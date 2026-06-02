// BigQuery Dataset as Metadata Source
//

import * as gcp from '../gcp';
import * as bq from '../gcp/bigquery';
import { Layouts } from '../layout';
import { CatalogSource } from '../source';


export class BigQueryDatasetSource implements CatalogSource {
  readonly type: string;
  readonly name: string;
  readonly ingestedEntries = true;
  readonly layout = Layouts.STANDARD;

  private readonly _datasets: Map<string, bq.Dataset>;

  constructor(type: string, name: string, datasets: Map<string, bq.Dataset>) {
    this.type = type;
    this.name = name;

    this._datasets = datasets;
  }

  async *entries(ctx: gcp.ApiContext): AsyncGenerator<gcp.Entry, void, unknown> {
    const bigQuery = new bq.BigQueryClient(ctx);
    const catalog = new gcp.CatalogClient(ctx);

    for (const [_, dsResource] of this._datasets.entries()) {
      const project = dsResource.datasetReference.projectId;
      const dataset = dsResource.datasetReference.datasetId;

      // Fetch the dataset entry
      const location = dsResource.location.toLowerCase();
      const dsEntryId = `bigquery.googleapis.com/projects/${project}/datasets/${dataset}`
      const dsEntryName = `${gcp.catalogContainer(project, location, '@bigquery')}/entries/${dsEntryId}`
      const dsEntryResult = await catalog.lookupEntry(project, location, dsEntryName);
      if (!dsEntryResult.result) {
        throw new Error(`Failed to get Entry for dataset ${project}.${dataset}`);
      }
      yield dsEntryResult.result;

      // Fetch the table entries
      for await (const table of bigQuery.listTables(project, dataset)) {
        const tableId = table.tableReference.tableId;
        const tableEntryName = `${dsEntryName}/tables/${tableId}`
        const tableEntryResult = await catalog.lookupEntry(project, location, tableEntryName);
        if (!tableEntryResult.result) {
          throw new Error(`Failed to get Entry for table ${project}.${dataset}.${tableId}`);
        }

        yield tableEntryResult.result;
      }
    }

    // TODO: Add support for routines, models
  }

  localName(entry: gcp.Entry): string {
    // The local catalog uses simplified path scheme:
    // dataset -> <project id>.<dataset id>
    // table -> <project id>.<dataset id>/<table id>
    // model -> <project id>.<dataset id>/models/<model id>
    // routine -> <project id>.<dataset id>/routines/<routine id>

    let match = entry.name.match(/\/projects\/([^/]+)\/datasets\/([^/]+)\/(tables|models|routines)\/(.+)$/);
    if (match) {
      const [, project, dataset, type, id] = match;
      if (type === 'tables') {
        return `${project}.${dataset}/${id}`;
      }
      return `${type}/${project}.${dataset}/${id}`;
    }

    match = entry.name.match(/\/projects\/([^/]+)\/datasets\/([^/]+)$/);
    if (match) {
      const [, project, dataset] = match;
      return `${project}.${dataset}`;
    }

    throw new Error(`Invalid BigQuery entry: ${entry.name}`);
  }

  serviceName(localName: string): string {
    const nameParts = localName.split('/');
    const dsResource = this._datasets.get(nameParts[0]);
    if (!dsResource) {
      throw new Error(`Failed to find dataset for ${nameParts[0]}`);
    }

    const project = dsResource.datasetReference.projectId;
    const location = dsResource.location.toLowerCase();
    const dataset = dsResource.datasetReference.datasetId;

    const entryGroup = `${gcp.catalogContainer(project, location, '@bigquery')}`;
    const entryName = `${entryGroup}/entries/bigquery.googleapis.com/projects/${project}/datasets/${dataset}`;
    if (nameParts.length == 1) {
      return entryName;
    }

    const collection = nameParts.length == 2 ? 'tables' : nameParts[1];
    const resource = nameParts.length == 2 ? nameParts[1] : nameParts[2];
    return `${entryName}/${collection}/${resource}`;
  }
}
