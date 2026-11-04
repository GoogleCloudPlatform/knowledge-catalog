// Checks that Knowledge Catalog has an entry for every table a push reads
// (b/568769073), so a source that names no table stops the push before it
// writes anything. The same reads find each profile whose BigQuery and
// BigLake tables share no location (b/578688979).
//
// Each first-party table's entry sits in its system's entry group, with its
// resource name as the entry id, in the table's own location:
//
// - BigQuery: the table's location, which getTable reads, such as `US`. The
//   table read needs only access to the table, not to its dataset.
// - BigLake: the region of one of the catalog's replicas, which getCatalog
//   reads: `us-central1` for a regional catalog. A federated catalog lists
//   one replica, such as `US`, with no state. A US catalog of Cloud Storage
//   tables keeps a table's entry in the region that was its primary when the
//   table was created, so after a failover an older table's entry can sit in
//   a former primary's region, now a secondary's. The entry is looked up in
//   each replica's region, the primary's first, until one finds it.
//   getHiveCatalog reads a Hive catalog. Its tables are written with
//   `databases/`.
// - Spanner: the default leader region of the instance's config, which
//   getInstance reads the config's name from. A regional config is named for
//   its region, `regional-us-central1` for us-central1, so it is not read;
//   any other config is, with getInstanceConfig: `nam3` gives us-east4. That
//   read needs spanner.instanceConfigs.get, which the Spanner database roles
//   lack. A database's own default leader does not move the entry.
// - AlloyDB: the location the source names.
//
// Dataplex keeps locations in lower case. A lookup in the wrong location
// answers 403, as a missing entry does (live, 2026-10-27), so each location
// must be read, not guessed. Every read is a direct lookup: Dataplex search
// misses entries a lookup finds, and is not exact.
//
// When a location read answers 404, the source names a table, catalog or
// instance that does not exist. When it answers 403, the read was refused and
// the entry was never looked up, so the message says which read it was, and
// what the service said: Spanner answers 403 for a project the caller may not
// read, whether or not the instance exists, so a 403 does not say the table
// is missing. A read that fails another way says to try again when a retry
// may pass (a thrown call, a 429 or a 5xx), and to fix the source otherwise.
//
// A Cloud SQL or third-party source is not looked up here: sourceDialects
// already looks up its entry directly, and fails the push when it is missing.

import type {ApiResult} from '../gcp/api';
import {isTransientStatus} from '../gcp/api';
import type {BigLakeClient, Catalog} from '../gcp/biglake';
import type {BigQueryClient} from '../gcp/bigquery';
import type {SpannerClient} from '../gcp/spanner';

import {EntryLookup, lookupSystemEntry, read} from './catalog_entry';
import type {SemanticModel} from './ir';
import {SourceTable, sourceTableOf, writtenSource} from './loader';
import {DEFAULT_PROFILE} from './resolve_profiles';

// The reads the check makes; the GCP clients provide them.
export interface SourceReaders {
  catalog: EntryLookup;
  bigquery: Pick<BigQueryClient, 'getTable'>;
  biglake: Pick<BigLakeClient, 'getCatalog'|'getHiveCatalog'>;
  spanner: Pick<SpannerClient, 'getInstance'|'getInstanceConfig'>;
}

// What a location read gave: the value read, or what is wrong with the
// source, as the message gives it after the source's name.
type Checked<T> = {result: T}|{problem: string};

// One message for each entity, in the inline bindings (named `default`) or in
// a profile, whose source names a table with no Knowledge Catalog entry, in
// that order. Then one message for each of those profiles whose BigQuery and
// BigLake tables share no location (b/578688979): BigQuery runs each query in
// one location, so no query through the profile can join them.
//
// A named profile is judged by its own sources, since push requires it to
// bind every concrete entity. A BigLake table can be queried in any replica
// region of its catalog. A table whose location could not be read is
// reported above and left out.
//
// Seen live in kc-looker-external, for a US catalog whose replicas are
// us-central1 (primary) and us-east1:
// - A job in US cannot read its tables (2026-11-03).
// - Once a table has replicated, which took a few minutes, a job in either
//   region can read it, join it with a dataset in that region, and create a
//   property graph over both (2026-11-04).
// - A job with no location runs in the primary.
//
// Reads each table's location and looks its entry up once per location it
// may sit in, and reads each catalog and instance once; tables are checked in
// parallel, and a table's locations in turn. Skips an abstract entity, an
// entity with no source, and a source that names no table this module knows
// (a Cloud SQL or third-party table, or a legacy bare name). Never throws.
export async function sourceEntryErrors(
    model: Pick<SemanticModel, 'name'|'entities'|'profiles'>,
    readers: SourceReaders): Promise<string[]> {
  const uses: Array<{entity: string; profile: string; table: SourceTable}> = [];
  const use = (entity: string, profile: string, source: string|undefined) => {
    const table = source ? sourceTableOf(source) : undefined;
    if (table) uses.push({entity, profile, table});
  };
  for (const e of model.entities) {
    if (!e.abstract) use(e.name, DEFAULT_PROFILE, writtenSource(e));
  }
  for (const p of model.profiles ?? []) {
    for (const b of p.entities) use(b.name, p.name, b.source);
  }

  const catalogAndInstanceReads =
      new Map<string, Promise<Checked<string[]>>>();
  const locations = new Map<string, Promise<Checked<string[]>>>();
  const problems = new Map<string, Promise<string|undefined>>();
  for (const {table} of uses) {
    if (!problems.has(table.resourceName)) {
      const located = locationsOf(table, readers, catalogAndInstanceReads);
      locations.set(table.resourceName, located);
      problems.set(table.resourceName, problemOf(table, located, readers));
    }
  }

  const errors: string[] = [];
  // By profile, each list of regions BigQuery can query one of its tables in,
  // keyed by the list, with the entities bound to such tables, in the order
  // bound.
  const placed = new Map<string, Map<string, {regions: string[]; entities: string[]}>>();
  for (const {entity, profile, table} of uses) {
    const problem = await problems.get(table.resourceName)!;
    if (problem) {
      errors.push(`entity '${entity}' in profile '${profile}': source '${
          table.resourceName}' ${problem}`);
    }
    if (table.system !== 'bigquery' && table.system !== 'biglake') continue;
    const located = await locations.get(table.resourceName)!;
    if (!('result' in located)) continue;
    const regions = located.result;
    const key = regions.join(' ');
    const at = placed.get(profile) ?? new Map();
    at.set(key, {regions, entities: [...at.get(key)?.entities ?? [], entity]});
    placed.set(profile, at);
  }
  for (const [profile, at] of placed) {
    const [first, ...rest] = at.values();
    if (first.regions.some(r => rest.every(g => g.regions.includes(r)))) {
      continue;
    }
    const listed = [...at.values()].map(
        ({regions, entities}) => `${regions.map(shown).join(' or ')} (${
            entities.map(e => `'${e}'`).join(', ')})`);
    errors.push(
        `profile '${profile}' of model '${model.name}' binds tables that ` +
        `share no BigQuery location: ${listed.join(', ')}. ` +
        `BigQuery runs each query in one location, so no query can join ` +
        `them. Bind them to tables that share a location, or pass ` +
        `--skip-source-check.`);
  }
  return errors;
}

// What is wrong with `table`'s source, or undefined when its catalog entry
// is there. `located` is what locationsOf gave for `table`. Looks the entry
// up in each of its locations in turn, and stops at the first that finds it:
// a lookup in the wrong location answers 403, so trying each cannot pass a
// missing entry.
async function problemOf(
    table: SourceTable, located: Promise<Checked<string[]>>,
    readers: SourceReaders): Promise<string|undefined> {
  const locations = await located;
  if ('problem' in locations) return locations.problem;
  for (const location of locations.result) {
    const res = await lookupSystemEntry(
        readers.catalog, table.system, table.project, location,
        table.resourceName);
    if ('result' in res) return undefined;
    if ('error' in res) return failedProblem(res).problem;
  }
  return `names no table Knowledge Catalog knows about. The table may not ` +
      `exist, or you may not be allowed to read its catalog entry.${
             table.system === 'alloydb' ?
                 ' A new AlloyDB cluster can take hours to appear in the ' +
                     'catalog after Dataplex integration is turned on.' :
                 ''} Fix the source, or pass --skip-source-check.`;
}

// `location`, which is kept in lower case, as BigQuery writes it: a
// multi-region, which has no hyphen, in upper case (`US`, `EU`).
function shown(location: string): string {
  return location.includes('-') ? location : location.toUpperCase();
}

// Said when reading an instance config is refused (live on
// bigquery-public-data and dataplex-staging-types, 2026-10-27: Spanner answers
// 403 naming this permission, even for a Google-managed config such as nam3).
const CONFIG_REFUSED_HINT = ' Reading it needs the permission ' +
    'spanner.instanceConfigs.get on the project, which roles/spanner.viewer ' +
    'includes and the Spanner database roles do not.';

// Said when a BigLake catalog read answers a status a retry will not change,
// since the source may name a table in the other kind of catalog. Live, the
// Iceberg REST catalog API answers 400 for a Hive catalog, and the Hive API
// answers 404 for an Iceberg REST catalog, or 400 for an id it refuses.
const HIVE_FORM_HINT =
    ` A table in a Hive catalog is written with 'databases/<database>'.`;
const ICEBERG_FORM_HINT = ` A table in an Iceberg REST catalog is written ` +
    `with 'namespaces/<namespace>'.`;

// The locations where `table`'s catalog entry may sit, as Dataplex writes
// them, in lower case, in the order to look in: one for a BigQuery, Spanner
// or AlloyDB table, and one per replica for a BigLake table. `cache` keeps
// each catalog and instance's read, so each is read once; each table is read
// once already.
async function locationsOf(
    table: SourceTable, readers: SourceReaders,
    cache: Map<string, Promise<Checked<string[]>>>):
    Promise<Checked<string[]>> {
  const once = (key: string, readIt: () => Promise<Checked<string[]>>) => {
    if (!cache.has(key)) cache.set(key, readIt());
    return cache.get(key)!;
  };
  const {project} = table;
  switch (table.system) {
    case 'alloydb':
      return {result: [table.location]};
    case 'bigquery': {
      const what = `reading table '${project}.${table.dataset}.${table.table}'`;
      const res = await readLocation(
          what, 'a table',
          () => readers.bigquery.getTable(project, table.dataset, table.table));
      return 'result' in res ?
          located(res.result.location, what, 'no location') :
          res;
    }
    case 'biglake': {
      const kind = table.hive ? 'Hive catalog' : 'catalog';
      return once(`biglake/${project}/${table.catalog}/${kind}`, async () => {
        const what = `reading the region of ${kind} '${table.catalog}'`;
        const res = await readLocation(
            what, `a ${kind}`, () => table.hive ?
                readers.biglake.getHiveCatalog(project, table.catalog) :
                readers.biglake.getCatalog(project, table.catalog),
            table.hive ? {400: ICEBERG_FORM_HINT, 404: ICEBERG_FORM_HINT} :
                         {400: HIVE_FORM_HINT});
        return 'result' in res ? replicaRegions(res.result, what) : res;
      });
    }
    case 'spanner':
      return once(`spanner/${project}/${table.instance}`, async () => {
        const what = `reading instance '${table.instance}'`;
        const instance = await readLocation(
            what, 'an instance',
            () => readers.spanner.getInstance(project, table.instance));
        if ('problem' in instance) return instance;
        const configName = instance.result.config;
        if (!configName) {
          return transientProblem(`${what} gave no instance config.`);
        }
        // A regional config keeps every replica, so its leader, in the region
        // it is named for: `regional-us-central1` leads in us-central1 (live,
        // 2026-10-27).
        const region = configName.match(/\/instanceConfigs\/regional-(.+)$/);
        if (region) return {result: [region[1]]};
        const configWhat = `reading instance config '${configName}'`;
        const config = await readLocation(
            configWhat, 'an instance config',
            () => readers.spanner.getInstanceConfig(configName),
            {403: CONFIG_REFUSED_HINT});
        // A config marks exactly one replica as its default leader.
        return 'result' in config ?
            located(
                config.result.replicas?.find(r => r.defaultLeaderLocation)
                    ?.location,
                configWhat, 'no default leader') :
            config;
      });
  }
}

// Makes the location read `call`, which `what` names. A 404 says the source
// names `kind`, such as `a table`, that does not exist (the services answer
// 404 for a missing table, dataset, catalog or instance; live, 2026-10-27 and
// 2026-11-03). A 403 says the read was refused, followed by the service's
// message. `hints` gives a sentence to add for a status.
async function readLocation<T>(
    what: string, kind: string, call: () => Promise<ApiResult<T>>,
    hints: Record<number, string> = {}): Promise<Checked<T>> {
  const res = await read(what, call);
  if ('result' in res) return res;
  const hint = hints[res.status ?? 0] ?? '';
  if ('error' in res) return failedProblem(res, hint);
  return {
    problem: res.status === 404 ?
        `names ${kind} that does not exist: ${what} found nothing (HTTP ` +
            `404).${hint} Fix the source, or pass --skip-source-check.` :
        `could not be checked: ${what} was refused (HTTP 403).${
            res.message ? ` ${res.message}` : ''}${hint} The ` +
            `source's catalog entry was not looked up. Fix the access or ` +
            `the source, or pass --skip-source-check.`,
  };
}

// The regions of `catalog`'s replicas, in the order to look in: a replica
// marked STATE_PRIMARY first, then one in another primary state, such as
// STATE_PRIMARY_IN_PROGRESS, then the rest, each group in the order the
// replicas come. A regional or federated catalog lists one replica with no
// state.
//
// After a failover, a table's entry stays only in the region that was the
// catalog's primary when the table was created, until the table is next
// written; for a few seconds during a failover the new primary reads
// STATE_PRIMARY_IN_PROGRESS, so no replica is STATE_PRIMARY (from review on
// #623, 2026-11-03; not tested live by us).
function replicaRegions(catalog: Catalog, what: string): Checked<string[]> {
  const rank = (state = '') =>
      state === 'STATE_PRIMARY' ? 0 : state.includes('PRIMARY') ? 1 : 2;
  const regions = (catalog.replicas ?? [])
                      .filter(r => r.region)
                      .sort((a, b) => rank(a.state) - rank(b.state))
                      .map(r => r.region!.toLowerCase());
  return regions.length ? {result: regions} :
                          transientProblem(`${what} gave no region.`);
}

// `location` in lower case, or a problem when the read `what` gave none.
// The services have always given one; this keeps a response without it from
// stopping the push with a crash.
function located(location: string|undefined, what: string, missing: string):
    Checked<string[]> {
  return location ? {result: [location.toLowerCase()]} :
                    transientProblem(`${what} gave ${missing}.`);
}

// The problem for the failed read `res`. A thrown call, a 429 or a 5xx may
// pass on retry; any other status, such as BigQuery's 400 for an invalid
// table ID, never will, so the source must change, and `hint` follows the
// service's answer.
function failedProblem(res: {error: string; status?: number}, hint = ''):
    {problem: string} {
  return res.status === undefined || isTransientStatus(res.status) ?
      transientProblem(res.error) :
      {
        problem: `could not be checked: ${res.error}${hint} Fix the source, ` +
            `or pass --skip-source-check.`,
      };
}

// The problem for a read that failed with `detail`, which may pass on retry.
function transientProblem(detail: string): {problem: string} {
  return {
    problem: `could not be checked; try again, or pass --skip-source-check: ${
        detail}`,
  };
}
