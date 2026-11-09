// Defines a Catalog metadata source abstraction
//

import * as gcp from './gcp';
import * as bq from './gcp/bigquery';
import * as dataplex from './gcp/dataplex';
import { Layouts } from './layout';
import { EntryGroupSource } from './sources/entrygroup';
import { BigQueryDatasetSource } from './sources/bq-dataset';
import { KnowledgeBaseSource } from './sources/kb';
import { SemanticModelSource } from './sources/semantic-model';

export enum Sources {
  ENTRYGROUP = 'entryGroup',
  BIGQUERY_DATASET = 'bq-dataset',
  KB = 'kb',
  SEMANTIC_MODEL = 'semantic-model'
}


export interface CatalogSource {
  readonly type: string;
  readonly name: string;
  readonly ingestedEntries: boolean;
  readonly layout: Layouts;
  readonly project?: string;
  readonly location?: string;
  // Present only for scopes that carry an EntryGroup (e.g. entryGroup, kb,
  // semantic-model); used to scope the local catalog layout to that group.
  readonly entryGroup?: string;
  // RFC 3339 creation timestamp of the backing EntryGroup when loaded from the
  // service; undefined on offline or non-EntryGroup sources.
  readonly entryGroupCreateTime?: string;
  // The aspect types `kcmd init` lists under snapshot.aspects, so pull fetches
  // them along with those each entry's type requires. System-generated aspects
  // are left out, since push sends every local aspect back.
  readonly defaultAspects: readonly string[];
  // The aspect types the service writes on this scope's entries beyond those
  // their entry types require. Pull leaves them out without a warning.
  readonly systemAspects: readonly string[];

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
    case Sources.SEMANTIC_MODEL:
      return new SemanticModelSource(Sources.SEMANTIC_MODEL, name);
    default:
      throw new Error(`Unknown source type: ${type}`);
  }
}

export interface EntryGroupCoordinates {
  project: string;
  location: string;
  entryGroup: string;
  container: string;
}

/** Validates and extracts `<project>.<location>.<entryGroup>` coordinates. */
export function entryGroupCoordinates(source: CatalogSource): EntryGroupCoordinates {
  if (source.type && source.type !== Sources.ENTRYGROUP && source.type !== Sources.KB) {
    throw new Error(
        `OKF layout applies only to '${Sources.ENTRYGROUP}' and '${Sources.KB}' scopes, got '${source.type}'.`);
  }
  const project = source.project ?? source.name.split('.')[0];
  const location = source.location ?? source.name.split('.')[1];
  const entryGroup = source.entryGroup ?? source.name.split('.')[2];
  const parts = source.name.split('.');
  if (!project || !location || !entryGroup || parts.length !== 3) {
    throw new Error(
        `EntryGroup must be in format <projectId>.<locationId>.<entryGroupId>: '${source.name}'`);
  }
  return {
    project,
    location,
    entryGroup,
    container: dataplex.catalogContainer(project, location, entryGroup),
  };
}
