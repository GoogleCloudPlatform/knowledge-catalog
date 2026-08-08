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


export interface InitOptions {
  entryGroup?: string;
  bigqueryDataset?: string | string[];
  kb?: string;
  semanticModel?: string;
  pull?: boolean;
}


export interface PushOptions {
  force?: boolean;
  validateOnly?: boolean;
  // Semantic-model push destination(s): 'bq', 'kc', 'all' (default), or a
  // comma-separated list (e.g. 'bq,kc'). Ignored for non-semantic-model scopes.
  target?: string;
  // Print each pushed destination's generated artifact in that destination's
  // native format (BigQuery Graph -> SQL DDL, Knowledge Catalog -> the entry
  // plan), each block labeled by destination. Scope which destinations run with
  // --target. Works with or without --validate-only. Semantic-model push only.
  print?: boolean;
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
    const entryGroup = manifest.source.entryGroup!;
    fs.mkdirSync(path.join('catalog', 'EntryGroups', entryGroup), { recursive: true });
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

    const docs = layout.modelDocuments();
    // Run the resolved destinations in canonical order (BigQuery first); the
    // early return below fails fast, skipping later legs when an earlier one
    // fails.
    for (const target of targets) {
      const code = target === 'bigquery'
        ? await pushBigQuery(docs, ctx, options, source)
        : await pushKnowledgeCatalog(docs, ctx, options, source);
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


// Deploys the semantic model's BigQuery Graph leg and prints the result.
// Returns a process exit code (0 on success).
async function pushBigQuery(
  docs: { name: string; text: string }[], ctx: context.ApiContext,
  options: PushOptions, source: SemanticModelSource): Promise<number> {
  console.log(options.validateOnly
    ? 'Validating semantic model for BigQuery Graph...'
    : 'Pushing semantic model (BigQuery Graph)...');
  const result = await deploy.deployBigQuery(docs, ctx, options, source.project);

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


// Deploys the semantic model's Knowledge Catalog leg and prints the result. The
// destination coordinates come from the scope (project.location.entryGroup).
// Returns a process exit code (0 on success).
async function pushKnowledgeCatalog(
  docs: { name: string; text: string }[], ctx: context.ApiContext,
  options: PushOptions, source: SemanticModelSource): Promise<number> {
  console.log(options.validateOnly
    ? 'Validating semantic model for Knowledge Catalog...'
    : 'Pushing semantic model (Knowledge Catalog)...');
  const result = await kc.deployKnowledgeCatalog(docs, ctx, {
    project: source.project,
    location: source.location,
    entryGroup: source.entryGroup,
    validateOnly: options.validateOnly,
  }, source.project);

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
  console.log(options.validateOnly
    ? 'Validation complete; no changes applied.'
    : `Wrote ${result.created} new and ${result.updated} updated ` +
        `Knowledge Catalog entr${n === 1 ? 'y' : 'ies'}.`);
  return 0;
}
