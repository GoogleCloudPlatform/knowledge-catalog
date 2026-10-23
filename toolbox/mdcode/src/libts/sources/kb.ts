// Dataplex Wiki managed as an EntryGroup as Metadata Source
//

import * as gcp from '../gcp';
import * as dataplex from '../gcp/dataplex';
import { Layouts } from '../layout';
import * as md from '../metadata';
import { CatalogSource } from '../source';


export class KnowledgeBaseSource implements CatalogSource {
  readonly type: string;
  readonly name: string;
  readonly ingestedEntries = false;
  readonly layout = Layouts.DOCUMENTS;
  readonly defaultAspects = [md.OVERVIEW_ASPECT];

  private readonly _name: string[];
  private readonly _entryGroup: dataplex.EntryGroup;

  constructor(type: string, name: string, entryGroup: dataplex.EntryGroup) {
    this.type = type;
    this.name = name;

    this._name = name.split('.');
    this._entryGroup = entryGroup;
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
}
