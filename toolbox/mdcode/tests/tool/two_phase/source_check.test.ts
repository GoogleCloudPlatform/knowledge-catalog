// Push checks that every source names a table Knowledge Catalog knows about,
// in the model file and in every profile, before it writes anything
// (b/568769073). The check itself is tested in
// tests/libts/semantic/source_entries.test.ts; these cases test where push
// runs it and what it skips.

import {expect} from 'bun:test';

import {entryDenied, NAM3_INSTANCE, NOT_FOUND, spannerDenied} from '../../libts/gcp/location_responses';
import {cloudSqlEntry} from '../../libts/mocks';

import {boundAt, bqTable, CUSTOMER, err, has, PushRun, REAL, scenarios, SPANNER_CUSTOMER} from './harness';

const CLOUDSQL = 'cloudsql.googleapis.com/projects/test-project/locations/' +
    'us-central1/instances/shop/databases/sales/tables/customer';
// Entity Order, bound to table order in dataset d.
const ORDER = {...CUSTOMER, name: 'Order', source: bqTable('order')};
// Answers the read of a table in dataset eu as BigQuery answers for the EU
// multi-region; other tables get the harness's `US`.
const IN_EU = (_p: string, dataset: string) =>
    dataset === 'eu' ? {status: 200, result: {location: 'EU'}} : undefined;
const SKIPPING = 'Skipping the source check (--skip-source-check).';

// The harness's log entry for the lookup of `resourceName`'s entry.
const lookup = (group: string, location: string, resourceName: string) =>
    `lookupEntry projects/test-project/locations/${location}/entryGroups/@${
        group}/entries/${resourceName}`;
const lookups = (r: PushRun) =>
    r.fake.calls.filter(c => c.startsWith('lookupEntry')).sort();
// Answers the lookup of `resourceName`'s entry as Dataplex answers a missing
// one; other lookups get the harness's answer.
const missing = (resourceName: string) =>
    (_p: string, _l: string, name: string) =>
        name.endsWith(`/entries/${resourceName}`) ? entryDenied(name) :
                                                    undefined;
const notFound = (entity: string, profile: string, source: string) =>
    has(`entity '${entity}' in profile '${profile}': source '${
        source}' names no table Knowledge Catalog knows about.`);

scenarios('push checks every source before it writes', [
  {
    name: 'a missing table in a profile no deployment uses stops the push before anything is written, as does a catalog-only push; --skip-source-check looks nothing up and says so',
    deployments: ['g'],
    profiles: {x: boundAt(SPANNER_CUSTOMER)},
    services: {lookupEntry: missing(SPANNER_CUSTOMER)},
    code: 1,
    errors: [notFound('Customer', 'x', SPANNER_CUSTOMER)],
    called: {preflight: 0},
    nothingWritten: true,
    // The model file's table is looked up in its dataset's location, and the
    // Spanner table in its instance's default leader region.
    check: r => expect(lookups(r)).toEqual([
      lookup('bigquery', 'us', bqTable('customer')),
      lookup('spanner', 'us-central1', SPANNER_CUSTOMER),
    ].sort()),
    then: [
      {
        flags: {deployment: false},
        code: 1,
        errors: [notFound('Customer', 'x', SPANNER_CUSTOMER)],
        nothingWritten: true,
      },
      {
        flags: {skipSourceCheck: true},
        code: 0,
        events: ['preflight', 'apply', 'deploy g'],
        check: r => {
          expect(r.log).toContain(SKIPPING);
          expect(lookups(r)).toEqual([]);
        },
      },
    ],
  },
  {
    name: 'a missing table offers --skip-source-check even when a deployment reads it; with the flag, the deployment\'s own table check stops the push, and creating the table clears both',
    deployments: ['g'],
    services: {getTable: NOT_FOUND},
    code: 1,
    errors: [err(`entity 'Customer' in profile 'default': source '${bqTable('customer')}' ` +
                 "names a table that does not exist: reading table 'test-project.d.customer' " +
                 'found nothing (HTTP 404). Create the table or fix the source. ' +
                 '--skip-source-check skips this lookup, but a deployment that reads the ' +
                 'table still checks the table itself.')],
    nothingWritten: true,
    then: [
      // The deployment's dry run of the table answers 404, as BigQuery does.
      {flags: {skipSourceCheck: true},
       services: {sources: REAL.sources, query: {status: 404, message: 'Not found: Table test-project:d.customer'}},
       code: 1, errors: [has("references BigQuery table 'test-project.d.customer', which does not exist")],
       nothingWritten: true},
      {services: {getTable: undefined}, code: 0, events: ['preflight', 'apply', 'deploy g']},
    ],
  },
  {
    name: 'a missing table in the model file\'s own bindings stops a catalog-only push and a --validate-only push before the preflight, as profile \'default\'',
    flags: {deployment: false},
    services: {lookupEntry: missing(bqTable('customer'))},
    code: 1,
    errors: [notFound('Customer', 'default', bqTable('customer'))],
    called: {preflight: 0},
    nothingWritten: true,
    then: [{
      flags: {validateOnly: true},
      code: 1,
      errors: [notFound('Customer', 'default', bqTable('customer'))],
      called: {preflight: 0},
    }],
  },
  {
    name: 'a BigQuery table is found in its location, not the push\'s, and push stops when its table does not exist',
    entities: [{...CUSTOMER, source: bqTable('customer', 'eu')}],
    flags: {deployment: false},
    services: {getTable: IN_EU},
    code: 0,
    calls: [lookup('bigquery', 'eu', bqTable('customer', 'eu'))],
    then: [{
      // Every table read answers 404, as BigQuery answers a missing table.
      services: {getTable: NOT_FOUND},
      code: 1,
      errors: [has(`source '${bqTable('customer', 'eu')}' names a table that ` +
                   'does not exist')],
      nothingWritten: true,
      check: r => expect(lookups(r)).toEqual([]),
    }],
  },
  {
    name: 'a profile whose BigQuery tables share no location stops the push before anything is written; --skip-source-check lets it through',
    entities: [CUSTOMER, ORDER],
    profiles: {x: {entities: {Customer: CUSTOMER, Order: {...ORDER, source: bqTable('order', 'eu')}}}},
    flags: {deployment: false},
    services: {getTable: IN_EU},
    code: 1,
    errors: [has(`profile 'x' of model 'commerce' binds tables that share no ` +
                 `BigQuery location: US ('Customer'), EU ('Order').`)],
    nothingWritten: true,
    then: [{flags: {deployment: false, skipSourceCheck: true}, code: 0,
            events: ['preflight', 'apply']}],
  },
  {
    name: 'a Spanner table whose instance config cannot be read is found in one of its instance\'s replica regions',
    profiles: {x: boundAt(SPANNER_CUSTOMER)},
    flags: {deployment: false},
    services: {
      getInstance: {status: 200, result: NAM3_INSTANCE},
      getInstanceConfig: spannerDenied('spanner.instanceConfigs.get', NAM3_INSTANCE.config),
      // As live, the entry sits only in the config's default leader region.
      lookupEntry: (_p: string, location: string, name: string) =>
          name.includes('/@spanner/') && location !== 'us-east4' ?
          entryDenied(name) : undefined,
    },
    code: 0,
    check: r => expect(lookups(r)).toEqual([
      lookup('bigquery', 'us', bqTable('customer')),
      lookup('spanner', 'us-east1', SPANNER_CUSTOMER),
      lookup('spanner', 'us-east4', SPANNER_CUSTOMER),
    ].sort()),
  },
  {
    name: 'a Cloud SQL table is looked up once, for its dialect, and a missing one fails the push with or without --skip-source-check',
    deployments: ['g'],
    profiles: {x: boundAt(CLOUDSQL)},
    services: {
      lookupEntry: (_p: string, _l: string, name: string) =>
          name.includes('/@cloudsql/') ? cloudSqlEntry('cloudsql-mysql-table') : undefined,
    },
    code: 0,
    check: r => expect(lookups(r)).toEqual([
      lookup('bigquery', 'us', bqTable('customer')),
      lookup('cloudsql', 'us-central1', CLOUDSQL),
    ].sort()),
    then: [
      {services: {lookupEntry: missing(CLOUDSQL)}, code: 1,
       errors: [has('kcmd reads a Cloud SQL table\'s dialect')],
       nothingWritten: true},
      {flags: {skipSourceCheck: true}, services: {lookupEntry: missing(CLOUDSQL)},
       code: 1, errors: [has('kcmd reads a Cloud SQL table\'s dialect')],
       nothingWritten: true},
    ],
  },
]);
