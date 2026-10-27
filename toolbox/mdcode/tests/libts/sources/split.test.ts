// Tests for the context-set source (src/libts/sources/split.ts) and the
// layout it selects: the scope that holds a semantic model and an OKF bundle
// in one entry group.

import {afterEach, beforeEach, describe, expect, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as gcp from '../../../src/libts/gcp';
import {createLayout, Layouts} from '../../../src/libts/layout';
import {OkfLayout} from '../../../src/libts/layouts/okf';
import {SplitLayout} from '../../../src/libts/layouts/split';
import {SEMANTIC_ENTRY_TYPE_IDS} from '../../../src/libts/semantic/entry_types';
import {SplitSource} from '../../../src/libts/sources/split';
import {TEST_API_CONTEXT} from '../mocks';

const SCOPE = 'test-project.us.eg';
const GROUP_NAME = 'projects/test-project/locations/us/entryGroups/eg';

function group(): gcp.EntryGroup {
  return {name: GROUP_NAME} as gcp.EntryGroup;
}

function source(): SplitSource {
  return new SplitSource('context-set', SCOPE, group());
}

function entryOfType(id: string, typeId: string): gcp.Entry {
  return {
    name: `${GROUP_NAME}/entries/${id}`,
    entryType: `projects/dataplex-types/locations/global/entryTypes/${typeId}`,
  } as gcp.Entry;
}

async function collect(src: SplitSource): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of src.entries(TEST_API_CONTEXT)) {
    names.push(src.localName(entry));
  }
  return names;
}

describe('scope parsing', () => {
  test('exposes the scope\'s parts and the group name', () => {
    const s = source();
    expect(s.project).toBe('test-project');
    expect(s.location).toBe('us');
    expect(s.entryGroup).toBe('eg');
    expect(s.groupName).toBe(GROUP_NAME);
    expect(s.layout).toBe(Layouts.SPLIT);
    expect(s.ingestedEntries).toBe(false);
  });

  test('rejects a scope that is not project.location.group', () => {
    expect(() => new SplitSource('context-set', 'too.short', group()))
        .toThrow('must be in format');
  });
});

describe('entries', () => {
  // The model half is pulled by its own leg, so enumerating its entries here
  // would write them into the bundle as well and push them back twice.
  test('leaves out every semantic entry type and keeps the rest', async () => {
    const listed = [
      entryOfType('policies/revenue', 'document'),
      ...SEMANTIC_ENTRY_TYPE_IDS.map((t, i) => entryOfType(`sem-${i}`, t)),
      entryOfType('tables/orders', 'generic'),
    ];
    const spy = spyOn(gcp.CatalogClient.prototype, 'listEntries')
                    .mockImplementation(async function*() {
                      for (const e of listed) yield e;
                    });

    try {
      expect(await collect(source())).toEqual([
        'policies/revenue',
        'tables/orders',
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  test('an unknown semantic type is left out too', async () => {
    const spy = spyOn(gcp.CatalogClient.prototype, 'listEntries')
                    .mockImplementation(async function*() {
                      yield entryOfType('doc', 'document');
                      yield entryOfType('future', 'semantic-something-new');
                    });
    try {
      expect(await collect(source())).toEqual(['doc']);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('names', () => {
  test('round-trips a nested concept id', () => {
    const s = source();
    const name = s.serviceName('policies/revenue');
    expect(name).toBe(`${GROUP_NAME}/entries/policies/revenue`);
    expect(s.localName({name} as gcp.Entry)).toBe('policies/revenue');
  });

  test('rejects an entry name it cannot read', () => {
    expect(() => source().localName({name: 'nonsense'} as gcp.Entry))
        .toThrow('Invalid entry name');
  });
});

describe('createLayout', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-source-'));
  });

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  // The two halves sit in different folders: the model where a semantic-model
  // workspace keeps it, the bundle beside it rather than inside catalog/.
  test('roots the model under catalog/ and the bundle under bundle/', async () => {
    const bundleFile = path.join(root, 'bundle', 'policies', 'revenue.md');
    fs.mkdirSync(path.dirname(bundleFile), {recursive: true});
    fs.writeFileSync(bundleFile, '---\ntype: document\n---\n# Revenue\n');

    const layout = createLayout(source(), root);
    expect(layout).toBeInstanceOf(SplitLayout);
    await layout.init();

    expect((layout as SplitLayout).okf).toBeInstanceOf(OkfLayout);
    expect(layout.listEntries()).toEqual(['policies/revenue']);
  });
});
