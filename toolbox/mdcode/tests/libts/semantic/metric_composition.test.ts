// Behavior specification for composite metrics (K6b, a proposed kcmd
// enhancement; src/libts/semantic/metric_composition.ts).
//
// The claims under test:
//
//   - A metric that is exactly one aggregate is SIMPLE: one component, under
//     the metric's own name, and the composition `{{0}}`.
//   - A formula over several aggregates is split into single-aggregate
//     COMPONENTS (each a BigQuery graph MEASURE) plus a COMPOSITION; equal
//     aggregates are one component, and an aggregate another simple metric
//     already computes reuses that metric's measure.
//   - `/` in a composition becomes SAFE_DIVIDE, with a numeric multiplier of
//     the dividend kept outside.
//   - COUNTIF, which a MEASURE cannot hold, becomes a SUM: over the K1
//     membership property when the condition is a defined entity's
//     predicate, over a CASE otherwise.
//   - What cannot be split is refused with a reason a person can act on.
//
// Nothing here opens a database.

import {describe, expect, test} from 'bun:test';

import {lowerDefinedEntities, resolveDefinedEntities} from '../../../src/libts/semantic/defined_entities';
import {Field, Metric, SemanticModel} from '../../../src/libts/semantic/ir';
import {CompositionContext, decomposeMetric, findAggregateCalls, MetricDecomposition, renderComposition, safeDivisions, simpleMetricIndex} from '../../../src/libts/semantic/metric_composition';
import {resolveInheritance} from '../../../src/libts/semantic/resolve_inheritance';

function f(name: string, column: string, type = 'String'): Field {
  return {name, expression: column, type} as Field;
}

// A fact with a numeric measure pair, a status a defined entity is carved
// out of, and a dimension it reaches many-to-one.
function model(): SemanticModel {
  return {
    name: 'shop',
    entities: [
      {
        name: 'Sale',
        dataSource: 'p.d.sale',
        keys: ['saleId'],
        fields: [
          f('saleId', 'sale_id'), f('customerId', 'customer_id'),
          f('amount', 'amount', 'Decimal'), f('quantity', 'qty', 'Integer'),
          f('status', 'status'),
        ],
      },
      {
        name: 'WonSale',
        extends: ['Sale'],
        dataSource: '',
        keys: [],
        fields: [],
        definition: {expression: "status = 'won'"},
      },
      {
        name: 'Customer',
        dataSource: 'p.d.customer',
        keys: ['customerId'],
        fields: [f('customerId', 'customer_id'), f('regionId', 'region_id')],
      },
    ],
    relationships: [{
      name: 'soldTo',
      source: {entity: 'Sale', columns: ['customerId']},
      destination: {entity: 'Customer', columns: ['customerId']},
    }],
    metrics: [
      {name: 'revenue', expression: 'SUM(Sale.amount)', entity: 'Sale'},
      {name: 'quantity_sold', expression: 'sum(Sale.quantity)', entity: 'Sale'},
    ],
  } as SemanticModel;
}

// The context the slice planner hands decomposition: lowered (defined
// entities become membership properties) and inheritance-resolved.
function contextFor(m: SemanticModel, reuse = true): CompositionContext {
  const lowered = lowerDefinedEntities(m, []);
  const resolved = resolveInheritance(lowered).model;
  const ctx: CompositionContext = {
    entityNames: (lowered.entities ?? []).map(e => e.name),
    entities: new Map((resolved.entities ?? []).map(e => [e.name, e])),
    defined: resolveDefinedEntities(m).infos,
  };
  if (reuse) ctx.simpleMetrics = simpleMetricIndex(m.metrics ?? [], ctx);
  return ctx;
}

function split(expression: string, extra: Partial<Metric> = {}, reuse = true):
    MetricDecomposition {
  const out = decomposeMetric({name: 'm', expression, ...extra}, contextFor(model(), reuse));
  if (!out.ok) throw new Error(out.reason);
  return out.value;
}

function refusal(expression: string, extra: Partial<Metric> = {}): string {
  const out = decomposeMetric({name: 'm', expression, ...extra}, contextFor(model()));
  if (out.ok) throw new Error(`expected a refusal for ${expression}`);
  return out.reason;
}

// Each component as `name = expression [@entity]`, for compact assertions.
function shape(d: MetricDecomposition): {components: string[]; template: string; simple: boolean} {
  return {
    components: d.components.map(c => `${c.name} = ${c.expression} @${c.entity}`),
    template: d.template,
    simple: d.simple,
  };
}


describe('decomposeMetric: simple metrics', () => {
  test('one aggregate is one component under the metric\'s own name', () => {
    expect(shape(split('SUM(Sale.amount)'))).toEqual({
      components: ['m = SUM(Sale.amount) @Sale'],
      template: '{{0}}',
      simple: true,
    });
  });

  test('outer parentheses and DISTINCT do not change that', () => {
    expect(shape(split('(COUNT(DISTINCT Sale.customerId))'))).toEqual({
      components: ['m = COUNT(DISTINCT Sale.customerId) @Sale'],
      template: '{{0}}',
      simple: true,
    });
  });
});


describe('decomposeMetric: composites', () => {
  test('a ratio with a multiplier: SAFE_DIVIDE, the multiplier outside, the dividend once', () => {
    const d = split('100*SUM(Sale.amount)/(SUM(Sale.amount)+SUM(Sale.quantity))', {}, false);
    expect(shape(d)).toEqual({
      components: ['m__agg1 = SUM(Sale.amount) @Sale', 'm__agg2 = SUM(Sale.quantity) @Sale'],
      template: '100 * SAFE_DIVIDE({{0}}, {{0}} + {{1}})',
      simple: false,
    });
    expect(renderComposition(d.template, i => `AGG(Sale_${d.components[i].name})`))
        .toBe('100 * SAFE_DIVIDE(AGG(Sale_m__agg1), AGG(Sale_m__agg1) + AGG(Sale_m__agg2))');
  });

  test('an aggregate a simple metric already computes reuses its measure', () => {
    // `sum(Sale.quantity)` is written in lower case: still the same aggregate.
    const d = split('SUM(Sale.amount) / SUM( Sale.quantity )');
    expect(shape(d).components).toEqual([
      'revenue = SUM(Sale.amount) @Sale',
      'quantity_sold = SUM(Sale.quantity) @Sale',
    ]);
    expect(d.components.map(c => c.reused)).toEqual([true, true]);
    expect(d.template).toBe('SAFE_DIVIDE({{0}}, {{1}})');
  });

  test('an existing SAFE_DIVIDE is kept; components may read different entities', () => {
    const d = split('100 * SAFE_DIVIDE(SUM(Sale.amount), COUNT(DISTINCT Customer.customerId))');
    expect(shape(d)).toEqual({
      components: [
        'revenue = SUM(Sale.amount) @Sale',
        'm__agg2 = COUNT(DISTINCT Customer.customerId) @Customer',
      ],
      template: '100 * SAFE_DIVIDE({{0}}, {{1}})',
      simple: false,
    });
    expect(d.entities).toEqual(['Sale', 'Customer']);
  });

  test('COUNT(*) counts the rows its siblings read, else the metric\'s entity', () => {
    expect(shape(split('SUM(Sale.amount) / COUNT(*)')).components)
        .toEqual(['revenue = SUM(Sale.amount) @Sale', 'm__agg2 = COUNT(*) @Sale']);
    expect(shape(split('COUNT(*)', {entity: 'Customer'})).components)
        .toEqual(['m = COUNT(*) @Customer']);
  });
});


describe('decomposeMetric: conditional counts', () => {
  test('a defined entity\'s predicate sums its membership property', () => {
    const d = split("100 * COUNTIF(Sale.status = 'won') / COUNT(Sale.saleId)");
    expect(shape(d)).toEqual({
      components: [
        'm__agg1 = SUM(CAST(Sale.isWonSale AS INT64)) @Sale',
        'm__agg2 = COUNT(Sale.saleId) @Sale',
      ],
      template: '100 * SAFE_DIVIDE({{0}}, {{1}})',
      simple: false,
    });
    expect(d.components[0].countIf).toEqual(
        {via: 'membership', flag: 'isWonSale', condition: "Sale.status = 'won'"});
  });

  test('the predicate matches whatever its spacing, case and parentheses', () => {
    const d = split("COUNTIF((Sale.status='won'))");
    expect(d.components[0].expression).toBe('SUM(CAST(Sale.isWonSale AS INT64))');
    expect(d.simple).toBe(true);
  });

  test('any other condition sums a CASE', () => {
    const d = split("100 * SAFE_DIVIDE(COUNTIF(LOWER(Sale.status) = 'won'), " +
        "COUNTIF(LOWER(Sale.status) IN ('won', 'lost')))");
    expect(shape(d)).toEqual({
      components: [
        "m__agg1 = SUM(CASE WHEN LOWER(Sale.status) = 'won' THEN 1 ELSE 0 END) @Sale",
        "m__agg2 = SUM(CASE WHEN LOWER(Sale.status) IN ('won', 'lost') THEN 1 ELSE 0 END) @Sale",
      ],
      template: '100 * SAFE_DIVIDE({{0}}, {{1}})',
      simple: false,
    });
    expect(d.components.map(c => c.countIf?.via)).toEqual(['case', 'case']);
  });

  test('a literal that spells an aggregate is data, not a call', () => {
    const d = split("COUNTIF(Sale.status = 'SUM(x)')");
    expect(d.components.map(c => c.expression))
        .toEqual(["SUM(CASE WHEN Sale.status = 'SUM(x)' THEN 1 ELSE 0 END)"]);
  });
});


describe('decomposeMetric: refusals', () => {
  test.each([
    ['SUM(Sale.amount) OVER ()', 'SUM(...) OVER is a window function, not an aggregate'],
    ['SUM(MAX(Sale.amount))', 'SUM(...) nests another aggregate'],
    ['STDDEV(Sale.amount)', 'STDDEV cannot be a MEASURE (a measure is one of SUM, AVG, COUNT, MIN, MAX)'],
    ['SUM(Sale.amount) + Sale.quantity', 'it reads Sale fields outside any aggregate'],
    ['Sale.amount', 'it contains no aggregate'],
    ['SUM(Sale.amount * Customer.regionId)',
     'SUM(Sale.amount * Customer.regionId) reads several entities (Sale, Customer); a MEASURE reads one table'],
    ['COUNT(*)', 'COUNT(*) names no entity, and the metric does not say which entity\'s rows it counts'],
    ['1 + 1', 'it contains no aggregate'],
  ])('%s', (expression, reason) => {
    expect(refusal(expression)).toBe(reason);
  });
});


describe('safeDivisions', () => {
  test.each([
    ['{{0}} / {{1}}', 'SAFE_DIVIDE({{0}}, {{1}})'],
    ['100 * {{0}} / ({{0}} + {{1}})', '100 * SAFE_DIVIDE({{0}}, {{0}} + {{1}})'],
    ['{{0}} * 100 / {{1}}', 'SAFE_DIVIDE({{0}}, {{1}}) * 100'],
    ['({{0}} - {{1}}) / {{0}}', 'SAFE_DIVIDE({{0}} - {{1}}, {{0}})'],
    ['{{0}} / {{1}} / {{2}}', 'SAFE_DIVIDE(SAFE_DIVIDE({{0}}, {{1}}), {{2}})'],
    ['ROUND(100 * {{0}} / {{1}}, 1)', 'ROUND(100 * SAFE_DIVIDE({{0}}, {{1}}), 1)'],
    // No division, or not plain arithmetic: left alone.
    ['100 * SAFE_DIVIDE({{0}} - {{1}}, {{0}})', '100 * SAFE_DIVIDE({{0}} - {{1}}, {{0}})'],
    ['CASE WHEN {{0}} > 0 THEN {{1}} / {{0}} END', 'CASE WHEN {{0}} > 0 THEN {{1}} / {{0}} END'],
  ])('%s', (template, expected) => {
    expect(safeDivisions(template)).toBe(expected);
  });
});


describe('findAggregateCalls', () => {
  test('finds each call with its span, skipping literals and bare column names', () => {
    const expr = "SUM(T.count) + COUNT(DISTINCT T.id) - LENGTH('MAX(1)') + T.sum";
    const found = findAggregateCalls(expr);
    if ('error' in found) throw new Error(found.error);
    expect(found.calls.map(c => ({fn: c.fn, distinct: c.distinct, operand: c.operand,
                                  text: expr.slice(c.start, c.end)})))
        .toEqual([
          {fn: 'SUM', distinct: false, operand: 'T.count', text: 'SUM(T.count)'},
          {fn: 'COUNT', distinct: true, operand: 'T.id', text: 'COUNT(DISTINCT T.id)'},
        ]);
  });

  test('refuses what it cannot split', () => {
    expect(findAggregateCalls('APPROX_QUANTILES(T.x, 4)'))
        .toEqual({error: 'APPROX_QUANTILES(...) takes several arguments'});
    expect(findAggregateCalls('SUM(T.x ORDER BY T.y)'))
        .toEqual({error: 'SUM(...) has a clause inside its parentheses'});
    expect(findAggregateCalls('SUM((T.x)')).toEqual({error: 'unbalanced parentheses'});
  });
});
