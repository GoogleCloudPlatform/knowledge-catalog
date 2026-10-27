// Tests for the OKF layout (src/libts/layouts/okf.ts): a catalog kept as a
// bundle of markdown concepts, read and written as kcmd's local entries.

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {OkfLayout} from '../../../src/libts/layouts/okf';
import * as gcp from '../../../src/libts/gcp';
import {conceptToFileContent} from '../../../src/libts/okf/concept';
import {entryToConcept} from '../../../src/libts/okf/entry_to_concept';

const GROUP = 'projects/p/locations/us-central1/entryGroups/g';
const DOC_TYPE = 'projects/dataplex-types/locations/global/entryTypes/document';

let root: string;

function serviceEntry(id: string, overrides: Partial<gcp.Entry> = {}): gcp.Entry {
  return {
    name: `${GROUP}/entries/${id}`,
    entryType: DOC_TYPE,
    entrySource: {displayName: id, description: `About ${id}.`},
    aspects: {
      'dataplex-types.global.overview': {
        data: {content: `# ${id}\n\nBody of ${id}.\n`, contentType: 'MARKDOWN'},
      },
    },
    ...overrides,
  } as gcp.Entry;
}

// Writes a concept the way `kcmd pull` would, so the bundle under test is one
// kcmd produced rather than a hand-authored sample.
function writeConcept(entry: gcp.Entry, id: string): string {
  const file = path.join(root, `${id}.md`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, conceptToFileContent(entryToConcept(entry, id)), 'utf8');
  return file;
}

async function layout(): Promise<OkfLayout> {
  const l = new OkfLayout(root, GROUP);
  await l.init();
  return l;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'okf-layout-'));
});

afterEach(() => {
  fs.rmSync(root, {recursive: true, force: true});
});

describe('indexing', () => {
  test('lists every concept by its bundle path, sorted', async () => {
    writeConcept(serviceEntry('revenue'), 'metrics/revenue');
    writeConcept(serviceEntry('orders'), 'tables/orders');
    writeConcept(serviceEntry('top'), 'top');

    expect((await layout()).listEntries()).toEqual([
      'metrics/revenue',
      'tables/orders',
      'top',
    ]);
  });

  // index.md is a directory listing and log.md is the bundle log. Treating
  // either as a concept would publish navigation into the catalog.
  test('skips the reserved navigation files', async () => {
    writeConcept(serviceEntry('revenue'), 'metrics/revenue');
    fs.writeFileSync(path.join(root, 'index.md'), '# Subdirectories\n', 'utf8');
    fs.writeFileSync(path.join(root, 'log.md'), '# Log\n', 'utf8');
    fs.mkdirSync(path.join(root, 'metrics'), {recursive: true});
    fs.writeFileSync(path.join(root, 'metrics', 'index.md'), '# Metric\n', 'utf8');

    const l = await layout();
    expect(l.listEntries()).toEqual(['metrics/revenue']);
    expect(l.entryExists('index')).toBe(false);
    expect(l.entryExists('metrics/index')).toBe(false);
  });

  test('an empty or absent bundle lists nothing', async () => {
    expect((await layout()).listEntries()).toEqual([]);
    fs.rmSync(root, {recursive: true, force: true});
    expect((await layout()).listEntries()).toEqual([]);
  });
});

describe('loadEntry', () => {
  test('reads a concept as a local entry', async () => {
    writeConcept(serviceEntry('revenue'), 'metrics/revenue');
    const entry = await (await layout()).loadEntry('metrics/revenue');

    expect(entry.name).toBe('metrics/revenue');
    expect(entry.type).toBe('dataplex-types.global.document');
    expect(entry.resource.displayName).toBe('revenue');
    expect(entry.resource.description).toBe('About revenue.');
    expect(entry.aspects?.['dataplex-types.global.overview']?.['content'])
        .toBe('# revenue\n\nBody of revenue.\n');
  });

  // parentEntry is a full resource name on the wire and a local name in
  // md.Entry; that is what lets a bundle be pushed to a different group.
  test('gives the parent as a local name', async () => {
    writeConcept(
        serviceEntry('revenue', {parentEntry: `${GROUP}/entries/metrics`}),
        'metrics/revenue');
    const entry = await (await layout()).loadEntry('metrics/revenue');
    expect(entry.resource.parent).toBe('metrics');
  });

  test('fails on an unknown name', async () => {
    await expect((await layout()).loadEntry('nope')).rejects.toThrow(
        'Entry not found: nope');
  });
});

describe('saveEntry', () => {
  test('a get-then-save round trip writes nothing', async () => {
    const file = writeConcept(serviceEntry('revenue'), 'metrics/revenue');
    const before = fs.readFileSync(file, 'utf8');
    const stat = fs.statSync(file);

    const l = await layout();
    await l.saveEntry('metrics/revenue', await l.loadEntry('metrics/revenue'));

    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(fs.statSync(file).mtimeMs).toBe(stat.mtimeMs);
  });

  test('an edit reaches the file and reads back', async () => {
    writeConcept(serviceEntry('revenue'), 'metrics/revenue');
    const l = await layout();
    const entry = await l.loadEntry('metrics/revenue');
    entry.resource.description = 'Recognized revenue.';
    await l.saveEntry('metrics/revenue', entry);

    expect((await l.loadEntry('metrics/revenue')).resource.description)
        .toBe('Recognized revenue.');
  });

  test('creates a new concept in a subfolder', async () => {
    const l = await layout();
    await l.saveEntry('metrics/new', {
      name: 'metrics/new',
      type: 'dataplex-types.global.document',
      resource: {displayName: 'New'},
      aspects: {'dataplex-types.global.overview': {content: '# New\n'}},
    });

    expect(fs.existsSync(path.join(root, 'metrics', 'new.md'))).toBe(true);
    expect(l.listEntries()).toContain('metrics/new');
    expect((await l.loadEntry('metrics/new')).resource.displayName).toBe('New');
  });

  // The name reaches the layout from `kcmd entry save`, so it is caller input.
  test('refuses a name that leaves the bundle folder', async () => {
    const l = await layout();
    const entry = {
      name: '../escaped',
      type: 'dataplex-types.global.document',
      resource: {},
    };
    await expect(l.saveEntry('../escaped', entry)).rejects.toThrow(
        'points outside the catalog folder');
    expect(fs.existsSync(path.join(path.dirname(root), 'escaped.md'))).toBe(false);
  });

  // system and platform have no home in md.Entry, so a caller editing an
  // entry cannot see them and must not silently drop them.
  test('carries entrySource fields md.Entry cannot express', async () => {
    writeConcept(
        serviceEntry('revenue', {
          entrySource: {
            displayName: 'revenue',
            system: 'BIGQUERY',
            platform: 'GCP',
          },
        }),
        'metrics/revenue');

    const l = await layout();
    const entry = await l.loadEntry('metrics/revenue');
    entry.resource.description = 'changed';
    await l.saveEntry('metrics/revenue', entry);

    const text = fs.readFileSync(path.join(root, 'metrics', 'revenue.md'), 'utf8');
    expect(text).toContain('system: BIGQUERY');
    expect(text).toContain('platform: GCP');
  });

  // SPEC 4.1: consumers preserve unknown keys.
  test('carries a producer extension it does not model', async () => {
    const file = writeConcept(serviceEntry('revenue'), 'metrics/revenue');
    fs.writeFileSync(
        file,
        fs.readFileSync(file, 'utf8').replace('---\n', '---\nx-acme-owner: finance\n'),
        'utf8');

    const l = await layout();
    const entry = await l.loadEntry('metrics/revenue');
    entry.resource.description = 'changed';
    await l.saveEntry('metrics/revenue', entry);

    expect(fs.readFileSync(file, 'utf8')).toContain('x-acme-owner: finance');
  });
});

describe('deleteEntry', () => {
  test('removes the file and the name', async () => {
    writeConcept(serviceEntry('revenue'), 'metrics/revenue');
    const l = await layout();
    await l.deleteEntry('metrics/revenue');

    expect(fs.existsSync(path.join(root, 'metrics', 'revenue.md'))).toBe(false);
    expect(l.listEntries()).toEqual([]);
  });

  test('fails on an unknown name', async () => {
    await expect((await layout()).deleteEntry('nope')).rejects.toThrow(
        'Entry not found: nope');
  });
});

describe('batch writes', () => {
  test('reports one result per item, in order, and applies the good ones',
       async () => {
         writeConcept(serviceEntry('revenue'), 'metrics/revenue');
         const l = await layout();
         const good = await l.loadEntry('metrics/revenue');
         good.resource.description = 'edited';

         const results = await l.saveEntries([
           good,
           {name: '../bad', type: 'dataplex-types.global.document', resource: {}},
           {
             name: 'metrics/other',
             type: 'dataplex-types.global.document',
             resource: {displayName: 'Other'},
           },
         ]);

         expect(results.map(r => [r.name, r.ok])).toEqual([
           ['metrics/revenue', true],
           ['../bad', false],
           ['metrics/other', true],
         ]);
         expect(results[1].error).toContain('points outside the catalog folder');
         expect((await l.loadEntry('metrics/revenue')).resource.description)
             .toBe('edited');
         expect(l.listEntries()).toEqual(['metrics/other', 'metrics/revenue']);
       });

  test('deleteEntries reports per item and keeps going', async () => {
    writeConcept(serviceEntry('a'), 'a');
    writeConcept(serviceEntry('b'), 'b');
    const l = await layout();

    const results = await l.deleteEntries(['a', 'missing', 'b']);
    expect(results.map(r => [r.name, r.ok])).toEqual([
      ['a', true],
      ['missing', false],
      ['b', true],
    ]);
    expect(l.listEntries()).toEqual([]);
  });
});
