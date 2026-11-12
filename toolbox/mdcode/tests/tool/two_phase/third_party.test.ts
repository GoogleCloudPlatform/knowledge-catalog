// Tests that push takes a third-party table's dialect from its Knowledge
// Catalog entry, refuses every deployment that binds one, and publishes it to
// Knowledge Catalog (src/tool/commands.ts, src/libts/semantic/source_dialect.ts).

import {expect} from 'bun:test';

import {entryDenied} from '../../libts/gcp/location_responses';

import {ALLOYDB, bqTable, CUSTOMER, err, has, scenarios, spannerGraph} from './harness';

const entry = (group: string, id: string) =>
    `projects/test-project/locations/us/entryGroups/${group}/entries/${id}`;
const ENTRY = entry('sf', 'customer');
const OTHER_ACCOUNT = entry('sf2', 'order');
// Entity Customer bound to ENTRY, whose entry is a Snowflake table's.
const THIRD_PARTY = {...CUSTOMER, source: ENTRY};
// ENTRY and OTHER_ACCOUNT are tables in two Snowflake accounts.
const LOOKUP = {
  lookupEntry: (_p: string, _l: string, name: string) => ({
    [ENTRY]: {status: 200, result: {fullyQualifiedName: 'snowflake:acme.db.public.c'}},
    [OTHER_ACCOUNT]: {status: 200, result: {fullyQualifiedName: 'snowflake:other.db.public.o'}},
  })[name],
};
const MISSING = err(
    `source '${ENTRY}' names no table Knowledge Catalog knows about. The ` +
    'entry may not exist, or you may not be allowed to read it. kcmd reads a ' +
    "third-party table's dialect from its entry, so add the table to " +
    'Knowledge Catalog, or fix the source.');
const BQ = 'a BigQuery graph';
const SPANNER = "Spanner database 'test-project/i/db'";
const ALLOYDB_DB = "AlloyDB database 'test-project/us-central1/c/db'";
// Why `target` cannot read Customer's table.
const outside = (target: string) => `'${ENTRY}', which is not ${
    target === BQ ? 'a BigQuery or BigLake table' : 'a table in that database'}.`;
// Push's refusal of deployment 'd', which targets `target`.
const refused = (target: string) => `[commerce] deployment 'd' targets ${
    target}, but the model file binds entity 'Customer' to ${outside(target)}`;
const BIGQUERY = refused(BQ);
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
       errors: [err(refused(SPANNER))], nothingWritten: true},
      {deployments: [{name: 'd', target: ALLOYDB}], code: 1,
       errors: [err(refused(ALLOYDB_DB))],
       nothingWritten: true},
      {
        deployments: [], code: 0,
        events: ['preflight', 'apply'], calls: [`lookupEntry ${ENTRY}`],
        check: r => expect(r.published.entities[0]).toMatchObject(
            {authoredSource: ENTRY, sourceDialect: 'SNOWFLAKE'}),
      },
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
    name: "a field bound to one needs SQL in its dialect or ANSI_SQL, and the third-party tables of a profile or of the model file must be in one account",
    entities: [DATABRICKS],
    flags: {deployment: false},
    services: LOOKUP,
    code: 1,
    errors: [err(
        "field 'Customer.key' in model 'commerce' (commerce) has no expression " +
        "for SNOWFLAKE or ANSI_SQL, and the model file binds entity 'Customer' " +
        'to a SNOWFLAKE source; give it one.')],
    then: [{
      entities: [CUSTOMER], profiles: {x: {entities: {Customer: DATABRICKS}}},
      code: 1,
      errors: [err(
          "[commerce.profile.x.yaml] profile 'x': field 'Customer.key' has no " +
          "expression for SNOWFLAKE or ANSI_SQL, and this profile's sources " +
          'are SNOWFLAKE; give it one')],
    }, {
      // Tables in two Snowflake accounts are in two databases.
      entities: [CUSTOMER, ORDER],
      profiles: {x: {entities: {Customer: THIRD_PARTY, Order: {...ORDER, source: OTHER_ACCOUNT}}}},
      code: 1,
      errors: [err(
          "[commerce.profile.x.yaml] profile 'x' binds entities in more than " +
          "one database ('Customer', 'Order'); a profile reads from one " +
          'system a single query can reach')],
    }, {
      entities: [THIRD_PARTY, {...ORDER, source: OTHER_ACCOUNT}],
      code: 1,
      errors: [has("binds entities in more than one database ('Customer', 'Order')")],
    }],
  },
]);
