// Behavior specification for the BigQuery property-graph generator
// (src/libts/semantic/bigquery.ts).
//
// The readable "big picture" tests live in `bigquery.e2e.test.ts`: a corpus of
// `<fixture>.yaml` inputs, each with a committed
// `<fixture>.bigquery.golden.sql` showing the exact generated DDL and warnings.
// Open a `.yaml` next to its golden to see a full translation. Prefer adding a
// fixture + golden there.
//
// This file holds only what a loader fixture CANNOT express, because the open
// AI-first format the loader reads is a subset of the IR:
//   - an M:N association edge (its own backing junction table, KEY, and edge
//     properties) — the open format has no association-table syntax, so its IR
//     is hand-built here and checked against a committed golden file.
//   - IR-contract cases the loader never produces: a COUNT(*) metric with a
//     declared attach entity, and a metric whose declared entity disagrees with
//     its expression (the loader always derives the entity FROM the
//     expression).
//   - degenerate inputs the format forbids (a model with no datasets) and pure
//     GenerateOptions behavior (graph naming; a source `dataSource` is emitted
//     verbatim, never re-qualified from options).
//   - which SQL each field and metric emits, case by case, such as a dialect
//     list with no `expression` beside it.
//   - how the SQL parser reads a metric's entity and aggregate, case by case.
// Plus a structural invariant guard that parses generated DDL and asserts the
// shape BigQuery enforces for measures, run over the loaded fixtures.
//

import {beforeAll, describe, expect, test} from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import {GenerateOptions, generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {Field, Metric, SemanticModel} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';
import {generateSpannerPropertyGraph} from '../../../src/libts/semantic/spanner';
import {loadSqlEngine} from '../../../src/libts/semantic/sql_parser';

const FIXTURES = path.join(__dirname, 'fixtures');

// Loads a corpus fixture to its IR (same defaults the e2e golden suite uses),
// so the invariant guard below can run over the exact models the goldens
// capture.
function loadFixture(fixture: string): SemanticModel {
  const text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
  const {models} = loadModels(text);
  return models[0];
}
const GEN_OPTS: GenerateOptions = {
  project: 'sqlgen-testing',
  dataset: 'demo'
};


describe(
    'M:N association edge (no association-table syntax in the open format yet)',
    () => {
      // Hand-built because the loader's relationship schema is direct-FK only
      // (from/to/columns) — it cannot express an edge backed by its own
      // association table with its own KEY and edge properties. The expected
      // DDL is a committed golden file
      // (`school_manytomany.bigquery.golden.sql`) so the output stays
      // reviewable as text; these exact strings were run against a live
      // BigQuery instance and traversed with a GQL MATCH.
      const SCHOOL: SemanticModel = {
        name: 'school_graph',
        entities: [
          {
            name: 'students',
            dataSource: 'sqlgen-testing.bei_semantic_ir_verify.students',
            keys: ['student_id'],
            fields: [
              {name: 'student_id', expression: 'student_id'},
              {name: 'name', expression: 'name'}
            ]
          },
          {
            name: 'courses',
            dataSource: 'sqlgen-testing.bei_semantic_ir_verify.courses',
            keys: ['course_id'],
            fields: [
              {name: 'course_id', expression: 'course_id'},
              {name: 'title', expression: 'title'}
            ]
          },
        ],
        relationships: [
          {
            name: 'enrollment',
            source: {entity: 'students', columns: ['student_id']},
            destination: {entity: 'courses', columns: ['course_id']},
            association: {
              dataSource: 'sqlgen-testing.bei_semantic_ir_verify.enrollment',
              keys: ['enrollment_id'],
              sourceColumns: ['student_id'],
              destinationColumns: ['course_id'],
              fields: [{
                name: 'grade',
                expression: 'grade',
                description: 'Letter grade'
              }]
            }
          },
        ],
        metrics: [],
      };
      const SCHOOL_OPTS: GenerateOptions = {
        project: 'sqlgen-testing',
        dataset: 'bei_semantic_ir_verify'
      };

      test('the association graph matches its committed golden DDL', () => {
        const {ddl} = generatePropertyGraph(SCHOOL, SCHOOL_OPTS);
        const golden = fs.readFileSync(
            path.join(FIXTURES, 'school_manytomany.bigquery.golden.sql'),
            'utf8');
        expect(ddl).toBe(golden);
      });
    });


describe('IR-contract metric cases the loader cannot produce', () => {
  // A minimal one-entity model shared by the cases below. Metrics are supplied
  // per test with an explicit `entities`, which is exactly what the loader
  // never does independently of the expression.
  const orders = (): SemanticModel => ({
    name: 'm',
    relationships: [],
    metrics: [],
    entities: [{
      name: 'orders',
      dataSource: 'orders',
      keys: ['o_orderkey'],
      fields: [{name: 'o_orderkey', expression: 'o_orderkey'}]
    }],
  });

  test(
      'COUNT(*) with a declared attach entity lowers to COUNT over the key property',
      () => {
        // COUNT(*) names no column, so it relies on the metric's declared
        // attach entity. The loader always derives the entity from the
        // expression, so a qualifier-free COUNT(*) gets entity:undefined there
        // and is skipped; a producer that declares the attach entity (or
        // hand-built IR) reaches this lowering.
        const model = orders();
        model.metrics =
            [{name: 'order_count', expression: 'COUNT(*)', entity: 'orders'}];
        const {ddl} = generatePropertyGraph(model, GEN_OPTS);
        expect(ddl).toContain('MEASURE(COUNT(o_orderkey)) AS order_count');
      });

  // COUNT(*) counts the key column itself. A key names a column, never a field,
  // so a field of the same name neither supplies the counted value nor drops
  // the metric.
  describe('COUNT(*) counts the key column', () => {
    const keyedByOrderId = (field: Field): SemanticModel => ({
      ...orders(),
      entities: [{
        name: 'orders',
        dataSource: 'orders',
        keys: ['order_id'],
        fields: [field],
      }],
      metrics: [{name: 'order_count', expression: 'COUNT(*)', entity: 'orders'}],
    });

    test('not a same-named field that reads another column', () => {
      const {ddl} = generatePropertyGraph(
          keyedByOrderId(
              {name: 'order_id', expression: 'orders.legacy_ref'}),
          GEN_OPTS);
      expect(ddl).toContain('KEY(order_id)');
      expect(ddl).toContain('order_id AS order_count_input');
      expect(ddl).toContain(
          'MEASURE(COUNT(order_count_input)) AS order_count');
    });

    test('when a same-named field has no BigQuery SQL', () => {
      const {ddl, warnings} = generatePropertyGraph(
          keyedByOrderId({
            name: 'order_id',
            dialects: [{dialect: 'SNOWFLAKE', expression: 'legacy_ref::text'}],
            importedExpression: 'legacy_ref::text',
            importedDialect: 'SNOWFLAKE',
          }),
          GEN_OPTS);
      expect(ddl).toContain(
          'MEASURE(COUNT(order_count_input)) AS order_count');
      expect(warnings.filter(w => w.includes('aggregates field'))).toEqual([]);
    });

    test('quoted when BigQuery cannot read it bare', () => {
      const model = orders();
      model.entities[0].keys = ['2nd_id'];
      model.metrics =
          [{name: 'order_count', expression: 'COUNT(*)', entity: 'orders'}];
      const {ddl} = generatePropertyGraph(model, GEN_OPTS);
      expect(ddl).toContain('`2nd_id` AS order_count_input');
    });

    test('in one property that a later metric over the column reuses', () => {
      const model = orders();
      model.entities[0].keys = ['o_key'];
      model.metrics = [
        {name: 'n', expression: 'COUNT(*)', entity: 'orders'},
        {name: 'm', expression: 'COUNT(DISTINCT orders.o_key)', entity: 'orders'},
      ];
      const {ddl} = generatePropertyGraph(model, GEN_OPTS);
      expect(ddl).toContain('MEASURE(COUNT(o_key)) AS n');
      expect(ddl).toContain('MEASURE(COUNT(DISTINCT o_key)) AS m');
      expect(ddl).not.toContain('_input');
    });

    test('while a later metric over a same-named field still reads the field', () => {
      const model = keyedByOrderId(
          {name: 'order_id', expression: 'orders.legacy_ref'});
      model.metrics.push({
        name: 'distinct_refs',
        expression: 'COUNT(DISTINCT orders.order_id)',
        entity: 'orders'
      });
      const {ddl} = generatePropertyGraph(model, GEN_OPTS);
      expect(ddl).toContain(
          'MEASURE(COUNT(order_count_input)) AS order_count');
      // The field's SQL, since a measure that named `order_id` would name the
      // key column too, which BigQuery rejects as ambiguous.
      expect(ddl).toContain(
          '      legacy_ref,\n' +
          '      MEASURE(COUNT(order_count_input)) AS order_count,\n' +
          '      MEASURE(COUNT(DISTINCT legacy_ref)) AS distinct_refs\n');
    });
  });

  test('a key named like a field bound to a computed expression stays the column', () => {
    // A KEY / SOURCE KEY / REFERENCES site must name a bare column, and a key
    // names one, never a field. So the same-named field's computed expression
    // does not reach KEY, and nothing is warned.
    const model = orders();
    model.entities[0].fields[0].expression = 'CONCAT(orders.a, orders.b)';
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain('KEY(o_orderkey)');
    expect(ddl).not.toContain('KEY(CONCAT');
    expect(warnings.filter(w => w.includes('key or join column'))).toEqual([]);
  });

  test(
      'an unbound field (no column) is omitted from the node table with a warning',
      () => {
        // Availability pruning normally removes unbound fields; generating DDL
        // without pruning (e.g. straight from a bindingOptional load) must not
        // emit the field as a phantom bare column.
        const model = orders();
        model.entities[0].fields.push({name: 'notes'});  // no expression/binding
        const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(ddl).not.toContain('notes');
        expect(warnings.some(
                   w => w.includes('notes') && w.includes('no column')))
            .toBe(true);
      });

  test(
      'a metric whose declared entity disagrees with its expression is reported',
      () => {
        // Declared entity:'orders' but the expression aggregates a different
        // known entity (order_items); the generator places per the expression
        // and surfaces the discrepancy rather than resolving it silently. The
        // loader cannot create this state (it sets entity FROM the expression).
        const model = orders();
        model.entities.push({
          name: 'order_items',
          dataSource: 'order_items',
          keys: ['order_item_id'],
          fields: [
            {name: 'order_item_id', expression: 'order_item_id'}
          ],
        });
        model.metrics = [{
          name: 'mislabeled',
          expression: 'SUM(order_items.amount)',
          entity: 'orders'
        }];
        const {warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(warnings.some(
                   w => w.includes('metric \'mislabeled\'') &&
                       w.includes('declares entity')))
            .toBe(true);
      });

  test(
      'a metric that spans tables is skipped without a contradictory "placing" note',
      () => {
        // A declared entity that ALSO spans multiple tables must not first be
        // announced as "placing per the expression" and then skipped: the
        // disagreement note is only meaningful when the metric is actually
        // placed on a single table.
        const model = orders();
        model.entities.push({
          name: 'order_items',
          dataSource: 'order_items',
          keys: ['order_item_id'],
          fields: [
            {name: 'order_item_id', expression: 'order_item_id'}
          ],
        });
        model.metrics = [{
          name: 'cross',
          expression: 'SUM(orders.amount) + SUM(order_items.amount)',
          entity: 'orders',
        }];
        const {warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(warnings.some(w => w.includes('spans multiple tables')))
            .toBe(true);
        expect(warnings.some(w => w.includes('placing per the expression')))
            .toBe(false);
      });

  test(
      'a metric on a keyless (skipped) entity is dropped with a KEY-specific reason',
      () => {
        // The entity has no primary key, so it has no node table to carry a
        // MEASURE. The skip reason must name the missing KEY, not a misleading
        // "cannot be a measure".
        const model = orders();
        model.entities.push(
            {name: 'dim', dataSource: 'dim', keys: [], fields: []});
        model.metrics = [{name: 'dim_total', expression: 'SUM(dim.amount)'}];
        const {warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(warnings.some(
                   w => w.includes('metric \'dim_total\'') &&
                       w.includes('has no KEY')))
            .toBe(true);
        expect(warnings.some(
                   w => w.includes('metric \'dim_total\'') &&
                       w.includes('cannot be a measure')))
            .toBe(false);
      });

  test(
      'a backtick-quoted operand with an embedded comma is one operand, not a multi-arg call',
      () => {
        // The SQL parser reads a column like `weird,name` as one name, so it
        // is not mistaken for two aggregate arguments and dropped.
        const model = orders();
        model.metrics = [{
          name: 'weird_sum',
          expression: 'SUM(orders.`weird,name`)',
          entity: 'orders'
        }];
        const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(warnings.some(
                   w => w.includes('metric \'weird_sum\'') &&
                       w.includes('cannot be a measure')))
            .toBe(false);
        expect(ddl).toContain('AS weird_sum');
      });

  test(
      'a measure over a struct path whose subfield matches another entity name is placed on the leading qualifier entity',
      () => {
        const model = orders();
        model.entities.push({
          name: 'customer',
          dataSource: 'customer',
          keys: ['c_id'],
          fields: [{name: 'c_id', expression: 'c_id'}],
        });
        model.metrics = [{
          name: 'cust_amount',
          expression: 'SUM(orders.customer.amount)',
          entity: 'orders',
        }];
        const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(warnings.some(w => w.includes('spans multiple tables')))
            .toBe(false);
        expect(ddl).toContain('customer.amount AS cust_amount_input');
        expect(ddl).toContain('MEASURE(SUM(cust_amount_input)) AS cust_amount');
      });
});

describe('the SQL parser reads a metric\'s entity and aggregate', () => {
  // orders, keyed on its column, with a field bound to another column.
  const model = (...metrics: SemanticModel['metrics']): SemanticModel => ({
    name: 'm',
    relationships: [],
    metrics,
    entities: [
      {
        name: 'orders',
        dataSource: 'p.d.orders',
        keys: ['o_id'],
        fields: [
          {name: 'o_id', expression: 'o_id'},
          {name: 'buyer', expression: 'customer_id'},
          {name: 'url', expression: 'url'},
        ],
      },
      {
        name: 'NET',
        dataSource: 'p.d.net',
        keys: ['n_id'],
        fields: [{name: 'n_id', expression: 'n_id'}],
      },
    ],
  });

  test('COUNT(DISTINCT(x)) lowers to a valid measure', () => {
    // The parentheses are the operand's, so the measure counts distinct
    // buyers, through the column `buyer` reads. Read with patterns, the operand
    // was `DISTINCT(buyer)`, which gave the input property `DISTINCT(buyer) AS
    // buyers_input` and the measure `COUNT(buyers_input)`, which BigQuery
    // rejects.
    const {ddl, warnings} = generatePropertyGraph(model(
        {name: 'buyers', expression: 'COUNT(DISTINCT(orders.buyer))'},
        {name: 'sites', expression: 'COUNT(DISTINCT (orders.url || orders.o_id))'},
    ), GEN_OPTS);
    expect(warnings).toEqual([]);
    expect(ddl).toContain('MEASURE(COUNT(DISTINCT customer_id)) AS buyers');
    expect(ddl).toContain('url || o_id AS sites_input');
    expect(ddl).toContain('MEASURE(COUNT(DISTINCT sites_input)) AS sites');
    expect(ddl).not.toContain('DISTINCT(');
  });

  test('ALL is the default, so it lowers to the plain aggregate', () => {
    // Read with patterns, it gave the input property `ALL o_id AS ...`.
    const {ddl, warnings} = generatePropertyGraph(
        model({name: 'orders_seen', expression: 'COUNT(ALL orders.o_id)'}),
        GEN_OPTS);
    expect(warnings).toEqual([]);
    expect(ddl).toContain('MEASURE(COUNT(o_id)) AS orders_seen');
  });

  test('a function namespace named like an entity is not that entity', () => {
    // Read with patterns, `NET.` made the metric span NET and orders.
    const {ddl, warnings} = generatePropertyGraph(model(
        {name: 'hosts', expression: 'COUNT(DISTINCT NET.HOST(orders.url))'},
    ), GEN_OPTS);
    expect(warnings).toEqual([]);
    expect(ddl).toContain('NET.HOST(url) AS hosts_input');
    expect(ddl).toContain('MEASURE(COUNT(DISTINCT hosts_input)) AS hosts');
  });

  test('a qualifier the parser reserves as a keyword still places the measure', () => {
    const {ddl, warnings} = generatePropertyGraph({
      name: 'm',
      relationships: [],
      metrics: [{name: 'total_days', expression: 'SUM(Date.days)'}],
      entities: [{
        name: 'Date',
        dataSource: 'p.d.dates',
        keys: ['d_id'],
        fields: [{name: 'd_id', expression: 'd_id'}],
      }],
    }, GEN_OPTS);
    expect(warnings).toEqual([]);
    expect(ddl).toContain('MEASURE(SUM(days)) AS total_days');
  });
});


describe('a metric that combines aggregates on one entity lowers to one measure', () => {
  // orders, keyed on its column, with a field bound to another column, and
  // customers.
  const model = (...metrics: SemanticModel['metrics']): SemanticModel => ({
    name: 'm',
    relationships: [],
    metrics,
    entities: [
      {
        name: 'orders',
        dataSource: 'p.d.orders',
        keys: ['order_id'],
        fields: [
          {name: 'order_id', expression: 'order_id'},
          {name: 'amount', expression: 'amount'},
          {name: 'status', expression: 'status'},
          {name: 'net', expression: 'net_amount'},
        ],
      },
      {
        name: 'customers',
        dataSource: 'p.d.customers',
        keys: ['c_id'],
        fields: [{name: 'c_id', expression: 'c_id'}],
      },
    ],
  });
  // The properties of the orders node table, one per line.
  const ordersProperties = (ddl: string) => {
    const lines = ddl.slice(ddl.indexOf('PROPERTIES(') + 'PROPERTIES('.length)
                      .split('\n')
                      .map(line => line.trim())
                      .filter(line => line);
    return lines.slice(0, lines.findIndex(line => line.startsWith(')')));
  };

  test('a ratio, a scaled aggregate, SAFE_DIVIDE and CASE over aggregates', () => {
    const {ddl, warnings} = generatePropertyGraph(model(
        {
          name: 'avg_order_value',
          expression: 'SUM(orders.amount) / COUNT(orders.order_id)'
        },
        {name: 'revenue_k', expression: 'SUM(orders.amount) / 1000'},
        {
          name: 'fulfilled_share',
          expression: 'SAFE_DIVIDE(SUM(IF(orders.status = \'😀\', ' +
              'orders.amount, 0)), SUM(orders.amount))'
        },
        {
          name: 'aov_safe',
          expression: 'CASE WHEN COUNT(orders.order_id) = 0 THEN NULL ' +
              'ELSE SUM(orders.amount) / COUNT(orders.order_id) END'
        },
    ), GEN_OPTS);
    expect(warnings).toEqual([]);
    expect(ordersProperties(ddl)).toEqual([
      'order_id,',
      'amount,',
      'status,',
      'net_amount AS net,',
      'IF(status = \'😀\', amount, 0) AS fulfilled_share_input,',
      'MEASURE(SUM(amount) / COUNT(order_id)) AS avg_order_value,',
      'MEASURE(SUM(amount) / 1000) AS revenue_k,',
      'MEASURE(SAFE_DIVIDE(SUM(fulfilled_share_input), SUM(amount))) AS ' +
          'fulfilled_share,',
      'MEASURE(CASE WHEN COUNT(order_id) = 0 THEN NULL ELSE SUM(amount) / ' +
          'COUNT(order_id) END) AS aov_safe',
    ]);
  });

  test('each operand is exposed the way a single aggregate\'s operand is', () => {
    const {ddl, warnings} = generatePropertyGraph(model(
        // Two aggregates over one field share its property.
        {name: 'range', expression: 'MAX(orders.amount) - MIN(orders.amount)'},
        // Two different inline operands get one property each, and a later
        // metric's same operand reuses the first.
        {
          name: 'm',
          expression: 'SUM(orders.amount * 2) / SUM(orders.amount + 1)'
        },
        {name: 'n', expression: 'AVG(orders.amount + 1) * 2'},
        // A field bound to another column aggregates that column.
        {name: 'net_per_order', expression: 'SUM(orders.net) / COUNT(*)'},
        {
          name: 'distinct_share',
          expression: 'COUNT(DISTINCT orders.status) / COUNT(orders.status)'
        },
        // A sign before an aggregate is not part of it.
        {
          name: 'signed',
          expression: 'SUM(orders.amount) * +(COUNT(orders.order_id))'
        },
    ), GEN_OPTS);
    expect(warnings).toEqual([]);
    expect(ordersProperties(ddl).slice(4)).toEqual([
      'amount * 2 AS m_input,',
      'amount + 1 AS m_input_2,',
      'net_amount,',
      'MEASURE(MAX(amount) - MIN(amount)) AS `range`,',
      'MEASURE(SUM(m_input) / SUM(m_input_2)) AS m,',
      'MEASURE(AVG(m_input_2) * 2) AS n,',
      'MEASURE(SUM(net_amount) / COUNT(order_id)) AS net_per_order,',
      'MEASURE(COUNT(DISTINCT status) / COUNT(status)) AS distinct_share,',
      'MEASURE(SUM(amount) * +(COUNT(order_id))) AS signed',
    ]);
  });

  test('a qualifier the parser reserves as a keyword leaves no stand-in behind', () => {
    const {ddl, warnings} = generatePropertyGraph({
      name: 'm',
      relationships: [],
      metrics: [{
        name: 'avg_days',
        expression: 'SUM(Date.days) / COUNT(DISTINCT Date.d_id)'
      }],
      entities: [{
        name: 'Date',
        dataSource: 'p.d.dates',
        keys: ['d_id'],
        fields: [{name: 'd_id', expression: 'd_id'}],
      }],
    }, GEN_OPTS);
    expect(warnings).toEqual([]);
    expect(ddl).toContain(
        'MEASURE(SUM(days) / COUNT(DISTINCT d_id)) AS avg_days');
  });

  test('a metric that cannot be a measure is skipped with the reason push gives', () => {
    for (const [expression, body, why] of [
           ['orders.amount - SUM(orders.status)', 'amount - SUM(status)',
            'it reads field \'amount\' outside an aggregate'],
           ['STDDEV(orders.amount)', 'STDDEV(amount)',
            'it uses STDDEV, which BigQuery does not allow in a measure ' +
                '(SUM, AVG, COUNT, MIN, MAX)'],
           ['SUM(MAX(orders.amount))', 'SUM(MAX(amount))',
            'it nests an aggregate, a window or a subquery'],
           ['SUM(orders.amount) OVER ()', 'SUM(amount) OVER ()',
            'it uses a window or a subquery'],
           ['MIN(orders.amount, orders.net)', 'MIN(amount, net)',
            'it calls MIN with 2 operands, where an aggregate in a measure ' +
                'takes one'],
           ['orders.amount * 2', 'amount * 2',
            'it holds no aggregate (SUM, AVG, COUNT, MIN, MAX)'],
           ['`p.ds.safe_ratio`(SUM(orders.amount), COUNT(orders.order_id))',
            '`p.ds.safe_ratio`(SUM(amount), COUNT(order_id))',
            'it calls user-defined function \'p.ds.safe_ratio\' outside an ' +
                'aggregate, which BigQuery cannot read in a measure'],
           ['ds.f(SUM(orders.amount))', 'ds.f(SUM(amount))',
            'it calls user-defined function \'ds.f\' outside an aggregate, ' +
                'which BigQuery cannot read in a measure'],
         ]) {
      const {ddl, warnings} = generatePropertyGraph(
          model({name: 'm', expression, entity: 'orders'}), GEN_OPTS);
      expect({expression, warnings}).toEqual({
        expression,
        warnings: [`metric 'm' expression '${body}' cannot be a measure: ${
            why}; skipped`],
      });
      expect(ddl).not.toContain('MEASURE(');
    }
  });

  test('an operand it cannot read skips the metric before any is exposed', () => {
    const withLegacy = model(
        {name: 'm', expression: 'SUM(orders.amount * 2) / SUM(orders.legacy)'});
    withLegacy.entities[0].fields.push({
      name: 'legacy',
      dialects: [{dialect: 'SNOWFLAKE', expression: 'legacy::text'}],
    });
    const {ddl, warnings} = generatePropertyGraph(withLegacy, GEN_OPTS);
    expect(warnings).toContain(
        'metric \'m\' aggregates field \'legacy\', which has no ' +
        '\'BIGQUERY\' or \'ANSI_SQL\' expression; skipped (nothing to emit ' +
        'as a MEASURE)');
    expect(ddl).not.toContain('m_input');
  });

  test('a ratio over two entities gets only the warning that it spans multiple tables', () => {
    const {warnings} = generatePropertyGraph(model({
      name: 'm',
      expression: 'SUM(orders.amount) / COUNT(customers.c_id)'
    }), GEN_OPTS);
    expect(warnings).toEqual([
      'metric \'m\' spans multiple tables (orders, customers); skipped ' +
          '(cannot be a single MEASURE)',
    ]);
  });
});


describe('degenerate inputs and GenerateOptions behavior', () => {
  test(
      'a model with no entities throws, rather than emit an empty (invalid) graph',
      () => {
        // The open format requires datasets.min(1), so this state is only
        // reachable as hand-built IR. A graph with an empty NODE TABLES block
        // is invalid DDL, so generation fails loudly instead of returning it.
        expect(
            () => generatePropertyGraph(
                {name: 'm', entities: [], relationships: [], metrics: []},
                GEN_OPTS))
            .toThrow(
                /no valid node table|declares no entities|at least one NODE TABLE/);
      });

  test(
      'a model whose every entity lacks a KEY throws, naming the skipped entities',
      () => {
        // Every entity is keyless, so all are skipped and no node table
        // remains; the emitted graph would be empty and invalid. The error
        // carries the per-entity skip reasons so the caller sees why each
        // dropped out.
        expect(
            () => generatePropertyGraph(
                {
                  name: 'm',
                  relationships: [],
                  metrics: [],
                  entities: [
                    {name: 'a', dataSource: 'a', keys: [], fields: []},
                    {name: 'b', dataSource: 'b', keys: [], fields: []},
                  ],
                },
                GEN_OPTS))
            .toThrow(
                /every entity was skipped[\s\S]*entity 'a'[\s\S]*entity 'b'/);
      });

  test(
      'a model whose every entity is abstract throws, blaming abstractness not a missing KEY',
      () => {
        // An abstract entity is a table-less supertype that forms no node table
        // by design. When every entity is abstract, the failure must name that
        // cause rather than misdiagnose it as a missing primary key.
        expect(
            () => generatePropertyGraph(
                {
                  name: 'm',
                  relationships: [],
                  metrics: [],
                  entities: [
                    {
                      name: 'a',
                      dataSource: '',
                      keys: [],
                      fields: [],
                      abstract: true
                    },
                    {
                      name: 'b',
                      dataSource: '',
                      keys: [],
                      fields: [],
                      abstract: true
                    },
                  ],
                },
                GEN_OPTS))
            .toThrow(/every entity is abstract/);
      });

  test(
      'graph name falls back to options, but a dataSource is emitted as-is',
      () => {
        // opts.project/dataset name where the graph is CREATED (the graph
        // name), NOT where a source table lives: the entity's `dataSource` is
        // emitted verbatim, never re-prefixed from opts.
        const model: SemanticModel = {
          name: 'm',
          relationships: [],
          metrics: [],
          entities: [{
            name: 'e',
            dataSource: 't',
            keys: ['id'],
            fields: [{name: 'id', expression: 'id'}]
          }],
        };
        const {ddl} = generatePropertyGraph(
            model, {project: 'p', dataset: 'd', graphName: 'g'});
        expect(ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH `p.d.g`');
        expect(ddl).toContain('`t` AS e');  // as-is, NOT `p.d.t`
      });

  test(
      'a fully-qualified dataSource is never overridden by the graph\'s options',
      () => {
        // Source location and graph location are independent: a graph created
        // in one project/dataset may reference tables that live elsewhere. The
        // emitter must not rewrite the source table's own qualification.
        const model: SemanticModel = {
          name: 'm',
          relationships: [],
          metrics: [],
          entities: [
            {name: 'e', dataSource: 'samples.tpch.t', keys: ['id'], fields: []}
          ],
        };
        const {ddl} =
            generatePropertyGraph(model, {project: 'p', dataset: 'd'});
        expect(ddl).toContain('`samples.tpch.t` AS e');
      });

  test(
      'a project without a dataset does not produce a malformed `project.name`',
      () => {
        // A graph name is `name`, `dataset.name`, or `project.dataset.name`.
        // When only a project is known (no dataset in opts, and the first
        // entity's dataSource is bare so none can be derived), the lone project
        // is dropped rather than emitted as `p.g`, which BigQuery would read as
        // `dataset.name`.
        const model: SemanticModel = {
          name: 'm',
          relationships: [],
          metrics: [],
          entities: [{
            name: 'e',
            dataSource: 't',
            keys: ['id'],
            fields: [{name: 'id', expression: 'id'}]
          }],
        };
        const {ddl} =
            generatePropertyGraph(model, {project: 'p', graphName: 'g'});
        expect(ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH `g`');
        expect(ddl).not.toContain('`p.g`');
      });

  test(
      'a dataSource whose table name contains spaces is backtick-quoted without a query warning',
      () => {
        const model: SemanticModel = {
          name: 'm',
          relationships: [],
          metrics: [],
          entities: [{
            name: 'order_items',
            dataSource: 'acme.sales.order items',
            keys: ['id'],
            fields: [{name: 'id', expression: 'id'}]
          }],
        };
        const {ddl, warnings} = generatePropertyGraph(model);
        expect(warnings).toEqual([]);
        expect(ddl).toContain('`acme.sales.order items` AS order_items');
      });
});


describe('a BigLake source', () => {
  // Loaded rather than hand-built, so the test covers the loader's half too:
  // it reads a BigLake resource name into the four-part name BigQuery gives a
  // Lakehouse table, `<project>.<catalog>.<namespace>.<table>`.
  beforeAll(loadSqlEngine);

  test('is written as a BigQuery source is, one name in backticks', () => {
    const {models} = loadModels(`version: "0.2.0.dev0/google"
semantic_model:
  - name: lake
    entities:
      - name: orders
        source: biglake.googleapis.com/projects/acme/catalogs/lakehouse/namespaces/sales/tables/orders
        primary_key: [order_id]
        fields:
          - {name: order_id, expression: order_id}
          - {name: customer_id, expression: customer_id}
      - name: customers
        source: bigquery.googleapis.com/projects/acme/datasets/crm/tables/customers
        primary_key: [customer_id]
        fields:
          - {name: customer_id, expression: customer_id}
    relationships:
      - name: placed_by
        from: orders
        to: customers
        from_columns: [customer_id]
        to_columns: [customer_id]
`);
    const {ddl, warnings} =
        generatePropertyGraph(models[0], {project: 'acme', dataset: 'graphs'});
    expect(warnings).toEqual([]);
    // Its node table and the edge it backs both read it.
    expect(ddl).toContain('\n  `acme.lakehouse.sales.orders` AS orders\n');
    expect(ddl).toContain('\n  `acme.lakehouse.sales.orders` AS placed_by\n');
    expect(ddl).toContain('\n  `acme.crm.customers` AS customers\n');
  });
});


describe('descriptive metadata: structured synonyms and ai_context extensions', () => {
  // A two-entity model with an FK edge and an M:N association edge, exercising
  // ai_context on every element kind (entity label, node field property, M:N
  // edge property, measure, 1:N and M:N edge labels) plus the model. BigQuery's
  // PropertyGraph{Label,Property}Options carry structured `synonyms` and
  // `extensions` (`ARRAY<STRUCT<STRING, STRING>>`) options, so `synonyms` emits
  // as `synonyms=[...]` and `instructions`/`examples` emit as `(key, value)`
  // pairs in `extensions=[...]` instead of folding into `description`.
  const model = (): SemanticModel => ({
    name: 'm',
    description: 'MODEL_LEVEL_DESC',
    aiContext: {
      instructions: 'model help',
      synonyms: ['modelsyn'],
      examples: ['model example'],
    },
    entities: [
      {
        name: 'orders',
        dataSource: 'orders',
        keys: ['o_orderkey'],
        description: 'the orders',
        aiContext: {
          instructions: 'one row per order',
          synonyms: ['ord', 'purchase'],
          examples: ['how many orders?'],
        },
        fields: [
          {name: 'o_orderkey', expression: 'o_orderkey'},
          {
            name: 'amount',
            expression: 'amount',
            label: 'Order amount',
            description: 'Gross order value',
            aiContext: {
              instructions: 'In USD.',
              synonyms: ['total', 'value'],
              examples: ['100.00', '250.50'],
            },
          },
          {
            name: 'segment',
            expression: 'segment',
            description: 'Marketing segment',
            aiContext: {
              synonyms: ['tier'],
              examples: ['gold', 'silver'],
            },
          },
          {
            name: 'order_date',
            expression: 'order_date',
            type: 'Date',
            dimension: {isTime: true},
            description: 'Date placed',
            aiContext: {instructions: 'UTC calendar date.'},
          },
        ],
      },
      {
        name: 'customers',
        dataSource: 'customers',
        keys: ['c_custkey'],
        fields: [{name: 'c_custkey', expression: 'c_custkey'}],
      },
    ],
    relationships: [
      {
        name: 'placed_by',
        source: {entity: 'orders', columns: ['o_custkey']},
        destination: {entity: 'customers', columns: ['c_custkey']},
        description: 'Buyer link',
        aiContext: {
          instructions: 'Join orders to buyer.',
          synonyms: ['belongs to'],
          examples: ['orders by customer'],
        },
      },
      {
        name: 'tagged_for',
        source: {entity: 'orders', columns: ['o_orderkey']},
        destination: {entity: 'customers', columns: ['c_custkey']},
        aiContext: {
          instructions: 'Shared account tag.',
          examples: ['co-buyers'],
        },
        association: {
          dataSource: 'order_customer_tags',
          keys: ['tag_id'],
          sourceColumns: ['o_orderkey'],
          destinationColumns: ['c_custkey'],
          fields: [{
            name: 'tier_override',
            expression: 'tier_override',
            aiContext: {examples: ['gold', 'silver']},
          }],
        },
      },
    ],
    metrics: [{
      name: 'total_amount',
      expression: 'SUM(orders.amount)',
      entity: 'orders',
      description: 'Sum of order amounts',
      aiContext: {
        instructions: 'Exclude cancelled orders.',
        synonyms: ['revenue', 'sales'],
        examples: ['total revenue last quarter'],
      },
    }],
  });

  test(
      'synonyms are a structured array on every element, not folded into description',
      () => {
        const {ddl} = generatePropertyGraph(model(), GEN_OPTS);
        // Entity label, field property, measure, and edge label each carry a
        // structured `synonyms=[...]` array.
        expect(ddl).toContain('synonyms=["ord", "purchase"]');
        expect(ddl).toContain('synonyms=["total", "value"]');
        expect(ddl).toContain('synonyms=["revenue", "sales"]');
        expect(ddl).toContain('synonyms=["belongs to"]');
        // The legacy folded "Synonyms: ..." text is gone entirely.
        expect(ddl).not.toContain('Synonyms:');
      });

  test(
      'instructions and examples emit in OPTIONS(extensions=[...]) on every element kind, not folded into description',
      () => {
        const {ddl} = generatePropertyGraph(model(), GEN_OPTS);
        // Entity DEFAULT LABEL: separate description, synonyms and extensions.
        expect(ddl).toContain(
            '    OPTIONS(description="the orders", synonyms=["ord", "purchase"], ' +
            'extensions=[("instructions", "one row per order"), ' +
            '("examples", "[\\"how many orders?\\"]")])\n');
        // Node field with label, description, synonyms, instructions and
        // examples.
        expect(ddl).toContain(
            '      amount OPTIONS(description="Order amount\\n\\nGross order value", ' +
            'synonyms=["total", "value"], ' +
            'extensions=[("instructions", "In USD."), ' +
            '("examples", "[\\"100.00\\",\\"250.50\\"]")]),\n');
        // Node field with examples=["gold", "silver"] and no instructions.
        expect(ddl).toContain(
            '      segment OPTIONS(description="Marketing segment", ' +
            'synonyms=["tier"], ' +
            'extensions=[("examples", "[\\"gold\\",\\"silver\\"]")]),\n');
        // Temporal dimension field: `Time dimension.` still folds into
        // description while `instructions` goes to extensions.
        expect(ddl).toContain(
            '      order_date OPTIONS(description="Time dimension.\\n\\nDate placed", ' +
            'extensions=[("instructions", "UTC calendar date.")]),\n');
        // Metric MEASURE(...) AS <metric> with description, synonyms and
        // extensions.
        expect(ddl).toContain(
            '      MEASURE(SUM(amount)) AS total_amount OPTIONS(' +
            'description="Sum of order amounts", synonyms=["revenue", "sales"], ' +
            'extensions=[("instructions", "Exclude cancelled orders."), ' +
            '("examples", "[\\"total revenue last quarter\\"]")])\n');
        // 1:N relationship DEFAULT LABEL with description, synonyms and
        // extensions.
        expect(ddl).toContain(
            '    OPTIONS(description="Buyer link", synonyms=["belongs to"], ' +
            'extensions=[("instructions", "Join orders to buyer."), ' +
            '("examples", "[\\"orders by customer\\"]")])\n');
        // M:N relationship DEFAULT LABEL and M:N edge property.
        expect(ddl).toContain(
            '    OPTIONS(extensions=[("instructions", "Shared account tag."), ' +
            '("examples", "[\\"co-buyers\\"]")])\n');
        expect(ddl).toContain(
            '      tier_override OPTIONS(extensions=[("examples", "[\\"gold\\",\\"silver\\"]")])\n');
        // Legacy `Examples:` line is gone from descriptions everywhere.
        expect(ddl).not.toContain('Examples:');
      });

  test(
      'elements with only instructions or only examples emit OPTIONS(extensions=[...]), and blank/custom-only ai_context emits nothing',
      () => {
        const onlyExtensions: SemanticModel = {
          name: 'm',
          entities: [{
            name: 'orders',
            dataSource: 'orders',
            keys: ['id'],
            aiContext: {instructions: '  Exclude test accounts.\n'},
            fields: [
              {
                name: 'id',
                expression: 'id',
                aiContext: {
                  instructions: '   \n\t  ',
                  examples: [],
                  additionalProperties: {custom_hint: 'internal-only'},
                },
              },
              {
                name: 'status',
                expression: 'status',
                // `examples` items are kept verbatim, whitespace included.
                aiContext: {examples: ['open', 'closed', '  ']},
              },
            ],
          }],
          relationships: [],
          metrics: [{
            name: 'order_count',
            expression: 'COUNT(*)',
            entity: 'orders',
            aiContext: {instructions: 'Count distinct orders.'},
          }],
        };
        const {ddl} = generatePropertyGraph(onlyExtensions, GEN_OPTS);
        expect(ddl).toContain(
            '    OPTIONS(extensions=[("instructions", "Exclude test accounts.")])\n');
        expect(ddl).toContain('      id,\n');
        expect(ddl).not.toContain('id OPTIONS');
        expect(ddl).toContain(
            '      status OPTIONS(extensions=[("examples", ' +
            '"[\\"open\\",\\"closed\\",\\"  \\"]")]),\n');
        expect(ddl).toContain(
            '      MEASURE(COUNT(id)) AS order_count ' +
            'OPTIONS(extensions=[("instructions", "Count distinct orders.")])\n');
        expect(ddl).not.toContain('custom_hint');
        expect(ddl).not.toContain('internal-only');
      });

  test(
      'special characters in instructions and examples serialize losslessly inside BigQuery string literals',
      () => {
        const trickyExamples = [
          'semi; colon',
          'quote "inside" text',
          'back\\slash\\path',
          'line1\nline2\r\tend',
        ];
        const trickyInstructions =
            'Use "UTC"\\ISO dates;\nignore\ttest\raccounts.';
        const special: SemanticModel = {
          name: 'm',
          entities: [{
            name: 'orders',
            dataSource: 'orders',
            keys: ['id'],
            aiContext: {
              instructions: trickyInstructions,
              examples: trickyExamples,
            },
            fields: [{name: 'id', expression: 'id'}],
          }],
          relationships: [],
          metrics: [],
        };
        const {ddl} = generatePropertyGraph(special, GEN_OPTS);
        // Read the two SQL string literals back out of extensions=[...] and
        // unescape them to check the round-trip.
        const unescapeSqlString = (literal: string): string =>
            literal.replace(/\\([\\"nrt])/g, (_, ch: string) => {
              switch (ch) {
                case 'n':
                  return '\n';
                case 'r':
                  return '\r';
                case 't':
                  return '\t';
                default:
                  return ch;
              }
            });
        const match = ddl.match(
            /extensions=\[\("instructions", "((?:\\.|[^"\\])*)"\), \("examples", "((?:\\.|[^"\\])*)"\)\]/);
        expect(match).not.toBeNull();
        expect(unescapeSqlString(match![1])).toBe(trickyInstructions);
        expect(JSON.parse(unescapeSqlString(match![2]))).toEqual(trickyExamples);
        // Raw unescaped newlines/tabs/CRs never leak into the OPTIONS line.
        const optsLine = ddl.split('\n').find(l => l.includes('extensions=['))!;
        expect(optsLine).not.toContain('\r');
        expect(optsLine).not.toContain('\t');
      });

  test(
      'custom ai_context members stay out of the DDL, model-level metadata is omitted, and Spanner DDL stays unchanged',
      () => {
        const m = model();
        m.entities[0].fields[1].aiContext!.additionalProperties = {
          custom_hint: 'prioritize verified orders',
        };
        const {ddl} = generatePropertyGraph(m, GEN_OPTS);
        expect(ddl).not.toContain('custom_hint');
        expect(ddl).not.toContain('prioritize verified orders');
        expect(ddl).not.toContain('MODEL_LEVEL_DESC');
        expect(ddl).not.toContain('model help');
        expect(ddl).not.toContain('modelsyn');
        expect(ddl).not.toContain('model example');

        const spanner = generateSpannerPropertyGraph(m);
        expect(spanner.ddl).not.toContain('OPTIONS');
        expect(spanner.ddl).not.toContain('extensions');
      });
});


describe('ai_context loaded from a model file reaches OPTIONS(extensions)', () => {
  // Loaded rather than hand-built, so the test covers the loader's half too:
  // the map form keeps `instructions`, `synonyms` and `examples` apart; the
  // bare-string shorthand reads as `instructions`; a block scalar's trailing
  // newline and a shorthand's padding are trimmed; a whitespace-only shorthand
  // emits nothing; and a `custom` member stays out of the DDL.
  beforeAll(loadSqlEngine);

  test(
      'the map form and the bare-string shorthand emit on labels, properties and measures',
      () => {
        const {models} = loadModels(`version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    entities:
      - name: orders
        source: bigquery.googleapis.com/projects/acme/datasets/sales/tables/orders
        primary_key: [order_id]
        description: One row per order
        ai_context:
          instructions: |
            Exclude test orders.
            Amounts include tax.
          synonyms: [purchase]
          examples: [orders last week, biggest order]
        fields:
          - {name: order_id, expression: order_id}
          - {name: customer_id, expression: customer_id}
          - name: amount
            expression: amount
            description: Order total
            ai_context: "  Amounts are in USD.  "
          - name: status
            expression: status
            ai_context: "   "
      - name: customers
        source: bigquery.googleapis.com/projects/acme/datasets/sales/tables/customers
        primary_key: [customer_id]
        fields:
          - {name: customer_id, expression: customer_id}
    relationships:
      - name: placed_by
        from: orders
        to: customers
        from_columns: [customer_id]
        to_columns: [customer_id]
        ai_context: Join each order to its buyer.
    metrics:
      - name: total_amount
        expression: SUM(orders.amount)
        ai_context:
          instructions: Completed orders only.
          examples: [revenue last quarter]
          custom: {owner: finance}
`);
        const {ddl, warnings} =
            generatePropertyGraph(models[0], {project: 'acme', dataset: 'graphs'});
        expect(warnings).toEqual([]);
        // Entity label, from the map form.
        expect(ddl).toContain(
            '    OPTIONS(description="One row per order", synonyms=["purchase"], ' +
            'extensions=[("instructions", "Exclude test orders.\\nAmounts include tax."), ' +
            '("examples", "[\\"orders last week\\",\\"biggest order\\"]")])\n');
        // Field property, from the bare-string shorthand, trimmed.
        expect(ddl).toContain(
            '      amount OPTIONS(description="Order total", ' +
            'extensions=[("instructions", "Amounts are in USD.")]),\n');
        // A whitespace-only shorthand gives the field no OPTIONS at all.
        expect(ddl).toContain('      status,\n');
        expect(ddl).not.toContain('status OPTIONS');
        // Measure, from the map form; its custom member is left out.
        expect(ddl).toContain(
            '      MEASURE(SUM(amount)) AS total_amount OPTIONS(' +
            'extensions=[("instructions", "Completed orders only."), ' +
            '("examples", "[\\"revenue last quarter\\"]")])\n');
        expect(ddl).not.toContain('finance');
        // Edge label, from the bare-string shorthand.
        expect(ddl).toContain(
            '    OPTIONS(extensions=[("instructions", "Join each order to its buyer.")])\n' +
            '    NO PROPERTIES\n');
      });
});


// The BigQuery restrictions recorded at
// go/x20 -> bei/bigquery-property-graph-limits.html (section A): a graph
// MEASURE may only aggregate a SINGLE EXPOSED PROPERTY of its node — never a
// raw column (A1), an inline expression (A2), or `*` (A3). Rather than
// enumerate inputs one by one, this guard parses the emitted DDL and asserts
// the invariant BigQuery itself enforces, so ANY future emitter change that
// reintroduces a rejected shape fails here — even for inputs no explicit test
// covers.
describe(
    'emitter never produces a MEASURE shape BigQuery rejects (x20 record §A)',
    () => {
      // For each NODE block: the names it exposes as (non-measure) properties,
      // and the operand of every aggregate in each MEASURE it declares.
      function parseNodeMeasures(ddl: string): Record < string, {
        exposed: Set<string>;
        operands: string[]
      }
      > {
        const nodes: Record < string, {
          exposed: Set<string>;
          operands: string[]
        }
        > = {};
        let inNodeSection = false, inProps = false;
        let cur: string|null = null;
        for (const raw of ddl.split('\n')) {
          const t = raw.trim();
          if (t.startsWith('NODE TABLES')) {
            inNodeSection = true;
            continue;
          }
          if (t.startsWith('EDGE TABLES')) {
            inNodeSection = false;
            continue;
          }
          if (!inNodeSection) continue;
          const alias = t.match(/^`[^`]+`\s+AS\s+(\w+)$/);
          if (alias) {
            cur = alias[1];
            nodes[cur] = {exposed: new Set(), operands: []};
            inProps = false;
            continue;
          }
          if (t.endsWith('PROPERTIES(')) {
            inProps = true;
            continue;
          }
          if (inProps && (t === ')' || t === '),')) {
            inProps = false;
            continue;
          }
          if (!inProps || !cur) continue;
          if (t.startsWith('MEASURE(')) {
            // The text inside the `(` at `open` in `text` and the `)` that
            // closes it.
            const closed = (text: string, open: number) => {
              let depth = 0;
              for (let i = open; i < text.length; i++) {
                if (text[i] === '(') depth++;
                if (text[i] === ')' && --depth === 0) {
                  return text.slice(open + 1, i);
                }
              }
              return text.slice(open + 1);
            };
            const body = closed(t, 'MEASURE'.length);
            for (const agg of body.matchAll(/\b(?:SUM|AVG|COUNT|MIN|MAX)\(/gi)) {
              nodes[cur].operands.push(
                  closed(body, agg.index + agg[0].length - 1)
                      .replace(/^\s*DISTINCT\s+/i, '')
                      .trim());
            }
            continue;
          }
          // A non-measure property line: record the name it exposes (after AS,
          // or the bare identifier), ignoring any trailing comma or
          // OPTIONS(...) suffix.
          const noOpts =
              t.replace(/,\s*$/, '').replace(/\s+OPTIONS\(.*\)$/, '');
          const asIdx = noOpts.lastIndexOf(' AS ');
          nodes[cur].exposed.add(
              (asIdx >= 0 ? noOpts.slice(asIdx + 4) : noOpts).trim());
        }
        return nodes;
      }

      function assertLegalMeasures(ddl: string): void {
        expect(ddl).not.toContain(
            'MEASURE(COUNT(*))');  // §A3 star must never survive
        for (const {exposed, operands} of Object.values(
                 parseNodeMeasures(ddl))) {
          for (const op of operands) {
            // §A1/§A2: a bare identifier only — no parentheses, operators, or
            // `*`.
            expect(op).toMatch(/^[A-Za-z_]\w*$/);
            // ...and it must be an exposed property of the very same node.
            expect(exposed.has(op)).toBe(true);
          }
        }
      }

      // The fixtures whose goldens carry measures — the invariant must hold for
      // each.
      test('the live-verified fan-out chain satisfies the invariant', () => {
        assertLegalMeasures(
            generatePropertyGraph(loadFixture('sales_fanout.yaml'), GEN_OPTS)
                .ddl);
      });

      test('a measure that combines aggregates aggregates only properties', () => {
        const {ddl} = generatePropertyGraph(
            loadFixture('metric_skips.yaml'), GEN_OPTS);
        expect(ddl).toContain('MEASURE(SUM(amount) / COUNT(o_orderkey)) AS aov');
        assertLegalMeasures(ddl);
      });

      test('every lowered operand shape stays a legal MEASURE', () => {
        assertLegalMeasures(generatePropertyGraph(
                                loadFixture('measure_lowering.yaml'), GEN_OPTS)
                                .ddl);
      });

      test('a COUNT(*) lowering (star -> key property) stays legal', () => {
        const model: SemanticModel = {
          name: 'm',
          relationships: [],
          entities: [{
            name: 'orders',
            dataSource: 'orders',
            keys: ['o_orderkey'],
            fields: [{name: 'o_orderkey', expression: 'o_orderkey'}]
          }],
          metrics:
              [{name: 'n_orders', expression: 'COUNT(*)', entity: 'orders'}],
        };
        const {ddl} = generatePropertyGraph(model, GEN_OPTS);
        assertLegalMeasures(ddl);
        expect(ddl).toContain('MEASURE(COUNT(o_orderkey)) AS n_orders');
        expect(ddl).not.toContain('MEASURE(COUNT(*))');
      });
    });


describe('abstract (table-less) superclasses are eliminated to labels', () => {
  // An abstract `Party` has no physical table; two concrete subtypes, `Person`
  // and `Organization`, bind it. Party's inherited `id`/`name` are bound on
  // each subtype's OWN table under DIFFERENT columns (person.p_name vs
  // org.o_name). resolveInheritance flattens Party's fields onto each subtype
  // and expands their `extends` to [Party], so each concrete node table
  // declares `LABEL Party` with that subtype's OWN binding of the inherited
  // names (`p_name AS name` / `o_name AS name`). BigQuery reconciles a shared
  // label by property name, not backing column, so the differing columns are
  // valid; a bare-alias reference (`PROPERTIES(name)`) would not deploy
  // (verified live). Party itself must produce NO node table -- it survives
  // only as that shared label.
  function partyModel(): SemanticModel {
    return {
      name: 'party_graph',
      entities: [
        {
          name: 'Party',
          dataSource: '',
          keys: [],
          abstract: true,
          fields: [{name: 'id'}, {name: 'name'}],
        },
        {
          name: 'Person',
          dataSource: 'sqlgen-testing.demo.person',
          keys: ['id'],
          extends: ['Party'],
          fields: [
            {name: 'id', expression: 'p_id'},
            {name: 'name', expression: 'p_name'},
            {name: 'ssn', expression: 'p_ssn'},
          ],
        },
        {
          name: 'Organization',
          dataSource: 'sqlgen-testing.demo.organization',
          keys: ['id'],
          extends: ['Party'],
          fields: [
            {name: 'id', expression: 'o_id'},
            {name: 'name', expression: 'o_name'},
            {name: 'taxId', expression: 'o_tax'},
          ],
        },
      ],
      relationships: [],
      metrics: [],
    };
  }

  test(
      'the abstract class produces no node table but survives as a label',
      () => {
        const {ddl} = generatePropertyGraph(partyModel(), GEN_OPTS);
        // No `AS Party` node table (it has no source/KEY to materialize)...
        expect(ddl).not.toContain('AS Party');
        // ...but its label is present on the concrete descendants.
        expect(ddl).toContain('LABEL Party');
      });

  test(
      'concrete subclasses share the abstract label and its flattened fields',
      () => {
        const {ddl} = generatePropertyGraph(partyModel(), GEN_OPTS);
        // Both Person and Organization declare the shared Party label, each
        // with a PROPERTIES block listing Party's flattened `id`/`name`
        // rendered from that subtype's OWN binding (assert inside the block, so
        // an unrelated substring elsewhere can't satisfy this).
        const partyBlocks =
            [...ddl.matchAll(/LABEL Party\s*\n\s*PROPERTIES\(([\s\S]*?)\)/g)];
        expect(partyBlocks.length).toBe(2);
        for (const [, props] of partyBlocks) {
          expect(props).toContain('name');
          expect(props).toContain('id');
        }
        // The label signature must REDEFINE each inherited property with the
        // subtype's own column (`<col> AS <name>`), never a bare-alias
        // reference -- the shape BigQuery accepts across element tables with
        // differing columns (verified live).
        const props = partyBlocks.map(m => m[1]);
        expect(props.some(p => /p_name\s+AS\s+name/.test(p))).toBe(true);
        expect(props.some(p => /o_name\s+AS\s+name/.test(p))).toBe(true);
      });

  test('both concrete node tables are still emitted', () => {
    const {ddl} = generatePropertyGraph(partyModel(), GEN_OPTS);
    expect(ddl).toContain('AS Person');
    expect(ddl).toContain('AS Organization');
  });

  test(
      'an abstract class that is nobody\'s supertype is warned and dropped',
      () => {
        const model = partyModel();
        model.entities!.push({
          name: 'Ghost',
          dataSource: '',
          keys: [],
          abstract: true,
          fields: [{name: 'id'}],
        });
        const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(warnings.some(
                   w => w.includes(`abstract entity 'Ghost'`) &&
                       w.includes('no graph element')))
            .toBe(true);
        expect(ddl).not.toContain('Ghost');
      });

  test(
      'an abstract supertype\'s own metadata is dropped from its shared label with a warning on BigQuery, and Spanner does not warn',
      () => {
        const dropped =
            `entity 'Party' is an abstract supertype in a class hierarchy; ` +
            `its metadata is dropped (an abstract supertype is only a LABEL ` +
            `on its subtypes, and BigQuery accepts OPTIONS only on a ` +
            `table's DEFAULT LABEL)`;
        // Only instructions and examples, with no description or synonyms: the
        // label still has metadata to lose, so the author is told.
        const model = partyModel();
        model.entities[0].aiContext = {
          instructions: 'Prefer the legal name.',
          examples: ['ACME Corp'],
        };
        const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(warnings).toContain(dropped);
        expect(ddl).not.toContain('Prefer the legal name.');
        expect(ddl).not.toContain('ACME Corp');
        // A description alone is dropped and warned the same way.
        const described = partyModel();
        described.entities[0].description = 'A person or an organization';
        const res = generatePropertyGraph(described, GEN_OPTS);
        expect(res.warnings).toContain(dropped);
        expect(res.ddl).not.toContain('A person or an organization');
        // Nothing is dropped, so nothing is warned: no metadata, or only custom
        // members, which never reach the DDL.
        const customOnly = partyModel();
        customOnly.entities[0].aiContext = {
          additionalProperties: {custom_hint: 'internal-only'},
        };
        for (const m of [partyModel(), customOnly]) {
          expect(generatePropertyGraph(m, GEN_OPTS)
                     .warnings.some(w => w.includes('abstract supertype')))
              .toBe(false);
        }
        // Spanner writes no OPTIONS on any element, so it has nothing to drop.
        const spanner = generateSpannerPropertyGraph(model);
        expect(spanner.warnings.some(w => w.includes('abstract supertype')))
            .toBe(false);
        expect(spanner.ddl).not.toContain('Prefer the legal name.');
        expect(spanner.ddl).not.toContain('ACME Corp');
      });
});


describe('supertype shared-label constraints (inheritance)', () => {
  // Person is a supertype (Customer extends it), so its label is shared across
  // both element tables. BigQuery forbids OPTIONS on a shared label and forbids
  // a MEASURE bound to more than one element table, so the generator must (a)
  // drop Person's label OPTIONS with a warning and (b) skip a metric that
  // targets a supertype with a warning -- while a metric on a leaf still emits.
  function hierModel(): SemanticModel {
    return {
      name: 'hier',
      entities: [
        {
          name: 'Person',
          dataSource: 'proj.ds.person',
          keys: ['id'],
          description: 'A human being',
          fields: [{name: 'id'}, {name: 'name'}],
        },
        {
          name: 'Customer',
          dataSource: 'proj.ds.customer',
          keys: ['id'],
          extends: ['Person'],
          fields: [{name: 'id'}, {name: 'tier'}],
        },
      ],
      relationships: [],
      metrics: [{name: 'total_people', expression: 'COUNT(Person.id)'}],
    };
  }

  test('a shared supertype label drops its OPTIONS (with a warning)', () => {
    const {ddl, warnings} = generatePropertyGraph(hierModel(), GEN_OPTS);
    // Person's description would normally ride its DEFAULT LABEL OPTIONS;
    // because the label is shared with Customer it must be options-free.
    expect(ddl).not.toContain('A human being');
    expect(warnings.some(
               w => w.includes(`entity 'Person' is a supertype`) &&
                   w.includes('dropped from the shared')))
        .toBe(true);
    // The shared supertype still uses an explicit DEFAULT LABEL.
    expect(ddl).toContain('DEFAULT LABEL');

    // A supertype with only instructions and examples still produces
    // OPTIONS(extensions=[...]), which is dropped with a warning.
    const extOnly = hierModel();
    delete extOnly.entities[0].description;
    extOnly.entities[0].aiContext = {
      instructions: 'Shared supertype guidance',
      examples: ['who is a person?'],
    };
    const res = generatePropertyGraph(extOnly, GEN_OPTS);
    expect(res.ddl).not.toContain('Shared supertype guidance');
    expect(res.ddl).not.toContain('who is a person?');
    expect(res.warnings.some(
               w => w.includes(`entity 'Person' is a supertype`) &&
                   w.includes('metadata is dropped from the shared')))
        .toBe(true);
  });

  test('a metric targeting a supertype is skipped (with a warning)', () => {
    const {ddl, warnings} = generatePropertyGraph(hierModel(), GEN_OPTS);
    expect(ddl).not.toContain('total_people');
    expect(warnings.some(
               w => w.includes(`metric 'total_people'`) &&
                   w.includes('not a leaf type')))
        .toBe(true);
  });

  test('a metric on a leaf (non-supertype) entity is still emitted', () => {
    const model = hierModel();
    // Retarget to the leaf Customer -- nobody extends it, so its label is not
    // shared and a MEASURE binds cleanly.
    model.metrics =
        [{name: 'total_customers', expression: 'COUNT(Customer.id)'}];
    // A field with no column is left out of the node table, and a measure over
    // it is skipped, so bind the one it counts.
    model.entities[1].fields = [{name: 'id', expression: 'id'}, {name: 'tier'}];
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain('AS total_customers');
    expect(warnings.some(w => w.includes('total_customers'))).toBe(false);
  });
});


describe('inherited property rendering (shared-label consistency)', () => {
  // BigQuery requires a property carried by a label bound to more than one
  // element table to have an IDENTICAL definition in every table. These tests
  // pin the two ways a naive renderer would violate that: a supertype field
  // whose expression is qualified with its own name, and a subclass that
  // redefines an inherited field.
  function base(
      customerFields: Array<{name: string; expression?: string}>,
      personFields: Array<{name: string; expression?: string}>): SemanticModel {
    return {
      name: 'hier',
      entities: [
        {name: 'Person', dataSource: 'proj.ds.person', keys: ['id'],
         fields: personFields},
        {name: 'Customer', dataSource: 'proj.ds.customer', keys: ['id'],
         extends: ['Person'], fields: customerFields},
      ],
      relationships: [],
      metrics: [],
    };
  }

  test(
      'a supertype expression qualified with its own name is localized', () => {
        // Person.email references Person's table; inherited onto Customer it
        // must be the local `email`, so the qualifier appears NOWHERE in the
        // DDL and every binding of the Person label lists an identical `email`
        // property.
        const model = base([{name: 'id', expression: 'id'}], [
          {name: 'id', expression: 'id'},
          {name: 'email', expression: 'email'}
        ]);
        const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(ddl).not.toContain('Person.email');
        // Person's own DEFAULT LABEL, Customer's DEFAULT LABEL, and Customer's
        // LABEL Person block must all list `email` the same way -> three
        // occurrences.
        expect(ddl.match(/\bemail\b/g)?.length).toBe(3);
        // A well-formed hierarchy raises no override warning.
        expect(warnings.some(w => w.includes('redefines inherited')))
            .toBe(false);
      });

  test('a subclass structurally remapping an inherited field is warned', () => {
    // Customer remaps `email` (inherited from Person) to a different
    // expression. That cannot be represented under the shared Person label, so
    // the supertype's definition wins and the remap is dropped with a warning
    // that names it as a column/expression remap.
    const model = base(
        [
          {name: 'id', expression: 'id'},
          {name: 'email', expression: 'LOWER(email)'}
        ],
        [{name: 'id', expression: 'id'}, {name: 'email', expression: 'email'}]);
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(warnings.some(
               w => w.includes(`remaps inherited property 'email'`) &&
                   w.includes('remapping is dropped')))
        .toBe(true);
    // The remapping expression is gone; only the supertype's `email` remains.
    expect(ddl).not.toContain('LOWER(email)');
  });

  test(
      'a subclass refining only inherited metadata is warned as metadata-only',
      () => {
        // Customer keeps `email`'s column but adds a description. The
        // structural core matches the supertype, so under the shared label the
        // supertype's (option-free) definition still wins -- but the warning
        // must say the refinement was METADATA, not a redefined column, and the
        // added text must not leak into the DDL.
        const model: SemanticModel = {
           name: 'hier',
           entities: [
             {
               name: 'Person', dataSource: 'proj.ds.person', keys: ['id'],
               fields: [{name: 'id', expression: 'id'},
                        {name: 'email', expression: 'email'}],
             },
             {
               name: 'Customer', dataSource: 'proj.ds.customer', keys: ['id'],
               extends: ['Person'],
               fields: [{name: 'id', expression: 'id'}, {
                 name: 'email',
                 expression: 'email',
                 description: 'Customer-specific email',
               }],
             },
           ],
           relationships: [],
           metrics: [],
         };
        const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(
            warnings.some(
                w =>
                    w.includes(
                        `overrides the metadata of inherited property 'email'`) &&
                    w.includes('metadata is used')))
            .toBe(true);
        // Not mislabeled as a structural remap...
        expect(warnings.some(w => w.includes('remaps inherited property')))
            .toBe(false);
        // ...and the subclass metadata is dropped, not emitted.
        expect(ddl).not.toContain('Customer-specific email');

        // Overriding only instructions and examples raises the same warning
        // and drops the subclass extensions.
        delete model.entities[1].fields[1].description;
        model.entities[1].fields[1].aiContext = {
          instructions: 'Use verified customer email',
          examples: ['alice@example.com'],
        };
        const extRes = generatePropertyGraph(model, GEN_OPTS);
        expect(extRes.warnings.some(
                   w => w.includes(
                       `overrides the metadata of inherited property 'email'`)))
            .toBe(true);
        expect(extRes.ddl).not.toContain('Use verified customer email');
        expect(extRes.ddl).not.toContain('alice@example.com');
      });

  test(
      'a subclass extending a KEY-less (dropped) supertype omits that label',
      () => {
        // Person is concrete but has no KEY, so it forms no node table. It must
        // NOT be resurrected as a shared label on its subclass -- that would
        // contradict the "skipped, invalid" report. The subclass keeps the
        // flattened columns but drops the LABEL, with a warning explaining why.
        const model: SemanticModel = {
           name: 'hier',
           entities: [
             {
               name: 'Person', dataSource: 'proj.ds.person', keys: [],
               fields: [{name: 'id', expression: 'id'},
                        {name: 'email', expression: 'email'}],
             },
             {
               name: 'Customer', dataSource: 'proj.ds.customer', keys: ['id'],
               extends: ['Person'],
               fields: [{name: 'id', expression: 'id'},
                        {name: 'loyalty', expression: 'loyalty'}],
             },
           ],
           relationships: [],
           metrics: [],
         };
        const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
        // No Person node table, and NOT a Person label anywhere.
        expect(ddl).not.toContain('AS Person');
        expect(ddl).not.toContain('LABEL Person');
        // Reported both as the KEY defect and as the omitted label.
        expect(warnings.some(w => w.includes('empty KEY'))).toBe(true);
        expect(warnings.some(
                   w => w.includes(
                       `the 'Person' label is omitted from 'Customer'`)))
            .toBe(true);
        // Person's `email` still flattened onto Customer (it physically
        // exists).
        expect(ddl).toContain('email');
      });
});

describe('reserved-word names in an M:N association edge are quoted', () => {
  // The open format has no association-table syntax, so this hand-built IR is
  // the only path that exercises renderAssociationEdge's identifier quoting: the
  // edge alias, KEY, SOURCE KEY / DESTINATION KEY columns, and both REFERENCES
  // labels, each named with a GoogleSQL reserved keyword.
  const RW_ASSOC: SemanticModel = {
    name: 'rw_assoc',
    entities: [
      {
        name: 'Order',
        dataSource: 'proj.ds.orders',
        keys: ['order'],
        fields: [{name: 'order', expression: '`order`'}],
      },
      {
        name: 'Group',
        dataSource: 'proj.ds.groups',
        keys: ['id'],
        fields: [{name: 'id', expression: 'id'}],
      },
    ],
    relationships: [{
      name: 'from',
      source: {entity: 'Order', columns: ['order']},
      destination: {entity: 'Group', columns: ['id']},
      association: {
        dataSource: 'proj.ds.order_group',
        keys: ['order'],
        sourceColumns: ['order'],
        destinationColumns: ['id'],
        fields: [],
      },
    }],
    metrics: [],
  };

  test('every reserved identifier position in the edge is backtick-quoted', () => {
    const {ddl} = generatePropertyGraph(RW_ASSOC, GEN_OPTS);
    expect(ddl).toContain('`proj.ds.order_group` AS `from`');
    expect(ddl).toContain('KEY(`order`)');
    expect(ddl).toContain('SOURCE KEY(`order`) REFERENCES `Order`(`order`)');
    expect(ddl).toContain('DESTINATION KEY(id) REFERENCES `Group`(id)');
  });
});


describe('a comment in a field expression', () => {
  // Left in, a line comment runs to the end of the line and swallows the
  // ` AS <name>` after the expression, and the comma after that.
  const model: SemanticModel = {
    name: 'm',
    relationships: [],
    metrics: [],
    entities: [{
      name: 'orders',
      dataSource: 'p.d.orders',
      keys: ['order_id'],
      fields: [
        {name: 'id', expression: 'order_id -- the key'},
        {name: 'total', expression: 'amount -- in cents'},
        {name: 'notes', expression: '/* free text */ notes'},
        {name: 'status', expression: 'status # open or closed'},
        {name: 'code', expression: "CONCAT('--', code)"},
      ],
    }],
  };

  test('is removed before the field is written', () => {
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain('KEY(order_id)');
    expect(ddl).toContain(
        '      order_id AS id,\n      amount AS total,\n      notes,\n' +
        "      status,\n      CONCAT('--', code) AS code\n");
    expect(ddl).not.toContain('the key');
    expect(ddl).not.toContain('free text');
    expect(warnings).toEqual([]);
  });

  test('is removed from a metric before it is lowered', () => {
    const withMetric: SemanticModel = {
      ...model,
      metrics: [{name: 'revenue', entity: 'orders',
                 expression: 'SUM(orders.amount -- in cents\n)'}],
    };
    const {ddl, warnings} = generatePropertyGraph(withMetric, GEN_OPTS);
    expect(ddl).toContain('MEASURE(SUM(amount)) AS revenue');
    expect(warnings).toEqual([]);
  });

  test('a metric whose aggregate has no operand is skipped with a warning', () => {
    // Lowered, it would give a measure input property with no SQL.
    for (const expression of [
           'SUM()', 'SUM(/* in cents */)', 'SUM(orders.)', 'COUNT(DISTINCT)',
           'SUM(DISTINCT orders.)', 'COUNT(DISTINCT /* in cents */)']) {
      const {ddl, warnings} = generatePropertyGraph(
          {...model, metrics: [{name: 'revenue', entity: 'orders', expression}]},
          GEN_OPTS);
      expect(ddl).not.toContain('revenue');
      expect(warnings.some(w => w.startsWith("metric 'revenue' expression"))).toBe(true);
    }
  });

  test('is read as BigQuery reads it, even when a PostgreSQL entry holds the same text', () => {
    // A target text is read as the graph's engine reads it, so `# in cents`
    // comes out of `net`. A field or metric with only imported PostgreSQL SQL
    // has nothing BigQuery runs, so it is left out however its comments read.
    const vendor: SemanticModel = {
      name: 'm',
      relationships: [],
      entities: [{
        name: 'orders',
        dataSource: 'p.d.orders',
        keys: ['id'],
        fields: [
          {name: 'id', expression: 'id'},
          {name: 'flags', dialects: [{dialect: 'POSTGRES', expression: 'flags # 1'}],
           importedExpression: 'flags # 1', importedDialect: 'POSTGRES'},
          {name: 'total', dialects: [{dialect: 'POSTGRES', expression: 'amount -- in cents'}],
           importedExpression: 'amount -- in cents', importedDialect: 'POSTGRES'},
          {name: 'net', expression: 'net_amount # in cents',
           dialects: [{dialect: 'POSTGRES', expression: 'net_amount # in cents'},
                      {dialect: 'BIGQUERY', expression: 'net_amount # in cents'}]},
        ],
      }],
      metrics: [{
        name: 'xor_bits',
        entity: 'orders',
        dialects: [{dialect: 'POSTGRES', expression: 'SUM(orders.bits # 1\n)'}],
        importedExpression: 'SUM(orders.bits # 1\n)',
        importedDialect: 'POSTGRES',
      }],
    };
    const {ddl, warnings} = generatePropertyGraph(vendor, GEN_OPTS);
    expect(ddl).toContain('net_amount AS net');
    expect(ddl).not.toContain('flags');
    expect(ddl).not.toContain('AS total');
    expect(ddl).not.toContain('xor_bits');
    expect(warnings).toEqual([
      `metric 'xor_bits' has no 'BIGQUERY' or 'ANSI_SQL' expression; skipped ` +
          `(nothing to emit as a MEASURE)`,
      `entity 'orders': field 'flags' has no 'BIGQUERY' or 'ANSI_SQL' ` +
          `expression; omitted from the node table`,
      `entity 'orders': field 'total' has no 'BIGQUERY' or 'ANSI_SQL' ` +
          `expression; omitted from the node table`,
    ]);
  });

  test('next to a dot leaves no space, so the qualifier still comes off', () => {
    const dotted: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [{name: 'revenue', entity: 'orders',
                 expression: 'SUM(orders/* in cents */.amount)'}],
      entities: [{
        name: 'orders',
        dataSource: 'p.d.orders',
        keys: ['order_id'],
        fields: [
          {name: 'id', expression: 'orders./* the key */order_id'},
          {name: 'amount', expression: 'orders/* in cents */.amount_cents'},
          {name: 'select', expression: 'orders. /* a keyword */ group'},
        ],
      }],
    };
    const {ddl, warnings} = generatePropertyGraph(dotted, GEN_OPTS);
    expect(ddl).toContain('KEY(order_id)');
    expect(ddl).toContain(
        '      order_id AS id,\n      amount_cents AS amount,\n' +
        '      `group` AS `select`,\n      amount_cents,\n' +
        '      MEASURE(SUM(amount_cents)) AS revenue\n');
    expect(warnings).toEqual([]);
  });

  test('on an inherited field is read in its own dialect, even when a vendor entry holds the same text', () => {
    // Read as PostgreSQL, where `#` is an operator, the apostrophe opens a
    // string, the subtype's copy keeps `base.second`, and the generator warns
    // that the subtype remaps a property it only inherits.
    const text = "base.first # base's first\n|| base.second || ' '";
    const inherited: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'base',
          dataSource: 'p.d.base',
          keys: ['id'],
          fields: [
            {name: 'id', expression: 'id'},
            {name: 'label', expression: text, importedExpression: text,
             importedDialect: 'POSTGRES',
             dialects: [{dialect: 'POSTGRES', expression: text},
                        {dialect: 'BIGQUERY', expression: text}]},
          ],
        },
        {name: 'orders', dataSource: 'p.d.orders', keys: ['id'],
         extends: ['base'], fields: []},
      ],
    };
    const {ddl, warnings} = generatePropertyGraph(inherited, GEN_OPTS);
    expect(ddl).not.toContain('base.second');
    expect(ddl.match(/first \|\| second \|\| ' ' AS label/g)).toHaveLength(3);
    expect(warnings).toEqual([]);
  });
});


describe('each field and metric emits BigQuery\'s own SQL', () => {
  // Fields and metrics carry only a dialect list here, with no `expression`
  // beside it, so the emitted text can only have come from the list. (The
  // loader also copies the BIGQUERY or ANSI_SQL entry into `expression`.)
  const orders = (): SemanticModel => ({
    name: 'm',
    relationships: [],
    metrics: [],
    entities: [{
      name: 'orders',
      dataSource: 'orders',
      keys: ['o_orderkey'],
      fields: [{name: 'o_orderkey', expression: 'o_orderkey'}]
    }],
  });

  // Built the way the loader builds a field written only for Snowflake. Leave
  // `importedExpression` in: without it the field has nothing to emit however
  // the generator chooses.
  const snowflakeOnly =
      (): Pick<Field, 'dialects'|'importedExpression'|'importedDialect'> => ({
    dialects: [{dialect: 'SNOWFLAKE', expression: 'DIV0(a,b)'}],
    importedExpression: 'DIV0(a,b)',
    importedDialect: 'SNOWFLAKE',
  });

  test('a BIGQUERY entry beats ANSI_SQL, and ANSI_SQL is used without one', () => {
    const model = orders();
    model.entities[0].fields.push(
        {
          name: 'order_month',
          dialects: [
            {
              dialect: 'ANSI_SQL',
              expression: 'DATE_TRUNC(\'month\', orders.order_ts)'
            },
            {
              dialect: 'BIGQUERY',
              expression: 'TIMESTAMP_TRUNC(orders.order_ts, MONTH)'
            },
          ],
        },
        {
          name: 'net',
          dialects: [
            {dialect: 'SNOWFLAKE', expression: 'DIV0(orders.a, orders.b)'},
            {dialect: 'ANSI_SQL', expression: 'orders.a / NULLIF(orders.b, 0)'},
          ],
        });
    model.metrics = [
      {
        name: 'revenue',
        dialects: [
          {dialect: 'ANSI_SQL', expression: 'SUM(orders.amount)'},
          {dialect: 'BIGQUERY', expression: 'SUM(orders.amount_usd)'},
        ],
      },
      {
        name: 'units',
        dialects: [
          {dialect: 'SNOWFLAKE', expression: 'SUM(ZEROIFNULL(orders.qty))'},
          {dialect: 'ANSI_SQL', expression: 'SUM(COALESCE(orders.qty, 0))'},
        ],
      },
    ];
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain('TIMESTAMP_TRUNC(order_ts, MONTH) AS order_month');
    expect(ddl).toContain('a / NULLIF(b, 0) AS net');
    expect(ddl).toContain('MEASURE(SUM(amount_usd)) AS revenue');
    expect(ddl).toContain('COALESCE(qty, 0) AS units_input');
    expect(ddl).toContain('MEASURE(SUM(units_input)) AS units');
    expect(ddl).not.toContain('DATE_TRUNC');
    expect(ddl).not.toContain('DIV0');
    expect(ddl).not.toContain('ZEROIFNULL');
    expect(warnings).toEqual([]);
  });

  test('another engine\'s SQL is never emitted', () => {
    const model = orders();
    model.entities[0].fields.push({name: 'ratio', ...snowflakeOnly()});
    model.metrics = [{name: 'revenue', ...snowflakeOnly(), entity: 'orders'}];
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).not.toContain('DIV0');
    expect(ddl).not.toContain('ratio');
    expect(ddl).not.toContain('revenue');
    expect(warnings).toContain(
        `entity 'orders': field 'ratio' has no 'BIGQUERY' or 'ANSI_SQL' ` +
        `expression; omitted from the node table`);
    expect(warnings).toContain(
        `metric 'revenue' has no 'BIGQUERY' or 'ANSI_SQL' expression; ` +
        `skipped (nothing to emit as a MEASURE)`);
  });

  test('a field or metric with no SQL at all keeps the unbound message', () => {
    const model = orders();
    model.entities[0].fields.push({name: 'notes'});
    model.metrics = [{name: 'revenue', entity: 'orders'}];
    const {warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(warnings).toEqual([
      `metric 'revenue' has no expression; skipped (nothing to emit as a ` +
          `MEASURE)`,
      `entity 'orders': field 'notes' has no column under this binding; ` +
          `omitted from the node table (bind it, or govern the logical model ` +
          `in Knowledge Catalog instead)`,
    ]);
  });

  test('a subtype that rebinds an inherited field with only a dialect list emits its own SQL', () => {
    const model: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'party',
          dataSource: '',
          keys: [],
          abstract: true,
          fields: [{name: 'nm', expression: 'party.display_name'}],
        },
        {
          name: 'person',
          dataSource: 'p.d.people',
          keys: ['id'],
          extends: ['party'],
          fields: [
            {name: 'id', expression: 'id'},
            {
              name: 'nm',
              dialects: [{dialect: 'BIGQUERY', expression: 'person.full_name'}],
            },
          ],
        },
      ],
    };
    const {ddl} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain('full_name AS nm');
    expect(ddl).not.toContain('display_name');
  });

  test('a concrete parent\'s field with no BigQuery SQL is left out of the parent\'s label on every table', () => {
    const model: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'person',
          dataSource: 'p.d.person',
          keys: ['id'],
          fields: [
            {name: 'id', expression: 'id'},
            {name: 'nick', ...snowflakeOnly()},
          ],
        },
        {
          name: 'customer',
          dataSource: 'p.d.customer',
          keys: ['id'],
          extends: ['person'],
          fields: [{name: 'id', expression: 'id'}],
        },
      ],
    };
    expect(generatePropertyGraph(model, GEN_OPTS).ddl).not.toMatch(/\bnick\b/);
    // A subtype that binds the field in BigQuery SQL keeps its own SQL.
    model.entities[1].fields.push({name: 'nick', expression: 'customer.nick2'});
    const {ddl} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain('nick2 AS nick');
    expect(ddl).not.toMatch(/^\s+nick,?$/m);
  });

  test('an abstract parent\'s label leaves out a field one leaf has no BigQuery SQL for, on every leaf', () => {
    const leaf = (
        name: string,
        code: Pick<Field, 'expression'|'dialects'|'importedExpression'|
                          'importedDialect'>): SemanticModel['entities'][number] => ({
      name,
      dataSource: `p.d.${name}`,
      keys: ['id'],
      extends: ['party'],
      fields: [
        {name: 'id', expression: 'id'},
        {name: 'nm', expression: `${name}.${name}_nm`},
        {name: 'code', ...code},
      ],
    });
    const model: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'party',
          abstract: true,
          dataSource: '',
          keys: [],
          fields: [{name: 'nm'}, {name: 'code'}],
        },
        leaf('person', {expression: 'person.p_code'}),
        leaf('org', snowflakeOnly()),
      ],
    };
    const labels = (ddl: string) =>
        [...ddl.matchAll(/LABEL party\s+(PROPERTIES\([^)]*\)|NO PROPERTIES)/g)]
            .map(m => m[1].replace(/\s+/g, ' '));
    expect(labels(generatePropertyGraph(model, GEN_OPTS).ddl)).toEqual([
      'PROPERTIES( person_nm AS nm )',
      'PROPERTIES( org_nm AS nm )',
    ]);
    // When nothing else is left, the label lists no properties, since a bare
    // LABEL exposes every column of its table.
    for (const e of model.entities) e.fields = e.fields.filter(f => f.name !== 'nm');
    const {ddl} = generatePropertyGraph(model, GEN_OPTS);
    expect(labels(ddl)).toEqual(['NO PROPERTIES', 'NO PROPERTIES']);
    expect(ddl).toContain('p_code AS code');
  });

  test('a metric over a field with no BigQuery SQL is skipped', () => {
    const model = orders();
    model.entities[0].fields.push({name: 'ratio', ...snowflakeOnly()});
    model.metrics = [{name: 'total_ratio', expression: 'SUM(orders.ratio)'}];
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).not.toContain('ratio');
    expect(warnings).toContain(
        `metric 'total_ratio' aggregates field 'ratio', which has no ` +
        `'BIGQUERY' or 'ANSI_SQL' expression; skipped (nothing to emit as a ` +
        `MEASURE)`);
  });

  test('a key named like a field with only Snowflake SQL stays the column', () => {
    // The key names the column `order_id`; the field of that name, which has
    // no BigQuery SQL, is left out of the properties.
    const model = orders();
    model.entities[0].keys = ['order_id'];
    model.entities[0].fields = [{
      name: 'order_id',
      dialects: [{dialect: 'SNOWFLAKE', expression: 'o_orderkey'}],
      importedExpression: 'o_orderkey',
      importedDialect: 'SNOWFLAKE',
    }];
    const {ddl} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain('KEY(order_id)');
    expect(ddl).not.toContain('o_orderkey');
  });

  test('an association field with no BigQuery SQL is left out of its edge', () => {
    const model = orders();
    model.entities.push({
      name: 'parts',
      dataSource: 'parts',
      keys: ['p_partkey'],
      fields: [{name: 'p_partkey', expression: 'p_partkey'}],
    });
    model.relationships = [{
      name: 'contains',
      source: {entity: 'orders', columns: ['o_orderkey']},
      destination: {entity: 'parts', columns: ['p_partkey']},
      association: {
        dataSource: 'lineitem',
        keys: ['l_orderkey', 'l_partkey'],
        sourceColumns: ['l_orderkey'],
        destinationColumns: ['l_partkey'],
        fields: [{name: 'ratio', ...snowflakeOnly()}],
      },
    }];
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).not.toContain('ratio');
    expect(warnings).toContain(
        `relationship 'contains': field 'ratio' has no 'BIGQUERY' or ` +
        `'ANSI_SQL' expression; omitted from the edge table`);
  });

  test('a subtype that restates an inherited field in Snowflake SQL only keeps the supertype\'s definition under its label', () => {
    const model: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'person',
          dataSource: 'p.d.person',
          keys: ['id'],
          fields: [
            {name: 'id', expression: 'id'},
            {name: 'nick', expression: 'nick'},
          ],
        },
        {
          name: 'customer',
          dataSource: 'p.d.customer',
          keys: ['id'],
          extends: ['person'],
          fields: [
            {name: 'id', expression: 'id'},
            {name: 'nick', ...snowflakeOnly()},
          ],
        },
      ],
    };
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toMatch(/LABEL person\s+PROPERTIES\(\s+id,\s+nick\s+\)/);
    expect(warnings).toContain(
        `entity 'customer': field 'nick' has no 'BIGQUERY' or 'ANSI_SQL' ` +
        `expression; omitted from the node table's own label, and the ` +
        `supertype's label keeps the supertype's definition`);
  });
});

describe('a field expression that names a sibling field', () => {
  // The other rules for a field that names a sibling, which both graphs
  // share, are checked in spanner.test.ts.
  test('an association field reads its siblings under the relationship name', () => {
    const model: SemanticModel = {
      name: 'm',
      metrics: [],
      entities: [
        {
          name: 'students',
          dataSource: 'p.d.students',
          keys: ['sid'],
          fields: [{name: 'sid', expression: 'sid'}],
        },
        {
          name: 'courses',
          dataSource: 'p.d.courses',
          keys: ['cid'],
          fields: [{name: 'cid', expression: 'cid'}],
        },
      ],
      relationships: [{
        name: 'enrollment',
        source: {entity: 'students', columns: []},
        destination: {entity: 'courses', columns: []},
        association: {
          dataSource: 'p.d.enrollments',
          keys: ['eid'],
          sourceColumns: ['sid'],
          destinationColumns: ['cid'],
          fields: [
            {name: 'grade', expression: 'letter'},
            {name: 'passed', expression: 'enrollment.grade <> \'F\''},
            {
              name: 'late',
              dialects: [{dialect: 'SNOWFLAKE', expression: 'x'}],
              importedExpression: 'x',
              importedDialect: 'SNOWFLAKE',
            },
            {name: 'on_time', expression: 'NOT enrollment.late'},
          ],
        },
      }],
    };
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain(
        '    PROPERTIES(\n' +
        '      letter AS grade,\n' +
        '      letter <> \'F\' AS passed\n' +
        '    )\n');
    expect(warnings).toContain(
        `relationship 'enrollment': field 'on_time' reads field 'late', ` +
        `which has no 'BIGQUERY' or 'ANSI_SQL' expression; omitted from the ` +
        `edge table`);
  });
});


describe('a metric operand that names a field', () => {
  // A `purchase` entity keyed on `id`, with `fields` after the key, and
  // `metrics`.
  const purchaseWith = (fields: Field[], metrics: Metric[]): SemanticModel => ({
    name: 'm',
    relationships: [],
    metrics,
    entities: [{
      name: 'purchase',
      dataSource: 'p.d.purchase',
      keys: ['purchase_id'],
      fields: [{name: 'id', expression: 'purchase_id'}, ...fields],
    }],
  });

  // A measure that named `amount` would name both the property and the column
  // `amount`, which BigQuery rejects: "Name amount is ambiguous because it
  // exists as both a column and a graph property".
  test('aggregates the field\'s SQL when the table has a column of its name', () => {
    for (const local of ['amount', 'amount * 100']) {
      const {ddl, warnings} = generatePropertyGraph(
          purchaseWith(
              [
                {name: 'amount', expression: 'amount_usd'},
                {name: 'amount_local', expression: local},
              ],
              [{name: 'total_amount', expression: 'SUM(purchase.amount)'}]),
          GEN_OPTS);
      expect(ddl).toContain(
          '      amount_usd AS amount,\n' +
          `      ${local} AS amount_local,\n` +
          '      amount_usd,\n' +
          '      MEASURE(SUM(amount_usd)) AS total_amount\n');
      expect(warnings).toEqual([]);
    }
  });

  // b/581838371: the purchase table keeps its old `amount` and `customer_id`
  // columns beside `amount_usd` and `cust_ref`, and joins on `customer_id`.
  test('aggregates the SQL of a field that renames a join column', () => {
    const model = purchaseWith(
        [
          {name: 'amount', expression: 'amount_usd'},
          {name: 'customer_id', expression: 'cust_ref'},
        ],
        [
          {name: 'total_amount', expression: 'SUM(purchase.amount)'},
          {name: 'buyers', expression: 'COUNT(DISTINCT purchase.customer_id)'},
        ]);
    model.entities.push({
      name: 'customer',
      dataSource: 'p.d.customer',
      keys: ['id'],
      fields: [{name: 'id', expression: 'id'}],
    });
    model.relationships.push({
      name: 'placed_by',
      source: {entity: 'purchase', columns: ['customer_id']},
      destination: {entity: 'customer', columns: ['id']},
    });
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain(
        '      amount_usd AS amount,\n' +
        '      cust_ref AS customer_id,\n' +
        '      amount_usd,\n' +
        '      cust_ref,\n' +
        '      MEASURE(SUM(amount_usd)) AS total_amount,\n' +
        '      MEASURE(COUNT(DISTINCT cust_ref)) AS buyers\n');
    expect(ddl).toContain(
        '    DESTINATION KEY(customer_id) REFERENCES customer(id)\n');
    expect(warnings).toEqual([]);
  });

  // BigQuery ignores case in a property name, so a column property `AMOUNT`
  // beside `amount` is rejected: "Duplicate graph property name amount".
  test('does not expose a column whose name differs from a field\'s only in case', () => {
    const {ddl, warnings} = generatePropertyGraph(
        purchaseWith(
            [
              {name: 'amount', expression: 'amount_usd'},
              {name: 'fee', expression: 'AMOUNT'},
            ],
            [{name: 'total_fee', expression: 'SUM(purchase.fee)'}]),
        GEN_OPTS);
    expect(ddl).toContain(
        '      amount_usd AS amount,\n' +
        '      AMOUNT AS fee,\n' +
        '      AMOUNT AS total_fee_input,\n' +
        '      MEASURE(SUM(total_fee_input)) AS total_fee\n');
    expect(warnings).toEqual([]);
  });

  test('does not expose a column whose name differs from a metric\'s only in case', () => {
    const {ddl, warnings} = generatePropertyGraph(
        purchaseWith(
            [{name: 'x', expression: 'Total'}],
            [{name: 'total', expression: 'SUM(purchase.x)'}]),
        GEN_OPTS);
    expect(ddl).toContain(
        '      Total AS x,\n' +
        '      Total AS total_input,\n' +
        '      MEASURE(SUM(total_input)) AS total\n');
    expect(warnings).toEqual([]);
  });

  // BigQuery gives a property name one type across the graph, so a column
  // exposed under its own name can clash with another node table's property:
  // "The property declaration of 'id' has type conflicts".
  test('does not expose a column under a name another node table\'s field has', () => {
    const {ddl, warnings} = generatePropertyGraph(
        {
          name: 'm',
          relationships: [],
          metrics:
              [{name: 'customers', expression: 'COUNT(customer.customer_id)'}],
          entities: [
            {
              name: 'customer',
              dataSource: 'p.d.customer',
              keys: ['id'],
              fields: [{name: 'customer_id', expression: 'id'}],
            },
            {
              name: 'product',
              dataSource: 'p.d.product',
              keys: ['id'],
              fields: [{name: 'id', expression: 'id'}],
            },
          ],
        },
        GEN_OPTS);
    expect(ddl).toContain(
        '      id AS customer_id,\n' +
        '      id AS customers_input,\n' +
        '      MEASURE(COUNT(customers_input)) AS customers\n');
    expect(warnings).toEqual([]);
  });

  test('does not expose a column under a name another node table exposed', () => {
    const model = purchaseWith(
        [{name: 'amount', expression: 'amount_usd'}],
        [
          {name: 'total_amount', expression: 'SUM(purchase.amount)'},
          {name: 'refunded', expression: 'SUM(refund.amount)'},
        ]);
    model.entities.push({
      name: 'refund',
      dataSource: 'p.d.refund',
      keys: ['refund_id'],
      fields: [{name: 'amount', expression: 'amount_usd'}],
    });
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain(
        '      amount_usd AS amount,\n' +
        '      amount_usd,\n' +
        '      MEASURE(SUM(amount_usd)) AS total_amount\n');
    expect(ddl).toContain(
        '      amount_usd AS amount,\n' +
        '      amount_usd AS refunded_input,\n' +
        '      MEASURE(SUM(refunded_input)) AS refunded\n');
    expect(warnings).toEqual([]);
  });

  // A measure that named a column of the table would be ambiguous: "Name
  // total_input is ambiguous because it exists as both a column and a graph
  // property".
  test('a synthesized operand property takes no name of a column the table is known to have', () => {
    const net: Field = {name: 'net', expression: 'gross - fee'};
    const total: Metric = {name: 'total', expression: 'SUM(purchase.net)'};
    // A field reads the column.
    const read = generatePropertyGraph(
        purchaseWith([net, {name: 'raw', expression: 'total_input'}], [total]),
        GEN_OPTS);
    expect(read.ddl).toContain(
        '      total_input AS raw,\n' +
        '      gross - fee AS total_input_2,\n' +
        '      MEASURE(SUM(total_input_2)) AS total\n');
    expect(read.warnings).toEqual([]);
    // The key names the column.
    const model = purchaseWith([net], [total]);
    model.entities[0].keys = ['purchase_id', 'total_input'];
    const keyed = generatePropertyGraph(model, GEN_OPTS);
    expect(keyed.ddl).toContain(
        '      gross - fee AS total_input_2,\n' +
        '      MEASURE(SUM(total_input_2)) AS total\n');
    expect(keyed.warnings).toEqual([]);
  });

  test('a measure over a field bound to TRUE, FALSE or NULL aggregates that value', () => {
    for (const value of ['TRUE', 'FALSE', 'NULL']) {
      const {ddl, warnings} = generatePropertyGraph(
          purchaseWith(
              [{name: 'flag', expression: value}],
              [{name: 'm', expression: 'MAX(purchase.flag)'}]),
          GEN_OPTS);
      expect(ddl).toContain(
          `      ${value} AS flag,\n` +
          `      ${value} AS m_input,\n` +
          '      MEASURE(MAX(m_input)) AS m\n');
      expect(warnings).toEqual([]);
    }
  });

  test('COUNT(*) counts the key column, not a field named like another column', () => {
    // The key names column `purchase_id`, which field `id` reads, while
    // `legacy_id` reads column `id`.
    const {ddl, warnings} = generatePropertyGraph(
        purchaseWith(
            [{name: 'legacy_id', expression: 'id'}],
            [{name: 'n', entity: 'purchase', expression: 'COUNT(*)'}]),
        GEN_OPTS);
    expect(ddl).toContain('    KEY(purchase_id)\n');
    expect(ddl).toContain(
        '      id AS legacy_id,\n' +
        '      purchase_id,\n' +
        '      MEASURE(COUNT(purchase_id)) AS n\n');
    expect(warnings).toEqual([]);
  });

  // The parser reads `time.hour2` as a field of a column `time`, and cannot
  // read `Date.days` at all, unless the qualifier is renamed.
  test('reads the field it names on an entity whose name the parser reads otherwise', () => {
    const one = (name: string, fields: Field[], metrics: Metric[]) =>
        generatePropertyGraph(
            {
              name: 'm',
              relationships: [],
              metrics,
              entities: [{
                name,
                dataSource: `p.d.${name}`,
                keys: ['id'],
                fields: [{name: 'id', expression: 'id'}, ...fields],
              }],
            },
            GEN_OPTS);
    // Each measure sums the column the field reads.
    const time = one(
        'time',
        [{name: 'hour', expression: 'hr'}, {name: 'hour2', expression: 'hr'}],
        [{name: 'h', expression: 'SUM(time.hour2)'}]);
    expect(time.ddl).toContain(
        '      hr AS hour2,\n' +
        '      hr,\n' +
        '      MEASURE(SUM(hr)) AS h\n');
    expect(time.warnings).toEqual([]);
    const date = one(
        'Date', [{name: 'days', expression: 'd_days'}],
        [
          {name: 'tw', expression: 'SUM(Date.days * 2)'},
          {name: 'td', expression: 'SUM(Date.days)'},
        ]);
    expect(date.ddl).toContain(
        '      d_days AS days,\n' +
        '      d_days * 2 AS tw_input,\n' +
        '      d_days,\n' +
        '      MEASURE(SUM(tw_input)) AS tw,\n' +
        '      MEASURE(SUM(d_days)) AS td\n');
    expect(date.warnings).toEqual([]);
  });

  test('reads the field through its SQL inside an expression', () => {
    const lowered = (operand: string) => generatePropertyGraph(
        purchaseWith(
            [{name: 'amount', expression: 'amt'}],
            [{name: 'm', entity: 'purchase', expression: `SUM(${operand})`}]),
        GEN_OPTS);
    expect(lowered('purchase.amount * 2').ddl).toContain(
        '      amt * 2 AS m_input,\n' +
        '      MEASURE(SUM(m_input)) AS m\n');
    expect(lowered('purchase.amount.x').ddl).toContain(
        '      amt.x AS m_input,\n' +
        '      MEASURE(SUM(m_input)) AS m\n');
    // Each of these is the field itself, so the measure sums its column.
    // `purchase . amount` places through the metric's entity: placement does
    // not read it as naming `purchase`.
    for (const operand of
             ['purchase.`amount`', '(purchase.amount)', 'purchase . amount']) {
      const {ddl, warnings} = lowered(operand);
      expect(ddl).toContain(
          '      amt AS amount,\n' +
          '      amt,\n' +
          '      MEASURE(SUM(amt)) AS m\n');
      expect(warnings).toEqual([]);
    }
  });

  test('reuses a field only when it reads the operand\'s column under its own name', () => {
    // `dbl` doubles the column `amount`, not the field `amount`, which reads
    // `amt`. `twice` doubles `amt`, but a measure that named it would also
    // name a column `twice` if the table has one.
    for (const [name, expression] of
             [['dbl', 'amount * 2'], ['twice', 'amt * 2']]) {
      const {ddl} = generatePropertyGraph(
          purchaseWith(
              [{name: 'amount', expression: 'amt'}, {name, expression}],
              [{name: 'm', expression: 'SUM(purchase.amount * 2)'}]),
          GEN_OPTS);
      expect(ddl).toContain(
          `      ${expression} AS ${name},\n` +
          '      amt * 2 AS m_input,\n' +
          '      MEASURE(SUM(m_input)) AS m\n');
    }
    // A field that reads the column of its name, in any case, names that
    // column alone.
    for (const [name, property] of [['amt', 'amt'], ['Amt', 'amt AS Amt']]) {
      const {ddl} = generatePropertyGraph(
          purchaseWith(
              [
                {name: 'amount', expression: 'amt'},
                {name, expression: 'amt'},
              ],
              [{name: 'm', expression: 'SUM(purchase.amount)'}]),
          GEN_OPTS);
      expect(ddl).toContain(
          `      ${property},\n` +
          `      MEASURE(SUM(${name})) AS m\n`);
    }
  });

  test('a metric named like a property an earlier metric added reaches the graph, in either order', () => {
    const doubled: Metric = {name: 'm', expression: 'SUM(purchase.amount * 2)'};
    const input: Metric = {name: 'm_input', expression: 'SUM(purchase.amount)'};
    for (const metrics of [[doubled, input], [input, doubled]]) {
      const {ddl, warnings} = generatePropertyGraph(
          purchaseWith([{name: 'amount', expression: 'amt'}], metrics),
          GEN_OPTS);
      expect(ddl).toContain('      amt * 2 AS m_input_2,\n');
      expect(ddl).toContain('      MEASURE(SUM(m_input_2)) AS m');
      expect(ddl).toContain('      MEASURE(SUM(amt)) AS m_input');
      expect(warnings).toEqual([]);
    }
    // COUNT(*) exposes a key column that no field names. A metric may have
    // that column's name.
    const count: Metric =
        {name: 'n', entity: 'purchase', expression: 'COUNT(*)'};
    const code: Metric = {name: 'code', expression: 'MAX(purchase.id)'};
    for (const metrics of [[count, code], [code, count]]) {
      const model = purchaseWith([], metrics);
      model.entities[0].keys = ['code'];
      const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
      expect(ddl).toContain('      code AS n_input,\n');
      expect(ddl).toContain('      MEASURE(COUNT(n_input)) AS n');
      expect(ddl).toContain('      MEASURE(MAX(purchase_id)) AS code');
      expect(warnings).toEqual([]);
    }
  });

  test('a keyword operand is SQL, not a column', () => {
    for (const [expression, property, measure] of [
           ['COUNT(TRUE)', 'TRUE AS m_input', 'COUNT(m_input)'],
           ['SUM(NULL)', 'NULL AS m_input', 'SUM(m_input)'],
           ['MAX(CURRENT_DATE)', 'CURRENT_DATE AS m_input', 'MAX(m_input)'],
    ]) {
      const {ddl, warnings} = generatePropertyGraph(
          purchaseWith([], [{name: 'm', entity: 'purchase', expression}]),
          GEN_OPTS);
      expect(ddl).toContain(
          `      ${property},\n` +
          `      MEASURE(${measure}) AS m\n`);
      expect(warnings).toEqual([]);
    }
  });

  test('an operand that reads a field the node table leaves out skips the metric, with a warning that names the field', () => {
    const {ddl, warnings} = generatePropertyGraph(
        purchaseWith(
            [
              {
                name: 'amount',
                dialects: [{dialect: 'SPANNER', expression: 'amt'}],
              },
              {name: 'net', expression: 'purchase.amount - 1'},
              {name: 'memo'},
            ],
            [
              {name: 'doubled', expression: 'SUM(purchase.amount * 2)'},
              {name: 'total_net', expression: 'SUM(purchase.net)'},
              {name: 'memos', expression: 'COUNT(purchase.memo)'},
            ]),
        GEN_OPTS);
    expect(ddl).not.toMatch(/MEASURE|_input/);
    expect(warnings).toContain(
        `metric 'doubled' reads field 'amount', which has no 'BIGQUERY' or ` +
        `'ANSI_SQL' expression; skipped (nothing to emit as a MEASURE)`);
    expect(warnings).toContain(
        `metric 'total_net' aggregates field 'net', which reads field ` +
        `'amount', which has no 'BIGQUERY' or 'ANSI_SQL' expression; skipped ` +
        `(nothing to emit as a MEASURE)`);
    expect(warnings).toContain(
        `metric 'memos' aggregates field 'memo', which has no column under ` +
        `this binding; skipped (nothing to emit as a MEASURE)`);
  });
});
