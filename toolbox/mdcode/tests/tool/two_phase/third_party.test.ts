// Tests that push takes a third-party table's dialect from its Knowledge
// Catalog entry, refuses every deployment that binds one, and publishes it to
// Knowledge Catalog (src/tool/commands.ts, src/libts/semantic/source_dialect.ts).

import {expect} from 'bun:test';

import {entryDenied} from '../../libts/gcp/location_responses';

import {ALLOYDB, CUSTOMER, err, scenarios, spannerGraph} from './harness';

const ENTRY =
    'projects/test-project/locations/us/entryGroups/sf/entries/customer';
// Entity Customer bound to ENTRY, whose entry is a Snowflake table's.
const THIRD_PARTY = {...CUSTOMER, source: ENTRY};
const SNOWFLAKE = {
  lookupEntry: (_p: string, _l: string, name: string) => name === ENTRY ?
      {status: 200, result: {fullyQualifiedName: 'snowflake:acme.db.public.c'}} :
      undefined,
};
const MISSING = err(
    `source '${ENTRY}' names no table Knowledge Catalog knows about. The ` +
    'entry may not exist, or you may not be allowed to read it. kcmd reads a ' +
    "third-party table's dialect from its entry, so add the table to " +
    'Knowledge Catalog, or fix the source.');
// Push's refusal of deployment d, which targets `target`.
const refused = (target: string, outside = 'a table in that database') =>
    `[commerce] deployment 'd' targets ${target}, but the model file binds ` +
    `entity 'Customer' to '${ENTRY}', which is not ${outside}.`;
const BIGQUERY = refused('a BigQuery graph', 'a BigQuery or BigLake table');
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
    services: SNOWFLAKE,
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
    name: 'a field bound to one needs SQL in its dialect or in ANSI_SQL, in the model file and in a profile',
    entities: [DATABRICKS],
    flags: {deployment: false},
    services: SNOWFLAKE,
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
    }],
  },
]);
