// Deploys a semantic model's Knowledge Catalog resources.
//
// This is the Knowledge Catalog leg of `kcmd push` for the semantic-model
// scope, the counterpart to `deploy_bigquery.ts`. It consumes models already
// parsed into the semantic IR (see loadSemanticModels, shared with the BigQuery
// leg so a `--target all` push parses each document once), maps each to catalog
// Entries + Aspects (the pure emitter in knowledge_catalog.ts), and writes them
// through the Knowledge Catalog client.
//
// Types: the `semantic-model`/`semantic-entity`/`semantic-metric` entry and
// aspect types — and the built-in `schema` aspect — are built-in system types
// in `dataplex-types/global`. Push does NOT provision any type, nor the entry
// group (that is created at `init`); it only writes entries. The caller needs
// `dataplex.entryGroups.useSemanticModelAspect` on the destination entry group.
//
// Publish sequence (mirrors the BigQuery leg's structure):
//   * Create each model's entries in array order: the semantic-model anchor
//     first (it is the parentEntry of every entity/metric entry), then the
//     children concurrently. No entry-group or type creation -- the entry
//     group is provisioned at `init` and the system types are built-in.
//   * A re-push upserts: an entry that already exists is updated in place.
//   * Reconcile deletions: an entity or metric removed from a still-present
//     model leaves an orphaned entry under its anchor; after writing, delete
//     any entry this push owns (by entry-id prefix) that was not re-emitted.
//   * Relationship edges are not published (no writable directed link type over
//     semantic-entity endpoints); the emitter warns and the edges live in the
//     BigQuery property graph.
//
// This is a library module: it emits no console output. Warnings and the
// dry-run plan are returned in `KcDeployResult` for the CLI (commands.ts) to
// print.
//

import {ApiResult} from '../gcp/api';
import * as context from '../gcp/context';
import {CatalogClient, Entry} from '../gcp/dataplex';

import {generateCatalogResources, KcResources} from './knowledge_catalog';
import {LoadedModel} from './loader';


export interface KcDeployOptions {
  // The resolved Knowledge Catalog destination (flag overrides applied over the
  // catalog.yaml scope defaults).
  project: string;
  location: string;
  entryGroup: string;
  // Where the built-in `semantic-*` / `schema` system types are referenced.
  // Default: `dataplex-types` / `global`. Overridable to reference them from a
  // staging project; the emitted entries are otherwise unchanged.
  systemTypeProject?: string;
  systemTypeLocation?: string;
  // Compile + report only; never writes.
  validateOnly?: boolean;
  // entries.create can briefly 404 on a just-created entry group; retry that
  // window. Overridable so tests can exercise the path without burning
  // wall-clock.
  entryCreateTries?: number;
  entryCreateRetryMs?: number;
}

export interface KcDeployResult {
  success: boolean;
  details?: string;
  // Loader and emitter warnings collected across all documents.
  warnings: string[];
  // Entries created / updated-in-place / deleted (all 0 for validateOnly).
  created: number;
  updated: number;
  deleted: number;
  // A human-readable plan of what would be written; populated for validateOnly.
  plan: string[];
}


// entries.create propagation retry: a just-created entry group can briefly 404.
const ENTRY_CREATE_TRIES = 3;
const ENTRY_CREATE_RETRY_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}


// Deploys the Knowledge Catalog resources for each authored model document.
// Emits no console output; warnings and the dry-run plan are returned for the
// caller to print. `defaultProject` qualifies a dataset `source` that omits its
// project (the scope's declared project, a deterministic user-authored value).
export async function deployKnowledgeCatalog(
    models: LoadedModel[], ctx: context.ApiContext,
    opts: KcDeployOptions): Promise<KcDeployResult> {
  const warnings: string[] = [];
  const plan: string[] = [];
  let created = 0;
  let updated = 0;
  let deleted = 0;
  let modelsSeen = 0;

  const fail = (details: string): KcDeployResult =>
      ({success: false, details, warnings, created, updated, deleted, plan});

  // Emit every model up front (pure): dry-run and warnings need no network, and
  // a generation warning surfaces even if a later write fails.
  const emitted: {model: string; resources: KcResources}[] = [];
  for (const {document, model} of models) {
    modelsSeen++;
    // The emitter is pure but not infallible: bigQueryGraphTargets (reached
    // via the semantic-model aspect) throws on a malformed GOOGLE
    // custom_extension. Report it against the document -- as the BigQuery leg
    // does -- rather than letting it escape as an uncaught stack trace.
    let resources: KcResources;
    try {
      resources = generateCatalogResources(model, {
        project: opts.project,
        location: opts.location,
        entryGroup: opts.entryGroup,
        systemTypeProject: opts.systemTypeProject,
        systemTypeLocation: opts.systemTypeLocation,
      });
    } catch (err: any) {
      return fail(
          `Model '${model.name}' (${document}): ${err.message || err}`);
    }
    for (const w of resources.warnings) {
      warnings.push(`[${model.name}] ${w}`);
    }
    emitted.push({model: model.name, resources});
  }

  // A parsed document always yields at least one model (the loader enforces
  // `semantic_model` min 1), so modelsSeen is 0 only when no documents were
  // found. validateOnly mutates nothing, so an empty workspace is a clean no-op
  // there; a real push treats it as a configuration error worth flagging.
  if (!modelsSeen) {
    if (opts.validateOnly) {
      warnings.push('No semantic model documents found; nothing to validate.');
      return {success: true, warnings, created, updated, deleted, plan};
    }
    return fail('No semantic model documents found; nothing to deploy.');
  }

  // Entry ids must be unique within the destination entry group. The emitter
  // dedups within one model, but two models in a single push (two documents, or
  // two `semantic_model`s in one document) whose names normalize to the same id
  // generate colliding entry names; on publish the later one would 409 and
  // silently upsert over the earlier. Catch that across models here and fail
  // before any write, naming the entry so the author can rename one model. The
  // owner is tracked by index, not model name, so two same-named models (the
  // most common collision) are still distinguished.
  const entryOwner = new Map<string, number>();
  for (let i = 0; i < emitted.length; i++) {
    for (const entry of emitted[i].resources.entries) {
      const prev = entryOwner.get(entry.name);
      if (prev !== undefined && prev !== i) {
        return fail(
            `models '${emitted[prev].model}' and '${emitted[i].model}' both ` +
            `generate catalog entry '${idOf(entry.name)}'; entry ids must be ` +
            `unique within entry group '${opts.entryGroup}' -- rename one ` +
            `model.`);
      }
      entryOwner.set(entry.name, i);
    }
  }

  for (const {model, resources} of emitted) {
    plan.push(...planSummary(model, resources, opts));
  }
  if (opts.validateOnly) {
    return {success: true, warnings, created, updated, deleted, plan};
  }

  // The destination entry group is provisioned at `init`, not here: push writes
  // only entries, matching how the standard layout's push operates (it creates
  // entries, never the entry group). A missing group surfaces as a clear entry
  // creation error, and createEntryWithRetry rides out the brief post-init
  // propagation window.
  const cat = new CatalogClient(ctx);

  for (const {model, resources} of emitted) {
    const outcome = await createEntries(cat, opts, resources.entries);
    if (outcome.error) {
      return fail(`Model '${model}': ${outcome.error}`);
    }
    created += outcome.created;
    updated += outcome.updated;
  }

  // Reconcile deletions: an entity or metric removed from a still-present model
  // since the last push leaves an orphaned entry under the model's anchor.
  // Delete any entry this push owns that was not re-emitted (see
  // reconcileDeletions). Runs only on a real push -- validateOnly returned
  // above and never lists remote state.
  const recon = await reconcileDeletions(cat, opts, emitted);
  if (recon.error) {
    return fail(recon.error);
  }
  deleted = recon.deleted;

  return {success: true, warnings, created, updated, deleted, plan};
}


interface ReconcileOutcome {
  deleted: number;
  error?: string;
}

// Deletes entries this push OWNS but did not re-emit -- the entities/metrics
// removed from a model since its last push. Ownership is scoped by entry id so
// reconciliation never touches entries outside the models in this push (a
// shared entry group may legitimately hold others): an existing entry is owned
// when its id is a pushed model's anchor id or is prefixed by that anchor's
// `<model>.entities.` / `<model>.metrics.` child namespace. An anchor is always
// re-emitted, so it is never deleted here.
//
// TODO: reconcile whole-model removals too. Deleting a model's document drops
// its anchor from this push, so its anchor + children are no longer owned and
// survive. Removing them safely needs a scope-level record of which models this
// entry group manages (follow-up).
async function reconcileDeletions(
    cat: CatalogClient, opts: KcDeployOptions,
    emitted: {resources: KcResources}[]): Promise<ReconcileOutcome> {
  const emittedIds = new Set<string>();
  const anchorIds = new Set<string>();
  const childPrefixes: string[] = [];
  for (const {resources} of emitted) {
    for (const e of resources.entries) emittedIds.add(idOf(e.name));
    // entries[0] is the model anchor (the emitter writes it first).
    const anchorId = idOf(resources.entries[0].name);
    anchorIds.add(anchorId);
    childPrefixes.push(`${anchorId}.entities.`, `${anchorId}.metrics.`);
  }
  const owned = (id: string) =>
      anchorIds.has(id) || childPrefixes.some(p => id.startsWith(p));

  const orphans: string[] = [];
  try {
    for await (const entry of cat.listEntries(
        opts.project, opts.location, opts.entryGroup)) {
      const id = idOf(entry.name);
      if (owned(id) && !emittedIds.has(id)) orphans.push(id);
    }
  } catch (err: any) {
    return {deleted: 0, error: `listing entries to reconcile deletions: ${
                                   err.message || err}`};
  }

  let deleted = 0;
  for (const id of orphans) {
    const res =
        await cat.deleteEntry(opts.project, opts.location, opts.entryGroup, id);
    // A 404 means it is already gone -- reconciliation's goal is met either way.
    if (isOk(res) || res.status === 404) {
      deleted++;
      continue;
    }
    return {deleted, error: `deleting orphaned entry '${id}': ${errText(res)}`};
  }
  return {deleted};
}


interface EntriesOutcome {
  created: number;
  updated: number;
  error?: string;
}

// Creates a model's entries. The anchor (entries[0]) is the parent of every
// child and is written first. Entity entries are then written before metric
// entries -- a metric's aspect references its entity by name, so the entity must
// exist first -- and within each of those two waves the entries are independent
// and written concurrently. An entry that already exists is updated in place
// (idempotent re-push).
async function createEntries(
    cat: CatalogClient, opts: KcDeployOptions,
    entries: Entry[]): Promise<EntriesOutcome> {
  if (!entries.length) return {created: 0, updated: 0};
  const [anchor, ...children] = entries;

  const anchorRes = await writeEntry(cat, opts, anchor);
  if (anchorRes.error) return {created: 0, updated: 0, error: anchorRes.error};

  let created = anchorRes.updated ? 0 : 1;
  let updated = anchorRes.updated ? 1 : 0;

  // Entities first, then metrics (a metric references its entity); each wave is
  // written concurrently.
  const isMetric = (e: Entry) => (e.entryType ?? '').endsWith('/semantic-metric');
  for (const wave of [children.filter(e => !isMetric(e)),
                      children.filter(isMetric)]) {
    const res = await Promise.all(wave.map(e => writeEntry(cat, opts, e)));
    const firstErr = res.find(r => r.error);
    if (firstErr) return {created, updated, error: firstErr.error};
    for (const r of res) {
      if (r.updated)
        updated++;
      else
        created++;
    }
  }
  return {created, updated};
}


interface WriteOutcome {
  updated?: boolean;  // true when the entry already existed and was updated
  error?: string;
}

// Writes one entry: create (retrying the group-propagation window), then fall
// back to update-in-place if it already exists.
async function writeEntry(
    cat: CatalogClient, opts: KcDeployOptions,
    entry: Entry): Promise<WriteOutcome> {
  const entryId = idOf(entry.name);
  let res = await createEntryWithRetry(cat, opts, entryId, entry);
  if (isExists(res)) {
    // Idempotent re-push: refresh the existing entry's source + aspects.
    const upd = await cat.updateEntry(
        entry, ['entry_source', 'aspects'], Object.keys(entry.aspects ?? {}));
    if (!isOk(upd)) return {error: `entry '${entryId}': ${errText(upd)}`};
    return {updated: true};
  }
  if (!isOk(res)) return {error: `entry '${entryId}': ${errText(res)}`};
  return {};
}

// entries.create can briefly 404 on a just-created entry group; retry that
// window.
async function createEntryWithRetry(
    cat: CatalogClient, opts: KcDeployOptions, entryId: string,
    entry: Entry): Promise<ApiResult<Entry>> {
  const tries = opts.entryCreateTries ?? ENTRY_CREATE_TRIES;
  const retryMs = opts.entryCreateRetryMs ?? ENTRY_CREATE_RETRY_MS;
  let res = await cat.createEntry(
      opts.project, opts.location, opts.entryGroup, entryId, entry);
  for (let attempt = 1; attempt < tries; attempt++) {
    if (isOk(res) || isExists(res) || !isPropagating(res)) break;
    await sleep(retryMs);
    res = await cat.createEntry(
        opts.project, opts.location, opts.entryGroup, entryId, entry);
  }
  return res;
}


// A human-readable summary of what a (dry-run) push would write for one model.
function planSummary(
    model: string, resources: KcResources, opts: KcDeployOptions): string[] {
  const dest = `${opts.project}.${opts.location}.${opts.entryGroup}`;
  const lines = [
    `Knowledge Catalog plan for '${model}' (destination ${dest}):`,
    `  ${resources.entries.length} entr${
        resources.entries.length === 1 ? 'y' : 'ies'}:`,
    ...resources.entries.map(
        e => `    - ${idOf(e.name)} (${idOf(e.entryType)})`),
  ];
  return lines;
}


// The id segment of a full entry/entryType resource name (after the last '/').
function idOf(name: string): string {
  return name.split('/').pop() ?? name;
}

function isOk(res: {status: number}): boolean {
  return res.status === 200;
}

// A create that failed because the resource already exists — treated as success
// for idempotent provisioning and re-push. The API layer preserves the HTTP
// status (gcp/api.ts), so the 409 ALREADY_EXISTS status is authoritative; no
// need to match the error text.
function isExists(res: {status: number}): boolean {
  return res.status === 409;
}

// A transient "not visible yet" error worth retrying, matching the propagation
// phrasing specifically rather than a bare "not found" (which also covers a
// genuinely missing aspect/entry type — a real, non-transient failure).
function isPropagating(res: {message?: string}): boolean {
  const msg = res.message ?? '';
  return /may not exist/i.test(msg) ||
      /entry group .*(not found|does not exist)/i.test(msg);
}

function errText(res: {status: number; message?: string}): string {
  return res.message?.trim() || `HTTP ${res.status}`;
}
