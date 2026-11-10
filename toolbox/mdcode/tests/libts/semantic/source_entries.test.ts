// Tests for src/libts/semantic/source_entries.ts: every table a push reads has
// a Knowledge Catalog entry. The services are faked with the responses they
// gave live (see ../gcp/location_responses.ts); nothing here calls a service.

import {describe, expect, test} from 'bun:test';

import {ApiResult} from '../../../src/libts/gcp/api';
import {BigLakeClient} from '../../../src/libts/gcp/biglake';
import {BigQueryClient} from '../../../src/libts/gcp/bigquery';
import {CatalogClient} from '../../../src/libts/gcp/dataplex';
import {SpannerClient} from '../../../src/libts/gcp/spanner';
import {Entity, ProfileSpec} from '../../../src/libts/semantic/ir';
import {sourceEntryErrors, SourceReaders} from '../../../src/libts/semantic/source_entries';
import {entryDenied, entryInvalid, FEDERATED_CATALOG, HIVE_CATALOG, INVALID_TABLE_ID, invalidHiveId, MULTI_REGION_GCS_CATALOG, NAM22_CONFIG, NAM3_CONFIG, NAM3_INSTANCE, NOT_FOUND, NOT_ICEBERG, P, REGIONAL_CATALOG, REGIONAL_CONFIG, REGIONAL_INSTANCE, spannerDenied, US_TABLE} from '../gcp/location_responses';

const BIGQUERY = `bigquery.googleapis.com/projects/${P}/datasets/kcmd_demo/tables/orders`;
const BIGLAKE = `biglake.googleapis.com/projects/${P}/catalogs/kcmd-src-biglake-57138/namespaces/sales/tables/orders`;
const BIGLAKE_US = 'biglake.googleapis.com/projects/looker-private-demo/catalogs/snowflake/namespaces/sales/tables/orders';
const BIGLAKE_GCS_US = `biglake.googleapis.com/projects/${P}/catalogs/kcmd-biglake-probe-6890/namespaces/sales/tables/orders`;
const BIGLAKE_FAILOVER = `biglake.googleapis.com/projects/${P}/catalogs/kcmd-biglake-failover/namespaces/sales/tables/orders`;
const HIVE_ID = 'sqlgen_jharshit_atscale_hive_us';
const BIGLAKE_HIVE = `biglake.googleapis.com/projects/sqlgen-testing/catalogs/${HIVE_ID}/databases/hive_db_us_d4/tables/jharshit_autogen_hive_us_t8`;
// Each kind of catalog's table, written as the other kind's.
const BIGLAKE_US_AS_HIVE = BIGLAKE_US.replace('namespaces', 'databases');
const BIGLAKE_AS_HIVE = BIGLAKE.replace('namespaces', 'databases');
const HIVE_AS_ICEBERG = BIGLAKE_HIVE.replace('databases', 'namespaces');
const GET_HIVE = `getHiveCatalog sqlgen-testing ${HIVE_ID}`;
const GET_HIVE_AS_ICEBERG = `getCatalog sqlgen-testing ${HIVE_ID}`;
const SPANNER = `spanner.googleapis.com/projects/${P}/instances/kcmd-src-reg/databases/sales/tables/Orders`;
const SPANNER_NAM3 = `spanner.googleapis.com/projects/${P}/instances/kcmd-src-multi/databases/sales/tables/Orders`;
const SPANNER_NAM22 = `spanner.googleapis.com/projects/${P}/instances/kcmd-src-nam22/databases/sales/tables/Orders`;
// The nam22 config is live; the instance is made up, and lists no replica
// regions, as the instance read on 2026-10-27 was captured (whether Spanner
// ever leaves them out is not known).
const NAM22_INSTANCE = {
  name: `projects/${P}/instances/kcmd-src-nam22`,
  config: NAM22_CONFIG.name,
};
// A US catalog during a failover, made up, never seen live: for a few seconds
// the new primary reads STATE_PRIMARY_IN_PROGRESS, so no replica is
// STATE_PRIMARY (from review on #623, 2026-11-03). The secondary comes first,
// so the order the check looks in is its own.
const FAILOVER_CATALOG = {
  ...MULTI_REGION_GCS_CATALOG,
  name: `projects/${P}/catalogs/kcmd-biglake-failover`,
  replicas: [
    {region: 'us-central1', state: 'STATE_SECONDARY'},
    {region: 'us-east1', state: 'STATE_PRIMARY_IN_PROGRESS'},
  ],
};
// Tables in a regional dataset. BigQuery writes a region in lower case and a
// multi-region in upper case (the live US_TABLE writes `US`).
const BQ_CENTRAL = `bigquery.googleapis.com/projects/${P}/datasets/us_ds/tables/orders`;
const BQ_EU = `bigquery.googleapis.com/projects/${P}/datasets/eu_ds/tables/customers`;
const BQ_EAST = `bigquery.googleapis.com/projects/${P}/datasets/east_ds/tables/customers`;
const tableIn = (dataset: string, table: string, location: string) => ({
  ...US_TABLE, id: `${P}:${dataset}.${table}`,
  tableReference: {projectId: P, datasetId: dataset, tableId: table}, location,
});
const ALLOYDB = `alloydb.googleapis.com/projects/${P}/locations/us-east4/clusters/kcmd-src-alloy/databases/sales/schemas/public/tables/orders`;

// The lookup of `resourceName`'s entry in `@<group>` at `location`, as the
// fake records it: the call's project and location, and the entry name.
function lookup(group: string, location: string, resourceName: string): string {
  const project = resourceName.split('/')[2];
  return `lookupEntry ${project} ${location} projects/${project}/locations/${
      location}/entryGroups/@${group}/entries/${resourceName}`;
}

const ok = (result: object) => ({status: 200, result});

// Readers that answer from the live responses, keyed by what each call
// names, and record each call. A table, instance, config or catalog they do
// not know answers 404; an entry not in `entries` answers 403, as a missing
// entry or one in another location does. `override` replaces one answer.
function fakeReaders(entries: string[], override: Record<string, ApiResult<any>|Error> = {}) {
  const calls: string[] = [];
  const answers: Record<string, ApiResult<any>> = {
    [`getTable ${P} kcmd_demo orders`]: ok(US_TABLE),
    [`getTable ${P} us_ds orders`]: ok(tableIn('us_ds', 'orders', 'us-central1')),
    [`getTable ${P} eu_ds customers`]: ok(tableIn('eu_ds', 'customers', 'europe-west1')),
    [`getTable ${P} east_ds customers`]: ok(tableIn('east_ds', 'customers', 'us-east1')),
    [`getInstance ${P} kcmd-src-reg`]: ok(REGIONAL_INSTANCE),
    [`getInstance ${P} kcmd-src-multi`]: ok(NAM3_INSTANCE),
    [`getInstanceConfig ${NAM3_INSTANCE.config}`]: ok(NAM3_CONFIG),
    [`getInstance ${P} kcmd-src-nam22`]: ok(NAM22_INSTANCE),
    [`getInstanceConfig ${NAM22_CONFIG.name}`]: ok(NAM22_CONFIG),
    [`getCatalog ${P} kcmd-src-biglake-57138`]: ok(REGIONAL_CATALOG),
    'getCatalog looker-private-demo snowflake': ok(FEDERATED_CATALOG),
    // Live, the primary came first; nothing promises that order, so here the
    // secondary does.
    [`getCatalog ${P} kcmd-biglake-probe-6890`]: ok({
      ...MULTI_REGION_GCS_CATALOG,
      replicas: [...MULTI_REGION_GCS_CATALOG.replicas].reverse(),
    }),
    [`getCatalog ${P} kcmd-biglake-failover`]: ok(FAILOVER_CATALOG),
    [GET_HIVE]: ok(HIVE_CATALOG),
  };
  const answer = async (call: string, missing: ApiResult<any>) => {
    calls.push(call);
    const over = override[call];
    if (over instanceof Error) throw over;
    return over ?? answers[call] ?? (entries.includes(call) ? ok({}) : missing);
  };
  const readers: SourceReaders = {
    catalog: {
      lookupEntry: (project, location, name) =>
          answer(`lookupEntry ${project} ${location} ${name}`, entryDenied(name)),
    },
    bigquery: {getTable: (p, d, t) => answer(`getTable ${p} ${d} ${t}`, NOT_FOUND)},
    biglake: {
      getCatalog: (p, c) => answer(`getCatalog ${p} ${c}`, NOT_FOUND),
      getHiveCatalog: (p, c) => answer(`getHiveCatalog ${p} ${c}`, NOT_FOUND),
    },
    spanner: {
      getInstance: (p, i) => answer(`getInstance ${p} ${i}`, NOT_FOUND),
      getInstanceConfig: c => answer(`getInstanceConfig ${c}`, NOT_FOUND),
    },
  };
  return {readers, calls};
}

const entity = (name: string, source: string, extra: Partial<Entity> = {}) =>
    ({name, dataSource: '', authoredSource: source, keys: [], fields: [], ...extra}) as Entity;
const profile = (name: string, entities: Array<[string, string?]>): ProfileSpec =>
    ({name, entities: entities.map(([e, source]) => ({name: e, source})), relationships: []});
// Model commerce with `entities` and `profiles`.
const model = (entities: Entity[], profiles: ProfileSpec[] = []) =>
    ({name: 'commerce', entities, profiles});
const inline = (source: string) => model([entity('orders', source)]);

// What each message about `source` says --skip-source-check skips. No
// deployment checks an AlloyDB table.
const skips = (source: string) => ' --skip-source-check skips this lookup' +
    (source.startsWith('alloydb.') ? '.' :
         ', but a deployment that reads the table still checks the table itself.');
// The message for a source with no entry the check could read. getTable has
// found a BigQuery table.
const notFound = (entity: string, profile: string, source: string, hint = '') =>
    `entity '${entity}' in profile '${profile}': source '${source}' names no ` +
    `table Knowledge Catalog knows about. The table may not exist, or you may ` +
    `not be allowed to read its catalog entry.${hint} ${
        source.startsWith('bigquery.') ? 'Fix the access or the source.' :
                                         'Create the table or fix the source.'}${skips(source)}`;
// The start of the messages for an inline source of `entity`.
const at = (source: string, entity = 'orders') =>
    `entity '${entity}' in profile 'default': source '${source}'`;
// The message for an inline source whose check failed for another reason.
const couldNotCheck = (source: string, detail: string) =>
    `${at(source)} could not be checked; try again: ${detail}${skips(source)}`;
// The message for an inline source whose location read `what` answered 404,
// so `missed`, such as `table`, does not exist.
const missing = (source: string, missed: string, what: string, entity?: string, hint = '') =>
    `${at(source, entity)} names ${/^[aeiou]/i.test(missed) ? 'an' : 'a'} ${missed} that ` +
    `does not exist: ${what} found nothing (HTTP 404).${hint} Create the ${missed} or ` +
    `fix the source.${skips(source)}`;
// The message for an inline source whose location read `what` answered 400
// with `message`.
const failed = (source: string, what: string, message: string, hint = '') =>
    `${at(source)} could not be checked: ${what} failed (HTTP 400: ${message}).` +
    `${hint} Fix the source.${skips(source)}`;
// The message for an inline source whose location read `what` answered 403
// with `message`.
const refused = (source: string, what: string, message: string, hint = '') =>
    `${at(source)} could not be checked: ${what} was refused (HTTP 403). ` +
    `${message}${hint} The source's catalog entry was not looked up. Fix the ` +
    `access or the source.${skips(source)}`;
const ALLOYDB_HINT = ' A new AlloyDB cluster can take hours to appear in the ' +
    'catalog after Dataplex integration is turned on.';
const CONFIG_HINT = ' Reading it needs the permission ' +
    'spanner.instanceConfigs.get on the project, which roles/spanner.viewer ' +
    'includes and the Spanner database roles do not.';
const HIVE_FORM = " A table in a Hive catalog is written with 'databases/<database>'.";
const ICEBERG_FORM = " A table in an Iceberg REST catalog is written with 'namespaces/<namespace>'.";
const INSTANCE_HINT = ' The Spanner database roles include ' +
    'spanner.instances.get, but a role granted on one database does not ' +
    'apply to its instance.';

describe('sourceEntryErrors', () => {
  const CONFIG_DENIED = spannerDenied('spanner.instanceConfigs.get', NAM3_INSTANCE.config);
  // [label, source, the lookup that finds its entry, the reads and lookups
  // before it, hint, answers that replace the live ones, the lookups after it
  // when no location has the entry]
  const SYSTEMS: Array<[string, string, string, string[], string?,
                        Record<string, ApiResult<any>>?, string[]?]> = [
    // A BigQuery entry sits in its table's location, which reads `US`.
    ['BigQuery', BIGQUERY, lookup('bigquery', 'us', BIGQUERY),
     [`getTable ${P} kcmd_demo orders`]],
    ['regional BigLake', BIGLAKE, lookup('biglake', 'us-central1', BIGLAKE),
     [`getCatalog ${P} kcmd-src-biglake-57138`]],
    ['federated multi-region BigLake', BIGLAKE_US, lookup('biglake', 'us', BIGLAKE_US),
     ['getCatalog looker-private-demo snowflake']],
    ['multi-region BigLake, whose primary replica is not listed first', BIGLAKE_GCS_US,
     lookup('biglake', 'us-central1', BIGLAKE_GCS_US),
     [`getCatalog ${P} kcmd-biglake-probe-6890`], undefined, undefined,
     [lookup('biglake', 'us-east1', BIGLAKE_GCS_US)]],
    // After a failover, an older table's entry sits in a former primary's
    // region, now a secondary's: the primary's region is looked in first.
    ['multi-region BigLake, whose entry sits in its secondary\'s region', BIGLAKE_GCS_US,
     lookup('biglake', 'us-east1', BIGLAKE_GCS_US),
     [`getCatalog ${P} kcmd-biglake-probe-6890`,
      lookup('biglake', 'us-central1', BIGLAKE_GCS_US)]],
    ['multi-region BigLake during a failover, with no STATE_PRIMARY replica',
     BIGLAKE_FAILOVER, lookup('biglake', 'us-central1', BIGLAKE_FAILOVER),
     [`getCatalog ${P} kcmd-biglake-failover`,
      lookup('biglake', 'us-east1', BIGLAKE_FAILOVER)]],
    // After a fail back, a table made during the failover has its entry only
    // in the secondary's region (live, 2026-11-04).
    ['Hive BigLake, whose entry sits in its secondary\'s region', BIGLAKE_HIVE,
     lookup('biglake', 'us-east1', BIGLAKE_HIVE), [GET_HIVE, lookup('biglake', 'us', BIGLAKE_HIVE)]],
    // A Spanner entry sits in its config's default leader region. A regional
    // config's name gives it, so the config is not read; the live config
    // agrees.
    ['regional Spanner', SPANNER,
     lookup('spanner', REGIONAL_CONFIG.replicas.find(r => r.defaultLeaderLocation)!.location, SPANNER),
     [`getInstance ${P} kcmd-src-reg`]],
    ['nam3 Spanner', SPANNER_NAM3, lookup('spanner', 'us-east4', SPANNER_NAM3),
     [`getInstance ${P} kcmd-src-multi`, `getInstanceConfig ${NAM3_INSTANCE.config}`]],
    ['nam22 Spanner, whose leader is not its first replica', SPANNER_NAM22,
     lookup('spanner', 'us-east5', SPANNER_NAM22),
     [`getInstance ${P} kcmd-src-nam22`, `getInstanceConfig ${NAM22_CONFIG.name}`]],
    // When the config read is refused, the entry is looked up in each region
    // the instance lists, in its order, and nowhere else: live, it sat in
    // us-east4, the config's default leader, which the instance lists second.
    ['nam3 Spanner whose config read is refused', SPANNER_NAM3,
     lookup('spanner', 'us-east4', SPANNER_NAM3),
     [`getInstance ${P} kcmd-src-multi`, `getInstanceConfig ${NAM3_INSTANCE.config}`,
      lookup('spanner', 'us-east1', SPANNER_NAM3)],
     ` Instance config '${NAM3_INSTANCE.config}' could not be read (HTTP 403), ` +
         `so the entry was looked up in each of the instance's replica regions: ` +
         `us-east1, us-east4, us-central1.`,
     {[`getInstanceConfig ${NAM3_INSTANCE.config}`]: CONFIG_DENIED},
     [lookup('spanner', 'us-central1', SPANNER_NAM3)]],
    // An AlloyDB entry sits in the location its source names.
    ['AlloyDB', ALLOYDB, lookup('alloydb', 'us-east4', ALLOYDB), [], ALLOYDB_HINT],
  ];
  for (const [label, source, entry, reads, hint, override, after = []] of SYSTEMS) {
    test(`${label}: its entry is looked up in its table's location`, async () => {
      const {readers, calls} = fakeReaders([entry], override);
      expect(await sourceEntryErrors(inline(source), readers)).toEqual([]);
      expect(calls).toEqual([...reads, entry]);
      // Without the entry, in any location, the source fails, once every
      // location has been looked in.
      const without = fakeReaders([], override);
      expect(await sourceEntryErrors(inline(source), without.readers))
          .toEqual([notFound('orders', 'default', source, hint)]);
      expect(without.calls).toEqual([...reads, entry, ...after]);
    });
  }

  const NAM3_CONFIG_READ = `reading instance config '${NAM3_INSTANCE.config}'`;
  const INSTANCE_DENIED = spannerDenied('spanner.instances.get', REGIONAL_INSTANCE.name);
  const NAM22_CONFIG_DENIED = spannerDenied('spanner.instanceConfigs.get', NAM22_CONFIG.name);
  // The loader accepts this table ID; BigQuery rejects it.
  const BIGQUERY_INVALID = BIGQUERY.replace(/orders$/, 'orders!x');
  const ALLOYDB_LOOKUP = lookup('alloydb', 'us-east4', ALLOYDB);
  const ENTRY_INVALID = entryInvalid(ALLOYDB_LOOKUP.split(' ')[3]);
  const CAPS_ID = HIVE_ID.toUpperCase();
  const HIVE_CAPS = BIGLAKE_HIVE.replace(HIVE_ID, CAPS_ID);
  const HIVE_MISSING = BIGLAKE_HIVE.replace(HIVE_ID, 'no_such_catalog');
  const UNAVAILABLE = {status: 503, message: 'unavailable'};
  const INVALID_HYPHEN_ID = invalidHiveId('kcmd-src-biglake-57138');
  const notIceberg = (hint?: string) =>
      failed(HIVE_AS_ICEBERG, `reading the region of catalog '${HIVE_ID}'`, NOT_ICEBERG.message, hint);
  // [label, source, the read that fails, its answer, the message, the reads
  // after it, with their answers]
  const FAILED_READS: Array<[string, string, string, ApiResult<any>|Error, string,
                             Record<string, ApiResult<any>>?]> = [
    // A missing table or dataset, catalog or instance answers 404.
    ['a missing table', BIGQUERY, `getTable ${P} kcmd_demo orders`, NOT_FOUND,
     missing(BIGQUERY, 'table', `reading table '${P}.kcmd_demo.orders'`)],
    ['a missing catalog', BIGLAKE, `getCatalog ${P} kcmd-src-biglake-57138`, NOT_FOUND,
     missing(BIGLAKE, 'catalog', `reading the region of catalog 'kcmd-src-biglake-57138'`),
     {[`getHiveCatalog ${P} kcmd-src-biglake-57138`]: INVALID_HYPHEN_ID}],
    ['a missing Hive catalog', HIVE_MISSING, 'getHiveCatalog sqlgen-testing no_such_catalog', NOT_FOUND,
     missing(HIVE_MISSING, 'Hive catalog', "reading the region of Hive catalog 'no_such_catalog'"),
     {'getCatalog sqlgen-testing no_such_catalog': NOT_FOUND}],
    ['a missing instance', SPANNER, `getInstance ${P} kcmd-src-reg`, NOT_FOUND,
     missing(SPANNER, 'instance', `reading instance 'kcmd-src-reg'`)],
    // Spanner answers 403 for an instance or config the caller may not read.
    ['a refused instance read', SPANNER, `getInstance ${P} kcmd-src-reg`,
     INSTANCE_DENIED,
     refused(SPANNER, `reading instance 'kcmd-src-reg'`, INSTANCE_DENIED.message,
             INSTANCE_HINT)],
    // With no replica regions to look in instead.
    ['a refused instance config read, for an instance that lists no replica regions',
     SPANNER_NAM22, `getInstanceConfig ${NAM22_CONFIG.name}`, NAM22_CONFIG_DENIED,
     refused(SPANNER_NAM22, `reading instance config '${NAM22_CONFIG.name}'`,
             NAM22_CONFIG_DENIED.message, CONFIG_HINT)],
    // A 5xx or a thrown call may pass on retry; a 400 never will.
    ['an instance config that fails', SPANNER_NAM3,
     `getInstanceConfig ${NAM3_INSTANCE.config}`, UNAVAILABLE,
     couldNotCheck(SPANNER_NAM3, `${NAM3_CONFIG_READ} failed (HTTP 503: unavailable).`)],
    ['a catalog read that answers 503', BIGLAKE, `getCatalog ${P} kcmd-src-biglake-57138`, UNAVAILABLE,
     couldNotCheck(BIGLAKE, "reading the region of catalog 'kcmd-src-biglake-57138' failed (HTTP 503: unavailable).")],
    ['a catalog read that throws', BIGLAKE, `getCatalog ${P} kcmd-src-biglake-57138`, new Error('socket hang up'),
     couldNotCheck(BIGLAKE, "reading the region of catalog 'kcmd-src-biglake-57138' failed: socket hang up.")],
    ['a lookup that throws', ALLOYDB, ALLOYDB_LOOKUP,
     new Error('socket hang up'),
     couldNotCheck(ALLOYDB, 'looking up its Knowledge Catalog entry failed: socket hang up.')],
    ['an invalid table ID', BIGQUERY_INVALID, `getTable ${P} kcmd_demo orders!x`,
     INVALID_TABLE_ID,
     failed(BIGQUERY_INVALID, `reading table '${P}.kcmd_demo.orders!x'`, INVALID_TABLE_ID.message)],
    ['a lookup that answers 400', ALLOYDB, ALLOYDB_LOOKUP, ENTRY_INVALID,
     failed(ALLOYDB, 'looking up its Knowledge Catalog entry', ENTRY_INVALID.message)],
    // A catalog read that a retry cannot pass is followed by a read through the
    // other kind of catalog's API. The message says how a table in that kind of
    // catalog is written only when that read finds the catalog. The Hive API
    // refuses an id with a hyphen or a capital letter.
    ['a Hive catalog written with namespaces/', HIVE_AS_ICEBERG, GET_HIVE_AS_ICEBERG, NOT_ICEBERG,
     notIceberg(HIVE_FORM), {[GET_HIVE]: ok(HIVE_CATALOG)}],
    ['a Hive catalog written with namespaces/, whose Hive read answers 403', HIVE_AS_ICEBERG,
     GET_HIVE_AS_ICEBERG, NOT_ICEBERG, notIceberg(), {[GET_HIVE]: {status: 403, message: 'denied'}}],
    ['a Hive catalog written with namespaces/, whose Hive read answers 503', HIVE_AS_ICEBERG,
     GET_HIVE_AS_ICEBERG, NOT_ICEBERG, notIceberg(), {[GET_HIVE]: UNAVAILABLE}],
    ['an Iceberg REST catalog written with databases/', BIGLAKE_AS_HIVE, `getHiveCatalog ${P} kcmd-src-biglake-57138`,
     INVALID_HYPHEN_ID, failed(BIGLAKE_AS_HIVE, "reading the region of Hive catalog 'kcmd-src-biglake-57138'",
                               INVALID_HYPHEN_ID.message, ICEBERG_FORM),
     {[`getCatalog ${P} kcmd-src-biglake-57138`]: ok(REGIONAL_CATALOG)}],
    ['a Hive catalog id in capitals', HIVE_CAPS, `getHiveCatalog sqlgen-testing ${CAPS_ID}`, invalidHiveId(CAPS_ID),
     failed(HIVE_CAPS, `reading the region of Hive catalog '${CAPS_ID}'`, invalidHiveId(CAPS_ID).message),
     {[`getCatalog sqlgen-testing ${CAPS_ID}`]: NOT_FOUND}],
    // The services have always given these fields; the guards keep an answer
    // without one from crashing the push.
    ['a table with no location', BIGQUERY, `getTable ${P} kcmd_demo orders`,
     ok({...US_TABLE, location: undefined}),
     couldNotCheck(BIGQUERY, `reading table '${P}.kcmd_demo.orders' gave no location.`)],
    // A catalog lists no replicas for a few seconds after it is created.
    ['a catalog with no region', BIGLAKE, `getCatalog ${P} kcmd-src-biglake-57138`,
     ok({...REGIONAL_CATALOG, replicas: []}),
     couldNotCheck(BIGLAKE, `reading the region of catalog 'kcmd-src-biglake-57138' gave no region.`)],
    ['an instance with no config', SPANNER, `getInstance ${P} kcmd-src-reg`,
     ok({name: REGIONAL_INSTANCE.name}),
     couldNotCheck(SPANNER, `reading instance 'kcmd-src-reg' gave no instance config.`)],
    ['a config with no default leader', SPANNER_NAM3,
     `getInstanceConfig ${NAM3_INSTANCE.config}`,
     ok({...NAM3_CONFIG, replicas: NAM3_CONFIG.replicas.slice(1)}),
     couldNotCheck(SPANNER_NAM3, `${NAM3_CONFIG_READ} gave no default leader.`)],
  ];
  for (const [label, source, call, answer, message, after = {}] of FAILED_READS) {
    test(`${label} fails the source, and only the listed reads follow it`, async () => {
      const {readers, calls} = fakeReaders([], {[call]: answer, ...after});
      expect(await sourceEntryErrors(inline(source), readers)).toEqual([message]);
      expect(calls.slice(calls.indexOf(call))).toEqual([call, ...Object.keys(after)]);
    });
  }

  test('each table, catalog, instance and instance config is read once', async () => {
    const SPANNER_2 = SPANNER_NAM3.replace(/Orders$/, 'Items');
    const BIGLAKE_2 = BIGLAKE_GCS_US.replace(/orders$/, 'items');
    const entries = [
      lookup('bigquery', 'us', BIGQUERY),
      lookup('spanner', 'us-east4', SPANNER_NAM3),
      lookup('spanner', 'us-east4', SPANNER_2),
      lookup('biglake', 'us-central1', BIGLAKE_GCS_US),
      lookup('biglake', 'us-central1', BIGLAKE_2),
    ];
    const {readers, calls} = fakeReaders(entries);
    const m = model(
        [entity('orders', BIGQUERY), entity('items', SPANNER_2)],
        [
          profile('a', [['orders', BIGQUERY], ['items', SPANNER_NAM3]]),
          profile('b', [['orders', BIGQUERY]]),
          profile('c', [['orders', BIGLAKE_GCS_US], ['items', BIGLAKE_2]]),
        ]);
    expect(await sourceEntryErrors(m, readers)).toEqual([]);
    expect(calls.sort()).toEqual([
      `getTable ${P} kcmd_demo orders`,
      `getInstance ${P} kcmd-src-multi`,
      `getInstanceConfig ${NAM3_INSTANCE.config}`,
      `getCatalog ${P} kcmd-biglake-probe-6890`,
      ...entries,
    ].sort());
  });

  // The Hive API answers 404 for an Iceberg REST catalog. That wrong form
  // does not fail the catalog's right form.
  test('a catalog written in both forms is read once through each API', async () => {
    const entry = lookup('biglake', 'us', BIGLAKE_US);
    const {readers, calls} = fakeReaders([entry]);
    const m = model([entity('orders', BIGLAKE_US_AS_HIVE)], [profile('iceberg', [['orders', BIGLAKE_US]])]);
    expect(await sourceEntryErrors(m, readers)).toEqual([missing(BIGLAKE_US_AS_HIVE, 'Hive catalog',
        "reading the region of Hive catalog 'snowflake'", undefined, ICEBERG_FORM)]);
    expect(calls.sort()).toEqual(
        ['getCatalog looker-private-demo snowflake', 'getHiveCatalog looker-private-demo snowflake', entry]);
  });

  test('every entity of a failing source is reported, in model order', async () => {
    const {readers} = fakeReaders([lookup('bigquery', 'us', BIGQUERY)]);
    const m = model(
        [entity('orders', SPANNER), entity('items', BIGQUERY)],
        [profile('spanner', [['orders', SPANNER_NAM3], ['items', SPANNER]])]);
    expect(await sourceEntryErrors(m, readers)).toEqual([
      notFound('orders', 'default', SPANNER),
      notFound('orders', 'spanner', SPANNER_NAM3),
      notFound('items', 'spanner', SPANNER),
    ]);
  });

  test('an entity with no table this check reads is skipped', async () => {
    const {readers, calls} = fakeReaders([]);
    const m = model(
      [
        entity('party', BIGQUERY, {abstract: true}),
        entity('unbound', ''),
        // A dotted `dataSource` with no authored source.
        entity('dotted', '', {dataSource: `${P}.kcmd_demo.orders`}),
        // sourceDialects looks a Cloud SQL table up.
        entity('cloudsql', `cloudsql.googleapis.com/projects/${P}/locations/us-central1/instances/i/databases/d/tables/t`),
      ],
      [profile('p', [['orders']])]);
    expect(await sourceEntryErrors(m, readers)).toEqual([]);
    expect(calls).toEqual([]);
  });

  // The message for profile `name`, whose tables can be queried at `locations`.
  const spans = (name: string, locations: string) =>
      `profile '${name}' of model 'commerce' binds tables that share no ` +
      `BigQuery location: ${locations}. BigQuery runs each query in one ` +
      `location, so no query can join them. Bind them to tables that share a ` +
      `location. --skip-source-check skips this check, but a deployment that ` +
      `reads these tables still checks their locations itself.`;
  // Every table below has its entry.
  const ENTRIES = [
    lookup('bigquery', 'us', BIGQUERY),
    lookup('bigquery', 'us-central1', BQ_CENTRAL),
    lookup('bigquery', 'europe-west1', BQ_EU),
    lookup('bigquery', 'us-east1', BQ_EAST),
    lookup('biglake', 'us-central1', BIGLAKE_GCS_US),
    lookup('biglake', 'us', BIGLAKE_US),
  ];
  // [label, inline sources of orders and customers, profiles, the messages,
  //  answers that replace the live ones]
  const LOCATIONS: Array<[string, [string, string], ProfileSpec[], string[],
                          Record<string, ApiResult<any>>?]> = [
    // The bug's repro.
    ['a profile binding datasets in two regions', [BQ_CENTRAL, BQ_CENTRAL],
     [profile('prod', [['orders', BQ_CENTRAL], ['customers', BQ_EU]])],
     [spans('prod', "us-central1 ('orders'), europe-west1 ('customers')")]],
    ['inline sources in a region and the US multi-region', [BQ_CENTRAL, BIGQUERY], [],
     [spans('default', "us-central1 ('orders'), US ('customers')")]],
    // BigQuery queries a US BigLake catalog in any of its replicas' regions:
    // us-central1, its primary, and us-east1. The message lists the primary
    // first, though the catalog lists its secondary first.
    ['a US BigLake catalog whose primary is us-central1, with a us-central1 dataset',
     [BIGLAKE_GCS_US, BQ_CENTRAL], [], []],
    ['a US BigLake catalog whose secondary is us-east1, with a us-east1 dataset',
     [BIGLAKE_GCS_US, BQ_EAST], [], []],
    ['a US BigLake catalog with replicas in us-central1 and us-east1, with a US dataset',
     [BIGLAKE_GCS_US, BIGQUERY], [],
     [spans('default', "us-central1 or us-east1 ('orders'), US ('customers')")]],
    // The table writes `US` and the federated catalog's replica `US`.
    ['a US dataset and a federated US catalog', [BIGQUERY, BIGLAKE_US], [], []],
    ['a table whose location read failed, which only its own message names', [BQ_CENTRAL, BQ_EU], [],
     [missing(BQ_EU, 'table', `reading table '${P}.eu_ds.customers'`, 'customers')],
     {[`getTable ${P} eu_ds customers`]: NOT_FOUND}],
  ];
  for (const [label, [orders, customers], profiles, messages, override] of LOCATIONS) {
    test(`${label}: ${messages.length ? 'fails' : 'passes'}`, async () => {
      const m = model([entity('orders', orders), entity('customers', customers)], profiles);
      expect(await sourceEntryErrors(m, fakeReaders(ENTRIES, override).readers))
          .toEqual(messages);
    });
  }

  test('the GCP clients provide the reads', () => {
    // Compile-time check: each client fits its reader.
    const fits = (c: CatalogClient, bq: BigQueryClient, bl: BigLakeClient,
                  sp: SpannerClient): SourceReaders =>
        ({catalog: c, bigquery: bq, biglake: bl, spanner: sp});
    expect(typeof fits).toBe('function');
  });
});
