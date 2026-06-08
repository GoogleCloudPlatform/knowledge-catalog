// Implements the documents layout (markdown files in directory)
//

import * as fs from 'node:fs';
import * as glob from 'glob';
import * as path from 'node:path';
import * as yaml from 'yaml';
import * as md from '../metadata';
import { CatalogLayout } from '../layout';

const OVERVIEW_ASPECT_KEY = 'dataplex-types.global.overview';
const DEFAULT_ENTRY_TYPE = 'dataplex-types.global.generic';
const INDEX_NAME = 'index';


export class DocumentsLayout implements CatalogLayout {

  private _catalogPath: string = '';

  // Maps entry name -> local file path, or null for synthetic directory-index
  // entries that don't have a backing file on disk.
  private readonly _index = new Map<string, string | null>();

  constructor(catalogPath: string) {
    this._catalogPath = catalogPath;
  }

  async init(): Promise<void> {
    this._index.clear();

    if (!fs.existsSync(this._catalogPath)) {
      return;
    }

    const matches = await glob.glob('**/*.md', {
      cwd: this._catalogPath,
      absolute: true,
      nodir: true,
    });

    for (const localPath of matches) {
      const name = deriveEntryNameFromPath(localPath, this._catalogPath);
      this._index.set(name, localPath);
    }

    this._synthesizeIndexEntries();
  }

  entryExists(name: string): boolean {
    return this._index.has(name);
  }

  listEntries(): string[] {
    return Array.from(this._index.keys());
  }

  async loadEntry(name: string): Promise<md.Entry> {
    if (!this._index.has(name)) {
      throw new Error(`Entry not found: ${name}`);
    }
    const entryPath = this._index.get(name) ?? null;

    let parsed: md.Entry | null = null;
    let body = '';
    if (entryPath) {
      const content = await fs.promises.readFile(entryPath, 'utf8');
      const result = parseMarkdown(content);
      parsed = result.entry;
      body = result.body;
    }

    const entry: md.Entry = parsed ?? ({ type: DEFAULT_ENTRY_TYPE, resource: {} } as md.Entry);
    entry.name = name;

    entry.resource = entry.resource ?? {};
    const parentName = deriveParentLocalName(name);
    if (parentName !== undefined) {
      entry.resource.parent = parentName;
    } else {
      delete entry.resource.parent;
    }

    // Ensure the entry's type aspect is present — Dataplex create requires it.
    entry.aspects = entry.aspects ?? {};
    entry.aspects[entry.type] = entry.aspects[entry.type] ?? {};

    const bodyTrimmed = body.trim();
    if (bodyTrimmed) {
      if (!entry.aspects[OVERVIEW_ASPECT_KEY]) {
        entry.aspects[OVERVIEW_ASPECT_KEY] = {};
      }
      entry.aspects[OVERVIEW_ASPECT_KEY].content = bodyTrimmed;
      entry.aspects[OVERVIEW_ASPECT_KEY].contentType = 'MARKDOWN';
    }
    return entry;
  }

  async saveEntry(name: string, entry: md.Entry): Promise<void> {
    const entryPath = path.join(this._catalogPath, `${name}.md`);
    await fs.promises.mkdir(path.dirname(entryPath), { recursive: true });

    // Clone to avoid mutating original entry aspects
    const clonedEntry = JSON.parse(JSON.stringify(entry)) as md.Entry;
    let body = '';

    if (clonedEntry.aspects?.[OVERVIEW_ASPECT_KEY]) {
      const aspect = clonedEntry.aspects[OVERVIEW_ASPECT_KEY];
      if (aspect.content !== undefined) {
        body = aspect.content;
        delete aspect.content;
        delete aspect.contentType;
      }
    }

    const fileContent = toMarkdown(clonedEntry, body);

    await fs.promises.writeFile(entryPath, fileContent, 'utf8');
    this._index.set(name, entryPath);
    this._synthesizeIndexEntries();
  }

  async deleteEntry(name: string): Promise<void> {
    const entryPath = this._index.get(name);
    if (!entryPath) {
      throw new Error(`Entry not found: ${name}`);
    }
    if (!fs.existsSync(entryPath)) {
      throw new Error(`Entry not found: ${name}`);
    }

    await fs.promises.unlink(entryPath);
    this._index.delete(name);
    this._synthesizeIndexEntries();
  }

  // Ensure every directory that contains entries has an index entry. Directories
  // whose own index file is absent get a synthetic entry (no backing file).
  // Synthetic entries left behind by a previous synthesis pass are dropped if
  // their directory no longer has any other entries.
  private _synthesizeIndexEntries(): void {
    for (const [name, entryPath] of this._index) {
      if (entryPath === null) {
        this._index.delete(name);
      }
    }

    const dirs = new Set<string>();
    for (const name of this._index.keys()) {
      const segments = name.split('/');
      for (let i = 0; i < segments.length; i++) {
        dirs.add(segments.slice(0, i).join('/'));
      }
    }

    for (const dir of dirs) {
      const indexName = dir ? `${dir}/${INDEX_NAME}` : INDEX_NAME;
      if (!this._index.has(indexName)) {
        this._index.set(indexName, null);
      }
    }
  }
}

function deriveEntryNameFromPath(absolutePath: string, catalogPath: string): string {
  const rel = path.relative(catalogPath, absolutePath);
  return rel.replace(/\.md$/, '');
}

function deriveParentLocalName(name: string): string | undefined {
  const segments = name.split('/');
  const leaf = segments[segments.length - 1];

  // The root index entry has no parent.
  if (leaf === INDEX_NAME && segments.length === 1) {
    return undefined;
  }

  const parentDir = leaf === INDEX_NAME
    ? segments.slice(0, -2)
    : segments.slice(0, -1);

  return [...parentDir, INDEX_NAME].join('/');
}

export function parseMarkdown(content: string): { entry: md.Entry|null; body: string } {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') {
    return { entry: null, body: content };
  }
  const endIndex = lines.indexOf('---', 1);
  if (endIndex === -1) {
    return { entry: null, body: content };
  }

  const frontmatter = lines.slice(1, endIndex).join('\n');
  const metadata = yaml.parse(frontmatter);
  const body = lines.slice(endIndex + 1).join('\n');

  const entry = (metadata.catalogEntry ?? {}) as md.Entry;
  entry.type = (typeof metadata.type === 'string' && metadata.type.split('.').length === 3)
    ? metadata.type
    : DEFAULT_ENTRY_TYPE;
  entry.resource = entry.resource ?? {}
  entry.resource.displayName = metadata.title;
  entry.resource.description = metadata.description;
  if (metadata.tags) {
    entry.resource.labels = entry.resource.labels ?? {};
    for (const tag of metadata.tags) {
      entry.resource.labels[tag] = 'true';
    }
  }
  if (metadata.timeStamp) {
    entry.resource.updateTime = metadata.timeStamp;
    if (!entry.resource.createTime) {
      entry.resource.createTime = metadata.timeStamp;
    }
  }

  return { entry, body };
}

export function toMarkdown(entry: md.Entry, body: string): string {
  // Clone to be able to make modifications
  const entryClone = JSON.parse(JSON.stringify(entry)) as Record<string, any>;

  const tags = [];
  if (entry.resource.labels) {
    for (const [k, v] of Object.entries(entryClone.resource.labels ?? {})) {
      if (v == 'true') {
        tags.push(k);
      }
    }
  }

  const metadata = {
    type: entry.type,
    title: entry.resource.displayName ?? entry.resource.name,
    description: entry.resource.description ?? undefined,
    tags: tags.length ? tags : undefined,
    timeStamp: entry.resource.updateTime ?? entry.resource.createTime ?? undefined,
    catalogEntry: entryClone
  };

  delete entryClone.name;
  delete entryClone.resource.displayName;
  delete entryClone.resource.description;
  delete entryClone.resource.updateTime;
  delete entryClone.resource.createTime;
  delete entryClone.resource.parent;
  delete entryClone.type;
  for (const tag of tags) {
    delete entryClone.resource.labels[tag];
  }

  const frontmatter = yaml.stringify(metadata).trim();
  return `---\n${frontmatter}\n---\n${body}`;
}
