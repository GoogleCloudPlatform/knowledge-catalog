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
//   * Preflight validates that exactly one model is deployed per entry group
//     and that each file copy fits in one aspect, snapshots the destination
//     entry group to guard against foreign models (unless `--force-remove` is
//     set), and checks that any required custom entry/aspect types exist in
//     the target project.
//   * Apply creates or updates each model's entries in dependency order: the
//     `semantic-model` anchor first, then independent child entries
//     concurrently, and finally dependent child entries (`semantic-metric` and
//     `semantic-explore`).
//   * Relationship edges are published as entry links between two entity
//     entries after that model's entries exist: a `schema-join` link per
//     relationship, or with v2Aspects a `semantic-link` per ordered entity
//     pair and a `reference` link from each relationship entry to each of its
//     entities. A re-push first deletes any orphaned links (no longer emitted)
//     and stale links (whose type or endpoint references changed), then
//     creates new or recreated links and updates unchanged links' aspects in
//     place. The caller additionally needs
//     `dataplex.entryGroups.useSchemaJoinEntryLink` and `useSchemaJoinAspect`,
//     and with v2Aspects `useReferenceEntryLink`, on the destination entry
//     group.
//   * Reconcile deletions: after writing, delete any child entry this push owns
//     (by `ownedPrefixes`) that is present in the pre-write listing but was not
//     re-emitted.
//
// This is a library module: it emits no console output. Warnings and the
// dry-run plan are returned in `KcDeployResult` for the CLI (commands.ts) to
// print.

import {ApiResult} from '../gcp/api';
import * as context from '../gcp/context';
import * as crm from '../gcp/crm';
import {CatalogClient, Entry, EntryLink} from '../gcp/dataplex';

import {collectCustomTypes, customTypeHome, FILE_COPY_TYPE_ID, FileCopy, PUSH_ID_LABEL} from './kc_custom_types';
import {anchorId, collectEntityNames, collectOwnedEntries, collectOwnedReferences, entryAspectKeys, entryId, entryTypeId, isAnchorEntry, isDependentEntry, isEntryOwner, isLinkOwner, isModelLink, KcAnchor, linkId, linkTypeId, sameLinkReferences,} from './kc_entries';
import {entryIdOf, slug} from './kc_ids';
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
  // The file copies of the model file and its profile files, which the
  // emitter stores when v2Aspects is off. Consumed by `emitModels` like
  // v2Aspects.
  sourceFiles?: FileCopy[];
  // Set when the caller has already checked that the file-copy type exists
  // in the destination project. The preflight then does not look that type
  // up again. It still looks up every other custom type the model uses.
  fileCopyTypeChecked?: boolean;
  // Called with the warnings once the preflight passes, before the first
  // catalog write, so a caller can show them before anything is written. The
  // result carries them too. Not called for validateOnly or when the preflight
  // fails.
  onWarnings?: (warnings: readonly string[]) => void;
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
  // Relationship (schema-join or semantic-link) entry links written --
  // created, updated, or recreated (0 for validateOnly).
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
 *   2. Verifies that exactly one model is being deployed and that each file
 *      copy fits in one aspect, builds the dry-run plan, and returns early
 *      when `opts.validateOnly` is set.
 *   3. Lists the destination entry group and fails if an unrecognized model's
 *      anchor entry is present without `--force-remove`.
 *   4. Verifies that every custom entry type and aspect type required by the
 *      model exists in the target project. Skips the file-copy type when
 *      `opts.fileCopyTypeChecked` is set.
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
  // Resource Manager is asked for the project number at most once per push.
  const isScopeProject = scopeProjectMatcher(ctx, opts.project);

  // Some of this model's writes may have landed before a failure in them.
  // The catalog may then lack some or all of this push's file copies, and
  // pull refuses that until a push succeeds.
  const storesCopies = emitted.some(
      m => m.resources.entries.some(e => entryTypeId(e) === FILE_COPY_TYPE_ID));
  const failed = (details: string) => result(
      false,
      storesCopies ?
          `${details.replace(/\.$/, '')}. The catalog may now lack some or ` +
              `all of this push's file copies, so push again before you pull.` :
          details);

  if (opts.forceRemove) {
    const foreignAnchorIds = findForeignAnchorIds(emitted[0], existing);
    if (foreignAnchorIds.length) {
      // This runs before any of this model's writes. A failure here leaves
      // none of this push's file copies, so it gets the note too, and so
      // does a thrown error.
      const removed =
          await removeForeignModels(
              cat, opts, existing, foreignAnchorIds, isScopeProject)
              .catch((err: any) => ({
                       deleted: 0,
                       unlinked: 0,
                       error: String(err?.message || err).trim(),
                     }));
      counts.deleted += removed.deleted;
      counts.unlinked += removed.unlinked;
      if (removed.error) return failed(removed.error);
    }
  }

  // Write each emitted model's entries and relationship links and delete any
  // orphaned resources. A thrown error, such as a network failure, can stop
  // the writes partway too, so it is reported the same way. The counts then
  // leave out what the step that threw had already written.
  const written =
      await writeEmittedModels(
          cat, opts, emitted, existing, counts, isScopeProject)
          .catch((err: any) => ({error: String(err?.message || err).trim()}));
  if (written.error) return failed(written.error);

  return result(true);
}

/**
 * Deploys every authored model's Knowledge Catalog resources.
 *
 * Runs `preflightKnowledgeCatalog` followed by `applyKnowledgeCatalog`, and
 * passes the warnings to `opts.onWarnings` between the two.
 */
export async function deployKnowledgeCatalog(
    models: LoadedModel[], ctx: context.ApiContext,
    opts: KcDeployOptions): Promise<KcDeployResult> {
  const pre = await preflightKnowledgeCatalog(models, ctx, opts);
  if (pre.result) return pre.result;
  opts.onWarnings?.(pre.prepared!.warnings);
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
  opts.onWarnings?.(pre.prepared!.warnings);
  return applyKnowledgeCatalog(pre.prepared!, ctx, opts);
}

/**
 * Runs read-only preflight checks on already-emitted models.
 *
 * The method performs the following checks:
 *   1. Validates locally that `emitted` contains a single model and that each
 *      file copy fits in one aspect, builds the dry-run plan, and returns
 *      early when `opts.validateOnly` is set.
 *   2. Lists the destination entry group and validates that it contains no
 *      foreign models unless `--force-remove` is set.
 *   3. Validates that every custom type used by the model exists in the
 *      target project. Skips the file-copy type when
 *      `opts.fileCopyTypeChecked` is set.
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
  const sizeValidation = validateFileCopySizes(model, result);
  if (!sizeValidation.success) return {result: sizeValidation};
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
        false, oneModelPerEntryGroupMessage(opts.entryGroup, emitted.length));
  }
  return result(true);
}

/** The error for an entry group that would receive more than one model. */
export function oneModelPerEntryGroupMessage(
    entryGroup: string, models: number): string {
  return `entry group '${entryGroup}' would receive ${models} models, but ` +
      `only one model per entry group is supported; split them into ` +
      `separate entry groups.`;
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

// The largest aspect data Dataplex accepts: 120 KiB of its JSON form, in UTF-8
// bytes, with escaping counted. The schema aspect may hold 2 MiB.
export const MAX_ASPECT_DATA_BYTES = 120 * 1024;

/**
 * Validates that every file copy in `model` fits in one aspect.
 *
 * A file too large to store then fails before any write, naming the file,
 * rather than partway through the writes. Push runs the same check on its
 * copies, with `checkFileCopies`, before any graph deploys.
 */
function validateFileCopySizes(
    model: EmittedModel, result: ResultBuilder): KcDeployResult {
  for (const entry of model.resources.entries) {
    if (entryTypeId(entry) !== FILE_COPY_TYPE_ID) continue;
    for (const aspect of Object.values(entry.aspects ?? {})) {
      const error = fileCopySizeError(aspect.data ?? {});
      if (error) return result(false, error);
    }
  }
  return result(true);
}

/**
 * Checks a push's file copies before anything is written. Returns the error
 * to report, or undefined when every copy fits in one aspect and no two file
 * names map to one entry id.
 *
 * Push calls it before any graph deploys. Every copy of a model shares the
 * model's part of the entry id, so two file names collide when their slugs
 * do.
 */
export function checkFileCopies(files: readonly FileCopy[]): string|undefined {
  const bySlug = new Map<string, string>();
  for (const file of files) {
    const tooLarge = fileCopySizeError(kcEmit.fileCopyData(file));
    if (tooLarge) return tooLarge;
    const earlier = bySlug.get(slug(file.fileName));
    if (earlier !== undefined) {
      return `files '${earlier}' and '${file.fileName}' both map to one ` +
          `entry id; rename one of them`;
    }
    bySlug.set(slug(file.fileName), file.fileName);
  }
  return undefined;
}

// Why the aspect data of one file copy is too large to store, or undefined
// when it fits.
function fileCopySizeError(data: Record<string, any>): string|undefined {
  const bytes = new TextEncoder().encode(JSON.stringify(data)).length;
  if (bytes <= MAX_ASPECT_DATA_BYTES) return undefined;
  return `file '${data.fileName}' is too large to store in Knowledge ` +
      `Catalog: its copy takes ${bytes} bytes, and one aspect holds at most ` +
      `${MAX_ASPECT_DATA_BYTES}.`;
}

/**
 * Validates that every kcmd-owned custom type (`semantic-action`,
 * `semantic-constraint`, `semantic-model-file`) used by `model` exists in the
 * target project.
 *
 * Unlike built-in system types in `dataplex-types`, custom entry and aspect
 * types are provisioned in the destination project by `kcmd init`;
 * checking them up front in preflight fails fast with an actionable message
 * before any catalog entries or entry links are written, rather than failing
 * mid-push when creating an action or constraint entry.
 *
 * Skips the file-copy type when `opts.fileCopyTypeChecked` is set, because
 * the caller has already looked it up. Makes no network calls when no type
 * is left to check.
 */
async function validateCustomTypes(
    cat: CatalogClient, model: EmittedModel, opts: KcDeployOptions,
    result: ResultBuilder): Promise<KcDeployResult> {
  const typeIds = collectCustomTypes(model.resources.entries).filter(
      id => !(opts.fileCopyTypeChecked && id === FILE_COPY_TYPE_ID));
  const error = await checkCustomTypes(cat, opts, typeIds);
  return error ? result(false, error) : result(true);
}

/**
 * Checks that each custom type in `typeIds` exists in the destination
 * project. Returns the error to report, or undefined when every one exists.
 *
 * Push also calls it before any graph deploys, for the file-copy type every
 * push with v2Aspects off needs. Push then sets `fileCopyTypeChecked`, so the
 * catalog preflight looks up only the other custom types.
 */
export async function checkCustomTypes(
    cat: CatalogClient, dest: {project: string},
    typeIds: readonly string[]): Promise<string|undefined> {
  const home = customTypeHome(dest);
  for (const typeId of typeIds) {
    const [entryTypeRes, aspectTypeRes] = await Promise.all([
      cat.getEntryType(home.project, home.location, typeId),
      cat.getAspectType(home.project, home.location, typeId),
    ]);
    if (isNotFoundStatus(entryTypeRes) || isNotFoundStatus(aspectTypeRes)) {
      return `Custom type '${typeId}' not found in project ` +
          `'${dest.project}'; run 'kcmd init --semantic-model' first.`;
    }
    if (!isOkStatus(entryTypeRes)) {
      return `checking entry type '${typeId}' ` +
          `(HTTP ${entryTypeRes.status}): ${errText(entryTypeRes)}`;
    }
    if (!isOkStatus(aspectTypeRes)) {
      return `checking aspect type '${typeId}' ` +
          `(HTTP ${aspectTypeRes.status}): ${errText(aspectTypeRes)}`;
    }
  }
  return undefined;
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
        sourceFiles: opts.sourceFiles,
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
 *   3. Deletes any orphaned relationship links (no longer emitted) and stale
 *      relationship links (changed type or endpoints) owned by the model.
 *      Before the first delete, reads each emitted link ID the lookup did not
 *      return, and fails when push may not change the link under it.
 *   4. Creates or updates the model's relationship links.
 *   5. Deletes any existing entries owned by the model that are no longer
 *      emitted.
 *
 * Progress accumulates into `counts`, so a mid-way failure still reports what
 * had been written.
 */
async function writeEmittedModels(
    cat: CatalogClient, opts: KcDeployOptions, emitted: EmittedModel[],
    existing: Entry[], counts: Counts,
    isScopeProject: ProjectMatcher): Promise<{error?: string}> {
  for (const {model, resources} of emitted) {
    const entries =
        await writeEntries(cat, opts, resources.entries, existing);
    counts.created += entries.created;
    counts.updated += entries.updated;
    if (entries.error) return {error: `Model '${model}': ${entries.error}`};

    // When the pre-write listing contains entity entries this model owns, look
    // up the model's existing links once and share the map between
    // findOrphanedEntryLinks (to delete dropped or renamed links) and
    // findStaleEntryLinks (to delete links whose type or endpoints changed).
    // Look up links via the model's entity entries known to the server (the
    // pre-write snapshot `existing`), not the ones this push emits: only a
    // server-side entry can already carry a link, and enumerating the snapshot
    // also reaches a link both of whose endpoints were removed in this push
    // (neither is re-emitted, but both entries are still present in `existing`
    // until `deleteEntries` deletes them at the end). On a first push there are
    // no such entries, so no lookup is made.
    const existingEntityNames = resources.entries.length ?
        collectEntityNames(collectOwnedEntries(resources, existing)) :
        [];
    let existingLinks = new Map<string, EntryLink>();
    if (existingEntityNames.length) {
      const lookedUp = await lookupEntryLinks(
          cat, opts, existingEntityNames, isScopeProject);
      if (lookedUp.error) {
        const {entryId, message} = lookedUp.error;
        return {
          error: `Looking up entry links for '${entryId}' from model '${
              model}' failed: ${message}`,
        };
      }
      existingLinks = lookedUp.links;
    }

    // Find orphaned links (dropped or renamed) and stale links (same ID,
    // changed type or endpoints) in `existingLinks` and delete both BEFORE
    // creating current links so renamed links, swapped endpoint pairs, and
    // taken-over endpoint pairs do not collide with an existing link.
    const orphanedLinks = findOrphanedEntryLinks(resources, existingLinks);
    const staleLinks = findStaleEntryLinks(resources, existingLinks);
    if (staleLinks.error) {
      return {error: `Model '${model}': ${staleLinks.error}`};
    }
    // Before a link is deleted, read each emitted ID the lookup did not
    // return. A link under one of them that push may not change would fail
    // its write after the delete and leave the relationship with no link.
    const foundUnchanged = new Set<string>();
    if (orphanedLinks.length || staleLinks.links.length) {
      for (const link of resources.entryLinks) {
        if (existingLinks.has(linkId(link))) continue;
        const read =
            await readEmittedLink(cat, opts, resources, link, isScopeProject)
                .catch((err: any): ReadLinkOutcome => ({
                         error: `entry link '${linkId(link)}': ${
                             String(err?.message || err).trim()}`,
                       }));
        if (read.error) return {error: `Model '${model}': ${read.error}`};
        if (read.existing && !isStaleLink(read.existing, link)) {
          foundUnchanged.add(linkId(link));
        }
      }
    }
    // `deletedLinks` collects the links deleted so far. An error after a
    // delete gets the push-again hint when a link is missing because of it.
    const deletedLinks: EntryLink[] = [];
    const hint = (written: ReadonlySet<string> = new Set()) => restoreHint(
        deletedLinks, resources.entryLinks,
        new Set([...staleLinks.current, ...foundUnchanged, ...written]));
    const orphanedLinkDeletions =
        await deleteEntryLinks(cat, opts, orphanedLinks);
    counts.unlinked += orphanedLinkDeletions.deleted.length;
    deletedLinks.push(...orphanedLinkDeletions.deleted);
    if (orphanedLinkDeletions.error) {
      const {linkId, message} = orphanedLinkDeletions.error;
      return {
        error: `Deleting orphaned entry link '${linkId}' from model '${
            model}' failed: ${message}${hint()}`,
      };
    }
    const staleLinkDeletions =
        await deleteEntryLinks(cat, opts, staleLinks.links);
    deletedLinks.push(...staleLinkDeletions.deleted);
    if (staleLinkDeletions.error) {
      const {linkId, message} = staleLinkDeletions.error;
      return {
        error: `Deleting stale entry link '${linkId}' from model '${
            model}' failed: ${message}${hint()}`,
      };
    }

    // Links reference this model's entity entries, so they follow the entries
    // above (both endpoints must exist first).
    const links = await writeEntryLinks(
        cat, opts, resources, staleLinks.current, isScopeProject);
    counts.linked += links.linked;
    deletedLinks.push(...links.deleted);
    if (links.error) {
      return {error: `Model '${model}': ${links.error}${hint(links.written)}`};
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

/**
 * Returns the push-again hint for an error, or '' when no link is missing.
 *
 * An emitted link is missing when this push deleted a link with its ID or its
 * two entries, and `presentIds` does not hold it. `presentIds` holds the IDs
 * of the links written or found unchanged.
 */
function restoreHint(
    deletedLinks: readonly EntryLink[], emittedLinks: readonly EntryLink[],
    presentIds: ReadonlySet<string>): string {
  const ends = (link: EntryLink) =>
      link.entryReferences.map(r => entryId(r)).sort().join('|');
  const missing = emittedLinks.some(
      link => !presentIds.has(linkId(link)) &&
          deletedLinks.some(
              d => linkId(d) === linkId(link) || ends(d) === ends(link)));
  return missing ? ' (push again to restore the link)' : '';
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
    // Push writes listed source fields back, so it keeps each `resource` as
    // stored.
    for await (const entry of cat.listEntries(
        opts.project, opts.location, opts.entryGroup,
        {keepSourceResource: true})) {
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
  // The links deleted, in the order given.
  deleted: EntryLink[];
  error?: {linkId: string; message: string};
}

interface LinkLookupOutcome {
  links: Map<string, EntryLink>;
  error?: {entryId: string; message: string};
}

/**
 * Looks up all model links in the destination entry group referencing any of
 * `entityNames`.
 *
 * Links are looked up per referenced entry -- the only server-side access path
 * -- so a link between two of the entities is returned twice and deduplicated
 * here by bare link ID. Queries `lookupEntryLinks` and filters the results to
 * the kinds of link push writes (`isModelLink`) stored in the destination
 * entry group
 * (`projects/<project>/locations/<location>/entryGroups/<entryGroup>/entryLinks/`).
 * `isScopeProject` tells whether a link's project part names the destination
 * project. A link whose project number push cannot resolve is kept.
 * `isLinkOwner` accepts such a link only when its references spell the same
 * project as its name, so no reference in another project counts as the
 * model's own.
 */
async function lookupEntryLinks(
    cat: CatalogClient, opts: KcDeployOptions, entityNames: string[],
    isScopeProject: ProjectMatcher): Promise<LinkLookupOutcome> {
  const groupRegExp = new RegExp(`^projects/([^/]+)/locations/${
      opts.location}/entryGroups/${opts.entryGroup}/entryLinks/`);
  const links = new Map<string, EntryLink>();
  for (const entityName of entityNames) {
    const res = await cat.lookupEntryLinks(
        opts.project, opts.location, {entry: entityName});
    if (!isOkStatus(res)) {
      return {
        links,
        error: {entryId: entryIdOf(entityName), message: errText(res)},
      };
    }
    for (const link of res.result ?? []) {
      const project = link.name?.match(groupRegExp)?.[1];
      if (!project || (await isScopeProject(project)) === false) continue;
      if (!isModelLink(link)) continue;
      const id = linkId(link);
      if (!links.has(id)) links.set(id, link);
    }
  }
  return {links};
}

/**
 * Tells whether the project part of a resource name names the destination
 * project. Resolves to undefined when the part is a project number and the
 * destination's number is unknown.
 */
type ProjectMatcher = (nameProject: string) => Promise<boolean|undefined>;

/**
 * Returns a function that tells whether the project part of a resource name
 * that Dataplex returned names the destination project, `project`.
 *
 * Dataplex spells link references, and the names of looked-up links, with the
 * project number. When `project` is a project ID, the number comes from Cloud
 * Resource Manager. When Resource Manager does not give it, the function
 * resolves to undefined for every other project number.
 */
function scopeProjectMatcher(
    ctx: context.ApiContext, project: string): ProjectMatcher {
  let crmNumber: Promise<string|undefined>|undefined;
  return async (nameProject: string) => {
    // Check whether `nameProject` refers to the destination `project`:
    //   1. If `nameProject === project`, they already match verbatim.
    //   2. If `nameProject` is not a numeric project number, it is a different
    //      project's string ID and cannot match `project`. Only a numeric
    //      `nameProject` can still refer to `project` (when `project` is a
    //      project ID and Dataplex returned `nameProject` as a project number).
    //   3. Otherwise, resolve `project`'s number via Cloud Resource Manager
    //      (caching the Promise in `crmNumber` so it is called at most once)
    //      and compare `nameProject` against it. Without the number, the
    //      answer is unknown.
    if (nameProject === project) return true;
    if (!/^\d+$/.test(nameProject)) return false;
    const number = await (crmNumber ??= crm.projectNumber(project, ctx));
    return number === undefined ? undefined : nameProject === number;
  };
}

/**
 * Deletes every entry link in `links`.
 *
 * A 404 response on delete counts as success because the link is already gone.
 * A thrown error, such as a network failure, is returned like a failed
 * response, so the caller can name the link and keep its counts.
 */
async function deleteEntryLinks(
    cat: CatalogClient, opts: KcDeployOptions,
    links: Iterable<EntryLink>): Promise<LinkReconcileOutcome> {
  const deleted: EntryLink[] = [];
  for (const link of links) {
    const id = linkId(link);
    let del: ApiResult<EntryLink>;
    try {
      del = await cat.deleteEntryLink(
          opts.project, opts.location, opts.entryGroup, id);
    } catch (err: any) {
      const message = String(err?.message || err).trim();
      return {deleted, error: {linkId: id, message}};
    }
    if (isOkStatus(del) || isNotFoundStatus(del)) {
      deleted.push(link);
      continue;
    }
    return {deleted, error: {linkId: id, message: errText(del)}};
  }
  return {deleted};
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

interface StaleLinksOutcome {
  // The model's own links under an emitted ID whose type or endpoints changed.
  links: EntryLink[];
  // Emitted IDs whose looked-up link is the model's own with the same type and
  // endpoints.
  current: Set<string>;
  error?: string;
}

/**
 * Returns the existing entry links in `existingLinks` that share a bare link ID
 * with an emitted link in `resources.entryLinks` but have a different link type
 * or endpoint references, so they must be deleted before recreating the link.
 *
 * Fails with `error` (before any link is deleted) if a matching existing link
 * references an entry outside `resources`.
 */
function findStaleEntryLinks(
    resources: kcEmit.KcResources,
    existingLinks: Map<string, EntryLink>): StaleLinksOutcome {
  const links: EntryLink[] = [];
  const current = new Set<string>();
  if (!existingLinks.size) return {links, current};
  for (const link of resources.entryLinks) {
    const id = linkId(link);
    const existingLink = existingLinks.get(id);
    // Check whether `existingLink` is stale and safe to delete:
    //   1. If no link with this ID exists yet, `writeEntryLinks` creates it.
    //   2. If an existing link with this ID references an entry outside this
    //      model, we do not own it and must fail before deleting anything.
    //   3. If we own it and its link type and endpoint references are
    //      unchanged, `writeEntryLinks` updates its aspects in place.
    // Otherwise, its immutable type or endpoints changed, so it is stale.
    if (!existingLink) continue;
    if (!isLinkOwner(resources, existingLink)) {
      return {
        links: [],
        current,
        error: outsideReferenceError(resources, existingLink),
      };
    }
    if (isStaleLink(existingLink, link)) {
      links.push(existingLink);
    } else {
      current.add(id);
    }
  }
  return {links, current};
}

/**
 * Returns true when `existingLink` has a different immutable `entryLinkType`
 * or `entryReferences` from `link` and must be deleted and recreated rather
 * than updated in place.
 */
function isStaleLink(existingLink: EntryLink, link: EntryLink): boolean {
  return linkTypeId(existingLink) !== linkTypeId(link) ||
      !sameLinkReferences(existingLink, link);
}

/**
 * Returns the error for an existing link that holds an ID this model emits and
 * references an entry outside the model. Push does not delete or change such
 * a link.
 */
function outsideReferenceError(
    resources: kcEmit.KcResources, link: EntryLink,
    asReturned: EntryLink = link): string {
  // A reference whose entry ID this model owns is outside the model because it
  // names an entry in another entry group or project, so the error gives its
  // full name, as Dataplex returned it. `asReturned` is `link` before push
  // respelled its project.
  const ownedReferences = collectOwnedReferences(resources, link);
  const externalIds: string[] = [];
  link.entryReferences.forEach((r, i) => {
    if (ownedReferences.includes(r)) return;
    const shown = isEntryOwner(resources, r) ?
        asReturned.entryReferences[i].name :
        entryId(r);
    externalIds.push(`'${shown}'`);
  });
  return `entry link '${linkId(link)}' already exists and references ${
             externalIds.length === 1 ? 'entry' : 'entries'} ${
             externalIds.join(' and ')} outside this model; ` +
      `rename the relationship or delete the existing link`;
}

/**
 * Deletes models already in the entry group that this push does not re-emit
 * (`--force-remove`).
 *
 * For each foreign anchor, looks up its relationship links and then deletes
 * the anchor before anything else. Dataplex deletes an entry's child entries
 * with it, and a link with an entry it references, so a push that stops here
 * leaves the whole foreign model or none of it. Pull then returns the whole
 * model or finds none. The links and the children present in `existing` are
 * deleted after the anchor, and a 404 for one already gone counts as success.
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
    foreignAnchorIds: string[], isScopeProject: ProjectMatcher):
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

    // Look the links up while their entity entries still exist.
    const lookedUp = await lookupEntryLinks(
        cat, opts, foreignEntityNames, isScopeProject);
    if (lookedUp.error) {
      const {entryId, message} = lookedUp.error;
      return {
        deleted,
        unlinked,
        error: `Looking up entry links for '${entryId}' from removed model '${
            foreignAnchorId}' failed: ${message}`,
      };
    }

    // The anchor goes first and takes its children and their links with it.
    // A failure before it leaves the foreign model whole. The deletes after it
    // remove anything Dataplex left and normally get 404.
    const entryFailure = (e: NonNullable<ReconcileOutcome['error']>) => ({
      deleted,
      unlinked,
      error: `Deleting entry '${e.entryId}' from removed model '${
          foreignAnchorId}' failed: ${e.message}`,
    });
    const anchors = await deleteEntries(
        cat, opts, foreignEntries.filter(isAnchorEntry));
    deleted += anchors.deleted;
    if (anchors.error) return entryFailure(anchors.error);

    const links = await deleteEntryLinks(cat, opts, lookedUp.links.values());
    unlinked += links.deleted.length;
    if (links.error) {
      const {linkId, message} = links.error;
      return {
        deleted,
        unlinked,
        error: `Deleting entry link '${linkId}' from removed model '${
            foreignAnchorId}' failed: ${message}`,
      };
    }

    const children = await deleteEntries(
        cat, opts, foreignEntries.filter(e => !isAnchorEntry(e)));
    deleted += children.deleted;
    if (children.error) return entryFailure(children.error);
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
 *   2. Writes independent child entries (such as entities, relationships,
 *      actions, and constraints) concurrently.
 *   3. Writes dependent child entries (`semantic-metric` via
 *      `semantic-metric.entity` and, for LookML, `semantic-explore` via
 *      `semantic-explore.baseEntity` / `joins[].fromEntity`, which reference
 *      entities by name) concurrently.
 *
 * An entry that already exists is updated in place (idempotent re-push).
 */
async function writeEntries(
    cat: CatalogClient, opts: KcDeployOptions, entries: Entry[],
    existing: Entry[] = []): Promise<EntriesOutcome> {
  if (!entries.length) return {created: 0, updated: 0};
  // The entrySource each entry had before this push. An update keeps the
  // fields kcmd does not own.
  const sources = new Map(existing.map(e => [entryId(e), e.entrySource]));
  const write = (e: Entry) => writeEntry(cat, opts, e, sources);
  const [anchor, ...children] = entries;

  const anchorRes = await write(anchor);
  if (anchorRes.error) return {created: 0, updated: 0, error: anchorRes.error};

  let created = anchorRes.updated ? 0 : 1;
  let updated = anchorRes.updated ? 1 : 0;

  const independentEntries = children.filter(e => !isDependentEntry(e));
  const dependentEntries = children.filter(isDependentEntry);

  for (const entryWave of [independentEntries, dependentEntries]) {
    const res = await Promise.all(entryWave.map(write));
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
  // IDs of the links written.
  written: Set<string>;
  // Existing links deleted so that an emitted link with a new type or new
  // endpoints could take their ID. The caller uses them for the push-again
  // hint.
  deleted: EntryLink[];
  error?: string;
}

/**
 * Writes a model's relationship entry links concurrently.
 *
 * Both endpoint entries already exist because `writeEntries` runs first, and
 * any orphaned or stale links the lookup found have already been deleted. On
 * the flag-off path the emitter gives each pair of entries at most one link,
 * and with the flag on, each ordered pair. A stale link the lookup missed is
 * replaced during these writes, so a link that needs the pair it frees can fail
 * with the duplicate-endpoints error. That error gets the push-again hint, and
 * the next push writes the link. Uses `Promise.allSettled` so a thrown network
 * error on one link waits for any in-flight link writes to finish and reports
 * the link ID in the returned error. `current` holds the emitted IDs whose
 * looked-up link is the model's own with the same type and endpoints.
 * `isScopeProject` tells whether a project part names the destination project.
 */
async function writeEntryLinks(
    cat: CatalogClient, opts: KcDeployOptions, resources: kcEmit.KcResources,
    current: ReadonlySet<string>,
    isScopeProject: ProjectMatcher): Promise<LinksOutcome> {
  const entryLinks = resources.entryLinks;
  const written = new Set<string>();
  const deleted: EntryLink[] = [];
  if (!entryLinks.length) return {linked: 0, written, deleted};
  const settled = await Promise.allSettled(entryLinks.map(
      l => writeEntryLink(
          cat, opts, resources, l, current, isScopeProject)));
  const res = settled.map((s, i): LinkWriteOutcome => {
    if (s.status === 'fulfilled') return s.value;
    const id = linkId(entryLinks[i]);
    const msg = s.reason?.message || String(s.reason);
    return {error: `entry link '${id}': ${msg}`};
  });
  res.forEach((r, i) => {
    if (r.deleted) deleted.push(r.deleted);
    if (!r.error) written.add(linkId(entryLinks[i]));
  });
  const linked = res.filter(r => !r.error).length;
  const firstErr = res.find(r => r.error);
  if (firstErr) return {linked, written, deleted, error: firstErr.error};
  return {linked, written, deleted};
}

interface WriteOutcome {
  updated?: boolean;  // true when the resource already existed and was updated
  error?: string;
}

interface LinkWriteOutcome {
  // The existing link deleted so that the emitted link could take its ID.
  deleted?: EntryLink;
  error?: string;
}

/**
 * Writes a single relationship entry link to Knowledge Catalog.
 *
 * Attempts to create `link`. When `createEntryLink` returns HTTP 409, updates
 * the link under its ID, replaces it, or reports why push cannot write it.
 * `current` holds the emitted IDs whose looked-up link is the model's own with
 * the same type and endpoints.
 */
async function writeEntryLink(
    cat: CatalogClient, opts: KcDeployOptions, resources: kcEmit.KcResources,
    link: EntryLink, current: ReadonlySet<string>,
    isScopeProject: ProjectMatcher): Promise<LinkWriteOutcome> {
  const id = linkId(link);
  const res = await cat.createEntryLink(
      opts.project, opts.location, opts.entryGroup, id, link);
  if (!isExistsStatus(res)) return linkOutcome(link, res);
  if (current.has(id)) {
    return linkOutcome(link, await updateEntryLink(cat, link));
  }

  // The lookup did not return a link under this ID, so read it.
  const read = await readEmittedLink(cat, opts, resources, link, isScopeProject);
  if (read.error) return {error: read.error};
  if (!read.existing) {
    // No link holds the ID. Dataplex allows one link of a type between two
    // entries, so the 409 means another link already joins them.
    return {error: duplicateEndpointsError(link, errText(res))};
  }
  // The update patches only the aspects, and a link's type and references are
  // immutable. The model's own link whose type or endpoints changed is
  // deleted and created again.
  if (isStaleLink(read.existing, link)) {
    return replaceEntryLink(cat, opts, read.existing, link);
  }
  return linkOutcome(link, await updateEntryLink(cat, link));
}

interface ReadLinkOutcome {
  // The model's own relationship link under the emitted ID, with the
  // destination project spelled as `opts.project`. Unset when no link holds
  // the ID.
  existing?: EntryLink;
  error?: string;
}

/**
 * Reads the link under the ID of the emitted link `link` and checks that push
 * may change it.
 *
 * Returns the error when the read fails with anything but 404, when the link
 * is not of a kind push writes, when it references an entry outside the model,
 * and when push cannot resolve the project number its references need.
 */
async function readEmittedLink(
    cat: CatalogClient, opts: KcDeployOptions, resources: kcEmit.KcResources,
    link: EntryLink, isScopeProject: ProjectMatcher): Promise<ReadLinkOutcome> {
  const id = linkId(link);
  const found = await cat.getEntryLink(link.name!);
  if (isNotFoundStatus(found)) return {};
  if (!isOkStatus(found) || !found.result) {
    return {error: `reading entry link '${id}' failed: ${errText(found)}`};
  }
  const existing =
      await respellScopeProject(found.result, opts.project, isScopeProject);
  if (!existing) {
    return {
      error: `entry link '${id}' already exists, and push could not get the ` +
          `number of project '${opts.project}' from Cloud Resource Manager ` +
          `to check its references; check that the caller has ` +
          `resourcemanager.projects.get on the project`,
    };
  }
  // Push manages only the kinds of link it writes, as the lookup does.
  if (!isModelLink(existing)) {
    return {
      error: `entry link '${id}' already exists with link type '${
                 linkTypeId(existing)}'; ` +
          `rename the relationship or delete the existing link`,
    };
  }
  if (!isLinkOwner(resources, existing)) {
    return {error: outsideReferenceError(resources, existing, found.result)};
  }
  return {existing};
}

/**
 * Returns the outcome of a write of `link` that returned `res`.
 */
function linkOutcome(
    link: EntryLink, res: {status: number; message?: string}): LinkWriteOutcome {
  return isOkStatus(res) ? {} :
                           {error: `entry link '${linkId(link)}': ${errText(res)}`};
}

/**
 * Returns `link` with the destination project spelled as `project` in its name
 * and references, or undefined when a project number in them cannot be
 * resolved.
 *
 * Dataplex spells a read link's name as requested and its references with the
 * project number. `isLinkOwner` compares the two as text, so they must spell
 * the project the same way.
 */
async function respellScopeProject(
    link: EntryLink, project: string,
    isScopeProject: ProjectMatcher): Promise<EntryLink|undefined> {
  const respell = async (resourceName: string) => {
    const part = /^projects\/([^/]+)\//.exec(resourceName)?.[1];
    if (!part) return resourceName;
    const isScope = await isScopeProject(part);
    if (isScope === undefined) return undefined;
    return isScope ?
        `projects/${project}/${resourceName.slice(`projects/${part}/`.length)}` :
        resourceName;
  };
  const name = link.name && await respell(link.name);
  const references = await Promise.all(link.entryReferences.map(
      async r => ({...r, name: await respell(r.name)})));
  if (name === undefined && link.name !== undefined) return undefined;
  if (references.some(r => r.name === undefined)) return undefined;
  return {
    ...link,
    name,
    entryReferences: references as EntryLink['entryReferences'],
  };
}

/**
 * Deletes `existingLink`, a stale relationship entry link, and recreates it as
 * `link` with its updated `entryLinkType` and `entryReferences`.
 *
 * Once the delete succeeds, the outcome carries `existingLink`, which the
 * caller uses to add the push-again hint to an error after the delete.
 */
async function replaceEntryLink(
    cat: CatalogClient, opts: KcDeployOptions, existingLink: EntryLink,
    link: EntryLink): Promise<LinkWriteOutcome> {
  const id = linkId(link);
  const del = await cat.deleteEntryLink(
      opts.project, opts.location, opts.entryGroup, id);
  if (!isOkStatus(del) && !isNotFoundStatus(del)) {
    return {error: `entry link '${id}': ${errText(del)}`};
  }
  try {
    const recreated = await cat.createEntryLink(
        opts.project, opts.location, opts.entryGroup, id, link);
    return {...linkOutcome(link, recreated), deleted: existingLink};
  } catch (err: any) {
    const message = String(err?.message || err).trim();
    return {error: `entry link '${id}': ${message}`, deleted: existingLink};
  }
}

/**
 * Updates an existing entry link's aspects in place. A link with no aspect,
 * such as a reference link, has nothing to update.
 */
async function updateEntryLink(
    cat: CatalogClient, link: EntryLink): Promise<ApiResult<EntryLink>> {
  if (!link.aspects) return {status: 200};
  return cat.updateEntryLink(
      {name: link.name, aspects: link.aspects} as EntryLink,
      Object.keys(link.aspects));
}

/**
 * Returns the error when `createEntryLink` returns 409 because another link
 * under a different ID already connects the same endpoints. `createError` is
 * the text of that 409.
 */
function duplicateEndpointsError(link: EntryLink, createError: string): string {
  const id = linkId(link);
  const endpoints =
      link.entryReferences.map(r => `'${entryId(r)}'`).join(' and ');
  return `failed to create entry link '${id}' because another '${
             linkTypeId(link)}' link already connects ${endpoints}; ` +
      `Knowledge Catalog returned: ${createError}`;
}

/**
 * Writes a single entry to Knowledge Catalog.
 *
 * Attempts to create `entry` (retrying brief entry-group propagation 404s), and
 * if it already exists (HTTP 409), delegates to `updateEntry` with the
 * entrySource `sources` lists for it. An entry `sources` does not hold is read
 * first. That happens after a listing the caller may not make, or when another
 * writer created the entry after the listing.
 */
async function writeEntry(
    cat: CatalogClient, opts: KcDeployOptions, entry: Entry,
    sources: ReadonlyMap<string, Entry['entrySource']>): Promise<WriteOutcome> {
  const id = entryId(entry);
  const res = await createEntry(cat, opts, id, entry);
  if (isExistsStatus(res)) {
    if (sources.has(id)) return updateEntry(cat, opts, entry, sources.get(id));
    const read = await cat.getEntry(
        opts.project, opts.location, opts.entryGroup, id, undefined,
        {keepSourceResource: true});
    if (!isOkStatus(read)) {
      return {error: `entry '${id}': reading it before the update: ${
                  errText(read)}`};
    }
    return updateEntry(cat, opts, entry, read.result?.entrySource);
  }
  if (!isOkStatus(res)) return {error: `entry '${id}': ${errText(res)}`};
  return {};
}

// The entrySource fields another writer may set, which an update keeps.
const KEPT_SOURCE_FIELDS =
    ['resource', 'system', 'platform', 'createTime', 'updateTime'] as const;

/**
 * Updates an existing entry in place after `createEntry` returns HTTP 409.
 *
 * A Dataplex `entries.patch` upserts each aspect `aspectKeys` names that the
 * body carries, removes one the body leaves out only when
 * `deleteMissingAspects` is set, and keeps every aspect `aspectKeys` does not
 * name. Passing `entryAspectKeys(entry, opts)` with `deleteMissingAspects:
 * true` makes a re-push converge: a still-present optional aspect is refreshed,
 * and a removed one (such as `guidelines` when `ai_context.instructions` is
 * deleted, `sql-expressions`, or a field's `guidelines`, matched by its `@*`
 * key under `v2Aspects`) is deleted so a later `pull` does not bring it back.
 * Push owns the optional aspects `entryAspectKeys` lists, so it removes any
 * that the model does not declare even if someone added them in the console.
 * Every other aspect another tool attached is left alone, since `aspectKeys`
 * names only the types kcmd writes.
 *
 * The update mask replaces the whole entrySource, so the update carries over
 * fields from `source`, the entrySource the entry had before this push. Of
 * those fields kcmd owns the display name, the description and the
 * `kcmd-push-id` label. The update keeps another writer's `resource`,
 * `system`, `platform`, `createTime` and `updateTime`, and every label but
 * `kcmd-push-id`. It sets that label when `entry` carries it and drops it
 * when not. Dataplex refuses an update that leaves out an `updateTime` the
 * entry has, or moves it back. A kept field another writer changes after
 * `source` was read is written back with the old value. For `updateTime` the
 * update fails instead.
 */
async function updateEntry(
    cat: CatalogClient, opts: KcDeployOptions, entry: Entry,
    source?: Entry['entrySource']): Promise<WriteOutcome> {
  const {[PUSH_ID_LABEL]: _own, ...others} = source?.labels ?? {};
  const labels = {...others, ...entry.entrySource?.labels};
  const kept = Object.fromEntries(
      KEPT_SOURCE_FIELDS.filter(k => source?.[k] !== undefined)
          .map(k => [k, source![k]]));
  const merged = {
    ...kept,
    ...entry.entrySource,
    ...(Object.keys(labels).length ? {labels} : {}),
  };
  if (Object.keys(merged).length) entry = {...entry, entrySource: merged};
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
