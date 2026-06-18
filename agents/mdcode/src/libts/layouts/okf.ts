// Implements the OKF (Open Knowledge Format) layout.
//
// OKF (github.com/GoogleCloudPlatform/knowledge-catalog okf/SPEC.md) represents
// knowledge as a directory of markdown files, ONE per concept, each with a YAML
// frontmatter block; reserved `index.md` files are directory listings (the
// bundle-root `index.md` is the only place `okf_version` may appear).
//
// To round-trip Dataplex entries losslessly (a Dataplex entry has more than the
// OKF-spec frontmatter fields can express — arbitrary aspects, entry links,
// resource.parent, …) we ALSO stash the full `md.Entry` under a single hidden
// `x-kcmd` frontmatter key. Per the spec, consumers ignore unknown keys, so the
// file stays a valid OKF concept; kcmd reads `x-kcmd` to reconstruct the entry.
// Files authored without `x-kcmd` (pure hand-written OKF) still load, lossily.

import * as glob from 'glob';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import {CatalogLayout} from '../layout';
import type {CatalogManifest} from '../manifest';
import * as md from '../metadata';

const OVERVIEW_ASPECT_KEY = 'dataplex-types.global.overview';
const GENERIC_ASPECT_KEY = 'dataplex-types.global.generic';
const INDEX_ENTRY_TYPE = 'dataplex-types.global.generic';
const DEFAULT_ENTRY_TYPE = 'dataplex-types.global.generic';
const OKF_VERSION = '0.1';
const STASH_KEY = 'x-kcmd';

export class OkfLayout implements CatalogLayout {
  private readonly _catalogPath: string;
  private readonly _manifest?: CatalogManifest;

  // Maps entry name to its file paths (modifiable and reference layers).
  private readonly _index = new Map<string, {local?: string; ref?: string}>();
  // OKF index.md files carry no frontmatter, so they are not concepts. We still
  // synthesize a directory `index` entry per folder (id `<folder>/index`) so
  // `kcmd push` recreates the Dataplex hierarchy. id -> its index.md path, or
  // `null` for a directory that has entries but no index.md (synthetic, no
  // backing file — its title is derived and it has no overview).
  private readonly _indexPaths = new Map<string, string | null>();

  constructor(catalogPath: string, manifest?: CatalogManifest) {
    this._catalogPath = catalogPath;
    this._manifest = manifest;
  }

  async init(): Promise<void> {
    this._index.clear();
    this._indexPaths.clear();
    if (!fs.existsSync(this._catalogPath)) {
      return;
    }

    const matches = await glob.glob('**/*.md', {
      cwd: this._catalogPath,
      absolute: true,
      nodir: true,
    });

    // Synthetic directory `index` entries are only pushable into a user-managed
    // entry group. Ingested sources (e.g. bq-dataset -> @bigquery system
    // entries, table mode) can't hold custom entries, so we DON'T synthesize
    // index entries there — the index.md files remain as navigation only.
    const synthIndexEntries = !this._manifest?.source?.ingestedEntries;
    // Directories (relative, '' = root) that contain at least one concept, so we
    // can guarantee an index entry per directory even when a folder has no
    // index.md file of its own.
    const dirsWithEntries = new Set<string>();

    for (const localPath of matches) {
      // index.md files carry no frontmatter (they're directory listings), but we
      // register a synthetic directory `index` entry so push recreates the
      // Dataplex hierarchy. id: bundle-root -> "index"; sub -> "<folder>/index".
      if (path.basename(localPath) === 'index.md') {
        if (!synthIndexEntries) {
          continue;
        }
        const rel = path
          .relative(this._catalogPath, localPath)
          .replace(/\\/g, '/');
        const dir = path.dirname(rel);
        const id = dir === '.' ? 'index' : `${dir}/index`;
        this._indexPaths.set(id, localPath);
        continue;
      }
      try {
        const content = await fs.promises.readFile(localPath, 'utf8');
        const {entry} = parseOkf(content);
        // Name: prefer the stashed entry name (x-kcmd may differ from the path,
        // e.g. context overlays) and fall back to a path-derived name so
        // hand-authored / external OKF files (no x-kcmd, no resource URI) — and
        // even frontmatter-less markdown — still index.
        const name =
          entry?.name || deriveEntryName(localPath, this._catalogPath);
        if (!name) {
          continue;
        }
        const entryPaths = this._index.get(name) || {};
        if (localPath.endsWith('.ref.md')) {
          entryPaths.ref = localPath;
        } else {
          entryPaths.local = localPath;
        }
        this._index.set(name, entryPaths);
        // Record this file's directory (and every ancestor) so we can ensure an
        // index entry exists for each level of the tree.
        const reldir = path
          .dirname(path.relative(this._catalogPath, localPath))
          .replace(/\\/g, '/');
        for (const d of ancestorDirs(reldir)) {
          dirsWithEntries.add(d);
        }
      } catch (err) {
        // Skip unreadable/invalid files during indexing.
      }
    }

    // Ensure every directory that holds concepts has an index entry. Folders
    // whose own index.md is absent get a synthetic, file-less entry (null) so a
    // leaf's `parent` never dangles. (kcmd-native bundles always have index.md;
    // this guards arbitrary / hand-authored bundles.)
    if (synthIndexEntries) {
      for (const dir of dirsWithEntries) {
        const id = dir === '' ? 'index' : `${dir}/index`;
        if (!this._indexPaths.has(id)) {
          this._indexPaths.set(id, null);
        }
      }
    }
  }

  entryExists(name: string): boolean {
    if (this._indexPaths.has(name)) {
      const idx = this._indexPaths.get(name);
      return idx == null || fs.existsSync(idx);
    }
    const entryPaths = this._index.get(name);
    return (
      !!entryPaths &&
      ((!!entryPaths.local && fs.existsSync(entryPaths.local)) ||
        (!!entryPaths.ref && fs.existsSync(entryPaths.ref)))
    );
  }

  listEntries(): string[] {
    return [...this._index.keys(), ...this._indexPaths.keys()];
  }

  async loadEntry(name: string): Promise<md.Entry> {
    // Synthetic directory `index` entry: derived from the index.md (which has no
    // frontmatter) plus the directory tree. `null` = no backing index.md file.
    if (this._indexPaths.has(name)) {
      return this._synthIndexEntry(name, this._indexPaths.get(name) ?? null);
    }

    const entryPaths = this._index.get(name);
    if (!entryPaths) {
      throw new Error(`Entry not found: ${name}`);
    }

    let mergedEntry: md.Entry | undefined;

    // Reference layer first, local overrides it (mirrors StandardLayout).
    if (entryPaths.ref && fs.existsSync(entryPaths.ref)) {
      mergedEntry = await this._loadLayer(entryPaths.ref);
    }
    if (entryPaths.local && fs.existsSync(entryPaths.local)) {
      const localEntry = await this._loadLayer(entryPaths.local);
      if (!mergedEntry) {
        mergedEntry = localEntry;
      } else {
        mergedEntry.type = localEntry.type;
        mergedEntry.resource = {
          ...mergedEntry.resource,
          ...localEntry.resource,
        };
        if (localEntry.aspects) {
          mergedEntry.aspects = mergedEntry.aspects ?? {};
          for (const [key, value] of Object.entries(localEntry.aspects)) {
            mergedEntry.aspects[key] = value;
          }
        }
        if (localEntry.links) {
          mergedEntry.links = localEntry.links;
        }
      }
    }

    if (!mergedEntry) {
      throw new Error(`Entry files missing for: ${name}`);
    }
    // A path-derived (stash-less / frontmatter-less) entry has no name of its
    // own — use the index key (its path-derived name) so push targets it.
    if (!mergedEntry.name) {
      mergedEntry.name = name;
    }
    return mergedEntry;
  }

  private async _loadLayer(entryPath: string): Promise<md.Entry> {
    const content = await fs.promises.readFile(entryPath, 'utf8');
    const parsed = parseOkf(content);
    const body = parsed.body;
    // A frontmatter-less markdown file is still a valid concept (body-only):
    // treat it as a default generic entry whose body is the overview.
    const entry =
      parsed.entry ?? ({type: DEFAULT_ENTRY_TYPE, resource: {}} as md.Entry);
    // The markdown body IS the overview aspect content.
    const bodyTrimmed = body.trim();
    if (bodyTrimmed) {
      entry.aspects = entry.aspects ?? {};
      entry.aspects[OVERVIEW_ASPECT_KEY] =
        entry.aspects[OVERVIEW_ASPECT_KEY] ?? {};
      entry.aspects[OVERVIEW_ASPECT_KEY].content = bodyTrimmed;
      entry.aspects[OVERVIEW_ASPECT_KEY].contentType = 'MARKDOWN';
    }
    return entry;
  }

  async saveEntry(name: string, entry: md.Entry): Promise<void> {
    // Directory `index` entries are not materialized as frontmatter files —
    // they're regenerated from the tree by finalize(). On pull, skip writing.
    if (path.basename(name) === 'index') {
      return;
    }

    const entryPath = path.join(this._catalogPath, `${name}.md`);
    await fs.promises.mkdir(path.dirname(entryPath), {recursive: true});

    const entryClone = JSON.parse(JSON.stringify(entry)) as md.Entry;

    // Pull the overview content out to become the markdown body.
    let body = '';
    if (entryClone.aspects?.[OVERVIEW_ASPECT_KEY]) {
      const aspect = entryClone.aspects[OVERVIEW_ASPECT_KEY];
      if (aspect.content !== undefined) {
        body = aspect.content;
        delete aspect.content;
        delete aspect.contentType;
      }
      if (Object.keys(aspect).length === 0) {
        delete entryClone.aspects[OVERVIEW_ASPECT_KEY];
      }
    }

    const fileContent = toOkf(entryClone, body);
    await fs.promises.writeFile(entryPath, fileContent, 'utf8');

    // Index by the entry's own name; the `.ref` suffix on `name` selects layer.
    const entryName = entryClone.name;
    const entryPaths = this._index.get(entryName) || {};
    if (name.endsWith('.ref')) {
      entryPaths.ref = entryPath;
    } else {
      entryPaths.local = entryPath;
    }
    this._index.set(entryName, entryPaths);
  }

  async deleteEntry(name: string): Promise<void> {
    if (this._indexPaths.has(name)) {
      this._indexPaths.delete(name);
      return; // index.md is regenerated by finalize(); nothing else to remove.
    }
    const entryPaths = this._index.get(name);
    const entryPath = entryPaths?.local || entryPaths?.ref;
    if (!entryPath || !fs.existsSync(entryPath)) {
      throw new Error(`Entry not found: ${name}`);
    }
    await fs.promises.unlink(entryPath);
    this._index.delete(name);
  }

  getEntryPaths(name: string): {local?: string; ref?: string} | undefined {
    if (this._indexPaths.has(name)) {
      // Index entries are modifiable (pushable). For a file-less synthetic one,
      // return a placeholder local path — loadEntry routes index ids to
      // _synthIndexEntry, so this value is only used as a truthy modifiable flag.
      const idx = this._indexPaths.get(name);
      return {local: idx ?? path.join(this._catalogPath, `${name}.md`)};
    }
    return this._index.get(name);
  }

  // Build a directory `index` entry from its (frontmatter-free) index.md plus
  // the manifest's source for parent linking. The index.md `# Title` + first
  // paragraph become displayName/description; its body becomes the overview.
  private async _synthIndexEntry(
    id: string,
    indexPath: string | null,
  ): Promise<md.Entry> {
    let raw = '';
    if (indexPath) {
      try {
        raw = await fs.promises.readFile(indexPath, 'utf8');
      } catch (err) {
        raw = '';
      }
    }
    // Drop the root index.md's okf_version frontmatter, if present.
    const lines = raw.split(/\r?\n/);
    let body = raw;
    if (lines[0]?.trim() === '---') {
      const end = lines.indexOf('---', 1);
      if (end !== -1) {
        body = lines.slice(end + 1).join('\n');
      }
    }
    const bodyLines = body.split(/\r?\n/);
    // Default title from the folder name (the segment before `/index`), so a
    // file-less synthetic index still gets a sensible displayName.
    let title = _titleFromIndexId(id);
    let description = '';
    const h = bodyLines.find((l) => l.startsWith('# '));
    if (h) {
      title = h.slice(2).trim();
    }
    // First non-empty, non-heading, non-list line is the folder description.
    for (const l of bodyLines) {
      const t = l.trim();
      if (!t || t.startsWith('#') || t.startsWith('*') || t.startsWith('-')) {
        continue;
      }
      description = t;
      break;
    }

    // The index.md uses bundle-relative `*.md` links (correct for OKF). Those
    // are meaningless in the Dataplex/Pantheon UI (they resolve to broken
    // pantheon.corp.google.com/<file>.md URLs), so the KC index ENTRY's overview
    // is de-linked to plain text. The on-disk OKF bundle keeps its links.
    const aspects: Record<string, md.Aspect> = {
      [GENERIC_ASPECT_KEY]: {
        type: 'knowledge-base-index',
        system: 'enrichment-agent',
      },
    };
    const overview = _delinkMarkdown(body).trim();
    if (overview) {
      // Omit an empty overview aspect (a file-less synthetic index has no body);
      // an empty `content` is rejected by Dataplex on push.
      aspects[OVERVIEW_ASPECT_KEY] = {
        content: overview,
        contentType: 'MARKDOWN',
      };
    }
    const entry: md.Entry = {
      name: id,
      type: INDEX_ENTRY_TYPE,
      resource: {
        displayName: _oneLine(title),
        description: _oneLine(description),
      },
      aspects,
    };

    // Parent = the enclosing directory's index entry (root has none). Bake the
    // full service name via the source so it matches the leaf entries' parents.
    const parentId = _parentIndexId(id);
    if (parentId && this._manifest) {
      entry.resource.parent = this._manifest.source.serviceName(parentId);
    }
    return entry;
  }

  // Regenerate the reserved `index.md` directory listings across the whole
  // bundle. Called after `pull` (Dataplex has no index concept, so we derive the
  // listings from the on-disk tree). The bundle-root index carries okf_version.
  async finalize(): Promise<void> {
    await writeIndexes(this._catalogPath);
  }
}

export function parseOkf(content: string): {
  entry: md.Entry | null;
  body: string;
} {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') {
    return {entry: null, body: content};
  }
  const endIndex = lines.indexOf('---', 1);
  if (endIndex === -1) {
    return {entry: null, body: content};
  }

  const frontmatter = lines.slice(1, endIndex).join('\n');
  const metadata = yaml.parse(frontmatter) || {};
  const body = lines.slice(endIndex + 1).join('\n');

  // Faithful path: the full md.Entry is stashed under `x-kcmd`. Lossy path: no
  // stash, reconstruct what we can from the spec fields.
  const entry = (metadata[STASH_KEY] ?? {}) as md.Entry;
  // Type precedence: a valid 3-part Dataplex type in the frontmatter wins; else
  // keep the stashed type (x-kcmd); else default to generic. This tolerates
  // OKF-native type labels (e.g. `type: "BigQuery Dataset"`) on hand-authored
  // files by falling back to generic instead of pushing an unknown type.
  if (
    typeof metadata.type === 'string' &&
    metadata.type.split('.').length === 3
  ) {
    entry.type = metadata.type;
  } else if (!entry.type) {
    entry.type = DEFAULT_ENTRY_TYPE;
  }
  entry.resource = entry.resource ?? {};
  if (metadata.title !== undefined) {
    entry.resource.displayName = metadata.title;
  }
  if (metadata.description !== undefined) {
    entry.resource.description = metadata.description;
  }
  if (metadata.resource !== undefined && entry.resource.name === undefined) {
    entry.resource.name = metadata.resource;
  }
  if (metadata.tags) {
    entry.resource.labels = entry.resource.labels ?? {};
    for (const tag of metadata.tags) {
      entry.resource.labels[tag] = 'true';
    }
  }
  if (metadata.timestamp) {
    entry.resource.updateTime = entry.resource.updateTime ?? metadata.timestamp;
    if (!entry.resource.createTime) {
      entry.resource.createTime = metadata.timestamp;
    }
  }
  // Lossy fallback: a pure-OKF file with no stash has no entry name; use the
  // resource URI if present so it can still be indexed.
  if (!entry.name && entry.resource.name) {
    entry.name = entry.resource.name;
  }

  // A concept must have at least a type or a name to be a real entry; otherwise
  // (e.g. a root index.md carrying only okf_version) it is not an entry.
  if (!entry.type && !entry.name) {
    return {entry: null, body};
  }
  return {entry, body};
}

export function toOkf(entry: md.Entry, body: string): string {
  const entryClone = JSON.parse(JSON.stringify(entry)) as Record<string, any>;

  const tags: string[] = [];
  if (entry.resource?.labels) {
    for (const [k, v] of Object.entries(entry.resource.labels)) {
      if (v === 'true') {
        tags.push(k);
      }
    }
  }

  const metadata: Record<string, any> = {
    type: entry.type,
    title: entry.resource?.displayName ?? entry.resource?.name,
    description: entry.resource?.description ?? undefined,
    tags: tags.length ? tags : undefined,
    timestamp:
      entry.resource?.updateTime ?? entry.resource?.createTime ?? undefined,
    resource: entry.resource?.name ?? undefined,
    // Faithful round-trip stash (consumers ignore unknown keys per SPEC).
    [STASH_KEY]: entryClone,
  };

  const frontmatter = yaml.stringify(metadata).trim();
  return `---\n${frontmatter}\n---\n${body.endsWith('\n') ? body : body + '\n'}`;
}

// Walks the bundle tree and writes an `index.md` directory listing per folder.
// Non-root indexes carry no frontmatter; the bundle-root index declares
// okf_version (the only place frontmatter is permitted in an index.md).
export async function writeIndexes(rootDir: string): Promise<void> {
  if (!fs.existsSync(rootDir)) {
    return;
  }
  const dirs: string[] = [];
  const walk = (d: string) => {
    dirs.push(d);
    for (const e of fs.readdirSync(d, {withFileTypes: true})) {
      if (e.isDirectory()) {
        walk(path.join(d, e.name));
      }
    }
  };
  walk(rootDir);

  for (const dir of dirs) {
    const isRoot = path.resolve(dir) === path.resolve(rootDir);
    // GA4-style rows: `* [<title>](<link>) - <description>`.
    const rows: string[] = [];
    const entries = fs
      .readdirSync(dir, {withFileTypes: true})
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      let title: string;
      let desc: string;
      let link: string;
      if (e.isDirectory()) {
        link = `${e.name}/index.md`;
        ({title, desc} = _folderMeta(
          path.join(dir, e.name, 'index.md'),
          e.name,
        ));
      } else if (
        e.name.endsWith('.md') &&
        e.name !== 'index.md' &&
        !e.name.endsWith('.ref.md')
      ) {
        link = e.name;
        ({title, desc} = _conceptMeta(path.join(dir, e.name)));
      } else {
        continue;
      }
      title = _oneLine(title);
      desc = _oneLine(desc);
      rows.push(`* [${title}](${link})` + (desc ? ` - ${desc}` : ''));
    }

    const {title: ftitle, desc: fdesc} = isRoot
      ? {title: 'Index', desc: ''}
      : _folderMeta(path.join(dir, 'index.md'), path.basename(dir));
    const lines = [`# ${_oneLine(ftitle)}`, ''];
    if (fdesc) {
      lines.push(_oneLine(fdesc), '');
    }
    if (rows.length) {
      lines.push(...rows);
    } else {
      lines.push('_(empty)_');
    }
    let out = `${lines.join('\n')}\n`;
    if (isRoot) {
      out = `---\nokf_version: "${OKF_VERSION}"\n---\n${out}`;
    }
    fs.writeFileSync(path.join(dir, 'index.md'), out, 'utf8');
  }
}

// Collapse all whitespace (incl. newlines) to single spaces and trim. Used to
// keep index rows / metadata on one line.
function _oneLine(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim();
}

// De-link ONLY bundle-relative markdown links (`[text](foo.md)`, `[text](./a)`)
// to plain text — these resolve to broken URLs in the Dataplex/Pantheon UI.
// Real links with a scheme (http(s)://, mailto:, …) are kept clickable, so
// genuine Citations URLs survive. Used on the KC index entry's overview only.
function _delinkMarkdown(s: string): string {
  return (s || '').replace(/\[([^\]]+)\]\(([^)]*)\)/g, (match, text, target) =>
    /^[a-z][a-z0-9+.-]*:/i.test(target) ? match : text,
  );
}

// Derive an entry name from a concept file's path (relative to the bundle root,
// with the `.md` / `.ref.md` suffix stripped). Used as the name when a file has
// no `x-kcmd`/`resource` stash, so hand-authored OKF bundles still index.
function deriveEntryName(localPath: string, catalogPath: string): string {
  let rel = path.relative(catalogPath, localPath).replace(/\\/g, '/');
  if (rel.endsWith('.ref.md')) {
    rel = rel.slice(0, -'.ref.md'.length);
  } else if (rel.endsWith('.md')) {
    rel = rel.slice(0, -'.md'.length);
  }
  return rel;
}

// A relative directory and all of its ancestors, with '' for the root.
// 'a/b' -> ['a/b', 'a', '']; '.' or '' -> [''].
function ancestorDirs(reldir: string): string[] {
  const out: string[] = [];
  let d = reldir === '.' ? '' : reldir;
  while (d) {
    out.push(d);
    const i = d.lastIndexOf('/');
    d = i >= 0 ? d.slice(0, i) : '';
  }
  out.push('');
  return out;
}

// Default displayName for a directory `index` id, from the folder segment.
// 'a/my_folder/index' -> 'My Folder'; 'index' -> 'Index'.
function _titleFromIndexId(id: string): string {
  const segs = id.split('/');
  const folder = segs.length >= 2 ? segs[segs.length - 2] : 'Index';
  return folder
    .replace(/[-_]/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// The enclosing directory's index id for a given index id (root has none).
function _parentIndexId(id: string): string | null {
  if (id === 'index') {
    return null;
  }
  const folder = id.endsWith('/index') ? id.slice(0, -'/index'.length) : '';
  if (!folder) {
    return null;
  }
  const slash = folder.lastIndexOf('/');
  const parentFolder = slash >= 0 ? folder.slice(0, slash) : '';
  return parentFolder ? `${parentFolder}/index` : 'index';
}

// (title, description) for a concept .md, from its YAML frontmatter.
function _conceptMeta(mdPath: string): {title: string; desc: string} {
  const fallback = path.basename(mdPath).slice(0, -3);
  try {
    const {entry} = parseOkf(fs.readFileSync(mdPath, 'utf8'));
    return {
      title: entry?.resource?.displayName || fallback,
      desc: entry?.resource?.description || '',
    };
  } catch (err) {
    return {title: fallback, desc: ''};
  }
}

// (title, description) for a folder, read from its (frontmatter-free) index.md:
// the `# Title` heading and the first non-heading/non-list paragraph.
function _folderMeta(
  indexPath: string,
  fallbackTitle: string,
): {title: string; desc: string} {
  try {
    const raw = fs.readFileSync(indexPath, 'utf8');
    const lines = raw.split(/\r?\n/);
    let body = lines;
    if (lines[0]?.trim() === '---') {
      const end = lines.indexOf('---', 1);
      if (end !== -1) {
        body = lines.slice(end + 1);
      }
    }
    const h = body.find((l) => l.startsWith('# '));
    let desc = '';
    for (const l of body) {
      const t = l.trim();
      if (!t || t.startsWith('#') || t.startsWith('*') || t.startsWith('-')) {
        continue;
      }
      desc = t;
      break;
    }
    return {title: h ? h.slice(2).trim() : fallbackTitle, desc};
  } catch (err) {
    return {title: fallbackTitle, desc: ''};
  }
}
