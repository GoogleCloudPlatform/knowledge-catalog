// Behavior specification for the shared GoogleSQL property-graph generator
// (src/libts/semantic/graph_ddl.ts).
//
// The BigQuery setting's output is pinned by the BigQuery goldens
// (`bigquery.e2e.test.ts`, `bigquery.test.ts`); moving that generator onto the
// shared code changed none of them. This file checks the shared code itself:
// that each of the four engine differences -- names, measures, element
// metadata, SQL text -- comes from the setting, and that a setting with
// Spanner's names, no measures and no metadata reproduces spanner.ts's graph.
//

import {describe, expect, test} from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import {spannerTable} from '../../../src/libts/semantic/binding';
import {generateGraphDdl, GraphEngine} from '../../../src/libts/semantic/graph_ddl';
import {fieldBinding, SemanticModel} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';
import {generateSpannerPropertyGraph} from '../../../src/libts/semantic/spanner';
import {quoteIdentifier} from '../../../src/libts/semantic/sql_identifiers';

const FIXTURES = path.join(__dirname, 'fixtures');

function loadFixture(fixture: string): SemanticModel {
  const text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
  const {models} = loadModels(text, {
    defaultProject: 'sqlgen-testing',
    defaultDataset: 'demo',
    allowLegacyBareSource: true,
  });
  return models[0];
}


describe('the graph structure is engine-neutral', () => {
  // Spanner's names, no measures, no metadata, and today's field SQL. This is
  // not the Spanner setting (b/573660675 adds that); it is only enough to show
  // the shared node tables, edge tables, labels, properties, and key and join
  // columns are the ones spanner.ts writes.
  const BARE: GraphEngine = {
    name: 'Spanner',
    table: spannerTable,
    unresolvedTable: quoteIdentifier,
    graphName: model => quoteIdentifier(model.name),
    placeMetrics: () => new Map(),
    elementOptions: () => undefined,
    fieldOptions: () => undefined,
    fieldExpression: fieldBinding,
  };

  // The Spanner e2e corpus: a star with metrics, a class hierarchy, a fan-out,
  // and reserved words with and without inheritance.
  for (const fixture of [
         'star_orders_customer.yaml',
         'hierarchy_graph.yaml',
         'sales_fanout.yaml',
         'reserved_words.yaml',
         'reserved_words_inherit.yaml',
       ]) {
    test(`${fixture} matches spanner.ts`, () => {
      const model = loadFixture(fixture);
      expect(generateGraphDdl(model, BARE).ddl)
          .toBe(generateSpannerPropertyGraph(model).ddl);
    });
  }

  test('an association edge matches spanner.ts', () => {
    const model: SemanticModel = {
      name: 'school_graph',
      entities: [
        {
          name: 'students',
          dataSource: 'students',
          keys: ['student_id'],
          fields: [{name: 'student_id', expression: 'students.student_id'}],
        },
        {
          name: 'courses',
          dataSource: 'courses',
          keys: ['course_id'],
          fields: [{name: 'course_id', expression: 'courses.course_id'}],
        },
      ],
      relationships: [{
        name: 'enrollment',
        source: {entity: 'students', columns: ['student_id']},
        destination: {entity: 'courses', columns: ['course_id']},
        association: {
          dataSource: 'enrollment',
          keys: ['enrollment_id'],
          sourceColumns: ['student_id'],
          destinationColumns: ['course_id'],
          fields: [{name: 'grade', expression: 'enrollment.grade'}],
        },
      }],
      metrics: [],
    };
    expect(generateGraphDdl(model, BARE).ddl)
        .toBe(generateSpannerPropertyGraph(model).ddl);
  });
});


describe('each engine difference comes from the setting', () => {
  // Every hook writes a visible marker, so the expected DDL shows where the
  // shared code puts what each one returns.
  const MARKED: GraphEngine = {
    name: 'Marked',
    table: dataSource => `<table ${dataSource}>`,
    unresolvedTable: entityName => `<unresolved ${entityName}>`,
    graphName: model => `<graph ${model.name}>`,
    placeMetrics: metrics => new Map([[
      'orders', {
        derivedProperties: ['<derived>'],
        measures: metrics.map(m => `<measure ${m.name}>`),
      }
    ]]),
    elementOptions: description =>
        description === undefined ? undefined : `<options ${description}>`,
    fieldOptions: field => field.description === undefined ?
        undefined :
        `<field options ${field.description}>`,
    fieldExpression: field =>
        field.name === 'amount' ? 'orders.amount_usd' : fieldBinding(field),
  };

  const MODEL: SemanticModel = {
    name: 'shop',
    entities: [
      {
        name: 'orders',
        dataSource: 'p.d.orders',
        keys: ['order_id'],
        description: 'One row per order',
        fields: [
          {name: 'order_id', expression: 'orders.order_id'},
          {name: 'amount', expression: 'orders.amount', description: 'Total'},
          {name: 'customer_id', expression: 'orders.customer_id'},
          {name: 'notes'},
        ],
      },
      {
        name: 'customers',
        dataSource: 'p.d.customers',
        keys: ['customer_id'],
        fields: [
          {name: 'customer_id', expression: 'CAST(customers.id AS STRING)'},
        ],
      },
    ],
    relationships: [
      {
        name: 'placed_by',
        source: {entity: 'orders', columns: ['customer_id']},
        destination: {entity: 'customers', columns: ['customer_id']},
        description: 'Who placed it',
      },
      {
        name: 'from_ghost',
        source: {entity: 'ghost', columns: ['customer_id']},
        destination: {entity: 'customers', columns: ['customer_id']},
      },
    ],
    metrics: [{name: 'revenue', expression: 'SUM(orders.amount)'}],
  };

  test('names, measures, metadata and SQL text land where the graph puts them',
       () => {
         expect(generateGraphDdl(MODEL, MARKED).ddl).toBe(`\
CREATE OR REPLACE PROPERTY GRAPH <graph shop>
NODE TABLES (
  <table p.d.orders> AS orders
    KEY(order_id)
    <options One row per order>
    PROPERTIES(
      order_id,
      amount_usd AS amount <field options Total>,
      customer_id,
      <derived>,
      <measure revenue>
    ),
  <table p.d.customers> AS customers
    KEY(CAST(id AS STRING))
    PROPERTIES(
      CAST(id AS STRING) AS customer_id
    )
)
EDGE TABLES (
  <table p.d.orders> AS placed_by
    KEY(order_id)
    SOURCE KEY(order_id) REFERENCES orders(order_id)
    DESTINATION KEY(customer_id) REFERENCES customers(CAST(id AS STRING))
    <options Who placed it>,
  <unresolved ghost> AS from_ghost
    KEY(customer_id)
    SOURCE KEY(customer_id) REFERENCES ghost(customer_id)
    DESTINATION KEY(customer_id) REFERENCES customers(CAST(id AS STRING))
);
`);
       });

  test('warnings name the engine', () => {
    const {warnings} = generateGraphDdl(MODEL, MARKED);
    expect(warnings).toContain(
        `entity 'customers': field 'customer_id' is bound to a non-column ` +
        `expression (CAST(id AS STRING)); a KEY/REFERENCES site ` +
        `requires a bare column, so Marked will reject the generated DDL`);
    // A field the setting has no SQL for is left out of its node table.
    expect(warnings).toContain(
        `entity 'orders': field 'notes' has no column under this binding; ` +
        `omitted from the node table (bind it, or govern the logical model in ` +
        `Knowledge Catalog instead)`);
  });

  test('placeMetrics sees the graph as the shared code built it', () => {
    let seen: {skipped: string[]; ancestorsUsed: string[]; entities: string[]}|
        undefined;
    const model: SemanticModel = {
      ...MODEL,
      entities: [
        ...MODEL.entities,
        {name: 'party', dataSource: '', keys: [], abstract: true, fields: []},
        {
          name: 'keyless',
          dataSource: 'p.d.keyless',
          keys: [],
          fields: [{name: 'x', expression: 'keyless.x'}],
        },
        {
          name: 'vip',
          dataSource: 'p.d.vip',
          keys: ['customer_id'],
          extends: ['party'],
          fields: [{name: 'customer_id', expression: 'vip.customer_id'}],
        },
      ],
    };
    generateGraphDdl(model, {
      ...MARKED,
      placeMetrics: (_metrics, input) => {
        seen = {
          skipped: [...input.skipped].sort(),
          ancestorsUsed: [...input.ancestorsUsed].sort(),
          entities: [...input.entityByName.keys()].sort(),
        };
        return new Map();
      },
    });
    expect(seen).toEqual({
      skipped: ['keyless', 'party'],
      ancestorsUsed: ['party'],
      entities: ['customers', 'keyless', 'orders', 'party', 'vip'],
    });
  });
});
