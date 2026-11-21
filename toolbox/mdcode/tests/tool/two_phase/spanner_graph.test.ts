// Tests that push refuses a Spanner graph that Spanner would refuse before it
// writes anything: from the model alone for every Spanner deployment, and from
// reads of the database for each Spanner deployment it deploys
// (src/libts/semantic/validate.ts, src/tool/commands.ts).

import {expect} from 'bun:test';

import {at, CUSTOMER, err, has, scenarios, SPANNER, SPANNER_CUSTOMER, spannerGraph, when} from './harness';

const BAD_NAME = has("deployment 'sp' targets Spanner graph 'my-graph', but");

// Entities employee and purchase on tables employees and Order, each with a
// property `code`, and a relationship that references employee's unique key.
const GRAPH = {
  deployments: [{name: 'sp', target: spannerGraph('g')}],
  entities: [{
    name: 'employee', source: `${SPANNER}/tables/employees`,
    primary_key: ['id'], unique_keys: [['dept']],
    fields: [{name: 'id', expression: 'id'}, {name: 'code', expression: 'dept'}],
  }, {
    name: 'purchase', source: `${SPANNER}/tables/Order`, primary_key: ['order'],
    fields: [{name: 'order', expression: 'order'}, {name: 'code', expression: 'by'}],
  }],
  relationships: [{
    name: 'placed_by', from: 'purchase', to: 'employee',
    from_columns: ['by'], to_columns: ['dept'],
  }],
};
// The queries of the graph check, by what they read.
const isPlan = (sql: string, opts: any, table: string) =>
    opts?.plan && sql.includes(`FROM ${table} AS`);
const isNames = (sql: string) => sql.startsWith('SELECT kind, name');
const isKeys = (sql: string) => sql.includes('INDEX_COLUMNS');
// A plan whose columns have the types `codes` gives, in order.
const planned = (...codes: string[]) => ({
  status: 200,
  result: {metadata: {rowType: {fields: codes.map(code => ({type: {code}}))}}},
});
// The primary key of each table, and with `unique`, a unique index on
// employees.id.
const keyRows = (unique = false) => ({
  status: 200,
  result: {rows: [
    ['', 'employees', 'PRIMARY_KEY', 'emp_id'],
    ['', 'Order', 'PRIMARY_KEY', 'order'],
    ...unique ? [['', 'employees', 'by_id', 'ID']] : [],
  ]},
});
const UNBACKED = err(
    `${at('sp')}: the node table of entity 'employee' is keyed by (id), but ` +
    'neither the primary key of table employees nor a unique index on it is ' +
    'made of those columns, so Spanner cannot prove the key unique. Key it ' +
    "by columns that hold the table's primary key, or create a unique index " +
    'on (id).');

scenarios('a Spanner graph', [
  {
    name: 'that Spanner would refuse for its name is refused before the catalog preflight, also under --no-deployment, and kcmd profiles reports it',
    entities: [{...CUSTOMER, source: SPANNER_CUSTOMER}],
    deployments: [{name: 'sp', target: spannerGraph('my-graph')}],
    events: [],
    errors: [BAD_NAME],
    report: {code: 1, rejects: {'no profiles': [BAD_NAME]}},
    then: [{flags: {deployment: false}, code: 1, nothingWritten: true,
             errors: [BAD_NAME]}],
  },
  {
    name: 'is refused before the catalog write when Spanner refuses the plan of what a node table reads, gives a property two types, or gives a join column a type other than that of the column it references, after planning each node and edge table and the columns an edge references, and prints the warnings of the generated graph',
    ...GRAPH,
    actions: [{name: 'refund', executor: {mcp: {server: 's', tool: 't'}}}],
    warnings: [has('1 action(s) reach Knowledge Catalog only')],
    services: {
      executeQuery: when(
          (_s: string, sql: string, opts: any) =>
              isPlan(sql, opts, 'employees') && sql.includes('code'),
          {
            status: 400,
            message: 'Unrecognized name: dept; Did you mean dept_no?',
          }),
    },
    errors: [err(
        `${at('sp')}: Spanner cannot read the node table of entity ` +
        "'employee' from table employees: Unrecognized name: dept; Did you " +
        'mean dept_no? kcmd asked Spanner to plan: SELECT id, dept AS code ' +
        'FROM employees AS kcmd_table')],
    check: r => expect(r.fake.executeQuery.mock.calls
                           .filter(c => c[2]?.plan).map(c => c[1]))
                    .toEqual([
                      'SELECT id, dept AS code FROM employees AS kcmd_table',
                      'SELECT `order`, `by` AS code FROM `Order` AS kcmd_table',
                      'SELECT `order`, `by` FROM `Order` AS kcmd_table',
                      'SELECT dept FROM employees AS kcmd_table',
                    ]),
    then: [{
      code: 1, nothingWritten: true,
      services: {
        executeQuery: (_s: string, sql: string, opts: any) =>
            isPlan(sql, opts, 'employees') ? planned('INT64', 'STRING') :
            isPlan(sql, opts, '`Order`') ? planned('INT64', 'INT64') :
            undefined,
      },
      errors: [err(
          `${at('sp')}: property 'code' has type STRING in the node table of ` +
          "entity 'employee' and type INT64 in the node table of entity " +
          "'purchase', but a Spanner graph gives a property one type. Cast " +
          'the expressions to one type, or rename the fields.')],
    }, {
      // Join column `by` is an INT64, and dept, which it references, a STRING.
      code: 1, nothingWritten: true,
      services: {
        executeQuery: (_s: string, sql: string, opts: any) =>
            sql === 'SELECT dept FROM employees AS kcmd_table' ?
            planned('STRING') :
            isPlan(sql, opts, '`Order`') ? planned('INT64', 'INT64') :
                                          undefined,
      },
      errors: [err(
          `${at('sp')}: relationship 'placed_by' joins column \`by\` of ` +
          'table `Order`, of type INT64, to column dept of entity ' +
          "'employee', of type STRING; Spanner needs each join column to " +
          'have the type of the column it references. Join on columns of ' +
          'one type.')],
    }],
  },
  {
    name: 'is refused before the catalog write when its name is taken by another object of the database or a key has no unique index, and deploys once a unique index backs the key',
    ...GRAPH,
    services: {
      executeQuery: (_s: string, sql: string) =>
          isNames(sql) ? {status: 200, result: {rows: [['index', 'G']]}} :
          isKeys(sql) ? keyRows() : undefined,
    },
    errors: [
      err(`${at('sp')}: Spanner database test-project/i/db already has an ` +
          "index named 'G', and a graph cannot share its name with another " +
          'object of its database, compared ignoring case; rename the graph ' +
          'in the target.'),
      UNBACKED,
    ],
    called: {createSession: 1, deleteSession: 1},
    then: [{
      services: {
        executeQuery: (_s: string, sql: string) =>
            isKeys(sql) ? keyRows(true) : undefined,
      },
      code: 0,
      events: ['preflight', 'apply', 'deploy sp'],
    }, {
      services: {
        executeQuery: (_s: string, sql: string) => isNames(sql) ?
            {status: 403, message: 'Permission denied.'} : undefined,
      },
      code: 1, nothingWritten: true,
      errors: [err(
          `${at('sp')}: could not read the schema of Spanner database ` +
          'test-project/i/db to check the graph before anything is written: ' +
          'Permission denied.')],
    }, {
      services: {createSession: {status: 403, message: 'Permission denied.'}},
      code: 1, nothingWritten: true,
      errors: [err(
          `${at('sp')}: could not open a session on Spanner database ` +
          'test-project/i/db to check the graph before anything is written: ' +
          'Permission denied.')],
    }],
  },
], {code: 1, nothingWritten: true, events: ['preflight']});
