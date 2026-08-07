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
import * as deploy from '../libts/semantic/deploy';
import * as kc from '../libts/semantic/kc';


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
  // Semantic-model push destination: 'bq' (default), 'kc', or 'both'. Ignored
  // for non-semantic-model scopes.
  target?: string;
}


export type PushTarget = 'bigquery' | 'kc';

// The push destinations a --target selection resolves to, in run order. 'both'
// runs BigQuery first so a BigQuery failure fails fast before touching the
// catalog (fail-fast is encoded by the array order + the caller's early return).
const TARGET_MAP: Record<string, PushTarget[]> = {
  bq: ['bigquery'],
  bigquery: ['bigquery'],
  kc: ['kc'],
  both: ['bigquery', 'kc'],
};

// Resolves a --target flag value (default 'bq') to its ordered destinations, or
// undefined for an unrecognized value (the caller reports the error).
export function resolveTargets(target?: string): PushTarget[] | undefined {
  return TARGET_MAP[(target ?? 'bq').toLowerCase()];
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
        `Error: unknown --target '${options.target}'; expected bq, kc, or both.`);
      return 1;
    }

    const docs = layout.modelDocuments();
    // Run destinations in order; 'both' is BigQuery-first and fails fast (an
    // early return below skips the catalog leg when BigQuery fails).
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
  if (options.validateOnly) {
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
// destination coordinates come from the scope (project.location.entryGroup); the
// built-in semantic types are nonprod-only, so this targets a nonprod Dataplex.
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
  if (options.validateOnly) {
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
