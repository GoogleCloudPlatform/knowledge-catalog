// Tests for src/libts/semantic/source_dialect.ts: a Cloud SQL or third-party
// table's dialect read from its Knowledge Catalog entry. The catalog is faked;
// nothing here calls a service.

import {describe, expect, test} from 'bun:test';

import {ApiResult} from '../../../src/libts/gcp/api';
import {CatalogClient} from '../../../src/libts/gcp/dataplex';
import {EntryLookup} from '../../../src/libts/semantic/catalog_entry';
import {sourceDialects, sourcesToLookUp} from '../../../src/libts/semantic/source_dialect';
import {entryDenied} from '../gcp/location_responses';

const INSTANCE = 'cloudsql.googleapis.com/projects/acme/locations/us-central1/instances';
const MYSQL = `${INSTANCE}/shop/databases/sales/tables/orders`;
const POSTGRES = `${INSTANCE}/pg/databases/shop/schemas/sales/tables/orders`;
const POSTGRES_VIEW = `${INSTANCE}/pg/databases/shop/schemas/sales/tables/open_orders`;
const SQLSERVER = `${INSTANCE}/ms/databases/shop/schemas/sales/tables/orders`;
const THIRD_PARTY = 'projects/acme/locations/us-central1/entryGroups/sf/entries/orders';
// A file that binds THIRD_PARTY, which is collected only as a source.
const THIRD_PARTY_FILE = `source: ${THIRD_PARTY}`;

// A catalog that answers from `answers`, keyed by entry name, and records each
// call. An entry it does not know gets the 403 Dataplex gives a missing entry.
function fakeCatalog(answers: Record<string, ApiResult<object>>) {
  const calls: Array<{project: string; location: string; name: string}> = [];
  const catalog: EntryLookup = {
    async lookupEntry(project, location, name) {
      calls.push({project, location, name});
      return answers[name] ?? entryDenied(name);
    },
  };
  return {catalog, calls};
}
const entryName = (resourceName: string) =>
    `projects/acme/locations/us-central1/entryGroups/@cloudsql/entries/${resourceName}`;
const typed = (type: string): ApiResult<{entryType?: string}> =>
    ({status: 200, result: {entryType: `projects/dataplex-types/locations/global/entryTypes/${type}`}});

describe('sourceDialects', () => {
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
        await sourceDialects([MYSQL, POSTGRES, POSTGRES_VIEW, SQLSERVER], catalog);
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
    expect((await sourceDialects([POSTGRES], catalog)).dialects.get(POSTGRES)).toBe('POSTGRES');
  });

  test('each table is looked up once', async () => {
    const {catalog, calls} = fakeCatalog({[entryName(MYSQL)]: typed('cloudsql-mysql-table')});
    const {dialects} = await sourceDialects([MYSQL, MYSQL], catalog);
    expect(calls).toHaveLength(1);
    expect(dialects).toEqual(new Map([[MYSQL, 'MYSQL']]));
  });

  test('other sources are not looked up', async () => {
    const {catalog, calls} = fakeCatalog({});
    const {dialects, errors} = await sourceDialects([
      'bigquery.googleapis.com/projects/p/datasets/d/tables/t',
      'spanner.googleapis.com/projects/p/instances/i/databases/db/tables/t',
    ], catalog);
    expect(calls).toEqual([]);
    expect(dialects.size).toBe(0);
    expect(errors).toEqual([]);
  });

  test('a missing or unreadable entry says to turn on Dataplex integration', async () => {
    const {catalog} = fakeCatalog({});
    const {dialects, errors} = await sourceDialects([SQLSERVER], catalog);
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
    expect((await sourceDialects([MYSQL], catalog)).errors).toEqual([
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
    const {errors} = await sourceDialects([POSTGRES, MYSQL, THIRD_PARTY_FILE], failing);
    // Sorted, so the order does not depend on which lookup answers first.
    expect(errors).toEqual([
      `source '${POSTGRES}': looking up its Knowledge Catalog entry failed (HTTP 503: unavailable).`,
      `source '${MYSQL}': looking up its Knowledge Catalog entry failed: socket hang up`,
      `source '${THIRD_PARTY}': looking up its Knowledge Catalog entry failed: socket hang up`,
    ]);
  });

  test('the catalog client provides the lookup', () => {
    // Compile-time check: CatalogClient fits EntryLookup.
    const fits = (c: CatalogClient): EntryLookup => c;
    expect(typeof fits).toBe('function');
  });
});

// A third-party table's entry gives its dialect by the prefix of its
// fullyQualifiedName, or, with none, by its entrySource.system in any case.
// The fullyQualifiedName also names the table's database.
describe('sourceDialects of a third-party table', () => {
  const dialectOf = async (result: object) =>
      sourceDialects([THIRD_PARTY_FILE], fakeCatalog({[THIRD_PARTY]: {status: 200, result}}).catalog);

  test('each fullyQualifiedName prefix and system gives its dialect, and the prefix wins', async () => {
    const fqn = (fullyQualifiedName: string) => ({fullyQualifiedName});
    const system = (s: string) => ({entrySource: {system: s}});
    const rows: Array<[object, string, string?]> = [
      [fqn('snowflake:acme.retail.public.orders'), 'SNOWFLAKE', 'snowflake/acme'],
      [fqn('databricks:table:1234.main.retail.orders'), 'DATABRICKS', 'databricks/1234'],
      [fqn('databricks:1234.main.retail.orders'), 'DATABRICKS', 'databricks/1234'],
      [fqn('mysql:host.sales.orders'), 'MYSQL', 'mysql/host'],
      [fqn('postgresql:`db.example.com`.sales.public.orders'), 'POSTGRES',
       'postgresql/db.example.com/sales'],
      [fqn('sqlserver:host.sales.dbo.orders'), 'SQLSERVER', 'sqlserver/host'],
      [system('Snowflake'), 'SNOWFLAKE'],
      [system('DATABRICKS'), 'DATABRICKS'],
      [system('mysql'), 'MYSQL'],
      [system('PostgreSQL'), 'POSTGRES'],
      [system('POSTGRES'), 'POSTGRES'],
      [system('SQLSERVER'), 'SQLSERVER'],
      [{...fqn('snowflake:acme.orders'), ...system('DATABRICKS')}, 'SNOWFLAKE', 'snowflake/acme'],
    ];
    for (const [result, dialect, database] of rows) {
      expect({result, ...await dialectOf(result)}).toEqual({
        result, dialects: new Map([[THIRD_PARTY, dialect]]),
        databases: new Map(database ? [[THIRD_PARTY, database]] : []), errors: [],
      });
    }
  });

  test('an entry that gives no dialect is rejected, naming the entry', async () => {
    for (const [result, has] of [
      [{}, 'neither a fullyQualifiedName nor an entrySource.system'],
      [{fullyQualifiedName: 'custom:acme.orders', entrySource: {system: 'SNOWFLAKE'}},
       "fullyQualifiedName 'custom:acme.orders'"],
      [{entrySource: {system: 'ORACLE'}},
       "entrySource.system 'ORACLE' and no fullyQualifiedName"],
      // Dataplex rejects this prefix, and kcmd reads only postgresql:.
      [{fullyQualifiedName: 'postgres:host.db.public.orders'},
       "fullyQualifiedName 'postgres:host.db.public.orders'"],
    ] as const) {
      expect(await dialectOf(result)).toEqual({dialects: new Map(), databases: new Map(), errors: [
        `source '${THIRD_PARTY}': kcmd cannot tell the table's SQL dialect from ` +
        `its Knowledge Catalog entry, which has ${has}. kcmd reads the prefix ` +
        `of the entry's fullyQualifiedName (snowflake:, databricks:, mysql:, ` +
        `postgresql: or sqlserver:), or entrySource.system when there is no ` +
        `fullyQualifiedName.`,
      ]});
    }
  });

  // tests/tool/two_phase/third_party.test.ts holds the missing entry's text.
  test('is looked up once, by its entry name, and a missing entry is reported; with thirdParty false, not at all', async () => {
    const {catalog, calls} = fakeCatalog({});
    expect((await sourceDialects([THIRD_PARTY_FILE, THIRD_PARTY_FILE], catalog)).errors)
        .toEqual([expect.stringContaining(
            `source '${THIRD_PARTY}' names no table Knowledge Catalog knows about.`)]);
    expect(calls).toEqual([{project: 'acme', location: 'us-central1', name: THIRD_PARTY}]);
    expect(await sourceDialects([THIRD_PARTY_FILE], catalog, {thirdParty: false}))
        .toEqual({dialects: new Map(), databases: new Map(), errors: []});
    expect(calls).toHaveLength(1);
  });
});

describe('sourcesToLookUp', () => {
  test('collects Cloud SQL resource names, and third-party entry names written as a source, from YAML values, GOOGLE-block JSON and profile files, not from comments', () => {
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
    source: "${POSTGRES}"
  - name: lines
    source: ${THIRD_PARTY}
  - name: items
    source: projects/acme/locations/us/entryGroups/@bigquery/entries/items
`;
    expect(sourcesToLookUp([model, vanilla, profile]).sort())
        .toEqual([POSTGRES, MYSQL, SQLSERVER, THIRD_PARTY].sort());
    // An entry name that is not a source, such as one in ai_context or in
    // another vendor's block, is not collected.
    expect(sourcesToLookUp([`version: "0.2.0.dev0"
semantic_model:
  - name: shop
    description: ${THIRD_PARTY}
    custom_extensions:
      - vendor_name: ACME
        data: '{"glossary": "${THIRD_PARTY}"}'
    datasets:
      - name: orders
        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders
        ai_context: {synonyms: ["${THIRD_PARTY}"]}
`])).toEqual([]);
    // A file that does not parse collects nothing, even a name it holds.
    expect(sourcesToLookUp([`source: ${MYSQL}\nname: [unclosed`])).toEqual([]);
    // Nor does one whose values cannot be read, and that does not throw: an
    // alias whose anchor is not set.
    expect(sourcesToLookUp([`source: ${MYSQL}\nother: *missing\n`])).toEqual([]);
    // Nor does an alias that refers to itself, whose values are cyclic, stop
    // it; the other files are still read.
    expect(sourcesToLookUp([`a: &a [*a]\nsource: ${MYSQL}\n`, `source: ${POSTGRES}\n`]))
        .toEqual([POSTGRES]);
    // A tag kcmd does not resolve is read as the loader reads it: a !!set
    // stays a plain mapping, so its values are walked.
    expect(sourcesToLookUp([`tables: !!set\n  orders: ${MYSQL}\n`])).toEqual([MYSQL]);
  });
});
