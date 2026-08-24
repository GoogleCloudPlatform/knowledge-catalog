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
import {LoadedModel, loadModels, loadSemanticModels} from '../libts/semantic/loader';
import {transpileModels} from '../libts/semantic/transpile';
import {pullKnowledgeCatalog} from '../libts/semantic/pull_kc';
import {serializeModel} from '../libts/semantic/osi_converter';
import {convertOsiToOwl, convertOwlToOsi} from '../libts/semantic/converters/owl/convert';
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
  // authored in GoogleSQL/ANSI needs nothing). Runs once over the shared models,
  // so both the BigQuery and Knowledge Catalog legs see the filled expressions.
  // Semantic-model push only. See ../libts/semantic/transpile.
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
// destination), and defaults to 'all'. The result is always in canonical
// DESTINATIONS order.
export function resolveTargets(target?: string | boolean): PushTarget[] | undefined {
  // cac yields boolean `true` for a bare `--target` (no value); treat any
  // non-string as an invalid selection so the caller reports it rather than
  // throwing on `.toLowerCase()`.
  if (target !== undefined && typeof target !== 'string') return undefined;
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


export interface PullOptions {
  // Reconstruct + report only; never writes a file. Mirrors push --validate-only.
  dryRun?: boolean;
  // Authorize replacing a differently-named local model with the catalog's.
  // Without it, a pull whose catalog model id differs from the local model on
  // disk fails rather than leave two models in the entry group. Mirrors the
  // push flag of the same name.
  forceRemove?: boolean;
}


export async function pull(options: PullOptions = {}): Promise<number> {
  const ctx = context.ApiContext.default();
  const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);

  if (snapshot.manifest.source.type === Sources.SEMANTIC_MODEL) {
    return await pullSemanticModel(ctx, snapshot, options);
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
    // imported form (with a warning) if any expression fails to transpile.
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

  // These flags only take effect on a semantic-model push; on a regular
  // catalog snapshot they are inert. Warn rather than silently ignore them, so
  // a user who expected (say) --transpile to run isn't misled by a clean exit.
  const semanticOnlyFlags: Array<[boolean, string]> = [
    [!!options.transpile, '--transpile'],
    [options.target !== undefined, '--target'],
    [!!options.print, '--print'],
    [!!options.emitExpressions, '--emit-expressions'],
    [!!options.forceRemove, '--force-remove'],
  ];
  for (const [set, flag] of semanticOnlyFlags) {
    if (set) {
      console.warn(
          `Warning: ${flag} only applies to a semantic-model push; ignoring it.`);
    }
  }

  const catalog = new dataplex.CatalogClient(ctx);
  const sync = new kcmd.CatalogSync(catalog, snapshot);

  console.log(options.validateOnly
    ? 'Validating catalog entries...'
    : 'Pushing catalog entries...');
  const result = await sync.push(options);

  if (result.success) {
    console.log(options.validateOnly
      ? 'Validation complete; no changes applied.'
      : 'Successfully pushed catalog entries.');
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


// Pulls the semantic model's Knowledge Catalog entries back into local model
// documents (catalog/EntryGroups/<entryGroup>/<model>.yaml) and prints the
// result. The destination coordinates come from the scope
// (project.location.entryGroup). An entry group holds one model: a local
// document with the same name is overwritten in place; a differently-named
// local document is a conflict (pull would leave two models), so pull fails
// unless --force-remove authorizes deleting the stale local model first.
// Returns a process exit code (0 on success).
async function pullSemanticModel(
  ctx: context.ApiContext, snapshot: kcmd.CatalogSnapshot,
  options: PullOptions): Promise<number> {
  // The semantic-model source always resolves to the SemanticModel layout
  // (see createLayout), so these casts are safe.
  const layout = snapshot.layout as SemanticModelLayout;
  const source = snapshot.manifest.source as SemanticModelSource;

  console.log(options.dryRun
    ? 'Reconstructing semantic model from Knowledge Catalog (dry run)...'
    : 'Pulling semantic model from Knowledge Catalog...');

  const catalog = new dataplex.CatalogClient(ctx);
  const result = await pullKnowledgeCatalog(catalog, {
    project: source.project,
    location: source.location,
    entryGroup: source.entryGroup,
  });

  for (const w of result.warnings) {
    console.warn(`Warning: ${w}`);
  }

  if (!result.models.length) {
    console.log('No semantic models found; nothing to pull.');
    return 0;
  }

  // Reconcile the local layout with the catalog. A local document whose name
  // differs from the pulled model would leave the entry group with two models,
  // so pull refuses by default; --force-remove deletes the stale local
  // document(s) before the catalog's is written.
  const catalogNames = new Set(result.models.map(m => m.name));
  // Compare by the on-disk path each name maps to, not the raw name: a catalog
  // model name and a local document whose names sanitize to the same file (e.g.
  // 'a/b' -> 'a_b.yaml') are the same model, not a stale conflict.
  const catalogPaths = new Set(result.models.map(m => layout.modelPath(m.name)));
  const staleLocal = layout.modelDocuments()
    .map(d => d.name)
    .filter(n => !catalogPaths.has(layout.modelPath(n)));
  if (staleLocal.length) {
    if (!options.forceRemove) {
      const localList = staleLocal.map(n => `'${n}'`).join(', ');
      const catalogList = [...catalogNames].map(n => `'${n}'`).join(', ');
      console.error(
        `Error: local model(s) ${localList} do not match the catalog ` +
        `model ${catalogList} in this entry group. An entry group holds ` +
        `one model, so pull will not leave two behind. Re-run with ` +
        `--force-remove to delete the local model(s) and pull the ` +
        `catalog's.`);
      return 1;
    }
    for (const name of staleLocal) {
      const p = layout.modelPath(name);
      if (options.dryRun) {
        console.log(`  would remove ${p}`);
      }
      else {
        layout.removeModelDocument(name);
        console.log(`  removed ${p}`);
      }
    }
  }

  let created = 0;
  let updated = 0;
  // Guard against two reconstructed models whose names map to the same file
  // (path-separator sanitizing, or two anchors sharing a display name): the
  // later write would silently clobber the earlier. Track written paths so the
  // collision is reported and the dry-run/real counts agree on the repeat.
  const writtenBy = new Map<string, string>();
  for (const model of result.models) {
    const serialized = serializeModel(model);
    for (const w of serialized.warnings) {
      console.warn(`Warning: [${model.name}] ${w}`);
    }
    const target = layout.modelPath(model.name);
    const prior = writtenBy.get(target);
    if (prior !== undefined && prior !== model.name) {
      console.warn(
          `Warning: models '${prior}' and '${model.name}' both map to ` +
          `${target}; the later overwrites the earlier -- rename one model.`);
    }
    const existed = writtenBy.has(target) || layout.hasModel(model.name);
    writtenBy.set(target, model.name);
    if (options.dryRun) {
      console.log(`  would ${existed ? 'update' : 'create'} ${target}`);
    }
    else {
      layout.writeModelDocument(model.name, serialized.yaml);
      console.log(`  ${existed ? 'updated' : 'created'} ${target}`);
    }
    if (existed) updated++;
    else created++;
  }

  console.log(options.dryRun
    ? `Dry run: would write ${created} new and ${updated} updated model document(s).`
    : `Wrote ${created} new and ${updated} updated model document(s).`);
  return 0;
}


export interface OwlOptions {
  // import: write the generated OSI document here instead of the semantic-model
  //   layout dir (when omitted, the model lands in the scope's model layout so
  //   the next `kcmd push` picks it up).
  // export: write the generated Turtle here instead of `<model>.owl.ttl` in the
  //   current directory.
  out?: string;
}

// Recognized OWL source extensions, stripped to derive the model name from the
// filename: `sales.owl.ttl` -> `sales`.
const OWL_EXTENSIONS = /\.owl\.ttl$|\.ttl$|\.owl$/i;

// Handles `kcmd owl <action> <file>`, dispatching to `import` (Turtle -> OSI) or
// `export` (OSI -> Turtle). Returns a process exit code.
export async function owl(
  action: string, file: string, options: OwlOptions): Promise<number> {
  if (action === 'import') return owlImport(file, options);
  if (action === 'export') return owlExport(file, options);
  console.error(
    `Error: unknown owl action '${action}'; expected 'import' or 'export' `
    + `(usage: kcmd owl import <file.ttl> | kcmd owl export <model.yaml>).`);
  return 1;
}

// `kcmd owl import <file.ttl>`: convert a Turtle OWL ontology into an OSI model
// document that then rides the normal `kcmd push` / `kcmd pull`. The converted
// model is UNBOUND (see the OWL converter): its sources / join columns must be
// bound and a BigQuery deployment target added before `kcmd push` will deploy it
// (to either destination).
async function owlImport(file: string, options: OwlOptions): Promise<number> {
  if (!fs.existsSync(file)) {
    console.error(`Error: file not found: ${file}`);
    return 1;
  }

  const turtle = fs.readFileSync(file, 'utf8');
  const modelName = path.basename(file).replace(OWL_EXTENSIONS, '');
  if (!modelName) {
    console.error(`Error: could not derive a model name from '${file}'.`);
    return 1;
  }

  // convertOwlToOsi throws only on malformed Turtle; main.ts's try/catch
  // reports it.
  const result = convertOwlToOsi(turtle, modelName);
  for (const w of result.warnings) {
    console.warn(`Warning: ${w}`);
  }

  const { classes, datatypeProperties, objectProperties } = result.stats;

  // Guard: an ontology with no owl:Class yields a model with no datasets, which
  // is not a loadable OSI model. Fail clearly -- before the summary, so we do
  // not print a "converted 0 classes" line for a model we are about to reject --
  // rather than writing an empty artifact that only errors on a later push/pull.
  if (classes === 0) {
    console.error(
      `Error: no owl:Class declarations found in '${file}'; nothing to import.`);
    return 1;
  }

  console.log(
    `converted ${classes} ${plural(classes, 'class', 'classes')}, `
    + `${objectProperties} `
    + `${plural(objectProperties, 'object property', 'object properties')}, `
    + `${datatypeProperties} `
    + `${plural(datatypeProperties, 'datatype property', 'datatype properties')}`);

  // Sink: an explicit --out path writes directly; otherwise the semantic-model
  // layout places the document under the scope's entry group so `kcmd push`
  // finds it.
  let writtenPath: string;
  if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true });
    fs.writeFileSync(options.out, result.yaml);
    writtenPath = options.out;
  }
  else {
    const ctx = context.ApiContext.default();
    const snapshot = await kcmd.CatalogSnapshot.fromPath('.', ctx);
    if (snapshot.manifest.source.type !== Sources.SEMANTIC_MODEL) {
      console.error(
        `Error: this catalog is not a semantic-model scope, so there is no `
        + `model layout to write into. Run \`kcmd init --semantic-model ...\` `
        + `first, or pass --out <path> to write the OSI document directly.`);
      return 1;
    }
    const layout = snapshot.layout as SemanticModelLayout;
    layout.writeModelDocument(modelName, result.yaml);
    writtenPath = layout.modelPath(modelName);
  }

  console.log(`wrote ${writtenPath}`);
  console.log(
    `note: this model is UNBOUND (placeholder \`unbound:\` sources, no deployment target).\n`
    + `      \`kcmd push\` is rejected until you bind each entity's source table and add\n`
    + `      a BigQuery deployment target -- validation needs both, for every --target.`);
  return 0;
}

// `kcmd owl export <model.yaml>`: convert an OSI model document back to a Turtle
// OWL ontology (the inverse of `owl import`), scoped to round-trip fidelity. A
// model that originated as OWL round-trips exactly; constructs OWL cannot express
// (metrics, SQL expressions, bound sources, associations) are dropped with a
// warning (see the OWL converter).
async function owlExport(file: string, options: OwlOptions): Promise<number> {
  if (!fs.existsSync(file)) {
    console.error(`Error: file not found: ${file}`);
    return 1;
  }

  // loadModels throws on a malformed document; main.ts's try/catch reports it.
  const { models, warnings: loadWarnings } =
    loadModels(fs.readFileSync(file, 'utf8'));
  for (const w of loadWarnings) {
    console.warn(`Warning: ${w}`);
  }
  if (!models.length) {
    console.error(
      `Error: no semantic model found in '${file}'; nothing to export.`);
    return 1;
  }
  if (models.length > 1) {
    console.warn(
      `Warning: '${file}' declares ${models.length} models; exporting only `
      + `the first ('${models[0].name}'). OWL has no multi-model document.`);
  }
  const model = models[0];

  const result = convertOsiToOwl(model);
  for (const w of result.warnings) {
    console.warn(`Warning: ${w}`);
  }

  const { classes, datatypeProperties, objectProperties } = result.stats;
  console.log(
    `exported ${classes} ${plural(classes, 'class', 'classes')}, `
    + `${objectProperties} `
    + `${plural(objectProperties, 'object property', 'object properties')}, `
    + `${datatypeProperties} `
    + `${plural(datatypeProperties, 'datatype property', 'datatype properties')}`);

  // Sink: an explicit --out path writes directly; otherwise `<model>.owl.ttl` in
  // the current directory, mirroring the import filename convention.
  const outPath = options.out ?? `${model.name}.owl.ttl`;
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, result.turtle);
  console.log(`wrote ${outPath}`);
  return 0;
}

// Selects the singular or plural form based on `n` (English count agreement).
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
