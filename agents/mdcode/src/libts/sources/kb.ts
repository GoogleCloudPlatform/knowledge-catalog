// Dataplex Wiki managed as an EntryGroup as Metadata Source
//

import * as gcp from '../gcp';
import * as dataplex from '../gcp/dataplex';
import {Layouts} from '../layout';
import {CatalogSource} from '../source';

export class KnowledgeBaseSource implements CatalogSource {
  readonly type: string;
  readonly name: string;
  readonly namespace: string;
  readonly ingestedEntries = false;
  readonly layout = Layouts.DOCUMENTS;

  private readonly _name: string[];
  private readonly _entryGroup: dataplex.EntryGroup;

  constructor(type: string, name: string, entryGroup: dataplex.EntryGroup) {
    this.type = type;
    this.name = name;

    this._name = name.split('.');
    this._entryGroup = entryGroup;

    this.namespace = this._name[2].startsWith('@')
      ? this._name[2].substring(1)
      : this._name[2];
  }

  async *entries(
    ctx: gcp.ApiContext,
  ): AsyncGenerator<gcp.Entry, void, unknown> {
    // Enumerate all entries in the EntryGroup

    const catalog = new gcp.CatalogClient(ctx);
    for await (const entry of catalog.listEntries(
      this._name[0],
      this._name[1],
      this._name[2],
    )) {
      yield entry;
    }
  }

  localName(entry: gcp.Entry, isReference?: boolean): string {
    // The local catalog uses the entry id as is, nested under kb/project/location
    const match = entry.name.match(/entryGroups\/([^/]+)\/entries\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid entry name for entry: ${entry.name}`);
    }

    const entryId = match[2];
    const localPath = `${this.namespace}/${this._name[0]}/${this._name[1]}/${entryId}`;
    return isReference ? `${localPath}.ref` : localPath;
  }

  serviceName(localName: string): string {
    const cleanName = localName.endsWith('.ref')
      ? localName.slice(0, -4)
      : localName;
    const parts = cleanName.split('/');
    // parts[0] is namespace, parts[1] is project, parts[2] is location, parts[3+] is entryId
    const entryId = parts.slice(3).join('/');
    return `${this._entryGroup.name}/entries/${entryId}`;
  }

  tryGetLocalName(serviceName: string): string | undefined {
    if (!serviceName.startsWith(this._entryGroup.name + '/entries/')) {
      return undefined;
    }
    const entryId = serviceName.substring(this._entryGroup.name.length + 9);
    return `${this.namespace}/${this._name[0]}/${this._name[1]}/${entryId}`;
  }
}
