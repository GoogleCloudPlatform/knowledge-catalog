import * as fs from 'node:fs';
import * as path from 'node:path';

export interface EntryState {
  entryChecksum: string;
  lastSyncTime: string;
  aspects: Record<string, string>;
}

export interface CatalogStateData {
  version: string;
  entries: Record<string, EntryState>;
}

export class CatalogState {
  private readonly _statePath: string;
  private readonly _lockPath: string;
  private _data: CatalogStateData = { version: '1', entries: {} };
  private _hasLock: boolean = false;

  constructor(basePath: string) {
    this._statePath = path.join(basePath, 'catalog-state.json');
    this._lockPath = path.join(basePath, 'catalog-state.json.lock');
  }

  /**
   * Acquires a file-level lock. If already locked by another process, fails immediately.
   */
  async lock(): Promise<void> {
    if (this._hasLock) {
      return;
    }

    try {
      // 'wx' flag opens the file for writing, failing if it already exists.
      const fd = await fs.promises.open(this._lockPath, 'wx');
      await fd.close();
      this._hasLock = true;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        throw new Error(
          'Concurrency Conflict: The catalog state database is locked. Another process may be running.'
        );
      }
      throw err;
    }
  }

  /**
   * Releases the file-level lock.
   */
  async unlock(): Promise<void> {
    if (!this._hasLock) {
      return;
    }

    try {
      if (fs.existsSync(this._lockPath)) {
        await fs.promises.unlink(this._lockPath);
      }
      this._hasLock = false;
    } catch (err) {
      // Ignore if file was already removed
    }
  }

  /**
   * Loads state database from disk.
   */
  load(): void {
    if (!fs.existsSync(this._statePath)) {
      this._data = { version: '1', entries: {} };
      return;
    }

    try {
      const content = fs.readFileSync(this._statePath, 'utf8');
      this._data = JSON.parse(content) as CatalogStateData;
    } catch (err: any) {
      throw new Error(`Failed to parse state database: ${err.message}`);
    }
  }

  /**
   * Saves state database to disk. Requires lock.
   */
  save(): void {
    if (!this._hasLock) {
      throw new Error('Database Error: Cannot write to state database without acquiring a lock.');
    }

    try {
      const content = JSON.stringify(this._data, null, 2);
      fs.writeFileSync(this._statePath, content, 'utf8');
    } catch (err: any) {
      throw new Error(`Failed to write state database: ${err.message}`);
    }
  }

  getEntry(name: string): EntryState | undefined {
    return this._data.entries[name];
  }

  updateEntry(name: string, entryState: EntryState): void {
    this._data.entries[name] = entryState;
  }

  deleteEntry(name: string): void {
    delete this._data.entries[name];
  }

  listEntries(): string[] {
    return Object.keys(this._data.entries);
  }
}
