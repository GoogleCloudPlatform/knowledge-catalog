// CLI command handlers
//

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as kcmd from '../libts';
import * as dataplex from '../libts/gcp/dataplex';
import * as context from '../libts/gcp/context';
import { Sources } from '../libts/source';
import { SemanticModelLayout } from '../libts/layouts/semantic-model';
import { SemanticModelSource } from '../libts/sources/semantic-model';
import * as deploy from '../libts/semantic/deploy_bigquery';
import * as kc from '../libts/semantic/deploy_knowledge_catalog';
import {BigQueryClient} from '../libts/gcp/bigquery';
import {LoadedModel, loadSemanticModels} from '../libts/semantic/loader';
import {transpileModels} from '../libts/semantic/transpile';
import {validateBigQueryDataSources, validatePushRequirements} from '../libts/semantic/validate';


export interface InitOptions {
  entryGroup?: string;
  bigqueryDataset?: string | string[];
  kb?: string;
  semanticModel?: string;
  pull?: boolean;
}


export interface PushOptions {
  // Generic push flag for non-semantic-model (CatalogSync) scopes;
  // forwarded to CatalogSync.push. The semantic-model legs ignore it.
  // The catch-all "force the push" toggle -- distinct from
  // `forceRemove` below, which specifically authorizes deleting models
  // this push no longer includes.
  force?: boolean;
  // Run every validation check and report pass/fail, but write nothing
  // to any destination (a dry run). Applies to both push paths.
  validateOnly?: boolean;
  // Delete Knowledge Catalog models already in the entry group that this push
  // does not include (a removed or renamed model). Without it, an unrecognized
  // model in the group fails the push. Semantic-model KC push only.
  // Unlike `force` above, this authorizes a destructive delete rather
  // than overriding a conflict.
  forceRemove?: boolean;
  // Semantic-model push destination(s): 'bq', 'kc', 'all' (default), or a
  // comma-separated list (e.g. 'bq,kc'). Ignored for non-semantic-model scopes.
  target?: string;
  // Print each pushed destination's generated artifact in that destination's
  // native format (BigQuery Graph -> SQL DDL, Knowledge Catalog -> the entry
  // plan), each block labeled by destination. Scope which destinations run with
  // --target. Works with or without --validate-only. Semantic-model push only.
  print?: boolean;
  // Emit the SQL-expression fields not yet supported by the published Knowledge
  // Catalog system-type templates (per-field schema semantics and the metric
  // expression). Off by default so a push matches the live types; enable once
  // the templates gain these fields. Semantic-model KC push only.
  emitExpressions?: boolean;
  // Rewrite vendor-dialect expressions (e.g. Snowflake/Databricks) to GoogleSQL
  // before deploying, filling any target `expression` the loader left unset
  // because only an `importedExpression` was supplied. Off by default (a model
  // authored in GoogleSQL/ANSI needs nothing). Runs once over the shared
  // models, so both the BigQuery and Knowledge Catalog legs see the filled
  // expressions. Semantic-model push only. See ../libts/semantic/transpile.
  transpile?: boolean;
}


export type PushTarget = 'bigquery' | 'kc';

// All known semantic-model push destinations, in canonical run order. `all`
// expands to this list, and resolveTargets always emits in this order so the
// run is deterministic and BigQuery-first fail-fast holds regardless of how the
// user ordered the flag. Append new destinations here as they land.
const DESTINATIONS: PushTarget[] = ['bigquery', 'kc'];

// The default when --target is omitted: push to every destination.
const DEFAULT_TARGET = 'all';

// User-typeable aliases for a single destination.
const TARGET_ALIASES: Record<string, PushTarget> = {
  bq: 'bigquery',
  bigquery: 'bigquery',
  kc: 'kc',
};

// Resolves a --target flag value to its ordered, de-duplicated destinations, or
// undefined if any token is unrecognized (the caller reports the error).
// Accepts a comma-separated list ('bq,kc'), the keyword 'all' (every
// destination), and defaults to 'bq'. The result is always in canonical
// DESTINATIONS order.
export function resolveTargets(target?: string): PushTarget[] | undefined {
  const tokens = (target ?? DEFAULT_TARGET)
    .toLowerCase()
    .split(',')
    .map(t => t.trim())
    .filter(t => t.length);
  if (!tokens.length) return undefined;
  const selected = new Set<PushTarget>();
  for (const tok of tokens) {
    if (tok === 'all') {
      DESTINATIONS.forEach(d => selected.add(d));
      continue;
    }
    const dest = TARGET_ALIASES[tok];
    if (!dest) return undefined;
    selected.add(dest);
  }
  return DESTINATIONS.filter(d => selected.has(d));
}


export async function init(options: InitOptions): Promise<number> {
  const ctx = context.ApiContext.default();

  let manifest: kcmd.CatalogManifest;
  if (options.entryGroup) {
    manifest = await kcmd.CatalogManifest.initWithEntryGroup(options.entryGroup, ctx);
  }
  else if (options.kb) {
    manifest = await kcmd.CatalogManifest.initWithKnowledgeBase(options.kb, ctx);
  }
  else if (options.bigqueryDataset) {
    let datasets = '';
    if (Array.isArray(options.bigqueryDataset)) {
      datasets = options.bigqueryDataset.join(',');
    }
    else {
      datasets = options.bigqueryDataset!;
    }
    manifest = await kcmd.CatalogManifest.initWithBigQuery(datasets, ctx);
  }
  else if (options.semanticModel) {
    manifest = await kcmd.CatalogManifest.initWithSemanticModel(options.semanticModel, ctx);
    const source = manifest.source as SemanticModelSource;
    // Provision the destination entry group now, at init, so push writes only
    // entries -- matching how the standard layout operates (its push creates
    // entries, never the entry group). Idempotent: an already-existing group
    // (409) is success.
    const catalog = new dataplex.CatalogClient(ctx);
    const res = await catalog.createEntryGroup(
      source.project, source.location, source.entryGroup);
    if (res.status !== 200 && res.status !== 409) {
      console.error(
        `Error: failed to create entry group '${source.name}': ` +
        `${res.message || res.status}`);
      return 1;
    }
    fs.mkdirSync(
      path.join('catalog', 'EntryGroups', source.entryGroup),
      { recursive: true });
  }
  else {
    console.error('Error: Must provide --entry-group, --bigquery-dataset, --kb, or --semantic-model');
    return 1;
  }

  manifest.save('catalog.yaml');
  console.log(fs.readFileSync('catalog.yaml', 'utf8'));

  if (options.pull) {
    return await pull();
  }

  return 0;
}


export async function pull(): Promise<number> {
  const ctx = context.ApiContext.default();
  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);

  if (snapshot.manifest.source.type === Sources.SEMANTIC_MODEL) {
    console.log(
      'Semantic-model scope: nothing to pull. Knowledge Catalog resource ' +
      'pull for the semantic model is not yet implemented.');
    return 0;
  }

  const catalog = new dataplex.CatalogClient(ctx);
  const sync = new kcmd.CatalogSync(catalog, snapshot);

  console.log('Pulling catalog entries...');
  const result = await sync.pull();

  if (result.success) {
    console.log('Successfully updated local snapshot.');
    return 0;
  }
  else {
    console.error('Error pulling catalog entries:', result.details);
    return 1;
  }
}


export async function push(options: PushOptions): Promise<number> {
  const ctx = context.ApiContext.default();
  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);

  if (snapshot.manifest.source.type === Sources.SEMANTIC_MODEL) {
    // The semantic-model source always resolves to the SemanticModel layout
    // (see createLayout), so this cast is safe.
    const layout = snapshot.layout as SemanticModelLayout;
    const source = snapshot.manifest.source as SemanticModelSource;

    const targets = resolveTargets(options.target);
    if (!targets) {
      console.error(
        `Error: invalid --target '${options.target}'; expected bq, kc, all, ` +
        `or a comma-separated list (e.g. bq,kc).`);
      return 1;
    }

    // Load + validate every model ONCE, then fan the parsed models out to each
    // destination leg. Both legs consume the same IR, so a `--target all` push
    // parses each document a single time instead of once per leg. A parse error
    // fails the whole push before any destination runs. defaultProject is the
    // scope's declared project (deterministic) rather than the ambient gcloud
    // project, which can drift from where the model's tables live.
    const docs = layout.modelDocuments();
    const loaded = loadSemanticModels(
        docs, {defaultProject: source.project ?? ctx.project});
    if (loaded.error) {
      console.error('Error:', loaded.error);
      return 1;
    }
    for (const w of loaded.warnings) {
      // When transpiling, the loader's "needs transpilation to ..." notes are
      // superseded by the transpile pass's own per-expression outcome lines
      // (transpiled / left imported); printing both is contradictory, so drop
      // the loader note here and let the pass report the result below.
      if (options.transpile && w.includes('needs transpilation')) continue;
      console.warn(`Warning: ${w}`);
    }

    // Rewrite vendor-dialect expressions to GoogleSQL once over the shared
    // models, before validation, so both destination legs and every downstream
    // check see the filled target expressions. Off unless --transpile: a model
    // authored in GoogleSQL/ANSI needs nothing, and the pass degrades to the
    // imported form (with a warning) when sqlglot is unavailable.
    let models = loaded.models;
    if (options.transpile) {
      const transpiled = await transpileModels(models);
      models = transpiled.models;
      for (const w of transpiled.warnings) {
        console.warn(`Warning: ${w}`);
      }
    }

    // Enforce push-time requirements once over the shared models, before any
    // destination runs: every model must declare a deployment target, and a
    // BigQuery-graph-targeting model's metrics must each resolve to one entity.
    // This is also the --validate-only path, so a dry run reports the same
    // failures.
    const validationErrors = validatePushRequirements(models);
    if (validationErrors.length) {
      for (const e of validationErrors) {
        console.error(`Error: ${e}`);
      }
      return 1;
    }

    // Live pre-flight over the same models, before any destination runs: every
    // entity's BigQuery source table must be reachable, so a push to either
    // BigQuery or Knowledge Catalog fails fast when the model could not deploy.
    // Runs for every --target and for --validate-only.
    const accessErrors = await validateBigQueryDataSources(
        models, new BigQueryClient(ctx), source.project ?? ctx.project);
    if (accessErrors.length) {
      for (const e of accessErrors) {
        console.error(`Error: ${e}`);
      }
      return 1;
    }

    // Run the resolved destinations in canonical order (BigQuery first); the
    // early return below fails fast, skipping later legs when an earlier one
    // fails.
    for (const target of targets) {
      const code = target === 'bigquery'
        ? await pushBigQuery(models, ctx, options)
        : await pushKnowledgeCatalog(models, ctx, options, source);
      if (code !== 0) return code;
    }
    return 0;
  }

  const catalog = new dataplex.CatalogClient(ctx);
  const sync = new kcmd.CatalogSync(catalog, snapshot);

  console.log('Pushing catalog entries...');
  const result = await sync.push(options);

  if (result.success) {
    console.log('Successfully pushed catalog entries.');
    return 0;
  }
  else {
    console.error('Error pushing catalog entries:', result.details);
    return 1;
  }
}


// Deploys the semantic model's BigQuery Graph leg (over the pre-loaded models)
// and prints the result. Returns a process exit code (0 on success).
async function pushBigQuery(
  models: LoadedModel[], ctx: context.ApiContext,
  options: PushOptions): Promise<number> {
  console.log(options.validateOnly
    ? 'Validating semantic model for BigQuery Graph...'
    : 'Pushing semantic model (BigQuery Graph)...');
  const result = await deploy.deployBigQuery(models, ctx, options);

  for (const w of result.warnings) {
    console.warn(`Warning: ${w}`);
  }
  if (options.print) {
    console.log('-- BigQuery Graph --');
    for (const block of result.ddl) {
      console.log(`${block}\n`);
    }
  }

  if (!result.success) {
    console.error('Error pushing semantic model to BigQuery:', result.details);
    return 1;
  }
  console.log(options.validateOnly
    ? 'Validation complete; no changes applied.'
    : `Deployed ${result.deployed} BigQuery Graph(s).`);
  return 0;
}


// Deploys the semantic model's Knowledge Catalog leg (over the pre-loaded
// models) and prints the result. The destination coordinates come from the
// scope (project.location.entryGroup). Returns a process exit code (0 on
// success).
async function pushKnowledgeCatalog(
  models: LoadedModel[], ctx: context.ApiContext,
  options: PushOptions, source: SemanticModelSource): Promise<number> {
  console.log(options.validateOnly
    ? 'Validating semantic model for Knowledge Catalog...'
    : 'Pushing semantic model (Knowledge Catalog)...');
  const result = await kc.deployKnowledgeCatalog(models, ctx, {
    project: source.project,
    location: source.location,
    entryGroup: source.entryGroup,
    validateOnly: options.validateOnly,
    forceRemove: options.forceRemove,
    emitExpressions: options.emitExpressions,
  });

  for (const w of result.warnings) {
    console.warn(`Warning: ${w}`);
  }
  if (options.print) {
    console.log('-- Knowledge Catalog --');
    for (const line of result.plan) {
      console.log(line);
    }
  }

  if (!result.success) {
    console.error(
      'Error pushing semantic model to Knowledge Catalog:', result.details);
    return 1;
  }
  const n = result.created + result.updated;
  const removed = result.deleted
    ? `; removed ${result.deleted} orphaned entr${
        result.deleted === 1 ? 'y' : 'ies'}`
    : '';
  const linked = result.linked
    ? `; linked ${result.linked} relationship${result.linked === 1 ? '' : 's'}`
    : '';
  const unlinked = result.unlinked
    ? `; unlinked ${result.unlinked} orphaned link${
        result.unlinked === 1 ? '' : 's'}`
    : '';
  console.log(options.validateOnly
    ? 'Validation complete; no changes applied.'
    : `Wrote ${result.created} new and ${result.updated} updated ` +
        `Knowledge Catalog entr${n === 1 ? 'y' : 'ies'}${removed}${linked}${
            unlinked}.`);
  return 0;
}
