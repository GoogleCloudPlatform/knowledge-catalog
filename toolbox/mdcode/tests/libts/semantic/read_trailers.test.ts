// The derived description paragraphs that tell an agent how to read an entry
// in BigQuery (read_trailers.ts): `Read through: …` on a bound entity (its
// node view or table, its graph and node label) and `Query: …` on a metric
// (its measures over GRAPH_EXPAND, ready to run). lookup_context renders an
// entry's description and schema only, so these are what make one
// lookup_context call enough to execute. Pull drops both.

import {describe, expect, test} from 'bun:test';

import {generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {ANNOTATION_ASPECT_IDS} from '../../../src/libts/semantic/kc_custom_types';
import {generateCatalogResources, physicalBindings} from '../../../src/libts/semantic/knowledge_catalog';
import {metricQueries, readThroughTrailer, relationshipItems, relationshipsTrailer, splitQueryTrailer, splitReadThroughTrailer, splitRelationshipsTrailer, withQueryTrailer} from '../../../src/libts/semantic/read_trailers';

const OPTS = {project: 'dest', location: 'us', entryGroup: 'eg'};
const ALL = [...ANNOTATION_ASPECT_IDS];
const GRAPH =
    '//bigquery.googleapis.com/projects/data-proj/datasets/sem/propertyGraphs/shop_graph';

function shop(): SemanticModel {
  return {
    name: 'shop',
    description: 'The shop model.',
    customExtensions: [{
      vendorName: 'GOOGLE',
      data: JSON.stringify({deploymentTargets: [GRAPH]}),
    }],
    entities: [
      {
        name: 'Customer',
        dataSource: 'src.sales.customers',
        keys: ['customerId'],
        description: 'A buyer.',
        fields: [
          {name: 'customerId', expression: 'customer_id', type: 'String'},
          {name: 'segment', expression: 'segment', type: 'String'},
        ],
      },
      {
        name: 'Order',
        dataSource: 'src.sales.orders',
        keys: ['orderId'],
        description: 'A purchase.',
        hydration: {grain: {latestBy: 'updated_at'}},
        fields: [
          {name: 'orderId', expression: 'order_id', type: 'String'},
          {name: 'customerId', expression: 'customer_ref', type: 'String'},
          {name: 'amount', expression: 'amount', type: 'Decimal'},
        ],
      },
      {
        name: 'Product',
        dataSource: 'src.sales.products',
        keys: ['productId'],
        mode: 'direct',
        fields: [{name: 'productId', expression: 'product_id', type: 'String'}],
      },
    ],
    relationships: [{
      name: 'placedBy',
      source: {entity: 'Order', columns: ['customer_ref']},
      destination: {entity: 'Customer', columns: ['customer_id']},
    }],
    metrics: [
      {
        name: 'revenue',
        expression: 'SUM(Order.amount)',
        entity: 'Order',
        type: 'Decimal',
        description: 'Gross revenue.\n\nUnit: USD.',
      },
      {
        name: 'aov',
        expression: 'SUM(Order.amount) / COUNT(Order.orderId)',
        entity: 'Order',
        type: 'Decimal',
        description: 'Average order value.',
      },
    ],
  };
}

const descriptionOf = (entries: {name?: string; entrySource?: {description?: string}}[],
                       id: string) =>
    entries.find(e => e.name?.endsWith(`/entries/${id}`))?.entrySource
        ?.description;

describe('read-through paragraph (entity)', () => {
  const phys = physicalBindings(shop());

  test('names the node view, then the graph and node label', () => {
    expect(readThroughTrailer(shop().entities[0], phys.get('Customer')))
        .toBe(
            'Read through: node view `data-proj.sem.customer`; ' +
            'graph `data-proj.sem.shop_graph`, node Customer.');
  });

  test('mode: direct names the source table instead', () => {
    expect(readThroughTrailer(shop().entities[2], phys.get('Product')))
        .toBe(
            'Read through: table `src.sales.products`; ' +
            'graph `data-proj.sem.shop_graph`, node Product.');
  });

  test('no physical binding, no paragraph', () => {
    expect(readThroughTrailer(shop().entities[0], undefined)).toBeUndefined();
  });

  test('peel removes only a well-formed last paragraph', () => {
    const t = readThroughTrailer(shop().entities[0], phys.get('Customer'))!;
    expect(splitReadThroughTrailer(`A buyer.\n\n${t}`)).toEqual({rest: 'A buyer.'});
    expect(splitReadThroughTrailer(t)).toEqual({rest: undefined});
    expect(splitReadThroughTrailer('A buyer.\n\nRead through: the manual.'))
        .toEqual({rest: 'A buyer.\n\nRead through: the manual.'});
    expect(splitReadThroughTrailer(undefined)).toEqual({rest: undefined});
  });
});

describe('query paragraph (metric)', () => {
  const queries = metricQueries(shop());
  const GX = 'GRAPH_EXPAND\\("data-proj\\.sem\\.shop_graph(?:__order_metrics)?"\\)';

  test('a simple metric: AGG of its measure over GRAPH_EXPAND', () => {
    expect(queries.get('revenue'))
        .toMatch(new RegExp(`^SELECT AGG\\(Order_revenue\\) FROM ${GX}$`));
  });

  test('a composite metric: its measures composed as the expression', () => {
    expect(queries.get('aov')).toMatch(new RegExp(
        `^SELECT SAFE_DIVIDE\\(AGG\\(Order_revenue\\), ` +
        `AGG\\(Order_aov__agg2\\)\\) FROM ${GX}$`));
  });

  test('no BigQuery target, no queries', () => {
    const m = shop();
    delete m.customExtensions;
    expect(metricQueries(m).size).toBe(0);
  });

  test('appended after the description; peel restores it', () => {
    const q = queries.get('revenue')!;
    const d = withQueryTrailer('Gross revenue.\n\nUnit: USD.', q)!;
    expect(d).toBe(`Gross revenue.\n\nUnit: USD.\n\nQuery: ${q}`);
    expect(splitQueryTrailer(d)).toEqual({rest: 'Gross revenue.\n\nUnit: USD.'});
    expect(withQueryTrailer(undefined, q)).toBe(`Query: ${q}`);
    expect(splitQueryTrailer(`Query: ${q}`)).toEqual({rest: undefined});
    expect(withQueryTrailer('Plain.', undefined)).toBe('Plain.');
    expect(splitQueryTrailer('Plain.\n\nQuery: ask the finance team.'))
        .toEqual({rest: 'Plain.\n\nQuery: ask the finance team.'});
  });
});

describe('relationships paragraph (entity)', () => {
  const phys = physicalBindings(shop());
  const entity = (n: string) => shop().entities.find(e => e.name === n)!;

  test('each edge from and to the entity, with node-view join columns', () => {
    // Order.customerId is bound to column customer_ref, but its node view
    // column is customer_id (snake_case of the field).
    expect(relationshipItems(entity('Order'), shop(), phys))
        .toEqual(['placedBy → Customer (customer_id = customer_id)']);
    expect(relationshipItems(entity('Customer'), shop(), phys))
        .toEqual(['placedBy ← Order (customer_id = customer_id)']);
    expect(relationshipItems(entity('Product'), shop(), phys)).toEqual([]);
  });

  test('a paragraph that does not fit is cut, saying how many are left', () => {
    const items = ['a → B (x = y)', 'c → D (x = y)', 'e → F (x = y)'];
    expect(relationshipsTrailer(items, 500))
        .toBe('Relationships: a → B (x = y); c → D (x = y); e → F (x = y).');
    expect(relationshipsTrailer(items, 45))
        .toBe('Relationships: a → B (x = y); … 2 more.');
    expect(relationshipsTrailer(items, 10)).toBeUndefined();
    expect(relationshipsTrailer([], 500)).toBeUndefined();
  });

  test('peel removes only a well-formed last paragraph', () => {
    const t = relationshipsTrailer(['placedBy → Customer (customer_id = customer_id)'], 500)!;
    expect(splitRelationshipsTrailer(`A purchase.\n\n${t}`)).toEqual({rest: 'A purchase.'});
    expect(splitRelationshipsTrailer('A purchase.\n\nRelationships: see the ERD.'))
        .toEqual({rest: 'A purchase.\n\nRelationships: see the ERD.'});
  });
});

describe('on the published entries', () => {
  const {entries, entryLinks} =
      generateCatalogResources(shop(), {...OPTS, customAspects: ALL});

  test('a bound entity ends with Read through and Relationships (before Hydration)', () => {
    expect(descriptionOf(entries, 'shop.entities.Customer')).toBe(
        'A buyer.\n\nRead through: node view `data-proj.sem.customer`; ' +
        'graph `data-proj.sem.shop_graph`, node Customer.\n\n' +
        'Relationships: placedBy ← Order (customer_id = customer_id).');
    const order = descriptionOf(entries, 'shop.entities.Order')!.split('\n\n');
    expect(order[1]).toMatch(/^Read through: node view `data-proj\.sem\.order`/);
    expect(order[2]).toBe('Relationships: placedBy → Customer (customer_id = customer_id).');
    expect(order[3]).toMatch(/^Hydration: /);
  });

  test('a metric ends with its query', () => {
    expect(descriptionOf(entries, 'shop.metrics.revenue'))
        .toMatch(/^Gross revenue\.\n\nUnit: USD\.\n\nQuery: SELECT AGG\(Order_revenue\) /);
  });

  test('without the physical layout, nothing is appended', () => {
    const plain = generateCatalogResources(shop(), OPTS).entries;
    expect(descriptionOf(plain, 'shop.entities.Customer')).toBe('A buyer.');
    expect(descriptionOf(plain, 'shop.metrics.revenue'))
        .toBe('Gross revenue.\n\nUnit: USD.');
  });

  test('pull drops both paragraphs: the model comes back as authored', () => {
    const back = modelsFromCatalogResources(entries, entryLinks).models[0];
    const src = shop();
    expect(back.entities.map(e => e.description))
        .toEqual(src.entities.map(e => e.description));
    expect(back.metrics.map(m => m.description))
        .toEqual(src.metrics.map(m => m.description));
    expect(back.entities.find(e => e.name === 'Order')!.hydration)
        .toEqual({grain: {latestBy: 'updated_at'}});
  });
});

// BigQuery accepts a MEASURE named like a column of its node table's backing
// table but then fails every query on the graph (internal error, verified
// live). A metric named like its field's column is renamed `<metric>__measure`
// -- in the DDL, in the generator's record, and in the catalog's Query.
describe('a metric named like its node table\'s column', () => {
  function withWon(): SemanticModel {
    const m = shop();
    const order = m.entities.find(e => e.name === 'Order')!;
    order.fields.push({name: 'wonAmount', expression: 'won_amount', type: 'Decimal'});
    m.metrics.push(
        {name: 'won_amount', expression: 'SUM(Order.wonAmount)', entity: 'Order'},
        {name: 'win_share', expression: 'SUM(Order.wonAmount) / SUM(Order.amount)', entity: 'Order'});
    return m;
  }
  const TARGET = {project: 'data-proj', dataset: 'sem', graphName: 'shop_graph'};

  test('its MEASURE takes the __measure suffix', () => {
    const gen = generatePropertyGraph(withWon(), TARGET);
    expect(gen.ddl).toContain('MEASURE(SUM(wonAmount)) AS won_amount__measure');
    expect(gen.ddl).not.toMatch(/\) AS won_amount\b(?!__)/);
    expect(gen.measures).toContainEqual(
        {metric: 'won_amount', nodeTable: 'Order', measure: 'won_amount__measure'});
    expect(gen.warnings.some(w => w.includes('read it as AGG(Order_won_amount__measure)')))
        .toBe(true);
  });

  test('a metric not named like a column keeps its name', () => {
    const gen = generatePropertyGraph(withWon(), TARGET);
    expect(gen.measures).toContainEqual(
        {metric: 'revenue', nodeTable: 'Order', measure: 'revenue'});
  });

  test('the Query paragraph reads the renamed measure, also inside a composite', () => {
    const q = metricQueries(withWon());
    expect(q.get('won_amount')).toMatch(
        /^SELECT AGG\(Order_won_amount__measure\) FROM GRAPH_EXPAND\("data-proj\.sem\.shop_graph(?:__order_metrics)?"\)$/);
    expect(q.get('win_share')).toMatch(
        /^SELECT SAFE_DIVIDE\(AGG\(Order_won_amount__measure\), AGG\(Order_(?:revenue|win_share__agg2)\)\) FROM /);
  });
});
