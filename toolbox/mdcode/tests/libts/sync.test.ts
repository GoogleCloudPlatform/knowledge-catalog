// Behavior spec for CatalogSync's handling of the Catalog API's ambiguous 403:
// the service returns 403 for both "entry does not exist" and "permission
// denied", so neither pull nor push can treat a non-200 lookup as a clean
// "absent". These tests pin the two failure modes from issue #308 — pull must
// not report success over a snapshot it did not fully take, and push must not
// mislabel an already-exists (409) as a create failure.

import {describe, expect, test} from 'bun:test';

import {CatalogSync} from '../../src/libts/sync';

// Minimal fakes: CatalogSync only touches a handful of members on the catalog
// client and the snapshot, so we stub exactly those rather than stand up a real
// client/snapshot. Cast through `any` at the constructor boundary.
function makeSnapshotForPull(names: string[]) {
  const stored: any[] = [];
  const snapshot = {
    entryTypes: new Map(),
    aspectTypes: new Map(),
    manifest: {
      source: {
        // Async generator over the listed entries, mirroring the real source.
        async *
            entries() {
              for (const name of names) {
                yield {name, entryType: 'x'};
              }
            },
      },
    },
    async _storeEntry(entry: any) {
      stored.push(entry);
    },
  };
  return {snapshot, stored};
}

describe('CatalogSync.pull', () => {
  test('reports success when every entry is readable', async () => {
    const {snapshot, stored} = makeSnapshotForPull(
        ['projects/p/locations/us/entryGroups/g/entries/a']);
    const catalog = {
      context: {},
      async lookupEntry() {
        return {status: 200, result: {name: 'a'}};
      },
    };

    const res = await new CatalogSync(catalog as any, snapshot as any).pull();

    expect(res.success).toBe(true);
    expect(res.skipped).toBe(0);
    expect(stored.length).toBe(1);
  });

  test(
      'does not report success when an entry 403s; counts the skip',
      async () => {
        const {snapshot, stored} = makeSnapshotForPull([
          'projects/p/locations/us/entryGroups/g/entries/a',
          'projects/p/locations/us/entryGroups/g/entries/b',
        ]);
        const catalog = {
          context: {},
          async lookupEntry(_project: string, _location: string, name: string) {
            // 'a' readable, 'b' forbidden/absent (403).
            return name.endsWith('/a') ?
                {status: 200, result: {name: 'a'}} :
                {status: 403, message: 'permission denied'};
          },
        };

        const res =
            await new CatalogSync(catalog as any, snapshot as any).pull();

        expect(res.success).toBe(false);
        expect(res.skipped).toBe(1);
        expect(res.details).toContain('403');
        // The readable entry is still stored — the pull is partial, not
        // aborted.
        expect(stored.length).toBe(1);
      });

  test(
      'fails when every entry 403s rather than claiming a clean snapshot',
      async () => {
        const {snapshot, stored} = makeSnapshotForPull([
          'projects/p/locations/us/entryGroups/g/entries/a',
          'projects/p/locations/us/entryGroups/g/entries/b',
        ]);
        const catalog = {
          context: {},
          async lookupEntry() {
            return {status: 403, message: 'permission denied'};
          },
        };

        const res =
            await new CatalogSync(catalog as any, snapshot as any).pull();

        expect(res.success).toBe(false);
        expect(res.skipped).toBe(2);
        expect(stored.length).toBe(0);
      });
});

function makeSnapshotForPush(entry: any) {
  return {
    manifest: {source: {ingestedEntries: false}},
    async listEntries() {
      return [entry.name];
    },
    async _fetchEntry() {
      return entry;
    },
  };
}

const PUSH_ENTRY = {
  name: 'projects/p/locations/us/entryGroups/g/entries/a',
  aspects: {foo: {}},
};

describe('CatalogSync.push', () => {
  test(
      'creates when the lookup is non-200 and the create succeeds',
      async () => {
        const snapshot = makeSnapshotForPush(PUSH_ENTRY);
        let created = false;
        const catalog = {
          async lookupEntry() {
            return {status: 403, message: 'not found or forbidden'};
          },
          async createEntry() {
            created = true;
            return {status: 200, result: PUSH_ENTRY};
          },
        };

        const res =
            await new CatalogSync(catalog as any, snapshot as any).push();

        expect(res.success).toBe(true);
        expect(created).toBe(true);
      });

  test(
      'a 409 on create is reported as already-exists, not "Failed to create"',
      async () => {
        const snapshot = makeSnapshotForPush(PUSH_ENTRY);
        const catalog = {
          async lookupEntry() {
            return {status: 403, message: 'permission denied'};
          },
          async createEntry() {
            return {status: 409, message: 'entry already exists'};
          },
        };

        const res =
            await new CatalogSync(catalog as any, snapshot as any).push();

        expect(res.success).toBe(false);
        expect(res.details).toContain('already exists');
        expect(res.details).not.toContain('Failed to create');
      });
});
