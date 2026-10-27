// Implements the standard layout (yaml files in directory)
//

import * as fs from 'node:fs';
import * as path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as glob from 'glob';
import * as yaml from 'yaml';
import { pathInside, readFileIfExists, writeFileAtomic } from '../fsutil';
import { CatalogLayout } from '../layout';
import * as md from '../metadata';
import { deleteEachEntry, saveEachEntry } from './batch';


export class StandardLayout implements CatalogLayout {

  private readonly _catalogPath: string;

  private readonly _index = new Map<string, string>();

  constructor(catalogPath: string) {
    this._catalogPath = catalogPath;
  }

  async init(): Promise<void> {
    this._index.clear();

    if (!fs.existsSync(this._catalogPath)) {
      return;
    }

    const matches = await glob.glob('**/*.yaml', {
      cwd: this._catalogPath,
      absolute: true,
      nodir: true,
    });

    for (const localPath of matches) {
      try {
        const content = await fs.promises.readFile(localPath, 'utf8');
        const metadata = yaml.parse(content);
        if (metadata && metadata.name) {
          this._index.set(metadata.name, localPath);
        }
      }
      catch (err) {
        // A file that fails to read or parse is left out of the index, so it is
        // never listed and never pushed. Warn rather than drop it silently:
        // push otherwise makes the destination match the directory, and a file
        // vanishing from that set is easy to miss.
        const reason = err instanceof Error ? err.message : String(err);
        const relPath = path.relative(this._catalogPath, localPath);
        console.warn(`Skipping unreadable catalog file '${relPath}': ${reason}`);
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
    return yaml.parse(content) as md.Entry;
  }

  async saveEntry(name: string, entry: md.Entry): Promise<void> {
    // An entry already in the index is updated where it was found; a new one
    // goes to `<name>.yaml`, which must stay inside the catalog folder.
    const entryPath = this._index.get(name) ??
        pathInside(this._catalogPath, `${name}.yaml`, 'entry name');

    // Leave an unchanged entry's file alone, so its formatting, comments and
    // modification time survive a save of what was read.
    const existing = await readFileIfExists(entryPath);
    if (existing !== undefined && sameEntry(existing, entry)) {
      this._index.set(name, entryPath);
      return;
    }

    await fs.promises.mkdir(path.dirname(entryPath), { recursive: true });
    await writeFileAtomic(entryPath, yaml.stringify(entry));
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

  async saveEntries(entries: md.Entry[]): Promise<md.EntryResult[]> {
    return saveEachEntry(this, entries);
  }

  async deleteEntries(names: string[]): Promise<md.EntryResult[]> {
    return deleteEachEntry(this, names);
  }
}


// Whether a file's YAML holds the same entry. Values the entry leaves
// undefined are not written to the file, so they are dropped before comparing.
function sameEntry(fileText: string, entry: md.Entry): boolean {
  let parsed: unknown;
  try {
    parsed = yaml.parse(fileText);
  } catch {
    return false;
  }
  return isDeepStrictEqual(parsed, JSON.parse(JSON.stringify(entry)));
}
