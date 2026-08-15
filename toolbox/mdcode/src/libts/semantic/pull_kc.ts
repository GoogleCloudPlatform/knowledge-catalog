// Pull: fetch a semantic model from a live Knowledge Catalog into the IR.
//
// The read-direction counterpart of `deployKnowledgeCatalog` (push, in
// `deploy_knowledge_catalog.ts`). Unlike a write, a pull needs no server-side
// type provisioning -- only that the `semantic-*` entries exist. It enumerates
// the entry group, keeps the semantic entries, hydrates each one's aspect data
// (a BASIC list omits aspect data, so each entry is re-fetched with its aspect
// types -- an entity needs BOTH its `semantic-entity` aspect and the built-in
// `schema` aspect), and hands the hydrated entries to the pure reader
// (`kc_converter.modelsFromCatalogResources`).
//
// TODO(#278): Layer 2 push/pull symmetry. This is the pull half over the
// pure `kc_converter` codec; the push half (`deployKnowledgeCatalog`) still
// lives in `deploy_knowledge_catalog.ts`. Once #278 merges, rename that
// file to `push_kc.ts` (repointing `src/tool/commands.ts` and its test) so
// the orchestration layer reads as `push_kc` / `pull_kc`. Rename only -- no
// logic moves.

import {CatalogClient, Entry, EntryLink} from '../gcp/dataplex';

import {SemanticModel} from './ir';
import {idOf, linkDedupKey, modelsFromCatalogResources} from './kc_converter';

export interface KcPullOptions {
  project: string;
  location: string;
  entryGroup: string;
}

export interface KcPullResult {
  models: SemanticModel[];
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
// to print. Hard failures -- more than one model in the group, or a fetch error
// on any entry or its links -- throw, so the pull aborts rather than write a
// partial model.
export async function pullKnowledgeCatalog(
    cat: CatalogClient, opts: KcPullOptions): Promise<KcPullResult> {
  const destination = `${opts.project}.${opts.location}.${opts.entryGroup}`;
  const warnings: string[] = [];

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
  warnings.push(...read.warnings);

  return {models: read.models, warnings: [...new Set(warnings)]};
}


// The aspect type resource names to hydrate for a semantic entry, derived from
// its entryType (the aspect types are the parallel resources in the same
// project/location). An entity carries two aspects: its `semantic-entity`
// aspect and the built-in `schema` aspect that holds its fields. Returns
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
      return [aspectType('semantic-model')];
    case 'semantic-entity':
      return [aspectType('semantic-entity'), aspectType('schema')];
    case 'semantic-metric':
      return [aspectType('semantic-metric')];
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
