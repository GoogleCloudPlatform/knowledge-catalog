// Behavior spec for the reads the source check uses to find where Knowledge
// Catalog keeps a table's entry: a BigQuery table, a Spanner instance and its
// instance config, and a BigLake catalog. Spies on the low-level _get so it
// pins the path and parameters each read requests without a live service. The
// responses are live copies (see location_responses.ts).

import {describe, expect, spyOn, test} from 'bun:test';

import {ApiResult} from '../../../src/libts/gcp/api';
import {BigLakeClient} from '../../../src/libts/gcp/biglake';
import {BigQueryClient} from '../../../src/libts/gcp/bigquery';
import {ApiContext} from '../../../src/libts/gcp/context';
import {SpannerClient} from '../../../src/libts/gcp/spanner';

import {FEDERATED_CATALOG, NAM3_CONFIG, NAM3_INSTANCE, NOT_FOUND, P, REGIONAL_CATALOG, US_TABLE} from './location_responses';

const CTX = new ApiContext('test-project', 'us', 'test-token');

const bigquery = new BigQueryClient(CTX);
const spanner = new SpannerClient(CTX);
const biglake = new BigLakeClient(CTX);

// [label, client, call, the arguments _get gets, what the service answers]
const CASES: Array<[string, object, () => Promise<ApiResult<unknown>>, unknown[],
                    ApiResult<unknown>]> = [
  // The BASIC view, since `selectedFields` picks schema columns: live,
  // `selectedFields=tableReference` answered 400.
  ['BigQuery table', bigquery,
   () => bigquery.getTable(P, 'kcmd_demo', 'orders'),
   [`projects/${P}/datasets/kcmd_demo/tables/orders`, {view: 'BASIC'}],
   {status: 200, result: US_TABLE}],
  ['missing BigQuery table', bigquery,
   () => bigquery.getTable(P, 'kcmd_demo', 'nope'),
   [`projects/${P}/datasets/kcmd_demo/tables/nope`, {view: 'BASIC'}], NOT_FOUND],
  ['Spanner instance', spanner,
   () => spanner.getInstance(P, 'kcmd-src-multi'),
   [`projects/${P}/instances/kcmd-src-multi`],
   {status: 200, result: NAM3_INSTANCE}],
  ['missing Spanner instance', spanner, () => spanner.getInstance(P, 'nope'),
   [`projects/${P}/instances/nope`], NOT_FOUND],
  ['Spanner instance config', spanner,
   () => spanner.getInstanceConfig(NAM3_INSTANCE.config), [NAM3_INSTANCE.config],
   {status: 200, result: NAM3_CONFIG}],
  ['regional BigLake catalog', biglake,
   () => biglake.getCatalog(P, 'kcmd-src-biglake-57138'),
   [`projects/${P}/catalogs/kcmd-src-biglake-57138`],
   {status: 200, result: REGIONAL_CATALOG}],
  ['federated multi-region BigLake catalog', biglake,
   () => biglake.getCatalog('looker-private-demo', 'snowflake'),
   ['projects/looker-private-demo/catalogs/snowflake'],
   {status: 200, result: FEDERATED_CATALOG}],
  ['missing BigLake catalog', biglake, () => biglake.getCatalog(P, 'nope'),
   [`projects/${P}/catalogs/nope`], NOT_FOUND],
];

describe('location reads', () => {
  for (const [label, client, call, args, answer] of CASES) {
    test(`${label}: requests its path and returns the answer as is`,
         async () => {
           const get = spyOn(client as any, '_get')
                           .mockImplementation(async () => answer);
           expect(await call()).toEqual(answer);
           expect(get.mock.calls).toEqual([args]);
           get.mockRestore();
         });
  }
});
