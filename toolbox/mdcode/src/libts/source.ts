// Defines a Catalog metadata source abstraction
//

import * as gcp from './gcp';
import * as bq from './gcp/bigquery';
import * as dataplex from './gcp/dataplex';
import { Layouts } from './layout';
import { EntryGroupSource } from './sources/entrygroup';
import { BigQueryDatasetSource } from './sources/bq-dataset';
import { KnowledgeBaseSource } from './sources/kb';

export enum Sources {
  ENTRYGROUP = 'entryGroup',
  BIGQUERY_DATASET = 'bq-dataset',
  KB = 'kb'
}


export interface CatalogSource {
  readonly type: string;
  readonly name: string;
  readonly ingestedEntries: boolean;
  readonly layout: Layouts;

  entries(ctx: gcp.ApiContext): AsyncGenerator<gcp.Entry, void, unknown>;
  localName(entry: gcp.Entry): string;
  serviceName(localName: string): string;
  tryGetLocalName(serviceName: string): string | undefined;
}


async function getEntryGroup(name: string, ctx: gcp.ApiContext): Promise<dataplex.EntryGroup> {
  const [project, location, entryGroup] = name.split('.')
  if (!project || !location || !entryGroup) {
    throw new Error('EntryGroup must be in format <projectId>.<locationId>.<entryGroupId>');
  }

  const catalog = new gcp.CatalogClient(ctx);
  const res = await catalog.getEntryGroup(project, location, entryGroup);
  if (!res.result) {
    throw new Error(`Failed to locate EntryGroup '${name}'.`);
  }

  return res.result;
}


async function getBigQueryDatasets(name: string, ctx: gcp.ApiContext): Promise<Map<string, bq.Dataset>> {
  const datasets = new Map<string, bq.Dataset>();
  const names = name.split(',');

  const bigQuery = new bq.BigQueryClient(ctx);
  for (const n of names) {
    const [project, dataset] = n.split('.');
    if (!project || !dataset) {
      throw new Error(`BigQuery dataset must be in format <projectId>.<datasetId>: ${n}`);
    }

    const res = await bigQuery.getDataset(project, dataset);
    if (!res.result) {
      throw new Error(`Failed to locate BigQuery dataset '${n}'.`);
    }

    datasets.set(n, res.result);
  }

  return datasets;
}


export async function createSource(type: string, name: string,
                                   ctx: gcp.ApiContext): Promise<CatalogSource> {
  switch (type) {
    case Sources.ENTRYGROUP:
      const entryGroup = await getEntryGroup(name, ctx);
      return new EntryGroupSource(Sources.ENTRYGROUP, name, entryGroup);
    case Sources.BIGQUERY_DATASET:
      const datasets = await getBigQueryDatasets(name, ctx);
      return new BigQueryDatasetSource(Sources.BIGQUERY_DATASET, name, datasets);
    case Sources.KB:
      const knowledgeBase = await getEntryGroup(name, ctx);
      return new KnowledgeBaseSource(Sources.KB, name, knowledgeBase);
    default:
      throw new Error(`Unknown source type: ${type}`);
  }
}
