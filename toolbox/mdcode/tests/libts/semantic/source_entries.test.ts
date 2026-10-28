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
import {entryDenied, MULTI_REGION_CATALOG, NAM22_CONFIG, NAM3_CONFIG, NAM3_INSTANCE, NOT_FOUND, P, REGIONAL_CATALOG, REGIONAL_CONFIG, REGIONAL_INSTANCE, US_DATASET} from '../gcp/location_responses';

const BIGQUERY = `bigquery.googleapis.com/projects/${P}/datasets/kcmd_demo/tables/orders`;
const BIGLAKE = `biglake.googleapis.com/projects/${P}/catalogs/kcmd-src-biglake-57138/namespaces/sales/tables/orders`;
const BIGLAKE_US = 'biglake.googleapis.com/projects/looker-private-demo/catalogs/snowflake/namespaces/sales/tables/orders';
const SPANNER = `spanner.googleapis.com/projects/${P}/instances/kcmd-src-reg/databases/sales/tables/Orders`;
const SPANNER_NAM3 = `spanner.googleapis.com/projects/${P}/instances/kcmd-src-multi/databases/sales/tables/Orders`;
const SPANNER_NAM22 = `spanner.googleapis.com/projects/${P}/instances/kcmd-src-nam22/databases/sales/tables/Orders`;
// The nam22 config is live; the instance is made up, in the shape of the live
// ones.
const NAM22_INSTANCE = {
  name: `projects/${P}/instances/kcmd-src-nam22`,
  config: NAM22_CONFIG.name,
};
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
// names, and record each call. A dataset, instance, config or catalog they do
// not know answers 404; an entry not in `entries` answers 403, as a missing
// entry or one in another location does. `override` replaces one answer.
function fakeReaders(entries: string[], override: Record<string, ApiResult<any>|Error> = {}) {
  const calls: string[] = [];
  const answers: Record<string, ApiResult<any>> = {
    [`getDataset ${P} kcmd_demo`]: ok(US_DATASET),
    [`getInstance ${P} kcmd-src-reg`]: ok(REGIONAL_INSTANCE),
    [`getInstance ${P} kcmd-src-multi`]: ok(NAM3_INSTANCE),
    [`getInstanceConfig ${REGIONAL_INSTANCE.config}`]: ok(REGIONAL_CONFIG),
    [`getInstanceConfig ${NAM3_INSTANCE.config}`]: ok(NAM3_CONFIG),
    [`getInstance ${P} kcmd-src-nam22`]: ok(NAM22_INSTANCE),
    [`getInstanceConfig ${NAM22_CONFIG.name}`]: ok(NAM22_CONFIG),
    [`getCatalog ${P} kcmd-src-biglake-57138`]: ok(REGIONAL_CATALOG),
    'getCatalog looker-private-demo snowflake': ok(MULTI_REGION_CATALOG),
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
    bigquery: {getDataset: (p, d) => answer(`getDataset ${p} ${d}`, NOT_FOUND)},
    biglake: {getCatalog: (p, c) => answer(`getCatalog ${p} ${c}`, NOT_FOUND)},
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
const inline = (source: string) => ({entities: [entity('orders', source)]});

// The message for a source with no entry the check could read.
const notFound = (entity: string, profile: string, source: string, hint = '') =>
    `entity '${entity}' in profile '${profile}': source '${source}' names no ` +
    `table Knowledge Catalog knows about. The table may not exist, or you may ` +
    `not be allowed to read its catalog entry.${hint} Fix the source, or pass ` +
    `--skip-source-check.`;
// The message for an inline source whose check failed for another reason.
const couldNotCheck = (source: string, detail: string) =>
    `entity 'orders' in profile 'default': source '${source}' could not be ` +
    `checked; try again, or pass --skip-source-check: ${detail}`;
const ALLOYDB_HINT = ' A new AlloyDB cluster can take hours to appear in the ' +
    'catalog after Dataplex integration is turned on.';

describe('sourceEntryErrors', () => {
  // [label, source, the lookup of its entry, the reads before it, hint]
  const SYSTEMS: Array<[string, string, string, string[], string?]> = [
    // A BigQuery entry sits in its dataset's location, which reads `US`.
    ['BigQuery', BIGQUERY, lookup('bigquery', 'us', BIGQUERY),
     [`getDataset ${P} kcmd_demo`]],
    ['regional BigLake', BIGLAKE, lookup('biglake', 'us-central1', BIGLAKE),
     [`getCatalog ${P} kcmd-src-biglake-57138`]],
    ['multi-region BigLake', BIGLAKE_US, lookup('biglake', 'us', BIGLAKE_US),
     ['getCatalog looker-private-demo snowflake']],
    // A Spanner entry sits in its config's default leader region.
    ['regional Spanner', SPANNER, lookup('spanner', 'us-central1', SPANNER),
     [`getInstance ${P} kcmd-src-reg`, `getInstanceConfig ${REGIONAL_INSTANCE.config}`]],
    ['nam3 Spanner', SPANNER_NAM3, lookup('spanner', 'us-east4', SPANNER_NAM3),
     [`getInstance ${P} kcmd-src-multi`, `getInstanceConfig ${NAM3_INSTANCE.config}`]],
    ['nam22 Spanner, whose leader is not its first replica', SPANNER_NAM22,
     lookup('spanner', 'us-east5', SPANNER_NAM22),
     [`getInstance ${P} kcmd-src-nam22`, `getInstanceConfig ${NAM22_CONFIG.name}`]],
    // An AlloyDB entry sits in the location its source names.
    ['AlloyDB', ALLOYDB, lookup('alloydb', 'us-east4', ALLOYDB), [], ALLOYDB_HINT],
  ];
  for (const [label, source, entry, reads, hint] of SYSTEMS) {
    test(`${label}: its entry is looked up in its table's location`, async () => {
      const {readers, calls} = fakeReaders([entry]);
      expect(await sourceEntryErrors(inline(source), readers)).toEqual([]);
      expect(calls).toEqual([...reads, entry]);
      // Without the entry, the source fails.
      expect(await sourceEntryErrors(inline(source), fakeReaders([]).readers))
          .toEqual([notFound('orders', 'default', source, hint)]);
    });
  }

  // [label, source, the read that fails, its answer, the message]
  const FAILED_READS: Array<[string, string, string, ApiResult<any>|Error, string]> = [
    ['a missing dataset', BIGQUERY, `getDataset ${P} kcmd_demo`, NOT_FOUND,
     notFound('orders', 'default', BIGQUERY)],
    ['a missing catalog', BIGLAKE, `getCatalog ${P} kcmd-src-biglake-57138`, NOT_FOUND,
     notFound('orders', 'default', BIGLAKE)],
    ['a missing instance', SPANNER, `getInstance ${P} kcmd-src-reg`, NOT_FOUND,
     notFound('orders', 'default', SPANNER)],
    ['an instance config that fails', SPANNER,
     `getInstanceConfig ${REGIONAL_INSTANCE.config}`, {status: 503, message: 'unavailable'},
     couldNotCheck(SPANNER, `reading instance config '${
         REGIONAL_INSTANCE.config}' failed (HTTP 503: unavailable).`)],
    ['a lookup that throws', ALLOYDB, lookup('alloydb', 'us-east4', ALLOYDB),
     new Error('socket hang up'),
     couldNotCheck(ALLOYDB, 'looking up its Knowledge Catalog entry failed: socket hang up')],
    // The services have always given these fields; the guards keep an answer
    // without one from crashing the push.
    ['a dataset with no location', BIGQUERY, `getDataset ${P} kcmd_demo`,
     ok({...US_DATASET, location: undefined}),
     couldNotCheck(BIGQUERY, `reading the location of dataset '${P}.kcmd_demo' gave no location.`)],
    ['a catalog with no region', BIGLAKE, `getCatalog ${P} kcmd-src-biglake-57138`,
     ok({...REGIONAL_CATALOG, replicas: []}),
     couldNotCheck(BIGLAKE, `reading the region of catalog 'kcmd-src-biglake-57138' gave no region.`)],
    ['an instance with no config', SPANNER, `getInstance ${P} kcmd-src-reg`,
     ok({name: REGIONAL_INSTANCE.name}),
     couldNotCheck(SPANNER, `reading instance 'kcmd-src-reg' gave no instance config.`)],
    ['a config with no default leader', SPANNER,
     `getInstanceConfig ${REGIONAL_INSTANCE.config}`,
     ok({...REGIONAL_CONFIG, replicas: REGIONAL_CONFIG.replicas.slice(1)}),
     couldNotCheck(SPANNER, `reading instance config '${
         REGIONAL_INSTANCE.config}' gave no default leader.`)],
  ];
  for (const [label, source, call, answer, message] of FAILED_READS) {
    test(`${label} fails the source, and nothing after it is read`, async () => {
      const {readers, calls} = fakeReaders([], {[call]: answer});
      expect(await sourceEntryErrors(inline(source), readers)).toEqual([message]);
      expect(calls.at(-1)).toBe(call);
    });
  }

  test('each table, dataset and instance is read once', async () => {
    const SPANNER_2 = SPANNER.replace(/Orders$/, 'Items');
    const entries = [
      lookup('bigquery', 'us', BIGQUERY),
      lookup('spanner', 'us-central1', SPANNER),
      lookup('spanner', 'us-central1', SPANNER_2),
    ];
    const {readers, calls} = fakeReaders(entries);
    const model = {
      entities: [entity('orders', BIGQUERY), entity('items', SPANNER_2)],
      profiles: [
        profile('a', [['orders', BIGQUERY], ['items', SPANNER]]),
        profile('b', [['orders', BIGQUERY]]),
      ],
    };
    expect(await sourceEntryErrors(model, readers)).toEqual([]);
    expect(calls.sort()).toEqual([
      `getDataset ${P} kcmd_demo`,
      `getInstance ${P} kcmd-src-reg`,
      `getInstanceConfig ${REGIONAL_INSTANCE.config}`,
      ...entries,
    ].sort());
  });

  test('every entity of a failing source is reported, in model order', async () => {
    const {readers} = fakeReaders([lookup('bigquery', 'us', BIGQUERY)]);
    const model = {
      entities: [entity('orders', SPANNER), entity('items', BIGQUERY)],
      profiles: [profile('spanner', [['orders', SPANNER_NAM3], ['items', SPANNER]])],
    };
    expect(await sourceEntryErrors(model, readers)).toEqual([
      notFound('orders', 'default', SPANNER),
      notFound('orders', 'spanner', SPANNER_NAM3),
      notFound('items', 'spanner', SPANNER),
    ]);
  });

  test('an entity with no table this check reads is skipped', async () => {
    const {readers, calls} = fakeReaders([]);
    const model = {
      entities: [
        entity('party', BIGQUERY, {abstract: true}),
        entity('unbound', ''),
        // A legacy bare name, which the load completes into `dataSource`.
        entity('legacy', 'orders', {dataSource: `${P}.kcmd_demo.orders`}),
        // cloudSqlDialects looks a Cloud SQL table up.
        entity('cloudsql', `cloudsql.googleapis.com/projects/${P}/locations/us-central1/instances/i/databases/d/tables/t`),
      ],
      profiles: [profile('p', [['orders']])],
    };
    expect(await sourceEntryErrors(model, readers)).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('the GCP clients provide the reads', () => {
    // Compile-time check: each client fits its reader.
    const fits = (c: CatalogClient, bq: BigQueryClient, bl: BigLakeClient,
                  sp: SpannerClient): SourceReaders =>
        ({catalog: c, bigquery: bq, biglake: bl, spanner: sp});
    expect(typeof fits).toBe('function');
  });
});
