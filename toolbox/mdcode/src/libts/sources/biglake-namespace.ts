// BigLake Metastore Namespace as Metadata Source
//

import * as gcp from '../gcp';
import { Layouts } from '../layout';
import { CatalogSource } from '../source';

export class BigLakeNamespaceSource implements CatalogSource {
  readonly type: string;
  readonly name: string;
  readonly ingestedEntries = true;
  readonly layout = Layouts.STANDARD;

  private readonly _project: string;
  private readonly _location: string;
  readonly _catalogId: string;
  private readonly _namespaceId: string;
  private readonly _catalogType: 'iceberg';

  constructor(type: string, name: string, location: string, catalogType: 'iceberg') {
    this.type = type;
    this.name = name;
    this._catalogType = catalogType;

    const parts = name.split('.');
    if (parts.length !== 3) {
      throw new Error('BigLake namespace must be in format <projectId>.<catalogId>.<namespaceId>');
    }
    this._project = parts[0];
    this._location = location.toLowerCase();
    this._catalogId = parts[1];
    this._namespaceId = parts[2];
  }

  async *entries(ctx: gcp.ApiContext): AsyncGenerator<gcp.Entry, void, unknown> {
    const bigLake = new gcp.BigLakeClient(ctx, this._catalogType);
    const catalog = new gcp.CatalogClient(ctx);

    for await (const table of bigLake.listTables(this._project, this._location, this._catalogId, this._namespaceId)) {
      const tableId = table.name.substring(table.name.lastIndexOf('/') + 1);
      const tableEntryName = `projects/${this._project}/locations/${this._location}/entryGroups/@biglake/entries/biglake.googleapis.com/projects/${this._project}/catalogs/${this._catalogId}/namespaces/${this._namespaceId}/tables/${tableId}`;
      
      const tableEntryResult = await catalog.lookupEntry(this._project, this._location, tableEntryName);
      if (tableEntryResult.status === 200 && tableEntryResult.result) {
        yield tableEntryResult.result;
      }
    }
  }

  localName(entry: gcp.Entry): string {
    const match = entry.name.match(/\/tables\/([^/]+)$/);
    if (!match) {
      throw new Error(`Invalid entry name for BigLake: ${entry.name}`);
    }
    return `${this.name}/${match[1]}`;
  }

  serviceName(localName: string): string {
    const nameParts = localName.split('/');
    const tableId = nameParts[nameParts.length - 1];
    return `projects/${this._project}/locations/${this._location}/entryGroups/@biglake/entries/biglake.googleapis.com/projects/${this._project}/catalogs/${this._catalogId}/namespaces/${this._namespaceId}/tables/${tableId}`;
  }
}
