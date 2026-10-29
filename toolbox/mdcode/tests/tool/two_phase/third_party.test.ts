// Tests that push takes a third-party table's dialect from its Knowledge
// Catalog entry, refuses every deployment that binds one, and publishes it to
// Knowledge Catalog (src/tool/commands.ts, src/libts/semantic/source_dialect.ts).

import {expect} from 'bun:test';

import {entryDenied} from '../../libts/gcp/location_responses';

import {ALLOYDB, bqGraph, bqTable, CUSTOMER, err, modelFile, scenarios, spannerGraph} from './harness';

const entry = (group: string, id: string) =>
    `projects/test-project/locations/us/entryGroups/${group}/entries/${id}`;
const ENTRY = entry('sf', 'customer');
const DBX = entry('dbx', 'order');
// Entity Customer bound to ENTRY, whose entry is a Snowflake table's.
const THIRD_PARTY = {...CUSTOMER, source: ENTRY};
// ENTRY is a Snowflake table's entry, and DBX a Databricks table's.
const LOOKUP = {
  lookupEntry: (_p: string, _l: string, name: string) => ({
    [ENTRY]: {status: 200, result: {fullyQualifiedName: 'snowflake:acme.db.public.c'}},
    [DBX]: {status: 200, result: {fullyQualifiedName: 'databricks:1.main.r.o'}},
  })[name],
};
const MISSING = err(
    `source '${ENTRY}' names no table Knowledge Catalog knows about. The ` +
    'entry may not exist, or you may not be allowed to read it. kcmd reads a ' +
    "third-party table's dialect from its entry, so add the table to " +
    'Knowledge Catalog, or fix the source.');
// Push's refusal of deployment `d`, which targets `target`, for the binding
// in `bindings`.
const refused = (target: string, outside = 'a table in that database',
                 {d = 'd', bindings = 'the model file'} = {}) =>
    `[commerce] deployment '${d}' targets ${target}, but ${bindings} binds ` +
    `entity 'Customer' to '${ENTRY}', which is not ${outside}.`;
const BQ_TABLE = 'a BigQuery or BigLake table';
const BIGQUERY = refused('a BigQuery graph', BQ_TABLE);
const SINGLE_PHASE = refused('a BigQuery graph', BQ_TABLE, {d: 'default'});
const ORDER = {
  name: 'Order', source: bqTable('order'), primary_key: ['id'],
  fields: [{name: 'id', expression: 'o_id'}],
};
// Entity Customer, or its binding in a profile, with only a Databricks text.
const DATABRICKS = {
  ...THIRD_PARTY,
  fields: [{name: 'key', expression: {dialects: [{dialect: 'DATABRICKS', expression: 'c_key'}]}}],
};

scenarios('a third-party table', [
  {
    name: 'a BigQuery, Spanner or AlloyDB deployment that binds one is refused before anything is written, and a push with no deployment publishes it, looked up once for its dialect',
    entities: [THIRD_PARTY],
    deployments: [{name: 'd'}],
    services: LOOKUP,
    code: 1, errors: [err(BIGQUERY)], nothingWritten: true,
    report: {code: 1, rejects: {'no profiles': [BIGQUERY]}},
    then: [
      {deployments: [{name: 'd', target: spannerGraph('g')}], code: 1,
       errors: [err(refused("Spanner database 'test-project/i/db'"))],
       nothingWritten: true},
      {deployments: [{name: 'd', target: ALLOYDB}], code: 1,
       errors: [err(refused("AlloyDB database 'test-project/us-central1/c/db'"))],
       nothingWritten: true},
      {
        deployments: [], flags: {deployment: false}, code: 0,
        events: ['preflight', 'apply'], calls: [`lookupEntry ${ENTRY}`],
        check: r => expect(r.published.entities[0]).toMatchObject(
            {authoredSource: ENTRY, sourceDialect: 'SNOWFLAKE'}),
      },
      {deployments: [], code: 0, events: ['deployKc']},
    ],
  },
  {
    // A model with no deployments list pushes in one phase, with the graph
    // target of its GOOGLE block or of a legacy profile folder.
    name: 'a graph that a model with no deployments list names refuses one before anything is written',
    files: {'commerce.yaml': modelFile({google: {deploymentTargets: [bqGraph('g')]}})
                                 .replace(bqTable('customer'), ENTRY)},
    services: LOOKUP,
    code: 1, nothingWritten: true, errors: [err(SINGLE_PHASE)],
    report: {code: 1, rejects: {'no profiles': [SINGLE_PHASE]}},
    then: [{
      files: {}, flags: {profile: 'sf'},
      legacy: {sf: `semantic_model:\n  - name: commerce\n    deployment_target: ${
          spannerGraph('g')}\n    entities: [{name: Customer, source: ${ENTRY}}]\n`},
      code: 1, nothingWritten: true,
      errors: [err(refused("Spanner database 'test-project/i/db'", undefined,
                           {d: 'sf', bindings: "profile 'sf'"}))],
    }],
  },
  {
    name: 'a missing entry stops the push before anything is written, with or without --skip-source-check, and stops kcmd profiles',
    entities: [THIRD_PARTY],
    flags: {deployment: false},
    services: {lookupEntry: (...a: string[]) => entryDenied(a[2])},
    code: 1, errors: [MISSING], nothingWritten: true,
    report: {code: 1, check: (_, errors) => expect(errors).toEqual([MISSING])},
    then: [{flags: {deployment: false, skipSourceCheck: true}, code: 1,
            errors: [MISSING], nothingWritten: true}],
  },
  {
    name: 'a field bound to one needs SQL in its dialect or in ANSI_SQL, in the model file and in a profile, whose tables must be of one system',
    entities: [DATABRICKS],
    flags: {deployment: false},
    services: LOOKUP,
    code: 1,
    errors: [err(
        "field 'Customer.key' in model 'commerce' (commerce) has no expression " +
        "for SNOWFLAKE or ANSI_SQL, and the model file binds entity 'Customer' " +
        'to a SNOWFLAKE source.')],
    then: [{
      entities: [CUSTOMER], profiles: {x: {entities: {Customer: DATABRICKS}}},
      code: 1,
      errors: [err(
          "[commerce.profile.x.yaml] profile 'x': field 'Customer.key' has no " +
          "expression for SNOWFLAKE or ANSI_SQL, and this profile's sources " +
          'are SNOWFLAKE')],
    }, {
      // A Snowflake and a Databricks table are two databases.
      entities: [CUSTOMER, ORDER],
      profiles: {x: {entities: {Customer: THIRD_PARTY, Order: {...ORDER, source: DBX}}}},
      code: 1,
      errors: [err(
          "[commerce.profile.x.yaml] profile 'x' binds entities in more than " +
          "one database ('Customer', 'Order'); a profile reads from one " +
          'system a single query can reach')],
    }],
  },
]);
