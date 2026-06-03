// Implements the standard layout (yaml files in directory)
//

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as glob from 'glob';
import * as yaml from 'yaml';
import { CatalogLayout } from '../layout';
import * as md from '../metadata';


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
    return yaml.parse(content) as md.Entry;
  }

  async saveEntry(name: string, entry: md.Entry): Promise<void> {
    const entryPath = path.join(this._catalogPath, `${name}.yaml`);
    await fs.promises.mkdir(path.dirname(entryPath), { recursive: true });

    await fs.promises.writeFile(entryPath, yaml.stringify(entry), 'utf8');
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
}
