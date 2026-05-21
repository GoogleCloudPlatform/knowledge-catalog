// Defines a Catalog metadata source abstraction
//

import * as gcp from './gcp';
import * as bq from './gcp/bigquery';
import { EntryGroupSource } from './sources/entrygroup';
import { BigQueryDatasetSource } from './sources/bq-dataset';


export interface CatalogSource {
  readonly type: string;
  readonly name: string;
  readonly ingestedEntries: boolean;

  entries(ctx: gcp.ApiContext): AsyncGenerator<gcp.Entry, void, unknown>;
  localName(entry: gcp.Entry): string;
}

export enum Sources {
  ENTRYGROUP = 'entryGroup',
  BIGQUERY_DATASET = 'bq-dataset',
}


async function validateEntryGroup(name: string, ctx: gcp.ApiContext): Promise<void> {
  const [project, location, entryGroup] = name.split('.')
  if (!project || !location || !entryGroup) {
    throw new Error('EntryGroup must be in format <projectId>.<locationId>.<entryGroupId>');
  }

  const catalog = new gcp.CatalogClient(ctx);
  const res = await catalog.getEntryGroup(project, location, entryGroup);
  if (res.status !== 200) {
    throw new Error(`Failed to locate EntryGroup '${name}'.`);
  }
}


async function validateBigQueryDataset(name: string, ctx: gcp.ApiContext): Promise<void> {
  const names = name.split(',');

  const bigQuery = new bq.BigQueryClient(ctx);
  for (const n of names) {
    const [project, dataset] = n.split('.');
    if (!project || !dataset) {
      throw new Error(`BigQuery dataset must be in format <projectId>.<datasetId>: ${n}`);
    }

    const res = await bigQuery.getDataset(project, dataset);
    if (res.status !== 200) {
      throw new Error(`Failed to locate BigQuery dataset '${n}'.`);
    }
  }
}


export async function createSource(type: string, name: string,
                                   ctx: gcp.ApiContext): Promise<CatalogSource> {
  switch (type) {
    case Sources.ENTRYGROUP:
      await validateEntryGroup(name, ctx);
      return new EntryGroupSource(Sources.ENTRYGROUP, name);
    case Sources.BIGQUERY_DATASET:
      await validateBigQueryDataset(name, ctx);
      return new BigQueryDatasetSource(Sources.BIGQUERY_DATASET, name);
    default:
      throw new Error(`Unknown source type: ${type}`);
  }
}
