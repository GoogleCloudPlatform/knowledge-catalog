// Push checks that every source names a table Knowledge Catalog knows about,
// in the model file and in every profile, before it writes anything
// (b/568769073). The check itself is tested in
// tests/libts/semantic/source_entries.test.ts; these cases test where push
// runs it and what it skips.

import {expect} from 'bun:test';

import {entryDenied} from '../../libts/gcp/location_responses';

import {boundAt, bqTable, CUSTOMER, has, PushRun, scenarios, SPANNER_CUSTOMER} from './harness';

const CLOUDSQL = 'cloudsql.googleapis.com/projects/test-project/locations/' +
    'us-central1/instances/shop/databases/sales/tables/customer';
// The entry Dataplex keeps for a Cloud SQL for MySQL table.
const MYSQL_ENTRY = {
  status: 200,
  result: {
    entryType:
        'projects/dataplex-types/locations/global/entryTypes/cloudsql-mysql-table',
  },
};
const SKIPPING = 'Skipping the source existence check (--skip-source-check).';

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
    name: 'a BigQuery table is found in its dataset\'s location, not the push\'s',
    entities: [{...CUSTOMER, source: bqTable('customer', 'eu')}],
    flags: {deployment: false},
    services: {
      getDataset: (_p: string, dataset: string) =>
          dataset === 'eu' ? {status: 200, result: {location: 'EU'}} : undefined,
    },
    code: 0,
    calls: [lookup('bigquery', 'eu', bqTable('customer', 'eu'))],
  },
  {
    name: 'a Cloud SQL table is looked up once, for its dialect, and a missing one fails the push with or without --skip-source-check',
    deployments: ['g'],
    profiles: {x: boundAt(CLOUDSQL)},
    services: {
      lookupEntry: (_p: string, _l: string, name: string) =>
          name.includes('/@cloudsql/') ? MYSQL_ENTRY : undefined,
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
