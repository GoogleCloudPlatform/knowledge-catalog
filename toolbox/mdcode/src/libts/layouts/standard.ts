// Implements the standard layout (yaml files in directory)
//

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as glob from 'glob';
import * as yaml from 'yaml';
import { CatalogLayout } from '../layout';
import { CatalogSource } from '../source';
import { CatalogManifest } from '../manifest';
import * as md from '../metadata';

async function findFiles(dir: string, ext: string): Promise<string[]> {
  const results: string[] = [];
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...await findFiles(fullPath, ext));
      } else if (entry.isFile() && entry.name.endsWith(ext)) {
        results.push(fullPath);
      }
    }
  } catch (e) {
    // Ignore errors
  }
  return results;
}

export class StandardLayout implements CatalogLayout {

  private readonly _catalogPath: string;
  private readonly _source: CatalogSource;
  private readonly _manifest: CatalogManifest;

  private readonly _index = new Map<string, string>();
  private readonly _sidecars = new Map<string, string[]>();

  constructor(catalogPath: string, source: CatalogSource, manifest: CatalogManifest) {
    this._catalogPath = catalogPath;
    this._source = source;
    this._manifest = manifest;
  }

  private getAspectTypeFromShortName(shortName: string): string {
    const aspects = this._manifest.snapshotConfig?.aspects || this._manifest.publishingConfig?.aspects || [];
    const matched = aspects.filter(a => a.endsWith(`.${shortName}`));
    if (matched.length === 1) {
      return matched[0];
    }
    return shortName;
  }

  private getShortNameFromAspectType(aspectType: string): string {
    const parts = aspectType.split('.');
    return parts[parts.length - 1];
  }

  async init(): Promise<void> {
    this._index.clear();
    this._sidecars.clear();
    // Temporary reference to satisfy TS compiler
    this._source;

    if (!fs.existsSync(this._catalogPath)) {
      return;
    }

    const matches = await findFiles(this._catalogPath, '.yaml');

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

    const mdMatches = await findFiles(this._catalogPath, '.md');

    for (const mdPath of mdMatches) {
      const relPath = path.relative(this._catalogPath, mdPath);
      const parsed = path.parse(relPath);
      const lastDot = parsed.name.lastIndexOf('.');
      
      if (lastDot === -1) {
        throw new Error(`Orphaned aspect sidecar file: ${relPath} (missing aspect short name)`);
      }

      const entryBase = parsed.name.substring(0, lastDot);
      const entryName = parsed.dir ? `${parsed.dir}/${entryBase}` : entryBase;

      let correspondingYamlPath: string | undefined;
      for (const yamlPath of this._index.values()) {
        const expectedRel = path.relative(this._catalogPath, yamlPath);
        const expectedParsed = path.parse(expectedRel);
        const expectedBase = expectedParsed.dir ? `${expectedParsed.dir}/${expectedParsed.name}` : expectedParsed.name;
        if (expectedBase === entryName) {
           correspondingYamlPath = yamlPath;
           break;
        }
      }

      if (!correspondingYamlPath) {
        throw new Error(`Orphaned aspect sidecar file: ${relPath} (no corresponding core YAML entry file)`);
      }

      // We found the corresponding yaml path, so we find its name in _index.
      // Wait, we know `name` from the loop above!
      let actualEntryName = '';
      for (const [name, yamlPath] of this._index.entries()) {
         if (yamlPath === correspondingYamlPath) {
            actualEntryName = name;
            break;
         }
      }

      let sidecars = this._sidecars.get(actualEntryName);
      if (!sidecars) {
        sidecars = [];
        this._sidecars.set(actualEntryName, sidecars);
      }
      sidecars.push(mdPath);
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

    const sidecars = this._sidecars.get(name) || [];
    for (const mdPath of sidecars) {
      const relPath = path.relative(this._catalogPath, mdPath);
      const parsed = path.parse(relPath);
      const lastDot = parsed.name.lastIndexOf('.');
      const shortName = parsed.name.substring(lastDot + 1);

      const mdContent = await fs.promises.readFile(mdPath, 'utf8');
      
      if (mdContent.trim() === '') {
        // empty sidecar -> aspect deletion request
        continue;
      }

      const aspectType = this.getAspectTypeFromShortName(shortName);

      if (!entry.aspects) {
        entry.aspects = {};
      }

      entry.aspects[aspectType] = {
        contentType: 'MARKDOWN',
        content: mdContent
      };
    }

    return entry;
  }

  async saveEntry(name: string, entry: md.Entry): Promise<void> {
    const entryPath = path.join(this._catalogPath, `${name}.yaml`);
    await fs.promises.mkdir(path.dirname(entryPath), { recursive: true });

    const sidecarsToWrite: { shortName: string, content: string }[] = [];
    if (entry.aspects) {
       for (const [aspectType, data] of Object.entries(entry.aspects)) {
          if (data && typeof data === 'object' && data.contentType === 'MARKDOWN' && typeof data.content === 'string') {
             const shortName = this.getShortNameFromAspectType(aspectType);
             sidecarsToWrite.push({ shortName, content: data.content });
             delete entry.aspects[aspectType];
          }
       }
       if (Object.keys(entry.aspects).length === 0) {
          delete entry.aspects;
       }
    }

    await fs.promises.writeFile(entryPath, yaml.stringify(entry), 'utf8');
    this._index.set(name, entryPath);

    const newSidecars: string[] = [];
    for (const sidecar of sidecarsToWrite) {
       // name could be nested, e.g. p.d/t1. 
       // We should derive the base path from entryPath.
       const parsedEntry = path.parse(entryPath);
       const mdPath = path.join(parsedEntry.dir, `${parsedEntry.name}.${sidecar.shortName}.md`);
       await fs.promises.writeFile(mdPath, sidecar.content, 'utf8');
       newSidecars.push(mdPath);
    }

    const oldSidecars = this._sidecars.get(name) || [];
    for (const oldMd of oldSidecars) {
       if (!newSidecars.includes(oldMd) && fs.existsSync(oldMd)) {
           await fs.promises.unlink(oldMd);
       }
    }
    this._sidecars.set(name, newSidecars);
  }

  async deleteEntry(name: string): Promise<void> {
    const entryPath = this._index.get(name);
    if (!entryPath || !fs.existsSync(entryPath)) {
      throw new Error(`Entry not found: ${name}`);
    }

    await fs.promises.unlink(entryPath);
    this._index.delete(name);

    const sidecars = this._sidecars.get(name) || [];
    for (const mdPath of sidecars) {
       if (fs.existsSync(mdPath)) {
          await fs.promises.unlink(mdPath);
       }
    }
    this._sidecars.delete(name);
  }
}
