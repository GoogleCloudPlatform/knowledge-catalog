// Pull: fetch a semantic model from a live Knowledge Catalog into the IR.
//
// The read-direction counterpart of `deployKnowledgeCatalog` (push, in
// `deploy_knowledge_catalog.ts`). Unlike a write, a pull needs no server-side
// type provisioning -- only that the `semantic-*` entries exist. It enumerates
// the entry group, keeps the semantic entries, hydrates each one's aspect data
// (a BASIC list omits aspect data, so each entry is re-fetched with the
// aspect types of its second-generation entry type), and hands the hydrated
// entries to the pure reader (`kc_converter.modelsFromCatalogResources`). A
// model an older kcmd pushed with the first-generation types is left out, and
// a warning names it.
//
// TODO(#278): Layer 2 push/pull symmetry. This is the pull half over the
// pure `kc_converter` codec; the push half (`deployKnowledgeCatalog`) still
// lives in `deploy_knowledge_catalog.ts`. Once #278 merges, rename that
// file to `push_kc.ts` (repointing `src/tool/commands.ts` and its test) so
// the orchestration layer reads as `push_kc` / `pull_kc`. Rename only -- no
// logic moves.

import {catalogContainer, CatalogClient, Entry} from '../gcp/dataplex';

import {actionAspectTypes} from './kc_actions';
import {constraintAspectTypes} from './kc_constraints';
import {FirstGenerationModel, modelsFromCatalogResources, ReadResult} from './kc_converter';
import {ACTION_TYPE_ID, CONSTRAINT_TYPE_ID, PUSH_STATE_LABEL, PUSH_WRITING} from './kc_custom_types';
import {entryIdOf} from './kc_ids';
import {loadSqlEngine} from './sql_parser';

export interface KcPullOptions {
  // Project that owns the source entry group.
  project: string;
  // Location (region) of the source entry group, e.g. `global` or `us`.
  location: string;
  // Id of the source entry group to pull from.
  entryGroup: string;
}

// Upper bound on in-flight aspect-hydration fetches during a pull.
const HYDRATE_CONCURRENCY = 8;

// Reads the semantic model back from a Knowledge Catalog entry group. Emits no
// console output; soft warnings (from the reader) are returned for the caller
// to print. Hard failures -- more than one model in the group, a fetch error
// on any entry, or a model entry still labeled as being written -- throw, so
// the pull aborts rather than write a partial model.
export async function pullKnowledgeCatalog(
    cat: CatalogClient, opts: KcPullOptions): Promise<ReadResult> {
  await loadSqlEngine();
  const destination = `${opts.project}.${opts.location}.${opts.entryGroup}`;

  // Enumerate the group (paging is inherently sequential) and pick the semantic
  // entries, then hydrate their aspects concurrently: a BASIC list omits aspect
  // data, so each entry needs its own lookupEntry, and those fetches are
  // independent. The pool preserves input order so warnings stay deterministic.
  const targets: {entry: Entry; aspectTypes: string[]}[] = [];
  for await (const entry of cat.listEntries(
      opts.project, opts.location, opts.entryGroup)) {
    const aspectTypes = semanticAspectTypes(entry.entryType);
    if (aspectTypes) targets.push({entry, aspectTypes});
    // else: not part of a semantic model; ignore it.
  }

  // An entry group holds exactly one semantic model. Zero anchors is a clean
  // "nothing to pull" (the reader returns no models); more than one is an
  // unexpected catalog state we refuse to guess through -- name the anchors and
  // fail so it can be fixed at the source.
  const anchors = targets.filter(
      t => t.entry.entryType?.endsWith('/entryTypes/semantic-model'));
  if (anchors.length > 1) {
    const ids = anchors.map(a => entryIdOf(a.entry.name)).sort();
    throw new Error(
        `entry group ${destination} holds ${anchors.length} semantic models (${
            ids.join(
                ', ')}); expected exactly one. Remove the extra anchor(s) ` +
        `from the catalog and pull again.`);
  }

  // Hydrate every semantic entry. A failed fetch means part of the model would
  // be silently missing, so abort rather than reconstruct an incomplete model.
  const hydrated = await mapConcurrent(
      targets, HYDRATE_CONCURRENCY,
      ({entry, aspectTypes}) =>
          fetchEveryAspect(cat, opts, entry, aspectTypes));

  const read = modelsFromCatalogResources(hydrated);
  // Every push labels the model entry as writing when it writes the model entry
  // and as finished with its last. The hydrated entries keep the order of
  // `targets`.
  const anchor =
      anchors.length ? hydrated[targets.indexOf(anchors[0])] : undefined;
  const writingReason =
      anchor?.entrySource?.labels?.[PUSH_STATE_LABEL] === PUSH_WRITING ?
      `its model entry's ${PUSH_STATE_LABEL} label still says ${PUSH_WRITING}` :
      undefined;
  if (writingReason) {
    // A model an older kcmd pushed is not in `read.models`, so the model is
    // named from its entry, as the reader names it.
    throw notFinished(
        anchor!.entrySource?.displayName ?? entryIdOf(anchor!.name),
        writingReason);
  }
  const warnings = [...read.warnings];
  for (const m of read.firstGeneration ?? []) {
    warnings.push(firstGenerationWarning(opts, m));
  }
  return {...read, warnings: [...new Set(warnings)]};
}

// The error for a model whose last push stopped partway, for `reason`.
function notFinished(model: string, reason: string): Error {
  return new Error(
      `the last push of model '${model}' did not finish: ${reason}, so pull ` +
      `writes nothing. Push again, then pull.`);
}


// The model, entity and metric aspect types a first-generation push writes, in
// the order the warning names them.
const FIRST_GEN_ASPECTS = ['semantic-model', 'semantic-entity', 'semantic-metric'];

// The warning for a model an older kcmd pushed, which pull leaves out. It
// names the first-generation aspect types found on the model's entries.
function firstGenerationWarning(
    opts: KcPullOptions, model: FirstGenerationModel): string {
  const found = new Set(model.entries.flatMap(
      e => Object.values(e.aspects ?? {})
               .map(a => a.aspectType?.split('/aspectTypes/')[1])));
  const types = FIRST_GEN_ASPECTS.filter(t => found.has(t));
  return `model '${model.name}' in entry group '${opts.entryGroup}' was ` +
      `pushed by an older kcmd (first-generation aspects: ${
             types.join(', ')}). Pull wrote nothing for it; push it again ` +
      `with the current kcmd`;
}


// Fetches `entry` with the aspects of `aspectTypes`, at `paths` when given.
// Throws on a failed fetch.
async function fetchEntry(
    cat: CatalogClient, opts: KcPullOptions, entry: Entry,
    aspectTypes: string[], paths?: string[]): Promise<Entry> {
  const res = await cat.lookupEntry(
      opts.project, opts.location, entry.name,
      {aspects: aspectTypes, paths});
  if (res.status !== 200 || !res.result) {
    throw new Error(`failed to fetch entry '${entry.name}' (status ${
        res.status}); pull aborted`);
  }
  return res.result;
}

// Most aspects Dataplex returns for one entry in one read.
const MAX_ASPECTS_PER_READ = 100;
// Most bytes of path and query Dataplex accepts in a GET.
const MAX_URL_BYTES = 16_384;

// Fetches `entry` with every aspect of `aspectTypes`, one read at a time. A
// read that returns MAX_ASPECTS_PER_READ is repeated once per type, and a type
// that returns that many is read again at the entry and at each field.
async function fetchEveryAspect(
    cat: CatalogClient, opts: KcPullOptions, entry: Entry,
    aspectTypes: string[]): Promise<Entry> {
  const full = (e: Entry) =>
      Object.keys(e.aspects ?? {}).length >= MAX_ASPECTS_PER_READ;
  const read = await fetchEntry(cat, opts, entry, aspectTypes);
  if (!full(read)) return read;
  const byType: Entry[] = [];
  for (const t of aspectTypes) {
    byType.push(await fetchEntry(cat, opts, entry, [t]));
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
    for (const batch of pathBatches(opts, entry, t, paths)) {
      byPath.push(await fetchEntry(cat, opts, entry, [t], batch));
    }
  }
  const reads = [...byType, ...byPath];
  return {...read, aspects: Object.assign({}, ...reads.map(r => r.aspects))};
}

// Splits `paths` into batches for reads of `type` on `entry`, each within
// MAX_URL_BYTES. A batch holds fewer than MAX_ASPECTS_PER_READ paths, and a
// path holds at most one instance of a type, so no read comes back cut.
function pathBatches(
    opts: KcPullOptions, entry: Entry, type: string,
    paths: string[]): string[][] {
  // Bytes of `params` in the URL, with the '?' or '&' before them.
  const bytes = (params: string[][]) =>
      new URLSearchParams(params).toString().length + 1;
  const base =
      `/v1/${catalogContainer(opts.project, opts.location)}:lookupEntry`
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
function semanticAspectTypes(entryType: string): string[]|undefined {
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


// Maps `items` through `fn` with at most `limit` calls in flight, returning
// results in input order (so downstream ordering stays deterministic).
async function mapConcurrent<T, R>(
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
