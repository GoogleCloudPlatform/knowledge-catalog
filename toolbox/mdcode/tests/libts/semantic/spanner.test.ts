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
import {applyProfileExclusions, pruneUnavailable} from '../../../src/libts/semantic/resolve_profiles';
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

// Each engine's name, generator, and quote around graph and table names.
const ENGINES = [
  ['BigQuery', generatePropertyGraph, '`'],
  ['Spanner', generateSpannerPropertyGraph, ''],
] as const;

// The trimmed KEY and REFERENCES lines of `ddl`, without a trailing comma.
const keyLines = (ddl: string) => ddl.split('\n')
    .filter(l => /KEY\(|REFERENCES/.test(l))
    .map(l => l.trim().replace(/,$/, ''));


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
      fields: [{name: 'id', expression: 'id'}]
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
      fields: [{name: 'id', expression: 'id'}]
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
      // ("Column 'o_orderkey' not found in table 'Orders'"). Keys and join
      // columns name the physical columns themselves, and PROPERTIES still
      // exposes the alias. Mirrors the BigQuery leg.
      const remapped = (): SemanticModel => ({
        name: 'sales',
        metrics: [],
        entities: [
          {
            name: 'orders',
            dataSource: 'Orders',
            keys: ['OrderId'],
            fields: [
              {name: 'o_orderkey', expression: 'OrderId'},
              {name: 'o_custkey', expression: 'CustomerId'},
            ],
          },
          {
            name: 'customer',
            dataSource: 'Customers',
            keys: ['CustomerId'],
            fields: [
              {name: 'c_custkey', expression: 'CustomerId'},
              {name: 'c_name', expression: 'FullName'},
            ],
          },
        ],
        relationships: [{
          name: 'orders_to_customer',
          source: {entity: 'orders', columns: ['CustomerId']},
          destination: {entity: 'customer', columns: ['CustomerId']},
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
          'a key that is not a column name is warned (Spanner needs a bare column)',
          () => {
            const model = remapped();
            model.entities[0].keys = ['UPPER(OrderId)'];
            const {warnings} = generateSpannerPropertyGraph(model);
            expect(warnings.some(
                       w => w.includes('UPPER(OrderId)') &&
                           w.includes('not a physical column name')))
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
          fields: [{name: 'id', expression: 'id'}]
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
    const {ddl} = generateSpannerPropertyGraph(RW_ASSOC, {});
    expect(ddl).toContain('order_group AS `from`');
    expect(ddl).toContain('KEY(`order`)');
    expect(ddl).toContain('SOURCE KEY(`order`) REFERENCES `Order`(`order`)');
    expect(ddl).toContain('DESTINATION KEY(id) REFERENCES `Group`(id)');
  });
});


test('a field reads its SPANNER text, else its ANSI_SQL text, without comments', () => {
  // Spanner reads `#` as a comment, where PostgreSQL reads an operator. `share`
  // is written only for Snowflake, and a transpile pass wrote BigQuery SQL into
  // its `expression`.
  const {ddl, warnings} = generateSpannerPropertyGraph(modelOf('shop', [
    entity('orders', 'Orders', ['order_id'], {
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
    entity('customers', 'customers', ['customer_id'],
           {cid: 'customers.customer_id # key'}),
  ], {relationships: [{name: 'placed_by',
                       source: {entity: 'orders', columns: ['cust_id']},
                       destination: {entity: 'customers', columns: ['customer_id']}}]}));
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

  // Spanner drops the metric with a warning, and BigQuery emits it. The
  // lineitem fixture's orders is keyed only by a unique key; with that taken
  // away no entity has a key, so the error comes before any metric is reached.
  test('metric warnings come after the entity warnings, and the no-node-table error leaves them out', () => {
    const noKey = (e: string) => `entity '${e}': empty KEY (no primary key); ` +
        `node table skipped, as a graph node requires a KEY`;
    const shop = modelOf('shop', [
      entity('orders', 'Orders', ['id'], {id: 'id', amount: 'amount'}),
      entity('drafts', 'Drafts', [], {id: 'id'}),
      entity('party', '', [], {}, {abstract: true}),
    ], {metrics: [{name: 'revenue', entity: 'orders',
                   expression: 'SUM(orders.amount)'}]});
    const [loaded] = loadModels(
        fs.readFileSync(path.join(FIXTURES, 'lineitem_databricks_ext.yaml'),
                        'utf8'),
        {allowLegacyBareSource: true}).models;
    const lineitem = {
      ...loaded,
      entities: loaded.entities.map(e => ({...e, uniqueKeys: undefined})),
    };
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
        entity('Person', 'Person', ['person_id'],
               {id: otherOnly('person_id'), email: otherOnly('p_email')}),
        entity('Employee', 'Employee', ['person_id'], {tier: 'tier'},
               {extends: ['Person']}),
        entity('Orders', 'Orders', ['order_id'],
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


// Keys and join columns are physical column names, so each engine writes them
// as written and never reads a field of the same name.
describe('key and join columns, on both engines', () => {
  // orders placed by customers, joined from `from` to `to`.
  const shop = (orders: Entity, customers: Entity, from: string[], to: string[]) =>
      modelOf('shop', [orders, customers], {relationships: [{
        name: 'placed_by',
        source: {entity: 'orders', columns: from},
        destination: {entity: 'customers', columns: to},
      }]});
  const keyWarnings = (warnings: string[]) =>
      warnings.filter(w => w.includes('KEY/REFERENCES'));

  test('a primary key named like a field with a computed expression emits the bare column', () => {
    const model = shop(
        entity('orders', 'Orders', ['raw_order_id'], {
          raw_order_id: 'CAST(raw_order_id AS STRING)',
          customer_id: 'customer_id',
        }),
        entity('customers', 'Customers', ['customer_id'],
               {customer_id: 'CAST(customer_id AS STRING)'}),
        ['customer_id'], ['customer_id']);
    for (const [engine, generate] of ENGINES) {
      const {ddl, warnings} = generate(model);
      for (const text of [
             'KEY(raw_order_id)', 'KEY(customer_id)',
             'SOURCE KEY(raw_order_id) REFERENCES orders(raw_order_id)',
             'DESTINATION KEY(customer_id) REFERENCES customers(customer_id)',
             'CAST(raw_order_id AS STRING) AS raw_order_id']) {
        expect(ddl, engine).toContain(text);
      }
      expect(ddl, engine).not.toContain('KEY(CAST');
      expect(ddl, engine).not.toContain('(CAST(customer_id AS STRING))');
      expect(keyWarnings(warnings), engine).toEqual([]);
    }
  });

  test('a join column with no matching field emits as written', () => {
    // Neither `cust_fk` nor `customer_id` is a field. A column that is not a
    // simple identifier is backtick-quoted, as a reserved one is.
    const model = shop(
        entity('orders', 'Orders', ['order_id'], {id: 'order_id'}),
        entity('customers', 'Customers', ['customer_id'], {name: 'name'}),
        ['cust_fk'], ['customer_id']);
    const quoted = shop(
        entity('orders', 'Orders', ['order_id'], {id: 'order_id'}),
        entity('customers', 'Customers', ['2nd_id'], {name: 'name'}),
        ['select'], ['2nd_id']);
    for (const [engine, generate] of ENGINES) {
      const {ddl, warnings} = generate(model);
      expect(ddl, engine).toContain(
          'DESTINATION KEY(cust_fk) REFERENCES customers(customer_id)');
      expect(keyWarnings(warnings), engine).toEqual([]);
      const other = generate(quoted);
      expect(other.ddl, engine).toContain(
          'DESTINATION KEY(`select`) REFERENCES customers(`2nd_id`)');
      expect(other.ddl, engine).toContain('KEY(`2nd_id`)');
      expect(keyWarnings(other.warnings), engine).toEqual([]);
    }
  });

  test('a backtick-quoted column emits as written, with no warning', () => {
    const model = shop(
        entity('orders', 'Orders', ['`order id`'], {id: '`order id`'}),
        entity('customers', 'Customers', ['`customer id`'],
               {id: '`customer id`'}),
        ['`cust fk`'], ['`customer id`']);
    for (const [engine, generate] of ENGINES) {
      const {ddl, warnings} = generate(model);
      for (const text of [
             'KEY(`order id`)', 'KEY(`customer id`)',
             'SOURCE KEY(`order id`) REFERENCES orders(`order id`)',
             'DESTINATION KEY(`cust fk`) REFERENCES customers(`customer id`)']) {
        expect(ddl, engine).toContain(text);
      }
      expect(warnings, engine).toEqual([]);
    }
  });

  test('a key or join column that is not a column name is written as is, with a warning', () => {
    const model = shop(
        entity('orders', 'Orders', ['order_id'], {id: 'order_id'}),
        entity('customers', 'Customers', ['customer_id'], {name: 'name'}),
        ['LOWER(cust_fk)'], ['customer_id']);
    for (const [engine, generate] of ENGINES) {
      const {ddl, warnings} = generate(model);
      expect(ddl, engine).toContain('DESTINATION KEY(LOWER(cust_fk))');
      expect(keyWarnings(warnings), engine).toEqual([
        `relationship 'placed_by': key or join column 'LOWER(cust_fk)' is ` +
            `not a physical column name; a KEY/REFERENCES site requires a ` +
            `column, so ${engine} will reject the generated DDL`,
      ]);
    }
  });

  test('a profile that excludes a field named like a key or join column leaves KEY and REFERENCES unchanged', () => {
    const model = shop(
        entity('orders', 'Orders', ['order_id'], {
          order_id: 'CAST(order_id AS STRING)',
          customer_id: 'UPPER(customer_id)',
          amount: 'amount',
        }),
        entity('customers', 'Customers', ['customer_id'],
               {customer_id: 'LOWER(customer_id)', name: 'name'}),
        ['customer_id'], ['customer_id']);
    const excluded = pruneUnavailable(applyProfileExclusions(model, [
      {model: 'shop', entity: 'orders', field: 'order_id'},
      {model: 'shop', entity: 'orders', field: 'customer_id'},
      {model: 'shop', entity: 'customers', field: 'customer_id'},
    ]), 'restricted').model;
    for (const [engine, generate] of ENGINES) {
      const before = generate(model);
      const after = generate(excluded);
      expect(keyLines(before.ddl), engine).toEqual([
        'KEY(order_id)',
        'KEY(customer_id)',
        'KEY(order_id)',
        'SOURCE KEY(order_id) REFERENCES orders(order_id)',
        'DESTINATION KEY(customer_id) REFERENCES customers(customer_id)',
      ]);
      expect(keyLines(after.ddl), engine).toEqual(keyLines(before.ddl));
      for (const text of ['CAST(', 'UPPER(', 'LOWER(']) {
        expect(after.ddl, engine).not.toContain(text);
      }
      expect(keyWarnings([...before.warnings, ...after.warnings]), engine)
          .toEqual([]);
    }
  });
});


// A relationship may join on a unique key, so an entity with no primary key is
// keyed by its first unique key, on both engines, wherever the graph reads its
// key.
describe('a node with no primary key, on both engines', () => {
  // customers states no primary key. Its first unique key is customer_code;
  // its second is email.
  const customers = (more: Partial<Entity> = {}) => entity(
      'customers', 'Customers', [], {name: 'name'},
      {uniqueKeys: [['customer_code'], ['email']], ...more});
  const orders = entity('orders', 'Orders', ['order_id'], {amount: 'amount'});
  const regions =
      entity('regions', 'Regions', ['region_id'], {label: 'label'});

  test('an entity with only a unique key gets a node keyed by it, and an edge to it is emitted', () => {
    // `drafts` states neither key (an empty unique key counts as none), so it
    // still gets no node table.
    const model = modelOf('shop', [
      orders, customers(),
      entity('drafts', 'Drafts', [], {note: 'note'}, {uniqueKeys: [[]]}),
    ], {relationships: [
      {
        name: 'placed_by',
        source: {entity: 'orders', columns: ['cust_code']},
        destination: {entity: 'customers', columns: ['customer_code']},
      },
      {
        name: 'gifted_to',
        source: {entity: 'orders', columns: []},
        destination: {entity: 'customers', columns: []},
        association: {
          dataSource: 'Gifts',
          keys: ['gift_id'],
          sourceColumns: ['order_id'],
          destinationColumns: ['customer_code'],
          fields: [],
        },
      },
    ]});
    for (const [engine, generate] of ENGINES) {
      const {ddl, warnings} = generate(model);
      expect(keyLines(ddl), engine).toEqual([
        'KEY(order_id)',
        'KEY(customer_code)',
        'KEY(order_id)',
        'SOURCE KEY(order_id) REFERENCES orders(order_id)',
        'DESTINATION KEY(cust_code) REFERENCES customers(customer_code)',
        'KEY(gift_id)',
        'SOURCE KEY(order_id) REFERENCES orders(order_id)',
        'DESTINATION KEY(customer_code) REFERENCES customers(customer_code)',
      ]);
      expect(ddl, engine).not.toContain('AS drafts');
      expect(warnings, engine).toEqual([
        `entity 'drafts': empty KEY (no primary key); node table skipped, ` +
            `as a graph node requires a KEY`,
      ]);
    }
  });

  test('an edge from it uses its unique key', () => {
    const model = modelOf('shop', [customers(), regions], {relationships: [{
      name: 'lives_in',
      source: {entity: 'customers', columns: ['region_fk']},
      destination: {entity: 'regions', columns: ['region_id']},
    }]});
    for (const [engine, generate] of ENGINES) {
      const {ddl, warnings} = generate(model);
      expect(keyLines(ddl), engine).toEqual([
        'KEY(customer_code)',
        'KEY(region_id)',
        'KEY(customer_code)',
        'SOURCE KEY(customer_code) REFERENCES customers(customer_code)',
        'DESTINATION KEY(region_fk) REFERENCES regions(region_id)',
      ]);
      expect(warnings, engine).toEqual([]);
    }
  });

  test('COUNT(*) anchored to it counts over that key', () => {
    const model = modelOf('shop', [customers()], {metrics: [
      {name: 'customer_count', entity: 'customers', expression: 'COUNT(*)'},
    ]});
    for (const [engine, generate] of ENGINES) {
      const {ddl, warnings} = generate(model);
      expect(ddl, engine).toContain('KEY(customer_code)');
      if (engine === 'BigQuery') {
        expect(ddl, engine).toContain(
            '      name,\n      customer_code,\n' +
            '      MEASURE(COUNT(customer_code)) AS customer_count\n');
        expect(warnings, engine).toEqual([]);
      } else {
        // Spanner Graph has no MEASURE, so only the node is keyed by it.
        expect(ddl, engine).not.toContain('MEASURE');
        expect(warnings, engine).toEqual([
          `metric 'customer_count' is not emitted: Spanner Graph has no ` +
              `MEASURE, so model-level metrics have no home in it`,
        ]);
      }
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
        keys: ['order_id'],
        fields: [
          {name: 'id', expression: 'orders./* the key */order_id'},
          {name: 'amount', expression: 'orders/* in cents */.amount_cents'},
          {name: 'select', expression: 'orders. /* a keyword */ group'},
        ],
      }],
    };
    const {ddl, warnings} = generateSpannerPropertyGraph(dotted);
    expect(ddl).toContain('KEY(order_id)');
    expect(ddl).toContain(
        '      order_id AS id,\n      amount_cents AS amount,\n' +
        '      `group` AS `select`\n');
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

describe('a field expression that names a sibling field', () => {
  // An `orders` entity keyed on `id`, with `fields` after the key.
  const ordersWith = (fields: Field[]): SemanticModel => ({
    name: 'm',
    relationships: [],
    metrics: [],
    entities: [{
      name: 'orders',
      dataSource: 'Orders',
      keys: ['id'],
      fields: [{name: 'id', expression: 'order_id'}, ...fields],
    }],
  });

  test('reads the columns its siblings are bound to', () => {
    const {ddl, warnings} = generateSpannerPropertyGraph(ordersWith([
      {name: 'gross', expression: 'g_amt'},
      {name: 'discount', expression: 'd_amt'},
      {name: 'net', expression: 'orders.gross - orders.discount'},
    ]));
    expect(ddl).toContain(
        '      g_amt AS gross,\n' +
        '      d_amt AS discount,\n' +
        '      g_amt - d_amt AS net\n');
    expect(warnings).toEqual([]);
  });

  test('reads a sibling\'s expression in parentheses, through a chain of siblings', () => {
    const {ddl} = generateSpannerPropertyGraph(ordersWith([
      {name: 'a', expression: 'x + y'},
      {name: 'b', expression: 'orders.a * 2'},
      {name: 'c', expression: 'orders.b + orders.a'},
    ]));
    expect(ddl).toContain(
        '      x + y AS a,\n' +
        '      (x + y) * 2 AS b,\n' +
        '      ((x + y) * 2) + (x + y) AS c\n');
  });

  // An expression that names a sibling is generated again from its parsed
  // form, so its SQL is rewritten in the parser's style.
  test('leaves an expression that names no sibling as written', () => {
    const {ddl} = generateSpannerPropertyGraph(ordersWith([
      {name: 'nm', expression: 'full_name'},
      {name: 'tag', expression: 'lower(full_name) || "!"'},
      {name: 'shout', expression: 'lower(orders.nm) || "!"'},
    ]));
    expect(ddl).toContain('      lower(full_name) || "!" AS tag,\n');
    expect(ddl).toContain('      LOWER(full_name) || \'!\' AS shout\n');
  });

  // The parser would write `DAYOFWEEK` as `DOW`, which Spanner does not read.
  test('leaves an expression as written when each sibling it names is bound to the column of its name', () => {
    const {ddl} = generateSpannerPropertyGraph(ordersWith([
      {name: 'd', expression: 'd'},
      {name: 'nm', expression: 'nm'},
      {name: 'dow', expression: 'EXTRACT(DAYOFWEEK FROM orders.d)'},
      {name: 'tag', expression: 'lower(orders.nm) || "!"'},
    ]));
    expect(ddl).toContain(
        '      EXTRACT(DAYOFWEEK FROM d) AS dow,\n' +
        '      lower(nm) || "!" AS tag\n');
  });

  test('two fields that name each other are rejected', () => {
    expect(() => generateSpannerPropertyGraph(ordersWith([
             {name: 'a', expression: 'orders.b + 1'},
             {name: 'b', expression: 'orders.a - 1'},
           ])))
        .toThrow(`field 'orders.a' names itself through 'orders.b'`);
    expect(() => generateSpannerPropertyGraph(ordersWith([
             {name: 'total', expression: 'orders.total * 2'},
           ])))
        .toThrow(`field 'orders.total' names itself;`);
  });

  test('a field whose sibling has no Spanner SQL is left out, with a warning that names the sibling', () => {
    const {ddl, warnings} = generateSpannerPropertyGraph(ordersWith([
      {name: 'gross', dialects: [{dialect: 'BIGQUERY', expression: 'g_amt'}]},
      {name: 'net', expression: 'orders.gross - 1'},
      {name: 'twice', expression: 'orders.net * 2'},
    ]));
    expect(ddl).not.toMatch(/AS (gross|net|twice)/);
    expect(warnings).toEqual([
      `entity 'orders': field 'gross' has no 'SPANNER' or 'ANSI_SQL' ` +
          `expression; omitted from the node table`,
      `entity 'orders': field 'net' reads field 'gross', which has no ` +
          `'SPANNER' or 'ANSI_SQL' expression; omitted from the node table`,
      `entity 'orders': field 'twice' reads field 'net', which reads field ` +
          `'gross', which has no 'SPANNER' or 'ANSI_SQL' expression; ` +
          `omitted from the node table`,
    ]);
  });
});
