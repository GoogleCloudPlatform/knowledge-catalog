// Pull: fetch a semantic model from a live Knowledge Catalog into the IR.
//
// The read-direction counterpart of `deployKnowledgeCatalog` (push, in
// `deploy_knowledge_catalog.ts`). Unlike a write, a pull needs no server-side
// type provisioning -- only that the `semantic-*` entries exist. It enumerates
// the entry group, keeps the semantic entries, hydrates each one's aspect data
// (a BASIC list omits aspect data, so each entry is re-fetched with its aspect
// types -- an entity needs BOTH its `semantic-entity` aspect and the built-in
// `schema` aspect), and hands the hydrated entries to the pure reader
// (`kc_converter.modelsFromCatalogResources`). With the first-generation
// aspects it also returns the file copies a push stored of the model and
// profile files, for the caller to write instead of the rebuilt model.
//
// TODO(#278): Layer 2 push/pull symmetry. This is the pull half over the
// pure `kc_converter` codec; the push half (`deployKnowledgeCatalog`) still
// lives in `deploy_knowledge_catalog.ts`. Once #278 merges, rename that
// file to `push_kc.ts` (repointing `src/tool/commands.ts` and its test) so
// the orchestration layer reads as `push_kc` / `pull_kc`. Rename only -- no
// logic moves.

import {CatalogClient, Entry, EntryLink} from '../gcp/dataplex';

import {SemanticModel} from './ir';
import {actionAspectTypes} from './kc_actions';
import {constraintAspectTypes} from './kc_constraints';
import {ACTION_TYPE_ID, CONSTRAINT_TYPE_ID, FILE_COPY_TYPE_ID, FileCopy} from './kc_custom_types';
import {idOf, linkDedupKey, modelsFromCatalogResources} from './kc_converter';
import {loadSqlEngine} from './sql_parser';

export interface KcPullOptions {
  // Project that owns the source entry group.
  project: string;
  // Location (region) of the source entry group, e.g. `global` or `us`.
  location: string;
  // Id of the source entry group to pull from.
  entryGroup: string;
  // Read the second-generation built-in aspect fields and entry-id layout
  // (selected via KC_V2_ASPECTS=1). Off by default (absent means false).
  v2Aspects?: boolean;
}

export interface KcPullResult {
  models: SemanticModel[];
  // The file copies a push stored for the model, sorted by file name. Set
  // only with v2Aspects off. Empty when the catalog holds no copy of the
  // model file, `<model>.yaml`; the caller then writes the model rebuilt from
  // the aspects.
  rawFiles?: FileCopy[];
  warnings: string[];
}

// Upper bound on in-flight aspect-hydration fetches during a pull.
const HYDRATE_CONCURRENCY = 8;

// The built-in schema-join entry link type. Relationships publish as links of
// this type; it is a system type that is referenced (never created), so it
// always lives in `dataplex-types/global` regardless of where the model's own
// entries live (see knowledge_catalog.ts). Pull filters :lookupEntryLinks to
// exactly it, so a group's other links are never fetched or considered.
const SCHEMA_JOIN_LINK_TYPE =
    'projects/dataplex-types/locations/global/entryLinkTypes/schema-join';

// Reads the semantic model back from a Knowledge Catalog entry group. Emits no
// console output; soft warnings (from the reader) are returned for the caller
// to print. Hard failures -- more than one model in the group, a fetch error
// on any entry or its links, or file copies that are not one finished push's
// -- throw, so the pull aborts rather than write a partial model.
export async function pullKnowledgeCatalog(
    cat: CatalogClient, opts: KcPullOptions): Promise<KcPullResult> {
  await loadSqlEngine();
  const destination = `${opts.project}.${opts.location}.${opts.entryGroup}`;
  const warnings: string[] = [];

  // Enumerate the group (paging is inherently sequential) and pick the semantic
  // entries, then hydrate their aspects concurrently: a BASIC list omits aspect
  // data, so each entry needs its own lookupEntry, and those fetches are
  // independent. The pool preserves input order so warnings stay deterministic.
  const targets: {entry: Entry; aspectTypes: string[]}[] = [];
  for await (const entry of cat.listEntries(
      opts.project, opts.location, opts.entryGroup)) {
    // With v2Aspects on, a pull returns no file copies, so it fetches none.
    if (opts.v2Aspects && isFileCopyEntry(entry)) continue;
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
    const ids = anchors.map(a => idOf(a.entry.name)).sort();
    throw new Error(
        `entry group ${destination} holds ${anchors.length} semantic models (${
            ids.join(
                ', ')}); expected exactly one. Remove the extra anchor(s) ` +
        `from the catalog and pull again.`);
  }

  // Hydrate every semantic entry. A failed fetch means part of the model would
  // be silently missing, so abort rather than reconstruct an incomplete model.
  const hydrated = await mapConcurrent(
      targets, HYDRATE_CONCURRENCY, async ({entry, aspectTypes}) => {
        const res = await cat.lookupEntry(
            opts.project, opts.location, entry.name, aspectTypes);
        if (res.status !== 200 || !res.result) {
          throw new Error(`failed to fetch entry '${entry.name}' (status ${
              res.status}); pull aborted`);
        }
        return res.result;
      });

  // Second fetch pass: relationships are schema-join entry links, which the
  // entry list/lookup does not return. The catalog exposes links only per
  // referenced entry (:lookupEntryLinks), so fan out over the entity entries
  // and dedup (linkDedupKey) -- schema-join is undirected, so each link comes
  // back once from each of its two endpoints. An entity with no relationships
  // returns an empty list (expected, not warned); a non-200 is a real fetch
  // error and aborts the pull.
  const entityEntries = hydrated.filter(
      e => e.entryType?.endsWith('/entryTypes/semantic-entity'));
  const linkLists =
      await mapConcurrent(entityEntries, HYDRATE_CONCURRENCY, async entry => {
        const res = await cat.lookupEntryLinks(opts.project, opts.location, {
          entry: entry.name,
          entryLinkTypes: [SCHEMA_JOIN_LINK_TYPE],
        });
        if (res.status !== 200 || !res.result) {
          throw new Error(
              `failed to fetch entry links for '${entry.name}' ` +
              `(status ${res.status}); pull aborted`);
        }
        return res.result;
      });

  const seenLinks = new Set<string>();
  const entryLinks: EntryLink[] = [];
  for (const links of linkLists) {
    for (const link of links) {
      const key = linkDedupKey(link);
      if (seenLinks.has(key)) continue;
      seenLinks.add(key);
      entryLinks.push(link);
    }
  }

  const read = modelsFromCatalogResources(hydrated, entryLinks);
  if (opts.v2Aspects) {
    warnings.push(...read.warnings);
    return {models: read.models, warnings: [...new Set(warnings)]};
  }
  // A copy belongs to the group's one model, so with no model there are none.
  if (!read.models.length) {
    warnings.push(...read.warnings);
    return {models: [], rawFiles: [], warnings: [...new Set(warnings)]};
  }

  // The first-generation aspects cannot hold the whole model, so the caller
  // writes these copies instead of the model rebuilt from the aspects. That
  // needs the copy of the model file, `<model>.yaml`, which is where pull
  // writes the model. Without it the rebuilt model is written, as for a model
  // pushed before copies were stored.
  const model = read.models[0].name;
  // The model's own copies sit under its anchor's `.files.` prefix. A copy
  // another model left behind is not one of them.
  const own = `${idOf(anchors[0].entry.name)}.files.`;
  const before = warnings.length;
  const copies = readFileCopies(
      hydrated.filter(e => idOf(e.name).startsWith(own)), warnings);
  const skipped = warnings.slice(before);
  // Every copy one push stores carries that push's id and how many copies it
  // stored. Copies whose ids differ, or of which only some carry one, or a
  // number of copies other than that count, mean the last push stopped
  // partway. Writing them would mix files from two pushes or leave one out.
  const count = copies[0]?.pushFileCount;
  const unfinished = new Set(copies.map(f => f.pushId)).size > 1 ?
      'its file copies in the catalog come from different pushes' :
      count !== undefined && copies.length < count ?
      `the catalog holds ${copies.length} of its ${count} file copies` :
      count !== undefined && copies.length > count ?
      `the catalog holds ${copies.length} file copies, but the push stored ` +
          `${count}` :
      undefined;
  if (unfinished) {
    // A skipped copy is often why the count is off, so its warning goes with
    // the error.
    throw new Error(
        `the last push of model '${model}' did not finish: ${unfinished}, ` +
        `so pull writes nothing. Push again, then pull.` +
        skipped.map(w => ` ${w}.`).join(''));
  }
  if (copies.some(f => f.fileName === `${model}.yaml`)) {
    // The rebuilt model is not written, so its warnings are left out.
    return {
      models: read.models,
      rawFiles: copies,
      warnings: [...new Set(warnings)],
    };
  }
  warnings.push(...read.warnings);
  warnings.push(
      copies.length ?
          `the stored copies of model '${model}' hold no '${model}.yaml', so ` +
              `the model file is rebuilt from the catalog's aspects and may ` +
              `differ from what was pushed` :
          'no stored copy of the model file was found, so it is rebuilt from ' +
              'the catalog\'s aspects and may differ from what was pushed; ' +
              'push it again to store a copy');
  return {models: read.models, rawFiles: [], warnings: [...new Set(warnings)]};
}


// True when an entry is a file copy, matched by its entry type's id suffix so
// the project the custom type lives in need not be known.
function isFileCopyEntry(entry: Entry): boolean {
  return entry.entryType?.endsWith(`/entryTypes/${FILE_COPY_TYPE_ID}`) ?? false;
}

// The file copies among the hydrated entries, sorted by file name, each with
// the push id and copy count it carries. A copy whose aspect holds no file
// name or no content is skipped with a warning.
function readFileCopies(entries: Entry[], warnings: string[]): FileCopy[] {
  const files: FileCopy[] = [];
  for (const entry of entries) {
    if (!isFileCopyEntry(entry)) continue;
    const aspect = Object.entries(entry.aspects ?? {}).find(
        ([key, a]) => key.endsWith(`.${FILE_COPY_TYPE_ID}`) ||
            (a.aspectType ?? '').endsWith(`/aspectTypes/${FILE_COPY_TYPE_ID}`));
    const data = aspect?.[1].data;
    if (typeof data?.fileName !== 'string' || data.fileName === '' ||
        typeof data.content !== 'string') {
      warnings.push(
          `file copy '${idOf(entry.name)}' holds no file name or no ` +
          `content; it is skipped`);
      continue;
    }
    files.push({
      fileName: data.fileName,
      content: data.content,
      ...(typeof data.pushId === 'string' ? {pushId: data.pushId} : {}),
      ...(typeof data.pushFileCount === 'number' ?
              {pushFileCount: data.pushFileCount} :
              {}),
    });
  }
  return files.sort(
      (a, b) => a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0);
}


// The aspect type resource names to hydrate for a semantic entry, derived from
// its entryType (the aspect types are the parallel resources in the same
// project/location). Every entry also carries the built-in `guidelines` aspect
// (ai_context instructions); an entity additionally carries the built-in
// `schema` aspect that holds its fields, keys, and unique constraints. Returns
// undefined for entries that are not part of a semantic model.
function semanticAspectTypes(entryType: string): string[]|undefined {
  const marker = '/entryTypes/';
  const idx = entryType?.indexOf(marker) ?? -1;
  if (idx < 0) return undefined;
  const typeBase = entryType.slice(0, idx);
  const t = entryType.slice(idx + marker.length);
  const aspectType = (name: string) => `${typeBase}/aspectTypes/${name}`;
  switch (t) {
    case 'semantic-model':
      return [aspectType('semantic-model'), aspectType('guidelines')];
    case 'semantic-entity':
      return [
        aspectType('semantic-entity'), aspectType('schema'),
        aspectType('guidelines')
      ];
    case 'semantic-metric':
      return [aspectType('semantic-metric'), aspectType('guidelines')];
    case ACTION_TYPE_ID:
      // An action's entry type is custom (see kc_custom_types.ts), so it
      // lives in the destination project rather than under `dataplex-types`;
      // `typeBase` already points there, and kc_actions.ts names the aspects
      // to fetch beneath it.
      return actionAspectTypes(typeBase);
    case CONSTRAINT_TYPE_ID:
      // Custom for the same reason, and named through the same `typeBase`.
      return constraintAspectTypes(typeBase);
    case FILE_COPY_TYPE_ID:
      // Custom too: one aspect holding the file's name and text.
      return [aspectType(FILE_COPY_TYPE_ID)];
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
