// BigQuery Dataset as Metadata Source
//

import * as gcp from '../gcp';
import * as bq from '../gcp/bigquery';


export class BigQueryDatasetSource {
  readonly type: string;
  readonly name: string;
  readonly ingestedEntries = true;

  private readonly _name: string[];

  constructor(type: string, name: string) {
    this.type = type;
    this.name = name;
    this._name = name.split('.');
  }

  async *entries(ctx: gcp.ApiContext): AsyncGenerator<gcp.Entry, void, unknown> {
    // List the BigQuery dataset, and its children, and retrieve entries for each resource.
    const bigQuery = new bq.BigQueryClient(ctx);
    const catalog = new gcp.CatalogClient(ctx);

    // Find the location of the dataset, as this is required to construct the catalog entry name.
    const dsResource = await bigQuery.getDataset(this._name[0], this._name[1]);
    if (!dsResource.result) {
      throw new Error(`Failed to get location for dataset ${this.name}`);
    }

    // Fetch the dataset entry
    const location = dsResource.result.location.toLowerCase();
    const dsEntryId = `bigquery.googleapis.com/projects/${this._name[0]}/datasets/${this._name[1]}`
    const dsEntryName = `${gcp.catalogContainer(this._name[0], location, '@bigquery')}/entries/${dsEntryId}`
    const dsEntryResult = await catalog.lookupEntry(this._name[0], location, dsEntryName);
    if (!dsEntryResult.result) {
      throw new Error(`Failed to get Entry for dataset ${this.name}`);
    }
    yield dsEntryResult.result;

    // Fetch the table entries
    for await (const table of bigQuery.listTables(this._name[0], this._name[1])) {
      const tableId = table.tableReference.tableId;
      const tableEntryName = `${dsEntryName}/tables/${tableId}`
      const tableEntryResult = await catalog.lookupEntry(this._name[0], location, tableEntryName);
      if (!tableEntryResult.result) {
        throw new Error(`Failed to get Entry for table ${this.name}.${tableId}`);
      }

      yield tableEntryResult.result;
    }

    // TODO: Add support for routines, models
  }

  localName(entry: gcp.Entry): string {
    // The local catalog uses simplified path scheme:
    // dataset -> <dataset id>
    // table -> <dataset id>/tables/<table id
    // model -> <dataset id>/models/<model id>
    // routine -> <dataset id>/routines/<routine id>

    let match = entry.name.match(/\/datasets\/([^/]+)\/(tables|models|routines)\/(.+)$/);
    if (match) {
      const [, dataset, type, id] = match;
      if (type === 'tables') {
        return `${dataset}/${id}`;
      }
      return `${type}/${dataset}/${id}`;
    }

    match = entry.name.match(/\/datasets\/([^/]+)$/);
    if (match) {
      return match[1];
    }

    throw new Error(`Invalid BigQuery entry: ${entry.name}`);
  }
}
