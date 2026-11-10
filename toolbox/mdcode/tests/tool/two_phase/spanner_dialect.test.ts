// Tests that push reads each Spanner source database's dialect, holds a field
// on a PostgreSQL-dialect table to POSTGRES or ANSI_SQL text, judges a
// deployment's profile in that dialect, refuses a graph deployment on such a
// database before any write, and holds the model file's own Spanner tables to
// one database (src/tool/commands.ts, src/libts/semantic/source_dialect.ts,
// src/libts/semantic/validate.ts).

import {expect} from 'bun:test';

import {CUSTOMER, err, scenarios, SPANNER, SPANNER_CUSTOMER, spannerGraph} from './harness';

const POSTGRESQL = {getDatabase: {status: 200, result: {databaseDialect: 'POSTGRESQL'}}};
const ON_SPANNER = {...CUSTOMER, source: SPANNER_CUSTOMER};
// Customer on a Spanner table, with its key's text in `dialect` only.
const keyIn = (dialect: string) => ({
  ...ON_SPANNER,
  fields: [{name: 'key', expression: {dialects: [{dialect, expression: 'c_key'}]}}],
});
const order = (database: string) => ({
  name: 'Order', source: `${database}/tables/Orders`, primary_key: ['id'],
  fields: [{name: 'id', expression: 'o_id'}],
});
const TWO_DATABASES =
    "model 'commerce' (commerce) binds entities in more than one database " +
    "('Customer', 'Order'); bind the model file's entities to tables in one " +
    'database.';
const REFUSAL =
    "[commerce] deployment 'd': database test-project/i/db has the " +
    'PostgreSQL dialect, and Spanner creates no property graph in a ' +
    'PostgreSQL-dialect database. Remove the deployment; push still ' +
    'publishes the model to Knowledge Catalog.';
const EXCLUDED =
    "[commerce.profile.pg.yaml] profile 'pg': metric 'secret_sum' reaches " +
    "'Customer.secret', which this profile excludes; add 'secret_sum' to " +
    "'metrics_exclude'";

scenarios('a Spanner database', [
  {
    name: 'with the PostgreSQL dialect needs POSTGRES or ANSI_SQL text, in the model file and in a profile, and push publishes a POSTGRES text, reading the database once',
    entities: [keyIn('SPANNER')],
    flags: {deployment: false},
    services: POSTGRESQL,
    code: 1, nothingWritten: true,
    errors: [err(
        "field 'Customer.key' in model 'commerce' (commerce) has no expression " +
        "for POSTGRES or ANSI_SQL, and the model file binds entity 'Customer' " +
        'to a POSTGRES source.')],
    then: [{
      entities: [CUSTOMER], profiles: {x: {entities: {Customer: keyIn('SPANNER')}}},
      code: 1,
      errors: [err(
          "[commerce.profile.x.yaml] profile 'x': field 'Customer.key' has no " +
          "expression for POSTGRES or ANSI_SQL, and this profile's sources " +
          'are POSTGRES')],
    }, {
      entities: [keyIn('POSTGRES')], code: 0, events: ['preflight', 'apply'],
      called: {getDatabase: 1},
      check: r => expect(r.published.entities[0]).toMatchObject({
        sourceDialect: 'POSTGRES',
        fields: [{dialects: [{dialect: 'POSTGRES', expression: 'c_key'}]}],
      }),
    }],
  },
  {
    name: 'with the PostgreSQL dialect refuses a Spanner deployment before the catalog preflight, in push, also under --no-deployment, and in kcmd profiles, and a push without it publishes',
    entities: [ON_SPANNER],
    deployments: [{name: 'd', target: spannerGraph('g')}],
    services: POSTGRESQL,
    code: 1, nothingWritten: true, events: [], errors: [err(REFUSAL)],
    report: {code: 1, rejects: {'no profiles': [REFUSAL]}},
    then: [
      {
        flags: {deployment: false}, code: 1, nothingWritten: true,
        errors: [err(REFUSAL)],
      },
      {deployments: [], code: 0, events: ['preflight', 'apply']},
    ],
  },
  {
    name: "with the PostgreSQL dialect judges a Spanner deployment's profile in that dialect, so a POSTGRES metric on a field the profile excludes gets only the profile's error",
    entities: [{
      ...ON_SPANNER,
      fields: [...ON_SPANNER.fields, {name: 'secret', expression: 'c_secret'}],
    }],
    metrics: [{
      name: 'secret_sum',
      expression:
          {dialects: [{dialect: 'POSTGRES', expression: 'SUM(Customer.secret)'}]},
    }],
    deployments: [{name: 'd', target: spannerGraph('g'), profile: 'pg'}],
    profiles: {pg: {entities: {Customer: {...ON_SPANNER, fields_exclude: ['secret']}}}},
    services: POSTGRESQL,
    code: 1, nothingWritten: true, errors: [err(EXCLUDED)],
    report: {code: 1, rejects: {pg: [EXCLUDED]}},
  },
  {
    name: "holds every table the model file binds in Spanner, on every push and in kcmd profiles",
    entities: [ON_SPANNER, order(`${SPANNER}2`)],
    flags: {deployment: false},
    code: 1, nothingWritten: true, errors: [err(TWO_DATABASES)],
    report: {code: 1, rejects: {'no profiles': [TWO_DATABASES]}},
    then: [{entities: [ON_SPANNER, order(SPANNER)], code: 0}],
  },
]);
