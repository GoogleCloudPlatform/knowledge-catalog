// The dialect of a Cloud SQL table written as its resource name, or of a
// third-party table written as its entry name, read from the table's
// Knowledge Catalog entry, and the dialect of a Spanner table's database.
//
// The resource name cannot say the dialect: a MySQL table has no schema, but a
// PostgreSQL table and a SQL Server table have the same shape. Dataplex keeps an
// entry for each table of an instance with Dataplex integration on, in the
// system entry group `@cloudsql`, and the entry's id is the table's resource
// name. Its entry type names the engine. The instance, each database and each
// schema have entries there too, whose ids are the matching prefixes of the
// table's resource name. When the table's entry cannot be read, kcmd looks
// those up to say why (see missingCloudSqlPart).
//
// A third-party table's entry names its system twice: in the prefix of its
// fullyQualifiedName, which Dataplex checks, and in entrySource.system, which
// is free text. So the prefix decides, and the system only when the entry has
// no fullyQualifiedName. Dataplex also checks the rest of the
// fullyQualifiedName, so its parts say whether the entry is a table's or, for
// example, a schema's.
//
// Knowledge Catalog's Spanner entries leave their dialect empty, so a Spanner
// table's dialect is its database's `databaseDialect`, read by databases.get.
//
// This is the only place kcmd looks up a source's dialect. A command looks
// every such source up once, before it loads the model, and passes the
// dialects to the load (LoadOptions.sourceDialects).

import * as yaml from 'yaml';

import type {SpannerClient} from '../gcp/spanner';
import {fileNameOf, SemanticModelLayout} from '../layouts/semantic-model';

import {catalogNameSegments, CloudSqlTable, cloudSqlTableOf, DIALECT_OF_ENTRY_TYPE, DIALECT_OF_FQN_PREFIX, isGoogleVendor, spannerDatabaseOf, ThirdPartyEntry, thirdPartyEntryOf} from './loader';
import {EntryLookup, EntryRead, lookupSystemEntry, Read, read} from './catalog_entry';
import {storeMessage} from './parameters';
import {documentValue, YAML_OPTIONS} from './yaml_options';

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
  // The messages of `errors` for a read that failed: a 403 or 404, another
  // failed status, or no answer. The others are for an entry that was read
  // and gives no dialect.
  unread: string[];
}

// A table's dialect and, for a third-party table, its database, or why kcmd
// cannot tell the dialect, with `unread` when the read failed.
type Dialect = {dialect: string; database?: string}|
    {error: string; unread?: true};

// A model or profile file: the label a message gives it, and its text. As in
// push's other messages, a model file's label is its document name, such as
// `commerce`, and a profile file's label is its file name.
export interface LabeledText {
  label: string;
  text: string;
}

// Each model file of `docs`, then its profile files, which `profileFiles`
// gives, labeled as LabeledText says. A model's profile files that
// `profileFiles` throws on are left out, since the command reports them where
// it reads them.
export function labeledFiles(
    layout: SemanticModelLayout, docs: Array<{name: string; text: string}>,
    profileFiles: (model: string) => Array<{path: string; text: string}>):
    LabeledText[] {
  return docs.flatMap(doc => {
    let files: Array<{path: string; text: string}> = [];
    try {
      files = profileFiles(doc.name);
    } catch {
      // Reported where it is read.
    }
    return [
      {label: doc.name, text: doc.text},
      ...files.map(
          f => ({label: fileNameOf(layout, doc.name, f.path), text: f.text})),
    ];
  });
}

// The aspect type of a Cloud SQL instance's entry whose `dataplexEnabled` says
// whether Dataplex integration is on for the instance.
const CLOUDSQL_INSTANCE_ASPECT =
    'projects/dataplex-types/locations/global/aspectTypes/cloudsql-instance';

// The engine each Cloud SQL instance entry type names.
const ENGINE_OF_INSTANCE_TYPE: Record<string, string> = {
  'cloudsql-mysql-instance': 'MySQL',
  'cloudsql-postgresql-instance': 'PostgreSQL',
  'cloudsql-sqlserver-instance': 'SQL Server',
};

// Looks up, once each and in parallel, the dialect of every Cloud SQL and
// third-party table the files `files` write (see sourcesToLookUp), and of
// every Spanner database they name. Without `spanner`, a Spanner database
// gives SPANNER, the dialect kcmd's Spanner store speaks, with no call.
// `thirdParty: false` skips third-party tables. Never throws: a failed lookup
// goes to `errors`. A message about a Cloud SQL table starts with the label of
// each file that writes it.
export async function sourceDialects(
    files: Iterable<LabeledText>, catalog: EntryLookup,
    {thirdParty = true, spanner}: {
      thirdParty?: boolean; spanner?: Pick<SpannerClient, 'getDatabase'>;
    } = {}): Promise<SourceDialects> {
  // Keyed as dialectLookupKey gives, so both spellings of one table, and the
  // tables of one Spanner database, are one lookup. A database's lookup names
  // the first of its tables.
  const lookups = new Map<string, () => Promise<Dialect>>();
  // The labels of the files that write each Cloud SQL table, keyed by its
  // resource name.
  const labelsOf = new Map<string, string[]>();
  // Each lookup of a Cloud SQL instance, database or schema entry, keyed by
  // its entry id, so tables that share one look it up once.
  const parts = new Map<string, Promise<Read<EntryRead>>>();
  const lookUpPart =
      (table: CloudSqlTable, id: string, what: string, aspects?: string[]) => {
        if (!parts.has(id)) {
          parts.set(
              id,
              lookupSystemEntry(
                  catalog, 'cloudsql', table.project, table.location, id,
                  `looking up the catalog entry of ${what}`, aspects));
        }
        return parts.get(id)!;
      };
  for (const {label, text} of files) {
    for (const source of sourcesToLookUp([text])) {
      const table = cloudSqlTableOf(source);
      if (table) {
        const labels = labelsOf.get(table.resourceName) ?? [];
        if (!labels.includes(label)) labels.push(label);
        labelsOf.set(table.resourceName, labels);
        lookups.set(
            table.resourceName,
            () => cloudSqlDialect(
                catalog, table, labels,
                (id, what, aspects) => lookUpPart(table, id, what, aspects)));
      }
      const entry = thirdParty ? thirdPartyEntryOf(source) : undefined;
      if (entry) {
        lookups.set(entry.name, () => thirdPartyDialect(catalog, entry));
      }
      const database = spannerDatabaseOf(source);
      if (database && !lookups.has(database)) {
        lookups.set(
            database,
            spanner ? () => spannerDialect(spanner, database, source) :
                      async () => ({dialect: 'SPANNER'}));
      }
    }
  }
  const dialects = new Map<string, string>();
  const databases = new Map<string, string>();
  const errors: string[] = [];
  const unread: string[] = [];
  await Promise.all([...lookups].map(async ([key, lookUp]) => {
    const got = await lookUp();
    if ('error' in got) errors.push(got.error);
    else dialects.set(key, got.dialect);
    if ('unread' in got) unread.push(got.error);
    if ('database' in got && got.database) databases.set(key, got.database);
  }));
  errors.sort();
  unread.sort();
  return {dialects, databases, errors, unread};
}

// Looks up the entry of a part of a Cloud SQL table, by its entry id, with the
// aspects of the aspect types `aspects`; `what` names the part in a message.
type PartLookup = (id: string, what: string, aspects?: string[]) =>
    Promise<Read<EntryRead>>;

// The dialect of a Cloud SQL table, by its entry's type. `labels` labels the
// files that write the table, and `lookUpPart` looks up the entries of its
// instance, database and schema.
async function cloudSqlDialect(
    catalog: EntryLookup, table: CloudSqlTable, labels: string[],
    lookUpPart: PartLookup): Promise<Dialect> {
  const at = `[${labels.join(', ')}] source '${table.resourceName}'`;
  const res = await lookupSystemEntry(
      catalog, 'cloudsql', table.project, table.location, table.resourceName);
  if ('error' in res) return {error: `${at}: ${res.error}`, unread: true};
  if ('unreadable' in res) {
    return {
      unread: true,
      error: `${at} names no table Knowledge Catalog knows about. ${
          await missingCloudSqlPart(table, lookUpPart)}`,
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

// Why Knowledge Catalog gives no entry for `table` that the caller may read.
// Dataplex answers 403 both when an entry does not exist and when the caller
// may not read it. So this looks up the entries of the table's instance,
// database and schema with `lookUp`, and reports the first of these that
// holds:
//   1. The instance's entry cannot be read.
//   2. The table's name does not fit the engine the instance's entry gives.
//      A MySQL table's name has no schema. A PostgreSQL or SQL Server table's
//      name has one.
//   3. The instance's entry says Dataplex integration is off. The catalog
//      keeps an instance's entry whether integration is on or off.
//   4. The database's entry cannot be read.
//   5. The schema's entry cannot be read.
// When every part can be read, the table may not exist, or it may be too new
// to be in the catalog yet.
async function missingCloudSqlPart(
    table: CloudSqlTable, lookUp: PartLookup): Promise<string> {
  const {project, location, instance, database, schema} = table;
  const instanceId = `cloudsql.googleapis.com/projects/${project}/locations/${
      location}/instances/${instance}`;
  const found = await lookUp(
      instanceId, `instance '${instance}'`, [CLOUDSQL_INSTANCE_ASPECT]);
  if ('error' in found) return `kcmd could not tell why: ${found.error}`;
  if ('unreadable' in found) {
    return `Knowledge Catalog has no entry you may read for its instance ` +
        `'${instance}' in project '${project}' and region '${location}'. ` +
        `The project ID, the region or the instance name may be wrong, or ` +
        `you may not be allowed to read the instance's entry. Check the ` +
        `source and your access.`;
  }
  const type = (found.result.entryType ?? '').split('/').pop() ?? '';
  const engine = ENGINE_OF_INSTANCE_TYPE[type];
  if (engine === 'MySQL' && schema !== undefined) {
    return `Instance '${instance}' runs MySQL, which has no schemas. Remove ` +
        `'schemas/${schema}/' from the source.`;
  }
  if (engine && engine !== 'MySQL' && schema === undefined) {
    return `Instance '${instance}' runs ${engine}, so a table's name ` +
        `includes its schema. Add 'schemas/<schema>/' before 'tables/' in ` +
        `the source.`;
  }
  // The aspect's key names its type's project by ID or by number.
  const integration = Object.entries(found.result.aspects ?? {}).find(
      ([key]) => key.endsWith('.global.cloudsql-instance'))?.[1];
  if (integration?.data?.dataplexEnabled === false) {
    return `Dataplex integration is off for instance '${instance}'. Turn it ` +
        `on with 'gcloud sql instances patch ${instance} ` +
        `--enable-dataplex-integration --project ${project}' and wait for ` +
        `the table to appear in the catalog.`;
  }
  const databaseId = `${instanceId}/databases/${database}`;
  const parts = [{
    id: databaseId,
    what: `database '${database}'`,
    missing: `Instance '${instance}' is in the catalog, but database '${
        database}' is not. The database may not exist, or it may be too new ` +
        `to be in the catalog yet. Check the database name.`,
  }];
  if (schema !== undefined) {
    parts.push({
      id: `${databaseId}/schemas/${schema}`,
      what: `schema '${schema}'`,
      missing: `Database '${database}' is in the catalog, but schema '${
          schema}' is not. The schema may not exist, or it may be too new to ` +
          `be in the catalog yet. Check the schema name.`,
    });
  }
  for (const {id, what, missing} of parts) {
    const res = await lookUp(id, what);
    if ('error' in res) return `kcmd could not tell why: ${res.error}`;
    if ('unreadable' in res) return missing;
  }
  const present = schema === undefined ? 'instance and database' :
                                         'instance, database and schema';
  return `Its ${present} are in the catalog. The table may not exist, or it ` +
      `may be too new to be in the catalog yet. Check the table name, or ` +
      `create the table.`;
}

// The dialect of the Spanner database `database`, which `source` names a
// table of, by its databaseDialect.
async function spannerDialect(
    spanner: Pick<SpannerClient, 'getDatabase'>, database: string,
    source: string): Promise<Dialect> {
  const [, , project, , instance, , name] = database.split('/');
  const failed = (why: string): Dialect => ({
    unread: true,
    error: `source '${source}': kcmd reads its Spanner database's SQL ` +
        `dialect, and could not read database ${project}/${instance}/${
               name}: ${why}`,
  });
  try {
    const res = await spanner.getDatabase(project, instance, name);
    if (res.status !== 200) {
      return failed(storeMessage(res.message, res.status));
    }
    const postgres = res.result?.databaseDialect === 'POSTGRESQL';
    return {dialect: postgres ? 'POSTGRES' : 'SPANNER'};
  } catch (err: any) {
    return failed(err?.message ?? String(err));
  }
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
  if ('error' in res) return {error: `${at}: ${res.error}`, unread: true};
  if ('unreadable' in res) {
    return {
      unread: true,
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
// and its unquoted parts, such as `snowflake` and ['acme', 'retail', 'public',
// 'orders'] for `snowflake:acme.retail.public.orders`. Undefined when `fqn`
// has another number of parts than TABLE_FQN_PARTS gives, or a subtype other
// than Databricks' `table:` and `view:`.
export function tableFqnParts(fqn: string):
    {prefix: string; parts: string[]}|undefined {
  // The subtype holds no backtick, so a colon inside a quoted host and port
  // stays in the path. A colon in an unquoted database, schema or table
  // name stays in its segment when it comes after the name's first backtick.
  const [, prefix, subtype, path] =
      fqn.match(/^([a-z]+):(?:([a-z0-9_-]+):)?(.*)$/s) ?? [];
  const parts = TABLE_FQN_PARTS.get(prefix ?? '');
  const seg = catalogNameSegments(path ?? '', true);
  const tableSubtype = subtype === undefined ||
      (prefix === 'databricks' && (subtype === 'table' || subtype === 'view'));
  if (!parts || !tableSubtype || seg.length !== parts.length) return undefined;
  return {prefix, parts: seg};
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

// Every Cloud SQL table, Spanner table and third-party entry the model and
// profile files `texts` write. A Cloud SQL table counts as a resource name or
// resource URI anywhere, JSON strings included. A Spanner table or an entry
// name counts as a `source` value in the YAML or in a GOOGLE block's JSON
// `data`, unless it sits in ai_context, an action parameter's default or
// another vendor's block. Values are read from the parsed YAML, so a name in a
// comment is not collected. A file that does not parse collects nothing; the
// load reports it.
export function sourcesToLookUp(texts: Iterable<string>): string[] {
  const found = new Set<string>();
  // `key` names the member that holds `value`. `opaque` marks a value whose
  // `source` names no table: one inside ai_context, an action parameter's
  // default or another vendor's block, or in JSON written anywhere but a
  // `data` member.
  const visit = (value: unknown, key?: string, opaque = false): void => {
    if (typeof value === 'string') {
      if (cloudSqlTableOf(value) ||
          (key === 'source' && !opaque &&
           (thirdPartyEntryOf(value) || spannerDatabaseOf(value)))) {
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
      // set, on more aliases than a load expands, or on an alias inside the
      // value its anchor names. The load reports that file in its own words,
      // so it is skipped here rather than stopping the command.
      try {
        visit(documentValue(text, doc));
      } catch {
        continue;
      }
    }
  }
  return [...found];
}
