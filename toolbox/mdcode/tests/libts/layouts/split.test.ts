// Tests for the split layout (src/libts/layouts/split.ts): a thin holder of
// SemanticModelLayout (`catalog/`) and OkfLayout (`bundle/`) that forwards
// CatalogLayout methods to `this.okf` without parsing the model YAML during
// `init()`.

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as gcp from '../../../src/libts/gcp';
import {OkfLayout} from '../../../src/libts/layouts/okf';
import {SemanticModelLayout} from '../../../src/libts/layouts/semantic-model';
import {SplitLayout} from '../../../src/libts/layouts/split';
import * as md from '../../../src/libts/metadata';
import {conceptToFileContent} from '../../../src/libts/okf/concept';
import {entryToConcept} from '../../../src/libts/okf/concept_to_entry';

const GROUP = 'projects/test-project/locations/us/entryGroups/eg';
const DOC_TYPE = 'projects/dataplex-types/locations/global/entryTypes/document';

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-split-'));
});

afterEach(() => {
  fs.rmSync(root, {recursive: true, force: true});
});

function writeModel(text: string): void {
  const dir = path.join(root, 'catalog', 'EntryGroups', 'eg');
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(path.join(dir, 'commerce.yaml'), text);
}

function writeConcept(id: string, displayName = id): void {
  const entry = {
    name: `${GROUP}/entries/${id}`,
    entryType: DOC_TYPE,
    entrySource: {displayName},
    aspects: {
      'dataplex-types.global.overview': {
        data: {content: `# ${displayName}\n`, contentType: 'MARKDOWN'},
      },
    },
  } as gcp.Entry;
  const file = path.join(root, 'bundle', `${id}.md`);
  fs.mkdirSync(path.dirname(file), {recursive: true});
  fs.writeFileSync(file, conceptToFileContent(entryToConcept(entry, id)), 'utf8');
}

async function createSplitLayout(): Promise<SplitLayout> {
  const l = new SplitLayout(
    new SemanticModelLayout(path.join(root, 'catalog'), 'eg'),
    new OkfLayout(path.join(root, 'bundle'), GROUP),
  );
  await l.init();
  return l;
}

function doc(name: string): md.Entry {
  return {
    name,
    type: 'dataplex-types.global.document',
    resource: {displayName: name},
    aspects: {'dataplex-types.global.overview': {content: `# ${name}\n`}},
  };
}

describe('SplitLayout', () => {
  test('init() indexes both halves without parsing the model YAML', async () => {
    // Even if the model file is unparseable YAML, init() only globs for file
    // paths and must not parse it before pull/push loads the SQL parser.
    writeModel('not: [valid: yaml\n');
    writeConcept('policies/revenue', 'Revenue Policy');

    const l = await createSplitLayout();
    expect(l.semantic.modelDocuments().map(d => d.name)).toEqual(['commerce']);
    expect(l.listEntries()).toEqual(['policies/revenue']);
  });

  test('forwards entryExists, listEntries, loadEntry, saveEntry, and deleteEntry to okf', async () => {
    writeConcept('policies/revenue', 'Revenue Policy');
    const l = await createSplitLayout();

    expect(l.entryExists('policies/revenue')).toBe(true);
    expect(l.entryExists('policies/missing')).toBe(false);
    expect(l.listEntries()).toEqual(['policies/revenue']);

    const loaded = await l.loadEntry('policies/revenue');
    expect(loaded.type).toBe('dataplex-types.global.document');
    expect(loaded.resource.displayName).toBe('Revenue Policy');
    expect(loaded.aspects?.['dataplex-types.global.overview']?.content).toContain(
      '# Revenue Policy',
    );

    await l.saveEntry('policies/new', doc('policies/new'));
    expect(fs.existsSync(path.join(root, 'bundle', 'policies', 'new.md'))).toBe(
      true,
    );
    expect(l.entryExists('policies/new')).toBe(true);
    expect(l.listEntries()).toEqual(['policies/new', 'policies/revenue']);

    await l.deleteEntry('policies/new');
    expect(fs.existsSync(path.join(root, 'bundle', 'policies', 'new.md'))).toBe(
      false,
    );
    expect(l.entryExists('policies/new')).toBe(false);
  });
});
