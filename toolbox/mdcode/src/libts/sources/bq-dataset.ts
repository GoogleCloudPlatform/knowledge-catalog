// BigQuery Dataset as Metadata Source
//

import * as gcp from '../gcp';
import * as bq from '../gcp/bigquery';
import { MAX_DATASETS } from '../source';


export class BigQueryDatasetSource {
  readonly type: string;
  readonly name: string;
  readonly ingestedEntries = true;

  private readonly _datasets: string[][];

  constructor(type: string, name: string) {
    this.type = type;
    this.name = name;
    
    const names = name.split(',');
    if (names.length > MAX_DATASETS) {
      throw new Error(`Only up to ${MAX_DATASETS} BigQuery datasets can be specified.`);
    }
    this._datasets = names.map(n => {
      const parts = n.split('.');
      if (parts.length !== 2) {
        throw new Error(`BigQuery dataset must be in format <projectId>.<datasetId>: ${n}`);
      }
      return parts;
    });
  }

  async *entries(ctx: gcp.ApiContext): AsyncGenerator<gcp.Entry, void, unknown> {
    const bigQuery = new bq.BigQueryClient(ctx);
    const catalog = new gcp.CatalogClient(ctx);

    for (const datasetParts of this._datasets) {
      const [project, dataset] = datasetParts;

      // Find the location of the dataset, as this is required to construct the catalog entry name.
      const dsResource = await bigQuery.getDataset(project, dataset);
      if (!dsResource.result) {
        throw new Error(`Failed to get location for dataset ${project}.${dataset}`);
      }

      // Fetch the dataset entry
      const location = dsResource.result.location.toLowerCase();
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
    // model -> <type>/<project id>.<dataset id>/<model id>
    // routine -> <type>/<project id>.<dataset id>/<routine id>

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
}
