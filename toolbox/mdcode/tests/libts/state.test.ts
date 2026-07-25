import { describe, test, expect, afterEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CatalogState } from '../../src/libts/state';

const TEST_DIR = path.join(__dirname, 'temp_state_test');

describe('CatalogState', () => {
  afterEach(() => {
    // Cleanup temporary directory
    if (fs.existsSync(TEST_DIR)) {
      const lockPath = path.join(TEST_DIR, 'catalog-state.json.lock');
      if (fs.existsSync(lockPath)) {
        fs.unlinkSync(lockPath);
      }
      const dbPath = path.join(TEST_DIR, 'catalog-state.json');
      if (fs.existsSync(dbPath)) {
        fs.unlinkSync(dbPath);
      }
      fs.rmdirSync(TEST_DIR);
    }
  });

  test('loads empty state if file does not exist', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const state = new CatalogState(TEST_DIR);
    state.load();

    expect(state.listEntries()).toEqual([]);
    expect(state.getEntry('non-existent')).toBeUndefined();
  });

  test('acquires and releases file lock', async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const state = new CatalogState(TEST_DIR);
    const lockFile = path.join(TEST_DIR, 'catalog-state.json.lock');

    expect(fs.existsSync(lockFile)).toBe(false);

    await state.lock();
    expect(fs.existsSync(lockFile)).toBe(true);

    await state.unlock();
    expect(fs.existsSync(lockFile)).toBe(false);
  });

  test('throws error if attempting to lock already locked database', async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const state1 = new CatalogState(TEST_DIR);
    const state2 = new CatalogState(TEST_DIR);

    await state1.lock();

    expect(state2.lock()).rejects.toThrow('Concurrency Conflict');

    await state1.unlock();
  });

  test('throws error when saving without holding lock', () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const state = new CatalogState(TEST_DIR);
    state.load();
    state.updateEntry('orders', {
      entryChecksum: 'hash1',
      lastSyncTime: '2026-06-03T00:00:00Z',
      aspects: {}
    });

    expect(() => state.save()).toThrow('Database Error: Cannot write');
  });

  test('CRUD operations work and persist on save', async () => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const state = new CatalogState(TEST_DIR);
    state.load();

    await state.lock();

    state.updateEntry('entry-1', {
      entryChecksum: 'checksum-1',
      lastSyncTime: '2026-06-03T12:00:00Z',
      aspects: { 'aspect-1': 'hash-a' }
    });

    state.save();

    // Load in a different state instance
    const state2 = new CatalogState(TEST_DIR);
    state2.load();

    expect(state2.listEntries()).toEqual(['entry-1']);
    expect(state2.getEntry('entry-1')).toEqual({
      entryChecksum: 'checksum-1',
      lastSyncTime: '2026-06-03T12:00:00Z',
      aspects: { 'aspect-1': 'hash-a' }
    });

    // Delete entry
    await state.unlock();

    await state2.lock();
    state2.deleteEntry('entry-1');
    state2.save();
    await state2.unlock();

    const state3 = new CatalogState(TEST_DIR);
    state3.load();
    expect(state3.listEntries()).toEqual([]);
  });
});
