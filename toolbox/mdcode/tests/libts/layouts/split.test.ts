// Tests for the split layout (src/libts/layouts/split.ts): one workspace
// holding a semantic model in OSI+G and the rest of a context set as an OKF
// bundle, with entries routed between the two halves.

import {afterEach, beforeEach, describe, expect, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as gcp from '../../../src/libts/gcp';
import {OkfLayout} from '../../../src/libts/layouts/okf';
import {SemanticModelLayout} from '../../../src/libts/layouts/semantic-model';
import {SplitLayout} from '../../../src/libts/layouts/split';
import * as md from '../../../src/libts/metadata';
import {conceptToFileContent} from '../../../src/libts/okf/concept';
import {entryToConcept} from '../../../src/libts/okf/entry_to_concept';

const SCOPE = {project: 'test-project', location: 'us'};
const GROUP = 'projects/test-project/locations/us/entryGroups/eg';
const DOC_TYPE = 'projects/dataplex-types/locations/global/entryTypes/document';
const ORDERS_TABLE =
    'bigquery.googleapis.com/projects/test-project/datasets/sales/tables/orders';

const MODEL = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    description: Orders.
    entities:
      - name: orders
        source: ${ORDERS_TABLE}
        primary_key: [order_id]
        description: One row per order.
        fields:
          - name: order_id
            expression: order_id
            datatype: Integer
          - name: amount
            expression: amount
            datatype: Float
    metrics:
      - name: revenue
        expression: SUM(orders.amount)
        datatype: Float
`;

let root: string;
let savedV2: string|undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-split-'));
  savedV2 = process.env.KC_V2_ASPECTS;
  delete process.env.KC_V2_ASPECTS;
});

afterEach(() => {
  fs.rmSync(root, {recursive: true, force: true});
  if (savedV2 === undefined) delete process.env.KC_V2_ASPECTS;
  else process.env.KC_V2_ASPECTS = savedV2;
});

function writeModel(text = MODEL): void {
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

async function layout(): Promise<SplitLayout> {
  const l = new SplitLayout(
      new SemanticModelLayout(path.join(root, 'catalog'), 'eg', SCOPE),
      new OkfLayout(path.join(root, 'bundle'), GROUP));
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

describe('listing', () => {
  test('gives the model first, then the bundle', async () => {
    writeModel();
    writeConcept('policies/revenue');
    writeConcept('tables/orders_doc');

    const names = (await layout()).listEntries();
    // The model's anchor leads, in the order its view gives.
    expect(names[0]).toBe('commerce');
    expect(names).toContain('commerce.entities.orders');
    // The bundle's concepts follow, after every semantic name.
    expect(names.indexOf('policies/revenue'))
        .toBeGreaterThan(names.lastIndexOf('commerce.metrics.revenue'));
    expect(names).toContain('tables/orders_doc');
  });

  test('either half alone works', async () => {
    writeConcept('policies/revenue');
    expect((await layout()).listEntries()).toEqual(['policies/revenue']);

    fs.rmSync(path.join(root, 'bundle'), {recursive: true, force: true});
    writeModel();
    expect((await layout()).listEntries()).toContain('commerce');
  });
});

describe('reading', () => {
  test('routes each name to the half that holds it', async () => {
    writeModel();
    writeConcept('policies/revenue');
    const l = await layout();

    expect((await l.loadEntry('commerce.entities.orders')).type)
        .toContain('semantic-entity');
    expect((await l.loadEntry('policies/revenue')).type)
        .toBe('dataplex-types.global.document');
    expect(l.entryExists('commerce')).toBe(true);
    expect(l.entryExists('policies/revenue')).toBe(true);
    expect(l.entryExists('nope')).toBe(false);
  });
});

describe('saving', () => {
  test('routes by the entry\'s declared type', async () => {
    writeModel();
    const l = await layout();

    await l.saveEntry('policies/new', doc('policies/new'));
    expect(fs.existsSync(path.join(root, 'bundle', 'policies', 'new.md')))
        .toBe(true);

    const entity = await l.loadEntry('commerce.entities.orders');
    entity.resource.description = 'Edited by the split layout.';
    await l.saveEntry('commerce.entities.orders', entity);
    const model = fs.readFileSync(
        path.join(root, 'catalog', 'EntryGroups', 'eg', 'commerce.yaml'), 'utf8');
    expect(model).toContain('Edited by the split layout.');
  });

  test('a save reaching the other half\'s name is refused', async () => {
    writeModel();
    writeConcept('commerce.entities.orders');
    const l = await layout();

    const [result] = await l.saveEntries([doc('commerce.entities.orders')]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('already an element of the semantic model');
  });

  test('results come back in input order, across both halves', async () => {
    writeModel();
    const l = await layout();
    const entity = await l.loadEntry('commerce.entities.orders');
    entity.resource.description = 'Changed.';

    const results = await l.saveEntries([
      doc('a'),
      entity,
      doc('b/c'),
    ]);

    expect(results.map(r => [r.name, r.ok])).toEqual([
      ['a', true],
      ['commerce.entities.orders', true],
      ['b/c', true],
    ]);
  });

  test('one half failing leaves the other half applied', async () => {
    writeModel();
    const l = await layout();

    const results = await l.saveEntries([
      doc('good'),
      // The model refuses an element name it cannot spell.
      {
        name: 'Not A Valid Name!',
        type: 'dataplex-types.global.semantic-entity',
        resource: {},
      },
    ]);

    expect(results[0].ok).toBe(true);
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toContain('is not valid');
    expect(fs.existsSync(path.join(root, 'bundle', 'good.md'))).toBe(true);
  });
});

describe('deleting', () => {
  test('routes by the half that holds the name', async () => {
    writeModel();
    writeConcept('policies/revenue');
    const l = await layout();

    const results = await l.deleteEntries([
      'policies/revenue',
      'commerce.metrics.revenue',
    ]);
    expect(results.map(r => r.ok)).toEqual([true, true]);
    expect(fs.existsSync(path.join(root, 'bundle', 'policies', 'revenue.md')))
        .toBe(false);
  });

  test('an unknown name is answered here, not by a half', async () => {
    writeModel();
    const l = await layout();
    const [result] = await l.deleteEntries(['nope']);

    expect(result).toEqual({name: 'nope', ok: false, error: 'Entry not found: nope'});
  });

  // Deleting only the model element would leave the concept to recreate it.
  test('a name both halves hold is refused, not guessed', async () => {
    writeModel();
    writeConcept('commerce.entities.orders');
    const l = await layout();

    const [result] = await l.deleteEntries(['commerce.entities.orders']);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('both an element of the semantic model');
    expect(fs.existsSync(
               path.join(root, 'bundle', 'commerce.entities.orders.md')))
        .toBe(true);
  });
});

describe('collisions', () => {
  test('listing warns, and a read takes the model\'s copy', async () => {
    writeModel();
    writeConcept('commerce.entities.orders', 'The concept copy');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const l = await layout();
      // Opening the workspace says nothing: that would read the model file,
      // which pull and push cannot afford before they load the SQL parser.
      expect(warn).not.toHaveBeenCalled();

      l.listEntries();
      expect(warn).toHaveBeenCalled();
      expect(String(warn.mock.calls[0][0]))
          .toContain('commerce.entities.orders');
      // The model's copy is an entity, not the concept's document.
      expect((await l.loadEntry('commerce.entities.orders')).type)
          .toContain('semantic-entity');
      // And it is listed once.
      const listed = l.listEntries().filter(n => n === 'commerce.entities.orders');
      expect(listed).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test('no warning when the halves are disjoint', async () => {
    writeModel();
    writeConcept('policies/revenue');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      (await layout()).listEntries();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  test('warns once, however many times the entries are listed', async () => {
    writeModel();
    writeConcept('commerce.entities.orders');
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const l = await layout();
      l.listEntries();
      l.listEntries();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});
