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
    console.log('Pushing semantic model (BigQuery Graph)...');
    const result = await deploy.deployBigQuery(
      layout.modelDocuments(), ctx, options, source.project);

    for (const w of result.warnings) {
      console.warn(`Warning: ${w}`);
    }
    if (options.validateOnly) {
      for (const block of result.ddl) {
        console.log(`${block}\n`);
      }
    }

    if (result.success) {
      if (options.validateOnly) {
        console.log('Validation complete; no changes applied.');
      }
      else {
        console.log(
          `Deployed ${result.deployed} BigQuery Graph(s). ` +
          `Knowledge Catalog resource emit for the semantic model is not yet implemented.`);
      }
      return 0;
    }
    console.error('Error pushing semantic model:', result.details);
    return 1;
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
