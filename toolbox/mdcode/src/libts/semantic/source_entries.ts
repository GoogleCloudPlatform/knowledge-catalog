// Checks that Knowledge Catalog has an entry for every table a push reads
// (b/568769073), so a source that names no table stops the push before it
// writes anything.
//
// Each first-party table's entry sits in its system's entry group, with its
// resource name as the entry id, in the table's own location:
//
// - BigQuery: the table's location, which getTable reads, such as `US`. The
//   table read needs only access to the table, not to its dataset.
// - BigLake: the region of the catalog's primary replica, which getCatalog
//   reads: `us-central1` for a regional catalog, and also for a US catalog
//   whose primary replica is there. A federated catalog lists one replica,
//   such as `US`, with no state.
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
// the entry was never looked up, so the message says which read it was:
// Spanner answers 403 for a project the caller may not read, whether or not
// the instance exists, so a 403 does not say the table is missing.
//
// A Cloud SQL or third-party source is not looked up here: sourceDialects
// already looks up its entry directly, and fails the push when it is missing.

import type {ApiResult} from '../gcp/api';
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
  biglake: Pick<BigLakeClient, 'getCatalog'>;
  spanner: Pick<SpannerClient, 'getInstance'|'getInstanceConfig'>;
}

// What a location read gave: the value read, or what is wrong with the
// source, as the message gives it after the source's name.
type Checked<T> = {result: T}|{problem: string};

// One message for each entity, in the inline bindings (named `default`) or in
// a profile, whose source names a table with no Knowledge Catalog entry, in
// that order. Reads each table's location and looks its entry up once, and
// reads each catalog and instance once, all in parallel. Skips an abstract
// entity, an entity with no source, and a source that names no table this
// module knows (a Cloud SQL or third-party table, or a legacy bare name).
// Never throws.
export async function sourceEntryErrors(
    model: Pick<SemanticModel, 'entities'|'profiles'>,
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

  const locations = new Map<string, Promise<Checked<string>>>();
  const problems = new Map<string, Promise<string|undefined>>();
  for (const {table} of uses) {
    if (!problems.has(table.resourceName)) {
      problems.set(table.resourceName, problemOf(table, readers, locations));
    }
  }

  const errors: string[] = [];
  for (const {entity, profile, table} of uses) {
    const problem = await problems.get(table.resourceName)!;
    if (problem) {
      errors.push(`entity '${entity}' in profile '${profile}': source '${
          table.resourceName}' ${problem}`);
    }
  }
  return errors;
}

// What is wrong with `table`'s source, or undefined when its catalog entry
// is there.
async function problemOf(
    table: SourceTable, readers: SourceReaders,
    cache: Map<string, Promise<Checked<string>>>): Promise<string|undefined> {
  const location = await locationOf(table, readers, cache);
  if ('problem' in location) return location.problem;
  const res = await lookupSystemEntry(
      readers.catalog, table.system, table.project, location.result,
      table.resourceName);
  if ('unreadable' in res) {
    return `names no table Knowledge Catalog knows about. The table may not ` +
        `exist, or you may not be allowed to read its catalog entry.${
               table.system === 'alloydb' ?
                   ' A new AlloyDB cluster can take hours to appear in the ' +
                       'catalog after Dataplex integration is turned on.' :
                   ''} Fix the source, or pass --skip-source-check.`;
  }
  return 'error' in res ? retry(res.error).problem : undefined;
}

// Said when reading an instance config is refused (live on
// bigquery-public-data and dataplex-staging-types, 2026-10-27: Spanner answers
// 403 naming this permission, even for a Google-managed config such as nam3).
const CONFIG_REFUSED_HINT = ' Reading it needs the permission ' +
    'spanner.instanceConfigs.get on the project, which roles/spanner.viewer ' +
    'includes and the Spanner database roles do not.';

// The location of `table`'s catalog entry, as Dataplex writes it, in lower
// case. `cache` keeps each catalog and instance's read, so each is read once;
// each table is read once already.
async function locationOf(
    table: SourceTable, readers: SourceReaders,
    cache: Map<string, Promise<Checked<string>>>): Promise<Checked<string>> {
  const once = (key: string, readIt: () => Promise<Checked<string>>) => {
    if (!cache.has(key)) cache.set(key, readIt());
    return cache.get(key)!;
  };
  const {project} = table;
  switch (table.system) {
    case 'alloydb':
      return {result: table.location};
    case 'bigquery': {
      const what = `reading table '${project}.${table.dataset}.${table.table}'`;
      const res = await readLocation(
          what, 'table',
          () => readers.bigquery.getTable(project, table.dataset, table.table));
      return 'result' in res ?
          located(res.result.location, what, 'no location') :
          res;
    }
    case 'biglake':
      return once(`biglake/${project}/${table.catalog}`, async () => {
        const what = `reading the region of catalog '${table.catalog}'`;
        const res = await readLocation(
            what, 'catalog',
            () => readers.biglake.getCatalog(project, table.catalog));
        return 'result' in res ? primaryRegion(res.result, what) : res;
      });
    case 'spanner':
      return once(`spanner/${project}/${table.instance}`, async () => {
        const what = `reading instance '${table.instance}'`;
        const instance = await readLocation(
            what, 'instance',
            () => readers.spanner.getInstance(project, table.instance));
        if ('problem' in instance) return instance;
        const configName = instance.result.config;
        if (!configName) return retry(`${what} gave no instance config.`);
        // A regional config keeps every replica, so its leader, in the region
        // it is named for: `regional-us-central1` leads in us-central1 (live,
        // 2026-10-27).
        const region = configName.match(/\/instanceConfigs\/regional-(.+)$/);
        if (region) return {result: region[1]};
        const configWhat = `reading instance config '${configName}'`;
        const config = await readLocation(
            configWhat, 'instance config',
            () => readers.spanner.getInstanceConfig(configName),
            CONFIG_REFUSED_HINT);
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
// names a `kind` that does not exist (the services answer 404 for a missing
// table, dataset, catalog or instance; live, 2026-10-27 and 2026-11-03). A 403
// says the read was refused, followed by `refusedHint`.
async function readLocation<T>(
    what: string, kind: string, call: () => Promise<ApiResult<T>>,
    refusedHint = ''): Promise<Checked<T>> {
  const res = await read(what, call);
  if ('result' in res) return res;
  if ('error' in res) return retry(res.error);
  return {
    problem: res.status === 404 ?
        `names a ${kind} that does not exist: ${what} found nothing (HTTP ` +
            `404). Fix the source, or pass --skip-source-check.` :
        `could not be checked: ${what} was refused (HTTP 403), so its ` +
            `catalog entry was not looked up.${refusedHint} Fix the access ` +
            `or the source, or pass --skip-source-check.`,
  };
}

// The region of `catalog`'s primary replica: the one marked STATE_PRIMARY, in
// whatever order the replicas come, or a lone replica with no state, as a
// regional or federated catalog lists. Several replicas with none primary
// were never seen live; that is reported rather than guessed at.
function primaryRegion(catalog: Catalog, what: string): Checked<string> {
  const replicas = catalog.replicas ?? [];
  const primary = replicas.find(r => r.state === 'STATE_PRIMARY') ??
      (replicas.length === 1 ? replicas[0] : undefined);
  if (!primary && replicas.length) {
    return retry(`${what} gave no primary replica.`);
  }
  return located(primary?.region, what, 'no region');
}

// `location` in lower case, or a problem when the read `what` gave none.
// The services have always given one; this keeps a response without it from
// stopping the push with a crash.
function located(location: string|undefined, what: string, missing: string):
    Checked<string> {
  return location ? {result: location.toLowerCase()} :
                    retry(`${what} gave ${missing}.`);
}

// The problem for a read that failed with `detail`, which may pass on retry.
function retry(detail: string): {problem: string} {
  return {
    problem: `could not be checked; try again, or pass --skip-source-check: ${
        detail}`,
  };
}
