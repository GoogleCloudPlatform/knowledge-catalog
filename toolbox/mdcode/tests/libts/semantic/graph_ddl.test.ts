// Behavior specification for the shared GoogleSQL property-graph generator
// (src/libts/semantic/graph_ddl.ts).
//
// The BigQuery goldens (`bigquery.e2e.test.ts`, `bigquery.test.ts`) pin the
// BigQuery engine's output. This file checks the shared code itself: that each
// of the four engine differences -- names, measures, element metadata, SQL
// text -- comes from the engine.
//

import {afterEach, beforeEach, describe, expect, test} from 'bun:test';

import {generateGraphDdl, GraphEngine, graphInheritanceEnabled} from '../../../src/libts/semantic/graph_ddl';
import {fieldBinding, SemanticModel} from '../../../src/libts/semantic/ir';


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
    // Other SQL than the field's own for `order_id` and `amount`, and none for
    // `notes`, so the expected DDL shows every place the graph reads a field's
    // SQL: properties, and the filter that leaves out a field the engine has no
    // SQL for. Key and join columns name columns, so they never read it, even
    // where a field has their name.
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
    dialect: 'POSTGRES',
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
          {name: 'order_id', expression: 'order_id'},
          {name: 'amount', expression: 'amount', description: 'Total'},
          {name: 'customer_id', expression: 'customer_id'},
          {name: 'notes', expression: 'notes'},
          {name: 'memo'},
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
    KEY(order_id)
    <options One row per order>
    PROPERTIES(
      id AS order_id,
      amount_usd AS amount <field options Total>,
      customer_id,
      <derived>,
      <measure revenue>
    ),
  <table p.d.customers> AS customers
    KEY(customer_id)
    PROPERTIES(
      CAST(id AS STRING) AS customer_id
    )
)
EDGE TABLES (
  <table p.d.orders> AS placed_by
    KEY(order_id)
    SOURCE KEY(order_id) REFERENCES orders(order_id)
    DESTINATION KEY(customer_id) REFERENCES customers(customer_id)
    <options Who placed it>
    NO PROPERTIES,
  <table p.d.gifts> AS gifted_to
    KEY(gift_id)
    SOURCE KEY(order_id) REFERENCES orders(order_id)
    DESTINATION KEY(customer_id) REFERENCES customers(customer_id)
    <options Who received it>
    PROPERTIES(
      card_text AS message <field options Card text>
    ),
  <table ghost> AS from_ghost
    KEY(customer_id)
    SOURCE KEY(customer_id) REFERENCES ghost(customer_id)
    DESTINATION KEY(customer_id) REFERENCES customers(customer_id)
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
                 {name: 'order_id', expression: 'order_id'},
                 {
                   name: 'amount',
                   expression: 'amount',
                   description: 'Total'
                 },
                 {name: 'customer_id', expression: 'customer_id'},
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
    KEY(order_id)
    DEFAULT LABEL
    PROPERTIES(
      id AS order_id,
      amount_usd AS amount <field options Total>,
      customer_id
    ),
  <table p.d.gift_orders> AS gift_orders
    KEY(order_id)
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
    // A key named like a field with a computed expression is still a column.
    expect(warnings.filter(w => w.includes('KEY/REFERENCES'))).toEqual([]);
    const computedKey = {
      ...MODEL,
      entities: [MODEL.entities[0],
                 {...MODEL.entities[1], keys: ['CAST(id AS STRING)']}],
    };
    expect(generateGraphDdl(computedKey, MARKED).warnings).toContain(
        `entity 'customers': key or join column 'CAST(id AS STRING)' is not ` +
        `a physical column name; a KEY/REFERENCES site requires a column, so ` +
        `Marked will reject the generated DDL`);
    expect(warnings).toContain(
        `1 action(s) reach Knowledge Catalog only; the Marked push deploys ` +
        `none of them.`);
    expect(warnings).toContain(
        `1 constraint(s) reach Knowledge Catalog only; the Marked push ` +
        `deploys none of them.`);
    // A field the engine has no SQL for is left out of its node table. One
    // bound by SQL the engine does not read is named against the engine's
    // dialect; one with no SQL at all is unbound.
    expect(warnings).toContain(
        `entity 'orders': field 'notes' has no 'POSTGRES' or 'ANSI_SQL' ` +
        `expression; omitted from the node table`);
    expect(warnings).toContain(
        `entity 'orders': field 'memo' has no column under this binding; ` +
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
          fields: [{name: 'x', expression: 'x'}],
        },
        {
          name: 'vip',
          dataSource: 'p.d.vip',
          keys: ['customer_id'],
          extends: ['party'],
          fields: [{name: 'customer_id', expression: 'customer_id'}],
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

  describe('default behavior ignores abstract and extends unless KCMD_GRAPH_INHERITANCE=1', () => {
    let savedFlag: string|undefined;
    beforeEach(() => {
      savedFlag = process.env.KCMD_GRAPH_INHERITANCE;
      delete process.env.KCMD_GRAPH_INHERITANCE;
    });
    afterEach(() => {
      if (savedFlag === undefined) delete process.env.KCMD_GRAPH_INHERITANCE;
      else process.env.KCMD_GRAPH_INHERITANCE = savedFlag;
    });

    test('graphInheritanceEnabled returns true only when KCMD_GRAPH_INHERITANCE is "1"', () => {
      expect(graphInheritanceEnabled()).toBe(false);
      for (const val of ['', '0', 'true', 'yes', 'false']) {
        process.env.KCMD_GRAPH_INHERITANCE = val;
        expect(graphInheritanceEnabled()).toBe(false);
      }
      process.env.KCMD_GRAPH_INHERITANCE = '1';
      expect(graphInheritanceEnabled()).toBe(true);
    });

    test('ignores abstract entities and extends clauses with warnings, without mutating input', () => {
      let seenAncestors: string[] = [];
      const model: SemanticModel = {
        name: 'shop',
        entities: [
          {
            name: 'party',
            dataSource: '',
            keys: [],
            abstract: true,
            fields: [{name: 'party_name', description: 'Abstract name'}],
          },
          {
            name: 'orders',
            dataSource: 'p.d.orders',
            keys: ['order_id'],
            description: 'One row per order',
            excludedFields: ['secret'],
            fields: [
              {name: 'order_id', expression: 'order_id'},
              {name: 'amount', expression: 'amount', description: 'Total'},
              {name: 'customer_id', expression: 'customer_id'},
              {name: 'secret', expression: 'secret'},
            ],
          },
          {
            name: 'gift_orders',
            dataSource: 'p.d.gift_orders',
            keys: ['order_id'],
            extends: ['orders', 'party'],
            description: 'Orders sent as gifts',
            fields: [
              {name: 'order_id', expression: 'order_id'},
              {name: 'customer_id', expression: 'buyer_id'},
            ],
          },
        ],
        relationships: [],
        metrics: [],
      };

      const {ddl, warnings} = generateGraphDdl(model, {
        ...MARKED,
        placeMetrics: (_metrics, input) => {
          seenAncestors = [...input.ancestorsUsed];
          return new Map();
        },
      });

      expect(ddl).toBe(`\
CREATE OR REPLACE PROPERTY GRAPH <graph shop>
NODE TABLES (
  <table p.d.orders> AS orders
    KEY(order_id)
    <options One row per order>
    PROPERTIES(
      id AS order_id,
      amount_usd AS amount <field options Total>,
      customer_id
    ),
  <table p.d.gift_orders> AS gift_orders
    KEY(order_id)
    <options Orders sent as gifts>
    PROPERTIES(
      id AS order_id,
      buyer_id AS customer_id
    )
);
`);
      expect(seenAncestors).toEqual([]);
      expect(warnings).toEqual([
        `entity 'party': 'abstract' is not supported in Marked property-graph DDL generation; entity ignored`,
        `entity 'gift_orders': 'extends' is not supported in Marked property-graph DDL generation; inheritance ignored`,
      ]);
      // Input model is not mutated.
      expect(model.entities[0].abstract).toBe(true);
      expect(model.entities[2].extends).toEqual(['orders', 'party']);
    });

    test('throws cleanly when every entity is abstract, including the unsupported warning', () => {
      const onlyAbstract: SemanticModel = {
        name: 'empty_hierarchy',
        entities: [
          {name: 'party', dataSource: '', keys: [], abstract: true, fields: []},
        ],
        relationships: [],
        metrics: [],
      };
      expect(() => generateGraphDdl(onlyAbstract, MARKED)).toThrow(
          /every entity is abstract[\s\S]*'abstract' is not supported in Marked property-graph DDL generation/);
    });
  });
});
