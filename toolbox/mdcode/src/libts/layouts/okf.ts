// A catalog laid out as an OKF bundle: one markdown file per concept.
//
// OKF (github.com/GoogleCloudPlatform/knowledge-catalog okf/SPEC.md) keeps
// knowledge as a directory of markdown files, each with a YAML frontmatter
// block. A Dataplex entry holds more than the spec's frontmatter can say --
// arbitrary aspects, the entry type, resource.parent -- so the whole service
// entry is also stashed under a hidden `x-kcmd` key. Consumers ignore unknown
// keys (SPEC 4.1), so the file stays a valid OKF concept while kcmd can
// rebuild the entry exactly.
//
// Reserved files are not entries. `index.md` is a directory listing and
// `log.md` is the bundle log; the spec gives both a meaning that is not "a
// concept", and `kcmd pull` never writes them. They are skipped rather than
// turned into synthetic entries, which would publish navigation into the
// catalog.
//
// A concept with no `x-kcmd.entryType` -- a hand-authored bundle -- indexes
// and lists, but fails to load, because its catalog entry type is genuinely
// unknown. That is the pre-existing limit of conceptToEntry, not a new one.

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as glob from 'glob';

import {pathInside, readFileIfExists, writeFileAtomic} from '../fsutil';
import {CatalogLayout} from '../layout';
import * as md from '../metadata';
import {Concept, conceptToFileContent, fileContentToConcept, RESIDUE_KEY} from '../okf/concept';
import {conceptToEntry} from '../okf/concept_to_entry';
import {localEntryToService, serviceEntryToLocal} from '../okf/entry_bridge';
import {entryToConcept} from '../okf/entry_to_concept';
import {deleteEachEntry, saveEachEntry} from './batch';

// Files the OKF spec reserves for navigation, which are never concepts.
const RESERVED_BASENAMES: ReadonlySet<string> = new Set(['index.md', 'log.md']);

// entrySource fields md.Entry has nowhere to put. They live in the concept's
// residue and are carried from the file being overwritten, so editing an
// entry through `kcmd entry save` cannot silently drop them.
const CARRIED_SOURCE_FIELDS: readonly string[] = ['system', 'platform'];

export class OkfLayout implements CatalogLayout {
  private readonly _bundlePath: string;
  private readonly _entryGroup: string;

  // Entry name -> the file holding it. The name is the concept's path in the
  // bundle without `.md`, which is also its Dataplex entry ID.
  private readonly _index = new Map<string, string>();

  // `entryGroup` is the full entry-group resource name this workspace is
  // bound to; the concept's residue spells names relative to it.
  constructor(bundlePath: string, entryGroup: string) {
    this._bundlePath = bundlePath;
    this._entryGroup = entryGroup;
  }

  async init(): Promise<void> {
    this._index.clear();
    if (!fs.existsSync(this._bundlePath)) return;

    const matches = await glob.glob('**/*.md', {
      cwd: this._bundlePath,
      absolute: true,
      nodir: true,
    });

    for (const file of matches) {
      if (RESERVED_BASENAMES.has(path.basename(file))) continue;
      const rel = path.relative(this._bundlePath, file).replace(/\\/g, '/');
      this._index.set(rel.slice(0, -'.md'.length), file);
    }
  }

  entryExists(name: string): boolean {
    const file = this._index.get(name);
    return !!file && fs.existsSync(file);
  }

  listEntries(): string[] {
    return [...this._index.keys()].sort();
  }

  async loadEntry(name: string): Promise<md.Entry> {
    const file = this._index.get(name);
    if (!file) throw new Error(`Entry not found: ${name}`);
    const text = await readFileIfExists(file);
    if (text === undefined) throw new Error(`Entry not found: ${name}`);
    const concept = fileContentToConcept(text, name);
    return serviceEntryToLocal(conceptToEntry(concept, this._entryGroup), name);
  }

  async saveEntry(name: string, entry: md.Entry): Promise<void> {
    // An entry already in the index is rewritten where it was found; a new one
    // goes to `<name>.md`, which must stay inside the bundle folder.
    const file = this._index.get(name) ??
        pathInside(this._bundlePath, `${name}.md`, 'entry name');

    const before = await readFileIfExists(file);
    const existing =
        before === undefined ? undefined : fileContentToConcept(before, name);

    const service =
        localEntryToService(entry, this._entryGroup, carriedSource(existing));
    const concept = entryToConcept(service, name);
    carryUnknownKeys(concept, existing);

    const text = conceptToFileContent(concept);
    // Leave an unchanged concept's file alone, so its modification time
    // survives a save of what was read.
    if (before === text) {
      this._index.set(name, file);
      return;
    }

    await fs.promises.mkdir(path.dirname(file), {recursive: true});
    await writeFileAtomic(file, text);
    this._index.set(name, file);
  }

  async deleteEntry(name: string): Promise<void> {
    const file = this._index.get(name);
    if (!file || !fs.existsSync(file)) {
      throw new Error(`Entry not found: ${name}`);
    }
    await fs.promises.unlink(file);
    this._index.delete(name);
  }

  async saveEntries(entries: md.Entry[]): Promise<md.EntryResult[]> {
    return saveEachEntry(this, entries);
  }

  async deleteEntries(names: string[]): Promise<md.EntryResult[]> {
    return deleteEachEntry(this, names);
  }
}

// The entrySource fields to carry from the concept being overwritten.
function carriedSource(existing: Concept | undefined): Record<string, unknown> {
  const residue = existing?.frontmatter?.[RESIDUE_KEY];
  if (!residue || typeof residue !== 'object' || Array.isArray(residue)) {
    return {};
  }
  const source = (residue as Record<string, unknown>)['entrySource'];
  if (!source || typeof source !== 'object' || Array.isArray(source)) return {};

  const carried: Record<string, unknown> = {};
  for (const field of CARRIED_SOURCE_FIELDS) {
    const value = (source as Record<string, unknown>)[field];
    if (value !== undefined) carried[field] = value;
  }
  return carried;
}

// SPEC 4.1: preserve what we do not model. Every frontmatter key the concept
// already carried that this layout does not itself derive -- a producer
// extension, say -- is carried into the rewrite. The v0.2 keys kcmd knows
// (`sources`, `status`, ...) do not rely on this: they travel through the
// overview's OKF Metadata section and come back via entryToConcept.
function carryUnknownKeys(concept: Concept, existing: Concept | undefined): void {
  if (!existing) return;
  for (const [key, value] of Object.entries(existing.frontmatter)) {
    if (key === RESIDUE_KEY) continue;
    if (concept.frontmatter[key] === undefined) concept.frontmatter[key] = value;
  }
}
