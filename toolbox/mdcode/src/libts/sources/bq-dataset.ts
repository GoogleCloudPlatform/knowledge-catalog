// BigQuery Dataset as Metadata Source
//

import * as gcp from '../gcp';
import * as bq from '../gcp/bigquery';
import {Layouts} from '../layout';
import {CatalogSource} from '../source';

export class BigQueryDatasetSource implements CatalogSource {
  readonly type: string;
  readonly name: string;
  readonly namespace: string = 'bigquery';
  readonly ingestedEntries = true;
  readonly layout = Layouts.STANDARD;

  private readonly _datasets: Map<string, bq.Dataset>;

  constructor(type: string, name: string, datasets: Map<string, bq.Dataset>) {
    this.type = type;
    this.name = name;

    this._datasets = datasets;
  }

  async *entries(
    ctx: gcp.ApiContext,
  ): AsyncGenerator<gcp.Entry, void, unknown> {
    const bigQuery = new bq.BigQueryClient(ctx);
    const catalog = new gcp.CatalogClient(ctx);

    for (const [_, dsResource] of this._datasets.entries()) {
      const project = dsResource.datasetReference.projectId;
      const dataset = dsResource.datasetReference.datasetId;

      // Fetch the dataset entry
      const location = dsResource.location.toLowerCase();
      const dsEntryId = `bigquery.googleapis.com/projects/${project}/datasets/${dataset}`;
      const dsEntryName = `${gcp.catalogContainer(project, location, '@bigquery')}/entries/${dsEntryId}`;
      const dsEntryResult = await catalog.lookupEntry(
        project,
        location,
        dsEntryName,
      );
      if (!dsEntryResult.result) {
        throw new Error(
          `Failed to get Entry for dataset ${project}.${dataset}`,
        );
      }
      yield dsEntryResult.result;

      // Fetch the table entries
      for await (const table of bigQuery.listTables(project, dataset)) {
        const tableId = table.tableReference.tableId;
        const tableEntryName = `${dsEntryName}/tables/${tableId}`;
        const tableEntryResult = await catalog.lookupEntry(
          project,
          location,
          tableEntryName,
        );
        if (!tableEntryResult.result) {
          throw new Error(
            `Failed to get Entry for table ${project}.${dataset}.${tableId}`,
          );
        }

        yield tableEntryResult.result;
      }
    }

    // TODO: Add support for routines, models
  }

  localName(entry: gcp.Entry, isReference?: boolean): string {
    // The local catalog uses simplified path scheme:
    // dataset -> bigquery/<project id>/<dataset id>
    // table -> bigquery/<project id>/<dataset id>/<table id>
    // routine -> bigquery/<project id>/<dataset id>/routines/<routine id>

    let localPath = '';
    let match = entry.name.match(
      /\/projects\/([^/]+)\/datasets\/([^/]+)\/(tables|models|routines)\/(.+)$/,
    );
    if (match) {
      const [, project, dataset, type, id] = match;
      if (type === 'tables') {
        localPath = `${this.namespace}/${project}/${dataset}/${id}`;
      } else {
        localPath = `${this.namespace}/${project}/${dataset}/${type}/${id}`;
      }
    } else {
      match = entry.name.match(/\/projects\/([^/]+)\/datasets\/([^/]+)$/);
      if (match) {
        const [, project, dataset] = match;
        localPath = `${this.namespace}/${project}/${dataset}`;
      }
    }

    if (!localPath) {
      throw new Error(`Invalid BigQuery entry: ${entry.name}`);
    }

    return isReference ? `${localPath}.ref` : localPath;
  }

  serviceName(localName: string): string {
    const cleanName = localName.endsWith('.ref')
      ? localName.slice(0, -4)
      : localName;
    const parts = cleanName.split('/');

    // parts[0] is 'bigquery'
    if (parts[0] !== this.namespace) {
      throw new Error(`Invalid namespace in local name: ${localName}`);
    }

    const projectId = parts[1];
    const datasetId = parts[2];

    const dsKey = `${projectId}.${datasetId}`;
    const dsResource = this._datasets.get(dsKey);
    if (!dsResource) {
      throw new Error(`Failed to find dataset for ${dsKey}`);
    }

    const project = dsResource.datasetReference.projectId;
    const location = dsResource.location.toLowerCase();
    const dataset = dsResource.datasetReference.datasetId;

    const entryGroup = `${gcp.catalogContainer(project, location, '@bigquery')}`;
    const entryName = `${entryGroup}/entries/bigquery.googleapis.com/projects/${project}/datasets/${dataset}`;

    if (parts.length === 3) {
      return entryName;
    }

    if (parts.length === 4) {
      // Table: bigquery/project/dataset/tableId
      return `${entryName}/tables/${parts[3]}`;
    }

    // Others: bigquery/project/dataset/type/id
    return `${entryName}/${parts[3]}/${parts[4]}`;
  }

  tryGetLocalName(serviceName: string): string | undefined {
    const match = serviceName.match(
      /\/projects\/([^/]+)\/datasets\/([^/]+)(\/(tables|models|routines)\/(.+))?$/,
    );
    if (!match) {
      return undefined;
    }
    const [, project, dataset, , type, id] = match;
    const datasetKey = `${project}.${dataset}`;
    if (!this._datasets.has(datasetKey)) {
      return undefined;
    }
    const dsResource = this._datasets.get(datasetKey)!;
    const location = dsResource.location.toLowerCase();
    const prefix = `${gcp.catalogContainer(project, location, '@bigquery')}/entries/bigquery.googleapis.com/projects/${project}/datasets/${dataset}`;
    if (!serviceName.startsWith(prefix)) {
      return undefined;
    }

    if (type === 'tables') {
      return `${this.namespace}/${project}/${dataset}/${id}`;
    }
    if (type) {
      return `${this.namespace}/${project}/${dataset}/${type}/${id}`;
    }
    return `${this.namespace}/${project}/${dataset}`;
  }
}
