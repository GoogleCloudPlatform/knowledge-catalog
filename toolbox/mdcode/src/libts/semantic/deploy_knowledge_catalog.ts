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
//     updates the link's aspects in place, or deletes and recreates the link
//     when its type or endpoint references changed; orphaned links are then
//     deleted. The caller additionally needs
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
import {anchorId, collectEntityNames, collectOwnedEntries, entryAspectKeys, entryId, entryTypeId, isAnchorEntry, isDependentEntry, isEntryOwner, isLinkOwner, isRelationshipLink, KcAnchor, linkId, linkTypeId, sameLinkReferences,} from './kc_entries';
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
  // `deployKnowledgeCatalog`, and by `updateEntry` when computing `aspectKeys`
  // (including when called through `deployEmittedModels`, which takes
  // already-emitted resources from an origin with its own emitter).
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
 *   2. Writes each emitted model's entries and relationship links and deletes
 *      any orphaned links and entries.
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
      counts.deleted += removed.deleted;
      counts.unlinked += removed.unlinked;
      if (removed.error) return result(false, removed.error);
    }
  }

  // Write each emitted model's entries and relationship links and delete any
  // orphaned resources.
  const written =
      await writeEmittedModels(cat, opts, emitted, existing, counts);
  if (written.error) return result(false, written.error);

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

/**
 * Writes every model's entries and relationship links and deletes orphaned
 * resources in model order.
 *
 * For each model, the method performs the following actions:
 *   1. Creates or updates the model's entries (anchor first).
 *   2. Looks up the model's existing relationship links when the pre-write
 *      entry group contains entities owned by the model.
 *   3. Creates, updates, or recreates the model's relationship links.
 *   4. Deletes any existing relationship links owned by the model that are no
 *      longer emitted.
 *   5. Deletes any existing entries owned by the model that are no longer
 *      emitted.
 *
 * Progress accumulates into `counts`, so a mid-way failure still reports what
 * had been written.
 */
async function writeEmittedModels(
    cat: CatalogClient, opts: KcDeployOptions, emitted: EmittedModel[],
    existing: Entry[], counts: Counts): Promise<{error?: string}> {
  for (const {model, resources} of emitted) {
    const entries = await writeEntries(cat, opts, resources.entries);
    counts.created += entries.created;
    counts.updated += entries.updated;
    if (entries.error) return {error: `Model '${model}': ${entries.error}`};

    // When the pre-write listing contains entity entries this model owns, look
    // up the model's existing links once and share the map between
    // writeEntryLinks (to detect changed endpoints) and findOrphanedEntryLinks
    // (to delete dropped links). Look up links via the model's entity entries
    // known to the server (the pre-write snapshot `existing`), not the ones
    // this push emits: only a server-side entry can already carry a link, and
    // enumerating the snapshot also reaches a link both of whose endpoints were
    // removed in this push (neither is re-emitted, but both entries are still
    // present in `existing` until `deleteEntries` deletes them at the end). On
    // a first push there are no such entries, so no lookup is made.
    const existingEntityNames = resources.entries.length ?
        collectEntityNames(collectOwnedEntries(resources, existing)) :
        [];
    let existingLinks = new Map<string, EntryLink>();
    if (existingEntityNames.length) {
      const lookedUp = await lookupEntryLinks(cat, opts, existingEntityNames);
      if (lookedUp.error) {
        return {error: `Model '${model}': ${lookedUp.error}`};
      }
      existingLinks = lookedUp.links;
    }

    // Links reference this model's entity entries, so they follow the entries
    // above (both endpoints must exist first).
    const links = await writeEntryLinks(cat, opts, resources, existingLinks);
    counts.linked += links.linked;
    if (links.error) return {error: `Model '${model}': ${links.error}`};

    // Then drop any relationship link this model owns but no longer emits (a
    // relationship dropped or renamed), after its current links are written so
    // a rename never leaves the pair with no link between them.
    const orphanedLinks = findOrphanedEntryLinks(resources, existingLinks);
    const unlinked = await deleteEntryLinks(cat, opts, orphanedLinks);
    counts.unlinked += unlinked.unlinked;
    if (unlinked.error) {
      const {linkId, message} = unlinked.error;
      return {
        error: `Deleting orphaned entry link '${linkId}' from model '${
            model}' failed: ${message}`,
      };
    }

    // Finally, delete any entry this model owns but no longer emits.
    const orphanedEntries = findOrphanedEntries(resources, existing);
    const deleted = await deleteEntries(cat, opts, orphanedEntries);
    counts.deleted += deleted.deleted;
    if (deleted.error) {
      const {entryId, message} = deleted.error;
      return {
        error: `Deleting orphaned entry '${entryId}' from model '${
            model}' failed: ${message}`,
      };
    }
  }
  return {};
}

interface ReconcileOutcome {
  deleted: number;
  error?: {entryId: string; message: string};
}

/**
 * Returns the entries in `existing` that `resources` owns but no longer emits.
 *
 * An entry becomes orphaned when a child resource (such as an entity, metric,
 * action, constraint, or explore) is deleted or renamed in the model since the
 * last push. Only child entries under `resources.ownedPrefixes` are ever
 * touched: entries outside those prefixes and the model anchor (always
 * re-emitted) are never deleted here.
 *
 * Deleting a whole model is handled by the `--force-remove` guard, and orphaned
 * relationship links by `findOrphanedEntryLinks` and `deleteEntryLinks`. This
 * step reads the pre-write snapshot `existing`, so it issues no list call of
 * its own (a re-emitted entry is never a deletion candidate, so the snapshot
 * stays correct).
 */
function findOrphanedEntries(
    resources: kcEmit.KcResources, existing: Entry[]): Entry[] {
  // An emitter that produced no entries has no anchor and owns nothing.
  if (!resources.entries.length) return [];
  const emittedIds = new Set(resources.entries.map(entryId));
  return existing.filter(
      e => isEntryOwner(resources, e) && !emittedIds.has(entryId(e)));
}

/**
 * Deletes every entry in `entries`.
 *
 * A 404 response on delete counts as success because the entry is already gone.
 */
async function deleteEntries(
    cat: CatalogClient, opts: KcDeployOptions,
    entries: Iterable<Entry>): Promise<ReconcileOutcome> {
  let deleted = 0;
  for (const entry of entries) {
    const id = entryId(entry);
    const res =
        await cat.deleteEntry(opts.project, opts.location, opts.entryGroup, id);
    // A 404 means it is already gone -- reconciliation's goal is met.
    if (isOkStatus(res) || isNotFoundStatus(res)) {
      deleted++;
      continue;
    }
    return {deleted, error: {entryId: id, message: errText(res)}};
  }
  return {deleted};
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
  error?: {linkId: string; message: string};
}

/**
 * Looks up all relationship entry links referencing any of `entityNames`.
 *
 * Links are looked up per referenced entry -- the only server-side access path
 * -- so a link between two of the entities is returned twice and deduplicated
 * here by bare link ID. Queries `lookupEntryLinks` and filters the results to
 * relationship links via `isRelationshipLink`.
 */
async function lookupEntryLinks(
    cat: CatalogClient, opts: KcDeployOptions, entityNames: string[]):
    Promise<{links: Map<string, EntryLink>; error?: string}> {
  const links = new Map<string, EntryLink>();
  for (const entityName of entityNames) {
    const res = await cat.lookupEntryLinks(
        opts.project, opts.location, {entry: entityName});
    if (!isOkStatus(res)) {
      return {
        links,
        error: `looking up entry links for '${entryIdOf(entityName)}': ` +
            errText(res),
      };
    }
    for (const link of res.result ?? []) {
      if (!isRelationshipLink(link)) continue;
      const id = linkId(link);
      if (!links.has(id)) links.set(id, link);
    }
  }
  return {links};
}

/**
 * Deletes every entry link in `links`.
 *
 * A 404 response on delete counts as success because the link is already gone.
 */
async function deleteEntryLinks(
    cat: CatalogClient, opts: KcDeployOptions,
    links: Iterable<EntryLink>): Promise<LinkReconcileOutcome> {
  let unlinked = 0;
  for (const link of links) {
    const id = linkId(link);
    const del = await cat.deleteEntryLink(
        opts.project, opts.location, opts.entryGroup, id);
    if (isOkStatus(del) || isNotFoundStatus(del)) {
      unlinked++;
      continue;
    }
    return {unlinked, error: {linkId: id, message: errText(del)}};
  }
  return {unlinked};
}

/**
 * Returns the relationship entry links in `existingLinks` that `resources`
 * owns but no longer emits.
 *
 * An entry link becomes orphaned when a relationship is deleted or renamed in
 * the model since the last push, or when a relationship stops being published
 * (for example, if one of its endpoint entities is removed). A link touching an
 * entry outside `resources` is never treated as owned.
 */
function findOrphanedEntryLinks(
    resources: kcEmit.KcResources,
    existingLinks: Map<string, EntryLink>): EntryLink[] {
  // An emitter that produced no entries has no anchor and owns nothing.
  if (!resources.entries.length || !existingLinks.size) return [];
  const emittedLinkIds = new Set(resources.entryLinks.map(linkId));
  return [...existingLinks.values()].filter(
      link =>
          isLinkOwner(resources, link) && !emittedLinkIds.has(linkId(link)));
}

/**
 * Deletes models already in the entry group that this push does not re-emit
 * (`--force-remove`).
 *
 * For each foreign anchor, removes its relationship links first (since they
 * reference entries about to be deleted), then deletes its children present in
 * `existing` followed by the anchor itself.
 *
 * A foreign model is by definition not in this push, so its emitter's
 * `ownedPrefixes` are unavailable. Ownership is instead the anchor followed by
 * a separator (`.` or `/`), which matches every ID scheme
 * (`<anchor>.entities.x` and `<anchor>/entities/x`) without hardcoding segment
 * names. Naming the segments here would leave a model published by a different
 * emitter with its children orphaned and unreachable -- the anchor goes, so no
 * later push sees a foreign model, and nothing owns the remainder.
 */
async function removeForeignModels(
    cat: CatalogClient, opts: KcDeployOptions, existing: Entry[],
    foreignAnchorIds: string[]):
    Promise<{deleted: number; unlinked: number; error?: string}> {
  let deleted = 0;
  let unlinked = 0;
  for (const foreignAnchorId of foreignAnchorIds) {
    // Find the foreign model's anchor entry and all of its child entries
    // across both the V1 dotted (`<anchor>.`) and V2/LookML slash (`<anchor>/`)
    // namespaces, then extract the full resource names of its `semantic-entity`
    // entries so we can look up their relationship links.
    const foreignAnchor: KcAnchor = {
      anchorId: foreignAnchorId,
      ownedPrefixes: [`${foreignAnchorId}.`, `${foreignAnchorId}/`],
    };
    const foreignEntries = collectOwnedEntries(foreignAnchor, existing);
    const foreignEntityNames = collectEntityNames(foreignEntries);

    // Delete all relationship links referencing the foreign model's entities
    // before deleting the entries themselves.
    const lookedUp = await lookupEntryLinks(cat, opts, foreignEntityNames);
    if (lookedUp.error) return {deleted, unlinked, error: lookedUp.error};
    const links = await deleteEntryLinks(cat, opts, lookedUp.links.values());
    unlinked += links.unlinked;
    if (links.error) {
      const {linkId, message} = links.error;
      return {
        deleted,
        unlinked,
        error: `Deleting entry link '${linkId}' from removed model '${
            foreignAnchorId}' failed: ${message}`,
      };
    }

    // Delete child entries before the anchor so that if a child delete fails
    // mid-way, the foreign anchor remains in the entry group and a subsequent
    // `--force-remove` push can still discover and finish removing the model.
    const orderedDeletions = [
      ...foreignEntries.filter(e => !isAnchorEntry(e)),
      ...foreignEntries.filter(isAnchorEntry),
    ];
    const entries = await deleteEntries(cat, opts, orderedDeletions);
    deleted += entries.deleted;
    if (entries.error) {
      const {entryId, message} = entries.error;
      return {
        deleted,
        unlinked,
        error: `Deleting entry '${entryId}' from removed model '${
            foreignAnchorId}' failed: ${message}`,
      };
    }
  }
  return {deleted, unlinked};
}

interface EntriesOutcome {
  created: number;
  updated: number;
  error?: string;
}

/**
 * Creates or updates a model's entries in dependency order.
 *
 * The method writes entries in three stages:
 *   1. Writes the model anchor (`entries[0]`) first, since it is the parent of
 *      every child entry.
 *   2. Writes independent child entries (such as entities, actions, and
 *      constraints) concurrently.
 *   3. Writes dependent child entries (`semantic-metric` via
 *      `semantic-metric.entity` and, for LookML, `semantic-explore` via
 *      `semantic-explore.baseEntity` / `joins[].fromEntity`, which reference
 *      entities by name) concurrently.
 *
 * An entry that already exists is updated in place (idempotent re-push).
 */
async function writeEntries(
    cat: CatalogClient, opts: KcDeployOptions,
    entries: Entry[]): Promise<EntriesOutcome> {
  if (!entries.length) return {created: 0, updated: 0};
  const [anchor, ...children] = entries;

  const anchorRes = await writeEntry(cat, opts, anchor);
  if (anchorRes.error) return {created: 0, updated: 0, error: anchorRes.error};

  let created = anchorRes.updated ? 0 : 1;
  let updated = anchorRes.updated ? 1 : 0;

  const independentEntries = children.filter(e => !isDependentEntry(e));
  const dependentEntries = children.filter(isDependentEntry);

  for (const entryWave of [independentEntries, dependentEntries]) {
    const res = await Promise.all(entryWave.map(e => writeEntry(cat, opts, e)));
    for (const r of res) {
      if (r.error) continue;
      if (r.updated) {
        updated++;
      } else {
        created++;
      }
    }
    const firstErr = res.find(r => r.error);
    if (firstErr) return {created, updated, error: firstErr.error};
  }
  return {created, updated};
}

interface LinksOutcome {
  linked: number;
  error?: string;
}

/**
 * Writes a model's relationship entry links concurrently.
 *
 * Both endpoint entries already exist because `writeEntries` runs first, and
 * links are independent of one another.
 */
async function writeEntryLinks(
    cat: CatalogClient, opts: KcDeployOptions, resources: kcEmit.KcResources,
    existingLinks: Map<string, EntryLink>): Promise<LinksOutcome> {
  if (!resources.entryLinks.length) return {linked: 0};
  const res = await Promise.all(resources.entryLinks.map(
      l => writeEntryLink(
          cat, opts, l, resources, existingLinks.get(linkId(l)))));
  const linked = res.filter(r => !r.error).length;
  const firstErr = res.find(r => r.error);
  if (firstErr) return {linked, error: firstErr.error};
  return {linked};
}

interface WriteOutcome {
  updated?: boolean;  // true when the resource already existed and was updated
  error?: string;
}

/**
 * Writes a single relationship entry link to Knowledge Catalog.
 *
 * Attempts to create `link`, and if it already exists (HTTP 409), delegates to
 * `updateEntryLink`.
 */
async function writeEntryLink(
    cat: CatalogClient, opts: KcDeployOptions, link: EntryLink,
    resources: kcEmit.KcResources,
    existingLink?: EntryLink): Promise<WriteOutcome> {
  const id = linkId(link);
  const res = await cat.createEntryLink(
      opts.project, opts.location, opts.entryGroup, id, link);
  if (isExistsStatus(res)) {
    return updateEntryLink(cat, opts, link, resources, existingLink);
  }
  if (!isOkStatus(res)) return {error: `entry link '${id}': ${errText(res)}`};
  return {};
}

/**
 * Updates an existing relationship entry link after `createEntryLink` returns
 * HTTP 409.
 *
 * Entry-link type and endpoint references are immutable in Knowledge Catalog,
 * so when `existingLink` differs in type or references, deletes and recreates
 * the link (failing if `existingLink` references an entry outside `resources`);
 * otherwise updates the link's aspects in place.
 */
async function updateEntryLink(
    cat: CatalogClient, opts: KcDeployOptions, link: EntryLink,
    resources: kcEmit.KcResources,
    existingLink?: EntryLink): Promise<WriteOutcome> {
  const id = linkId(link);
  if (existingLink &&
      (linkTypeId(existingLink) !== linkTypeId(link) ||
       !sameLinkReferences(existingLink, link))) {
    if (!isLinkOwner(resources, existingLink)) {
      return {
        error: `entry link '${id}' references an entry outside this model`,
      };
    }
    const del = await cat.deleteEntryLink(
        opts.project, opts.location, opts.entryGroup, id);
    if (!isOkStatus(del) && !isNotFoundStatus(del)) {
      return {error: `deleting entry link '${id}': ${errText(del)}`};
    }
    const recreated = await cat.createEntryLink(
        opts.project, opts.location, opts.entryGroup, id, link);
    if (!isOkStatus(recreated)) {
      return {error: `entry link '${id}': ${errText(recreated)}`};
    }
    return {};
  }

  const upd = await cat.updateEntryLink(
      {name: link.name, aspects: link.aspects} as EntryLink,
      Object.keys(link.aspects ?? {}));
  // A 409 already proved the link is present, and its entry references and
  // type are immutable, so this follow-up only refreshes the aspect. Some
  // catalog surfaces expose only create + lookup for an entry link and cannot
  // address it by name for an update -- there the link is still fully written
  // and only the aspect refresh is unavailable, so treat a not-addressable
  // response as a no-op success rather than failing an otherwise-complete
  // push. (This mirrors deleteEntryLinks tolerating a 404 on delete.)
  if (!isOkStatus(upd) && !isLinkNotAddressable(upd)) {
    return {error: `entry link '${id}': ${errText(upd)}`};
  }
  return {updated: true};
}

/**
 * Writes a single entry to Knowledge Catalog.
 *
 * Attempts to create `entry` (retrying brief entry-group propagation 404s), and
 * if it already exists (HTTP 409), delegates to `updateEntry`.
 */
async function writeEntry(
    cat: CatalogClient, opts: KcDeployOptions,
    entry: Entry): Promise<WriteOutcome> {
  const id = entryId(entry);
  const res = await createEntry(cat, opts, id, entry);
  if (isExistsStatus(res)) return updateEntry(cat, opts, entry);
  if (!isOkStatus(res)) return {error: `entry '${id}': ${errText(res)}`};
  return {};
}

/**
 * Updates an existing entry in place after `createEntry` returns HTTP 409.
 *
 * A Dataplex `entries.patch` upserts each aspect `aspectKeys` names that the
 * body carries, removes one the body leaves out only when
 * `deleteMissingAspects` is set, and keeps every aspect `aspectKeys` does not
 * name. Passing `entryAspectKeys(entry, opts)` with `deleteMissingAspects:
 * true` makes a re-push converge: a still-present optional aspect is refreshed,
 * and a removed one (such as `guidelines` when `ai_context.instructions` is
 * deleted, `sql-expressions`, or field-level `guidelines@Schema.<field>`
 * matched by `<project>.<location>.guidelines@*` under `v2Aspects`) is deleted
 * so a later `pull` does not bring it back. Push owns `guidelines` on its own
 * entries -- and, under `v2Aspects`, field-level `guidelines@Schema.<field>` on
 * its entity entries and `sql-expressions` on its entity and metric entries --
 * so it removes any that the model does not declare even if someone added them
 * in the console. Every other aspect another tool attached is left alone,
 * since `aspectKeys` names only the types kcmd writes.
 */
async function updateEntry(
    cat: CatalogClient, opts: KcDeployOptions,
    entry: Entry): Promise<WriteOutcome> {
  // We cannot simply pass `Object.keys(entry.aspects ?? {})` here because
  // `entry.aspects` only contains the aspects emitted in *this* push. If an
  // optional aspect (such as `guidelines`, `sql-expressions`, or a column's
  // `guidelines@Schema.<field>`) was present on a previous push and removed in
  // this push, it is absent from `entry.aspects` -- and Dataplex only deletes a
  // removed aspect when its key (or `<project>.<location>.guidelines@*` for
  // field-level `guidelines`) is still listed in `aspectKeys`.
  const aspectKeys = entryAspectKeys(entry, opts);
  const upd = await cat.updateEntry(
      entry, ['entry_source', 'aspects'], [...aspectKeys],
      /* deleteMissingAspects= */ true);
  if (!isOkStatus(upd)) {
    return {error: `entry '${entryId(entry)}': ${errText(upd)}`};
  }
  return {updated: true};
}

/**
 * Creates an entry, retrying brief 404s on a just-created entry group.
 */
async function createEntry(
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
 * surfaces expose only create + lookup for entry links, so `updateEntryLink`
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
