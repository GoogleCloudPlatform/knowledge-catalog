// Implements the standard layout (yaml files in directory)
//

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as glob from 'glob';
import * as yaml from 'yaml';
import { CatalogLayout } from '../layout';
import * as md from '../metadata';
import { CatalogManifest } from '../manifest';


export class StandardLayout implements CatalogLayout {

  private readonly _catalogPath: string;
  private readonly _manifest?: CatalogManifest;

  private readonly _index = new Map<string, string>();

  constructor(catalogPath: string, manifest?: CatalogManifest) {
    this._catalogPath = catalogPath;
    this._manifest = manifest;
  }

  async init(): Promise<void> {
    this._index.clear();

    if (!fs.existsSync(this._catalogPath)) {
      return;
    }

    const matches = await walkDir(this._catalogPath, '.yaml');

    for (const localPath of matches) {
      try {
        const content = await fs.promises.readFile(localPath, 'utf8');
        const metadata = yaml.parse(content);
        if (metadata && metadata.name) {
          this._index.set(metadata.name, localPath);
        }
      }
      catch (err) {
        // Skip unreadable/invalid yaml files during indexing
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
    const entry = yaml.parse(content) as md.Entry;

    // Load and merge any markdown sidecar files
    const dir = path.dirname(entryPath);
    const baseName = path.basename(entryPath, '.yaml');
    try {
      const files = await fs.promises.readdir(dir);
      const sidecarFiles = files.filter(f => f.startsWith(`${baseName}.`) && f.endsWith('.md'));

      for (const sidecarFile of sidecarFiles) {
        const aspectSuffix = sidecarFile.substring(baseName.length + 1, sidecarFile.length - 3);
        let matchedKey = aspectSuffix;

        if (this._manifest) {
          const snapshotAspects = this._manifest.snapshotConfig?.aspects || [];
          const publishingAspects = this._manifest.publishingConfig?.aspects || [];
          const allAspects = Array.from(new Set([...snapshotAspects, ...publishingAspects]));

          for (const key of allAspects) {
            if (key === aspectSuffix || key.endsWith(`.${aspectSuffix}`)) {
              matchedKey = key;
              break;
            }
          }
        }

        const sidecarPath = path.join(dir, sidecarFile);
        const sidecarContent = await fs.promises.readFile(sidecarPath, 'utf8');
        const parsed = parseSidecarMarkdown(sidecarContent);

        if (!entry.aspects) {
          entry.aspects = {};
        }
        if (!entry.aspects[matchedKey]) {
          entry.aspects[matchedKey] = {};
        }

        Object.assign(entry.aspects[matchedKey], parsed.data, {
          content: parsed.body.trim()
        });

        if (!entry.aspects[matchedKey].contentType && matchedKey.endsWith('.overview')) {
          entry.aspects[matchedKey].contentType = 'MARKDOWN';
        }
      }
    }
    catch (err) {
      // Ignore reading directory errors
    }

    return entry;
  }

  async saveEntry(name: string, entry: md.Entry): Promise<void> {
    const entryPath = path.join(this._catalogPath, `${name}.yaml`);
    await fs.promises.mkdir(path.dirname(entryPath), { recursive: true });

    // Clone the entry to avoid modifying the original entry aspects
    const entryClone = JSON.parse(JSON.stringify(entry)) as md.Entry;

    if (entryClone.aspects) {
      const dir = path.dirname(entryPath);
      const baseName = path.basename(entryPath, '.yaml');

      for (const key in entryClone.aspects) {
        const aspectData = entryClone.aspects[key];
        if (isMarkdownAspect(key, aspectData)) {
          const sidecarPath = path.join(dir, `${baseName}.${key}.md`);
          const sidecarContent = toSidecarMarkdown(aspectData);
          await fs.promises.writeFile(sidecarPath, sidecarContent, 'utf8');

          delete entryClone.aspects[key];
        }
      }

      if (Object.keys(entryClone.aspects).length === 0) {
        delete entryClone.aspects;
      }
    }

    await fs.promises.writeFile(entryPath, yaml.stringify(entryClone), 'utf8');
    this._index.set(name, entryPath);
  }

  async deleteEntry(name: string): Promise<void> {
    const entryPath = this._index.get(name);
    if (!entryPath || !fs.existsSync(entryPath)) {
      throw new Error(`Entry not found: ${name}`);
    }

    // Delete the entry YAML file
    await fs.promises.unlink(entryPath);
    this._index.delete(name);

    // Delete any associated markdown sidecar files
    const dir = path.dirname(entryPath);
    const baseName = path.basename(entryPath, '.yaml');
    try {
      const files = await fs.promises.readdir(dir);
      const sidecars = files.filter(f => f.startsWith(`${baseName}.`) && f.endsWith('.md'));
      for (const sidecar of sidecars) {
        await fs.promises.unlink(path.join(dir, sidecar));
      }
    }
    catch (err) {
      // Ignore reading directory errors
    }
  }
}

function parseSidecarMarkdown(content: string): { data: Record<string, any>; body: string } {
  const lines = content.split(/\r?\n/);
  if (lines[0] !== '---') {
    return { data: {}, body: content };
  }
  const endIndex = lines.indexOf('---', 1);
  if (endIndex === -1) {
    return { data: {}, body: content };
  }

  const frontmatter = lines.slice(1, endIndex).join('\n');
  const data = yaml.parse(frontmatter) || {};
  const body = lines.slice(endIndex + 1).join('\n');

  return { data, body };
}

function toSidecarMarkdown(aspectData: Record<string, any>): string {
  const cloned = JSON.parse(JSON.stringify(aspectData));
  const body = cloned.content || '';
  delete cloned.content;
  delete cloned.contentType;

  if (Object.keys(cloned).length === 0) {
    return body;
  }

  const frontmatter = yaml.stringify(cloned).trim();
  return `---\n${frontmatter}\n---\n${body}`;
}


function isMarkdownAspect(key: string, data: any): boolean {
  if (key === 'dataplex-types.global.overview' || key.endsWith('.overview')) {
    return true;
  }
  if (data && typeof data === 'object' && data.contentType === 'MARKDOWN') {
    return true;
  }
  return false;
}


async function walkDir(dir: string, ext: string): Promise<string[]> {
  const files: string[] = [];
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await walkDir(fullPath, ext)));
      } else if (entry.isFile() && entry.name.endsWith(ext)) {
        files.push(fullPath);
      }
    }
  } catch (err) {
    // Ignore errors reading directories
  }
  return files;
}
