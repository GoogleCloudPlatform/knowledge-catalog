// The derived description paragraphs that tell an agent how to read an entry
// in BigQuery (read_trailers.ts): `Read through: …` on a bound entity (its
// node view or table, its graph and node label) and `Query: …` on a metric
// (its measures over GRAPH_EXPAND, ready to run). lookup_context renders an
// entry's description and schema only, so these are what make one
// lookup_context call enough to execute. Pull drops both.

import {describe, expect, test} from 'bun:test';

import {SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {ANNOTATION_ASPECT_IDS} from '../../../src/libts/semantic/kc_custom_types';
import {generateCatalogResources, physicalBindings} from '../../../src/libts/semantic/knowledge_catalog';
import {metricQueries, readThroughTrailer, splitQueryTrailer, splitReadThroughTrailer, withQueryTrailer} from '../../../src/libts/semantic/read_trailers';

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

describe('on the published entries', () => {
  const {entries, entryLinks} =
      generateCatalogResources(shop(), {...OPTS, customAspects: ALL});

  test('a bound entity ends with Read through (before Hydration)', () => {
    expect(descriptionOf(entries, 'shop.entities.Customer')).toBe(
        'A buyer.\n\nRead through: node view `data-proj.sem.customer`; ' +
        'graph `data-proj.sem.shop_graph`, node Customer.');
    const order = descriptionOf(entries, 'shop.entities.Order')!.split('\n\n');
    expect(order[1]).toMatch(/^Read through: node view `data-proj\.sem\.order`/);
    expect(order[2]).toMatch(/^Hydration: /);
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
