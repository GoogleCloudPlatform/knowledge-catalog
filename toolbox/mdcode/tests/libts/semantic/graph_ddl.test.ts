// Behavior specification for the shared GoogleSQL property-graph generator
// (src/libts/semantic/graph_ddl.ts).
//
// The BigQuery goldens (`bigquery.e2e.test.ts`, `bigquery.test.ts`) pin the
// BigQuery engine's output. This file checks the shared code itself: that each
// of the four engine differences -- names, measures, element metadata, SQL
// text -- comes from the engine, and that an engine with Spanner's names, no
// measures and no metadata gives spanner.ts's graph on the Spanner test
// fixtures. One difference is known: a subtype that restates a field it
// inherits from a concrete parent with a different column gets the parent's
// column, BigQuery's supertype override, where spanner.ts writes the
// subtype's own.
//

import {describe, expect, test} from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import {spannerTable} from '../../../src/libts/semantic/binding';
import {generateGraphDdl, GraphEngine} from '../../../src/libts/semantic/graph_ddl';
import {fieldBinding, SemanticModel} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';
import {generateSpannerPropertyGraph} from '../../../src/libts/semantic/spanner';
import {fieldBindingWithoutComments} from '../../../src/libts/semantic/sql_expr_utils';
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
  // not the Spanner engine (that comes later); it is only enough to show that
  // on the Spanner test fixtures the shared node tables, edge tables, labels,
  // properties, and key and join columns are the ones spanner.ts writes. The
  // last test here pins the one known difference.
  const BARE: GraphEngine = {
    name: 'Spanner',
    table: spannerTable,
    graphName: model => quoteIdentifier(model.name),
    placeMetrics: () => new Map(),
    elementOptions: () => undefined,
    fieldOptions: () => undefined,
    fieldExpression: fieldBindingWithoutComments,
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

  test('fields with comments and vendor SQL match spanner.ts', () => {
    // spanner.ts removes a field's comments, and reads imported vendor SQL in
    // its own dialect, so a PostgreSQL `#` stays. The key and join columns read
    // the same SQL.
    const model: SemanticModel = {
      name: 'star',
      entities: [
        {
          name: 'orders',
          dataSource: 'orders',
          keys: ['id'],
          fields: [
            {name: 'id', expression: 'orders.order_id -- the key'},
            {name: 'cust', expression: 'orders.cust_id /* the customer */'},
            {
              name: 'flags',
              dialects: [{dialect: 'POSTGRES', expression: 'orders.flags # 1'}],
              importedExpression: 'orders.flags # 1',
              importedDialect: 'POSTGRES',
            },
          ],
        },
        {
          name: 'customers',
          dataSource: 'customers',
          keys: ['cid'],
          fields: [{name: 'cid', expression: 'customers.customer_id # key'}],
        },
      ],
      relationships: [{
        name: 'placed_by',
        source: {entity: 'orders', columns: ['cust']},
        destination: {entity: 'customers', columns: ['cid']},
      }],
      metrics: [],
    };
    expect(generateGraphDdl(model, BARE).ddl)
        .toBe(generateSpannerPropertyGraph(model).ddl);
  });

  test('a relationship hierarchy, an inverse and a shared abstract label match spanner.ts',
       () => {
         // An abstract super-relationship labels its descendants' edges, an
         // inverse is a second edge table read backwards, an abstract
         // supertype's label carries only the fields every subtype binds, and
         // every label states its properties (NO PROPERTIES when none).
         const model: SemanticModel = {
           name: 'deals',
           entities: [
             {
               name: 'party',
               dataSource: '',
               keys: [],
               abstract: true,
               fields: [{name: 'id'}, {name: 'region'}],
             },
             {
               name: 'client',
               dataSource: 'p.d.client',
               keys: ['id'],
               extends: ['party'],
               fields: [
                 {name: 'id', expression: 'client.client_id'},
                 {name: 'region', expression: 'client.region'},
               ],
             },
             {
               name: 'payer',
               dataSource: 'p.d.payer',
               keys: ['id'],
               extends: ['party'],
               fields: [{name: 'id', expression: 'payer.id'}],
             },
             {
               name: 'deal',
               dataSource: 'p.d.deal',
               keys: ['id'],
               fields: [
                 {name: 'id', expression: 'deal.id'},
                 {name: 'client_id', expression: 'deal.client_id'},
                 {name: 'payer_id', expression: 'deal.payer_id'},
               ],
             },
           ],
           relationships: [
             {
               name: 'hasCounterparty',
               abstract: true,
               source: {entity: 'deal', columns: []},
               destination: {entity: 'party', columns: []},
             },
             {
               name: 'hasBuyer',
               extends: ['hasCounterparty'],
               inverse: 'buys',
               source: {entity: 'deal', columns: ['client_id']},
               destination: {entity: 'client', columns: ['id']},
             },
             {
               name: 'hasPayer',
               extends: ['hasCounterparty'],
               source: {entity: 'deal', columns: ['payer_id']},
               destination: {entity: 'payer', columns: ['id']},
             },
           ],
           metrics: [],
         };
         const shared = generateGraphDdl(model, BARE).ddl;
         expect(shared).toBe(generateSpannerPropertyGraph(model).ddl);
         expect(shared).toContain('LABEL hasCounterparty NO PROPERTIES');
         expect(shared).toContain(' AS buys\n');
       });

  // The known difference. BigQuery allows one definition of a property under a
  // shared label, so the shared code gives a subtype's restated `email` the
  // parent's column and warns; spanner.ts writes the subtype's own column. A
  // later change removes the override.
  test('a subtype that remaps an inherited column differs from spanner.ts',
       () => {
         const model: SemanticModel = {
           name: 'people',
           entities: [
             {
               name: 'Person',
               dataSource: 'p.d.person',
               keys: ['id'],
               fields: [
                 {name: 'id', expression: 'Person.id'},
                 {name: 'email', expression: 'Person.email'},
               ],
             },
             {
               name: 'Customer',
               dataSource: 'p.d.customer',
               keys: ['id'],
               extends: ['Person'],
               fields: [
                 {name: 'id', expression: 'Customer.id'},
                 {name: 'email', expression: 'Customer.contact_email'},
               ],
             },
           ],
           relationships: [],
           metrics: [],
         };
         const spanner = generateSpannerPropertyGraph(model).ddl;
         expect(spanner).toContain('contact_email AS email');
         expect(generateGraphDdl(model, BARE).ddl)
             .toBe(spanner.replace('contact_email AS email', 'email'));
       });
});


describe('each engine difference comes from the engine', () => {
  // Every hook writes a visible marker, so the expected DDL shows where the
  // shared code puts what each one returns.
  const MARKED: GraphEngine = {
    name: 'Marked',
    table: dataSource => `<table ${dataSource}>`,
    graphName: model => `<graph ${model.name}>`,
    placeMetrics: metrics => new Map([[
      'orders', ['<derived>', ...metrics.map(m => `<measure ${m.name}>`)]
    ]]),
    elementOptions: description =>
        description === undefined ? undefined : `<options ${description}>`,
    fieldOptions: field => field.description === undefined ?
        undefined :
        `<field options ${field.description}>`,
    // Other SQL than the field's own for the key column and `amount`, and none
    // for `notes`, so the expected DDL shows every place the graph reads a
    // field's SQL: properties, key and join columns, and the filter that leaves
    // out a field the engine has no SQL for.
    fieldExpression: field => {
      switch (field.name) {
        case 'order_id':
          return 'id';
        case 'amount':
          return 'amount_usd';
        case 'notes':
          return undefined;
        default:
          return fieldBinding(field);
      }
    },
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
          {name: 'notes', expression: 'orders.notes'},
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
        name: 'gifted_to',
        source: {entity: 'orders', columns: []},
        destination: {entity: 'customers', columns: []},
        description: 'Who received it',
        association: {
          dataSource: 'p.d.gifts',
          keys: ['gift_id'],
          sourceColumns: ['order_id'],
          destinationColumns: ['customer_id'],
          fields: [{
            name: 'message',
            expression: 'gifted_to.card_text',
            description: 'Card text',
          }],
        },
      },
      {
        name: 'from_ghost',
        source: {entity: 'ghost', columns: ['customer_id']},
        destination: {entity: 'customers', columns: ['customer_id']},
      },
    ],
    metrics: [{name: 'revenue', expression: 'SUM(orders.amount)'}],
    actions: [{name: 'refund', parameters: []}],
    constraints: [{name: 'amount_is_positive'}],
  };

  test('names, measures, metadata and SQL text land where the graph puts them',
       () => {
         expect(generateGraphDdl(MODEL, MARKED).ddl).toBe(`\
CREATE OR REPLACE PROPERTY GRAPH <graph shop>
NODE TABLES (
  <table p.d.orders> AS orders
    KEY(id)
    <options One row per order>
    PROPERTIES(
      id AS order_id,
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
    KEY(id)
    SOURCE KEY(id) REFERENCES orders(id)
    DESTINATION KEY(customer_id) REFERENCES customers(CAST(id AS STRING))
    <options Who placed it>
    NO PROPERTIES,
  <table p.d.gifts> AS gifted_to
    KEY(gift_id)
    SOURCE KEY(order_id) REFERENCES orders(id)
    DESTINATION KEY(customer_id) REFERENCES customers(CAST(id AS STRING))
    <options Who received it>
    PROPERTIES(
      card_text AS message <field options Card text>
    ),
  <table ghost> AS from_ghost
    KEY(customer_id)
    SOURCE KEY(customer_id) REFERENCES ghost(customer_id)
    DESTINATION KEY(customer_id) REFERENCES customers(CAST(id AS STRING))
    NO PROPERTIES
);
`);
       });

  // A subtype of a concrete entity shares its label. The supertype's label
  // loses its OPTIONS, the subtype's remapped `customer_id` gives way to the
  // supertype's, and the subtype's `LABEL orders` block repeats the
  // supertype's properties with the engine's SQL and field metadata. Both
  // warnings name the engine.
  test('a class hierarchy takes its metadata and SQL text from the engine',
       () => {
         const model: SemanticModel = {
           name: 'shop',
           entities: [
             {
               name: 'orders',
               dataSource: 'p.d.orders',
               keys: ['order_id'],
               description: 'One row per order',
               fields: [
                 {name: 'order_id', expression: 'orders.order_id'},
                 {
                   name: 'amount',
                   expression: 'orders.amount',
                   description: 'Total'
                 },
                 {name: 'customer_id', expression: 'orders.customer_id'},
               ],
             },
             {
               name: 'gift_orders',
               dataSource: 'p.d.gift_orders',
               keys: ['order_id'],
               extends: ['orders'],
               description: 'Orders sent as gifts',
               fields: [
                 {name: 'customer_id', expression: 'gift_orders.buyer_id'},
               ],
             },
           ],
           relationships: [],
           metrics: [],
         };
         const {ddl, warnings} =
             generateGraphDdl(model, {...MARKED, placeMetrics: () => new Map()});
         expect(ddl).toBe(`\
CREATE OR REPLACE PROPERTY GRAPH <graph shop>
NODE TABLES (
  <table p.d.orders> AS orders
    KEY(id)
    DEFAULT LABEL
    PROPERTIES(
      id AS order_id,
      amount_usd AS amount <field options Total>,
      customer_id
    ),
  <table p.d.gift_orders> AS gift_orders
    KEY(id)
    DEFAULT LABEL
    <options Orders sent as gifts>
    PROPERTIES(
      customer_id,
      id AS order_id,
      amount_usd AS amount <field options Total>
    )
    LABEL orders
    PROPERTIES(
      id AS order_id,
      amount_usd AS amount <field options Total>,
      customer_id
    )
);
`);
         expect(warnings).toEqual([
           `entity 'orders' is a supertype in a class hierarchy; its ` +
               `description/synonyms are dropped from the shared 'orders' ` +
               `label (Marked forbids OPTIONS on a label bound by multiple ` +
               `tables)`,
           `entity 'gift_orders' remaps inherited property 'customer_id' to ` +
               `a different column/expression than its supertype; Marked ` +
               `allows only one definition per property under a shared ` +
               `label, so the supertype's is used and the subclass's ` +
               `remapping is dropped`,
         ]);
       });

  test('warnings name the engine', () => {
    const {warnings} = generateGraphDdl(MODEL, MARKED);
    expect(warnings).toContain(
        `entity 'customers': field 'customer_id' is bound to a non-column ` +
        `expression (CAST(id AS STRING)); a KEY/REFERENCES site ` +
        `requires a bare column, so Marked will reject the generated DDL`);
    expect(warnings).toContain(
        `1 action(s) reach Knowledge Catalog only; the Marked push deploys ` +
        `none of them.`);
    expect(warnings).toContain(
        `1 constraint(s) reach Knowledge Catalog only; the Marked push ` +
        `deploys none of them.`);
    // A field the engine has no SQL for is left out of its node table.
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

  // A super-relationship's label is shared by its descendants' edge tables, so
  // it loses its OPTIONS (the warning names the engine) and lists no
  // properties; an inverse reads the forward edge backwards and carries no
  // OPTIONS, since the description describes the forward reading.
  test('an edge hierarchy and an inverse take their metadata from the engine',
       () => {
         const model: SemanticModel = {
           name: 'shop',
           entities: [
             {
               name: 'orders',
               dataSource: 'p.d.orders',
               keys: ['order_id'],
               fields: [
                 {name: 'order_id', expression: 'orders.order_id'},
                 {name: 'customer_id', expression: 'orders.customer_id'},
               ],
             },
             {
               name: 'customers',
               dataSource: 'p.d.customers',
               keys: ['customer_id'],
               fields: [
                 {name: 'customer_id', expression: 'customers.customer_id'},
               ],
             },
           ],
           relationships: [
             {
               name: 'involves',
               description: 'Any party',
               source: {entity: 'orders', columns: ['customer_id']},
               destination: {entity: 'customers', columns: ['customer_id']},
             },
             {
               name: 'placed_by',
               extends: ['involves'],
               inverse: 'placed',
               description: 'Who placed it',
               source: {entity: 'orders', columns: ['customer_id']},
               destination: {entity: 'customers', columns: ['customer_id']},
             },
           ],
           metrics: [],
         };
         const {ddl, warnings} =
             generateGraphDdl(model, {...MARKED, placeMetrics: () => new Map()});
         expect(ddl).toBe(`\
CREATE OR REPLACE PROPERTY GRAPH <graph shop>
NODE TABLES (
  <table p.d.orders> AS orders
    KEY(id)
    PROPERTIES(
      id AS order_id,
      customer_id
    ),
  <table p.d.customers> AS customers
    KEY(customer_id)
    PROPERTIES(
      customer_id
    )
)
EDGE TABLES (
  <table p.d.orders> AS involves
    KEY(id)
    SOURCE KEY(id) REFERENCES orders(id)
    DESTINATION KEY(customer_id) REFERENCES customers(customer_id)
    DEFAULT LABEL
    NO PROPERTIES,
  <table p.d.orders> AS placed_by
    KEY(id)
    SOURCE KEY(id) REFERENCES orders(id)
    DESTINATION KEY(customer_id) REFERENCES customers(customer_id)
    DEFAULT LABEL
    <options Who placed it>
    NO PROPERTIES
    LABEL involves NO PROPERTIES,
  <table p.d.orders> AS placed
    KEY(id)
    SOURCE KEY(customer_id) REFERENCES customers(customer_id)
    DESTINATION KEY(id) REFERENCES orders(id)
    NO PROPERTIES
);
`);
         expect(warnings).toContain(
             `relationship 'involves' is a super-relationship in a ` +
             `relationship hierarchy; its description/synonyms are dropped ` +
             `from the shared 'involves' label (Marked forbids OPTIONS on a ` +
             `label bound by multiple tables)`);
       });

  // The optional hooks: an engine may lower the resolved model onto views it
  // generates (the graph reads what lowerModel returns), give a node's label
  // its own metadata (edges keep elementOptions), and word the constraint
  // warning. Without them, the defaults above hold.
  test('the optional hooks lower the model, label nodes and word constraints',
       () => {
         const model: SemanticModel = {
           name: 'shop',
           entities: [
             {
               name: 'orders',
               dataSource: 'p.d.orders',
               keys: ['order_id'],
               description: 'One row per order',
               fields: [
                 {name: 'order_id', expression: 'orders.order_id'},
                 {name: 'customer_id', expression: 'orders.customer_id'},
               ],
             },
             {
               name: 'gift_orders',
               dataSource: 'p.d.gift_orders',
               keys: ['order_id'],
               extends: ['orders'],
               fields: [],
             },
           ],
           relationships: [],
           metrics: [],
           constraints: [{name: 'a'}, {name: 'b'}],
         };
         let seen: SemanticModel|undefined;
         const {ddl, warnings} = generateGraphDdl(model, {
           ...MARKED,
           placeMetrics: () => new Map(),
           lowerModel: (resolved, warnings) => {
             seen = resolved;
             warnings.push('<lowered>');
             return {
               ...resolved,
               entities: resolved.entities.map(
                   e => e.name === 'gift_orders' ?
                       {...e, dataSource: 'p.d.gift_view'} :
                       e),
             };
           },
           entityOptions: entity => `<entity options ${entity.name}>`,
           constraintWarning: count => `<${count} constraint(s)>`,
         });
         // The hook sees the inheritance-resolved model: the subtype carries
         // its supertype's fields.
         expect(seen?.entities.find(e => e.name === 'gift_orders')
                    ?.fields.map(f => f.name)
                    .sort())
             .toEqual(['customer_id', 'order_id']);
         // The graph reads the lowered model.
         expect(ddl).toContain('<table p.d.gift_view> AS gift_orders');
         // entityOptions labels the subtype's node; the supertype's shared label
         // still drops its metadata, with the warning naming the engine.
         expect(ddl).toContain('    <entity options gift_orders>\n');
         expect(ddl).not.toContain('<entity options orders>');
         expect(ddl).not.toContain('One row per order');
         expect(warnings).toContain(
             `entity 'orders' is a supertype in a class hierarchy; its ` +
             `description/synonyms are dropped from the shared 'orders' ` +
             `label (Marked forbids OPTIONS on a label bound by multiple ` +
             `tables)`);
         expect(warnings).toContain('<lowered>');
         expect(warnings).toContain('<2 constraint(s)>');
         expect(warnings.some(w => w.includes('reach Knowledge Catalog only')))
             .toBe(false);
       });
});
