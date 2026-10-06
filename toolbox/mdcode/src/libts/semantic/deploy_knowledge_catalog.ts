// Deploys a semantic model's Knowledge Catalog resources.
//
// This is the Knowledge Catalog leg of `kcmd push` for the semantic-model
// scope, the counterpart to `deploy_bigquery.ts`. It consumes models already
// parsed into the semantic IR (see loadSemanticModels, shared with the BigQuery
// leg so a multi-destination push parses each document once), maps each to
// catalog Entries + Aspects (the pure emitter in knowledge_catalog.ts), and
// writes them through the Knowledge Catalog client.
//
// Types: the `semantic-model`/`semantic-entity`/`semantic-metric` entry and
// aspect types — and the built-in `schema` aspect — are built-in system types
// in `dataplex-types/global`, while `kcmd`-owned custom types (such as
// `semantic-action` and `semantic-constraint`) live in the destination project.
// Push does NOT provision any type, nor the entry group (those are created at
// `init`); it only validates and writes entries and entry links. The caller
// needs `dataplex.entryGroups.useSemanticModelAspect` on the destination entry
// group.
//
// Publish sequence (split into read-only `preflightKnowledgeCatalog` and write
// `applyKnowledgeCatalog`):
//   * Preflight validates that exactly one model is deployed per entry group,
//     snapshots the destination entry group to guard against foreign models
//     (unless `--force-remove` is set), and checks that any required custom
//     entry/aspect types exist in the target project.
//   * Apply creates or updates each model's entries in dependency order: the
//     `semantic-model` anchor first, then independent child entries
//     concurrently, and finally dependent child entries (`semantic-metric` and
//     `semantic-explore`).
//   * Relationship edges are published as `schema-join` entry links between
//     the two entity entries after that model's entries exist. A re-push
//     updates the link's aspects in place, and orphaned links are deleted.
//     The caller additionally needs
//     `dataplex.entryGroups.useSchemaJoinEntryLink` and `useSchemaJoinAspect`
//     on the destination entry group.
//   * Reconcile deletions: after writing, delete any child entry this push owns
//     (by `ownedPrefixes`) that is present in the pre-write listing but was not
//     re-emitted.
//
// This is a library module: it emits no console output. Warnings and the
// dry-run plan are returned in `KcDeployResult` for the CLI (commands.ts) to
// print.

import {ApiResult} from '../gcp/api';
import * as context from '../gcp/context';
import {CatalogClient, Entry, EntryLink} from '../gcp/dataplex';

import {collectCustomTypes, customTypeHome} from './kc_custom_types';
import {anchorId, entryId, entryTypeId, linkId, linkTypeId,} from './kc_entries';
import {entryIdOf} from './kc_ids';
import * as kcEmit from './knowledge_catalog';
import {LoadedModel} from './loader';

export interface KcDeployOptions {
  // Project that owns the destination entry group. Flag overrides are applied
  // over the catalog.yaml scope defaults before this is set.
  project: string;
  // Location (region) of the destination entry group, e.g. `global` or `us`.
  location: string;
  // Id of the destination entry group (provisioned at `init`, not by push).
  entryGroup: string;
  // Project the built-in `semantic-*` / `schema` system types are referenced
  // from. Defaults to `dataplex-types`, where these types live; overridable
  // only so hermetic tests can point at a fixture types project. The emitted
  // entries are otherwise unchanged.
  systemTypeProject?: string;
  // Location the built-in system types are referenced from. Default `global`.
  systemTypeLocation?: string;
  // Emit the SQL-expression fields not yet in the published system-type
  // templates (per-field `schema.semantics` and `semantic-metric.expression`).
  // Off by default so the push matches the live types; see
  // KcGenerateOptions.emitExpressions.
  emitExpressions?: boolean;
  // Emit the second-generation built-in aspect fields and entry-id layout
  // (selected via KC_V2_ASPECTS=1). Off by default (absent means false).
  // Consumed by `emitModels` when called through `preflightKnowledgeCatalog` or
  // `deployKnowledgeCatalog`; `deployEmittedModels` takes already-emitted
  // resources from an origin with its own emitter and ignores this field.
  v2Aspects?: boolean;
  // Compile and report only; never writes to the catalog (a dry run).
  validateOnly?: boolean;
  // Delete models already in the entry group that this push does not re-emit --
  // a removed or renamed model's entries and links. Without it, an unrecognized
  // model in the group is a hard error rather than a silent orphan.
  forceRemove?: boolean;
  // How many times to try entries.create before giving up: a just-created entry
  // group can briefly 404, and the create path retries that window. Overridable
  // so tests exercise the retry without burning wall-clock. Default
  // ENTRY_CREATE_TRIES.
  entryCreateTries?: number;
  // Delay between entries.create retries, in ms. Default ENTRY_CREATE_RETRY_MS.
  entryCreateRetryMs?: number;
}

export interface KcDeployResult {
  // Whether the push (or --validate-only run) completed without error.
  success: boolean;
  // On failure, a human-readable reason; unset on success.
  details?: string;
  // Loader and emitter warnings collected across all documents (e.g. a skipped
  // many-to-many relationship, or a metric that could not be lowered).
  warnings: string[];
  // New entries created in the entry group (0 for validateOnly).
  created: number;
  // Existing entries updated in place by an idempotent re-push (0 for
  // validateOnly).
  updated: number;
  // Entries deleted: those orphaned by removed entities/metrics, plus every
  // entry of a --force-remove'd model (0 for validateOnly).
  deleted: number;
  // Relationship (schema-join) entry links written -- created or upserted (0
  // for validateOnly).
  linked: number;
  // Orphaned relationship links deleted -- from relationships dropped or
  // renamed on a still-present model, and from force-removed models (0 for
  // validateOnly).
  unlinked: number;
  // A human-readable plan of what would be written: the sole output of a
  // validateOnly run, and also returned (for --print) on a real push.
  plan: string[];
}

// Running tallies threaded through the write phase so a partial failure still
// reports what had been done. Field names match KcDeployResult so this spreads
// straight into the result.
interface Counts {
  created: number;
  updated: number;
  deleted: number;
  linked: number;
  unlinked: number;
}

/** One authored model paired with the catalog resources it emitted. */
export interface EmittedModel {
  model: string;
  resources: kcEmit.KcResources;
}

/**
 * The read-only preflight output handed to `applyKnowledgeCatalog`. Holds the
 * emitted catalog resources, the pre-write entry-group snapshot, any emitter
 * warnings, and the human-readable plan so `applyKnowledgeCatalog` can write
 * without repeating generation or listing.
 */
export interface KcPreparedDeploy {
  emitted: EmittedModel[];
  existing: Entry[];
  warnings: string[];
  plan: string[];
}

type ResultBuilder = (success: boolean, details?: string) => KcDeployResult;

// entries.create propagation retry: a just-created entry group can briefly 404.
const ENTRY_CREATE_TRIES = 3;
const ENTRY_CREATE_RETRY_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Runs every read-only check for a Knowledge Catalog push without writing to
 * the catalog.
 *
 * The method performs the following actions:
 *   1. Translates the IR models into catalog resources.
 *   2. Verifies that exactly one model is being deployed, builds the dry-run
 *      plan, and returns early when `opts.validateOnly` is set.
 *   3. Lists the destination entry group and fails if an unrecognized model's
 *      anchor entry is present without `--force-remove`.
 *   4. Verifies that every custom entry type and aspect type required by the
 *      model exists in the target project.
 *   5. Returns the emitted resources, entry-group listing, warnings, and plan
 *      as `prepared` for `applyKnowledgeCatalog`.
 */
export async function preflightKnowledgeCatalog(
    models: LoadedModel[], ctx: context.ApiContext, opts: KcDeployOptions):
    Promise<{prepared?: KcPreparedDeploy; result?: KcDeployResult}> {
  const emit = emitModels(models, opts);
  if (emit.error) {
    return {
      result: {
        success: false,
        details: emit.error,
        warnings: emit.warnings,
        created: 0,
        updated: 0,
        deleted: 0,
        linked: 0,
        unlinked: 0,
        plan: [],
      },
    };
  }
  return preflightEmittedModels(emit.emitted, emit.warnings, ctx, opts);
}

/**
 * Writes a preflight-checked Knowledge Catalog deployment.
 *
 * The method performs the following actions:
 *   1. Removes foreign models when `--force-remove` is set.
 *   2. Writes the model's entries and relationship links.
 *   3. Deletes orphaned entries the model no longer emits.
 */
export async function applyKnowledgeCatalog(
    prepared: KcPreparedDeploy, ctx: context.ApiContext,
    opts: KcDeployOptions): Promise<KcDeployResult> {
  const warnings: string[] = [...prepared.warnings];
  const counts:
      Counts = {created: 0, updated: 0, deleted: 0, linked: 0, unlinked: 0};
  const plan = prepared.plan;
  const result: ResultBuilder = (success, details) =>
      ({success, warnings, ...counts, plan, ...(details ? {details} : {})});

  const cat = new CatalogClient(ctx);
  const {emitted, existing} = prepared;

  if (opts.forceRemove) {
    const foreignAnchorIds = findForeignAnchorIds(emitted[0], existing);
    if (foreignAnchorIds.length) {
      const removed =
          await removeForeignModels(cat, opts, existing, foreignAnchorIds);
      if (removed.error) return result(false, removed.error);
      counts.deleted += removed.deleted;
      counts.unlinked += removed.unlinked;
    }
  }

  // Write each emitted model's entries and relationship links.
  const written = await writeModels(cat, opts, emitted, existing, counts);
  if (written.error) return result(false, written.error);

  // Finally, delete entries orphaned by entities/metrics removed from a
  // still-present model since its last push.
  const recon = await reconcileDeletions(cat, opts, emitted, existing);
  if (recon.error) return result(false, recon.error);
  counts.deleted += recon.deleted;

  return result(true);
}

/**
 * Deploys every authored model's Knowledge Catalog resources.
 *
 * Runs `preflightKnowledgeCatalog` followed by `applyKnowledgeCatalog`.
 */
export async function deployKnowledgeCatalog(
    models: LoadedModel[], ctx: context.ApiContext,
    opts: KcDeployOptions): Promise<KcDeployResult> {
  const pre = await preflightKnowledgeCatalog(models, ctx, opts);
  if (pre.result) return pre.result;
  return applyKnowledgeCatalog(pre.prepared!, ctx, opts);
}

/**
 * Publishes models that are already mapped to catalog resources.
 *
 * Origin-agnostic wrapper over `preflightEmittedModels` and
 * `applyKnowledgeCatalog` for callers with their own emitter (such as LookML).
 */
export async function deployEmittedModels(
    emitted: EmittedModel[], emitWarnings: string[], ctx: context.ApiContext,
    opts: KcDeployOptions): Promise<KcDeployResult> {
  const pre = await preflightEmittedModels(emitted, emitWarnings, ctx, opts);
  if (pre.result) return pre.result;
  return applyKnowledgeCatalog(pre.prepared!, ctx, opts);
}

/**
 * Runs read-only preflight checks on already-emitted models.
 *
 * The method performs the following checks:
 *   1. Validates locally that `emitted` contains a single model, builds the
 *      dry-run plan, and returns early when `opts.validateOnly` is set.
 *   2. Lists the destination entry group and validates that it contains no
 *      foreign models unless `--force-remove` is set.
 *   3. Validates that every custom type used by the model exists in the
 *      target project.
 */
async function preflightEmittedModels(
    emitted: EmittedModel[], emitWarnings: string[], ctx: context.ApiContext,
    opts: KcDeployOptions):
    Promise<{prepared?: KcPreparedDeploy; result?: KcDeployResult}> {
  const warnings: string[] = [...emitWarnings];
  const counts: Counts =
      {created: 0, updated: 0, deleted: 0, linked: 0, unlinked: 0};
  let plan: string[] = [];
  const result: ResultBuilder = (success, details) =>
      ({success, warnings, ...counts, plan, ...(details ? {details} : {})});

  // 1. Local validation (offline, zero network calls).
  const modelsValidation =
      validateEmittedModels(emitted, opts, warnings, result);
  if (!modelsValidation.success || !emitted.length) {
    return {result: modelsValidation};
  }

  // Once `validateEmittedModels` passes and `emitted` is non-empty, `emitted`
  // is guaranteed to contain exactly one model (`emitted[0]`).
  const model = emitted[0];
  plan = buildPlan(emitted, opts);
  if (opts.validateOnly) return {result: result(true)};

  // 2. Snapshot the entry group once, before any write: the same listing feeds
  //    the foreign-model guard, link reconciliation, and deletion
  //    reconciliation. A re-emitted entry is never a deletion candidate, so a
  //    pre-write snapshot is correct for all three.
  const cat = new CatalogClient(ctx);
  const listing = await listEntryGroup(cat, opts);
  if (listing.error) return {result: result(false, listing.error)};
  const existing = listing.entries;

  const groupValidation = validateEntryGroup(model, existing, opts, result);
  if (!groupValidation.success) return {result: groupValidation};

  // 3. Validate that every kcmd-owned custom type used by the model exists in
  //    the target project.
  const customTypesValidation =
      await validateCustomTypes(cat, model, opts, result);
  if (!customTypesValidation.success) return {result: customTypesValidation};

  return {prepared: {emitted, existing, warnings, plan}};
}

/**
 * Returns any `semantic-model` anchor IDs in `existing` that do not match the
 * input `model`'s anchor ID.
 *
 * A foreign anchor ID exists when the remote entry group already contains a
 * different `semantic-model` entry (for example, when the model was renamed
 * locally or a different model is pushed to the same entry group).
 */
function findForeignAnchorIds(
    model: EmittedModel|undefined, existing: readonly Entry[]): string[] {
  const modelAnchorId = anchorId(model?.resources.entries[0]);
  return existing.map(anchorId).filter(
      (id): id is string => id !== undefined && id !== modelAnchorId);
}

/**
 * Validates that `emitted` contains a single model.
 *
 * Only one semantic model per entry group is supported (so two models cannot
 * share an entry group or collide on entry IDs, and `kcmd pull` can
 * unambiguously read the group back).
 *
 * An empty workspace is a clean no-op under `--validate-only` and a
 * configuration error on a real push.
 */
function validateEmittedModels(
    emitted: EmittedModel[], opts: KcDeployOptions, warnings: string[],
    result: ResultBuilder): KcDeployResult {
  if (!emitted.length) {
    if (opts.validateOnly) {
      warnings.push('No semantic model documents found; nothing to validate.');
      return result(true);
    }
    return result(
        false, 'No semantic model documents found; nothing to deploy.');
  }
  if (emitted.length > 1) {
    return result(
        false,
        `entry group '${opts.entryGroup}' would receive ${
            emitted.length} models, but only one model per entry group is ` +
            `supported; split them into separate entry groups.`);
  }
  return result(true);
}

/**
 * Validates that `existing` (the destination entry-group snapshot) contains no
 * foreign `semantic-model` anchors unless `--force-remove` is set.
 *
 * If the entry group already contains a different model (for example, when a
 * model was renamed or replaced locally), pushing without removing the old
 * model would leave multiple models in the same entry group. We fail by
 * default unless the caller passes `--force-remove` to delete the old model.
 */
function validateEntryGroup(
    model: EmittedModel, existing: Entry[], opts: KcDeployOptions,
    result: ResultBuilder): KcDeployResult {
  const foreignAnchorIds = findForeignAnchorIds(model, existing);
  if (foreignAnchorIds.length && !opts.forceRemove) {
    return result(
        false,
        `entry group '${opts.entryGroup}' already contains model(s) this ` +
            `push does not include: ${foreignAnchorIds.join(', ')}. Re-run ` +
            `with --force-remove to delete them, or add their documents to ` +
            `this push.`);
  }
  return result(true);
}

/**
 * Validates that every kcmd-owned custom type (`semantic-action`,
 * `semantic-constraint`) used by `model` exists in the target project.
 *
 * Unlike built-in system types in `dataplex-types`, custom entry and aspect
 * types are provisioned in the destination project by `kcmd init`;
 * checking them up front in preflight fails fast with an actionable message
 * before any catalog entries or entry links are written, rather than failing
 * mid-push when creating an action or constraint entry.
 *
 * Makes no network calls when the model uses no custom types.
 */
async function validateCustomTypes(
    cat: CatalogClient, model: EmittedModel, opts: KcDeployOptions,
    result: ResultBuilder): Promise<KcDeployResult> {
  const home = customTypeHome(opts);
  for (const typeId of collectCustomTypes(model.resources.entries)) {
    const [entryTypeRes, aspectTypeRes] = await Promise.all([
      cat.getEntryType(home.project, home.location, typeId),
      cat.getAspectType(home.project, home.location, typeId),
    ]);
    if (isNotFoundStatus(entryTypeRes) || isNotFoundStatus(aspectTypeRes)) {
      return result(
          false,
          `Custom type '${typeId}' not found in project '${opts.project}'; ` +
              `run 'kcmd init --semantic-model' first.`);
    }
    if (!isOkStatus(entryTypeRes)) {
      return result(
          false,
          `checking entry type '${typeId}' (HTTP ${entryTypeRes.status}): ` +
              `${errText(entryTypeRes)}`);
    }
    if (!isOkStatus(aspectTypeRes)) {
      return result(
          false,
          `checking aspect type '${typeId}' (HTTP ${aspectTypeRes.status}): ` +
              `${errText(aspectTypeRes)}`);
    }
  }
  return result(true);
}

/**
 * Turns every authored model into its catalog resources.
 *
 * Pure (no network I/O), so the dry-run plan and any generation warnings are
 * produced even when a later write fails. A malformed GOOGLE
 * `custom_extension` (reached via the `semantic-model` aspect) throws; report
 * it against its document, as the BigQuery leg does, rather than letting it
 * escape as an uncaught stack trace.
 */
function emitModels(models: LoadedModel[], opts: KcDeployOptions):
    {emitted: EmittedModel[]; warnings: string[]; error?: string} {
  const emitted: EmittedModel[] = [];
  const warnings: string[] = [];
  for (const {document, model} of models) {
    let resources: kcEmit.KcResources;
    try {
      resources = kcEmit.generateCatalogResources(model, {
        project: opts.project,
        location: opts.location,
        entryGroup: opts.entryGroup,
        systemTypeProject: opts.systemTypeProject,
        systemTypeLocation: opts.systemTypeLocation,
        emitExpressions: opts.emitExpressions,
        v2Aspects: opts.v2Aspects,
      });
    } catch (err: any) {
      return {
        emitted,
        warnings,
        error: `Model '${model.name}' (${document}): ${err.message || err}`,
      };
    }
    for (const w of resources.warnings) warnings.push(`[${model.name}] ${w}`);
    emitted.push({model: model.name, resources});
  }
  return {emitted, warnings};
}

/**
 * Builds the full dry-run plan across all models (one block per model; see
 * `planSummary`).
 */
function buildPlan(emitted: EmittedModel[], opts: KcDeployOptions): string[] {
  const plan: string[] = [];
  for (const {model, resources} of emitted) {
    plan.push(...planSummary(model, resources, opts));
  }
  return plan;
}

/**
 * Builds a human-readable summary of what a (dry-run) push would write for one
 * model.
 */
function planSummary(
    model: string, resources: kcEmit.KcResources,
    opts: KcDeployOptions): string[] {
  const dest = `${opts.project}.${opts.location}.${opts.entryGroup}`;
  const lines = [
    `Knowledge Catalog plan for '${model}' (destination ${dest}):`,
    `  ${resources.entries.length} entr${
        resources.entries.length === 1 ? 'y' : 'ies'}:`,
    ...resources.entries.map(e => `    - ${entryId(e)} (${entryTypeId(e)})`),
  ];
  const linksByType = new Map<string, string[]>();
  for (const link of resources.entryLinks) {
    const type = linkTypeId(link);
    linksByType.set(type, [...(linksByType.get(type) ?? []), linkId(link)]);
  }
  for (const [type, ids] of linksByType) {
    lines.push(
        `  ${ids.length} ${type} link${ids.length === 1 ? '' : 's'}:`,
        ...ids.map(id => `    - ${id}`));
  }
  return lines;
}

// Writes every model's entries and relationship links, in model order. For each
// model: create/upsert its entries (anchor first), write its schema-join links
// (both endpoints must exist first), then drop any link it owns but no longer
// emits (a dropped or renamed relationship). Progress accumulates into counts, so
// a mid-way failure still reports what had been written.
async function writeModels(
    cat: CatalogClient, opts: KcDeployOptions, emitted: EmittedModel[],
    existing: Entry[], counts: Counts): Promise<{error?: string}> {
  for (const {model, resources} of emitted) {
    const entries = await createEntries(cat, opts, resources.entries);
    if (entries.error) return {error: `Model '${model}': ${entries.error}`};
    counts.created += entries.created;
    counts.updated += entries.updated;

    // Links reference this model's entity entries, so they follow the entries
    // above (both endpoints must exist first).
    const links = await createEntryLinks(cat, opts, resources.entryLinks);
    if (links.error) return {error: `Model '${model}': ${links.error}`};
    counts.linked += links.linked;

    // Then drop any schema-join link this model owns but no longer emits (a
    // relationship dropped or renamed), after its current links are written so a
    // rename never leaves the pair with no link between them.
    const relLinks = await reconcileLinks(cat, opts, resources, existing);
    if (relLinks.error) return {error: `Model '${model}': ${relLinks.error}`};
    counts.unlinked += relLinks.unlinked;
  }
  return {};
}


interface ReconcileOutcome {
  deleted: number;
  error?: string;
}

// Removes the catalog entries left behind when you delete an entity or metric
// from a model and push again -- the entries the model no longer emits. Only
// entries this push OWNS are ever touched: an entry whose id is a pushed model's
// anchor, or that lives under that anchor's `<model>.entities.` /
// `<model>.metrics.` namespace. Entries belonging to other models that share the
// entry group are left alone, and an anchor (always re-emitted) is never deleted
// here.
//
// Deleting a whole model is handled by the --force-remove guard, and orphaned
// relationship links by reconcileLinks. This step reads the pre-write snapshot
// `existing`, so it issues no list call of its own (a re-emitted entry is never a
// deletion candidate, so the snapshot stays correct).
function reconcileDeletions(
    cat: CatalogClient, opts: KcDeployOptions, emitted: EmittedModel[],
    existing: Entry[]): Promise<ReconcileOutcome> {
  const emittedIds = new Set<string>();
  const anchorIds = new Set<string>();
  const childPrefixes: string[] = [];
  for (const {resources} of emitted) {
    for (const e of resources.entries) emittedIds.add(entryId(e));
    // entries[0] is the model anchor (the emitter writes it first). An emitter
    // that produced no entries has no anchor and owns nothing, so skip it
    // rather than index into an empty array -- a throw here escapes the
    // KcDeployResult contract, and it would do so *after* writes.
    if (!resources.entries.length) continue;
    anchorIds.add(entryId(resources.entries[0]));
    // An empty prefix matches every id, which would make every entry in the
    // group -- including ones this tool never wrote -- an orphan. Both current
    // emitters build prefixes from a validated model name and cannot produce
    // one, but this function deletes things on the strength of what it is
    // handed, and a future origin may supply them. Drop empties rather than trust
    // the caller.
    childPrefixes.push(...resources.ownedPrefixes.filter(p => p.length > 0));
  }
  const owned = (id: string) =>
      anchorIds.has(id) || childPrefixes.some(p => id.startsWith(p));

  const orphans =
      existing.map(entryId).filter(id => owned(id) && !emittedIds.has(id));

  return deleteOrphanEntries(cat, opts, orphans);
}

async function deleteOrphanEntries(
    cat: CatalogClient, opts: KcDeployOptions,
    orphans: string[]): Promise<ReconcileOutcome> {
  let deleted = 0;
  for (const id of orphans) {
    const res =
        await cat.deleteEntry(opts.project, opts.location, opts.entryGroup, id);
    // A 404 means it is already gone -- reconciliation's goal is met either way.
    if (isOkStatus(res) || isNotFoundStatus(res)) {
      deleted++;
      continue;
    }
    return {deleted, error: `deleting orphaned entry '${id}': ${errText(res)}`};
  }
  return {deleted};
}


// The schema-join entry-link type name, matching what the emitter stamps on each
// link (Namer.typeName('entryLink', 'schema-join')). Used to filter
// lookupEntryLinks to the links this leg owns.
function schemaJoinLinkType(opts: KcDeployOptions): string {
  const proj = opts.systemTypeProject ?? 'dataplex-types';
  const loc = opts.systemTypeLocation ?? 'global';
  return `projects/${proj}/locations/${loc}/entryLinkTypes/schema-join`;
}

/**
 * Snapshots the destination entry group's entries once, before any write.
 *
 * A brand-new entry group can briefly fail to list its entries collection (the
 * same propagation window `createEntry` rides out); treat only that
 * not-yet-visible error as empty so any other listing failure (such as a
 * backend error or permission problem) is surfaced rather than masked.
 */
async function listEntryGroup(
    cat: CatalogClient,
    opts: KcDeployOptions): Promise<{entries: Entry[]; error?: string}> {
  const entries: Entry[] = [];
  try {
    for await (const entry of cat.listEntries(
        opts.project, opts.location, opts.entryGroup)) {
      entries.push(entry);
    }
  } catch (err: any) {
    const msg = err.message || String(err);
    if (isPropagationError({message: msg})) {
      return {entries: []};
    }
    return {
      entries: [],
      error: `listing entries in entry group '${opts.entryGroup}': ${msg}`,
    };
  }
  return {entries};
}


interface LinkReconcileOutcome {
  unlinked: number;
  error?: string;
}

// Deletes the schema-join links referencing any of `entityNames` (full entry
// resource names) for which `shouldDelete` returns true. Links are looked up per
// referenced entry -- the only server-side access path -- so a link between two
// of the entities is returned twice; a `seen` set dedups it. A 404 on delete
// counts as success (already gone).
async function deleteOwnedLinks(
    cat: CatalogClient, opts: KcDeployOptions, entityNames: string[],
    shouldDelete: (link: EntryLink) => boolean):
    Promise<LinkReconcileOutcome> {
  const linkType = schemaJoinLinkType(opts);
  const seen = new Set<string>();
  let unlinked = 0;
  for (const entry of entityNames) {
    const res = await cat.lookupEntryLinks(
        opts.project, opts.location, {entry, entryLinkTypes: [linkType]});
    if (!isOkStatus(res)) {
      return {
        unlinked,
        error:
            `looking up entry links for '${entryIdOf(entry)}': ${errText(res)}`
      };
    }
    for (const link of res.result ?? []) {
      const id = linkId(link);
      if (seen.has(id)) continue;
      seen.add(id);
      if (!shouldDelete(link)) continue;
      const del = await cat.deleteEntryLink(
          opts.project, opts.location, opts.entryGroup, id);
      if (isOkStatus(del) || isNotFoundStatus(del)) {
        unlinked++;
        continue;
      }
      return {unlinked, error: `deleting entry link '${id}': ${errText(del)}`};
    }
  }
  return {unlinked};
}


// Reconciles a still-present model's schema-join links: deletes any link this
// model OWNS (both endpoints under its `<anchor>.entities.` namespace) that the
// model no longer emits -- a relationship dropped or renamed since the last
// push. A link touching an entry outside this model is never treated as owned,
// so a shared entry group is safe.
function reconcileLinks(
    cat: CatalogClient, opts: KcDeployOptions, resources: kcEmit.KcResources,
    existing: Entry[]): Promise<LinkReconcileOutcome> {
  // An emitter that produced no entries has no anchor and owns nothing. Guarded
  // for the same reason reconcileDeletions guards it: this runs inside
  // writeModels, so a throw here escapes the KcDeployResult contract *after*
  // writes have happened.
  if (!resources.entries.length) return Promise.resolve({unlinked: 0});
  // Owned by this model: the prefixes its emitter declared, not a guess at the
  // id scheme.
  const ownedId = (id: string) =>
      resources.ownedPrefixes.some(p => p.length > 0 && id.startsWith(p));
  // Look up links via the model's entity entries KNOWN TO THE SERVER (the
  // pre-write snapshot), not the ones this push emits. Only a server-side entry
  // can already carry a link, and enumerating the snapshot also reaches a link
  // both of whose endpoints were removed in this push -- neither is re-emitted,
  // but both entries are still present in `existing` until reconcileDeletions
  // deletes them at the end. A brand-new model has no such entries, so it issues
  // no lookups at all.
  // Entity entries specifically, by entry type rather than by id shape: only
  // those can be a schema-join endpoint.
  const entityNames =
      existing.filter(e => (e.entryType ?? '').endsWith('/semantic-entity'))
          .map(e => e.name)
          .filter(name => ownedId(entryIdOf(name)));
  if (!entityNames.length) return Promise.resolve({unlinked: 0});

  const emittedLinkIds = new Set(resources.entryLinks.map(linkId));
  const ownedByModel = (link: EntryLink) => link.entryReferences.length === 2 &&
      link.entryReferences.every(r => ownedId(entryIdOf(r.name)));

  return deleteOwnedLinks(
      cat, opts, entityNames,
      link => ownedByModel(link) && !emittedLinkIds.has(linkId(link)));
}


// Deletes models already in the entry group that this push does not re-emit
// (--force-remove). For each foreign anchor: remove its schema-join links first
// (they reference entries about to be deleted), then its entries -- the anchor
// and its children present in the pre-write listing `existing`.
//
// A foreign model is by definition not in this push, so its emitter's
// `ownedPrefixes` are unavailable. Ownership is instead the anchor followed by
// a separator, which holds for every id scheme without naming its segments:
// `<anchor>.entities.x` and `<anchor>/entities/x` both match. Naming the
// segments here would leave a model published by a different emitter with its
// children orphaned and unreachable -- the anchor goes, so no later push sees a
// foreign model, and nothing owns the remainder.
async function removeForeignModels(
    cat: CatalogClient, opts: KcDeployOptions, existing: Entry[],
    foreignAnchors: string[]):
    Promise<{deleted: number; unlinked: number; error?: string}> {
  let deleted = 0;
  let unlinked = 0;
  for (const anchor of foreignAnchors) {
    const owned = existing.filter(e => {
      const id = entryId(e);
      return id === anchor || id.startsWith(`${anchor}.`) ||
          id.startsWith(`${anchor}/`);
    });
    const entityNames = owned
        .filter(e => (e.entryType ?? '').endsWith('/semantic-entity'))
        .map(e => e.name);

    // The whole model is going away, so every schema-join link referencing one
    // of its entities is orphaned -- delete them all.
    const links = await deleteOwnedLinks(cat, opts, entityNames, () => true);
    if (links.error) return {deleted, unlinked, error: links.error};
    unlinked += links.unlinked;

    for (const e of owned) {
      const id = entryId(e);
      const res = await cat.deleteEntry(
          opts.project, opts.location, opts.entryGroup, id);
      if (isOkStatus(res) || isNotFoundStatus(res)) {
        deleted++;
        continue;
      }
      return {deleted, unlinked,
              error: `deleting entry '${id}' of removed model '${anchor}': ${
                         errText(res)}`};
    }
  }
  return {deleted, unlinked};
}


interface EntriesOutcome {
  created: number;
  updated: number;
  error?: string;
}

// Creates a model's entries. The anchor (entries[0]) is the parent of every
// child and is written first. Entity entries are then written before the entries
// that reference them by name -- metrics (`semantic-metric.entity`) and, for
// LookML, explores (`semantic-explore.baseEntity` / `joins[].fromEntity`) -- and
// within each of those two waves the entries are independent and written
// concurrently. An entry that already exists is updated in place (idempotent
// re-push).
async function createEntries(
    cat: CatalogClient, opts: KcDeployOptions,
    entries: Entry[]): Promise<EntriesOutcome> {
  if (!entries.length) return {created: 0, updated: 0};
  const [anchor, ...children] = entries;

  const anchorRes = await writeEntry(cat, opts, anchor);
  if (anchorRes.error) return {created: 0, updated: 0, error: anchorRes.error};

  let created = anchorRes.updated ? 0 : 1;
  let updated = anchorRes.updated ? 1 : 0;

  // Entities first, then the entries that reference an entity by name (metrics
  // and explores); each wave is written concurrently.
  const dependsOnEntity = (e: Entry) => {
    const type = e.entryType ?? '';
    return type.endsWith('/semantic-metric') ||
        type.endsWith('/semantic-explore');
  };
  for (const wave of [children.filter(e => !dependsOnEntity(e)),
                      children.filter(dependsOnEntity)]) {
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


interface LinksOutcome {
  linked: number;
  error?: string;
}

// Writes a model's schema-join entry links. Both endpoint entries already exist
// (createEntries ran first for this model), and links are independent of each
// other, so they are written concurrently. A link that already exists is upserted
// (its aspect refreshed).
async function createEntryLinks(
    cat: CatalogClient, opts: KcDeployOptions,
    links: EntryLink[]): Promise<LinksOutcome> {
  if (!links.length) return {linked: 0};
  const res = await Promise.all(links.map(l => writeEntryLink(cat, opts, l)));
  const firstErr = res.find(r => r.error);
  if (firstErr) return {linked: 0, error: firstErr.error};
  return {linked: links.length};
}

// Writes one entry link: create, then fall back to an in-place aspect update if
// it already exists. A link's entry references and type are immutable, so a
// re-push only refreshes the aspect (the join detail). A relationship whose id
// changed writes a new link and leaves the old one; reconcileLinks deletes such
// orphaned links after this model's links are written.
async function writeEntryLink(
    cat: CatalogClient, opts: KcDeployOptions,
    link: EntryLink): Promise<{error?: string}> {
  const id = linkId(link);
  const res = await cat.createEntryLink(
      opts.project, opts.location, opts.entryGroup, id, link);
  if (isExistsStatus(res)) {
    const upd = await cat.updateEntryLink(
        {name: link.name, aspects: link.aspects} as EntryLink,
        Object.keys(link.aspects ?? {}));
    // A 409 already proved the link is present, and its entry references and type
    // are immutable, so this follow-up only refreshes the aspect. Some catalog
    // surfaces expose only create + lookup for an entry link and cannot address
    // it by name for an update -- there the link is still fully written and only
    // the aspect refresh is unavailable, so treat a not-addressable response as a
    // no-op success rather than failing an otherwise-complete push. (This mirrors
    // deleteOwnedLinks tolerating a 404 on delete.)
    if (!isOkStatus(upd) && !isLinkNotAddressable(upd)) {
      return {error: `entry link '${id}': ${errText(upd)}`};
    }
    return {};
  }
  if (!isOkStatus(res)) return {error: `entry link '${id}': ${errText(res)}`};
  return {};
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
  const id = entryId(entry);
  const res = await createEntryWithRetry(cat, opts, id, entry);
  if (isExistsStatus(res)) {
    // Idempotent re-push: refresh the existing entry's source + aspects.
    const upd = await cat.updateEntry(
        entry, ['entry_source', 'aspects'], reconciledAspectKeys(entry, opts),
        /* deleteMissingAspects= */ true);
    if (!isOkStatus(upd)) return {error: `entry '${id}': ${errText(upd)}`};
    return {updated: true};
  }
  if (!isOkStatus(res)) return {error: `entry '${id}': ${errText(res)}`};
  return {};
}

// The aspects the emitter attaches CONDITIONALLY. `guidelines` (only when an
// object carries ai_context.instructions) can ride any entry, so it is
// reconciled everywhere. Every other aspect the emitter writes (semantic-*,
// schema, semantic-action, semantic-constraint) is unconditional on the entry
// that carries it, so it is always present on a re-push and never needs
// explicit clearing.
const OPTIONAL_ASPECT_TYPES = ['guidelines'] as const;

// The aspect keys to reconcile when updating an existing entry. A Dataplex
// entries.patch upserts each aspect `aspectKeys` names that the body carries.
// It removes one the body leaves out only when `deleteMissingAspects` is set,
// which the update does, and keeps every aspect `aspectKeys` does not name.
// Naming the optional aspect keys, present or not, makes a re-push converge: a
// still-present one is refreshed, a removed one is deleted, and one that was
// never there stays absent. Without that, an entity whose
// ai_context.instructions were deleted would keep its old `guidelines`, and a
// later `pull` would bring them back. Push owns `guidelines` on its own
// entries, so it removes one the model does not declare even if someone added
// it in the console. Every other aspect another tool attached is left alone,
// since `aspectKeys` names only the types kcmd writes.
function reconciledAspectKeys(entry: Entry, opts: KcDeployOptions): string[] {
  const proj = opts.systemTypeProject ?? 'dataplex-types';
  const loc = opts.systemTypeLocation ?? 'global';
  const keys = new Set(Object.keys(entry.aspects ?? {}));
  for (const type of OPTIONAL_ASPECT_TYPES) keys.add(`${proj}.${loc}.${type}`);
  return [...keys];
}

// entries.create can briefly 404 on a just-created entry group; retry that
// window.
async function createEntryWithRetry(
    cat: CatalogClient, opts: KcDeployOptions, id: string,
    entry: Entry): Promise<ApiResult<Entry>> {
  const tries = opts.entryCreateTries ?? ENTRY_CREATE_TRIES;
  const retryMs = opts.entryCreateRetryMs ?? ENTRY_CREATE_RETRY_MS;
  let res = await cat.createEntry(
      opts.project, opts.location, opts.entryGroup, id, entry);
  for (let attempt = 1; attempt < tries; attempt++) {
    if (isOkStatus(res) || isExistsStatus(res) || !isPropagationError(res)) {
      break;
    }
    await sleep(retryMs);
    res = await cat.createEntry(
        opts.project, opts.location, opts.entryGroup, id, entry);
  }
  return res;
}

/**
 * Returns true when the API response succeeded with HTTP 200 OK.
 */
function isOkStatus(res: {status: number}): boolean {
  return res.status === 200;
}

/**
 * Returns true when a create failed because the resource already exists (HTTP
 * 409 ALREADY_EXISTS), treated as success for idempotent provisioning and
 * re-push.
 */
function isExistsStatus(res: {status: number}): boolean {
  return res.status === 409;
}

/**
 * Returns true when the API response failed because the resource does not exist
 * (HTTP 404 NOT_FOUND).
 */
function isNotFoundStatus(res: {status: number}): boolean {
  return res.status === 404;
}

/**
 * Returns true when an entry link that `createEntryLink` reported as already
 * existing (409) could not be addressed by name in `updateEntryLink`:
 * `NOT_FOUND` (404) or a masked `PERMISSION_DENIED` (403). Some catalog
 * surfaces expose only create + lookup for entry links, so `writeEntryLink`
 * treats this as a no-op success.
 */
function isLinkNotAddressable(res: {status: number}): boolean {
  return isNotFoundStatus(res) || res.status === 403;
}

/**
 * Returns true for a transient "not visible yet" entry-group propagation error
 * worth retrying, matching the propagation phrasing specifically rather than a
 * bare "not found" (which also covers a genuinely missing aspect or entry
 * type).
 */
function isPropagationError(res: {message?: string}): boolean {
  const msg = res.message ?? '';
  return /may not exist/i.test(msg) ||
      /entry group .*(not found|does not exist)/i.test(msg);
}

function errText(res: {status: number; message?: string}): string {
  return res.message?.trim() || `HTTP ${res.status}`;
}
