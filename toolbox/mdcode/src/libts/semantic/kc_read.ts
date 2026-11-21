// Reads of semantic-model entries that push and pull share.
//
// Knowledge Catalog returns the data of at most 100 aspects of one entry in
// one read, so an entry with more is read again by aspect type and by field
// path until every instance is in.

import {ApiResult} from '../gcp/api';
import {catalogContainer, CatalogClient, Entry, FixOptions} from '../gcp/dataplex';

import {actionAspectTypes} from './kc_actions';
import {constraintAspectTypes} from './kc_constraints';
import {ACTION_TYPE_ID, CONSTRAINT_TYPE_ID} from './kc_custom_types';

// Upper bound on entry reads in flight.
export const READ_CONCURRENCY = 8;

// Where an entry group is: its project and location.
interface Place {
  project: string;
  location: string;
}

// Most aspects Dataplex returns for one entry in one read.
const MAX_ASPECTS_PER_READ = 100;
// Most bytes of path and query Dataplex accepts in a GET.
const MAX_URL_BYTES = 16_384;

// Reads `entry` with the aspects of `aspectTypes`, at `paths` when given.
function readEntry(
    cat: CatalogClient, place: Place, entry: Entry, aspectTypes: string[],
    fix: FixOptions, paths?: string[]): Promise<ApiResult<Entry>> {
  return cat.lookupEntry(
      place.project, place.location, entry.name, {aspects: aspectTypes, paths},
      fix);
}

// Whether `res` is a read that returned an entry.
function isRead(res: ApiResult<Entry>): boolean {
  return res.status === 200 && res.result !== undefined;
}

/**
 * Reads `entry` with every aspect of `aspectTypes`, one read at a time, and
 * returns the first response that failed or carried no entry. A read that
 * returns MAX_ASPECTS_PER_READ is repeated once per type, and a type that
 * returns that many is read again at the entry and at each field. Every read
 * passes `fix` to the client.
 */
export async function readEveryAspect(
    cat: CatalogClient, place: Place, entry: Entry, aspectTypes: string[],
    fix: FixOptions = {}): Promise<ApiResult<Entry>> {
  const full = (e: Entry) =>
      Object.keys(e.aspects ?? {}).length >= MAX_ASPECTS_PER_READ;
  const read = await readEntry(cat, place, entry, aspectTypes, fix);
  if (!isRead(read) || !full(read.result!)) return read;
  const byType: Entry[] = [];
  for (const t of aspectTypes) {
    const res = await readEntry(cat, place, entry, [t], fix);
    if (!isRead(res)) return res;
    byType.push(res.result!);
  }
  const schema =
      byType[aspectTypes.findIndex(t => t.endsWith('/aspectTypes/schema'))];
  const paths = [
    '',
    ...Object.values(schema?.aspects ?? {})
        .flatMap(a => a.data?.fields ?? [])
        .map(f => `Schema.${f.name}`)
  ];
  const byPath: Entry[] = [];
  for (const t of aspectTypes.filter((_, i) => full(byType[i]))) {
    for (const batch of pathBatches(place, entry, t, paths)) {
      const res = await readEntry(cat, place, entry, [t], fix, batch);
      if (!isRead(res)) return res;
      byPath.push(res.result!);
    }
  }
  const reads = [...byType, ...byPath];
  return {
    status: 200,
    result: {
      ...read.result!,
      aspects: Object.assign({}, ...reads.map(r => r.aspects)),
    },
  };
}

// Splits `paths` into batches for reads of `type` on `entry`, each within
// MAX_URL_BYTES. A batch holds fewer than MAX_ASPECTS_PER_READ paths, and a
// path holds at most one instance of a type, so no read comes back cut.
function pathBatches(
    place: Place, entry: Entry, type: string, paths: string[]): string[][] {
  // Bytes of `params` in the URL, with the '?' or '&' before them.
  const bytes = (params: string[][]) =>
      new URLSearchParams(params).toString().length + 1;
  const base =
      `/v1/${catalogContainer(place.project, place.location)}:lookupEntry`
          .length +
      bytes([['entry', entry.name], ['view', 'CUSTOM'], ['aspectTypes', type]]);
  const batches: string[][] = [];
  let batch: string[] = [];
  let size = base;
  for (const path of paths) {
    const add = bytes([['paths', path]]);
    if (batch.length === MAX_ASPECTS_PER_READ - 1 ||
        size + add > MAX_URL_BYTES) {
      batches.push(batch);
      batch = [];
      size = base;
    }
    batch.push(path);
    size += add;
  }
  return [...batches, batch];
}

// Maps `items` through `fn` with at most `limit` calls in flight, returning
// results in input order (so downstream ordering stays deterministic).
export async function mapConcurrent<T, R>(
    items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failed = false;
  async function worker(): Promise<void> {
    // Stop claiming new items once any worker has thrown: Promise.all rejects on
    // the first failure, so fanning out more fetches is wasted work whose own
    // rejections would surface as unhandled-rejection noise.
    while (next < items.length && !failed) {
      const i = next++;
      try {
        results[i] = await fn(items[i]);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  }
  const workers =
      Array.from({length: Math.min(limit, items.length)}, () => worker());
  await Promise.all(workers);
  return results;
}


// The aspect types each second-generation entry type is read with.
const OBJECT_ASPECTS = ['guidelines', 'semantic-extensions', 'overview'];
const V2_ASPECT_TYPES = new Map([
  ['semantic-model', ['semantic-model', ...OBJECT_ASPECTS]],
  [
    'semantic-entity',
    ['semantic-entity', 'schema', 'sql-expressions', ...OBJECT_ASPECTS]
  ],
  [
    'semantic-metric', ['semantic-metric', 'sql-expressions', ...OBJECT_ASPECTS]
  ],
  ['semantic-relationship', ['semantic-relationship', ...OBJECT_ASPECTS]],
]);

// The aspect types to read for a semantic entry, in its entry type's project
// and location. Undefined for an entry outside a semantic model.
export function semanticAspectTypes(entryType: string): string[]|undefined {
  const marker = '/entryTypes/';
  const idx = entryType?.indexOf(marker) ?? -1;
  if (idx < 0) return undefined;
  const typeBase = entryType.slice(0, idx);
  const t = entryType.slice(idx + marker.length);
  const aspectType = (name: string) => `${typeBase}/aspectTypes/${name}`;
  const v2Types = V2_ASPECT_TYPES.get(t);
  if (v2Types) return v2Types.map(aspectType);
  switch (t) {
    case ACTION_TYPE_ID:
      // An action's entry type is custom (see kc_custom_types.ts), so it
      // lives in the destination project rather than under `dataplex-types`;
      // `typeBase` already points there, and kc_actions.ts names the aspects
      // to fetch beneath it.
      return actionAspectTypes(typeBase);
    case CONSTRAINT_TYPE_ID:
      // Custom for the same reason, and named through the same `typeBase`.
      return constraintAspectTypes(typeBase);
    default:
      return undefined;
  }
}
