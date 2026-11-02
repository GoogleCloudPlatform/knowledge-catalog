import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiContext} from '../../../src/libts/gcp/context';
import {
  CatalogClient,
  Entry,
  EntryLink,
  MetadataChange,
} from '../../../src/libts/gcp/dataplex';
import {CatalogSnapshot} from '../../../src/libts/snapshot';
import {CatalogSync} from '../../../src/libts/sync';

const CTX = new ApiContext('dst-project', 'us', 'token');
const GROUP = 'projects/dst-project/locations/us/entryGroups/dst';
const SRC_GROUP = 'projects/src-project/locations/us/entryGroups/src';
const DOCUMENT = 'projects/dataplex-types/locations/global/entryTypes/document';
const ENTRYGROUP =
  'projects/dataplex-types/locations/global/entryTypes/entrygroup';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(d);
  return d;
}

function file(root: string, id: string, entryType: string, parent?: string) {
  const full = path.join(root, `${id}.md`);
  fs.mkdirSync(path.dirname(full), {recursive: true});
  const parentLine = parent
    ? `  parentEntry: ${SRC_GROUP}/entries/${parent}\n`
    : '';
  fs.writeFileSync(
    full,
    `---\ntype: knowledge-base\ntitle: ${id}\nx-kcmd:\n  v: 1\n` +
      `  entryType: ${entryType}\n${parentLine}---\nbody of ${id}\n`,
    'utf8',
  );
}

// assets/t is deeper than assets, and the service entry must be skipped.
function bundle(): string {
  const base = makeTempDir('okfpush-');
  fs.writeFileSync(
    path.join(base, 'catalog.yaml'),
    'scope: entryGroup.dst-project.us.dst\nlayout: okf\n',
    'utf8',
  );
  const root = path.join(base, 'bundle');
  file(root, 'assets/t', DOCUMENT, 'assets');
  file(root, 'assets', DOCUMENT);
  file(root, 'dst_entry', ENTRYGROUP);
  return base;
}

async function runPush(
  base: string,
  existing: string[] = [],
  options: {validateOnly?: boolean} = {},
) {
  spyOn(CatalogClient.prototype, 'getEntryGroup').mockImplementation(
    async () => ({status: 200, result: {name: GROUP}}) as any,
  );
  spyOn(CatalogClient.prototype, 'listEntries').mockImplementation(
    async function* () {
      for (const id of existing) {
        yield {
          name: `${GROUP}/entries/${id}`,
          entryType: id === 'dst_entry' ? ENTRYGROUP : DOCUMENT,
        };
      }
    } as any,
  );
  const snapshot = await CatalogSnapshot.fromPath(base, CTX);
  const sync = new CatalogSync(new CatalogClient(CTX), snapshot);
  return await sync.push(options);
}

function okOperation() {
  return {status: 200, result: {name: 'op/1', done: true}};
}

beforeEach(() => {
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a test made a network call');
  }) as any);
});

afterEach(() => {
  mock.restore();
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, {recursive: true, force: true});
  }
});

describe('CatalogSync OKF push --validate-only', () => {
  test('reports creates, updates, and deletes and sends nothing', async () => {
    const batch = spyOn(CatalogClient.prototype, 'batchChangeMetadata');
    const lines: string[] = [];
    spyOn(console, 'log').mockImplementation((m: any) => void lines.push(m));

    const res = await runPush(bundle(), ['assets', 'stale/leaf'], {
      validateOnly: true,
    });

    expect(res.success).toBe(true);
    expect(batch).not.toHaveBeenCalled();
    expect(lines).toContain(`would delete ${GROUP}/entries/stale/leaf`);
    expect(lines.at(-1)).toContain('3 change(s): 1 create, 1 update, 1 delete');
  });

  test('fails on a malformed OKF concept', async () => {
    const base = makeTempDir('okfpush-bad-');
    fs.writeFileSync(
      path.join(base, 'catalog.yaml'),
      'scope: entryGroup.dst-project.us.dst\nlayout: okf\n',
      'utf8',
    );
    const root = path.join(base, 'bundle');
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(
      path.join(root, 'broken.md'),
      '---\ntitle: missing type\n---\nbody\n',
      'utf8',
    );

    const res = await runPush(base, [], {validateOnly: true});

    expect(res.success).toBe(false);
    expect(res.details).toContain('broken');
  });
});

describe('CatalogSync OKF push', () => {
  test('sends one batch, skips the entry-group entry, and avoids extra getOperation', async () => {
    let sent: MetadataChange[] = [];
    const batch = spyOn(CatalogClient.prototype, 'batchChangeMetadata')
      .mockImplementation(async (_p, _l, _g, changes: MetadataChange[]) => {
        sent = changes;
        return okOperation() as any;
      });
    const getOp = spyOn(CatalogClient.prototype, 'getOperation');
    spyOn(console, 'log').mockImplementation(() => {});

    const res = await runPush(bundle(), ['dst_entry']);

    expect(res.success).toBe(true);
    expect(batch).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
    expect(getOp).not.toHaveBeenCalled();
  });

  test('orders creates shallowest first so parents exist before children', async () => {
    let sent: MetadataChange[] = [];
    spyOn(CatalogClient.prototype, 'batchChangeMetadata')
      .mockImplementation(async (_p, _l, _g, changes: MetadataChange[]) => {
        sent = changes;
        return okOperation() as any;
      });
    spyOn(console, 'log').mockImplementation(() => {});

    await runPush(bundle());

    expect(sent.map((c) => c.createEntryRequest?.entryId)).toEqual([
      'assets',
      'assets/t',
    ]);
  });

  test('rebases a stashed parent onto the target group', async () => {
    let sent: MetadataChange[] = [];
    spyOn(CatalogClient.prototype, 'batchChangeMetadata')
      .mockImplementation(async (_p, _l, _g, changes: MetadataChange[]) => {
        sent = changes;
        return okOperation() as any;
      });
    spyOn(console, 'log').mockImplementation(() => {});

    await runPush(bundle());

    const child = sent.find((c) => c.createEntryRequest?.entryId === 'assets/t');
    expect(child?.createEntryRequest?.entry.parentEntry).toBe(
      `${GROUP}/entries/assets`,
    );
  });

  test('an entry that already exists becomes an update', async () => {
    let sent: MetadataChange[] = [];
    spyOn(CatalogClient.prototype, 'batchChangeMetadata')
      .mockImplementation(async (_p, _l, _g, changes: MetadataChange[]) => {
        sent = changes;
        return okOperation() as any;
      });
    spyOn(console, 'log').mockImplementation(() => {});

    await runPush(bundle(), ['assets']);

    const update = sent.find((c) => c.updateEntryRequest);
    expect(update?.updateEntryRequest?.updateMask).toBe('aspects,entry_source');
    expect(update?.updateEntryRequest?.entry.entrySource?.displayName).toBe(
      'assets',
    );
    expect(update?.updateEntryRequest?.updateMask).not.toContain('parent_entry');
    expect(update?.updateEntryRequest?.deleteMissingAspects).toBe(false);
    expect(sent.filter((c) => c.createEntryRequest)).toHaveLength(1);
  });

  test('pushes a pure OKF bundle (index.md, <dir>/index.md, <dir>/<leaf>.md) in parent-first order and skips log.md', async () => {
    const base = makeTempDir('okfpush-pure-');
    fs.writeFileSync(
      path.join(base, 'catalog.yaml'),
      'scope: entryGroup.dst-project.us.dst\nlayout: okf\n',
      'utf8',
    );
    const root = path.join(base, 'bundle');
    fs.mkdirSync(path.join(root, 'tables'), {recursive: true});
    fs.writeFileSync(
      path.join(root, 'index.md'),
      '---\nokf_version: "0.2"\n---\n# Austin bikeshare knowledge\n',
      'utf8',
    );
    fs.writeFileSync(path.join(root, 'log.md'), '## 2026-10-01\n- ingest\n', 'utf8');
    fs.writeFileSync(path.join(root, 'tables/index.md'), '# Tables\n', 'utf8');
    fs.writeFileSync(
      path.join(root, 'tables/bikeshare_trips.md'),
      '---\ntype: Table\ntitle: bikeshare_trips\nstatus: verified\n---\n# bikeshare_trips\n',
      'utf8',
    );

    let sent: MetadataChange[] = [];
    spyOn(CatalogClient.prototype, 'batchChangeMetadata')
      .mockImplementation(async (_p, _l, _g, changes: MetadataChange[]) => {
        sent = changes;
        return okOperation() as any;
      });
    spyOn(console, 'log').mockImplementation(() => {});

    const res = await runPush(base);

    expect(res.success).toBe(true);
    expect(sent.map((c) => c.createEntryRequest?.entryId)).toEqual([
      'agents',
      'tables',
      'tables/bikeshare_trips',
    ]);
  });

  test('deletes remote entries missing from bundle/ in children-before-parents order', async () => {
    let sent: MetadataChange[] = [];
    spyOn(CatalogClient.prototype, 'batchChangeMetadata')
      .mockImplementation(async (_p, _l, _g, changes: MetadataChange[]) => {
        sent = changes;
        return okOperation() as any;
      });
    spyOn(console, 'log').mockImplementation(() => {});

    await runPush(bundle(), ['assets', 'assets/t', 'agents', 'old', 'old/sub', 'old/sub/leaf']);

    const deletes = sent
      .filter((c) => c.deleteEntryRequest)
      .map((c) => c.deleteEntryRequest!.name);
    expect(deletes).toEqual([
      `${GROUP}/entries/old/sub/leaf`,
      `${GROUP}/entries/old/sub`,
      `${GROUP}/entries/old`,
      `${GROUP}/entries/agents`,
    ]);
  });

  test('per-change failures in pollOperation metadata are counted and named', async () => {
    spyOn(CatalogClient.prototype, 'batchChangeMetadata').mockImplementation(
      async () =>
        ({
          status: 200,
          result: {
            name: 'op/1',
            done: true,
            metadata: {failedRequests: {'1': {code: 7, message: 'denied'}}},
          },
        }) as any,
    );
    const errors: string[] = [];
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation((m: any) => void errors.push(m));

    const res = await runPush(bundle());

    expect(res.success).toBe(false);
    expect(errors.join('\n')).toContain('assets/t: denied');
  });

  test('falls back to Entries API on HTTP 501 or structured UNIMPLEMENTED (including deletes)', async () => {
    spyOn(CatalogClient.prototype, 'batchChangeMetadata').mockImplementation(
      async () =>
        ({
          status: 404,
          message: JSON.stringify({
            error: {code: 404, status: 'UNIMPLEMENTED', message: 'not deployed'},
          }),
        }) as any,
    );
    const created: string[] = [];
    const deleted: string[] = [];
    spyOn(CatalogClient.prototype, 'createEntry').mockImplementation(
      async (_p, _l, _g, entryId: string, entry?: Entry) => {
        created.push(entryId);
        expect(entry).not.toHaveProperty('name');
        return {status: 200, result: {}} as any;
      },
    );
    spyOn(CatalogClient.prototype, 'deleteEntry').mockImplementation(
      async (_p, _l, _g, entryId: string) => {
        deleted.push(entryId);
        return {status: 200, result: {}} as any;
      },
    );
    spyOn(console, 'log').mockImplementation(() => {});

    const res = await runPush(bundle(), ['gone']);

    expect(res.success).toBe(true);
    expect(created).toEqual(['assets', 'assets/t']);
    expect(deleted).toEqual(['gone']);
  });

  test('does NOT fall back on a 404 NOT_FOUND or 400 INVALID_ARGUMENT', async () => {
    spyOn(CatalogClient.prototype, 'batchChangeMetadata').mockImplementation(
      async () =>
        ({
          status: 404,
          message: JSON.stringify({
            error: {code: 404, status: 'NOT_FOUND', message: 'entryGroup missing'},
          }),
        }) as any,
    );
    const create = spyOn(CatalogClient.prototype, 'createEntry');
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});

    const res = await runPush(bundle());

    expect(res.success).toBe(false);
    expect(create).not.toHaveBeenCalled();
  });

  test('bounds concurrent lookupEntry calls on pull to <= 8 while keeping output deterministic', async () => {
    const base = makeTempDir('okfpull-conc-');
    fs.writeFileSync(
      path.join(base, 'catalog.yaml'),
      'scope: entryGroup.dst-project.us.dst\nlayout: okf\n',
      'utf8',
    );
    const total = 24;
    const ids = Array.from({length: total}, (_, i) => `item_${String(i).padStart(2, '0')}`);
    spyOn(CatalogClient.prototype, 'getEntryGroup').mockImplementation(
      async () => ({status: 200, result: {name: GROUP}}) as any,
    );
    spyOn(CatalogClient.prototype, 'listEntries').mockImplementation(
      async function* () {
        for (const id of ids) yield {name: `${GROUP}/entries/${id}`, entryType: DOCUMENT};
      } as any,
    );

    let inFlight = 0;
    let maxInFlight = 0;
    spyOn(CatalogClient.prototype, 'lookupEntry').mockImplementation(
      async (_p, _l, name) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        inFlight--;
        return {
          status: 200,
          result: {
            name,
            entryType: DOCUMENT,
            entrySource: {displayName: name.split('/').pop()},
          },
        } as any;
      },
    );

    const lines: string[] = [];
    spyOn(console, 'log').mockImplementation((m: any) => void lines.push(m));

    const snapshot = await CatalogSnapshot.fromPath(base, CTX);
    const sync = new CatalogSync(new CatalogClient(CTX), snapshot);
    const res = await sync.pull({dryRun: true});

    expect(res.success).toBe(true);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(lines.slice(0, total)).toEqual(
      ids.map((id) => `would write bundle/${id}.md`),
    );
  });

  test('pushes bundle/_links.yaml (related, reference, definition) and deletes orphaned links', async () => {
    const base = bundle();
    fs.writeFileSync(
      path.join(base, 'bundle', '_links.yaml'),
      [
        'links:',
        '  - type: related',
        '    entries:',
        '      - assets',
        '      - assets/t',
        '  - type: reference',
        '    entries:',
        '      - name: assets',
        '        type: SOURCE',
        '      - name: assets/t',
        '        type: TARGET',
        '  - type: definition',
        '    entries:',
        '      - name: assets/t',
        '        type: SOURCE',
        '      - name: projects/ext/locations/us/entryGroups/@bigquery/entries/bq.p.d.t',
        '        path: Schema.col1',
        '        type: TARGET',
        '',
      ].join('\n'),
      'utf8',
    );

    spyOn(CatalogClient.prototype, 'batchChangeMetadata').mockImplementation(
      async () => okOperation() as any,
    );
    spyOn(CatalogClient.prototype, 'lookupEntryLinks').mockImplementation(
      async () =>
        ({
          status: 200,
          result: [
            {
              name: `${GROUP}/entryLinks/link-orphaned`,
              entryLinkType:
                'projects/dataplex-types/locations/global/entryLinkTypes/related',
              entryReferences: [
                {name: `${GROUP}/entries/assets`, type: 'UNSPECIFIED'},
                {name: `${GROUP}/entries/old`, type: 'UNSPECIFIED'},
              ],
            },
          ],
        }) as any,
    );
    const deleted: string[] = [];
    spyOn(CatalogClient.prototype, 'deleteEntryLink').mockImplementation(
      async (_p, _l, _g, id: string) => {
        deleted.push(id);
        return {status: 200, result: {}} as any;
      },
    );
    const created: Array<{id: string; link: EntryLink}> = [];
    spyOn(CatalogClient.prototype, 'createEntryLink').mockImplementation(
      async (_p, _l, _g, id: string, link: EntryLink) => {
        created.push({id, link});
        return {status: 200, result: link} as any;
      },
    );
    spyOn(console, 'log').mockImplementation(() => {});

    const res = await runPush(base);

    expect(res.success).toBe(true);
    expect(deleted).toEqual(['link-orphaned']);
    expect(created).toHaveLength(3);
    expect(created[0].link.entryLinkType).toBe(
      'projects/dataplex-types/locations/global/entryLinkTypes/related',
    );
    expect(created[1].link.entryLinkType).toBe(
      'projects/dataplex-types/locations/global/entryLinkTypes/reference',
    );
    expect(created[2].link.entryLinkType).toBe(
      'projects/dataplex-types/locations/global/entryLinkTypes/definition',
    );
    expect(created[2].link.entryReferences).toEqual([
      {name: `${GROUP}/entries/assets/t`, type: 'SOURCE'},
      {
        name: 'projects/ext/locations/us/entryGroups/@bigquery/entries/bq.p.d.t',
        path: 'Schema.col1',
        type: 'TARGET',
      },
    ]);
  });

  test('--validate-only logs would link for bundle/_links.yaml without network calls', async () => {
    const base = bundle();
    fs.writeFileSync(
      path.join(base, 'bundle', '_links.yaml'),
      'links:\n  - type: related\n    entries:\n      - assets\n      - assets/t\n',
      'utf8',
    );
    const logs: string[] = [];
    spyOn(console, 'log').mockImplementation((m: any) => void logs.push(String(m)));
    const createLink = spyOn(CatalogClient.prototype, 'createEntryLink');

    const res = await runPush(base, [], {validateOnly: true});

    expect(res.success).toBe(true);
    expect(
      logs.some((l) => l.startsWith(`would link ${GROUP}/entryLinks/link-`)),
    ).toBe(true);
    expect(createLink).not.toHaveBeenCalled();
  });
});
