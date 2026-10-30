import {afterEach, describe, expect, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiContext} from '../../../src/libts/gcp/context';
import {CatalogClient, Entry, MetadataChange} from '../../../src/libts/gcp/dataplex';
import {okfToCatalog} from '../../../src/libts/okf/okf_to_catalog';

const CTX = new ApiContext('dst-project', 'us', 'token');
const GROUP = 'projects/dst-project/locations/us/entryGroups/dst';
const SRC_GROUP = 'projects/src-project/locations/us/entryGroups/src';
const DOCUMENT = 'projects/dataplex-types/locations/global/entryTypes/document';
const ENTRYGROUP =
  'projects/dataplex-types/locations/global/entryTypes/entrygroup';

function file(root: string, id: string, entryType: string, parent?: string) {
  const full = path.join(root, `${id}.md`);
  fs.mkdirSync(path.dirname(full), {recursive: true});
  const parentLine = parent ? `  parentEntry: ${SRC_GROUP}/entries/${parent}\n` : '';
  fs.writeFileSync(
    full,
    `---\ntype: knowledge-base\ntitle: ${id}\nx-kcmd:\n  v: 1\n` +
      `  entryType: ${entryType}\n${parentLine}---\nbody of ${id}\n`,
    'utf8',
  );
}

// assets/t is deeper than assets, and the service entry must be skipped.
function bundle(): string {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'okfpush-'));
  const root = path.join(base, 'bundle');
  file(root, 'assets/t', DOCUMENT, 'assets');
  file(root, 'assets', DOCUMENT);
  file(root, 'dst_entry', ENTRYGROUP);
  return base;
}

function snapshotFor(base: string, existing: string[] = []) {
  return {
    basePath: base,
    manifest: {
      source: {
        name: 'dst-project.us.dst',
        async *entries() {
          for (const id of existing) yield {name: `${GROUP}/entries/${id}`};
        },
      },
    },
  } as any;
}

function okOperation() {
  return {status: 200, result: {name: 'op/1', done: true}};
}

afterEach(() => {
  (console.log as any).mockRestore?.();
  (console.error as any).mockRestore?.();
});

describe('okfToCatalog --validate-only', () => {
  test('reports the plan and sends nothing', async () => {
    const batch = spyOn(CatalogClient.prototype, 'batchChangeMetadata');
    const lines: string[] = [];
    spyOn(console, 'log').mockImplementation((m: any) => void lines.push(m));

    const code = await okfToCatalog(CTX, snapshotFor(bundle()), {
      validateOnly: true,
    });

    expect(code).toBe(0);
    expect(batch).not.toHaveBeenCalled();
    expect(lines.at(-1)).toContain('2 change(s): 2 create, 0 update');
    batch.mockRestore();
  });

  test('fails with exit code 1 on a malformed OKF concept', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'okfpush-bad-'));
    const root = path.join(base, 'bundle');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(
      path.join(root, 'broken.md'),
      '---\ntitle: missing type\n---\nbody\n',
      'utf8',
    );
    const errors: string[] = [];
    spyOn(console, 'error').mockImplementation((m: any) => void errors.push(m));

    const code = await okfToCatalog(CTX, snapshotFor(base), {
      validateOnly: true,
    });

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('broken');
  });
});

describe('okfToCatalog', () => {
  test('sends one batch and skips the entry-group entry', async () => {
    let sent: MetadataChange[] = [];
    const batch = spyOn(CatalogClient.prototype, 'batchChangeMetadata')
      .mockImplementation(async (_p, _l, _g, changes: MetadataChange[]) => {
        sent = changes;
        return okOperation() as any;
      });
    spyOn(CatalogClient.prototype, 'awaitOperation').mockImplementation(
      async () => undefined,
    );
    spyOn(CatalogClient.prototype, 'getOperation').mockImplementation(
      async () => ({status: 200, result: {name: 'op/1', done: true}}) as any,
    );
    spyOn(console, 'log').mockImplementation(() => {});

    const code = await okfToCatalog(CTX, snapshotFor(bundle()));

    expect(code).toBe(0);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(sent.map((c) => c.createEntryRequest?.entryId)).toEqual([
      'assets',
      'assets/t',
    ]);
    batch.mockRestore();
  });

  test('rebases a stashed parent onto the target group', async () => {
    let sent: MetadataChange[] = [];
    const batch = spyOn(CatalogClient.prototype, 'batchChangeMetadata')
      .mockImplementation(async (_p, _l, _g, changes: MetadataChange[]) => {
        sent = changes;
        return okOperation() as any;
      });
    spyOn(CatalogClient.prototype, 'awaitOperation').mockImplementation(
      async () => undefined,
    );
    spyOn(CatalogClient.prototype, 'getOperation').mockImplementation(
      async () => ({status: 200, result: {done: true}}) as any,
    );
    spyOn(console, 'log').mockImplementation(() => {});

    await okfToCatalog(CTX, snapshotFor(bundle()));

    const child = sent.find((c) => c.createEntryRequest?.entryId === 'assets/t');
    expect(child?.createEntryRequest?.entry.parentEntry).toBe(
      `${GROUP}/entries/assets`,
    );
    batch.mockRestore();
  });

  test('an entry that already exists updates aspects, entrySource, and parentEntry', async () => {
    let sent: MetadataChange[] = [];
    const batch = spyOn(CatalogClient.prototype, 'batchChangeMetadata')
      .mockImplementation(async (_p, _l, _g, changes: MetadataChange[]) => {
        sent = changes;
        return okOperation() as any;
      });
    spyOn(CatalogClient.prototype, 'awaitOperation').mockImplementation(
      async () => undefined,
    );
    spyOn(CatalogClient.prototype, 'getOperation').mockImplementation(
      async () => ({status: 200, result: {done: true}}) as any,
    );
    spyOn(console, 'log').mockImplementation(() => {});

    await okfToCatalog(CTX, snapshotFor(bundle(), ['assets']));

    const update = sent.find((c) => c.updateEntryRequest);
    // entry_source is replace-semantics server-side, so the mask is only safe
    // because conceptToEntry rebuilds the whole source, not just displayName.
    expect(update?.updateEntryRequest?.updateMask).toBe('aspects,entry_source');
    expect(update?.updateEntryRequest?.entry.entrySource?.displayName).toBe(
      'assets',
    );
    expect(update?.updateEntryRequest?.updateMask).not.toContain('parent_entry');
    expect(update?.updateEntryRequest?.deleteMissingAspects).toBe(false);
    expect(sent.filter((c) => c.createEntryRequest)).toHaveLength(1);
    batch.mockRestore();
  });

  test('pushes a pure OKF bundle (index.md, <dir>/index.md, <dir>/<leaf>.md) in parent-first order', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'okfpush-pure-'));
    const root = path.join(base, 'bundle');
    fs.mkdirSync(path.join(root, 'tables'), {recursive: true});
    fs.writeFileSync(
      path.join(root, 'index.md'),
      '---\nokf_version: "0.2"\n---\n# Austin bikeshare knowledge\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'tables/index.md'),
      '# Tables\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'tables/bikeshare_trips.md'),
      '---\ntype: Table\ntitle: bikeshare_trips\nstatus: verified\n---\n# bikeshare_trips\n',
      'utf8',
    );

    let sent: MetadataChange[] = [];
    const batch = spyOn(CatalogClient.prototype, 'batchChangeMetadata')
      .mockImplementation(async (_p, _l, _g, changes: MetadataChange[]) => {
        sent = changes;
        return okOperation() as any;
      });
    spyOn(CatalogClient.prototype, 'awaitOperation').mockImplementation(
      async () => undefined,
    );
    spyOn(CatalogClient.prototype, 'getOperation').mockImplementation(
      async () => ({status: 200, result: {done: true}}) as any,
    );
    spyOn(console, 'log').mockImplementation(() => {});

    const code = await okfToCatalog(CTX, snapshotFor(base));

    expect(code).toBe(0);
    expect(sent.map((c) => c.createEntryRequest?.entryId)).toEqual([
      'agents',
      'tables',
      'tables/bikeshare_trips',
    ]);
    batch.mockRestore();
  });

  test('per-change failures are counted and named', async () => {
    const batch = spyOn(CatalogClient.prototype, 'batchChangeMetadata')
      .mockImplementation(async () => okOperation() as any);
    spyOn(CatalogClient.prototype, 'awaitOperation').mockImplementation(
      async () => undefined,
    );
    spyOn(CatalogClient.prototype, 'getOperation').mockImplementation(
      async () =>
        ({
          status: 200,
          result: {
            done: true,
            metadata: {failedRequests: {'1': {code: 7, message: 'denied'}}},
          },
        }) as any,
    );
    const errors: string[] = [];
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation((m: any) => void errors.push(m));

    const code = await okfToCatalog(CTX, snapshotFor(bundle()));

    expect(code).toBe(1);
    expect(errors.join('\n')).toContain('assets/t: denied');
    batch.mockRestore();
  });

  test('falls back to the Entries API when batch is not deployed', async () => {
    const batch = spyOn(CatalogClient.prototype, 'batchChangeMetadata')
      .mockImplementation(
        async () =>
          ({status: 404, message: 'Method not found: BatchChangeMetadata'}) as any,
      );
    const created: string[] = [];
    const create = spyOn(CatalogClient.prototype, 'createEntry')
      .mockImplementation(async (_p, _l, _g, entryId: string, entry?: Entry) => {
        created.push(entryId);
        expect(entry).not.toHaveProperty('name');
        return {status: 200, result: {}} as any;
      });
    spyOn(console, 'log').mockImplementation(() => {});

    const code = await okfToCatalog(CTX, snapshotFor(bundle()));

    expect(code).toBe(0);
    expect(created).toEqual(['assets', 'assets/t']);
    batch.mockRestore();
    create.mockRestore();
  });

  test('a rejected batch is not replayed one entry at a time', async () => {
    const batch = spyOn(CatalogClient.prototype, 'batchChangeMetadata')
      .mockImplementation(
        async () => ({status: 400, message: 'invalid plan'}) as any,
      );
    const create = spyOn(CatalogClient.prototype, 'createEntry');
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});

    const code = await okfToCatalog(CTX, snapshotFor(bundle()));

    expect(code).toBe(1);
    expect(create).not.toHaveBeenCalled();
    batch.mockRestore();
    create.mockRestore();
  });
});
