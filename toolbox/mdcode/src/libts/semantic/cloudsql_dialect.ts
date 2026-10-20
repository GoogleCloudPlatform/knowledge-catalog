// The dialect of a Cloud SQL table written as its resource name, read from the
// table's Knowledge Catalog entry (b/573288219).
//
// The resource name cannot say the dialect: a MySQL table has no schema, but a
// PostgreSQL table and a SQL Server table have the same shape. Dataplex keeps an
// entry for each table of an instance with Dataplex integration on, in the
// system entry group `@cloudsql`, and the entry's id is the table's resource
// name. Its entry type names the engine.
//
// This is the only place kcmd makes a network call to learn a dialect. A
// command looks every Cloud SQL source up once, before it loads the model, and
// passes the dialects to the load (LoadOptions.cloudSqlDialects).

import * as yaml from 'yaml';

import {ApiResult} from '../gcp/api';

import {cloudSqlTableOf} from './loader';
import {YAML_OPTIONS} from './yaml_options';

// The one call this module makes; `CatalogClient` provides it.
export interface EntryLookup {
  lookupEntry(project: string, location: string, name: string):
      Promise<ApiResult<{entryType?: string}>>;
}

// The dialect each Cloud SQL table or view entry type gives.
const DIALECT_OF_ENTRY_TYPE: Record<string, string> = {
  'cloudsql-mysql-table': 'MYSQL',
  'cloudsql-mysql-view': 'MYSQL',
  'cloudsql-postgresql-table': 'POSTGRES',
  'cloudsql-postgresql-view': 'POSTGRES',
  'cloudsql-sqlserver-table': 'SQLSERVER',
  'cloudsql-sqlserver-view': 'SQLSERVER',
};

export interface CloudSqlDialects {
  // Each Cloud SQL resource name, with no leading `//`, and its dialect.
  dialects: Map<string, string>;
  // One message per source whose dialect could not be read.
  errors: string[];
}

// Looks up the dialect of every Cloud SQL table the model and profile files
// `texts` write as a resource name or resource URI (see cloudSqlSourcesIn),
// once per table, in parallel. Makes no call when they write none. Never
// throws: a lookup that fails is reported in `errors`.
export async function cloudSqlDialects(
    texts: Iterable<string>, catalog: EntryLookup): Promise<CloudSqlDialects> {
  const tables = new Map<string, NonNullable<ReturnType<typeof cloudSqlTableOf>>>();
  for (const source of cloudSqlSourcesIn(texts)) {
    // Keyed by resource name, so both spellings of one table are one lookup.
    const table = cloudSqlTableOf(source);
    if (table) tables.set(table.resourceName, table);
  }
  const dialects = new Map<string, string>();
  const errors: string[] = [];
  await Promise.all([...tables.values()].map(async table => {
    const entry = `projects/${table.project}/locations/${
        table.location}/entryGroups/@cloudsql/entries/${table.resourceName}`;
    const at = `source '${table.resourceName}'`;
    let res: ApiResult<{entryType?: string}>;
    try {
      res = await catalog.lookupEntry(table.project, table.location, entry);
    } catch (err: any) {
      errors.push(`${at}: looking up its Knowledge Catalog entry failed: ${
          err?.message ?? err}`);
      return;
    }
    // Dataplex answers 403 both when the entry does not exist and when the
    // caller may not read it, so the message names both causes.
    if (res.status === 403 || res.status === 404) {
      errors.push(
          `${at}: kcmd reads a Cloud SQL table's dialect from its Knowledge ` +
          `Catalog entry, and could not read it. Turn on Dataplex ` +
          `integration for instance '${table.instance}' (gcloud sql ` +
          `instances patch ${table.instance} --enable-dataplex-integration ` +
          `--project ${table.project}) and wait for the table to appear in ` +
          `the catalog, or check that you can read the table. If integration ` +
          `is on, check the name: the project ID, the instance's region, and ` +
          `a schema only for PostgreSQL and SQL Server.`);
      return;
    }
    if (res.status !== 200 || !res.result) {
      errors.push(`${at}: looking up its Knowledge Catalog entry failed (HTTP ${
          res.status}${res.message ? `: ${res.message}` : ''}).`);
      return;
    }
    // The type comes back as a full name; its last part says the engine.
    const type = (res.result.entryType ?? '').split('/').pop() ?? '';
    const dialect = DIALECT_OF_ENTRY_TYPE[type];
    if (!dialect) {
      errors.push(
          `${at}: its Knowledge Catalog entry has type '${type}', which is ` +
          `not a Cloud SQL table or view type kcmd knows (${
              Object.keys(DIALECT_OF_ENTRY_TYPE).join(', ')}).`);
      return;
    }
    dialects.set(table.resourceName, dialect);
  }));
  errors.sort();
  return {dialects, errors};
}

// Every Cloud SQL table written as a resource name or resource URI anywhere in
// the model and profile files `texts`, including the JSON a vanilla model's
// GOOGLE blocks carry. Values are read from the parsed YAML, so a name in a
// comment is not collected. A file that does not parse collects nothing; the
// load reports it.
export function cloudSqlSourcesIn(texts: Iterable<string>): string[] {
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      if (cloudSqlTableOf(value)) {
        found.add(value.trim());
      } else if (/^\s*[[{]/.test(value)) {
        try {
          visit(JSON.parse(value));
        } catch {
          // Not JSON: an ordinary string.
        }
      }
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit);
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
