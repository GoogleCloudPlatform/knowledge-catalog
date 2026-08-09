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

import {CatalogClient, Entry} from '../gcp/dataplex';
import {SemanticModel} from './ir';
import {idOf, modelsFromCatalogResources} from './kc_converter';

export interface KcPullOptions {
  project: string;
  location: string;
  entryGroup: string;
  model?: string;  // limit to a single model by name (default: all)
}

export interface KcPullResult {
  models: SemanticModel[];
  warnings: string[];
}

// Upper bound on in-flight aspect-hydration fetches during a pull.
const HYDRATE_CONCURRENCY = 8;

// Reads the semantic models back from a Knowledge Catalog entry group. Emits no
// console output; warnings (skipped entries, no match for --model, reader
// warnings) are returned for the caller to print.
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

  // When scoped to one model, hydrate only that model's entries -- its anchor
  // (matched by name) plus the children pointing at it. A list already carries
  // entrySource + parentEntry, so this avoids fetching every other model's
  // aspects. No match short-circuits with just the not-found warning.
  let scoped = targets;
  if (opts.model) {
    scoped = scopeToModel(targets, opts.model);
    if (!scoped.length) {
      return {
        models: [],
        warnings: [
          `no semantic model named '${opts.model}' found in ${destination}`
        ],
      };
    }
  }

  const fetched = await mapConcurrent(
      scoped, HYDRATE_CONCURRENCY, async ({entry, aspectTypes}) => {
        const res = await cat.lookupEntry(
            opts.project, opts.location, entry.name, aspectTypes);
        if (res.status !== 200 || !res.result) {
          return {
            warning: `failed to fetch entry '${entry.name}' (status ${
                res.status}); skipped`
          };
        }
        return {entry: res.result};
      });

  const hydrated: Entry[] = [];
  for (const r of fetched) {
    if (r.entry)
      hydrated.push(r.entry);
    else if (r.warning)
      warnings.push(r.warning);
  }

  const read = modelsFromCatalogResources(hydrated);
  warnings.push(...read.warnings);

  // Defense in depth: keep only the requested model even if the reader surfaced
  // another anchor (e.g. a child whose parentEntry pointed outside the scope).
  let models = read.models;
  if (opts.model) {
    models = models.filter(m => m.name === opts.model);
    if (!models.length) {
      warnings.push(
          `no semantic model named '${opts.model}' found in ${destination}`);
    }
  }

  return {models, warnings: [...new Set(warnings)]};
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


// Restricts hydration targets to a single model: the semantic-model anchor
// whose name (entrySource.displayName, else the entry id) matches `model`, plus
// every child entry whose parentEntry is that anchor. Uses only list-level
// fields (no aspect data), so it runs before hydration and avoids fetching
// unrelated models' aspects. Returns [] when no anchor matches.
function scopeToModel(
    targets: {entry: Entry; aspectTypes: string[]}[],
    model: string): {entry: Entry; aspectTypes: string[]}[] {
  const isAnchor = (t: {entry: Entry}) =>
      !!t.entry.entryType?.endsWith('/entryTypes/semantic-model');
  const allAnchorNames = new Set(targets.filter(isAnchor).map(t => t.entry.name));
  const matchedAnchorNames = new Set(
      targets.filter(isAnchor)
          .filter(
              t => (t.entry.entrySource?.displayName ?? idOf(t.entry.name)) ===
                  model)
          .map(t => t.entry.name));
  if (!matchedAnchorNames.size) return [];
  // Mirror the reader's childrenOf (knowledge_catalog.ts): when the group holds
  // exactly one anchor, a child whose parentEntry resolves to no anchor (e.g. a
  // project-id normalization mismatch) still belongs to it. Without this a
  // scoped pull would drop children a full pull keeps.
  const soleAnchor =
      allAnchorNames.size === 1 ? [...allAnchorNames][0] : undefined;
  const soleMatched =
      soleAnchor !== undefined && matchedAnchorNames.has(soleAnchor);
  return targets.filter(
      t => matchedAnchorNames.has(t.entry.name) ||
          matchedAnchorNames.has(t.entry.parentEntry ?? '') ||
          (soleMatched && !isAnchor(t) &&
           !allAnchorNames.has(t.entry.parentEntry ?? '')));
}


// Maps `items` through `fn` with at most `limit` calls in flight, returning
// results in input order (so downstream ordering stays deterministic).
async function mapConcurrent<T, R>(
    items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  const workers =
      Array.from({length: Math.min(limit, items.length)}, () => worker());
  await Promise.all(workers);
  return results;
}
