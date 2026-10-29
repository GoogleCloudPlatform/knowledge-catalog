// The dialect of a Cloud SQL table written as its resource name
// (b/573288219), or of a third-party table written as its entry name, read
// from the table's Knowledge Catalog entry.
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

import {CloudSqlTable, cloudSqlTableOf, ThirdPartyEntry, thirdPartyEntryOf} from './loader';
import {EntryFields, EntryLookup, lookupSystemEntry, Read, read} from './catalog_entry';
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

// The dialect each fullyQualifiedName prefix of a third-party entry gives.
const DIALECT_OF_FQN_PREFIX = new Map([
  ['snowflake', 'SNOWFLAKE'], ['databricks', 'DATABRICKS'], ['mysql', 'MYSQL'],
  ['postgresql', 'POSTGRES'], ['sqlserver', 'SQLSERVER'],
]);
// The dialect each entrySource.system gives, in lower case.
const DIALECT_OF_ENTRY_SYSTEM =
    new Map([...DIALECT_OF_FQN_PREFIX, ['postgres', 'POSTGRES']]);

export interface SourceDialects {
  // Each source, keyed as dialectLookupKey gives, and its dialect.
  dialects: Map<string, string>;
  // One message per source whose dialect could not be read.
  errors: string[];
}

// How to read one table's entry, what to say when it cannot be read, and the
// dialect the entry gives or why it gives none.
interface DialectLookup {
  read: () => Promise<Read<EntryFields>>;
  unreadable: string;
  dialectOf: (entry: EntryFields) => {dialect: string}|{error: string};
}

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
  const lookups = new Map<string, DialectLookup>();
  for (const source of sourcesToLookUp(texts)) {
    const table = cloudSqlTableOf(source);
    if (table) lookups.set(table.resourceName, cloudSqlLookup(catalog, table));
    const entry = thirdParty ? thirdPartyEntryOf(source) : undefined;
    if (entry) lookups.set(entry.name, thirdPartyLookup(catalog, entry));
  }
  const dialects = new Map<string, string>();
  const errors: string[] = [];
  await Promise.all([...lookups].map(async ([key, lookup]) => {
    const res = await lookup.read();
    const got = 'error' in res ? {error: `source '${key}': ${res.error}`} :
        'unreadable' in res ? {error: lookup.unreadable} :
                              lookup.dialectOf(res.result);
    if ('error' in got) errors.push(got.error);
    else dialects.set(key, got.dialect);
  }));
  errors.sort();
  return {dialects, errors};
}

// The lookup of a Cloud SQL table's entry, by its type.
function cloudSqlLookup(
    catalog: EntryLookup, table: CloudSqlTable): DialectLookup {
  const at = `source '${table.resourceName}'`;
  return {
    read: () => lookupSystemEntry(
        catalog, 'cloudsql', table.project, table.location, table.resourceName),
    // Dataplex answers 403 both when the entry does not exist and when the
    // caller may not read it, so the message names both causes.
    unreadable:
        `${at}: kcmd reads a Cloud SQL table's dialect from its Knowledge ` +
        `Catalog entry, and could not read it. Turn on Dataplex ` +
        `integration for instance '${table.instance}' (gcloud sql ` +
        `instances patch ${table.instance} --enable-dataplex-integration ` +
        `--project ${table.project}) and wait for the table to appear in ` +
        `the catalog, or check that you can read the table. If integration ` +
        `is on, check the name: the project ID, the instance's region, and ` +
        `a schema only for PostgreSQL and SQL Server.`,
    dialectOf: ({entryType}) => {
      // The type comes back as a full name; its last part says the engine.
      const type = (entryType ?? '').split('/').pop() ?? '';
      const dialect = DIALECT_OF_ENTRY_TYPE[type];
      return dialect ? {dialect} : {
        error: `${at}: its Knowledge Catalog entry has type '${type}', which ` +
            `is not a Cloud SQL table or view type kcmd knows (${
                   Object.keys(DIALECT_OF_ENTRY_TYPE).join(', ')}).`,
      };
    },
  };
}

// The lookup of a third-party table's entry, by its fullyQualifiedName or
// entrySource.system.
function thirdPartyLookup(
    catalog: EntryLookup, {project, location, name}: ThirdPartyEntry):
    DialectLookup {
  const at = `source '${name}'`;
  return {
    read: () => read(
        'looking up its Knowledge Catalog entry',
        () => catalog.lookupEntry(project, location, name)),
    unreadable:
        `${at} names no table Knowledge Catalog knows about. The entry may ` +
        `not exist, or you may not be allowed to read it. kcmd reads a ` +
        `third-party table's dialect from its entry, so add the table to ` +
        `Knowledge Catalog, or fix the source.`,
    dialectOf: ({fullyQualifiedName: fqn, entrySource}) => {
      const system = entrySource?.system;
      const dialect = fqn ?
          DIALECT_OF_FQN_PREFIX.get(fqn.split(':')[0]) :
          DIALECT_OF_ENTRY_SYSTEM.get(system?.toLowerCase() ?? '');
      if (dialect) return {dialect};
      const has = fqn ? `fullyQualifiedName '${fqn}'` :
          system ? `entrySource.system '${system}' and no fullyQualifiedName` :
                   'neither a fullyQualifiedName nor an entrySource.system';
      return {
        error: `${at}: kcmd cannot tell the table's SQL dialect from its ` +
            `Knowledge Catalog entry, which has ${has}. kcmd reads the ` +
            `prefix of the entry's fullyQualifiedName (snowflake:, ` +
            `databricks:, mysql:, postgresql: or sqlserver:), or ` +
            `entrySource.system when there is no fullyQualifiedName.`,
      };
    },
  };
}

// Every Cloud SQL table written as a resource name or resource URI anywhere in
// the model and profile files `texts`, and every third-party table written as
// an entry name as the value of a `source` key, including in the JSON a
// vanilla model's GOOGLE blocks carry. Values are read from the parsed YAML,
// so a name in a comment is not collected. A file that does not parse collects
// nothing; the load reports it.
export function sourcesToLookUp(texts: Iterable<string>): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, key?: string): void => {
    if (typeof value === 'string') {
      if (cloudSqlTableOf(value) ||
          (key === 'source' && thirdPartyEntryOf(value))) {
        found.add(value.trim());
      } else if (/^\s*[[{]/.test(value)) {
        try {
          visit(JSON.parse(value));
        } catch {
          // Not JSON: an ordinary string.
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(v => visit(v));
    } else if (value && typeof value === 'object') {
      for (const [k, v] of Object.entries(value)) visit(v, k);
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
