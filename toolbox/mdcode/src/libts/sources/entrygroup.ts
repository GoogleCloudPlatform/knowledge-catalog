// Dataplex EntryGroup as Metadata Source
//

import * as gcp from '../gcp';
import * as dataplex from '../gcp/dataplex';
import { Layouts } from '../layout';
import { CatalogSource } from '../source';


export class EntryGroupSource implements CatalogSource {
  readonly type: string;
  readonly name: string;
  readonly ingestedEntries: boolean;
  readonly layout = Layouts.STANDARD;

  private readonly _name: string[];
  private readonly _entryGroup: dataplex.EntryGroup;

  constructor(type: string, name: string, entryGroup: dataplex.EntryGroup) {
    this.type = type;
    this.name = name;

    this._name = name.split('.');
    this._entryGroup = entryGroup;

    this.ingestedEntries = this._name[2].startsWith('@');
  }

  async *entries(ctx: gcp.ApiContext): AsyncGenerator<gcp.Entry, void, unknown> {
    // Enumerate all entries in the EntryGroup

    const catalog = new gcp.CatalogClient(ctx);
    for await (const entry of catalog.listEntries(this._name[0], this._name[1], this._name[2])) {
      yield entry;
    }
  }

  localName(entry: gcp.Entry): string {
    // The local catalog uses the entry id as is
    const match = entry.name.match(/entryGroups\/([^/]+)\/entries\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid entry name for entry: ${entry.name}`);
    }

    return match[2];
  }

  serviceName(localName: string): string {
    return `${this._entryGroup.name}/entries/${localName}`;
  }

  tryGetLocalName(serviceName: string): string | undefined {
    const prefix = `${this._entryGroup.name}/entries/`;
    if (serviceName.startsWith(prefix)) {
      return serviceName.substring(prefix.length);
    }
    return undefined;
  }
}
