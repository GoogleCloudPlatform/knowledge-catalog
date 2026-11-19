// Tests for src/libts/semantic/source_dialect.ts: a Cloud SQL or third-party
// table's dialect read from its Knowledge Catalog entry, and a Spanner
// database's dialect. The catalog and Spanner are faked; nothing here calls a
// service.

import {describe, expect, test} from 'bun:test';

import {ApiResult} from '../../../src/libts/gcp/api';
import {CatalogClient} from '../../../src/libts/gcp/dataplex';
import {EntryLookup} from '../../../src/libts/semantic/catalog_entry';
import {dialectErrors, sourceDialects, sourcesToLookUp} from '../../../src/libts/semantic/source_dialect';
import {entryDenied} from '../gcp/location_responses';

const INSTANCE = 'cloudsql.googleapis.com/projects/acme/locations/us-central1/instances';
const MYSQL = `${INSTANCE}/shop/databases/sales/tables/orders`;
const POSTGRES = `${INSTANCE}/pg/databases/shop/schemas/sales/tables/orders`;
const POSTGRES_VIEW = `${INSTANCE}/pg/databases/shop/schemas/sales/tables/open_orders`;
const SQLSERVER = `${INSTANCE}/ms/databases/shop/schemas/sales/tables/orders`;
const THIRD_PARTY = 'projects/acme/locations/us-central1/entryGroups/sf/entries/orders';
const SPANNER = 'spanner.googleapis.com/projects/acme/instances/ops/databases';
// A file that binds THIRD_PARTY, which is collected only as a source.
const THIRD_PARTY_FILE = `source: ${THIRD_PARTY}`;
// What Dataplex says when its API is off in the project the call is billed
// to, and that answer, by default for every lookup. Dataplex's generic denial,
// which every other entry gives, is not quoted.
const DISABLED = 'Cloud Dataplex API has not been used in project 123 before or it is ' +
    'disabled. Enable it by visiting https://console.developers.google.com/apis/api/' +
    'dataplex.googleapis.com/overview?project=123 then retry.';
const disabled = (message = DISABLED) => ({status: 403, message});

// A catalog that answers from `answers`, keyed by entry name, and records each
// call, with its options when it has any. An entry it does not know gets the
// 403 Dataplex gives a missing entry.
function fakeCatalog(answers: Record<string, ApiResult<object>>) {
  const calls: Array<{project: string; location: string; name: string; opts?: object}> = [];
  const catalog: EntryLookup = {
    async lookupEntry(project, location, name, opts) {
      calls.push({project, location, name, ...opts && {opts}});
      return answers[name] ?? entryDenied(name);
    },
  };
  return {catalog, calls};
}
const entryName = (resourceName: string) =>
    `projects/acme/locations/us-central1/entryGroups/@cloudsql/entries/${resourceName}`;
const typed = (type: string): ApiResult<{entryType?: string}> =>
    ({status: 200, result: {entryType: `projects/dataplex-types/locations/global/entryTypes/${type}`}});
// The entry of an instance whose cloudsql-instance aspect says whether
// Dataplex integration is on. The instance runs `engine`, SQL Server by
// default, and the aspect's key names its type's project `project`.
const integration = (enabled: boolean, {project = 'dataplex-types', engine = 'sqlserver'} = {}):
    ApiResult<object> => {
  const instance = typed(`cloudsql-${engine}-instance`);
  return {...instance, result: {
    ...instance.result,
    aspects: {[`${project}.global.cloudsql-instance`]: {data: {dataplexEnabled: enabled}}},
  }};
};
// What a command gets for `texts`, each the text of a model file that messages
// label 'sales': each dialect and database, and each message (see
// dialectErrors).
async function read(texts: string[], ...lookup: [EntryLookup, Parameters<typeof sourceDialects>[2]?]) {
  const got = await sourceDialects(texts, ...lookup);
  return {
    dialects: got.dialects, databases: got.databases,
    ...dialectErrors(texts.map(text => ({label: 'sales', text})), got),
  };
}

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
        await read([MYSQL, POSTGRES, POSTGRES_VIEW, SQLSERVER], catalog);
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
    expect((await read([POSTGRES], catalog)).dialects.get(POSTGRES)).toBe('POSTGRES');
  });

  test('each table is looked up once', async () => {
    const {catalog, calls} = fakeCatalog({[entryName(MYSQL)]: typed('cloudsql-mysql-table')});
    const {dialects} = await read([MYSQL, MYSQL], catalog);
    expect(calls).toHaveLength(1);
    expect(dialects).toEqual(new Map([[MYSQL, 'MYSQL']]));
  });

  test('other sources are not looked up', async () => {
    const {catalog, calls} = fakeCatalog({});
    const {dialects, errors} = await read([
      'bigquery.googleapis.com/projects/p/datasets/d/tables/t',
    ], catalog);
    expect(calls).toEqual([]);
    expect(dialects.size).toBe(0);
    expect(errors).toEqual([]);
  });

  // [label, the table, the type of each entry the catalog has, or its answer,
  // keyed by its resource name, the parts looked up after the table, what the
  // message says after the table's name]. Every other entry answers 403.
  const MS = `${INSTANCE}/ms`;
  const PG = `${INSTANCE}/pg`;
  const SHOP = `${INSTANCE}/shop`;
  const NO_TABLE = 'names no table Knowledge Catalog knows about.';
  const NO_INSTANCE = `${NO_TABLE} Knowledge Catalog has no entry you may read for its ` +
      "instance 'ms' in project 'acme' and region 'us-central1'. The project ID, the region " +
      "or the instance name may be wrong, or you may not be allowed to read the instance's " +
      'entry. Check the source and your access.';
  const NO_DATABASE = `${NO_TABLE} Instance 'ms' is in the catalog, but database 'shop' is ` +
      'not. The database may not exist, or it may be too new to be in the catalog yet. Check ' +
      'the database name.';
  // A denial that names the permission it needs.
  const NAMED = "Permission 'dataplex.aspectTypes.use' denied on resource '//dataplex." +
      "googleapis.com/projects/dataplex-types/locations/global/aspectTypes/cloudsql-instance'.";
  test.each([
    ['no instance', SQLSERVER, {}, [MS], NO_INSTANCE],
    ['the Dataplex API off', SQLSERVER, {[SQLSERVER]: disabled(), [MS]: disabled()}, [MS],
     `${NO_INSTANCE} Dataplex said: ${DISABLED}`],
    ['a denial of the instance that names its permission', SQLSERVER,
     {[MS]: {status: 403, message: NAMED}}, [MS], `${NO_INSTANCE} Dataplex said: ${NAMED}`],
    // The text is quoted on one line.
    ['the Dataplex API off at the database, in a text of two lines', SQLSERVER,
     {[MS]: 'cloudsql-sqlserver-instance',
      [`${MS}/databases/shop`]: disabled(DISABLED.replace(' Enable', '\n  Enable'))},
     [MS, `${MS}/databases/shop`], `${NO_DATABASE} Dataplex said: ${DISABLED}`],
    ['Dataplex integration off', SQLSERVER, {[MS]: integration(false, {project: '655216118709'})}, [MS],
     `${NO_TABLE} Dataplex integration is off for instance 'ms'. Turn it on with 'gcloud sql ` +
     "instances patch ms --enable-dataplex-integration --project acme' and wait for the " +
     'table to appear in the catalog.'],
    ...[['Dataplex integration on', integration(true)],
        ['no word on Dataplex integration', typed('cloudsql-sqlserver-instance')]].map(
        ([label, answer]) => [`no database, ${label}`, SQLSERVER, {[MS]: answer},
                              [MS, `${MS}/databases/shop`], NO_DATABASE]),
    ['no schema', SQLSERVER,
     {[MS]: 'cloudsql-sqlserver-instance', [`${MS}/databases/shop`]: 'cloudsql-sqlserver-database'},
     [MS, `${MS}/databases/shop`, `${MS}/databases/shop/schemas/sales`],
     `${NO_TABLE} Database 'shop' is in the catalog, but schema 'sales' is not. The schema ` +
     'may not exist, or it may be too new to be in the catalog yet. Check the schema name.'],
    ['every part of a table in a schema', SQLSERVER,
     {[MS]: 'cloudsql-sqlserver-instance', [`${MS}/databases/shop`]: 'cloudsql-sqlserver-database',
      [`${MS}/databases/shop/schemas/sales`]: 'cloudsql-sqlserver-schema'},
     [MS, `${MS}/databases/shop`, `${MS}/databases/shop/schemas/sales`],
     `${NO_TABLE} Its instance, database and schema are in the catalog. The table may not ` +
     'exist, or it may be too new to be in the catalog yet. Check the table name, or create ' +
     'the table.'],
    ['every part of a table in a schema, with the Dataplex API off at the table', SQLSERVER,
     {[SQLSERVER]: disabled(), [MS]: 'cloudsql-sqlserver-instance',
      [`${MS}/databases/shop`]: 'cloudsql-sqlserver-database',
      [`${MS}/databases/shop/schemas/sales`]: 'cloudsql-sqlserver-schema'},
     [MS, `${MS}/databases/shop`, `${MS}/databases/shop/schemas/sales`],
     `${NO_TABLE} Its instance, database and schema are in the catalog. The table may not ` +
     'exist, or it may be too new to be in the catalog yet. Check the table name, or create ' +
     `the table. Dataplex said: ${DISABLED}`],
    ['every part of a MySQL table', MYSQL,
     {[SHOP]: 'cloudsql-mysql-instance', [`${SHOP}/databases/sales`]: 'cloudsql-mysql-database'},
     [SHOP, `${SHOP}/databases/sales`],
     `${NO_TABLE} Its instance and database are in the catalog. The table may not exist, or ` +
     'it may be too new to be in the catalog yet. Check the table name, or create the table.'],
    ['a schema on a MySQL instance', POSTGRES, {[PG]: 'cloudsql-mysql-instance'}, [PG],
     `${NO_TABLE} Instance 'pg' runs MySQL, which has no schemas. Remove 'schemas/sales/' ` +
     'from the source.'],
    ['no schema on a PostgreSQL instance', MYSQL, {[SHOP]: 'cloudsql-postgresql-instance'}, [SHOP],
     `${NO_TABLE} Instance 'shop' runs PostgreSQL, so a table's name includes its schema. ` +
     "Add 'schemas/<schema>/' before 'tables/' in the source, such as 'schemas/public/' for " +
     'the default schema.'],
    // The name is wrong whether or not integration is on, so it is named first.
    ['no schema on a SQL Server instance with Dataplex integration off',
     `${MS}/databases/shop/tables/orders`, {[MS]: integration(false)}, [MS],
     `${NO_TABLE} Instance 'ms' runs SQL Server, so a table's name includes its schema. ` +
     "Add 'schemas/<schema>/' before 'tables/' in the source, such as 'schemas/dbo/' for " +
     'the default schema.'],
    ['a schema on a MySQL instance with Dataplex integration off', POSTGRES,
     {[PG]: integration(false, {engine: 'mysql'})}, [PG],
     `${NO_TABLE} Instance 'pg' runs MySQL, which has no schemas. Remove 'schemas/sales/' ` +
     'from the source.'],
    // An instance type kcmd does not know names no engine, so the name is not
    // checked against one.
    ['no database on an instance of another type', `${MS}/databases/shop/tables/orders`,
     {[MS]: 'cloudsql-oracle-instance'}, [MS, `${MS}/databases/shop`], NO_DATABASE],
  ] as Array<[string, string, Record<string, string|ApiResult<object>>, string[], string]>)(
      'a table the catalog has no entry for, as a read that failed: %s',
      async (_, table, types, looked, says) => {
        const {catalog, calls} = fakeCatalog(Object.fromEntries(Object.entries(types).map(
            ([name, type]) => [entryName(name), typeof type === 'string' ? typed(type) : type])));
        const {dialects, errors, unread} = await read([table], catalog);
        expect(dialects.size).toBe(0);
        expect(unread).toEqual(errors);
        expect(errors).toEqual([`[sales] source '${table}' ${says}`]);
        // Each part is looked up in turn, in the table's project and location,
        // and the instance with its cloudsql-instance aspect.
        const aspects = ['projects/dataplex-types/locations/global/aspectTypes/cloudsql-instance'];
        expect(calls).toEqual([table, ...looked].map(name => ({
          project: 'acme', location: 'us-central1', name: entryName(name),
          ...name.split('/').at(-2) === 'instances' && {opts: {aspects}},
        })));
      });

  test('a part the catalog fails to answer for is named', async () => {
    const failing = (part: string): EntryLookup => ({
      async lookupEntry(_p, _l, name) {
        if (name.endsWith(`/${part}`)) throw new Error('socket hang up');
        if (name.endsWith('/instances/ms')) return typed('cloudsql-sqlserver-instance');
        if (name.endsWith('/databases/shop')) {
          return {status: 500, message: 'Internal error.\nTry again.'};
        }
        return entryDenied(name);
      },
    });
    const says = async (part: string) => (await read([SQLSERVER], failing(part))).errors;
    expect(await says('instances/ms')).toEqual([`[sales] source '${SQLSERVER}' ${NO_TABLE} ` +
        "kcmd could not tell why: looking up the catalog entry of instance 'ms' failed: socket hang up"]);
    // A message of two lines is printed on one.
    expect(await says('nothing')).toEqual([`[sales] source '${SQLSERVER}' ${NO_TABLE} ` +
        "kcmd could not tell why: looking up the catalog entry of database 'shop' failed (HTTP 500: " +
        'Internal error. Try again.).']);
  });

  // A Spanner table's message names every file that writes a table of its
  // database, and the first such table. No file here writes SQLSERVER, so its
  // message is left out.
  test('each message labels every file that writes its source, once, in file order', async () => {
    const files = [
      {label: 'sales', text: `a: //${POSTGRES}\nb: ${POSTGRES}\nsource: //${SPANNER}/x/tables/t\n`},
      {label: 'sales.profile.pg.yaml', text: `source: //${POSTGRES}\n`},
      {label: 'sales.profile.sf.yaml', text: `${THIRD_PARTY_FILE}\n`},
      {label: 'ops', text: `source: ${SPANNER}/x/tables/u\n`},
    ];
    const spanner = {getDatabase: async () => ({status: 403, message: 'Permission denied.'})};
    const got = await sourceDialects(
        [...files.map(f => f.text), SQLSERVER], fakeCatalog({}).catalog, {spanner});
    // A source written as a resource URI is named by its resource name.
    expect(dialectErrors(files, got).errors.map(e => e.match(/^\[.*?\] source '.*?'/)![0])).toEqual([
      `[sales, ops] source '${SPANNER}/x/tables/t'`,
      `[sales, sales.profile.pg.yaml] source '${POSTGRES}'`,
      `[sales.profile.sf.yaml] source '${THIRD_PARTY}'`,
    ]);
    expect(dialectErrors(files.slice(3), got).errors).toEqual([`[ops] source '${SPANNER}/x/tables/u': ` +
        "kcmd reads its Spanner database's SQL dialect, and could not read database acme/ops/x: " +
        'Permission denied.']);
  });

  test('tables that share an instance, database and schema look each up once', async () => {
    const {catalog, calls} = fakeCatalog({
      [entryName(MS)]: typed('cloudsql-sqlserver-instance'),
      [entryName(`${MS}/databases/shop`)]: typed('cloudsql-sqlserver-database'),
    });
    const {errors} = await read([SQLSERVER, `${SQLSERVER}_2`], catalog);
    expect(errors).toHaveLength(2);
    expect(calls.map(c => c.name).sort()).toEqual([
      SQLSERVER, `${SQLSERVER}_2`, MS, `${MS}/databases/shop`, `${MS}/databases/shop/schemas/sales`,
    ].map(entryName).sort());
  });

  test('an entry of another type is reported with its type, as an entry that was read', async () => {
    const {catalog} = fakeCatalog({[entryName(MYSQL)]: typed('cloudsql-mysql-database')});
    const {errors, unread} = await read([MYSQL], catalog);
    expect(unread).toEqual([]);
    expect(errors).toEqual([
      `[sales] source '${MYSQL}': its Knowledge Catalog entry has type ` +
      `'cloudsql-mysql-database', which is not a Cloud SQL table or view type ` +
      `kcmd knows (cloudsql-mysql-table, cloudsql-mysql-view, ` +
      `cloudsql-postgresql-table, cloudsql-postgresql-view, ` +
      `cloudsql-sqlserver-table, cloudsql-sqlserver-view).`,
    ]);
  });

  test('another failure is a read that failed, reported with its status, a thrown error does not escape, and a Spanner database\'s error names its first table', async () => {
    const failing: EntryLookup = {
      async lookupEntry(_p, _l, name) {
        if (name.includes('/pg/')) return {status: 503, message: 'unavailable'};
        throw new Error('socket hang up');
      },
    };
    const spanner = {getDatabase: async () => { throw new Error('socket hang up'); }};
    const {errors, unread} = await read(
        [POSTGRES, MYSQL, THIRD_PARTY_FILE, `source: ${SPANNER}/x/tables/t`,
         `source: ${SPANNER}/x/tables/u`],
        failing, {spanner});
    expect(unread).toEqual(errors);
    // Sorted, so the order does not depend on which lookup answers first.
    expect(errors).toEqual([
      `[sales] source '${POSTGRES}': looking up its Knowledge Catalog entry failed (HTTP 503: unavailable).`,
      `[sales] source '${MYSQL}': looking up its Knowledge Catalog entry failed: socket hang up`,
      `[sales] source '${THIRD_PARTY}': looking up its Knowledge Catalog entry failed: socket hang up`,
      `[sales] source '${SPANNER}/x/tables/t': kcmd reads its Spanner database's SQL ` +
      'dialect, and could not read database acme/ops/x: socket hang up',
    ]);
  });

  test('reads each Spanner database once, POSTGRESQL as POSTGRES and any other as SPANNER, and gives SPANNER with no client', async () => {
    const calls: string[] = [];
    const spanner = {async getDatabase(project: string, instance: string, database: string) {
      calls.push(`${project}/${instance}/${database}`);
      const dialect = {pg: 'POSTGRESQL', gsql: 'GOOGLE_STANDARD_SQL'}[database];
      return {status: 200, result: dialect ? {databaseDialect: dialect} : {}};
    }};
    const files = ['pg/tables/a', 'pg/tables/ops.b', 'gsql/tables/a', 'old/tables/a']
                      .map(t => `source: ${SPANNER}/${t}`);
    const {dialects, errors} = await read(files, fakeCatalog({}).catalog, {spanner});
    expect({dialects, errors}).toEqual({errors: [], dialects: new Map([
      [`${SPANNER}/pg`, 'POSTGRES'], [`${SPANNER}/gsql`, 'SPANNER'], [`${SPANNER}/old`, 'SPANNER']])});
    expect(calls.sort()).toEqual(['acme/ops/gsql', 'acme/ops/old', 'acme/ops/pg']);
    expect((await read(files, fakeCatalog({}).catalog)).dialects).toEqual(new Map(
        ['pg', 'gsql', 'old'].map(db => [`${SPANNER}/${db}`, 'SPANNER'])));
  });

  test('the catalog client provides the lookup', () => {
    // Compile-time check: CatalogClient fits EntryLookup.
    const fits = (c: CatalogClient): EntryLookup => c;
    expect(typeof fits).toBe('function');
  });
});

// A third-party table's entry gives its dialect by the prefix of its
// fullyQualifiedName, or, with none, by its entrySource.system in any case.
// The fullyQualifiedName also names the table's database, and must name a
// table or view.
describe('sourceDialects of a third-party table', () => {
  const dialectOf = async (result: object) =>
      read([THIRD_PARTY_FILE], fakeCatalog({[THIRD_PARTY]: {status: 200, result}}).catalog);

  test('each fullyQualifiedName prefix and system gives its dialect, and the prefix wins', async () => {
    const fqn = (fullyQualifiedName: string) => ({fullyQualifiedName});
    const system = (s: string) => ({entrySource: {system: s}});
    const rows: Array<[object, string, string?]> = [
      [fqn('snowflake:acme.retail.public.orders'), 'SNOWFLAKE', 'snowflake/acme'],
      [fqn('snowflake:ACME.retail.public.orders'), 'SNOWFLAKE', 'snowflake/acme'],
      [fqn('databricks:table:1234.main.retail.orders'), 'DATABRICKS', 'databricks/1234'],
      [fqn('databricks:AB12.main.retail.orders'), 'DATABRICKS', 'databricks/AB12'],
      [fqn('databricks:view:1234.main.retail.orders_v'), 'DATABRICKS', 'databricks/1234'],
      [fqn('mysql:`HOST:3306`.sales.orders'), 'MYSQL', 'mysql/host:3306'],
      [fqn('postgresql:`DB.example.com`.Sales.public.orders'), 'POSTGRES',
       'postgresql/db.example.com/Sales'],
      [fqn('sqlserver:HOST.sales.dbo.orders'), 'SQLSERVER', 'sqlserver/host'],
      // Dataplex keeps a colon after the name's first backtick.
      [fqn('mysql:`h:3306`.sa:les.orders'), 'MYSQL', 'mysql/h:3306'],
      [fqn('postgresql:`db.example.com`.sales.:public.orders'), 'POSTGRES',
       'postgresql/db.example.com/sales'],
      // Dataplex keeps a line break inside a quoted name.
      [fqn('mysql:`h`.s.`t\nx`'), 'MYSQL', 'mysql/h'],
      [system('Snowflake'), 'SNOWFLAKE'],
      [system('DATABRICKS'), 'DATABRICKS'],
      [system('mysql'), 'MYSQL'],
      [system('PostgreSQL'), 'POSTGRES'],
      [system('POSTGRES'), 'POSTGRES'],
      [system('SQLSERVER'), 'SQLSERVER'],
      [{...fqn('snowflake:acme.retail.public.orders'), ...system('DATABRICKS')}, 'SNOWFLAKE',
       'snowflake/acme'],
    ];
    for (const [result, dialect, database] of rows) {
      expect({result, ...await dialectOf(result)}).toEqual({
        result, dialects: new Map([[THIRD_PARTY, dialect]]),
        databases: new Map(database ? [[THIRD_PARTY, database]] : []), errors: [], unread: [],
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
        `[sales] source '${THIRD_PARTY}': kcmd cannot tell the table's SQL dialect from ` +
        `its Knowledge Catalog entry, which has ${has}. kcmd reads the prefix ` +
        `of the entry's fullyQualifiedName (snowflake:, databricks:, mysql:, ` +
        `postgresql: or sqlserver:), or entrySource.system when there is no ` +
        `fullyQualifiedName.`,
      ], unread: []});
    }
  });

  test('an entry whose fullyQualifiedName names no table or view is rejected, naming the entry', async () => {
    const rows: Array<[string, string]> = [
      ['snowflake:acme.retail.public', 'snowflake:<account>.<database>.<schema>.<table>'],
      ['databricks:1234.main.retail', 'databricks:<metastore>.<catalog>.<schema>.<table>'],
      ['databricks:volume:1234.main.retail.files',
       'databricks:<metastore>.<catalog>.<schema>.<table>'],
      ['mysql:host.sales', 'mysql:<host>.<schema>.<table>'],
      ['postgresql:host.sales.public', 'postgresql:<host>.<database>.<schema>.<table>'],
      // Dataplex reads `pg.internal` as a subtype, since no backtick comes
      // before the colon.
      ['postgresql:pg.internal:5432.public.orders',
       'postgresql:<host>.<database>.<schema>.<table>'],
      ['sqlserver:host.sales.dbo', 'sqlserver:<host>.<database>.<schema>.<table>'],
    ];
    for (const [fullyQualifiedName, form] of rows) {
      expect(await dialectOf({fullyQualifiedName})).toEqual({dialects: new Map(), databases: new Map(), errors: [
        `[sales] source '${THIRD_PARTY}': its Knowledge Catalog entry has ` +
        `fullyQualifiedName '${fullyQualifiedName}', which names no table or ` +
        `view. A table's fullyQualifiedName has the form ${form}. Write the ` +
        `entry name of the table's own entry.`,
      ], unread: []});
    }
  });

  test('a missing entry ends with what Dataplex said, unless it is the generic denial', async () => {
    const says = async (answer: ApiResult<object>) =>
        (await read([THIRD_PARTY_FILE], fakeCatalog({[THIRD_PARTY]: answer}).catalog)).errors;
    const missing = `[sales] source '${THIRD_PARTY}' names no table Knowledge Catalog knows ` +
        'about. The entry may not exist, or you may not be allowed to read it. kcmd reads a ' +
        "third-party table's dialect from its entry, so add the table to Knowledge Catalog, " +
        'or fix the source.';
    expect(await says(disabled())).toEqual([`${missing} Dataplex said: ${DISABLED}`]);
    // The generic denial, here without its last period.
    const denial = entryDenied(THIRD_PARTY);
    expect(await says({...denial, message: denial.message.slice(0, -1)})).toEqual([missing]);
  });

  test('is looked up once, in its own project and location', async () => {
    const {catalog, calls} = fakeCatalog({});
    await read([THIRD_PARTY_FILE, THIRD_PARTY_FILE], catalog);
    expect(calls).toEqual([{project: 'acme', location: 'us-central1', name: THIRD_PARTY}]);
  });
});

describe('sourcesToLookUp', () => {
  test('collects Cloud SQL resource names, and Spanner tables and third-party entry names written as a source, from YAML values, GOOGLE-block JSON and profile files, not from comments', () => {
    const model = `version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    # source: ${INSTANCE}/commented/databases/x/tables/y
    entities:
      - name: orders
        source: ${MYSQL}
      - name: items
        source: bigquery.googleapis.com/projects/p/datasets/d/tables/items
      - name: lines
        source: ${SPANNER}/db/tables/lines
`;
    const vanilla = `version: "0.2.0.dev0"
semantic_model:
  - name: shop
    custom_extensions:
      - vendor_name: GOOGLE
        data: '${JSON.stringify({profiles: [{name: 'ms', entities: [
          {name: 'orders', source: SQLSERVER}, {name: 'lines', source: THIRD_PARTY}]}]})}'
`;
    const profile = `name: pg
entities:
  - name: orders
    source: "${POSTGRES}"
  - name: items
    source: projects/acme/locations/us/entryGroups/@bigquery/entries/items
`;
    expect(sourcesToLookUp([model, vanilla, profile]).sort())
        .toEqual([POSTGRES, MYSQL, SQLSERVER, THIRD_PARTY, `${SPANNER}/db/tables/lines`].sort());
    // A file whose only source is a BigQuery table collects nothing from an
    // entry name under another key, as a `source` in a description's JSON, or
    // as a `source` inside ai_context, an action parameter's default or another
    // vendor's block.
    expect(sourcesToLookUp([`source: bigquery.googleapis.com/projects/p/datasets/d/tables/t\n` +
        `description: '{"source": "${THIRD_PARTY}"}'\nsynonyms: ["${THIRD_PARTY}"]\n` +
        `ai_context: {custom: {lineage: [{source: ${THIRD_PARTY}}]}}\n` +
        `actions: [{name: a, parameters: [{name: p, default: {source: ${THIRD_PARTY}}}]}]\n` +
        `custom_extensions: [{vendor_name: ACME, data: '{"source": "${THIRD_PARTY}"}'}]\n`]))
        .toEqual([]);
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
    // A name with quotes is not looked up, since the loader rejects it.
    expect(sourcesToLookUp(['"orders"', '`orders`'].flatMap(q => [
      `source: '${MYSQL.replace('orders', q)}'\n`,
      `source: '${THIRD_PARTY.replace('orders', q)}'\n`,
      `source: '${SPANNER}/db/tables/${q}'\n`]))).toEqual([]);
  });
});
