// Deploys a semantic model's Knowledge Catalog resources.
//
// This is the Knowledge Catalog leg of `kcmd push` for the semantic-model
// scope, the counterpart to `deploy_bigquery.ts`. It parses each authored
// Ossie document into the semantic IR (loader), maps it to catalog Entries +
// Aspects (the pure emitter in knowledge_catalog.ts), and writes them through
// the Knowledge Catalog client.
//
// Types: the `semantic-model`/`semantic-entity`/`semantic-metric` entry and
// aspect types — and the built-in `schema` aspect — are built-in system types
// in `dataplex-types/global` (go/semantic-model-kc-v2). Push does NOT provision
// any type; it only ensures the destination entry group exists and then writes
// entries. The types are TIER2 `nonprod_only`, so this leg targets a nonprod
// catalog, and the caller needs `dataplex.entryGroups.useSemanticModelAspect`.
//
// Publish sequence (mirrors the BigQuery leg's structure):
//   * Ensure the destination entry group (idempotent; an "already exists" is
//     success). No aspect/entry type creation — the system types are built-in.
//   * Create each model's entries in array order: the semantic-model anchor
//     first (it is the parentEntry of every entity/metric entry), then the
//     children concurrently.
//   * A re-push upserts: an entry that already exists is updated in place.
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
import {loadModels} from './loader';


export interface KcDeployOptions {
  // The resolved Knowledge Catalog destination (flag overrides applied over the
  // catalog.yaml scope defaults).
  project: string;
  location: string;
  entryGroup: string;
  // Where the built-in `semantic-*` / `schema` system types are referenced.
  // Default: `dataplex-types` / `global`. Overridable for a staging project
  // during the nonprod-only window; the emitted entries are otherwise
  // unchanged.
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
  // Entries created / updated-in-place (0 for validateOnly).
  created: number;
  updated: number;
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
    docs: {name: string; text: string}[], ctx: context.ApiContext,
    opts: KcDeployOptions, defaultProject?: string): Promise<KcDeployResult> {
  const warnings: string[] = [];
  const plan: string[] = [];
  let created = 0;
  let updated = 0;
  let modelsSeen = 0;

  const fail = (details: string): KcDeployResult =>
      ({success: false, details, warnings, created, updated, plan});

  // Emit every model up front (pure): dry-run and warnings need no network, and
  // a generation warning surfaces even if a later write fails.
  const emitted: {model: string; resources: KcResources}[] = [];
  for (const doc of docs) {
    // A document that fails to parse (or violates the model schema) is an
    // authoring error; report it against the specific document rather than
    // letting the loader's exception propagate as an uncaught stack trace.
    let loaded;
    try {
      loaded =
          loadModels(doc.text, {defaultProject: defaultProject ?? ctx.project});
    } catch (err: any) {
      return fail(`Model document '${doc.name}': ${err.message || err}`);
    }
    for (const w of loaded.warnings) {
      warnings.push(`[${doc.name}] ${w}`);
    }
    for (const model of loaded.models) {
      modelsSeen++;
      const resources = generateCatalogResources(model, {
        project: opts.project,
        location: opts.location,
        entryGroup: opts.entryGroup,
        systemTypeProject: opts.systemTypeProject,
        systemTypeLocation: opts.systemTypeLocation,
      });
      for (const w of resources.warnings) {
        warnings.push(`[${model.name}] ${w}`);
      }
      emitted.push({model: model.name, resources});
    }
  }

  // A parsed document always yields at least one model (the loader enforces
  // `semantic_model` min 1), so modelsSeen is 0 only when no documents were
  // found. validateOnly mutates nothing, so an empty workspace is a clean no-op
  // there; a real push treats it as a configuration error worth flagging.
  if (!modelsSeen) {
    if (opts.validateOnly) {
      warnings.push('No semantic model documents found; nothing to validate.');
      return {success: true, warnings, created, updated, plan};
    }
    return fail('No semantic model documents found; nothing to deploy.');
  }

  for (const {model, resources} of emitted) {
    plan.push(...planSummary(model, resources, opts));
  }
  if (opts.validateOnly) {
    return {success: true, warnings, created, updated, plan};
  }

  const cat = new CatalogClient(ctx);

  // Ensure the destination entry group once (idempotent). A failure dooms every
  // entry write, so stop here.
  const group = await ensureEntryGroup(cat, opts);
  if (group) {
    return fail(group);
  }

  for (const {model, resources} of emitted) {
    const outcome = await createEntries(cat, opts, resources.entries);
    if (outcome.error) {
      return fail(`Model '${model}': ${outcome.error}`);
    }
    created += outcome.created;
    updated += outcome.updated;
  }

  return {success: true, warnings, created, updated, plan};
}


// Ensures the destination entry group exists. Returns an error message on a
// non-idempotent failure, or undefined on success (created or already existed).
async function ensureEntryGroup(
    cat: CatalogClient, opts: KcDeployOptions): Promise<string|undefined> {
  const res = await cat.createEntryGroup(
      opts.project, opts.location, opts.entryGroup, {} as any);
  if (isOk(res) || isExists(res)) return undefined;
  return `entry group '${opts.entryGroup}': ${errText(res)}`;
}


interface EntriesOutcome {
  created: number;
  updated: number;
  error?: string;
}

// Creates a model's entries. The anchor (entries[0]) is the parent of every
// child, so it is written first; the remaining entries are independent and are
// written concurrently. An entry that already exists is updated in place
// (idempotent re-push).
async function createEntries(
    cat: CatalogClient, opts: KcDeployOptions,
    entries: Entry[]): Promise<EntriesOutcome> {
  if (!entries.length) return {created: 0, updated: 0};
  const [anchor, ...children] = entries;

  const anchorRes = await writeEntry(cat, opts, anchor);
  if (anchorRes.error) return {created: 0, updated: 0, error: anchorRes.error};

  const childRes =
      await Promise.all(children.map(e => writeEntry(cat, opts, e)));
  const firstErr = childRes.find(r => r.error);
  if (firstErr) return {created: 0, updated: 0, error: firstErr.error};

  let created = anchorRes.updated ? 0 : 1;
  let updated = anchorRes.updated ? 1 : 0;
  for (const r of childRes) {
    if (r.updated)
      updated++;
    else
      created++;
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
// for idempotent provisioning and re-push.
function isExists(res: {status: number; message?: string}): boolean {
  return res.status === 409 ||
      /already exists|alreadyexists/i.test(res.message ?? '');
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
