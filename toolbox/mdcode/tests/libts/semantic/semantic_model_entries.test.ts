// Tests for the SemanticModel layout's entry methods
// (src/libts/layouts/semantic-model.ts, src/libts/semantic/model_entries.ts,
// src/libts/semantic/model_edits.ts): the model file shown as the entries push
// would write for it, plus one `semantic-relationship` entry per relationship,
// named by bare entry IDs, and saves that edit the model file.

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {SemanticModelLayout} from '../../../src/libts/layouts/semantic-model';
import {diffLines} from '../../../src/libts/semantic/text_merge';

const SCOPE = {project: 'test-project', location: 'us'};
const ORDERS_TABLE =
    'bigquery.googleapis.com/projects/test-project/datasets/sales/tables/orders';
const CUSTOMERS_TABLE =
    'bigquery.googleapis.com/projects/test-project/datasets/sales/tables/customers';
const GRAPH =
    'bigquery.googleapis.com/projects/test-project/datasets/sales/propertyGraphs/commerce';

// One model with two entities, a metric, and three relationships push would
// not all link: two between the same pair, and one from an entity to itself
// with no join columns.
const MODEL = `version: "0.2.0.dev0/google"
# The commerce model.
semantic_model:
  - name: commerce
    description: Orders and customers.
    ai_context:
      instructions: Use for order questions.
    deployments:
      - name: graph
        target: ${GRAPH}
    entities:
      - name: orders
        source: ${ORDERS_TABLE}
        primary_key: [order_id]
        description: One row per order.
        fields:
          # The order key.
          - name: order_id
            expression: order_id
            datatype: Integer
          - name: customer_id
            expression: customer_id
            datatype: Integer
          - name: amount
            expression: amount
            datatype: Float
          - name: order_date
            expression: order_date
            datatype: Date
            dimension:
              is_time: true
      - name: customers
        source: ${CUSTOMERS_TABLE}
        primary_key: [customer_id]
        fields:
          - name: customer_id
            expression: customer_id
            datatype: Integer
          - name: name
            expression: name
            datatype: String
            label: Customer name
    relationships:
      - name: orders_to_customers
        from: orders
        to: customers
        from_columns: [customer_id]
        to_columns: [customer_id]
      - name: orders_to_customers_again
        from: orders
        to: customers
        from_columns: [customer_id]
        to_columns: [customer_id]
      - name: orders_self
        from: orders
        to: orders
    metrics:
      - name: revenue
        expression: SUM(orders.amount)
        datatype: Float
        description: Total order revenue.
`;

const ANCHOR_ONLY = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    description: Orders and customers.
    ai_context: Use for order questions.
    entities: []
`;

let root: string;
let catalogPath: string;
let savedV2: string|undefined;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-entries-'));
  catalogPath = path.join(root, 'catalog');
  savedV2 = process.env.KC_V2_ASPECTS;
  delete process.env.KC_V2_ASPECTS;
});

afterEach(() => {
  fs.rmSync(root, {recursive: true, force: true});
  if (savedV2 === undefined) {
    delete process.env.KC_V2_ASPECTS;
  } else {
    process.env.KC_V2_ASPECTS = savedV2;
  }
});

function groupDir(): string {
  return path.join(catalogPath, 'EntryGroups', 'eg');
}

function writeModel(text: string, file = 'commerce.yaml'): string {
  fs.mkdirSync(groupDir(), {recursive: true});
  const p = path.join(groupDir(), file);
  fs.writeFileSync(p, text);
  return p;
}

async function layout(scope = SCOPE): Promise<SemanticModelLayout> {
  const l = new SemanticModelLayout(catalogPath, 'eg', scope);
  await l.init();
  return l;
}

describe('SemanticModelLayout entry view', () => {
  test('lists the entries push writes, and every relationship', async () => {
    writeModel(MODEL);
    const l = await layout();
    expect(l.listEntries()).toEqual([
      'commerce',
      'commerce.entities.orders',
      'commerce.entities.customers',
      'commerce.metrics.revenue',
      'commerce.relationships.orders_to_customers',
      'commerce.relationships.orders_to_customers_again',
      'commerce.relationships.orders_self',
    ]);
    expect(l.entryExists('commerce.entities.orders')).toBe(true);
    expect(l.entryExists('orders')).toBe(false);
  });

  test('names entries with the second-generation layout', async () => {
    process.env.KC_V2_ASPECTS = '1';
    writeModel(MODEL);
    const l = await layout();
    expect(l.listEntries()).toEqual([
      'commerce',
      'commerce/entities/orders',
      'commerce/entities/customers',
      'commerce/metrics/revenue',
      'commerce/relationships/orders_to_customers',
      'commerce/relationships/orders_to_customers_again',
      'commerce/relationships/orders_self',
    ]);
  });

  test('reads the anchor', async () => {
    writeModel(MODEL);
    const l = await layout();
    expect(await l.loadEntry('commerce')).toEqual({
      name: 'commerce',
      type: 'dataplex-types.global.semantic-model',
      resource: {displayName: 'commerce', description: 'Orders and customers.'},
      aspects: {
        'dataplex-types.global.semantic-model': {deploymentTargets: [GRAPH]},
        'dataplex-types.global.guidelines':
            {instructions: 'Use for order questions.', userManaged: true},
      },
    });
  });

  test('reads an entity with its field expressions', async () => {
    writeModel(MODEL);
    const l = await layout();
    const entity = await l.loadEntry('commerce.entities.customers');
    expect(entity).toEqual({
      name: 'commerce.entities.customers',
      type: 'dataplex-types.global.semantic-entity',
      resource: {displayName: 'customers', parent: 'commerce'},
      aspects: {
        'dataplex-types.global.semantic-entity':
            {source: {resources: [CUSTOMERS_TABLE]}},
        'dataplex-types.global.schema': {
          fields: [
            {
              name: 'customer_id',
              dataType: 'INT64',
              metadataType: 'NUMBER',
              semantics: {expression: 'customer_id', role: 'DEFAULT'},
            },
            {
              name: 'name',
              dataType: 'STRING',
              metadataType: 'STRING',
              annotations: {label: 'Customer name'},
              semantics: {expression: 'name', role: 'DEFAULT'},
            },
          ],
          primaryKey: {fields: ['customer_id']},
        },
      },
    });
  });

  test('reads a metric with its expression', async () => {
    writeModel(MODEL);
    const l = await layout();
    expect(await l.loadEntry('commerce.metrics.revenue')).toEqual({
      name: 'commerce.metrics.revenue',
      type: 'dataplex-types.global.semantic-metric',
      resource: {
        displayName: 'revenue',
        description: 'Total order revenue.',
        parent: 'commerce',
      },
      aspects: {
        'dataplex-types.global.semantic-metric': {
          entity: 'orders',
          dataType: 'FLOAT64',
          expression: 'SUM(orders.amount)',
        },
      },
    });
  });

  test('reads relationships, bound and unbound', async () => {
    writeModel(MODEL);
    const l = await layout();
    const aspect = 'dataplex-types.global.semantic-relationship';
    const bound = await l.loadEntry('commerce.relationships.orders_to_customers');
    expect(bound.type).toBe(aspect);
    expect(bound.resource).toEqual(
        {displayName: 'orders_to_customers', parent: 'commerce'});
    expect(bound.aspects?.[aspect]).toEqual({
      source: {name: 'orders', fields: ['customer_id']},
      target: {name: 'customers', fields: ['customer_id']},
    });
    const self = await l.loadEntry('commerce.relationships.orders_self');
    expect(self.aspects?.[aspect])
        .toEqual({source: {name: 'orders'}, target: {name: 'orders'}});
  });

  test('gives a copy, so a caller cannot change the view', async () => {
    writeModel(MODEL);
    const l = await layout();
    const first = await l.loadEntry('commerce');
    first.resource.description = 'changed';
    expect((await l.loadEntry('commerce')).resource.description)
        .toBe('Orders and customers.');
  });

  test('reads the model file again when it changes', async () => {
    const p = writeModel(MODEL);
    const l = await layout();
    expect(l.entryExists('commerce.metrics.order_count')).toBe(false);
    fs.writeFileSync(
        p,
        MODEL + '      - name: order_count\n' +
            '        expression: COUNT(orders.order_id)\n');
    expect(l.entryExists('commerce.metrics.order_count')).toBe(true);
  });

  test('an unknown name fails to load', async () => {
    writeModel(MODEL);
    const l = await layout();
    await expect(l.loadEntry('orders')).rejects.toThrow(/does not exist/);
  });

  test('an anchor-only model file shows its anchor alone', async () => {
    writeModel(ANCHOR_ONLY);
    const l = await layout();
    expect(l.listEntries()).toEqual(['commerce']);
    expect(await l.loadEntry('commerce')).toEqual({
      name: 'commerce',
      type: 'dataplex-types.global.semantic-model',
      resource: {displayName: 'commerce', description: 'Orders and customers.'},
      aspects: {
        'dataplex-types.global.semantic-model': {},
        'dataplex-types.global.guidelines':
            {instructions: 'Use for order questions.', userManaged: true},
      },
    });
  });

  test('an empty entry group has no entries', async () => {
    const l = await layout();
    expect(l.listEntries()).toEqual([]);
    expect(l.entryExists('commerce')).toBe(false);
  });

  test('a model file that does not load fails with the loader message',
       async () => {
         writeModel(MODEL.replace('to: customers\n', 'to: suppliers\n'));
         const l = await layout();
         expect(() => l.listEntries()).toThrow(/suppliers/);
       });

  test('two model files in the entry group fail', async () => {
    writeModel(MODEL);
    writeModel(MODEL.replace('name: commerce', 'name: other'), 'other.yaml');
    const l = await layout();
    expect(() => l.listEntries()).toThrow(/2 model files \(commerce, other\)/);
  });

  test('without a scope, the entry methods cannot name entries', async () => {
    writeModel(MODEL);
    const l = new SemanticModelLayout(catalogPath, 'eg');
    await l.init();
    expect(() => l.listEntries()).toThrow(/cannot name entries/);
  });
});

// Entries for new elements, as `kcmd entry get` prints them.
const SYS = 'dataplex-types.global';
const ANCHOR = {
  name: 'commerce',
  type: `${SYS}.semantic-model`,
  resource: {displayName: 'commerce', description: 'Orders and customers.'},
  aspects: {[`${SYS}.guidelines`]: {instructions: 'Use for order questions.'}},
};

function entityEntry(
    name: string, table: string, fields: string[], description?: string) {
  return {
    name,
    type: `${SYS}.semantic-entity`,
    resource: {displayName: name, ...(description ? {description} : {})},
    aspects: {
      [`${SYS}.semantic-entity`]: {source: {resources: [table]}},
      [`${SYS}.schema`]: {
        fields: fields.map(f => ({
                             name: f,
                             dataType: 'INT64',
                             semantics: {expression: f},
                           })),
        primaryKey: {fields: [fields[0]]},
      },
    },
  };
}

function metricEntry(name: string, expression: string) {
  return {
    name,
    type: `${SYS}.semantic-metric`,
    resource: {},
    aspects: {[`${SYS}.semantic-metric`]: {expression, dataType: 'INT64'}},
  };
}

function joinEntry(name: string, from: string, to: string, column: string) {
  return {
    name,
    type: `${SYS}.semantic-relationship`,
    resource: {},
    aspects: {
      [`${SYS}.semantic-relationship`]: {
        source: {name: from, fields: [column]},
        target: {name: to, fields: [column]},
      },
    },
  };
}

const TABLES = 'bigquery.googleapis.com/projects/test-project/datasets/sales/tables';
const ORDERS = entityEntry(
    'orders', `${TABLES}/orders`, ['order_id', 'customer_id', 'amount'],
    'One row per order.');
const CUSTOMERS =
    entityEntry('customers', `${TABLES}/customers`, ['customer_id']);
const PRODUCTS = entityEntry('products', `${TABLES}/products`, ['product_id']);
const REVENUE = metricEntry('revenue', 'SUM(orders.amount)');
const ORDER_COUNT = metricEntry('order_count', 'COUNT(orders.order_id)');
const JOIN = joinEntry('orders_to_customers', 'orders', 'customers', 'customer_id');

describe('SemanticModelLayout saveEntries: new elements', () => {
  test('creates a model in an empty entry group in one call', async () => {
    const l = await layout();
    expect(await l.saveEntries([ANCHOR, ORDERS, CUSTOMERS, REVENUE, JOIN]))
        .toEqual([
          {name: 'commerce', ok: true},
          {name: 'commerce.entities.orders', ok: true},
          {name: 'commerce.entities.customers', ok: true},
          {name: 'commerce.metrics.revenue', ok: true},
          {name: 'commerce.relationships.orders_to_customers', ok: true},
        ]);
    const text = fs.readFileSync(path.join(groupDir(), 'commerce.yaml'), 'utf8');
    expect(text.startsWith('version: "0.2.0.dev0/google"\n')).toBe(true);

    const reopened = await layout();
    expect(reopened.listEntries()).toEqual([
      'commerce',
      'commerce.entities.orders',
      'commerce.entities.customers',
      'commerce.metrics.revenue',
      'commerce.relationships.orders_to_customers',
    ]);
    // Each entry comes back as sent, with what the view adds.
    const orders = await reopened.loadEntry('commerce.entities.orders');
    expect(orders.resource).toEqual(
        {displayName: 'orders', description: 'One row per order.', parent: 'commerce'});
    expect(orders.aspects?.[`${SYS}.schema`].fields[0]).toEqual({
      name: 'order_id',
      dataType: 'INT64',
      metadataType: 'NUMBER',
      semantics: {expression: 'order_id', role: 'DEFAULT'},
    });
    expect((await reopened.loadEntry('commerce.metrics.revenue')).aspects)
        .toEqual({
          [`${SYS}.semantic-metric`]: {
            entity: 'orders',
            dataType: 'INT64',
            expression: 'SUM(orders.amount)',
          },
        });
  });

  test('the anchor alone makes an anchor-only model file', async () => {
    const l = await layout();
    expect(await l.saveEntries([ANCHOR])).toEqual([{name: 'commerce', ok: true}]);
    const reopened = await layout();
    expect(reopened.listEntries()).toEqual(['commerce']);
    expect(await reopened.saveEntries([ORDERS])).toEqual(
        [{name: 'commerce.entities.orders', ok: true}]);
  });

  test('appends to a model and keeps the rest of the file as written', async () => {
    const original = MODEL.replace(
        'primary_key: [order_id]', 'primary_key: [ order_id ]  # the grain');
    const p = writeModel(original);
    const l = await layout();
    expect(await l.saveEntries([PRODUCTS, ORDER_COUNT])).toEqual([
      {name: 'commerce.entities.products', ok: true},
      {name: 'commerce.metrics.order_count', ok: true},
    ]);
    const text = fs.readFileSync(p, 'utf8');
    // Lines were only added.
    expect(diffLines(original.split('\n'), text.split('\n'))
               .every(h => h.start === h.end))
        .toBe(true);
    expect(l.listEntries()).toContain('commerce.entities.products');
  });

  test('a failed item is not written and the others are', async () => {
    const p = writeModel(MODEL);
    const l = await layout();
    const results = await l.saveEntries([
      PRODUCTS,
      joinEntry('orders_to_suppliers', 'orders', 'suppliers', 'customer_id'),
      ORDER_COUNT,
    ]);
    expect(results[0]).toEqual({name: 'commerce.entities.products', ok: true});
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toContain("'suppliers'");
    expect(results[2]).toEqual({name: 'commerce.metrics.order_count', ok: true});
    const text = fs.readFileSync(p, 'utf8');
    expect(text).toContain('name: products');
    expect(text).toContain('name: order_count');
    expect(text).not.toContain('orders_to_suppliers');
  });

  test('an item that needs a failed item fails too, and nothing is written',
       async () => {
         const p = writeModel(MODEL);
         const before = fs.readFileSync(p, 'utf8');
         const l = await layout();
         const badEntity = entityEntry('suppliers', `${TABLES}/suppliers`, []);
         const results = await l.saveEntries([
           badEntity,
           joinEntry('orders_to_suppliers', 'orders', 'suppliers', 'customer_id'),
         ]);
         expect(results.map(r => r.ok)).toEqual([false, false]);
         expect(fs.readFileSync(p, 'utf8')).toBe(before);
       });

  test('an item that adds a push check error fails', async () => {
    writeModel(MODEL);
    const l = await layout();
    const [result] = await l.saveEntries([
      entityEntry('products', `${TABLES}/products`, ['product_id'], 'x'.repeat(2001)),
    ]);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('2000');
  });

  test('a model that already fails a push check takes a save that does not touch it',
       async () => {
         writeModel(MODEL.replace(
             'description: One row per order.',
             `description: ${'x'.repeat(2001)}`));
         const l = await layout();
         expect(await l.saveEntries([PRODUCTS])).toEqual(
             [{name: 'commerce.entities.products', ok: true}]);
       });

  test('an element that would not come back as sent fails, naming the value',
       async () => {
         writeModel(MODEL);
         const l = await layout();
         const typo = structuredClone(PRODUCTS);
         typo.aspects[`${SYS}.schema`].fields[0].dataType = 'INTEGER';
         const extra = structuredClone(PRODUCTS) as any;
         extra.name = extra.resource.displayName = 'items';
         extra.aspects[`${SYS}.overview`] = {content: 'hello'};
         const results = await l.saveEntries([typo, extra]);
         expect(results[0].error).toBe(
             `aspects.${SYS}.schema.fields[0].dataType: "INTEGER" would be ` +
             'saved as "STRING"');
         expect(results[1].error).toBe(
             `aspects.${SYS}.overview: {"content":"hello"} would be saved as nothing`);
       });

  test('a name that is not an entry and not an element name fails', async () => {
    writeModel(MODEL);
    const l = await layout();
    const [dotted, invalid] = await l.saveEntries([
      {...PRODUCTS, name: 'commerce.entities.products'},
      {...PRODUCTS, name: 'my-products', resource: {}},
    ]);
    expect(dotted.error).toContain('is not an entry of the model');
    expect(invalid.error).toContain("Entity name 'my-products' is not valid");
  });

  test('an existing element, a second model and a child before its anchor fail',
       async () => {
         writeModel(MODEL);
         const l = await layout();
         const [twin, second] = await l.saveEntries([
           {...ORDERS, name: 'customers', resource: {displayName: 'customers'}},
           {...ANCHOR, name: 'other', resource: {displayName: 'other'}},
         ]);
         expect(twin.error).toBe("model 'commerce' already has entity 'customers'");
         expect(second.error).toContain("already holds model 'commerce'");

         fs.rmSync(groupDir(), {recursive: true});
         const empty = await layout();
         const [orphan] = await empty.saveEntries([ORDERS]);
         expect(orphan.error).toContain("save the model's anchor entry");
       });

  test('a renaming display name and an action fail', async () => {
    writeModel(MODEL);
    const l = await layout();
    const results = await l.saveEntries([
      {...PRODUCTS, resource: {displayName: 'items'}},
      {name: 'refund', type: 'test-project.global.semantic-action', resource: {}},
    ]);
    expect(results[0].error).toContain('renaming is not supported');
    expect(results[1].error).toContain('semantic-action entries is not supported');
  });

  test('names created entries with the second-generation layout', async () => {
    process.env.KC_V2_ASPECTS = '1';
    writeModel(MODEL);
    const l = await layout();
    expect(await l.saveEntries([PRODUCTS])).toEqual(
        [{name: 'commerce/entities/products', ok: true}]);
  });

  test('appends an entity to a vanilla model file under datasets', async () => {
    const p = writeModel(`version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    datasets:
      - name: orders
        source: ${ORDERS_TABLE}
        primary_key: [order_id]
        fields:
          - name: order_id
            expression:
              dialects:
                - dialect: ANSI_SQL
                  expression: order_id
`);
    const l = await layout();
    expect(await l.saveEntries([PRODUCTS])).toEqual(
        [{name: 'commerce.entities.products', ok: true}]);
    const text = fs.readFileSync(p, 'utf8');
    expect(text).not.toContain('entities:');
    expect(text).toContain('      - name: products');
  });
});

describe('SemanticModelLayout saveEntries: updates in place', () => {
  async function entriesOf(l: SemanticModelLayout) {
    const out = [];
    for (const name of l.listEntries()) out.push(await l.loadEntry(name));
    return out;
  }

  for (const v2 of [false, true]) {
    test(`saving every entry as get gives it writes nothing${v2 ? ' (V2)' : ''}`,
         async () => {
           if (v2) process.env.KC_V2_ASPECTS = '1';
           const p = writeModel(MODEL);
           const mtime = fs.statSync(p).mtimeMs;
           const l = await layout();
           const entries = await entriesOf(l);
           const results = await l.saveEntries(entries);
           expect(results).toEqual(entries.map(e => ({name: e.name, ok: true})));
           expect(fs.readFileSync(p, 'utf8')).toBe(MODEL);
           expect(fs.statSync(p).mtimeMs).toBe(mtime);
         });
  }

  test('changes only the lines of the values that change', async () => {
    const p = writeModel(MODEL);
    const l = await layout();
    const orders = await l.loadEntry('commerce.entities.orders');
    orders.resource.description = 'One row per placed order.';
    orders.aspects![`${SYS}.schema`].fields.push({
      name: 'status',
      dataType: 'STRING',
      metadataType: 'STRING',
      semantics: {expression: 'status'},
    });
    expect(await l.saveEntries([orders])).toEqual(
        [{name: 'commerce.entities.orders', ok: true}]);
    const text = fs.readFileSync(p, 'utf8');
    const hunks = diffLines(MODEL.split('\n'), text.split('\n'));
    expect(hunks.map(h => [MODEL.split('\n').slice(h.start, h.end), h.lines]))
        .toEqual([
          [['        description: One row per order.'],
           ['        description: One row per placed order.']],
          [[], [
            '          - name: status',
            '            expression: status',
            '            datatype: String',
          ]],
        ]);
  });

  test('a field a metric reads cannot be removed; another can', async () => {
    writeModel(MODEL);
    const l = await layout();
    const orders = await l.loadEntry('commerce.entities.orders');
    const schema = orders.aspects![`${SYS}.schema`];
    const withoutAmount = structuredClone(orders);
    withoutAmount.aspects![`${SYS}.schema`].fields =
        schema.fields.filter((f: any) => f.name !== 'amount');
    const [refused] = await l.saveEntries([withoutAmount]);
    expect(refused.ok).toBe(false);
    expect(refused.error).toContain('amount');

    schema.fields = schema.fields.filter((f: any) => f.name !== 'order_date');
    expect(await l.saveEntries([orders])).toEqual(
        [{name: 'commerce.entities.orders', ok: true}]);
    expect(l.listEntries()).toContain('commerce.entities.orders');
    expect((await l.loadEntry('commerce.entities.orders'))
               .aspects![`${SYS}.schema`].fields.map((f: any) => f.name))
        .toEqual(['order_id', 'customer_id', 'amount']);
  });

  test('a new expression replaces the BIGQUERY entry and keeps the others',
       async () => {
         const p = writeModel(MODEL.replace(
             '          - name: amount\n            expression: amount\n',
             '          - name: amount\n            expression:\n' +
                 '              dialects:\n' +
                 '                - dialect: SNOWFLAKE\n' +
                 '                  expression: AMOUNT\n' +
                 '                - dialect: BIGQUERY\n' +
                 '                  expression: amount\n'));
         const l = await layout();
         const orders = await l.loadEntry('commerce.entities.orders');
         const amount = orders.aspects![`${SYS}.schema`].fields.find(
             (f: any) => f.name === 'amount');
         amount.semantics.expression = 'amount / 100';
         expect((await l.saveEntries([orders]))[0].ok).toBe(true);
         const text = fs.readFileSync(p, 'utf8');
         expect(text).toContain(
             '                - dialect: SNOWFLAKE\n' +
             '                  expression: AMOUNT\n' +
             '                - dialect: BIGQUERY\n' +
             '                  expression: amount / 100\n');
       });

  test('a dimension keeps is_time, and the DEFAULT role removes it', async () => {
    const p = writeModel(MODEL);
    const l = await layout();
    const fieldOf = (e: any) => e.aspects[`${SYS}.schema`].fields.find(
        (f: any) => f.name === 'order_date');
    const orders = await l.loadEntry('commerce.entities.orders');
    fieldOf(orders).description = 'The day the order was placed.';
    expect((await l.saveEntries([orders]))[0].ok).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toContain('            dimension:\n              is_time: true\n');

    const again = await l.loadEntry('commerce.entities.orders');
    fieldOf(again).semantics.role = 'DEFAULT';
    expect((await l.saveEntries([again]))[0].ok).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).not.toContain('dimension:');
  });

  test('updates a metric; an entity its expression contradicts fails', async () => {
    const p = writeModel(MODEL);
    const l = await layout();
    const revenue = await l.loadEntry('commerce.metrics.revenue');
    const aspect = revenue.aspects![`${SYS}.semantic-metric`];
    aspect.expression = 'SUM(orders.amount) * 2';
    expect((await l.saveEntries([revenue]))[0].ok).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toContain('expression: SUM(orders.amount) * 2');

    aspect.entity = 'customers';
    const [result] = await l.saveEntries([revenue]);
    expect(result.error).toBe(
        `aspects.${SYS}.semantic-metric.entity: "customers" would be saved as "orders"`);
  });

  test('updates a relationship\'s columns, description and synonyms', async () => {
    const p = writeModel(MODEL);
    const l = await layout();
    const join = await l.loadEntry('commerce.relationships.orders_self');
    join.resource.description = 'An order and itself.';
    const aspect = join.aspects![`${SYS}.semantic-relationship`];
    aspect.source.fields = ['order_id'];
    aspect.target.fields = ['order_id'];
    aspect.synonyms = ['same order'];
    expect((await l.saveEntries([join]))[0].ok).toBe(true);
    expect(fs.readFileSync(p, 'utf8')).toContain(
        '      - name: orders_self\n' +
        '        from: orders\n' +
        '        to: orders\n' +
        '        from_columns: [order_id]\n' +
        '        to_columns: [order_id]\n' +
        '        description: An order and itself.\n' +
        '        ai_context:\n' +
        '          synonyms: [same order]\n');
  });

  test('updates the anchor; a deployment whose target stays keeps its name',
       async () => {
         const p = writeModel(MODEL);
         const l = await layout();
         const anchor = await l.loadEntry('commerce');
         anchor.resource.description = 'Orders, customers and revenue.';
         expect((await l.saveEntries([anchor]))[0].ok).toBe(true);
         let text = fs.readFileSync(p, 'utf8');
         expect(text).toContain('    description: Orders, customers and revenue.\n');
         expect(text).toContain(`      - name: graph\n        target: ${GRAPH}\n`);

         const other = GRAPH.replace('/commerce', '/commerce_v2');
         anchor.aspects![`${SYS}.semantic-model`].deploymentTargets = [other];
         expect((await l.saveEntries([anchor]))[0].ok).toBe(true);
         text = fs.readFileSync(p, 'utf8');
         expect(text).toContain(`      - name: default\n        target: ${other}\n`);
         expect(text).not.toContain('name: graph');
       });

  test('an update that leaves out an aspect the view gives fails', async () => {
    const p = writeModel(MODEL);
    const l = await layout();
    const orders = await l.loadEntry('commerce.entities.orders');
    delete orders.aspects![`${SYS}.schema`];
    const [result] = await l.saveEntries([orders]);
    expect(result.error).toContain('the schema aspect is missing');
    expect(fs.readFileSync(p, 'utf8')).toBe(MODEL);
  });

  test('a rename and an entity that uses extends fail', async () => {
    writeModel(MODEL.replace(
        '    relationships:\n',
        '      - name: vip_customers\n' +
            '        extends: [customers]\n' +
            `        source: ${CUSTOMERS_TABLE.replace('customers', 'vips')}\n` +
            '    relationships:\n'));
    const l = await layout();
    const orders = await l.loadEntry('commerce.entities.orders');
    orders.resource.displayName = 'purchases';
    const vip = await l.loadEntry('commerce.entities.vip_customers');
    const results = await l.saveEntries([orders, vip]);
    expect(results[0].error).toContain('renaming is not supported');
    expect(results[1].error).toContain('uses extends or abstract');
  });
});

describe('SemanticModelLayout deleteEntries', () => {
  test('deletes elements nothing uses, removing only their lines', async () => {
    const p = writeModel(MODEL);
    const l = await layout();
    expect(await l.deleteEntries([
      'commerce.relationships.orders_self',
      'commerce.metrics.revenue',
    ])).toEqual([
      {name: 'commerce.relationships.orders_self', ok: true},
      {name: 'commerce.metrics.revenue', ok: true},
    ]);
    const text = fs.readFileSync(p, 'utf8');
    expect(diffLines(MODEL.split('\n'), text.split('\n'))
               .every(h => h.lines.length === 0))
        .toBe(true);
    expect(text).not.toContain('orders_self');
    expect(text).not.toContain('metrics:');
    expect(l.listEntries()).not.toContain('commerce.metrics.revenue');
  });

  test('an entity a relationship uses is not deleted', async () => {
    const p = writeModel(MODEL);
    const l = await layout();
    const [result] = await l.deleteEntries(['commerce.entities.customers']);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("'customers'");
    expect(fs.readFileSync(p, 'utf8')).toBe(MODEL);
  });

  test('an entity a metric uses is not deleted; the rest of the call is',
       async () => {
         writeModel(MODEL);
         const l = await layout();
         const results = await l.deleteEntries([
           'commerce.entities.orders',
           'commerce.relationships.orders_to_customers',
           'commerce.relationships.orders_to_customers_again',
           'commerce.relationships.orders_self',
         ]);
         expect(results.map(r => r.ok)).toEqual([false, true, true, true]);
         expect(results[0].error).toContain('orders');
         expect(l.listEntries()).toEqual([
           'commerce',
           'commerce.entities.orders',
           'commerce.entities.customers',
           'commerce.metrics.revenue',
         ]);
       });

  test('an entity goes with what uses it in one call, in any order', async () => {
    writeModel(MODEL);
    const l = await layout();
    const results = await l.deleteEntries([
      'commerce.entities.customers',
      'commerce.relationships.orders_to_customers',
      'commerce.relationships.orders_to_customers_again',
    ]);
    expect(results.every(r => r.ok)).toBe(true);
    expect(l.entryExists('commerce.entities.customers')).toBe(false);
  });

  test('the anchor, an unknown entry and an element name are not deleted',
       async () => {
         writeModel(MODEL);
         const l = await layout();
         const [anchor, unknown, bare] = await l.deleteEntries(
             ['commerce', 'commerce.entities.suppliers', 'orders']);
         expect(anchor.error).toContain('anchor entry is not supported');
         expect(unknown.error).toContain('does not exist');
         expect(bare.error).toContain('does not exist');
       });

  test('deleting the last entity leaves an anchor-only model', async () => {
    const p = writeModel(ANCHOR_ONLY.replace(
        '    entities: []\n',
        '    entities:\n' +
            '      - name: orders\n' +
            `        source: ${ORDERS_TABLE}\n` +
            '        primary_key: [order_id]\n' +
            '        fields:\n' +
            '          - name: order_id\n' +
            '            expression: order_id\n'));
    const l = await layout();
    expect(await l.deleteEntries(['commerce.entities.orders'])).toEqual(
        [{name: 'commerce.entities.orders', ok: true}]);
    expect(l.listEntries()).toEqual(['commerce']);
    expect(fs.readFileSync(p, 'utf8')).toContain('    entities: []\n');
  });
});
