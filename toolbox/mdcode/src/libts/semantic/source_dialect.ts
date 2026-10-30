// The dialect of a Cloud SQL table written as its resource name, or of a
// third-party table written as its entry name, read from the table's
// Knowledge Catalog entry.
//
// The resource name cannot say the dialect: a MySQL table has no schema, but a
// PostgreSQL table and a SQL Server table have the same shape. Dataplex keeps an
// entry for each table of an instance with Dataplex integration on, in the
// system entry group `@cloudsql`, and the entry's id is the table's resource
// name. Its entry type names the engine.
//
// A third-party table's entry names its system twice: in the prefix of its
// fullyQualifiedName, which Dataplex checks, and in entrySource.system, which
// is free text. So the prefix decides, and the system only when the entry has
// no fullyQualifiedName. Dataplex also checks the rest of the
// fullyQualifiedName, so its parts say whether the entry is a table's or, for
// example, a schema's.
//
// This is the only place kcmd makes a network call to learn a dialect. A
// command looks every such source up once, before it loads the model, and
// passes the dialects to the load (LoadOptions.sourceDialects).

import * as yaml from 'yaml';

import {catalogNameSegments, CloudSqlTable, cloudSqlTableOf, DIALECT_OF_FQN_PREFIX, isGoogleVendor, ThirdPartyEntry, thirdPartyEntryOf} from './loader';
import {EntryLookup, lookupSystemEntry, read} from './catalog_entry';
import {YAML_OPTIONS} from './yaml_options';

// The dialect each Cloud SQL table or view entry type gives.
const DIALECT_OF_ENTRY_TYPE: Record<string, string> = {
  'cloudsql-mysql-table': 'MYSQL',
  'cloudsql-mysql-view': 'MYSQL',
  'cloudsql-postgresql-table': 'POSTGRES',
  'cloudsql-postgresql-view': 'POSTGRES',
  'cloudsql-sqlserver-table': 'SQLSERVER',
  'cloudsql-sqlserver-view': 'SQLSERVER',
};

// The dialect each entrySource.system gives, in lower case.
const DIALECT_OF_ENTRY_SYSTEM =
    new Map([...DIALECT_OF_FQN_PREFIX, ['postgres', 'POSTGRES']]);

// The parts of a table's fullyQualifiedName after each prefix, as Dataplex
// reads it. A view's name has the same parts as a table's.
const TABLE_FQN_PARTS = new Map([
  ['snowflake', ['account', 'database', 'schema', 'table']],
  ['databricks', ['metastore', 'catalog', 'schema', 'table']],
  ['mysql', ['host', 'schema', 'table']],
  ['postgresql', ['host', 'database', 'schema', 'table']],
  ['sqlserver', ['host', 'database', 'schema', 'table']],
]);

export interface SourceDialects {
  // Each source, keyed as dialectLookupKey gives, and its dialect.
  dialects: Map<string, string>;
  // Each third-party table whose entry has a fullyQualifiedName, keyed by
  // entry name, and the database that name gives (see databaseOfFqn).
  databases: Map<string, string>;
  // One message per source whose dialect could not be read.
  errors: string[];
}

// A table's dialect and, for a third-party table, its database, or why kcmd
// cannot tell the dialect.
type Dialect = {dialect: string; database?: string}|{error: string};

// Looks up the dialect of every Cloud SQL and third-party table the model and
// profile files `texts` write (see sourcesToLookUp), once per table, in
// parallel. With `thirdParty` false, looks up Cloud SQL tables only. Makes no
// call when they write none. Never throws: a lookup that fails is reported in
// `errors`.
export async function sourceDialects(
    texts: Iterable<string>, catalog: EntryLookup,
    {thirdParty = true} = {}): Promise<SourceDialects> {
  // Keyed as dialectLookupKey gives, so both spellings of one table are one
  // lookup.
  const lookups = new Map<string, () => Promise<Dialect>>();
  for (const source of sourcesToLookUp(texts)) {
    const table = cloudSqlTableOf(source);
    if (table) {
      lookups.set(table.resourceName, () => cloudSqlDialect(catalog, table));
    }
    const entry = thirdParty ? thirdPartyEntryOf(source) : undefined;
    if (entry) lookups.set(entry.name, () => thirdPartyDialect(catalog, entry));
  }
  const dialects = new Map<string, string>();
  const databases = new Map<string, string>();
  const errors: string[] = [];
  await Promise.all([...lookups].map(async ([key, lookUp]) => {
    const got = await lookUp();
    if ('error' in got) errors.push(got.error);
    else dialects.set(key, got.dialect);
    if ('database' in got && got.database) databases.set(key, got.database);
  }));
  errors.sort();
  return {dialects, databases, errors};
}

// The dialect of a Cloud SQL table, by its entry's type.
async function cloudSqlDialect(
    catalog: EntryLookup, table: CloudSqlTable): Promise<Dialect> {
  const at = `source '${table.resourceName}'`;
  const res = await lookupSystemEntry(
      catalog, 'cloudsql', table.project, table.location, table.resourceName);
  if ('error' in res) return {error: `${at}: ${res.error}`};
  // Dataplex answers 403 both when the entry does not exist and when the
  // caller may not read it, so the message names both causes.
  if ('unreadable' in res) {
    return {
      error: `${at}: kcmd reads a Cloud SQL table's dialect from its ` +
          `Knowledge Catalog entry, and could not read it. Turn on Dataplex ` +
          `integration for instance '${table.instance}' (gcloud sql ` +
          `instances patch ${table.instance} --enable-dataplex-integration ` +
          `--project ${table.project}) and wait for the table to appear in ` +
          `the catalog, or check that you can read the table. If integration ` +
          `is on, check the name: the project ID, the instance's region, and ` +
          `a schema only for PostgreSQL and SQL Server.`,
    };
  }
  // The type comes back as a full name; its last part says the engine.
  const type = (res.result.entryType ?? '').split('/').pop() ?? '';
  const dialect = DIALECT_OF_ENTRY_TYPE[type];
  return dialect ? {dialect} : {
    error: `${at}: its Knowledge Catalog entry has type '${type}', which is ` +
        `not a Cloud SQL table or view type kcmd knows (${
               Object.keys(DIALECT_OF_ENTRY_TYPE).join(', ')}).`,
  };
}

// The dialect of a third-party table, by its entry's fullyQualifiedName or
// entrySource.system, and the database the fullyQualifiedName names. An entry
// whose fullyQualifiedName names no table or view is rejected.
async function thirdPartyDialect(
    catalog: EntryLookup,
    {project, location, name}: ThirdPartyEntry): Promise<Dialect> {
  const at = `source '${name}'`;
  const res = await read(
      'looking up its Knowledge Catalog entry',
      () => catalog.lookupEntry(project, location, name));
  if ('error' in res) return {error: `${at}: ${res.error}`};
  if ('unreadable' in res) {
    return {
      error: `${at} names no table Knowledge Catalog knows about. The entry ` +
          `may not exist, or you may not be allowed to read it. kcmd reads a ` +
          `third-party table's dialect from its entry, so add the table to ` +
          `Knowledge Catalog, or fix the source.`,
    };
  }
  const {fullyQualifiedName: fqn, entrySource} = res.result;
  const system = entrySource?.system;
  const prefix = fqn?.match(/^([a-z]+):/)?.[1] ?? '';
  const dialect = fqn ? DIALECT_OF_FQN_PREFIX.get(prefix) :
                        DIALECT_OF_ENTRY_SYSTEM.get(system?.toLowerCase() ?? '');
  if (dialect && fqn) {
    const database = databaseOfFqn(fqn);
    if (database) return {dialect, database};
    const parts = TABLE_FQN_PARTS.get(prefix)!.map(p => `<${p}>`).join('.');
    return {
      error: `${at}: its Knowledge Catalog entry has fullyQualifiedName ` +
          `'${fqn}', which names no table or view. A table's ` +
          `fullyQualifiedName has the form ${prefix}:${parts}. Write the ` +
          `entry name of the table's own entry.`,
    };
  }
  if (dialect) return {dialect};
  const has = fqn ? `fullyQualifiedName '${fqn}'` :
      system ? `entrySource.system '${system}' and no fullyQualifiedName` :
               'neither a fullyQualifiedName nor an entrySource.system';
  return {
    error: `${at}: kcmd cannot tell the table's SQL dialect from its ` +
        `Knowledge Catalog entry, which has ${has}. kcmd reads the prefix of ` +
        `the entry's fullyQualifiedName (snowflake:, databricks:, mysql:, ` +
        `postgresql: or sqlserver:), or entrySource.system when there is no ` +
        `fullyQualifiedName.`,
  };
}

// The prefix of the fullyQualifiedName `fqn` of a third-party table or view,
// and the parts after it, unquoted, such as `snowflake` and ['acme', 'retail',
// 'public', 'orders'] for `snowflake:acme.retail.public.orders`. Undefined
// when `fqn` names no table or view. Such a name has another number of parts
// than TABLE_FQN_PARTS gives, or a subtype, such as the `routine:` of a
// routine. Dataplex reads a `databricks:table:` or `databricks:view:` name as
// the same table as the `databricks:` name.
export function tableFqnParts(fqn: string):
    {prefix: string; parts: string[]}|undefined {
  // The subtype holds no backtick, so a colon inside a quoted host and port
  // stays in the path. A colon in an unquoted database, schema or table
  // name stays in its segment when it comes after the name's first backtick.
  const [, prefix, subtype, path] =
      fqn.match(/^([a-z]+):(?:([a-z0-9_-]+):)?(.*)$/s) ?? [];
  const names = TABLE_FQN_PARTS.get(prefix ?? '');
  const parts = catalogNameSegments(path ?? '', true);
  const tableSubtype = subtype === undefined ||
      (prefix === 'databricks' && (subtype === 'table' || subtype === 'view'));
  if (!names || !tableSubtype || parts.length !== names.length) {
    return undefined;
  }
  return {prefix, parts};
}

// The database the fullyQualifiedName `fqn` of a third-party table or view
// names: a Snowflake account, a MySQL or SQL Server host, a PostgreSQL host
// and database, or a Databricks metastore. Each account and host is in lower
// case. Undefined when `fqn` names no table or view.
function databaseOfFqn(fqn: string): string|undefined {
  const table = tableFqnParts(fqn);
  if (!table) return undefined;
  const {prefix, parts} = table;
  const n = prefix === 'postgresql' ? 2 : 1;
  // A Snowflake account and a host name ignore letter case.
  if (prefix !== 'databricks') parts[0] = parts[0].toLowerCase();
  return [prefix, ...parts.slice(0, n)].join('/');
}

// Every Cloud SQL table and third-party entry the model and profile files
// `texts` write. A Cloud SQL table counts as a resource name or resource URI
// anywhere, JSON strings included. An entry name counts as a `source` value in
// the YAML or in a GOOGLE block's JSON `data`, unless it sits in ai_context,
// an action parameter's default or another vendor's block. Values are read
// from the parsed YAML, so a name in a comment is not collected. A file that
// does not parse collects nothing; the load reports it.
export function sourcesToLookUp(texts: Iterable<string>): string[] {
  const found = new Set<string>();
  // `key` names the member that holds `value`. `opaque` marks a value whose
  // `source` names no table: one inside ai_context, an action parameter's
  // default or another vendor's block, or in JSON written anywhere but a
  // `data` member.
  const visit = (value: unknown, key?: string, opaque = false): void => {
    if (typeof value === 'string') {
      if (cloudSqlTableOf(value) ||
          (key === 'source' && !opaque && thirdPartyEntryOf(value))) {
        found.add(value.trim());
      } else if (/^\s*[[{]/.test(value)) {
        try {
          visit(JSON.parse(value), undefined, opaque || key !== 'data');
        } catch {
          // Not JSON: an ordinary string.
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(v => visit(v, undefined, opaque));
    } else if (value && typeof value === 'object') {
      const vendor =
          'vendor_name' in value && !isGoogleVendor(value.vendor_name);
      for (const [k, v] of Object.entries(value)) {
        visit(v, k, opaque || vendor || k === 'ai_context' || k === 'default');
      }
    }
  };
  for (const text of texts) {
    // Parsed as the loader parses, so both read the same values.
    for (const doc of yaml.parseAllDocuments(text, YAML_OPTIONS)) {
      if (doc.errors.length) continue;
      // Reading the values can still fail: on an alias whose anchor is not
      // set, on more aliases than a load expands, or, while walking them, on
      // an alias that refers to itself, which makes the values cyclic. The
      // load reports that file in its own words, so the rest of it is skipped
      // here rather than stopping the command.
      try {
        visit(doc.toJS());
      } catch {
        continue;
      }
    }
  }
  return [...found];
}
