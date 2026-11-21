// Implements the Open Knowledge Format (OKF) layout (`bundle/<id>.md`).

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as dataplex from '../gcp/dataplex';
import {CatalogLayout} from '../layout';
import * as md from '../metadata';
import {
  Concept,
  conceptToFileContent,
  EXTRA_KEY,
  fileContentToConcept,
  RESIDUE_KEY,
} from '../okf/concept';
import {conceptToEntry, entryToConcept} from '../okf/concept_to_entry';
import {
  BundleLinksResult,
  formatLinksYaml,
  LINKS_FILE,
  readBundleLinks,
} from '../okf/links';

export const BUNDLE_DIR = 'bundle';

const FALLBACK_CONTAINER = 'projects/_/locations/_/entryGroups/_';

function mapping(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function conceptFiles(dir: string, realRoot?: string): string[] {
  const root = realRoot ?? fs.realpathSync(dir);
  return fs
    .readdirSync(dir, {withFileTypes: true})
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => {
      // Skip hidden dot-files and dot-directories (e.g. `.git`, `.staging`).
      if (e.name.startsWith('.')) return [];
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        // Do not follow symlinks that resolve outside the bundle root.
        let realTarget: string;
        let stat: fs.Stats;
        try {
          realTarget = fs.realpathSync(p);
          stat = fs.statSync(p);
        } catch {
          return [];
        }
        if (realTarget !== root && !realTarget.startsWith(root + path.sep)) {
          return [];
        }
        if (stat.isDirectory()) return conceptFiles(p, root);
        return e.name.endsWith('.md') ? [p] : [];
      }
      if (e.isDirectory()) return conceptFiles(p, root);
      return e.name.endsWith('.md') ? [p] : [];
    });
}

function toPosixId(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/').replace(/\.md$/, '');
}

/**
 * Resolves the catalog entry ID a concept file maps to, or `undefined` when the
 * file should be skipped (`<group>_entry`, reserved `log.md` at any level per
 * OKF v0.2 §§3.1, 9, or a generated `index.md` shadowed by an explicit
 * `agents.md` / `<dir>.md`).
 *
 * Documented `kcmd` OKF workspace extensions beyond OKF v0.2:
 * - Root `bundle/index.md` maps to the `agents` catalog entry and
 *   `bundle/<dir>/index.md` maps to `<dir>` (unless shadowed by an explicit
 *   `bundle/agents.md` or `bundle/<dir>.md` when `index.md` carries no explicit
 *   concept metadata).
 * - A `log.md` carrying `x-kcmd` / `extra` metadata from a pulled remote entry
 *   is preserved as an entry rather than skipped.
 * - `conceptFiles()` skips hidden dot-paths (e.g. `.git`, `.staging`) and
 *   symlinks resolving outside `bundle/`.
 */
function resolvedEntryName(
  id: string,
  frontmatter: Record<string, unknown>,
  bundlePath: string,
): string | undefined {
  const residue = mapping(frontmatter[RESIDUE_KEY]);
  const extra = mapping(frontmatter[EXTRA_KEY]);
  if (
    text(residue['entryType'])?.endsWith('/entrygroup') ||
    text(extra['type'])?.endsWith('/entrygroup')
  ) {
    return undefined;
  }

  const hasConceptType =
    text(frontmatter['type']) !== undefined ||
    text(residue['entryType']) !== undefined ||
    text(extra['type']) !== undefined;
  const hasExplicitMeta =
    frontmatter[RESIDUE_KEY] !== undefined ||
    frontmatter[EXTRA_KEY] !== undefined ||
    hasConceptType;

  // OKF v0.2 §§3.1, 9: `log.md` at any level is a reserved history file, never
  // a concept, unless it is a pulled remote entry carrying `x-kcmd` / `extra`.
  if (
    (id === 'log' || id.endsWith('/log')) &&
    frontmatter[RESIDUE_KEY] === undefined &&
    frontmatter[EXTRA_KEY] === undefined
  ) {
    return undefined;
  }

  // When `agents.md` or `<dir>.md` already exists alongside a directory-listing
  // `index.md` that has no explicit concept metadata, prefer the explicit file.
  if (
    id === 'index' &&
    !hasExplicitMeta &&
    fs.existsSync(path.join(bundlePath, 'agents.md'))
  ) {
    return undefined;
  }
  if (
    id.endsWith('/index') &&
    !hasExplicitMeta &&
    fs.existsSync(path.join(bundlePath, `${id.slice(0, -'/index'.length)}.md`))
  ) {
    return undefined;
  }

  const explicitId = text(residue['entryId']) ?? text(extra['entry_id']);
  if (explicitId) return explicitId;

  const hasExplicitType =
    text(residue['entryType']) !== undefined ||
    text(extra['type']) !== undefined;
  if (!hasExplicitType) {
    if (id === 'index') return 'agents';
    if (id.endsWith('/index')) return id.slice(0, -'/index'.length);
  }
  return id;
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
      let entryName: string | undefined = id;
      try {
        const concept = fileContentToConcept(fs.readFileSync(file, 'utf8'), id);
        entryName = resolvedEntryName(id, concept.frontmatter, this._bundlePath);
      } catch {
        // Defer frontmatter parse errors to loadEntry so pull --force-remove
        // can still overwrite or prune a corrupted local concept file.
      }
      if (!entryName) continue;
      this._index.set(entryName, file);
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
    const textContent = await fs.promises.readFile(file, 'utf8');
    const concept = fileContentToConcept(textContent, id);
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
    const prevFile = this._index.get(name);
    const file = this.resolveConceptPath(name);
    const concept = this.previewConcept(name, entry);
    await fs.promises.mkdir(path.dirname(file), {recursive: true});
    await fs.promises.writeFile(file, conceptToFileContent(concept), 'utf8');
    if (
      prevFile &&
      path.resolve(prevFile) !== path.resolve(file) &&
      fs.existsSync(prevFile)
    ) {
      await fs.promises.unlink(prevFile);
    }
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

  /** Reads `bundle/_links.yaml` plus any frontmatter `links` on indexed concepts. */
  readLinks(): BundleLinksResult {
    const concepts: Concept[] = [];
    for (const name of this.listEntries()) {
      const file = this._index.get(name);
      if (!file || !fs.existsSync(file)) continue;
      concepts.push(fileContentToConcept(fs.readFileSync(file, 'utf8'), name));
    }
    return readBundleLinks(this._bundlePath, this._container, concepts);
  }

  /** Writes or removes `bundle/_links.yaml` to match pulled EntryLinks. */
  async writeLinks(links: dataplex.EntryLink[]): Promise<void> {
    const linksPath = path.join(this._bundlePath, LINKS_FILE);
    if (links.length > 0) {
      await fs.promises.mkdir(this._bundlePath, {recursive: true});
      await fs.promises.writeFile(
        linksPath,
        formatLinksYaml(links, this._container),
        'utf8',
      );
    } else if (fs.existsSync(linksPath)) {
      await fs.promises.unlink(linksPath);
    }
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
