// CLI command handlers
//

import * as fs from 'node:fs';

import * as kcmd from '../libts';
import * as dataplex from '../libts/gcp/dataplex';
import * as context from '../libts/gcp/context';


export interface InitOptions {
  entryGroup?: string;
  bigqueryDataset?: string | string[];
  kb?: string;
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
  else {
    console.error('Error: Must provide either --entry-group or --bigquery-dataset or --kb');
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
