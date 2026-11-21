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
import {CatalogManifest} from '../../../src/libts/manifest';
import {CatalogSnapshot} from '../../../src/libts/snapshot';
import {Sources} from '../../../src/libts/source';
import {CatalogSync, PushSyncOptions} from '../../../src/libts/sync';

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
  options: PushSyncOptions = {},
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

  test('skips reserved log.md at any level while pushing typed agents.md and Attested Computation concepts', async () => {
    const base = makeTempDir('okfpush-v02-skip-');
    fs.writeFileSync(
      path.join(base, 'catalog.yaml'),
      'scope: entryGroup.dst-project.us.dst\nlayout: okf\n',
      'utf8',
    );
    const root = path.join(base, 'bundle');
    fs.mkdirSync(path.join(root, 'computations'), {recursive: true});
    fs.writeFileSync(
      path.join(root, 'index.md'),
      '---\nokf_version: "0.2"\n---\n# Finance\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'agents.md'),
      '---\ntype: Knowledge Base Root\ntitle: Finance Router\n---\n# Finance Router\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'computations/log.md'),
      '## 2026-11-03\n* **Creation**: Added revenue.\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(root, 'computations/revenue.md'),
      '---\ntype: Attested Computation\ntitle: Revenue\nruntime: bigquery\n---\n# Computation\n```sql\nSELECT 1\n```\n',
      'utf8',
    );

    const lines: string[] = [];
    spyOn(console, 'log').mockImplementation((m: any) => void lines.push(String(m)));

    const res = await runPush(base, [], {validateOnly: true});

    expect(res.success).toBe(true);
    expect(lines).toContain(`would write ${GROUP}/entries/agents`);
    expect(lines).toContain(`would write ${GROUP}/entries/computations/revenue`);
    expect(lines.at(-1)).toContain('2 change(s): 2 create, 0 update, 0 delete');
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
          body: JSON.stringify({
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
          body: JSON.stringify({
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

  test('preserves a pulled remote entry named log or <dir>/log carrying x-kcmd while skipping untyped log.md history files', async () => {
    const base = makeTempDir('okfpush-log-');
    fs.writeFileSync(
      path.join(base, 'catalog.yaml'),
      'scope: entryGroup.dst-project.us.dst\nlayout: okf\n',
      'utf8',
    );
    const root = path.join(base, 'bundle');
    file(root, 'documents/log', DOCUMENT, 'documents');
    file(root, 'documents', DOCUMENT);
    fs.writeFileSync(
      path.join(root, 'log.md'),
      '## 2026-11-05\n* **Update**: History entry.\n',
      'utf8',
    );

    let sent: MetadataChange[] = [];
    spyOn(CatalogClient.prototype, 'batchChangeMetadata')
      .mockImplementation(async (_p, _l, _g, changes: MetadataChange[]) => {
        sent = changes;
        return okOperation() as any;
      });
    spyOn(console, 'log').mockImplementation(() => {});

    const res = await runPush(base, ['documents', 'documents/log']);

    expect(res.success).toBe(true);
    expect(sent.filter((c) => c.deleteEntryRequest)).toHaveLength(0);
    expect(
      sent.map((c) => c.updateEntryRequest?.entry.name),
    ).toEqual([
      `${GROUP}/entries/documents`,
      `${GROUP}/entries/documents/log`,
    ]);
  });

  test('reconcileLinks ignores 403 on lookupEntryLinks for newly created entries and retries 429 on createEntryLink', async () => {
    const base = bundle();
    fs.writeFileSync(
      path.join(base, 'bundle', '_links.yaml'),
      'links:\n  - type: related\n    entries:\n      - assets\n      - assets/t\n',
      'utf8',
    );
    spyOn(CatalogClient.prototype, 'batchChangeMetadata').mockImplementation(
      async () => okOperation() as any,
    );
    spyOn(CatalogClient.prototype, 'lookupEntryLinks').mockImplementation(
      async () => ({status: 403, message: 'or it may not exist'}) as any,
    );
    let createCalls = 0;
    spyOn(CatalogClient.prototype, 'createEntryLink').mockImplementation(
      async (_p, _l, _g, _id, link) => {
        createCalls++;
        if (createCalls === 1) {
          return {status: 429, message: 'rate limit'} as any;
        }
        return {status: 200, result: link} as any;
      },
    );
    spyOn(console, 'log').mockImplementation(() => {});

    const res = await runPush(base, [], {retryDelayMs: 0});
    expect(res.success).toBe(true);
    expect(createCalls).toBe(2);
  });
});

describe('CatalogSync OKF push change detection and link preflight', () => {
  async function capturePushedEntries(base: string): Promise<Entry[]> {
    let sent: MetadataChange[] = [];
    spyOn(CatalogClient.prototype, 'batchChangeMetadata').mockImplementation(
      async (_p, _l, _g, changes: MetadataChange[]) => {
        sent = changes;
        return okOperation() as any;
      },
    );
    spyOn(console, 'log').mockImplementation(() => {});
    expect((await runPush(base)).success).toBe(true);
    mock.restore();
    spyOn(globalThis, 'fetch').mockImplementation((async () => {
      throw new Error('a test made a network call');
    }) as any);
    return sent.map((c) => {
      const req = c.createEntryRequest!;
      return {...req.entry, name: `${GROUP}/entries/${req.entryId}`};
    });
  }

  test('skips existing entries whose entrySource and aspects already match and reports them as unchanged', async () => {
    const base = bundle();
    const remote = await capturePushedEntries(base);
    expect(remote.map((e) => e.name)).toEqual([
      `${GROUP}/entries/assets`,
      `${GROUP}/entries/assets/t`,
    ]);
    // Server-only fields on the remote copy must not count as a change.
    const byName = new Map(
      remote.map((e) => [
        e.name,
        {
          ...e,
          entrySource: {...e.entrySource, updateTime: '2026-11-06T00:00:00Z'},
        },
      ]),
    );
    // Edit one concept's description locally.
    const leaf = path.join(base, 'bundle', 'assets', 't.md');
    fs.writeFileSync(
      leaf,
      fs.readFileSync(leaf, 'utf8').replace('title: assets/t\n', 'title: assets/t\ndescription: edited\n'),
      'utf8',
    );

    spyOn(CatalogClient.prototype, 'lookupEntry').mockImplementation(
      async (_p, _l, name: string) => ({status: 200, result: byName.get(name)}) as any,
    );
    let sent: MetadataChange[] = [];
    const batch = spyOn(CatalogClient.prototype, 'batchChangeMetadata').mockImplementation(
      async (_p, _l, _g, changes: MetadataChange[]) => {
        sent = changes;
        return okOperation() as any;
      },
    );
    const lines: string[] = [];
    spyOn(console, 'log').mockImplementation((m: any) => void lines.push(String(m)));

    const dry = await runPush(base, ['assets', 'assets/t'], {validateOnly: true});
    expect(dry.success).toBe(true);
    expect(batch).not.toHaveBeenCalled();
    expect(lines).toContain(`would write ${GROUP}/entries/assets/t`);
    expect(lines).not.toContain(`would write ${GROUP}/entries/assets`);
    expect(lines.at(-1)).toContain('1 change(s): 0 create, 1 update, 0 delete, 1 unchanged');

    const res = await runPush(base, ['assets', 'assets/t']);
    expect(res.success).toBe(true);
    expect(sent.map((c) => c.updateEntryRequest?.entry.name)).toEqual([
      `${GROUP}/entries/assets/t`,
    ]);
    expect(sent[0].updateEntryRequest?.entry.entrySource?.description).toBe('edited');
  });

  test('a remote description the concept no longer has is a change', async () => {
    const base = bundle();
    const remote = await capturePushedEntries(base);
    const byName = new Map(
      remote.map((e) => [e.name, {...e, entrySource: {...e.entrySource, description: 'old'}}]),
    );
    spyOn(CatalogClient.prototype, 'lookupEntry').mockImplementation(
      async (_p, _l, name: string) => ({status: 200, result: byName.get(name)}) as any,
    );
    const lines: string[] = [];
    spyOn(console, 'log').mockImplementation((m: any) => void lines.push(String(m)));

    await runPush(base, ['assets', 'assets/t'], {validateOnly: true});
    expect(lines.at(-1)).toContain('2 change(s): 0 create, 2 update, 0 delete');
  });

  test('skips, with a warning, a _links.yaml link to a concept whose file was deleted, and still deletes the entry', async () => {
    const base = bundle();
    fs.writeFileSync(
      path.join(base, 'bundle', '_links.yaml'),
      [
        'links:',
        '  - type: related',
        '    entries:',
        '      - assets',
        '      - assets/t',
        '  - type: related',
        '    entries:',
        '      - assets',
        '      - documents/removed',
        '',
      ].join('\n'),
      'utf8',
    );
    let sent: MetadataChange[] = [];
    spyOn(CatalogClient.prototype, 'batchChangeMetadata').mockImplementation(
      async (_p, _l, _g, changes: MetadataChange[]) => {
        sent = changes;
        return okOperation() as any;
      },
    );
    spyOn(CatalogClient.prototype, 'lookupEntryLinks').mockImplementation(
      async () => ({status: 200, result: []}) as any,
    );
    const created: EntryLink[] = [];
    spyOn(CatalogClient.prototype, 'createEntryLink').mockImplementation(
      async (_p, _l, _g, _id, link: EntryLink) => {
        created.push(link);
        return {status: 200, result: link} as any;
      },
    );
    const warnings: string[] = [];
    spyOn(console, 'warn').mockImplementation((m: any) => void warnings.push(String(m)));
    spyOn(console, 'log').mockImplementation(() => {});

    const res = await runPush(base, ['documents/removed']);

    expect(res.success).toBe(true);
    expect(sent.map((c) => c.deleteEntryRequest?.name).filter(Boolean)).toEqual([
      `${GROUP}/entries/documents/removed`,
    ]);
    expect(created).toHaveLength(1);
    expect(created[0].entryReferences.map((r) => r.name)).toEqual([
      `${GROUP}/entries/assets`,
      `${GROUP}/entries/assets/t`,
    ]);
    expect(warnings.join('\n')).toContain('documents/removed is not a concept in bundle/');
  });

  test('refuses a link to an entry in another region before writing anything, including on --dry-run', async () => {
    const base = bundle();
    fs.writeFileSync(
      path.join(base, 'bundle', '_links.yaml'),
      [
        'links:',
        '  - type: reference',
        '    source: assets/t',
        '    target: projects/ext/locations/us-central1/entryGroups/@bigquery/entries/bq.p.d.t',
        '  - type: reference',
        '    source: assets',
        '    target: projects/ext/locations/global/entryGroups/g/entries/ok',
        '',
      ].join('\n'),
      'utf8',
    );
    const batch = spyOn(CatalogClient.prototype, 'batchChangeMetadata');
    spyOn(console, 'log').mockImplementation(() => {});

    for (const validateOnly of [true, false]) {
      const res = await runPush(base, [], {validateOnly});
      expect(res.success).toBe(false);
      expect(res.details).toContain("is in region 'us-central1'");
      expect(res.details).toContain("'us' or 'global'");
      expect(res.details).not.toContain('locations/global/entryGroups/g');
    }
    expect(batch).not.toHaveBeenCalled();
  });

  test('counts entry link failures separately from entry changes', async () => {
    const base = bundle();
    fs.writeFileSync(
      path.join(base, 'bundle', '_links.yaml'),
      'links:\n  - type: related\n    entries:\n      - assets\n      - assets/t\n',
      'utf8',
    );
    spyOn(CatalogClient.prototype, 'batchChangeMetadata').mockImplementation(
      async () => okOperation() as any,
    );
    spyOn(CatalogClient.prototype, 'lookupEntryLinks').mockImplementation(
      async () => ({status: 200, result: []}) as any,
    );
    spyOn(CatalogClient.prototype, 'createEntryLink').mockImplementation(
      async () => ({status: 400, message: 'bad link'}) as any,
    );
    const lines: string[] = [];
    const errors: string[] = [];
    spyOn(console, 'log').mockImplementation((m: any) => void lines.push(String(m)));
    spyOn(console, 'error').mockImplementation((m: any) => void errors.push(String(m)));

    const res = await runPush(base);

    expect(res.success).toBe(false);
    expect(lines.at(-1)).toContain('Pushed 2/2 change(s)');
    expect(errors.join('\n')).toContain('1 entry link change(s) failed.');
  });
});

describe('CatalogSync OKF new-EntryGroup link propagation and manifest defaults', () => {
  async function runPushWithGroup(
    base: string,
    existing: string[],
    groupResult: Record<string, unknown>,
    options: PushSyncOptions = {retryDelayMs: 0},
  ) {
    spyOn(CatalogClient.prototype, 'getEntryGroup').mockImplementation(
      async () => ({status: 200, result: {name: GROUP, ...groupResult}}) as any,
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

  test('skips lookupEntryLinks on a newly created EntryGroup (ignoring synthetic <group>_entry), prints stderr progress, and retries transient 403/404 on createEntryLink', async () => {
    const base = bundle();
    fs.writeFileSync(
      path.join(base, 'bundle', '_links.yaml'),
      'links:\n  - type: related\n    entries:\n      - assets\n      - assets/t\n',
      'utf8',
    );
    spyOn(CatalogClient.prototype, 'batchChangeMetadata').mockImplementation(
      async () => okOperation() as any,
    );
    const lookupSpy = spyOn(
      CatalogClient.prototype,
      'lookupEntryLinks',
    ).mockImplementation(
      async () => ({status: 403, message: 'or it may not exist'}) as any,
    );
    let createCalls = 0;
    spyOn(CatalogClient.prototype, 'createEntryLink').mockImplementation(
      async (_p, _l, _g, _id, link) => {
        createCalls++;
        if (createCalls === 1) {
          return {
            status: 403,
            message: `Permission denied on '//dataplex.googleapis.com/${GROUP}' (or it may not exist)`,
          } as any;
        }
        if (createCalls === 2) {
          return {
            status: 404,
            message: `Resource '${GROUP}/entries/assets' not found`,
          } as any;
        }
        return {status: 200, result: link} as any;
      },
    );
    const stderrLines: string[] = [];
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation((m: any) =>
      void stderrLines.push(String(m)),
    );

    const res = await runPushWithGroup(base, ['dst_entry'], {
      createTime: new Date().toISOString(),
    });
    expect(res.success).toBe(true);
    expect(lookupSpy).not.toHaveBeenCalled();
    expect(createCalls).toBe(3);
    expect(
      stderrLines.some((l) =>
        l.includes("Waiting for Dataplex permissions on new context set 'dst'"),
      ),
    ).toBe(true);
    expect(
      stderrLines.some((l) => l.includes("Dataplex permissions on 'dst' ready")),
    ).toBe(true);
  });

  test('probes a single lookupEntryLinks call sequentially before fanning out on immediate re-push within the propagation window', async () => {
    const base = bundle();
    fs.writeFileSync(
      path.join(base, 'bundle', '_links.yaml'),
      'links:\n  - type: related\n    entries:\n      - assets\n      - assets/t\n',
      'utf8',
    );
    spyOn(CatalogClient.prototype, 'batchChangeMetadata').mockImplementation(
      async () => okOperation() as any,
    );
    const attemptsByEntry = new Map<string, number>();
    let ready = false;
    spyOn(CatalogClient.prototype, 'lookupEntryLinks').mockImplementation(
      async (_p, _l, opts: {entry: string}) => {
        const n = (attemptsByEntry.get(opts.entry) ?? 0) + 1;
        attemptsByEntry.set(opts.entry, n);
        if (!ready && n < 3) {
          return {
            status: 403,
            message: `Permission denied on '//dataplex.googleapis.com/${opts.entry}' (or it may not exist)`,
          } as any;
        }
        ready = true;
        return {
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
        } as any;
      },
    );
    const deleted: string[] = [];
    spyOn(CatalogClient.prototype, 'deleteEntryLink').mockImplementation(
      async (_p, _l, _g, id: string) => {
        deleted.push(id);
        return {status: 200, result: {}} as any;
      },
    );
    let created = 0;
    spyOn(CatalogClient.prototype, 'createEntryLink').mockImplementation(
      async (_p, _l, _g, _id, link) => {
        created++;
        return {status: 200, result: link} as any;
      },
    );
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});

    const res = await runPushWithGroup(
      base,
      ['assets', 'assets/t', 'dst_entry'],
      {createTime: new Date(Date.now() - 40_000).toISOString()},
    );
    expect(res.success).toBe(true);
    expect(attemptsByEntry.get(`${GROUP}/entries/assets`)).toBe(3);
    expect(attemptsByEntry.get(`${GROUP}/entries/assets/t`)).toBe(1);
    expect(attemptsByEntry.has(`${GROUP}/entries/dst_entry`)).toBe(false);
    expect(deleted).toEqual(['link-orphaned']);
    expect(created).toBe(1);
  });

  test('does not retry 403 naming an external group, a prefix-matching sibling group (<group>_archive), or an old EntryGroup', async () => {
    const base = bundle();
    fs.writeFileSync(
      path.join(base, 'bundle', '_links.yaml'),
      [
        'links:',
        '  - type: reference',
        '    source: assets/t',
        '    target: projects/ext/locations/us/entryGroups/@bigquery/entries/bq.p.d.secret',
        '',
      ].join('\n'),
      'utf8',
    );
    spyOn(CatalogClient.prototype, 'batchChangeMetadata').mockImplementation(
      async () => okOperation() as any,
    );
    let createCalls = 0;
    spyOn(CatalogClient.prototype, 'createEntryLink').mockImplementation(
      async () => {
        createCalls++;
        return {
          status: 403,
          message:
            "Permission denied on '//dataplex.googleapis.com/projects/ext/locations/us/entryGroups/@bigquery/entries/bq.p.d.secret'",
        } as any;
      },
    );
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation(() => {});

    const extRes = await runPushWithGroup(base, [], {
      createTime: new Date().toISOString(),
    });
    expect(extRes.success).toBe(false);
    expect(createCalls).toBe(1);

    // Prefix group ID (`dst_archive` vs `dst`) must not count as our own group.
    let prefixCalls = 0;
    spyOn(CatalogClient.prototype, 'createEntryLink').mockImplementation(
      async () => {
        prefixCalls++;
        return {
          status: 403,
          message:
            "Permission denied on '//dataplex.googleapis.com/projects/dst-project/locations/us/entryGroups/dst_archive/entries/x' (or it may not exist)",
        } as any;
      },
    );
    const prefixRes = await runPushWithGroup(base, [], {
      createTime: new Date().toISOString(),
    });
    expect(prefixRes.success).toBe(false);
    expect(prefixCalls).toBe(1);

    let oldLookupCalls = 0;
    spyOn(CatalogClient.prototype, 'lookupEntryLinks').mockImplementation(
      async () => {
        oldLookupCalls++;
        return {status: 403, message: 'Permission denied'} as any;
      },
    );
    const oldRes = await runPushWithGroup(base, ['assets', 'assets/t'], {
      createTime: '2025-01-01T00:00:00Z',
    });
    expect(oldRes.success).toBe(false);
    expect(oldLookupCalls).toBe(2);
  });

  test('stops retrying when propagationTimeoutMs runs out and reports a clear re-run hint', async () => {
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
        '    source: assets',
        '    target: assets/t',
        '',
      ].join('\n'),
      'utf8',
    );
    spyOn(CatalogClient.prototype, 'batchChangeMetadata').mockImplementation(
      async () => okOperation() as any,
    );
    let createCalls = 0;
    spyOn(CatalogClient.prototype, 'createEntryLink').mockImplementation(
      async () => {
        createCalls++;
        return {
          status: 403,
          body: JSON.stringify({
            error: {
              code: 403,
              message: 'Permission denied',
              details: [
                {
                  '@type': 'type.googleapis.com/google.rpc.ResourceInfo',
                  resourceName: `//dataplex.googleapis.com/${GROUP}`,
                },
              ],
            },
          }),
          message: 'Permission denied',
        } as any;
      },
    );
    const stderrLines: string[] = [];
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation((m: any) =>
      void stderrLines.push(String(m)),
    );

    const res = await runPushWithGroup(
      base,
      ['dst_entry'],
      {createTime: new Date().toISOString()},
      {propagationTimeoutMs: 20, retryDelayMs: 0},
    );
    expect(res.success).toBe(false);
    expect(createCalls).toBeGreaterThan(1);
    expect(res.details).toContain("re-run 'kcmd push' in ~2 minutes");
    expect(stderrLines.join('\n')).toContain('--propagation-timeout');
  });

  test('skips link reconciliation when entry writes fail so missing entries do not trigger propagation waits', async () => {
    const base = bundle();
    fs.writeFileSync(
      path.join(base, 'bundle', '_links.yaml'),
      'links:\n  - type: related\n    entries:\n      - assets\n      - assets/t\n',
      'utf8',
    );
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
    const createLink = spyOn(CatalogClient.prototype, 'createEntryLink');
    const stderrLines: string[] = [];
    spyOn(console, 'log').mockImplementation(() => {});
    spyOn(console, 'error').mockImplementation((m: any) =>
      void stderrLines.push(String(m)),
    );

    const res = await runPushWithGroup(base, ['dst_entry'], {
      createTime: new Date().toISOString(),
    });
    expect(res.success).toBe(false);
    expect(createLink).not.toHaveBeenCalled();
    expect(stderrLines.join('\n')).toContain(
      'Skipping entry link reconciliation because entry changes failed.',
    );
  });

  test('forPendingEntryGroup omits snapshot.aspects for OKF layout', () => {
    const dir = makeTempDir('okf-manifest-');
    const okfManifest = CatalogManifest.forPendingEntryGroup(
      Sources.ENTRYGROUP,
      'dst-project.us.dst',
      'okf',
    );
    const okfPath = path.join(dir, 'okf.yaml');
    okfManifest.save(okfPath);
    const okfSaved = fs.readFileSync(okfPath, 'utf8');
    expect(okfSaved).toContain('layout: okf');
    expect(okfSaved).not.toContain('snapshot:');

    const stdManifest = CatalogManifest.forPendingEntryGroup(
      Sources.ENTRYGROUP,
      'dst-project.us.dst',
    );
    const stdPath = path.join(dir, 'std.yaml');
    stdManifest.save(stdPath);
    expect(fs.readFileSync(stdPath, 'utf8')).toContain('snapshot:');
  });
});
