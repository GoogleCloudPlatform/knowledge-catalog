// Implements the documents layout (markdown files in directory)
//

import * as glob from 'glob';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import {CatalogLayout} from '../layout';
import * as md from '../metadata';

const OVERVIEW_ASPECT_KEY = 'dataplex-types.global.overview';

export class DocumentsLayout implements CatalogLayout {
  private _catalogPath: string = '';

  private readonly _index = new Map<string, string>();

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
      try {
        const content = await fs.promises.readFile(localPath, 'utf8');
        const {entry} = parseMarkdown(content);
        if (entry && entry.name) {
          this._index.set(entry.name, localPath);
        }
      } catch (err) {
        // Skip unreadable/invalid files during indexing
      }
    }
  }

  entryExists(name: string): boolean {
    const entryPath = this._index.get(name);
    return !!entryPath && fs.existsSync(entryPath);
  }

  listEntries(): string[] {
    return Array.from(this._index.keys());
  }

  async loadEntry(name: string): Promise<md.Entry> {
    const entryPath = this._index.get(name);
    if (!entryPath || !fs.existsSync(entryPath)) {
      throw new Error(`Entry not found: ${name}`);
    }
    const content = await fs.promises.readFile(entryPath, 'utf8');
    const {entry, body} = parseMarkdown(content);

    if (!entry) {
      throw new Error(
        `Missing YAML frontmatter in Markdown file: ${entryPath}`,
      );
    }

    const bodyTrimmed = body.trim();
    if (bodyTrimmed) {
      if (!entry.aspects) {
        entry.aspects = {};
      }
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
    await fs.promises.mkdir(path.dirname(entryPath), {recursive: true});

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
  }

  async deleteEntry(name: string): Promise<void> {
    const entryPath = this._index.get(name);
    if (!entryPath || !fs.existsSync(entryPath)) {
      throw new Error(`Entry not found: ${name}`);
    }

    await fs.promises.unlink(entryPath);
    this._index.delete(name);
  }

  getEntryPaths(name: string): {local?: string; ref?: string} | undefined {
    const entryPath = this._index.get(name);
    return entryPath ? {local: entryPath} : undefined;
  }
}

export function parseMarkdown(content: string): {
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
  const metadata = yaml.parse(frontmatter);
  const body = lines.slice(endIndex + 1).join('\n');

  const entry = (metadata.catalogEntry ?? {}) as md.Entry;
  entry.type = metadata.type;
  entry.resource = entry.resource ?? {};
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

  return {entry, body};
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
    timeStamp:
      entry.resource.updateTime ?? entry.resource.createTime ?? undefined,
    catalogEntry: entryClone,
  };

  delete entryClone.resource.displayName;
  delete entryClone.resource.description;
  delete entryClone.resource.updateTime;
  delete entryClone.resource.createTime;
  delete entryClone.type;
  for (const tag of tags) {
    delete entryClone.resource.labels[tag];
  }

  const frontmatter = yaml.stringify(metadata).trim();
  return `---\n${frontmatter}\n---\n${body}`;
}
