// A context set as a metadata source: one entry group, two local formats.
//
// The entry group holds both the semantic model's entries and the rest of the
// context set. The model half is authored locally as OSI+G and is pulled by
// its own leg (pullSemanticModel), so what this source enumerates is the
// other half -- the entries the OKF bundle owns.
//
// The filter is here rather than in the OKF converter because this is the one
// place every consumer of the scope's entries goes through, and because a
// semantic entry excluded at the list stub costs no lookupEntry.

import * as gcp from '../gcp';
import * as dataplex from '../gcp/dataplex';
import {Layouts} from '../layout';
import * as md from '../metadata';
import {isSemanticEntryType} from '../semantic/entry_types';
import {CatalogSource} from '../source';


export class SplitSource implements CatalogSource {
  readonly type: string;
  readonly name: string;
  readonly ingestedEntries = false;
  readonly layout = Layouts.SPLIT;
  readonly defaultAspects = [md.OVERVIEW_ASPECT];
  readonly systemAspects = [];

  readonly project: string;
  readonly location: string;
  readonly entryGroup: string;

  private readonly _group: dataplex.EntryGroup;

  constructor(type: string, name: string, group: dataplex.EntryGroup) {
    const parts = name.split('.');
    const [project, location, entryGroup] = parts;
    if (!project || !location || !entryGroup || parts.length !== 3) {
      throw new Error(
          'Context set must be in format <projectId>.<locationId>.<entryGroupId>');
    }

    this.type = type;
    this.name = name;
    this.project = project;
    this.location = location;
    this.entryGroup = entryGroup;
    this._group = group;
  }

  /** The full entry-group resource name the OKF half spells its names against. */
  get groupName(): string {
    return this._group.name;
  }

  get entryGroupCreateTime(): string|undefined {
    return this._group?.createTime;
  }

  // Every entry of the context set except the semantic model's own, which the
  // model file holds and the semantic leg pulls.
  async *entries(ctx: gcp.ApiContext): AsyncGenerator<gcp.Entry, void, unknown> {
    const catalog = new gcp.CatalogClient(ctx);
    for await (const entry of catalog.listEntries(
                   this.project, this.location, this.entryGroup)) {
      if (entry.entryType && isSemanticEntryType(entry.entryType)) continue;
      yield entry;
    }
  }

  localName(entry: gcp.Entry): string {
    const match = entry.name.match(/entryGroups\/([^/]+)\/entries\/(.+)$/);
    if (!match) {
      throw new Error(`Invalid entry name for entry: ${entry.name}`);
    }
    return match[2];
  }

  serviceName(localName: string): string {
    return `${this._group.name}/entries/${localName}`;
  }
}
