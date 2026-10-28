// Checks that Knowledge Catalog has an entry for every table a push reads
// (b/568769073), so a source that names no table stops the push before it
// writes anything.
//
// Each first-party table's entry sits in its system's entry group, with its
// resource name as the entry id, in the table's own location:
//
// - BigQuery: the dataset's location, which getDataset reads, such as `US`.
// - BigLake: the catalog's region, which getCatalog reads, such as
//   `us-central1`, or `US` for a multi-region catalog.
// - Spanner: the default leader region of the instance's config, which
//   getInstance and getInstanceConfig read: `regional-us-central1` gives
//   us-central1, and `nam3` gives us-east4. A database's own default leader
//   does not move the entry.
// - AlloyDB: the location the source names.
//
// Dataplex keeps locations in lower case. A lookup in the wrong location
// answers 403, as a missing entry does (live, 2026-10-27), so each location
// must be read, not guessed. Every read is a direct lookup: Dataplex search
// misses entries a lookup finds, and is not exact.
//
// A Cloud SQL source is not looked up here: cloudSqlDialects already looks up
// its entry, and fails the push when it is missing.

import type {BigLakeClient} from '../gcp/biglake';
import type {BigQueryClient} from '../gcp/bigquery';
import type {SpannerClient} from '../gcp/spanner';

import {EntryLookup, lookupSystemEntry, Read, read} from './catalog_entry';
import type {SemanticModel} from './ir';
import {SourceTable, sourceTableOf, writtenSource} from './loader';
import {DEFAULT_PROFILE} from './resolve_profiles';

// The reads the check makes; the GCP clients provide them.
export interface SourceReaders {
  catalog: EntryLookup;
  bigquery: Pick<BigQueryClient, 'getDataset'>;
  biglake: Pick<BigLakeClient, 'getCatalog'>;
  spanner: Pick<SpannerClient, 'getInstance'|'getInstanceConfig'>;
}

// One message for each entity, in the inline bindings (named `default`) or in
// a profile, whose source names a table with no Knowledge Catalog entry, in
// that order. Looks each table up once, and reads each dataset, catalog and
// instance's location once, all in parallel. Skips an abstract entity, an
// entity with no source, and a source that names no table this module knows
// (a Cloud SQL table, or a legacy bare name). Never throws.
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

  const locations = new Map<string, Promise<Read<string>>>();
  const entries = new Map<string, Promise<Read<unknown>>>();
  for (const {table} of uses) {
    if (entries.has(table.resourceName)) continue;
    entries.set(table.resourceName, (async () => {
      const location = await locationOf(table, readers, locations);
      if (!('result' in location)) return location;
      return lookupSystemEntry(
          readers.catalog, table.system, table.project, location.result,
          table.resourceName);
    })());
  }

  const errors: string[] = [];
  for (const {entity, profile, table} of uses) {
    const res = await entries.get(table.resourceName)!;
    const at = `entity '${entity}' in profile '${profile}': source '${
        table.resourceName}'`;
    if ('unreadable' in res) {
      errors.push(
          `${at} names no table Knowledge Catalog knows about. The table may ` +
          `not exist, or you may not be allowed to read its catalog entry.${
              table.system === 'alloydb' ?
                  ' A new AlloyDB cluster can take hours to appear in the ' +
                      'catalog after Dataplex integration is turned on.' :
                  ''} Fix the source, or pass --skip-source-check.`);
    } else if ('error' in res) {
      errors.push(`${at} could not be checked; try again, or pass ` +
                  `--skip-source-check: ${res.error}`);
    }
  }
  return errors;
}

// The location of `table`'s catalog entry, as Dataplex writes it, in lower
// case. `cache` keeps each dataset, catalog and instance's read, so each is
// read once.
function locationOf(
    table: SourceTable, readers: SourceReaders,
    cache: Map<string, Promise<Read<string>>>): Promise<Read<string>> {
  const once = (key: string, readIt: () => Promise<Read<string>>) => {
    if (!cache.has(key)) cache.set(key, readIt());
    return cache.get(key)!;
  };
  const {project} = table;
  switch (table.system) {
    case 'alloydb':
      return Promise.resolve({result: table.location});
    case 'bigquery':
      return once(`bigquery/${project}/${table.dataset}`, async () => {
        const what =
            `reading the location of dataset '${project}.${table.dataset}'`;
        const res = await read(
            what, () => readers.bigquery.getDataset(project, table.dataset));
        return 'result' in res ?
            located(res.result.location, what, 'no location') :
            res;
      });
    case 'biglake':
      return once(`biglake/${project}/${table.catalog}`, async () => {
        const what = `reading the region of catalog '${table.catalog}'`;
        const res = await read(
            what, () => readers.biglake.getCatalog(project, table.catalog));
        // A catalog lists the one region it lives in (live, 2026-10-27).
        return 'result' in res ?
            located(res.result.replicas?.[0]?.region, what, 'no region') :
            res;
      });
    case 'spanner':
      return once(`spanner/${project}/${table.instance}`, async () => {
        const what = `reading instance '${table.instance}'`;
        const instance = await read(
            what, () => readers.spanner.getInstance(project, table.instance));
        if (!('result' in instance)) return instance;
        const configName = instance.result.config;
        if (!configName) return {error: `${what} gave no instance config.`};
        const configWhat = `reading instance config '${configName}'`;
        const config = await read(
            configWhat, () => readers.spanner.getInstanceConfig(configName));
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

// `location` in lower case, or an error when the read `what` gave none.
// The services have always given one; this keeps a response without it from
// stopping the push with a crash.
function located(location: string|undefined, what: string, missing: string):
    Read<string> {
  return location ? {result: location.toLowerCase()} :
                    {error: `${what} gave ${missing}.`};
}
