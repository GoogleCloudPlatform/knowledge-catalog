// A context set held in two formats at once.
//
// One workspace, two layouts: the semantic model as OSI+G under
// `catalog/EntryGroups/<group>/`, and every other entry of the context set as
// an OKF bundle under `bundle/`. Both halves publish into the same Dataplex
// entry group, so an entry belongs to exactly one of them and the split is by
// entry type (libts/semantic/entry_types.ts).
//
// Routing differs by operation because the inputs differ. A save carries the
// entry, so its declared type decides. A delete carries only a name, so the
// half that holds it decides.
//
// Nothing here writes: both children keep their own rules, and CatalogSnapshot
// above still takes the workspace lock and applies the cross-item checks.

import {isSemanticEntryType} from '../semantic/entry_types';
import {CatalogLayout} from '../layout';
import * as md from '../metadata';
import {messageOf} from './batch';
import {OkfLayout} from './okf';
import {SemanticModelLayout} from './semantic-model';

export class SplitLayout implements CatalogLayout {
  private readonly _semantic: SemanticModelLayout;
  private readonly _okf: OkfLayout;
  private _warned = false;

  constructor(semantic: SemanticModelLayout, okf: OkfLayout) {
    this._semantic = semantic;
    this._okf = okf;
  }

  /** The semantic half, for the pull and push legs that drive it directly. */
  get semantic(): SemanticModelLayout {
    return this._semantic;
  }

  /** The OKF half, for the same reason. */
  get okf(): OkfLayout {
    return this._okf;
  }

  // Only indexes the two halves. Reading the semantic half's entries parses
  // the model file, which needs the SQL parser, and `pull` and `push` open
  // the workspace before they load it -- so nothing here may ask either half
  // what entries it has.
  async init(): Promise<void> {
    await this._semantic.init();
    await this._okf.init();
  }

  // Both halves name entries in one entry group, so a concept named for a
  // model element is two local writers for one server object. Reads take the
  // semantic one, which would otherwise shadow the concept silently -- and
  // silent shadowing is how a concept goes missing from a push. Warned once,
  // from listEntries, which is the cheapest point that has already paid for
  // the model file to be read.
  private _warnCollisionsOnce(): void {
    if (this._warned) return;
    this._warned = true;

    const collisions = this._okf.listEntries().filter(
        name => this._semantic.entryExists(name));
    if (!collisions.length) return;
    console.warn(
        `Warning: ${collisions.length} entr${
            collisions.length === 1 ? 'y is' : 'ies are'} in both halves of ` +
        `this workspace: ${collisions.join(', ')}. The semantic model's ` +
        `copy is the one that is read. Remove the concept from bundle/ or ` +
        `rename the model element.`);
  }

  entryExists(name: string): boolean {
    return this._semantic.entryExists(name) || this._okf.entryExists(name);
  }

  // The semantic model's entries first, in the order its view gives them
  // (anchor, entities, metrics, actions, constraints, relationships), which
  // is meaningful; then the bundle's. A collision is listed once, under the
  // half that a read would reach.
  listEntries(): string[] {
    this._warnCollisionsOnce();
    const names = this._semantic.listEntries();
    const seen = new Set(names);
    for (const name of this._okf.listEntries()) {
      if (!seen.has(name)) {
        seen.add(name);
        names.push(name);
      }
    }
    return names;
  }

  async loadEntry(name: string): Promise<md.Entry> {
    if (this._semantic.entryExists(name)) return this._semantic.loadEntry(name);
    return this._okf.loadEntry(name);
  }

  async saveEntry(name: string, entry: md.Entry): Promise<void> {
    const [result] = await this.saveEntries([{...entry, name}]);
    if (!result.ok) throw new Error(result.error);
  }

  async deleteEntry(name: string): Promise<void> {
    const [result] = await this.deleteEntries([name]);
    if (!result.ok) throw new Error(result.error);
  }

  // Each item goes to the half its type names. An item whose type sends it to
  // one half while the other already holds that name is failed rather than
  // written, so a save never creates the second copy.
  //
  // Each half is called at most once, with its items in their original
  // relative order: SemanticModelLayout validates and writes all of its items
  // together, so splitting or reordering them would change what it accepts.
  async saveEntries(entries: md.Entry[]): Promise<md.EntryResult[]> {
    const results: md.EntryResult[] = new Array(entries.length);
    const toSemantic: number[] = [];
    const toOkf: number[] = [];

    entries.forEach((entry, i) => {
      const semantic = isSemanticEntryType(entry.type);
      const other = semantic ? this._okf : this._semantic;
      if (other.entryExists(entry.name)) {
        results[i] = {
          name: entry.name,
          ok: false,
          error: collisionMessage(entry.name, semantic),
        };
        return;
      }
      (semantic ? toSemantic : toOkf).push(i);
    });

    const nameAt = (i: number) => entries[i].name;
    await this._apply(
        results, toSemantic, nameAt,
        () => this._semantic.saveEntries(toSemantic.map(i => entries[i])));
    await this._apply(
        results, toOkf, nameAt,
        () => this._okf.saveEntries(toOkf.map(i => entries[i])));
    return results;
  }

  // Routing has only a name here, so the half holding it decides. A name both
  // halves hold is refused rather than guessed: deleting only the model
  // element would leave the concept behind to recreate it on the next push.
  async deleteEntries(names: string[]): Promise<md.EntryResult[]> {
    const results: md.EntryResult[] = new Array(names.length);
    const toSemantic: number[] = [];
    const toOkf: number[] = [];

    names.forEach((name, i) => {
      const inSemantic = this._semantic.entryExists(name);
      const inOkf = this._okf.entryExists(name);
      if (inSemantic && inOkf) {
        results[i] = {name, ok: false, error: collisionMessage(name)};
      } else if (inSemantic) {
        toSemantic.push(i);
      } else if (inOkf) {
        toOkf.push(i);
      } else {
        // Answered here rather than by a child, whose message would say which
        // half was guessed at.
        results[i] = {name, ok: false, error: `Entry not found: ${name}`};
      }
    });

    const nameAt = (i: number) => names[i];
    await this._apply(
        results, toSemantic, nameAt,
        () => this._semantic.deleteEntries(toSemantic.map(i => names[i])));
    await this._apply(
        results, toOkf, nameAt,
        () => this._okf.deleteEntries(toOkf.map(i => names[i])));
    return results;
  }

  // Runs one half's batch and scatters its results back to the positions its
  // items came from. A half that throws as a whole fails only its own items.
  private async _apply(
      results: md.EntryResult[], indexes: number[],
      nameAt: (index: number) => string,
      run: () => Promise<md.EntryResult[]>): Promise<void> {
    if (!indexes.length) return;

    let batch: md.EntryResult[];
    try {
      batch = await run();
    } catch (err) {
      for (const i of indexes) {
        results[i] = {name: nameAt(i), ok: false, error: messageOf(err)};
      }
      return;
    }

    if (batch.length !== indexes.length) {
      throw new Error(
          `a layout returned ${batch.length} result(s) for ${
              indexes.length} item(s)`);
    }
    indexes.forEach((target, k) => {
      results[target] = batch[k];
    });
  }
}

function collisionMessage(name: string, savingToSemantic?: boolean): string {
  const where = savingToSemantic === undefined ?
      `'${name}' is both an element of the semantic model and a concept in the OKF bundle` :
      savingToSemantic ?
      `'${name}' is already a concept in the OKF bundle` :
      `'${name}' is already an element of the semantic model`;
  return `${where}; both halves publish into one entry group, so remove the ` +
      `copy you do not want before saving.`;
}
