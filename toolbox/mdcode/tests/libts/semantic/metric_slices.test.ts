// Tests for automatic metric slicing (K6, a proposed kcmd enhancement).
//
// planMetricGraphs (src/libts/semantic/metric_slices.ts) cuts, for each fact
// entity, a GRAPH_EXPAND-ready property graph -- a many-to-one tree rooted at
// the fact, at most 10 node tables, no inverse edges, ancestors as labels --
// carrying that fact's metrics as MEASUREs (composites as their components),
// and a SQL view for the metrics no graph can hold. deployBigQuery deploys
// them next to the main graph; its BigQuery client is stubbed here.

import {describe, expect, spyOn, test} from 'bun:test';

import * as bq from '../../../src/libts/gcp/bigquery';
import {ApiContext} from '../../../src/libts/gcp/context';
import {generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {deployBigQuery} from '../../../src/libts/semantic/deploy_bigquery';
import {Entity, Field, Metric, Relationship, SemanticModel} from '../../../src/libts/semantic/ir';
import {LoadedModel} from '../../../src/libts/semantic/loader';
import {renderComposition} from '../../../src/libts/semantic/metric_composition';
import {describeMetricGraphPlan, fallbackViewName, GRAPH_EXPAND_MAX_NODE_TABLES, MetricPlacement, planMetricGraphs, rewriteToColumns, sliceGraphName, snakeCase} from '../../../src/libts/semantic/metric_slices';

const TARGET = {project: 'p', dataset: 'd', graphName: 'g'};
const GRAPHS = '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs';

function f(name: string, column: string, type = 'String'): Field {
  return {name, expression: column, type} as Field;
}

function rel(name: string, from: string, fromField: string, to: string,
             toField: string, inverse?: string): Relationship {
  return {
    name,
    source: {entity: from, columns: [fromField]},
    destination: {entity: to, columns: [toField]},
    ...(inverse ? {inverse} : {}),
  } as Relationship;
}

function metric(name: string, expression: string, entity: string): Metric {
  return {name, expression, entity};
}

// Two facts (Sale, and SaleReturn which points at Sale) over a snowflake of
// dimensions; an abstract ancestor (Party); a defined entity (WonSale); a
// many-to-many relationship (promotedBy) and two inverses.
function retail(extra: Metric[] = []): SemanticModel {
  return {
    name: 'retail',
    entities: [
      {name: 'Party', abstract: true, dataSource: '', keys: [],
       fields: [{name: 'partyName', type: 'String'}]},
      {name: 'Customer', extends: ['Party'], dataSource: 'p.d.customer', keys: ['customerId'],
       fields: [f('customerId', 'customer_id'), f('partyName', 'customer_name'),
                f('segment', 'segment'), f('regionId', 'region_id')]},
      {name: 'Region', dataSource: 'p.d.region', keys: ['regionId'],
       fields: [f('regionId', 'region_id'), f('regionName', 'region_name')]},
      {name: 'Category', dataSource: 'p.d.category', keys: ['categoryId'],
       fields: [f('categoryId', 'category_id'), f('categoryName', 'category_name')]},
      {name: 'Product', dataSource: 'p.d.product', keys: ['productId'],
       fields: [f('productId', 'product_id'), f('productName', 'product_name'),
                f('categoryId', 'category_id')]},
      {name: 'Sale', dataSource: 'p.d.sale', keys: ['saleId'],
       fields: [f('saleId', 'sale_id'), f('customerId', 'customer_id'),
                f('productId', 'product_id'), f('amount', 'amount', 'Decimal'),
                f('quantity', 'qty', 'Integer'), f('status', 'status')]},
      {name: 'WonSale', extends: ['Sale'], dataSource: '', keys: [], fields: [],
       definition: {expression: "status = 'won'"}},
      {name: 'SaleReturn', dataSource: 'p.d.sale_return', keys: ['returnId'],
       fields: [f('returnId', 'return_id'), f('saleId', 'sale_id'),
                f('refund', 'refund_amount', 'Decimal')]},
      {name: 'Promotion', dataSource: 'p.d.promotion', keys: ['promotionId'],
       fields: [f('promotionId', 'promotion_id'), f('promotionName', 'name')]},
    ],
    relationships: [
      rel('soldTo', 'Sale', 'customerId', 'Customer', 'customerId', 'purchases'),
      rel('ofProduct', 'Sale', 'productId', 'Product', 'productId'),
      rel('inRegion', 'Customer', 'regionId', 'Region', 'regionId'),
      rel('inCategory', 'Product', 'categoryId', 'Category', 'categoryId'),
      rel('returnOf', 'SaleReturn', 'saleId', 'Sale', 'saleId', 'returns'),
      {name: 'promotedBy', source: {entity: 'Sale', columns: []},
       destination: {entity: 'Promotion', columns: []},
       association: {dataSource: 'p.d.sale_promotion', keys: ['sale_id', 'promotion_id'],
                     sourceColumns: ['sale_id'], destinationColumns: ['promotion_id']}},
    ],
    metrics: [
      metric('revenue', 'SUM(Sale.amount)', 'Sale'),
      metric('units', 'SUM(Sale.quantity)', 'Sale'),
      metric('avg_price', 'SUM(Sale.amount) / SUM(Sale.quantity)', 'Sale'),
      metric('win_rate', "100 * COUNTIF(Sale.status = 'won') / COUNT(Sale.saleId)", 'Sale'),
      metric('customer_count', 'COUNT(DISTINCT Customer.customerId)', 'Customer'),
      metric('refund_total', 'SUM(SaleReturn.refund)', 'SaleReturn'),
      metric('won_revenue', 'SUM(WonSale.amount)', 'WonSale'),
      metric('amount_stddev', 'STDDEV(Sale.amount)', 'Sale'),
      ...extra,
    ],
    actions: [],
    constraints: [],
  } as SemanticModel;
}

// retail plus a second path from Sale to Region (through Store): a diamond.
function diamond(extra: Metric[] = []): SemanticModel {
  const m = retail(extra);
  m.entities.find(e => e.name === 'Sale')!.fields.push(f('storeId', 'store_id'));
  m.entities.push({name: 'Store', dataSource: 'p.d.store', keys: ['storeId'],
                   fields: [f('storeId', 'store_id'), f('regionId', 'region_id')]} as Entity);
  m.relationships.push(rel('atStore', 'Sale', 'storeId', 'Store', 'storeId'),
                       rel('storeRegion', 'Store', 'regionId', 'Region', 'regionId'));
  return m;
}

// One fact (Event) with `dims` many-to-one dimensions D01, D02, ...
function star(dims: number, metrics: Metric[]): SemanticModel {
  const names = Array.from({length: dims}, (_, i) => `D${String(i + 1).padStart(2, '0')}`);
  const key = (n: string) => `${n.toLowerCase()}Id`;
  const col = (n: string) => `${n.toLowerCase()}_id`;
  return {
    name: 'star',
    entities: [
      {name: 'Event', dataSource: 'p.d.event', keys: ['eventId'],
       fields: [f('eventId', 'event_id'), f('value', 'value', 'Decimal'),
                ...names.map(n => f(key(n), col(n)))]},
      ...names.map(n => ({name: n, dataSource: `p.d.${n.toLowerCase()}`, keys: [key(n)],
                          fields: [f(key(n), col(n))]})),
    ],
    relationships: names.map(n => rel(`to${n}`, 'Event', key(n), n, key(n))),
    metrics,
    actions: [],
    constraints: [],
  } as SemanticModel;
}

// Sale -> Customer only.
function tiny(metrics: Metric[], inverse?: string): SemanticModel {
  return {
    name: 'tiny',
    entities: [
      {name: 'Customer', dataSource: 'p.d.customer', keys: ['customerId'],
       fields: [f('customerId', 'customer_id'), f('segment', 'segment')]},
      {name: 'Sale', dataSource: 'p.d.sale', keys: ['saleId'],
       fields: [f('saleId', 'sale_id'), f('customerId', 'customer_id'),
                f('amount', 'amount', 'Decimal'), f('quantity', 'qty', 'Integer')]},
    ],
    relationships: [rel('soldTo', 'Sale', 'customerId', 'Customer', 'customerId', inverse)],
    metrics,
    actions: [],
    constraints: [],
  } as SemanticModel;
}

// Where and how a placement says to read its metric, in one line: a graph
// placement as `AGG()` of each component's measure (on its home node table),
// recombined by the composition.
function read(p: MetricPlacement|undefined): string {
  if (!p) return 'missing';
  if (p.kind === 'graph') {
    const agg = (i: number) =>
        `AGG(${p.homes[i]}_${p.decomposition.components[i].name})`;
    return `${p.ref}: ${renderComposition(p.decomposition.template, agg)}`;
  }
  if (p.kind === 'view') return `view ${p.ref}: ${p.expression}`;
  return `none: ${p.reason}`;
}

const SALE_SLICE_DDL = `CREATE OR REPLACE PROPERTY GRAPH \`p.d.g__sale_metrics\`
NODE TABLES (
  \`p.d.sale\` AS Sale
    KEY(sale_id)
    PROPERTIES(
      sale_id AS saleId,
      customer_id AS customerId,
      product_id AS productId,
      amount,
      qty AS quantity,
      status,
      COALESCE(status = 'won', FALSE) AS isWonSale OPTIONS(description="True when this Sale is a WonSale: status = 'won'."),
      CAST((COALESCE(status = 'won', FALSE)) AS INT64) AS win_rate__agg1_input,
      MEASURE(SUM(amount)) AS revenue,
      MEASURE(SUM(quantity)) AS units,
      MEASURE(SUM(win_rate__agg1_input)) AS win_rate__agg1 OPTIONS(description="Component 1 of metric win_rate: SUM(CAST(Sale.isWonSale AS INT64)). Recombined as described on win_rate."),
      MEASURE(COUNT(saleId)) AS win_rate__agg2 OPTIONS(description="Component 2 of metric win_rate: COUNT(Sale.saleId). Recombined as described on win_rate.")
    ),
  \`p.d.product\` AS Product
    KEY(product_id)
    PROPERTIES(
      product_id AS productId,
      product_name AS productName,
      category_id AS categoryId
    ),
  \`p.d.customer\` AS Customer
    KEY(customer_id)
    DEFAULT LABEL
    PROPERTIES(
      customer_id AS customerId,
      customer_name AS partyName,
      segment,
      region_id AS regionId
    )
    LABEL Party
    PROPERTIES(
      customer_name AS partyName
    ),
  \`p.d.category\` AS Category
    KEY(category_id)
    PROPERTIES(
      category_id AS categoryId,
      category_name AS categoryName
    ),
  \`p.d.region\` AS Region
    KEY(region_id)
    PROPERTIES(
      region_id AS regionId,
      region_name AS regionName
    )
)
EDGE TABLES (
  \`p.d.sale\` AS ofProduct
    KEY(sale_id)
    SOURCE KEY(sale_id) REFERENCES Sale(sale_id)
    DESTINATION KEY(product_id) REFERENCES Product(product_id)
    NO PROPERTIES,
  \`p.d.sale\` AS soldTo
    KEY(sale_id)
    SOURCE KEY(sale_id) REFERENCES Sale(sale_id)
    DESTINATION KEY(customer_id) REFERENCES Customer(customer_id)
    NO PROPERTIES,
  \`p.d.product\` AS inCategory
    KEY(product_id)
    SOURCE KEY(product_id) REFERENCES Product(product_id)
    DESTINATION KEY(category_id) REFERENCES Category(category_id)
    NO PROPERTIES,
  \`p.d.customer\` AS inRegion
    KEY(customer_id)
    SOURCE KEY(customer_id) REFERENCES Customer(customer_id)
    DESTINATION KEY(region_id) REFERENCES Region(region_id)
    NO PROPERTIES
);
`;

const SALE_VIEW_SQL = `CREATE OR REPLACE VIEW \`p.d.g__sale_metrics_view\`
OPTIONS(description="One row per Sale record, joined along many-to-one relationships to Product, Customer, Category, Region. Columns are named <Entity>_<field>, as in GRAPH_EXPAND output. Generated by kcmd for the metrics that cannot be graph measures: amount_stddev.")
AS
SELECT
  Sale.saleId AS Sale_saleId,
  Sale.customerId AS Sale_customerId,
  Sale.productId AS Sale_productId,
  Sale.amount AS Sale_amount,
  Sale.quantity AS Sale_quantity,
  Sale.status AS Sale_status,
  Sale.isWonSale AS Sale_isWonSale,
  Product.productId AS Product_productId,
  Product.productName AS Product_productName,
  Product.categoryId AS Product_categoryId,
  Customer.customerId AS Customer_customerId,
  Customer.partyName AS Customer_partyName,
  Customer.segment AS Customer_segment,
  Customer.regionId AS Customer_regionId,
  Category.categoryId AS Category_categoryId,
  Category.categoryName AS Category_categoryName,
  Region.regionId AS Region_regionId,
  Region.regionName AS Region_regionName
FROM (
    SELECT
      sale_id AS saleId,
      customer_id AS customerId,
      product_id AS productId,
      amount,
      qty AS quantity,
      status,
      COALESCE(status = 'won', FALSE) AS isWonSale
    FROM \`p.d.sale\`
  ) AS Sale
LEFT JOIN (
    SELECT
      product_id AS productId,
      product_name AS productName,
      category_id AS categoryId
    FROM \`p.d.product\`
  ) AS Product
  ON Sale.productId = Product.productId
LEFT JOIN (
    SELECT
      customer_id AS customerId,
      customer_name AS partyName,
      segment,
      region_id AS regionId
    FROM \`p.d.customer\`
  ) AS Customer
  ON Sale.customerId = Customer.customerId
LEFT JOIN (
    SELECT
      category_id AS categoryId,
      category_name AS categoryName
    FROM \`p.d.category\`
  ) AS Category
  ON Product.categoryId = Category.categoryId
LEFT JOIN (
    SELECT
      region_id AS regionId,
      region_name AS regionName
    FROM \`p.d.region\`
  ) AS Region
  ON Customer.regionId = Region.regionId;
`;


describe('metric graph naming', () => {
  test('snake_case of entity names', () => {
    expect(snakeCase('Sale')).toBe('sale');
    expect(snakeCase('SaleReturn')).toBe('sale_return');
    expect(snakeCase('HTTPLog')).toBe('http_log');
    expect(snakeCase('line-item 2')).toBe('line_item_2');
  });

  test('slice graphs and fallback views are named after the main graph and the fact', () => {
    expect(sliceGraphName('g', 'SaleReturn')).toBe('g__sale_return_metrics');
    expect(fallbackViewName('g', 'Sale')).toBe('g__sale_metrics_view');
  });
});


describe('planMetricGraphs: slice selection', () => {
  const plan = planMetricGraphs(retail(), TARGET);

  test('one slice per fact entity, in fact order', () => {
    expect(plan.mainRef).toBe('p.d.g');
    expect(plan.slices.map(s => [s.fact, s.graphName, s.ref])).toEqual([
      ['Customer', 'g__customer_metrics', 'p.d.g__customer_metrics'],
      ['Sale', 'g__sale_metrics', 'p.d.g__sale_metrics'],
      ['SaleReturn', 'g__sale_return_metrics', 'p.d.g__sale_return_metrics'],
    ]);
    expect(plan.slices[1].uri).toBe(`${GRAPHS}/g__sale_metrics`);
  });

  test('a slice is the breadth-first many-to-one tree rooted at its fact', () => {
    const sale = plan.slices[1];
    expect(sale.nodeTables).toEqual(['Sale', 'Product', 'Customer', 'Category', 'Region']);
    expect(sale.edges).toEqual([
      {relationship: 'ofProduct', from: 'Sale', to: 'Product'},
      {relationship: 'soldTo', from: 'Sale', to: 'Customer'},
      {relationship: 'inCategory', from: 'Product', to: 'Category'},
      {relationship: 'inRegion', from: 'Customer', to: 'Region'},
    ]);
    // The many-to-many promotedBy never enters a tree; an inverse edge would
    // point back into the fact (a second root), so it is left out.
    expect(sale.omitted).toEqual(['purchases (inverse of soldTo)']);
    expect(sale.labels).toEqual(['Party']);
    expect(sale.metrics).toEqual(['avg_price', 'revenue', 'units', 'win_rate']);
    // Composites are carried as their single-aggregate components.
    expect(Object.fromEntries(sale.measures)).toEqual({
      revenue: 'Sale',
      units: 'Sale',
      win_rate__agg1: 'Sale',
      win_rate__agg2: 'Sale',
    });
  });

  test('a fact that points at another fact roots its own tree through it', () => {
    const returns = plan.slices[2];
    expect(returns.nodeTables)
        .toEqual(['SaleReturn', 'Sale', 'Product', 'Customer', 'Category', 'Region']);
    expect(returns.edges[0]).toEqual({relationship: 'returnOf', from: 'SaleReturn', to: 'Sale'});
    expect(returns.omitted)
        .toEqual(['purchases (inverse of soldTo)', 'returns (inverse of returnOf)']);
    expect(Object.fromEntries(returns.measures)).toEqual({refund_total: 'SaleReturn'});
  });

  test('every metric has a placement saying which graph and expression to read', () => {
    expect(Object.fromEntries([...plan.placements].map(([m, p]) => [m, read(p)]))).toEqual({
      amount_stddev: 'view p.d.g__sale_metrics_view: STDDEV(Sale_amount)',
      avg_price: 'p.d.g__sale_metrics: SAFE_DIVIDE(AGG(Sale_revenue), AGG(Sale_units))',
      customer_count: 'p.d.g__customer_metrics: AGG(Customer_customer_count)',
      refund_total: 'p.d.g__sale_return_metrics: AGG(SaleReturn_refund_total)',
      revenue: 'p.d.g__sale_metrics: AGG(Sale_revenue)',
      units: 'p.d.g__sale_metrics: AGG(Sale_units)',
      win_rate: 'p.d.g__sale_metrics: ' +
          '100 * SAFE_DIVIDE(AGG(Sale_win_rate__agg1), AGG(Sale_win_rate__agg2))',
      won_revenue: 'none: it reads defined entity WonSale, which has no table ' +
          '(a MEASURE cannot filter rows)',
    });
  });

  test('the plan in words (push output) and its warnings', () => {
    expect(describeMetricGraphPlan(plan)).toEqual([
      'metric graph p.d.g__customer_metrics: root Customer, 2 node table(s) ' +
          '(Region via inRegion), labels Party; metrics customer_count',
      'metric graph p.d.g__sale_metrics: root Sale, 5 node table(s) (Product via ' +
          'ofProduct, Customer via soldTo, Category via inCategory, Region via ' +
          'inRegion), labels Party; metrics avg_price, revenue, units, win_rate; ' +
          'left out: purchases (inverse of soldTo)',
      'metric graph p.d.g__sale_return_metrics: root SaleReturn, 6 node table(s) ' +
          '(Sale via returnOf, Product via ofProduct, Customer via soldTo, Category ' +
          'via inCategory, Region via inRegion), labels Party; metrics ' +
          'refund_total; left out: purchases (inverse of soldTo), returns (inverse ' +
          'of returnOf)',
      'metric view p.d.g__sale_metrics_view: one row per Sale, 18 column(s); ' +
          'metrics amount_stddev',
    ]);
    expect(plan.warnings).toEqual([
      "metric 'won_revenue' cannot be a graph MEASURE (it reads defined entity " +
          'WonSale, which has no table (a MEASURE cannot filter rows)); query it ' +
          'with plain SQL over the bound tables',
      "metric 'amount_stddev' cannot be a graph MEASURE (STDDEV cannot be a " +
          'MEASURE (a measure is one of SUM, AVG, COUNT, MIN, MAX)); it falls back ' +
          'to the SQL view p.d.g__sale_metrics_view',
    ]);
  });

  test('a composite whose aggregates read two entities is rooted at the one reaching the other', () => {
    const p = planMetricGraphs(
        retail([metric('revenue_per_region',
                       'SUM(Sale.amount) / COUNT(DISTINCT Region.regionId)', 'Sale')]),
        TARGET);
    expect(read(p.placements.get('revenue_per_region'))).toBe(
        'p.d.g__sale_metrics: SAFE_DIVIDE(AGG(Sale_revenue), ' +
        'AGG(Region_revenue_per_region__agg2))');
    const sale = p.slices.find(s => s.fact === 'Sale')!;
    expect(sale.measures.get('revenue_per_region__agg2')).toBe('Region');
    expect(sale.ddl).toContain(
        'MEASURE(COUNT(DISTINCT regionId)) AS revenue_per_region__agg2');
  });

  test('declaration order never changes the plan', () => {
    const m = retail();
    m.entities = [...m.entities].reverse();
    m.relationships = [...m.relationships].reverse();
    m.metrics = [...m.metrics].reverse();
    const again = planMetricGraphs(m, TARGET);
    expect(again.slices.map(s => s.ddl)).toEqual(plan.slices.map(s => s.ddl));
    expect(again.views.map(v => v.sql)).toEqual(plan.views.map(v => v.sql));
    expect(describeMetricGraphPlan(again)).toEqual(describeMetricGraphPlan(plan));
    expect(again.warnings).toEqual(plan.warnings);
  });

  test('a model without metrics plans nothing', () => {
    const empty = planMetricGraphs({...retail(), metrics: []}, TARGET);
    expect([empty.slices, empty.views, empty.warnings]).toEqual([[], [], []]);
    expect(empty.placements.size).toBe(0);
  });
});


describe('planMetricGraphs: slice DDL', () => {
  const plan = planMetricGraphs(retail(), TARGET);

  test('golden: the Sale slice', () => {
    expect(plan.slices[1].ddl).toBe(SALE_SLICE_DDL);
  });

  test('ancestors are labels only, never node tables', () => {
    const customers = plan.slices[0];
    expect(customers.ddl).toContain('    LABEL Party\n');
    expect(customers.ddl).not.toMatch(/ AS Party\b/);
    expect(customers.model.entities.find(e => e.name === 'Party')?.abstract).toBe(true);
  });

  test('inverse edges stay in the main graph only', () => {
    const main = generatePropertyGraph(retail(), TARGET).ddl;
    expect(main).toMatch(/ AS purchases\b/);
    for (const s of plan.slices) {
      expect(s.ddl).not.toMatch(/ AS (purchases|returns)\b/);
      expect(s.model.relationships.every(r => r.inverse === undefined)).toBe(true);
    }
  });

  test('a slice carries only its own metrics', () => {
    const customers = plan.slices[0];
    expect(customers.model.metrics.map(m => m.name)).toEqual(['customer_count']);
    expect(customers.ddl).not.toContain('AS revenue');
  });
});


describe('planMetricGraphs: the node-table limit', () => {
  test('a slice grows with further dimensions up to 10 node tables', () => {
    expect(GRAPH_EXPAND_MAX_NODE_TABLES).toBe(10);
    const plan = planMetricGraphs(
        star(12, [metric('event_count', 'COUNT(Event.eventId)', 'Event')]), TARGET);
    expect(plan.slices.map(s => s.nodeTables)).toEqual([
      ['Event', 'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D09'],
    ]);
  });

  test('the dimensions a metric reads are kept before the tree grows', () => {
    const plan = planMetricGraphs(
        star(12, [metric('value_per_d12', 'SUM(Event.value) / COUNT(DISTINCT D12.d12Id)',
                         'Event')]),
        TARGET);
    expect(plan.slices[0].nodeTables).toEqual(
        ['Event', 'D01', 'D02', 'D03', 'D04', 'D05', 'D06', 'D07', 'D08', 'D12']);
    expect(read(plan.placements.get('value_per_d12'))).toBe(
        'p.d.g__event_metrics: SAFE_DIVIDE(AGG(Event_value_per_d12__agg1), ' +
        'AGG(D12_value_per_d12__agg2))');
  });

  test('maxNodeTables lowers the limit', () => {
    const plan = planMetricGraphs(retail(), TARGET, {maxNodeTables: 3});
    expect(plan.slices.map(s => s.nodeTables)).toEqual([
      ['Customer', 'Region'],
      ['Sale', 'Product', 'Customer'],
      ['SaleReturn', 'Sale', 'Product'],
    ]);
  });

  test('a metric needing more node tables than the limit falls back to the view', () => {
    const plan = planMetricGraphs(
        retail([metric('revenue_per_region',
                       'SUM(Sale.amount) / COUNT(DISTINCT Region.regionId)', 'Sale')]),
        TARGET, {maxNodeTables: 2});
    expect(read(plan.placements.get('revenue_per_region'))).toBe(
        'view p.d.g__sale_metrics_view: SUM(Sale_amount) / COUNT(DISTINCT Region_regionId)');
    expect(plan.views.map(v => [v.viewName, v.entities, v.metrics])).toEqual([
      ['g__sale_metrics_view', ['Sale', 'Customer', 'Region'],
       ['amount_stddev', 'revenue_per_region']],
    ]);
    expect(plan.warnings).toContain(
        "metric 'revenue_per_region' cannot be a graph MEASURE (it needs 3 node " +
        'tables, over the 2 GRAPH_EXPAND accepts); it falls back to the SQL view ' +
        'p.d.g__sale_metrics_view');
  });

  test('metrics that fit alone but not together: the later one falls back', () => {
    const plan = planMetricGraphs(
        retail([
          metric('revenue_per_category',
                 'SUM(Sale.amount) / COUNT(DISTINCT Category.categoryId)', 'Sale'),
          metric('revenue_per_region',
                 'SUM(Sale.amount) / COUNT(DISTINCT Region.regionId)', 'Sale'),
        ]),
        TARGET, {maxNodeTables: 3});
    const sale = plan.slices.find(s => s.fact === 'Sale')!;
    expect(sale.nodeTables).toEqual(['Sale', 'Product', 'Category']);
    expect(sale.metrics).toContain('revenue_per_category');
    const placed = plan.placements.get('revenue_per_region');
    expect(placed?.kind).toBe('view');
    expect(placed?.kind === 'view' && placed.reason).toBe(
        'the Sale slice would need 5 node tables, over the 3 GRAPH_EXPAND accepts');
  });
});


describe('planMetricGraphs: fallbacks', () => {
  const PER_REGION =
      metric('revenue_per_region', 'SUM(Sale.amount) / COUNT(DISTINCT Region.regionId)', 'Sale');

  test('golden: the fallback view', () => {
    const plan = planMetricGraphs(retail(), TARGET);
    expect(plan.views.length).toBe(1);
    const [view] = plan.views;
    expect(view.sql).toBe(SALE_VIEW_SQL);
    expect(view.uri)
        .toBe('//bigquery.googleapis.com/projects/p/datasets/d/tables/g__sale_metrics_view');
    expect(view.columnFor.get('Customer.partyName')).toBe('Customer_partyName');
  });

  test('convergent paths: no tree can hold the metric; the view joins one path', () => {
    const plan = planMetricGraphs(diamond([PER_REGION]), TARGET);
    const placed = plan.placements.get('revenue_per_region');
    expect(placed?.kind === 'view' && placed.reason).toBe(
        'Sale reaches Region through several relationship paths (convergent ' +
        'paths), so one GRAPH_EXPAND tree cannot say which the metric means');
    expect(plan.warnings).toContain(
        "metric 'revenue_per_region' cannot be a graph MEASURE (Sale reaches " +
        'Region through several relationship paths (convergent paths), so one ' +
        'GRAPH_EXPAND tree cannot say which the metric means); it falls back to ' +
        'the SQL view p.d.g__sale_metrics_view; it joins Region along atStore -> ' +
        'storeRegion');
  });

  test('convergent paths: a slice still keeps one path and leaves the other out', () => {
    const sale = planMetricGraphs(diamond(), TARGET).slices.find(s => s.fact === 'Sale')!;
    expect(sale.nodeTables)
        .toEqual(['Sale', 'Store', 'Product', 'Customer', 'Region', 'Category']);
    expect(sale.edges.filter(e => e.to === 'Region'))
        .toEqual([{relationship: 'storeRegion', from: 'Store', to: 'Region'}]);
    expect(sale.omitted).toEqual(['inRegion', 'purchases (inverse of soldTo)']);
  });

  test('aggregates no one entity reaches through many-to-one: plain SQL', () => {
    const plan = planMetricGraphs(
        retail([metric('promo_share',
                       'SUM(Sale.amount) / COUNT(DISTINCT Promotion.promotionId)', 'Sale')]),
        TARGET);
    expect(read(plan.placements.get('promo_share'))).toBe(
        'none: its aggregates read Sale, Promotion, and no one of them reaches ' +
        'the others through many-to-one relationships');
    expect(plan.warnings).toContain(
        "metric 'promo_share' cannot be a graph MEASURE (its aggregates read Sale, " +
        'Promotion, and no one of them reaches the others through many-to-one ' +
        'relationships); no fallback view either (no one of Sale, Promotion ' +
        'reaches the others through many-to-one relationships); query it with ' +
        'plain SQL over the bound tables');
  });

  test('a flat view would repeat a dimension row: no view either', () => {
    const plan = planMetricGraphs(
        retail([metric('spread_per_customer',
                       'STDDEV(Sale.amount) / COUNT(Customer.customerId)', 'Sale')]),
        TARGET);
    expect(plan.placements.get('spread_per_customer')?.kind).toBe('none');
    expect(plan.warnings.find(w => w.startsWith("metric 'spread_per_customer'")))
        .toContain('no fallback view either (COUNT(...) reads only Customer, whose ' +
                   'rows repeat once per Sale record in a flat view)');
  });
});


describe('planMetricGraphs: the main graph serving GRAPH_EXPAND itself', () => {
  test('no slice when it would be the whole main graph and every metric a MEASURE there', () => {
    const plan = planMetricGraphs(tiny([metric('revenue', 'SUM(Sale.amount)', 'Sale')]), TARGET);
    expect(plan.slices).toEqual([]);
    const placed = plan.placements.get('revenue');
    expect(placed?.kind === 'graph' && placed.slice).toBe(false);
    expect(read(placed)).toBe('p.d.g: AGG(Sale_revenue)');
    expect(describeMetricGraphPlan(plan))
        .toEqual(['p.d.g serves GRAPH_EXPAND itself for revenue']);
  });

  test('a composite metric still gets a slice', () => {
    const plan = planMetricGraphs(
        tiny([metric('revenue', 'SUM(Sale.amount)', 'Sale'),
              metric('avg_price', 'SUM(Sale.amount) / SUM(Sale.quantity)', 'Sale')]),
        TARGET);
    expect(plan.slices.map(s => [s.graphName, s.metrics]))
        .toEqual([['g__sale_metrics', ['avg_price', 'revenue']]]);
  });

  test('an inverse edge in the main graph means a slice', () => {
    const plan = planMetricGraphs(
        tiny([metric('revenue', 'SUM(Sale.amount)', 'Sale')], 'purchases'), TARGET);
    expect(plan.slices.map(s => s.graphName)).toEqual(['g__sale_metrics']);
  });
});


describe('rewriteToColumns', () => {
  const column = (e: string, f: string) => `${e}_${f}`;

  test('rewrites qualified fields outside string literals, longest entity first', () => {
    expect(rewriteToColumns(
               "SUM(SaleReturn.refund) / COUNTIF(`Sale`.`status` = 'Sale.won')",
               ['Sale', 'SaleReturn'], column))
        .toBe("SUM(SaleReturn_refund) / COUNTIF(Sale_status = 'Sale.won')");
  });
});


describe('deployBigQuery: metric graphs next to the main graph', () => {
  const CTX = new ApiContext('test-project', 'us', 'test-token');
  const URI = `${GRAPHS}/g`;

  function loaded(): LoadedModel[] {
    const model = retail();
    model.customExtensions =
        [{vendorName: 'GOOGLE', data: JSON.stringify({deploymentTargets: [URI]})}];
    return [{document: 'retail', model}];
  }

  function mockDataset() {
    return spyOn(bq.BigQueryClient.prototype, 'getDataset')
        .mockImplementation(async () => ({status: 200, result: {location: 'US'}} as any));
  }

  // The statement a DDL creates, e.g. `PROPERTY GRAPH \`p.d.g\``.
  function created(sql: string): string {
    return /CREATE OR REPLACE (PROPERTY GRAPH|VIEW) `[^`]+`/.exec(sql)?.[0] ?? sql;
  }

  const CREATED = [
    'CREATE OR REPLACE PROPERTY GRAPH `p.d.g`',
    'CREATE OR REPLACE PROPERTY GRAPH `p.d.g__customer_metrics`',
    'CREATE OR REPLACE PROPERTY GRAPH `p.d.g__sale_metrics`',
    'CREATE OR REPLACE PROPERTY GRAPH `p.d.g__sale_return_metrics`',
    'CREATE OR REPLACE VIEW `p.d.g__sale_metrics_view`',
  ];

  test('a dry run plans the metric graphs and views and executes nothing', async () => {
    const querySpy = spyOn(bq.BigQueryClient.prototype, 'query');
    try {
      const res = await deployBigQuery(loaded(), CTX, {validateOnly: true});
      expect(res.success).toBe(true);
      expect(querySpy).not.toHaveBeenCalled();
      expect([res.deployed, res.views]).toEqual([0, 0]);
      expect(res.ddl.map(d => d.split('\n')[0])).toEqual([
        `-- ${URI}`,
        `-- ${GRAPHS}/g__customer_metrics`,
        `-- ${GRAPHS}/g__sale_metrics`,
        `-- ${GRAPHS}/g__sale_return_metrics`,
        '-- //bigquery.googleapis.com/projects/p/datasets/d/tables/g__sale_metrics_view',
      ]);
      expect(res.ddl.map(created)).toEqual(CREATED);
      expect(res.metricGraphs).toEqual(
          describeMetricGraphPlan(planMetricGraphs(retail(), TARGET))
              .map(line => `[retail -> g] ${line}`));
      expect(res.warnings).toContain(
          "[retail -> g] metric 'amount_stddev' cannot be a graph MEASURE (STDDEV " +
          'cannot be a MEASURE (a measure is one of SUM, AVG, COUNT, MIN, MAX)); it ' +
          'falls back to the SQL view p.d.g__sale_metrics_view');
    } finally {
      querySpy.mockRestore();
    }
  });

  test('a push creates the main graph, then the metric graphs, then the views', async () => {
    const dsSpy = mockDataset();
    const querySpy = spyOn(bq.BigQueryClient.prototype, 'query')
                         .mockImplementation(
                             async () => ({status: 200, result: {jobComplete: true}}));
    try {
      const res = await deployBigQuery(loaded(), CTX, {});
      expect(res.success).toBe(true);
      expect([res.deployed, res.views]).toEqual([4, 1]);
      expect(querySpy.mock.calls.map(c => created(c[1]))).toEqual(CREATED);
      expect(querySpy.mock.calls.every(c => c[0] === 'p' && c[2] === 'US')).toBe(true);
      expect(dsSpy).toHaveBeenCalledTimes(1);
    } finally {
      dsSpy.mockRestore();
      querySpy.mockRestore();
    }
  });

  test('--no-metric-graphs deploys the main graph alone', async () => {
    const dsSpy = mockDataset();
    const querySpy = spyOn(bq.BigQueryClient.prototype, 'query')
                         .mockImplementation(
                             async () => ({status: 200, result: {jobComplete: true}}));
    try {
      const res = await deployBigQuery(loaded(), CTX, {metricGraphs: false});
      expect(res.success).toBe(true);
      expect([res.deployed, res.views]).toEqual([1, 0]);
      expect(querySpy.mock.calls.map(c => created(c[1]))).toEqual([CREATED[0]]);
      expect(res.ddl.length).toBe(1);
      expect(res.metricGraphs).toEqual([]);
      expect(res.warnings.some(w => w.includes('cannot be a graph MEASURE'))).toBe(false);
    } finally {
      dsSpy.mockRestore();
      querySpy.mockRestore();
    }
  });

  test('a failing metric graph stops the push and says what was deployed', async () => {
    const dsSpy = mockDataset();
    let calls = 0;
    const querySpy = spyOn(bq.BigQueryClient.prototype, 'query')
                         .mockImplementation(async () => (++calls === 2 ?
                             {status: 400, message: 'boom'} :
                             {status: 200, result: {jobComplete: true}}) as any);
    try {
      const res = await deployBigQuery(loaded(), CTX, {});
      expect(res.success).toBe(false);
      expect(res.details).toBe(
          "Failed to deploy metric graph 'g__customer_metrics': boom (1 graph(s) " +
          'already deployed in this run; CREATE OR REPLACE changes are not rolled back)');
      expect(querySpy).toHaveBeenCalledTimes(2);
    } finally {
      dsSpy.mockRestore();
      querySpy.mockRestore();
    }
  });

  test('a failing view stops the push after the graphs', async () => {
    const dsSpy = mockDataset();
    let calls = 0;
    const querySpy = spyOn(bq.BigQueryClient.prototype, 'query')
                         .mockImplementation(async () => (++calls === 5 ?
                             {status: 400, message: 'boom'} :
                             {status: 200, result: {jobComplete: true}}) as any);
    try {
      const res = await deployBigQuery(loaded(), CTX, {});
      expect(res.success).toBe(false);
      expect(res.details).toBe(
          "Failed to create metric view 'g__sale_metrics_view': boom (4 graph(s) " +
          'already deployed in this run; CREATE OR REPLACE changes are not rolled back)');
      expect([res.deployed, res.views]).toEqual([4, 0]);
    } finally {
      dsSpy.mockRestore();
      querySpy.mockRestore();
    }
  });
});

describe('planMetricGraphs: edges over generated edge views', () => {
  // A foreign key into a vocabulary is rendered over a generated edge view
  // (matched case-insensitively), not over the fact's own table. GRAPH_EXPAND
  // ignores such a standalone edge table, so a slice that kept it would have
  // the vocabulary as a second root and every GRAPH_EXPAND on it would fail
  // ("The graph has multiple root node tables", seen live). The slice keeps
  // only the edges rendered over the source's own table.
  function withStatus(): SemanticModel {
    const model = tiny([metric('total_amount', 'SUM(Sale.amount)', 'Sale')]);
    model.entities.push({
      name: 'SaleStatus',
      dataSource: '',
      keys: ['code'],
      fields: [{name: 'code', type: 'String'}, {name: 'label', type: 'String'}],
      members: [{code: 'OPEN', label: 'Open'}, {code: 'WON', label: 'Won'}],
    } as Entity);
    model.entities[1].fields.push(f('status', 'status'));
    model.relationships.push(rel('hasStatus', 'Sale', 'status', 'SaleStatus', 'code'));
    return model;
  }

  test('the vocabulary is not a node table of the slice', () => {
    const plan = planMetricGraphs(withStatus(), TARGET);
    const sale = plan.slices.find(s => s.fact === 'Sale')!;
    expect(sale.nodeTables).toEqual(['Sale', 'Customer']);
    expect(sale.edges.map(e => e.relationship)).toEqual(['soldTo']);
    expect(sale.ddl).not.toContain('edge_has_status');
    expect(sale.ddl).not.toContain('vocab_sale_status');
  });

  test('the metric is read on the slice', () => {
    const plan = planMetricGraphs(withStatus(), TARGET);
    expect(read(plan.placements.get('total_amount')))
        .toBe('p.d.g__sale_metrics: AGG(Sale_total_amount)');
  });

  test('the main graph still walks the edge into the vocabulary', () => {
    const {ddl} = generatePropertyGraph(withStatus(), TARGET);
    expect(ddl).toContain('AS hasStatus');
    expect(ddl).toContain('AS SaleStatus');
  });
});
