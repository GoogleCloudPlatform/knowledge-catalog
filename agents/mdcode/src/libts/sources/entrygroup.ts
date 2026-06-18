// Dataplex EntryGroup as Metadata Source
//

import * as gcp from '../gcp';
import * as dataplex from '../gcp/dataplex';
import {Layouts} from '../layout';
import {CatalogSource} from '../source';

export class EntryGroupSource implements CatalogSource {
  readonly type: string;
  readonly name: string;
  readonly namespace: string;
  readonly ingestedEntries: boolean;
  readonly layout = Layouts.STANDARD;

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
    this.ingestedEntries = this._name[2].startsWith('@');
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
    // The local catalog uses the entry id as is, nested under namespace/project/location
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
    // `localName()` emits the `<namespace>/<project>/<location>/<entryId>` form
    // on pull, but locally-authored entries may set `name:` to a bare entryId —
    // which can itself contain '/' (e.g. a path-qualified `category/entry`, or a
    // folder `index` like `category/index`). Strip the namespace/project/location
    // prefix ONLY when it's actually present; otherwise the whole name IS the
    // entryId. (The previous `parts.length >= 4 ? slice(3) : last` heuristic
    // silently truncated multi-segment bare ids to their last segment, collapsing
    // every `*/index` onto `index` and dropping the category from leaf ids.)
    const prefix = `${this.namespace}/${this._name[0]}/${this._name[1]}/`;
    const entryId = cleanName.startsWith(prefix)
      ? cleanName.slice(prefix.length)
      : cleanName;
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
