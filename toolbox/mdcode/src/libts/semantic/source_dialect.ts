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
// no fullyQualifiedName.
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

export interface SourceDialects {
  // Each source, keyed as dialectLookupKey gives, and its dialect.
  dialects: Map<string, string>;
  // Each third-party table whose entry's fullyQualifiedName names its
  // database, keyed by entry name, and that database (see databaseOfFqn).
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
// entrySource.system, and the database the fullyQualifiedName names.
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
  const dialect = fqn ?
      DIALECT_OF_FQN_PREFIX.get(fqn.split(':')[0]) :
      DIALECT_OF_ENTRY_SYSTEM.get(system?.toLowerCase() ?? '');
  if (dialect) return {dialect, database: fqn && databaseOfFqn(fqn)};
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

// The database a third-party table's fullyQualifiedName `fqn` names: a
// Snowflake account, a Databricks metastore, a MySQL or SQL Server host, or a
// PostgreSQL host and database. A Databricks name may carry the subtype
// `table:`. Undefined when the name has too few segments to tell.
function databaseOfFqn(fqn: string): string|undefined {
  const [, prefix, path] = fqn.match(/^([a-z]+):(?:table:)?(.*)$/) ?? [];
  const seg = catalogNameSegments(path ?? '');
  const n = prefix === 'postgresql' ? 2 : 1;
  return seg.length > n ? [prefix, ...seg.slice(0, n)].join('/') : undefined;
}

// Every Cloud SQL table written as a resource name or resource URI anywhere in
// the model and profile files `texts`, and every third-party entry name written
// as a `source` value, unless it sits in ai_context or in another vendor's
// custom_extensions block. The JSON of a GOOGLE block is read too. Values are
// read from the parsed YAML, so a name in a comment is not collected. A file
// that does not parse collects nothing; the load reports it.
export function sourcesToLookUp(texts: Iterable<string>): string[] {
  const found = new Set<string>();
  // `key` names the member that holds `value`. `opaque` marks a value inside
  // ai_context or another vendor's block, whose `source` names no table.
  const visit = (value: unknown, key?: string, opaque = false): void => {
    if (typeof value === 'string') {
      if (cloudSqlTableOf(value) ||
          (key === 'source' && !opaque && thirdPartyEntryOf(value))) {
        found.add(value.trim());
      } else if (/^\s*[[{]/.test(value)) {
        try {
          visit(JSON.parse(value), undefined, opaque);
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
        visit(v, k, opaque || vendor || k === 'ai_context');
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
