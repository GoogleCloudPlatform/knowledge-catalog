// Tests for the context-set source (src/libts/sources/split.ts), manifest
// rules, and layout selection: the scope that holds a semantic model and an
// OKF bundle in one entry group.

import {afterEach, beforeEach, describe, expect, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as gcp from '../../../src/libts/gcp';
import {createLayout, Layouts} from '../../../src/libts/layout';
import {OkfLayout} from '../../../src/libts/layouts/okf';
import {SemanticModelLayout} from '../../../src/libts/layouts/semantic-model';
import {SplitLayout} from '../../../src/libts/layouts/split';
import {CatalogManifest, readWorkspaceLayout} from '../../../src/libts/manifest';
import * as md from '../../../src/libts/metadata';
import {SEMANTIC_ENTRY_TYPE_IDS} from '../../../src/libts/semantic/entry_types';
import {CatalogSnapshot} from '../../../src/libts/snapshot';
import {entryGroupCoordinates, Sources} from '../../../src/libts/source';
import {SplitSource} from '../../../src/libts/sources/split';
import {TEST_API_CONTEXT} from '../mocks';

const SCOPE = 'test-project.us.eg';
const GROUP_NAME = 'projects/test-project/locations/us/entryGroups/eg';

function group(): gcp.EntryGroup {
  return {name: GROUP_NAME} as gcp.EntryGroup;
}

function source(): SplitSource {
  return new SplitSource(Sources.CONTEXT_SET, SCOPE, group());
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

describe('scope parsing & default aspects', () => {
  test('exposes the scope parts, group name, SPLIT layout, and overview defaultAspect', () => {
    const s = source();
    expect(s.project).toBe('test-project');
    expect(s.location).toBe('us');
    expect(s.entryGroup).toBe('eg');
    expect(s.groupName).toBe(GROUP_NAME);
    expect(s.layout).toBe(Layouts.SPLIT);
    expect(s.ingestedEntries).toBe(false);
    expect(s.defaultAspects).toEqual([md.OVERVIEW_ASPECT]);
    expect(entryGroupCoordinates(s)).toEqual({
      project: 'test-project',
      location: 'us',
      entryGroup: 'eg',
      container: GROUP_NAME,
    });
  });

  test('rejects a scope that is not project.location.group', () => {
    expect(() => new SplitSource('context-set', 'too.short', group()))
        .toThrow('must be in format');
    expect(() => new SplitSource('context-set', 'a.b.c.d', group()))
        .toThrow('must be in format');
  });

  test('entryGroupCoordinates error names all entry-group scopes', () => {
    const fakeBq = {type: Sources.BIGQUERY_DATASET, name: 'p.d'} as any;
    expect(() => entryGroupCoordinates(fakeBq)).toThrow(
        "Entry group coordinates apply only to 'entryGroup', 'kb', 'semantic-model', 'context-set' scopes, got 'bq-dataset'.");
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

describe('manifest & snapshot integration', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'split-source-'));
  });

  afterEach(() => {
    fs.rmSync(root, {recursive: true, force: true});
  });

  test('roots the model under catalog/ and the bundle under bundle/', async () => {
    const bundleFile = path.join(root, 'bundle', 'policies', 'revenue.md');
    fs.mkdirSync(path.dirname(bundleFile), {recursive: true});
    fs.writeFileSync(bundleFile, '---\ntype: document\n---\n# Revenue\n');

    const modelFile = path.join(root, 'catalog', 'EntryGroups', 'eg', 'commerce.yaml');
    fs.mkdirSync(path.dirname(modelFile), {recursive: true});
    fs.writeFileSync(modelFile, 'version: "0.2.0.dev0/google"\n');

    const layout = createLayout(Layouts.SPLIT, root, GROUP_NAME);
    expect(layout).toBeInstanceOf(SplitLayout);
    await layout.init();

    const split = layout as SplitLayout;
    expect(split.okf).toBeInstanceOf(OkfLayout);
    expect(split.semantic).toBeInstanceOf(SemanticModelLayout);
    expect(split.listEntries()).toEqual(['policies/revenue']);
    expect(split.semantic.modelDocuments().map(d => d.name)).toEqual(['commerce']);
  });

  test('initWithContextSet records defaultAspects without calling getEntryGroup and rejects layout: in catalog.yaml', async () => {
    const getGroup = spyOn(gcp.CatalogClient.prototype, 'getEntryGroup');
    try {
      const manifest = await CatalogManifest.initWithContextSet(SCOPE, TEST_API_CONTEXT);
      expect(getGroup).not.toHaveBeenCalled();
      expect(manifest.source).toBeInstanceOf(SplitSource);
      expect((manifest.source as SplitSource).groupName).toBe(GROUP_NAME);
      expect(manifest.snapshotConfig?.aspects).toEqual([md.OVERVIEW_ASPECT]);

      const manifestPath = path.join(root, 'catalog.yaml');
      manifest.save(manifestPath);
      const snapshot = await CatalogSnapshot.fromPath(root, TEST_API_CONTEXT);
      expect(getGroup).not.toHaveBeenCalled();
      expect(snapshot.layout).toBeInstanceOf(SplitLayout);

      fs.writeFileSync(
        manifestPath,
        `scope: context-set.${SCOPE}\nlayout: okf\n`,
        'utf8',
      );
      expect(() => readWorkspaceLayout(manifestPath)).toThrow(
        /applies only to 'entryGroup' and 'kb' scopes/,
      );
      await expect(
        CatalogManifest.load(manifestPath, TEST_API_CONTEXT),
      ).rejects.toThrow(/applies only to 'entryGroup' and 'kb' scopes/);
    } finally {
      getGroup.mockRestore();
    }
  });
});
