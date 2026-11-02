// Implements the Open Knowledge Format (OKF) layout (`bundle/<id>.md`).

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as dataplex from '../gcp/dataplex';
import {CatalogLayout} from '../layout';
import * as md from '../metadata';
import {
  Concept,
  conceptToFileContent,
  fileContentToConcept,
  RESIDUE_KEY,
} from '../okf/concept';
import {conceptToEntry, entryToConcept} from '../okf/concept_to_entry';

export const BUNDLE_DIR = 'bundle';

const FALLBACK_CONTAINER = 'projects/_/locations/_/entryGroups/_';

function conceptFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, {withFileTypes: true})
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) return conceptFiles(p);
      return e.name.endsWith('.md') ? [p] : [];
    });
}

function toPosixId(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/').replace(/\.md$/, '');
}

function residueEntryType(frontmatter: Record<string, unknown>): string | undefined {
  const raw = frontmatter[RESIDUE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const et = (raw as Record<string, unknown>)['entryType'];
  return typeof et === 'string' ? et : undefined;
}

function toLocalFromService(entry: dataplex.Entry, localName: string): md.Entry {
  const aspects: Record<string, md.Aspect> = {};
  if (entry.aspects) {
    for (const [key, val] of Object.entries(entry.aspects)) {
      aspects[key] = val.data ?? {};
    }
  }
  const src = entry.entrySource ?? {};
  const resource: md.Entry['resource'] = {};
  if (src.resource !== undefined) resource.name = src.resource;
  if (src.system !== undefined) resource.system = src.system;
  if (src.platform !== undefined) resource.platform = src.platform;
  if (src.displayName !== undefined) resource.displayName = src.displayName;
  if (src.description !== undefined) resource.description = src.description;
  if (src.labels !== undefined) resource.labels = src.labels;
  if (src.location !== undefined) resource.location = src.location;
  if (src.ancestors !== undefined) resource.ancestors = src.ancestors;
  if (src.createTime !== undefined) resource.createTime = src.createTime;
  if (src.updateTime !== undefined) resource.updateTime = src.updateTime;

  if (entry.parentEntry) {
    const at = entry.parentEntry.indexOf('/entries/');
    resource.parent =
      at !== -1
        ? entry.parentEntry.slice(at + '/entries/'.length)
        : entry.parentEntry;
  }

  return {
    name: localName,
    type: dataplex._nameToTypeRef(entry.entryType),
    resource,
    aspects: Object.keys(aspects).length ? aspects : undefined,
  };
}

function toServiceFromLocal(entry: md.Entry, container: string): dataplex.Entry {
  const entryType = entry.type.includes('/')
    ? entry.type
    : dataplex._typeRefToName(entry.type, 'entry');
  const res = entry.resource ?? {};

  let parentEntry: string | undefined;
  if (res.parent) {
    parentEntry = res.parent.startsWith('projects/')
      ? res.parent
      : `${container}/entries/${res.parent}`;
  }

  const source: NonNullable<dataplex.Entry['entrySource']> = {};
  if (res.name !== undefined) source.resource = res.name;
  if (res.system !== undefined) source.system = res.system;
  if (res.platform !== undefined) source.platform = res.platform;
  if (res.displayName !== undefined) source.displayName = res.displayName;
  if (res.description !== undefined) source.description = res.description;
  if (res.labels !== undefined) source.labels = res.labels;
  if (res.location !== undefined) source.location = res.location;
  if (res.ancestors !== undefined) source.ancestors = res.ancestors;
  if (res.createTime !== undefined) source.createTime = res.createTime;
  if (res.updateTime !== undefined) source.updateTime = res.updateTime;

  const aspects: Record<string, dataplex.Aspect> = {};
  for (const [key, data] of Object.entries(entry.aspects ?? {})) {
    aspects[key] = {data};
  }

  const out: dataplex.Entry = {
    name: `${container}/entries/${entry.name}`,
    entryType,
  };
  if (parentEntry) out.parentEntry = parentEntry;
  if (Object.keys(source).length) out.entrySource = source;
  if (Object.keys(aspects).length) out.aspects = aspects;
  return out;
}

export class OkfLayout implements CatalogLayout {
  private readonly _bundlePath: string;
  private readonly _container: string;
  private readonly _index = new Map<string, string>();

  constructor(bundlePath: string, entryGroupContainer?: string) {
    this._bundlePath = bundlePath;
    this._container =
      entryGroupContainer && entryGroupContainer.startsWith('projects/')
        ? entryGroupContainer
        : FALLBACK_CONTAINER;
  }

  get bundlePath(): string {
    return this._bundlePath;
  }

  bundleExists(): boolean {
    return fs.existsSync(this._bundlePath);
  }

  /** Resolves `<bundle>/<id>.md`, rejecting any ID that escapes `bundle/`. */
  resolveConceptPath(id: string): string {
    if (
      !id ||
      id.includes('\0') ||
      path.posix.isAbsolute(id) ||
      path.win32.isAbsolute(id)
    ) {
      throw new Error(`entry id '${id}' escapes ${BUNDLE_DIR}/`);
    }
    const root = path.resolve(this._bundlePath);
    const file = path.resolve(root, `${id}.md`);
    if (!file.startsWith(root + path.sep)) {
      throw new Error(`entry id '${id}' escapes ${BUNDLE_DIR}/`);
    }
    return file;
  }

  /** Display path relative to workspace root (e.g. `bundle/tables/trips.md`). */
  relativeBundlePath(name: string): string {
    const existing = this._index.get(name);
    if (existing) {
      const rel = path
        .relative(this._bundlePath, existing)
        .split(path.sep)
        .join('/');
      return `${BUNDLE_DIR}/${rel}`;
    }
    return `${BUNDLE_DIR}/${name}.md`;
  }

  async init(): Promise<void> {
    this._index.clear();
    if (!fs.existsSync(this._bundlePath)) return;

    for (const file of conceptFiles(this._bundlePath)) {
      const id = toPosixId(this._bundlePath, file);
      try {
        const concept = fileContentToConcept(fs.readFileSync(file, 'utf8'), id);
        if (residueEntryType(concept.frontmatter)?.endsWith('/entrygroup')) {
          continue;
        }
      } catch {
        // Defer frontmatter parse errors to loadEntry so pull --force-remove
        // can still overwrite or prune a corrupted local concept file.
      }
      this._index.set(id, file);
    }
  }

  entryExists(name: string): boolean {
    const p = this._index.get(name);
    return !!p && fs.existsSync(p);
  }

  listEntries(): string[] {
    return [...this._index.keys()].sort((a, b) => {
      const depthDiff = a.split('/').length - b.split('/').length;
      return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
    });
  }

  async loadEntry(name: string): Promise<md.Entry> {
    const file = this._index.get(name);
    if (!file || !fs.existsSync(file)) {
      throw new Error(`Entry not found: ${name}`);
    }
    const id = toPosixId(this._bundlePath, file);
    const text = await fs.promises.readFile(file, 'utf8');
    const concept = fileContentToConcept(text, id);
    const gcpEntry = conceptToEntry(concept, this._container);
    return toLocalFromService(gcpEntry, name);
  }

  /** Validates and builds the `Concept` `saveEntry` would write, without I/O. */
  previewConcept(name: string, entry: md.Entry): Concept {
    this.resolveConceptPath(name);
    const gcpEntry = toServiceFromLocal({...entry, name}, this._container);
    return entryToConcept(gcpEntry, name);
  }

  async saveEntry(name: string, entry: md.Entry): Promise<void> {
    const file = this.resolveConceptPath(name);
    const concept = this.previewConcept(name, entry);
    await fs.promises.mkdir(path.dirname(file), {recursive: true});
    await fs.promises.writeFile(file, conceptToFileContent(concept), 'utf8');
    this._index.set(name, file);
  }

  async deleteEntry(name: string): Promise<void> {
    const indexed = this._index.get(name);
    const root = path.resolve(this._bundlePath);
    const file = indexed ? path.resolve(indexed) : this.resolveConceptPath(name);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      throw new Error(`Entry not found: ${name}`);
    }
    await fs.promises.unlink(file);
    this._index.delete(name);
    this._pruneEmptyDirs(path.dirname(file), root);
  }

  private _pruneEmptyDirs(dir: string, stopAt: string): void {
    let cur = path.resolve(dir);
    while (cur.startsWith(stopAt + path.sep) && cur !== stopAt) {
      if (!fs.existsSync(cur) || fs.readdirSync(cur).length > 0) break;
      fs.rmdirSync(cur);
      cur = path.dirname(cur);
    }
  }
}
