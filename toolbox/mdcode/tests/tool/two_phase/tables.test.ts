// Tests that push refuses a deployment whose tables are outside the database
// it deploys to, and that it probes each BigQuery table in the location of
// the graph's dataset (src/tool/commands.ts, checkBeforeWrites and
// liveErrors).

import {expect} from 'bun:test';

import {PushOptions} from '../../../src/tool/commands';

import {ALLOYDB, boundAt, bqTable, Case, CUSTOMER, err, has, pushed, REAL, Scope, scenarios, Services, SPANNER, SPANNER_CUSTOMER, spannerGraph} from './harness';

const OTHER_ALLOYDB = 'alloydb.googleapis.com/projects/test-project/' +
    'locations/us-central1/clusters/c/databases/other/schemas/public/tables/' +
    'customer';
const UNSELECTED = "[commerce] deployment 'sp' targets Spanner database " +
    "'test-project/i/db', but profile 'x' binds entity 'Customer' to " +
    `'${SPANNER}2/tables/Customer', which is not a table in that database.`;

const fails = (name: string, scope: Scope, error: string,
               flags: PushOptions = {}): Case => ({
  name, ...scope, flags, code: 1,
  errors: [err(error)], called: {preflight: 0}, nothingWritten: true,
});

// The graph's dataset d is in us-central1. BigQuery finds a table in dataset
// eu only in europe-west1, and a probe that names no location runs where its
// table is.
const TWO_LOCATIONS: Services = {
  getDataset: {status: 200, result: {location: 'us-central1'}},
  sources: REAL.sources,
  query: (_project: string, sql: string, location?: string) => {
    const where = sql.includes('.eu.') ? 'europe-west1' : 'us-central1';
    return location && location !== where ?
        {status: 404, message: `Not found in location ${location}`} :
        {status: 200, result: {jobReference: {location: where}}};
  },
};

scenarios('each deployment\'s tables are in the database it deploys to', [
  fails(
      'an AlloyDB deployment fails for a table in another database of its cluster, and nothing is written', {
        deployments: [{name: 'd1', target: ALLOYDB, profile: 'x'}],
        profiles: {x: boundAt(OTHER_ALLOYDB)},
      },
      "[commerce] deployment 'd1' targets AlloyDB database " +
          "'test-project/us-central1/c/db', but profile 'x' binds entity " +
          `'Customer' to '${OTHER_ALLOYDB}', which is not a table in that ` +
          'database.'),
  fails(
      'a deployment that uses the model file\'s bindings names only the entity outside its database',
      {entities: [CUSTOMER, {
        ...CUSTOMER, name: 'Orders', source: `${SPANNER}/tables/Orders`,
      }]},
      "[commerce] deployment 'g' targets a BigQuery graph, but the model " +
          `file binds entity 'Orders' to '${SPANNER}/tables/Orders', which ` +
          'is not a BigQuery or BigLake table.'),
  {
    ...fails(
        'a deployment the push does not select fails the push the same way, ' +
            'also under --no-deployment', {
          deployments:
              ['g', {name: 'sp', target: spannerGraph('g'), profile: 'x'}],
          profiles: {x: boundAt(`${SPANNER}2/tables/Customer`)},
        },
        UNSELECTED, {deployment: ['g']}),
    then: [{flags: {deployment: false}, code: 1, errors: [err(UNSELECTED)],
            nothingWritten: true}],
    report: {code: 1, rejects: {x: [pushed()]}},
  },
  {
    name: 'a profile source in no accepted form gets the profile check\'s error first',
    deployments: [{name: 'sp', target: spannerGraph('g'), profile: 'x'}],
    profiles: {x: boundAt(`${SPANNER}/table/Customer`)},
    code: 1, errors: [has('is not a valid table reference')],
  },
  {
    name: 'a model with an abstract entity, which has no source, passes and deploys to Spanner',
    deployments: [{name: 'sp', target: spannerGraph('g')}],
    entities: [
      {name: 'Party', abstract: true, fields: [{name: 'key'}]},
      {...CUSTOMER, extends: ['Party'], source: SPANNER_CUSTOMER},
    ],
    code: 0,
    events: ['preflight', 'apply', 'deploy sp'],
  },
  {
    name: 'a BigQuery table outside the graph dataset\'s location fails, naming its location, and passes with a probe that names no location when the dataset\'s location cannot be read; a table in the dataset\'s location passes',
    entities: [{...CUSTOMER, source: bqTable('customer', 'eu')}],
    services: TWO_LOCATIONS,
    code: 1,
    errors: [err(
        "[commerce] deployment 'g' targets a BigQuery graph in dataset " +
        "'test-project.d', which is in location 'us-central1', but entity " +
        "'Customer' reads table 'test-project.eu.customer', which is in " +
        "location 'europe-west1'. A property graph can use only tables in " +
        "its dataset's location.")],
    nothingWritten: true,
    check: r => expect(r.fake.query.mock.calls.map(c => c[2] ?? null))
                    .toEqual(['us-central1', null]),
    then: [{
      services: {getDataset: {status: 403, message: 'Access Denied'}},
      code: 0,
      check: r => expect(r.fake.query.mock.calls.map(c => c[2] ?? null))
                      .toEqual([null, null]),
    }, {
      entities: [CUSTOMER],
      code: 0,
      events: ['preflight', 'apply', 'deploy g'],
      check: r => expect(r.fake.query.mock.calls
                             .filter(c => String(c[1]).startsWith('SELECT 1'))
                             .map(c => c.slice(1, 4)))
                      .toEqual([[
                        'SELECT 1 FROM `test-project.d.customer` WHERE FALSE',
                        'us-central1', true,
                      ]]),
    }],
  },
], {deployments: ['g']});
