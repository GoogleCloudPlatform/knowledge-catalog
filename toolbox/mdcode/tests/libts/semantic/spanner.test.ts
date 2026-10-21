// Behavior specification for the Spanner property-graph generator
// (src/libts/semantic/spanner.ts).
//
// The readable "big picture" tests live in `spanner.e2e.test.ts`: a corpus of
// `<fixture>.yaml` inputs, each with a committed `<fixture>.spanner.golden.sql`
// showing the exact generated DDL and warnings. Prefer adding a fixture +
// golden there.
//
// This file holds what a loader fixture CANNOT express: an M:N association
// edge (the open format has no association-table syntax, so its IR is
// hand-built and checked against a committed golden), and degenerate/negative
// inputs and pure GenerateOptions behavior (graph naming, bare table mapping).
// It also checks which field text the graph reads and the rules it shares
// with the BigQuery graph.

import {describe, expect, test} from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import {generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {Entity, Field, SemanticModel, SqlDialect} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';
import {GenerateOptions, generateSpannerPropertyGraph} from '../../../src/libts/semantic/spanner';

const FIXTURES = path.join(__dirname, 'fixtures');

// A model with no relationships or metrics unless `more` gives them.
const modelOf = (name: string, entities: Entity[],
                 more: Partial<SemanticModel> = {}): SemanticModel =>
    ({name, entities, relationships: [], metrics: [], ...more});

// An entity with one field per entry of `fields`. A string is the field's
// expression.
const entity = (name: string, dataSource: string, keys: string[],
                fields: Record<string, string|Partial<Field>>,
                more: Partial<Entity> = {}): Entity => ({
  name, dataSource, keys, ...more,
  fields: Object.entries(fields).map(([field, f]) =>
      ({name: field, ...(typeof f === 'string' ? {expression: f} : f)})),
});

// A field's text in each dialect, stored as the loader stores it.
const texts = (sql: Record<string, string>): Partial<Field> => {
  const entries = Object.entries(sql) as [SqlDialect, string][];
  const other = entries.find(([d]) => d !== 'BIGQUERY' && d !== 'ANSI_SQL');
  return {
    expression: sql.BIGQUERY ?? sql.ANSI_SQL,
    dialects: entries.map(([dialect, expression]) => ({dialect, expression})),
    ...other && {importedExpression: other[1], importedDialect: other[0]},
  };
};


describe(
    'M:N association edge (no association-table syntax in the open format yet)',
    () => {
      // Hand-built because the loader's relationship schema is direct-FK only;
      // it cannot express an edge backed by its own association table with its
      // own KEY and edge properties. The expected DDL is a committed golden
      // (`school_manytomany.spanner.golden.sql`), the Spanner counterpart to
      // the BigQuery association golden, so the two shapes are reviewable side
      // by side.
      const SCHOOL: SemanticModel = {
        name: 'school_graph',
        entities: [
          {
            name: 'students',
            dataSource: 'sqlgen-testing.bei_semantic_ir_verify.students',
            keys: ['student_id'],
            fields: [
              {name: 'student_id', expression: 'students.student_id'},
              {name: 'name', expression: 'students.name'}
            ]
          },
          {
            name: 'courses',
            dataSource: 'sqlgen-testing.bei_semantic_ir_verify.courses',
            keys: ['course_id'],
            fields: [
              {name: 'course_id', expression: 'courses.course_id'},
              {name: 'title', expression: 'courses.title'}
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
                expression: 'enrollment.grade',
                description: 'Letter grade'
              }]
            }
          },
        ],
        metrics: [],
      };

      test('the association graph matches its committed golden DDL', () => {
        const {ddl} = generateSpannerPropertyGraph(SCHOOL);
        const golden =
            path.join(FIXTURES, 'school_manytomany.spanner.golden.sql');
        if (process.env.UPDATE_GOLDENS) {
          fs.writeFileSync(golden, ddl);
          return;
        }
        expect(ddl).toBe(fs.readFileSync(golden, 'utf8'));
      });

      test(
          'an edge property carries no OPTIONS (Spanner has no per-element options)',
          () => {
            // The junction's `grade` field has a description; on BigQuery that
            // becomes an OPTIONS clause, on Spanner it is dropped.
            const {ddl} = generateSpannerPropertyGraph(SCHOOL);
            expect(ddl).toContain('grade');
            expect(ddl).not.toContain('OPTIONS');
          });
    });


describe('graph naming', () => {
  const oneEntity = (): SemanticModel => ({
    name: 'my_model',
    relationships: [],
    metrics: [],
    entities: [{
      name: 'orders',
      dataSource: 'proj.ds.orders',
      keys: ['id'],
      fields: [{name: 'id', expression: 'orders.id'}]
    }],
  });

  test(
      'the graph name defaults to the model name, bare (no project.dataset)',
      () => {
        const {ddl} = generateSpannerPropertyGraph(oneEntity());
        expect(ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH my_model');
      });

  test('opts.graphName overrides the model name', () => {
    const {ddl} =
        generateSpannerPropertyGraph(oneEntity(), {graphName: 'chosen'});
    expect(ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH chosen');
  });

  test('a non-simple graph name is backtick-quoted', () => {
    // A hyphen is not a valid unquoted GoogleSQL identifier; the graph name
    // from a deployment-target URI can contain one, so it must be quoted.
    const opts: GenerateOptions = {graphName: 'sales-graph'};
    const {ddl} = generateSpannerPropertyGraph(oneEntity(), opts);
    expect(ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH `sales-graph`');
  });

  test(
      'an unbound field (no column) is omitted from the node table with a warning',
      () => {
        // Pruning normally removes unbound fields; generating DDL without
        // pruning (e.g. straight from a bindingOptional load) must not emit the
        // field as a phantom bare column.
        const model = oneEntity();
        model.entities[0].fields.push({name: 'notes'});  // no expression/binding
        const {ddl, warnings} = generateSpannerPropertyGraph(model);
        expect(ddl).not.toContain('notes');
        expect(warnings.some(
                   w => w.includes('notes') && w.includes('no column')))
            .toBe(true);
      });
});


describe('bare table mapping', () => {
  const withSource = (source: string): SemanticModel => ({
    name: 'm',
    relationships: [],
    metrics: [],
    entities: [{
      name: 'orders',
      dataSource: source,
      keys: ['id'],
      fields: [{name: 'id', expression: 'orders.id'}]
    }],
  });

  test('a three-part source reduces to its final table segment', () => {
    const {ddl} = generateSpannerPropertyGraph(withSource('proj.ds.Orders'));
    expect(ddl).toContain('Orders AS orders');
    expect(ddl).not.toContain('proj.ds.Orders');
  });

  test('a bare source is used as-is', () => {
    const {ddl} = generateSpannerPropertyGraph(withSource('Orders'));
    expect(ddl).toContain('Orders AS orders');
  });

  test('a backtick-quoted final segment is unwrapped to its bare name', () => {
    const {ddl} = generateSpannerPropertyGraph(withSource('proj.ds.`Orders`'));
    expect(ddl).toContain('Orders AS orders');
  });

  test('a Spanner resource-name URI reduces to its final path segment', () => {
    // A binding profile may name a Spanner source by its AIP-122 resource
    // name; the loader keeps it verbatim, so the generator must reduce it to
    // the bare table (the naive dotted split left `com/.../tables/Orders`).
    const {ddl} = generateSpannerPropertyGraph(withSource(
        '//spanner.googleapis.com/projects/p/instances/i/databases/d/tables/Orders'));
    expect(ddl).toContain('Orders AS orders');
    expect(ddl).not.toContain('googleapis');
    expect(ddl).not.toContain('tables/Orders');
  });

  test('a scheme:// source URI reduces to its final path segment', () => {
    const {ddl} =
        generateSpannerPropertyGraph(withSource('iceberg://cat/db/Orders'));
    expect(ddl).toContain('Orders AS orders');
    expect(ddl).not.toContain('iceberg');
  });

  test(
      'a dot INSIDE a quoted final segment does not split the table name',
      () => {
        // The naive `split('.')` mangled `weird.name` into `name`; the quoted
        // segment must survive whole (and be re-quoted, since it is not a
        // simple identifier).
        const {ddl} =
            generateSpannerPropertyGraph(withSource('proj.ds.`weird.name`'));
        expect(ddl).toContain('`weird.name` AS orders');
        expect(ddl).not.toContain('name AS orders');
      });

  test(
      'a query source is emitted verbatim (parenthesized) with a warning',
      () => {
        const {ddl, warnings} =
            generateSpannerPropertyGraph(withSource('SELECT * FROM t'));
        expect(ddl).toContain('(SELECT * FROM t) AS orders');
        expect(warnings.some(w => w.includes('looks like a query'))).toBe(true);
      });
});


describe(
    'remapped physical columns (a profile binds fields to differently named columns)',
    () => {
      // A binding profile can map a logical field onto a differently named
      // physical column (a warehouse's `o_orderkey` vs an operational store's
      // `OrderId`). Every structural site -- node KEY, edge KEY / SOURCE KEY /
      // DESTINATION KEY, and each REFERENCES target -- must name the physical
      // column, never the property alias exposed under the field name, or
      // Spanner rejects the DDL
      // ("Column 'o_orderkey' not found in table 'Orders'"). PROPERTIES still
      // exposes the alias. Mirrors the BigQuery leg.
      const remapped = (): SemanticModel => ({
        name: 'sales',
        metrics: [],
        entities: [
          {
            name: 'orders',
            dataSource: 'Orders',
            keys: ['o_orderkey'],
            fields: [
              {name: 'o_orderkey', expression: 'OrderId'},
              {name: 'o_custkey', expression: 'CustomerId'},
            ],
          },
          {
            name: 'customer',
            dataSource: 'Customers',
            keys: ['c_custkey'],
            fields: [
              {name: 'c_custkey', expression: 'CustomerId'},
              {name: 'c_name', expression: 'FullName'},
            ],
          },
        ],
        relationships: [{
          name: 'orders_to_customer',
          source: {entity: 'orders', columns: ['o_custkey']},
          destination: {entity: 'customer', columns: ['c_custkey']},
        }],
      });

      test(
          'node KEY names the physical column, PROPERTIES keeps the alias',
          () => {
            const {ddl} = generateSpannerPropertyGraph(remapped());
            expect(ddl).toContain('KEY(OrderId)');
            expect(ddl).not.toContain('KEY(o_orderkey)');
            expect(ddl).toContain('OrderId AS o_orderkey');
          });

      test(
          'edge SOURCE/DESTINATION KEY and REFERENCES name physical columns',
          () => {
            const {ddl} = generateSpannerPropertyGraph(remapped());
            expect(ddl).toContain(
                'SOURCE KEY(OrderId) REFERENCES orders(OrderId)');
            expect(ddl).toContain(
                'DESTINATION KEY(CustomerId) REFERENCES customer(CustomerId)');
            // The FK's logical name may still appear as a PROPERTIES alias
            // (`CustomerId AS o_custkey`); it must not appear at a key site.
            expect(ddl).not.toContain('KEY(o_custkey)');
          });

      test(
          'a key field bound to a non-column expression is warned (Spanner needs a bare column)',
          () => {
            const model = remapped();
            model.entities[0].fields[0].expression = 'UPPER(OrderId)';
            const {warnings} = generateSpannerPropertyGraph(model);
            expect(warnings.some(
                       w => w.includes('o_orderkey') &&
                           w.includes('non-column expression')))
                .toBe(true);
          });
    });

describe('degenerate inputs', () => {
  test(
      'a model with no entities throws (an empty NODE TABLES is invalid DDL)',
      () => {
        expect(
            () => generateSpannerPropertyGraph(
                {name: 'm', entities: [], relationships: [], metrics: []}))
            .toThrow(/at least one NODE TABLE/);
      });

  test('an entity with no KEY is skipped and warned', () => {
    const model: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'good',
          dataSource: 'ds.good',
          keys: ['id'],
          fields: [{name: 'id', expression: 'good.id'}]
        },
        {name: 'bad', dataSource: 'ds.bad', keys: [], fields: []},
      ],
    };
    const {ddl, warnings} = generateSpannerPropertyGraph(model);
    expect(ddl).toContain('good AS good');
    expect(ddl).not.toContain('AS bad');
    expect(warnings.some(w => w.includes('empty KEY'))).toBe(true);
  });
});

describe('reserved-word names in an M:N association edge are quoted', () => {
  // The open format has no association-table syntax, so this hand-built IR is
  // the only path that exercises renderAssociationEdge's identifier quoting on
  // the Spanner leg: the edge alias, KEY, SOURCE KEY / DESTINATION KEY columns,
  // and both REFERENCES labels, each named with a GoogleSQL reserved keyword.
  // Table names stay bare (Spanner graphs live in one database).
  const RW_ASSOC: SemanticModel = {
    name: 'rw_assoc',
    entities: [
      {
        name: 'Order',
        dataSource: 'proj.ds.orders',
        keys: ['order'],
        fields: [{name: 'order', expression: 'Order.order'}],
      },
      {
        name: 'Group',
        dataSource: 'proj.ds.groups',
        keys: ['id'],
        fields: [{name: 'id', expression: 'Group.id'}],
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
    const {ddl} = generateSpannerPropertyGraph(RW_ASSOC, {});
    expect(ddl).toContain('order_group AS `from`');
    expect(ddl).toContain('KEY(`order`)');
    expect(ddl).toContain('SOURCE KEY(`order`) REFERENCES `Order`(`order`)');
    expect(ddl).toContain('DESTINATION KEY(id) REFERENCES `Group`(id)');
  });
});


test('a field, key or join column reads its SPANNER text, else its ANSI_SQL text, without comments', () => {
  // Spanner reads `#` as a comment, where PostgreSQL reads an operator. `share`
  // is written only for Snowflake, and a transpile pass wrote BigQuery SQL into
  // its `expression`.
  const {ddl, warnings} = generateSpannerPropertyGraph(modelOf('shop', [
    entity('orders', 'Orders', ['id'], {
      id: 'orders.order_id -- the key',
      cust: 'orders.cust_id /* the customer */',
      order_day: texts({BIGQUERY: 'TIMESTAMP_TRUNC(order_ts, DAY)',
                        SPANNER: "TIMESTAMP_TRUNC(order_ts, DAY, 'UTC')",
                        ANSI_SQL: "DATE_TRUNC('day', order_ts)"}),
      order_month: texts({BIGQUERY: 'TIMESTAMP_TRUNC(order_ts, MONTH)',
                          ANSI_SQL: "DATE_TRUNC('month', order_ts)"}),
      region: texts({BIGQUERY: 'region_code'}),
      ratio: texts({SNOWFLAKE: 'DIV0(a, b)'}),
      share: {...texts({SNOWFLAKE: 'DIV0(a, b)'}), expression: 'SAFE_DIVIDE(a, b)'},
      flags: texts({POSTGRES: 'flags # 1'}),
      net: texts({POSTGRES: 'net_amount # in cents',
                  SPANNER: 'net_amount # in cents'}),
      tax: texts({POSTGRES: 'tax_amount # 1', ANSI_SQL: 'tax_amount # 1'}),
      fee: {importedExpression: 'fee_amount -- in cents',
            importedDialect: 'SPANNER'},
    }),
    entity('customers', 'customers', ['cid'],
           {cid: 'customers.customer_id # key'}),
  ], {relationships: [{name: 'placed_by',
                       source: {entity: 'orders', columns: ['cust']},
                       destination: {entity: 'customers', columns: ['cid']}}]}));
  for (const text of [
         `TIMESTAMP_TRUNC(order_ts, DAY, 'UTC') AS order_day`,
         `DATE_TRUNC('month', order_ts) AS order_month`, 'net_amount AS net',
         'tax_amount AS tax', 'fee_amount AS fee', 'KEY(order_id)',
         'KEY(customer_id)', 'SOURCE KEY(order_id) REFERENCES orders(order_id)',
         'DESTINATION KEY(cust_id) REFERENCES customers(customer_id)']) {
    expect(ddl).toContain(text);
  }
  for (const text of ['TIMESTAMP_TRUNC(order_ts, MONTH)', 'region', 'ratio',
                      'share', 'DIV0', 'SAFE_DIVIDE', 'flags', '#', 'in cents',
                      'the key', 'the customer']) {
    expect(ddl).not.toContain(text);
  }
  expect(warnings).toEqual(['region', 'ratio', 'share', 'flags'].map(
      f => `entity 'orders': field '${f}' has no 'SPANNER' or 'ANSI_SQL' ` +
          `expression; omitted from the node table`));
});


describe('rules the Spanner graph shares with the BigQuery graph', () => {
  // Each engine's name, generator, and quote around graph and table names.
  const ENGINES = [
    ['BigQuery', generatePropertyGraph, '`'],
    ['Spanner', generateSpannerPropertyGraph, ''],
  ] as const;

  // Customer inherits `email` from the concrete parent Person and maps it to
  // another column. Under the shared `Person` label the parent's column wins.
  test('a subtype that remaps an inherited column gets its parent\'s', () => {
    const model = modelOf('people', [
      entity('Person', 'Person', ['id'], {id: 'id', email: 'email'}),
      entity('Customer', 'Customer', ['id'], {id: 'id', email: 'contact_email'},
             {extends: ['Person']}),
    ]);
    for (const [engine, generate, q] of ENGINES) {
      const {ddl, warnings} = generate(model);
      expect(ddl).toBe(`\
CREATE OR REPLACE PROPERTY GRAPH ${q}people${q}
NODE TABLES (
  ${q}Person${q} AS Person
    KEY(id)
    DEFAULT LABEL
    PROPERTIES(
      id,
      email
    ),
  ${q}Customer${q} AS Customer
    KEY(id)
    DEFAULT LABEL
    PROPERTIES(
      id,
      email
    )
    LABEL Person
    PROPERTIES(
      id,
      email
    )
);
`);
      expect(warnings).toEqual([
        `entity 'Customer' remaps inherited property 'email' to a different ` +
            `column/expression than its supertype; ${engine} allows only ` +
            `one definition per property under a shared label, so the ` +
            `supertype's is used and the subclass's remapping is dropped`,
      ]);
    }
  });

  // Spanner drops the metric with a warning, and BigQuery emits it. No entity
  // in the lineitem fixture has a primary key, so the error comes before any
  // metric is reached.
  test('metric warnings come after the entity warnings, and the no-node-table error leaves them out', () => {
    const noKey = (e: string) => `entity '${e}': empty KEY (no primary key); ` +
        `node table skipped, as a graph node requires a KEY`;
    const shop = modelOf('shop', [
      entity('orders', 'Orders', ['id'], {id: 'id', amount: 'amount'}),
      entity('drafts', 'Drafts', [], {id: 'id'}),
      entity('party', '', [], {}, {abstract: true}),
    ], {metrics: [{name: 'revenue', entity: 'orders',
                   expression: 'SUM(orders.amount)'}]});
    const [lineitem] = loadModels(
        fs.readFileSync(path.join(FIXTURES, 'lineitem_databricks_ext.yaml'),
                        'utf8'),
        {allowLegacyBareSource: true}).models;
    for (const [engine, generate] of ENGINES) {
      expect(generate(shop).warnings, engine).toEqual([
        noKey('drafts'),
        `abstract entity 'party' is not a supertype of any concrete entity; ` +
            `it has no table and no descendant to label, so it produces no ` +
            `graph element`,
        ...engine === 'Spanner' ?
            [`metric 'revenue' is not emitted: Spanner Graph has no MEASURE, ` +
             `so model-level metrics have no home in it`] :
            [],
      ]);
      expect(() => generate(lineitem), engine).toThrow(new Error(
          'cannot generate a property graph: every entity was skipped ' +
          'because it has no primary key (a graph node requires a KEY); a ' +
          `graph requires at least one NODE TABLE\n${noKey('lineitem')}\n` +
          noKey('orders')));
    }
  });

  // A field written only for the other engine is left out. A table, label or
  // edge that this leaves with nothing to list gets NO PROPERTIES, since a
  // missing clause would expose every column of its table.
  test('NO PROPERTIES on an abstract label, a concrete parent\'s label, a table outside any hierarchy and an association edge', () => {
    for (const [engine, generate, q] of ENGINES) {
      const otherOnly = (column: string) =>
          texts({[engine === 'Spanner' ? 'BIGQUERY' : 'SPANNER']: column});
      expect(generate(modelOf('parties', [
        entity('Party', '', [], {email: {}}, {abstract: true}),
        entity('Customer', 'Customer', ['id'],
               {id: 'id', email: otherOnly('c_email')}, {extends: ['Party']}),
        entity('Supplier', 'Supplier', ['id'], {id: 'id', email: 's_email'},
               {extends: ['Party']}),
        entity('Person', 'Person', ['id'],
               {id: otherOnly('person_id'), email: otherOnly('p_email')}),
        entity('Employee', 'Employee', ['id'], {tier: 'tier'},
               {extends: ['Person']}),
        entity('Orders', 'Orders', ['id'],
               {id: otherOnly('order_id'), status: otherOnly('order_status')}),
      ], {relationships: [{
        name: 'supplied_by',
        source: {entity: 'Customer', columns: ['id']},
        destination: {entity: 'Supplier', columns: ['id']},
        association: {dataSource: 'CustomerSuppliers', keys: ['link_id'],
                      sourceColumns: ['customer_id'],
                      destinationColumns: ['supplier_id'],
                      fields: [{name: 'grade', ...otherOnly('grade')}]},
      }]})).ddl).toBe(`\
CREATE OR REPLACE PROPERTY GRAPH ${q}parties${q}
NODE TABLES (
  ${q}Customer${q} AS Customer
    KEY(id)
    DEFAULT LABEL
    PROPERTIES(
      id
    )
    LABEL Party
    NO PROPERTIES,
  ${q}Supplier${q} AS Supplier
    KEY(id)
    DEFAULT LABEL
    PROPERTIES(
      id,
      s_email AS email
    )
    LABEL Party
    NO PROPERTIES,
  ${q}Person${q} AS Person
    KEY(person_id)
    DEFAULT LABEL
    NO PROPERTIES,
  ${q}Employee${q} AS Employee
    KEY(person_id)
    DEFAULT LABEL
    PROPERTIES(
      tier
    )
    LABEL Person
    NO PROPERTIES,
  ${q}Orders${q} AS Orders
    KEY(order_id)
    NO PROPERTIES
)
EDGE TABLES (
  ${q}CustomerSuppliers${q} AS supplied_by
    KEY(link_id)
    SOURCE KEY(customer_id) REFERENCES Customer(id)
    DESTINATION KEY(supplier_id) REFERENCES Supplier(id)
    NO PROPERTIES
);
`);
    }
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
      dataSource: 'Orders',
      keys: ['id'],
      fields: [
        {name: 'id', expression: 'order_id -- the key'},
        {name: 'total', expression: 'amount -- in cents'},
        {name: 'notes', expression: '/* free text */ orders.notes'},
        {name: 'status', expression: 'status # open or closed'},
        {name: 'code', expression: "CONCAT('--', code)"},
      ],
    }],
  };

  test('is removed before the field is written', () => {
    const {ddl, warnings} = generateSpannerPropertyGraph(model);
    expect(ddl).toContain('KEY(order_id)');
    expect(ddl).toContain(
        '      order_id AS id,\n      amount AS total,\n      notes,\n' +
        "      status,\n      CONCAT('--', code) AS code\n");
    expect(ddl).not.toContain('the key');
    expect(ddl).not.toContain('free text');
    expect(warnings).toEqual([]);
  });

  test('next to a dot leaves no space, so the qualifier still comes off', () => {
    const dotted: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities: [{
        name: 'orders',
        dataSource: 'Orders',
        keys: ['id'],
        fields: [
          {name: 'id', expression: 'orders./* the key */order_id'},
          {name: 'amount', expression: 'orders/* in cents */.amount'},
          {name: 'select', expression: 'orders. /* a keyword */ select'},
        ],
      }],
    };
    const {ddl, warnings} = generateSpannerPropertyGraph(dotted);
    expect(ddl).toContain('KEY(order_id)');
    expect(ddl).toContain(
        '      order_id AS id,\n      amount,\n      `select`\n');
    expect(warnings).toEqual([]);
  });

  test('on an inherited field is read in its own dialect, even when a vendor entry holds the same text', () => {
    // Read as PostgreSQL, where `#` is an operator, the apostrophe opens a
    // string and the subtype's property keeps `base.second`.
    const text = "base.first # base's first\n|| base.second || ' '";
    const inherited: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'base',
          dataSource: 'Base',
          keys: ['id'],
          fields: [
            {name: 'id', expression: 'id'},
            {name: 'label', expression: text, importedExpression: text,
             importedDialect: 'POSTGRES',
             dialects: [{dialect: 'POSTGRES', expression: text},
                        {dialect: 'SPANNER', expression: text}]},
          ],
        },
        {name: 'orders', dataSource: 'Orders', keys: ['id'], extends: ['base'],
         fields: []},
      ],
    };
    const {ddl, warnings} = generateSpannerPropertyGraph(inherited);
    expect(ddl).not.toContain('base.second');
    expect(ddl.match(/first \|\| second \|\| ' ' AS label/g)).toHaveLength(3);
    expect(warnings).toEqual([]);
  });
});
