// Tests for src/libts/semantic/cloudsql_dialect.ts: a Cloud SQL table's dialect
// read from its Knowledge Catalog entry. The catalog is faked; nothing here
// calls a service.

import {describe, expect, test} from 'bun:test';

import {ApiResult} from '../../../src/libts/gcp/api';
import {CatalogClient} from '../../../src/libts/gcp/dataplex';
import {cloudSqlDialects, cloudSqlSourcesIn, EntryLookup} from '../../../src/libts/semantic/cloudsql_dialect';

const INSTANCE = 'cloudsql.googleapis.com/projects/acme/locations/us-central1/instances';
const MYSQL = `${INSTANCE}/shop/databases/sales/tables/orders`;
const POSTGRES = `${INSTANCE}/pg/databases/shop/schemas/sales/tables/orders`;
const POSTGRES_VIEW = `${INSTANCE}/pg/databases/shop/schemas/sales/tables/open_orders`;
const SQLSERVER = `${INSTANCE}/ms/databases/shop/schemas/sales/tables/orders`;

// A catalog that answers from `answers`, keyed by entry name, and records each
// call. An entry it does not know gets the 403 Dataplex gives a missing entry.
function fakeCatalog(answers: Record<string, ApiResult<{entryType?: string}>>) {
  const calls: Array<{project: string; location: string; name: string}> = [];
  const catalog: EntryLookup = {
    async lookupEntry(project, location, name) {
      calls.push({project, location, name});
      return answers[name] ??
          {status: 403, message: `Permission denied on resource \`${name}\` (or it may not exist).`};
    },
  };
  return {catalog, calls};
}
const entryName = (resourceName: string) =>
    `projects/acme/locations/us-central1/entryGroups/@cloudsql/entries/${resourceName}`;
const typed = (type: string): ApiResult<{entryType?: string}> =>
    ({status: 200, result: {entryType: `projects/dataplex-types/locations/global/entryTypes/${type}`}});

describe('cloudSqlDialects', () => {
  // Each argument is read as a file's text; a bare resource name is a file
  // whose one value is that name.
  test('each Cloud SQL table or view entry type gives its dialect', async () => {
    const {catalog, calls} = fakeCatalog({
      [entryName(MYSQL)]: typed('cloudsql-mysql-table'),
      [entryName(POSTGRES)]: typed('cloudsql-postgresql-table'),
      [entryName(POSTGRES_VIEW)]: typed('cloudsql-postgresql-view'),
      [entryName(SQLSERVER)]: typed('cloudsql-sqlserver-table'),
    });
    const {dialects, errors} =
        await cloudSqlDialects([MYSQL, POSTGRES, POSTGRES_VIEW, SQLSERVER], catalog);
    expect(errors).toEqual([]);
    expect(dialects).toEqual(new Map([
      [MYSQL, 'MYSQL'], [POSTGRES, 'POSTGRES'], [POSTGRES_VIEW, 'POSTGRES'],
      [SQLSERVER, 'SQLSERVER'],
    ]));
    // The entry is looked up in the table's own project and location.
    expect(calls).toContainEqual(
        {project: 'acme', location: 'us-central1', name: entryName(POSTGRES)});
  });

  test('a type given by project number reads the same', async () => {
    const {catalog} = fakeCatalog({
      [entryName(POSTGRES)]: {
        status: 200,
        result: {entryType: 'projects/655216118709/locations/global/entryTypes/cloudsql-postgresql-table'},
      },
    });
    expect((await cloudSqlDialects([POSTGRES], catalog)).dialects.get(POSTGRES)).toBe('POSTGRES');
  });

  test('each table is looked up once, in either spelling', async () => {
    const {catalog, calls} = fakeCatalog({[entryName(MYSQL)]: typed('cloudsql-mysql-table')});
    const {dialects} = await cloudSqlDialects([MYSQL, `//${MYSQL}`, MYSQL], catalog);
    expect(calls).toHaveLength(1);
    expect(dialects).toEqual(new Map([[MYSQL, 'MYSQL']]));
  });

  test('other sources are not looked up', async () => {
    const {catalog, calls} = fakeCatalog({});
    const {dialects, errors} = await cloudSqlDialects([
      'bigquery.googleapis.com/projects/p/datasets/d/tables/t',
      'cloudsql_mysql:acme.us-central1.shop.sales.orders',
      'spanner.googleapis.com/projects/p/instances/i/databases/db/tables/t',
    ], catalog);
    expect(calls).toEqual([]);
    expect(dialects.size).toBe(0);
    expect(errors).toEqual([]);
  });

  test('a missing or unreadable entry says to turn on Dataplex integration', async () => {
    const {catalog} = fakeCatalog({});
    const {dialects, errors} = await cloudSqlDialects([SQLSERVER], catalog);
    expect(dialects.size).toBe(0);
    expect(errors).toEqual([
      `source '${SQLSERVER}': kcmd reads a Cloud SQL table's dialect from its ` +
      `Knowledge Catalog entry, and could not read it. Turn on Dataplex ` +
      `integration for instance 'ms' (gcloud sql instances patch ms ` +
      `--enable-dataplex-integration --project acme) and wait for the table to ` +
      `appear in the catalog, or check that you can read the table. If ` +
      `integration is on, check the name: the project ID, the instance's ` +
      `region, and a schema only for PostgreSQL and SQL Server.`,
    ]);
  });

  test('an entry of another type is reported with its type', async () => {
    const {catalog} = fakeCatalog({[entryName(MYSQL)]: typed('cloudsql-mysql-database')});
    expect((await cloudSqlDialects([MYSQL], catalog)).errors).toEqual([
      `source '${MYSQL}': its Knowledge Catalog entry has type ` +
      `'cloudsql-mysql-database', which is not a Cloud SQL table or view type ` +
      `kcmd knows (cloudsql-mysql-table, cloudsql-mysql-view, ` +
      `cloudsql-postgresql-table, cloudsql-postgresql-view, ` +
      `cloudsql-sqlserver-table, cloudsql-sqlserver-view).`,
    ]);
  });

  test('another failure is reported with its status, and a thrown error does not escape', async () => {
    const failing: EntryLookup = {
      async lookupEntry(_p, _l, name) {
        if (name.includes('/pg/')) return {status: 503, message: 'unavailable'};
        throw new Error('socket hang up');
      },
    };
    const {errors} = await cloudSqlDialects([POSTGRES, MYSQL], failing);
    // Sorted, so the order does not depend on which lookup answers first.
    expect(errors).toEqual([
      `source '${POSTGRES}': looking up its Knowledge Catalog entry failed (HTTP 503: unavailable).`,
      `source '${MYSQL}': looking up its Knowledge Catalog entry failed: socket hang up`,
    ]);
  });

  test('the catalog client provides the lookup', () => {
    // Compile-time check: CatalogClient fits EntryLookup.
    const fits = (c: CatalogClient): EntryLookup => c;
    expect(typeof fits).toBe('function');
  });
});

describe('cloudSqlSourcesIn', () => {
  test('collects resource names from YAML values, GOOGLE-block JSON and profile files, not from comments', () => {
    const model = `version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    # source: ${INSTANCE}/commented/databases/x/tables/y
    entities:
      - name: orders
        source: ${MYSQL}
      - name: items
        source: bigquery.googleapis.com/projects/p/datasets/d/tables/items
`;
    const vanilla = `version: "0.2.0.dev0"
semantic_model:
  - name: shop
    custom_extensions:
      - vendor_name: GOOGLE
        data: '${JSON.stringify({profiles: [{name: 'ms', entities: [{name: 'orders', source: SQLSERVER}]}]})}'
`;
    const profile = `name: pg
entities:
  - name: orders
    source: "//${POSTGRES}"
`;
    expect(cloudSqlSourcesIn([model, vanilla, profile]).sort())
        .toEqual([`//${POSTGRES}`, MYSQL, SQLSERVER].sort());
    // A file that does not parse collects nothing, even a name it holds.
    expect(cloudSqlSourcesIn([`source: ${MYSQL}\nname: [unclosed`])).toEqual([]);
    // Nor does one whose values cannot be read, and that does not throw: an
    // alias whose anchor is not set.
    expect(cloudSqlSourcesIn([`source: ${MYSQL}\nother: *missing\n`])).toEqual([]);
    // Nor does an alias that refers to itself, whose values are cyclic, stop
    // it; the other files are still read.
    expect(cloudSqlSourcesIn([`a: &a [*a]\nsource: ${MYSQL}\n`, `source: ${POSTGRES}\n`]))
        .toEqual([POSTGRES]);
    // A tag kcmd does not resolve is read as the loader reads it: a !!set
    // stays a plain mapping, so its values are walked.
    expect(cloudSqlSourcesIn([`tables: !!set\n  orders: ${MYSQL}\n`])).toEqual([MYSQL]);
  });
});
