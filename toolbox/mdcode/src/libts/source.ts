// Defines a Catalog metadata source abstraction
//

import * as gcp from './gcp';
import * as bq from './gcp/bigquery';
import * as dataplex from './gcp/dataplex';
import {Layouts} from './layout';
import {BigLakeNamespaceSource} from './sources/biglake-namespace';
import {BigQueryDatasetSource} from './sources/bq-dataset';
import {EntryGroupSource} from './sources/entrygroup';
import {GlossarySource} from './sources/glossary';
import {KnowledgeBaseSource} from './sources/kb';

export enum Sources {
  ENTRYGROUP = 'entryGroup',
  BIGQUERY_DATASET = 'bq-dataset',
  KB = 'kb',
  BIGLAKE_NAMESPACE = 'biglake-namespace',
  BIGLAKE_ICEBERG_NAMESPACE = 'biglake-iceberg-namespace',
  GLOSSARY = 'glossary',
}

export interface CatalogSource {
  readonly type: string;
  readonly name: string;
  readonly namespace: string;
  readonly ingestedEntries: boolean;
  readonly layout: Layouts;

  entries(ctx: gcp.ApiContext): AsyncGenerator<any, void, unknown>;
  localName(resource: any, isReference?: boolean): string;
  serviceName(localName: string): string;
  tryGetLocalName(serviceName: string): string | undefined;
}

async function getEntryGroup(
  name: string,
  ctx: gcp.ApiContext,
): Promise<dataplex.EntryGroup> {
  const [project, location, entryGroup] = name.split('.');
  if (!project || !location || !entryGroup) {
    throw new Error(
      'EntryGroup must be in format <projectId>.<locationId>.<entryGroupId>',
    );
  }

  const catalog = new gcp.CatalogClient(ctx);
  const res = await catalog.getEntryGroup(project, location, entryGroup);
  if (!res.result) {
    console.log(
      `[kcmd] ℹ️ EntryGroup '${name}' not found. It will be created during push if needed.`,
    );
    // Return a minimal EntryGroup object so the source can be initialized locally
    return {
      name: `projects/${project}/locations/${location}/entryGroups/${entryGroup}`,
    };
  }

  return res.result;
}

async function resolveGlossaries(
  name: string,
  ctx: gcp.ApiContext,
): Promise<dataplex.Glossary[]> {
  const parts = name.split('.');
  if (parts.length < 2) {
    throw new Error(
      'Glossary scope must be in format <projectId>.<locationId> or <projectId>.<locationId>.<glossaryIdOrDisplayName>',
    );
  }

  const [project, location] = parts;
  const searchTermsRaw = parts.slice(2).join('.');

  // If no search terms, it's location mode
  if (!searchTermsRaw) {
    return [];
  }

  // Split by comma or newline
  const searchTerms = searchTermsRaw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const catalog = new gcp.CatalogClient(ctx);
  const resolved: dataplex.Glossary[] = [];

  for (const term of searchTerms) {
    // 1. Try to get by ID directly
    const res = await catalog.getGlossary(project, location, term);
    if (res.result) {
      resolved.push(res.result);
      continue;
    }

    // 2. Search by Display Name (exact match)
    let foundByName = false;
    for await (const glossary of catalog.listGlossaries(project, location)) {
      if (glossary.displayName === term) {
        resolved.push(glossary);
        foundByName = true;
      }
    }

    if (!foundByName) {
      throw new Error(
        `Glossary '${term}' not found in ${project}.${location} (tried ID and Display Name).`,
      );
    }
  }

  return resolved;
}

async function getBigQueryDatasets(
  name: string,
  ctx: gcp.ApiContext,
): Promise<Map<string, bq.Dataset>> {
  const datasets = new Map<string, bq.Dataset>();
  const names = name.split(',');

  const bigQuery = new bq.BigQueryClient(ctx);
  for (const n of names) {
    const [project, dataset] = n.split('.');
    if (!project || !dataset) {
      throw new Error(
        `BigQuery dataset must be in format <projectId>.<datasetId>: ${n}`,
      );
    }

    const res = await bigQuery.getDataset(project, dataset);
    if (!res.result) {
      throw new Error(`Failed to locate BigQuery dataset '${n}'.`);
    }

    datasets.set(n, res.result);
  }

  return datasets;
}

async function getBigLakeNamespace(
  name: string,
  ctx: gcp.ApiContext,
): Promise<{location: string}> {
  const [project, catalog, namespace] = name.split('.');
  if (!project || !catalog || !namespace) {
    throw new Error(
      `BigLake namespace must be in format <projectId>.<catalogId>.<namespaceId>: ${name}`,
    );
  }

  const bigQuery = new bq.BigQueryClient(ctx);
  const res = await bigQuery.getDataset(project, `${catalog}.${namespace}`);
  if (!res.result) {
    throw new Error(
      `Failed to locate BigLake namespace '${name}'. Ensure it physically exists.`,
    );
  }

  return {location: res.result.location || ctx.location};
}

export async function createSource(
  type: string,
  name: string,
  ctx: gcp.ApiContext,
): Promise<CatalogSource> {
  switch (type) {
    case Sources.ENTRYGROUP:
      const entryGroup = await getEntryGroup(name, ctx);
      return new EntryGroupSource(Sources.ENTRYGROUP, name, entryGroup);
    case Sources.BIGQUERY_DATASET:
      const datasets = await getBigQueryDatasets(name, ctx);
      return new BigQueryDatasetSource(
        Sources.BIGQUERY_DATASET,
        name,
        datasets,
      );
    case Sources.KB:
      const knowledgeBase = await getEntryGroup(name, ctx);
      return new KnowledgeBaseSource(Sources.KB, name, knowledgeBase);
    case Sources.BIGLAKE_NAMESPACE:
      const nsInfo = await getBigLakeNamespace(name, ctx);
      return new BigLakeNamespaceSource(
        Sources.BIGLAKE_NAMESPACE,
        name,
        nsInfo.location,
        'iceberg',
      );
    case Sources.BIGLAKE_ICEBERG_NAMESPACE:
      const icebergNsInfo = await getBigLakeNamespace(name, ctx);
      return new BigLakeNamespaceSource(
        Sources.BIGLAKE_ICEBERG_NAMESPACE,
        name,
        icebergNsInfo.location,
        'iceberg',
      );
    case Sources.GLOSSARY:
      const glossaries = await resolveGlossaries(name, ctx);
      return new GlossarySource(Sources.GLOSSARY, name, glossaries);
    default:
      throw new Error(`Unknown source type: ${type}`);
  }
}
