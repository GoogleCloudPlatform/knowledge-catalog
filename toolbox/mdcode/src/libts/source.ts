// Defines a Catalog metadata source abstraction
//

import * as gcp from './gcp';
import * as bq from './gcp/bigquery';
import * as dataplex from './gcp/dataplex';
import { Layouts } from './layout';
import { EntryGroupSource } from './sources/entrygroup';
import { BigQueryDatasetSource } from './sources/bq-dataset';
import { KnowledgeBaseSource } from './sources/kb';
import { BigLakeNamespaceSource } from './sources/biglake-namespace';

export enum Sources {
  ENTRYGROUP = 'entryGroup',
  BIGQUERY_DATASET = 'bq-dataset',
  KB = 'kb',
  BIGLAKE_NAMESPACE = 'biglake-namespace',
  BIGLAKE_ICEBERG_NAMESPACE = 'biglake-iceberg-namespace'
}


export interface CatalogSource {
  readonly type: string;
  readonly name: string;
  readonly ingestedEntries: boolean;
  readonly layout: Layouts;

  entries(ctx: gcp.ApiContext): AsyncGenerator<gcp.Entry, void, unknown>;
  localName(entry: gcp.Entry): string;
  serviceName(localName: string): string;
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


async function getBigLakeNamespace(name: string, ctx: gcp.ApiContext): Promise<{ location: string }> {
  const [project, catalog, namespace] = name.split('.');
  if (!project || !catalog || !namespace) {
    throw new Error(`BigLake namespace must be in format <projectId>.<catalogId>.<namespaceId>: ${name}`);
  }

  const bigQuery = new bq.BigQueryClient(ctx);
  const res = await bigQuery.getDataset(project, `${catalog}.${namespace}`);
  if (!res.result) {
    throw new Error(`Failed to locate BigLake namespace '${name}'. Ensure it physically exists.`);
  }

  return { location: res.result.location || ctx.location };
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
    case Sources.BIGLAKE_NAMESPACE:
      const nsInfo = await getBigLakeNamespace(name, ctx);
      return new BigLakeNamespaceSource(Sources.BIGLAKE_NAMESPACE, name, nsInfo.location, 'iceberg');
    case Sources.BIGLAKE_ICEBERG_NAMESPACE:
      const icebergNsInfo = await getBigLakeNamespace(name, ctx);
      return new BigLakeNamespaceSource(Sources.BIGLAKE_ICEBERG_NAMESPACE, name, icebergNsInfo.location, 'iceberg');
    default:
      throw new Error(`Unknown source type: ${type}`);
  }
}
