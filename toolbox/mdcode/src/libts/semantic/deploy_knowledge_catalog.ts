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
// needs the permissions docs/semantic-model/reference.md lists for push, on the
// destination entry group.
//
// Publish sequence (split into read-only `preflightKnowledgeCatalog` and write
// `applyKnowledgeCatalog`):
//   * Preflight validates that exactly one model is deployed per entry group,
//     snapshots the destination entry group to guard against foreign models
//     (unless `--force-remove` is set), and checks that any required custom
//     entry/aspect types exist in the target project. It also checks every
//     aspect's size.
//   * Apply first reads each emitted entry the listing holds, with the aspect
//     types its update names, and sends no write for one the update would
//     leave as stored. It creates or updates the others in dependency order:
//     the `semantic-model` anchor first, then independent child entries
//     concurrently, and finally dependent child entries (`semantic-metric` and
//     `semantic-explore`).
//   * Relationships are published as entry links after that model's entries
//     exist: a `semantic-link` per ordered pair of related entities, a
//     `reference` link from each relationship entry to each of its entities,
//     and one from each entity to each parent it extends. A re-push first
//     deletes any orphaned links (no longer emitted, such as the `schema-join`
//     links an older kcmd wrote) and stale links (whose endpoint references
//     changed), then creates new or recreated links. A link the lookup found
//     with the same endpoints gets an update only when its aspects changed,
//     and no request otherwise. The caller additionally needs
//     `dataplex.entryGroups.useReferenceEntryLink` on the destination entry
//     group.
//   * Reconcile deletions: after writing, delete any child entry this push owns
//     (by `ownedPrefixes`) that is present in the pre-write listing but was not
//     re-emitted.
//   * The model's first write labels the anchor `kcmd-push-state: writing`.
//     Under `--force-remove`, the deletes of foreign models come before it.
//     The model's last write, after its orphaned entries are deleted,
//     relabels the anchor `finished`. A model with nothing to create, update
//     or delete, whose anchor is labeled `finished`, gets no write.
//   * A dry run runs the preflight and then `planKnowledgeCatalog`, which
//     makes apply's reads and works out what apply would write and remove,
//     and writes nothing.
//
// This is a library module: it emits no console output. Warnings and the
// dry-run plan are returned in `KcDeployResult` for the CLI (commands.ts) to
// print.

import {isDeepStrictEqual} from 'node:util';

import {ApiResult} from '../gcp/api';
import * as context from '../gcp/context';
import * as crm from '../gcp/crm';
import {_typeRefToName, Aspect, CatalogClient, Entry, EntryLink} from '../gcp/dataplex';
import type {OverviewSidecar} from '../layouts/semantic-model';

import {collectCustomTypes, customTypeHome, PUSH_FINISHED, PUSH_STATE_LABEL, PUSH_WRITING} from './kc_custom_types';
import {anchorId, collectEntityNames, collectOwnedEntries, entryAspectKeys, entryId, entryTypeId, isAnchorEntry, isDependentEntry, isEntryOwner, isLinkOwner, isModelLink, KcAnchor, linkId, linkTypeId, sameLinkReferences,} from './kc_entries';
import {entryIdOf} from './kc_ids';
import {mapConcurrent, READ_CONCURRENCY, readEveryAspect} from './kc_read';
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
  // The overview sidecar of each entry, by entry id, which the emitter writes
  // into the entry's overview.
  overviews?: ReadonlyMap<string, OverviewSidecar>;
  // Called with the warnings once the preflight passes, before the first
  // catalog write, so a caller can show them before anything is written. The
  // result carries them too. Not called for validateOnly or when the preflight
  // fails.
  onWarnings?: (warnings: readonly string[]) => void;
  // A dry run: reads the catalog to work out what a push would write and
  // remove, and never writes to it.
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
  // Existing entries updated in place: those whose stored copy differs from
  // what the push writes, and those push wrote without a successful read (0
  // for validateOnly). No label counts as a difference. An emitted entry sets
  // none, and the update carries over every stored label it does not set.
  updated: number;
  // Existing entries that already hold what the push writes, so push read them
  // and sent no write, apart from the push-state label on the model entry (0
  // for validateOnly).
  unchangedEntries: number;
  // Entries deleted: those orphaned by removed entities/metrics, plus every
  // entry of a --force-remove'd model (0 for validateOnly).
  deleted: number;
  // Entry links written -- created, updated, or recreated (0 for
  // validateOnly).
  linked: number;
  // Entry links the lookup found with the same endpoints and aspects, so push
  // sent no request for them (0 for validateOnly).
  unchangedLinks: number;
  // Orphaned relationship links deleted -- from relationships dropped or
  // renamed on a still-present model, and from force-removed models (0 for
  // validateOnly).
  unlinked: number;
  // A human-readable plan of what push writes and removes: the sole output of
  // a validateOnly run, and also returned (for --print) on a real push. A
  // result that stops before push reads what the catalog holds lists only
  // the writes.
  plan: string[];
  // How many entries and links a dry run found push would remove. They
  // include each other model's entries and links under `--force-remove`.
  // Links push deletes and creates again are not counted, since they exist
  // after the push. Set only by a dry run that finds something to remove.
  toRemove?: {entries: number; links: number};
}

// Running tallies threaded through the write phase so a partial failure still
// reports what had been done. Field names match KcDeployResult so this spreads
// straight into the result.
interface Counts {
  created: number;
  updated: number;
  unchangedEntries: number;
  deleted: number;
  linked: number;
  unchangedLinks: number;
  unlinked: number;
}

// Counts of a run that has written nothing.
function noCounts(): Counts {
  return {
    created: 0,
    updated: 0,
    unchangedEntries: 0,
    deleted: 0,
    linked: 0,
    unchangedLinks: 0,
    unlinked: 0,
  };
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
 *   2. Verifies that exactly one model is being deployed, and builds the plan
 *      of what push writes.
 *   3. Fails when the destination entry group does not exist. Lists it and
 *      fails if an unrecognized model's anchor entry is present without
 *      `--force-remove`.
 *   4. Verifies that every custom entry type and aspect type required by the
 *      model exists in the target project.
 *   5. Returns the emitted resources, entry-group listing, warnings, and plan
 *      as `prepared` for `applyKnowledgeCatalog`.
 * Step 2 also checks every aspect's size.
 */
export async function preflightKnowledgeCatalog(
    models: LoadedModel[], ctx: context.ApiContext, opts: KcDeployOptions):
    Promise<{prepared?: KcPreparedDeploy; result?: KcDeployResult}> {
  const emit = emitModels(models, opts);
  return preflightEmittedModels(emit.emitted, emit.warnings, ctx, opts);
}

/**
 * Works out what a preflight-checked Knowledge Catalog deployment writes and
 * removes, as a dry run does, and writes nothing. The result's plan adds the
 * entries and links push removes, the links it deletes and creates again and,
 * under `--force-remove`, each other model's entries. A read that fails gives
 * the error the push would stop with.
 */
export async function planKnowledgeCatalog(
    prepared: KcPreparedDeploy, ctx: context.ApiContext,
    opts: KcDeployOptions): Promise<KcDeployResult> {
  const planned = await planWrites(
      new CatalogClient(ctx), opts, prepared,
      scopeProjectMatcher(ctx, opts.project));
  const failed = 'error' in planned;
  const toRemove = failed ? undefined : planned.toRemove;
  return {
    success: !failed,
    warnings: [...prepared.warnings],
    ...noCounts(),
    plan: failed ? prepared.plan : planned.plan,
    ...(failed ? {details: planned.error} : {}),
    ...(toRemove && toRemove.entries + toRemove.links ? {toRemove} : {}),
  };
}

/**
 * Writes a preflight-checked Knowledge Catalog deployment.
 *
 * The method performs the following actions:
 *   1. Works out what each emitted model's push writes and deletes, before
 *      any write (see `planWrites`).
 *   2. Removes foreign models when `--force-remove` is set.
 *   3. Writes each emitted model's new and changed entries and relationship
 *      links and deletes any orphaned links and entries. A model with nothing
 *      to write or delete, whose anchor is labeled finished, gets no write.
 */
export async function applyKnowledgeCatalog(
    prepared: KcPreparedDeploy, ctx: context.ApiContext,
    opts: KcDeployOptions): Promise<KcDeployResult> {
  const warnings: string[] = [...prepared.warnings];
  const counts = noCounts();
  let plan = prepared.plan;
  const result: ResultBuilder = (success, details) =>
      ({success, warnings, ...counts, plan, ...(details ? {details} : {})});

  const cat = new CatalogClient(ctx);
  const {emitted} = prepared;
  // Resource Manager is asked for the project number at most once per push.
  const isScopeProject = scopeProjectMatcher(ctx, opts.project);

  const planned = await planWrites(cat, opts, prepared, isScopeProject);
  if ('error' in planned) return result(false, planned.error);
  const {writePlans, foreign} = planned;
  plan = planned.plan;

  if (foreign.length) {
    // A thrown error is reported like a failed delete.
    const removed =
        await removeForeignModels(cat, opts, foreign)
            .catch((err: any) => ({
                     deleted: 0,
                     unlinked: 0,
                     error: String(err?.message || err).trim(),
                   }));
    counts.deleted += removed.deleted;
    counts.unlinked += removed.unlinked;
    if (removed.error) return result(false, removed.error);
  }

  // Write each emitted model's entries and relationship links and delete any
  // orphaned resources. A thrown error, such as a network failure, can stop
  // the writes partway too, so it is reported the same way. The counts then
  // leave out what the step that threw had already written.
  const written =
      await writeEmittedModels(
          cat, opts, emitted, writePlans, counts)
          .catch((err: any): WriteModelsOutcome =>
                     ({error: String(err?.message || err).trim()}));
  if (written.error) return result(false, written.error);

  return result(true);
}

/**
 * Deploys every authored model's Knowledge Catalog resources.
 *
 * Emits the models and passes them to `deployEmittedModels`.
 */
export async function deployKnowledgeCatalog(
    models: LoadedModel[], ctx: context.ApiContext,
    opts: KcDeployOptions): Promise<KcDeployResult> {
  const emit = emitModels(models, opts);
  return deployEmittedModels(emit.emitted, emit.warnings, ctx, opts);
}

/**
 * Publishes models that are already mapped to catalog resources.
 *
 * Origin-agnostic wrapper over `preflightEmittedModels` and
 * `applyKnowledgeCatalog` for callers with their own emitter (such as LookML).
 * It passes the warnings to `opts.onWarnings` between the two. With
 * `opts.validateOnly`, it runs `planKnowledgeCatalog` after the preflight
 * instead, and calls no `onWarnings`.
 */
export async function deployEmittedModels(
    emitted: EmittedModel[], emitWarnings: string[], ctx: context.ApiContext,
    opts: KcDeployOptions): Promise<KcDeployResult> {
  const pre = await preflightEmittedModels(emitted, emitWarnings, ctx, opts);
  if (pre.result) return pre.result;
  if (opts.validateOnly) return planKnowledgeCatalog(pre.prepared!, ctx, opts);
  opts.onWarnings?.(pre.prepared!.warnings);
  return applyKnowledgeCatalog(pre.prepared!, ctx, opts);
}

/**
 * Runs read-only preflight checks on already-emitted models.
 *
 * The method performs the following checks:
 *   1. Validates locally that `emitted` contains a single model and that
 *      every aspect size and instance count is within its limit. Builds the
 *      plan of what push writes.
 *   2. Validates that the destination entry group exists. Lists it and
 *      validates that it contains no foreign models unless `--force-remove`
 *      is set.
 *   3. Validates that every custom type used by the model exists in the
 *      target project.
 */
async function preflightEmittedModels(
    emitted: EmittedModel[], emitWarnings: string[], ctx: context.ApiContext,
    opts: KcDeployOptions):
    Promise<{prepared?: KcPreparedDeploy; result?: KcDeployResult}> {
  const warnings: string[] = [...emitWarnings];
  const counts = noCounts();
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
  const aspectsError = emittedAspectsError(model);
  if (aspectsError) return {result: result(false, aspectsError)};
  plan = buildPlan(emitted, opts);

  // 2. Snapshot the entry group once, before any write: the same listing feeds
  //    the foreign-model guard, link reconciliation, and deletion
  //    reconciliation. A re-emitted entry is never a deletion candidate, so a
  //    pre-write snapshot is correct for all three.
  const cat = new CatalogClient(ctx);
  // The listing reads a missing group as empty, so read the group itself.
  const group =
      await cat.getEntryGroup(opts.project, opts.location, opts.entryGroup)
          .catch((err: any) => `reading entry group '${opts.entryGroup}': ${
                     err?.message || String(err)}`);
  if (typeof group === 'string') return {result: result(false, group)};
  if (isNotFoundStatus(group)) {
    return {result: result(false, missingEntryGroupMessage(opts))};
  }
  // Any other refusal stops the push too, since the listing would read the
  // group as empty.
  if (!isOkStatus(group)) {
    return {
      result: result(
          false, `reading entry group '${opts.entryGroup}': ${errText(group)}`),
    };
  }
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

/** The error for a push or pull of an entry group that does not exist. */
export function missingEntryGroupMessage(
    opts: Pick<KcDeployOptions, 'project'|'location'|'entryGroup'>): string {
  const {project, location, entryGroup} = opts;
  return `entry group '${entryGroup}' does not exist in location ` +
      `'${location}' of project '${project}'; run 'kcmd init ` +
      `--semantic-model ${project}.${location}.${entryGroup}' to create it, ` +
      `or correct the scope in catalog.yaml.`;
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
const MAX_SCHEMA_ASPECT_DATA_BYTES = 2 * 1024 * 1024;

/**
 * The emitter's warnings for `models`, and the first aspect too large to
 * store, which is why push's catalog leg cannot write them. Calls no service.
 */
export function checkCatalogAspects(
    models: LoadedModel[],
    opts: KcDeployOptions): {error?: string; warnings: string[]} {
  const emit = emitModels(models, opts);
  const error = emit.emitted.map(emittedAspectsError).find(e => e);
  return {error, warnings: emit.warnings};
}

// Why push cannot write what `model` emits, or undefined when it can.
function emittedAspectsError(model: EmittedModel): string|undefined {
  for (const entry of model.resources.entries) {
    const error = aspectDataError(entry.aspects, `entry '${entryId(entry)}'`);
    if (error) return error;
  }
  for (const link of model.resources.entryLinks) {
    const error = aspectDataError(link.aspects, `entry link '${linkId(link)}'`);
    if (error) return error;
  }
  return undefined;
}

// Why Knowledge Catalog cannot store one of `aspects`, which `owner` carries,
// or undefined when each fits.
function aspectDataError(
    aspects: Record<string, Aspect>|undefined, owner: string): string|
    undefined {
  for (const [key, aspect] of Object.entries(aspects ?? {})) {
    const type = aspectTypeIdOfKey(key);
    const bytes = storedJsonBytes(aspect.data ?? {});
    const limit = type === 'schema' ? MAX_SCHEMA_ASPECT_DATA_BYTES :
                                      MAX_ASPECT_DATA_BYTES;
    if (bytes > limit) {
      return `aspect '${key}' of ${owner} is too large to store in ` +
          `Knowledge Catalog: its data takes ${bytes} bytes, and one ` +
          `aspect holds at most ${limit}.`;
    }
  }
  return undefined;
}

// The UTF-8 bytes of `data`'s JSON as Dataplex counts them. Dataplex writes
// < > & = ' U+2028 and U+2029 as six-byte \uXXXX escapes.
function storedJsonBytes(data: unknown): number {
  const json = JSON.stringify(data);
  return new TextEncoder().encode(json).length +
      5 * (json.match(/[<>&=']/g)?.length ?? 0) +
      3 * (json.match(/[\u2028\u2029]/g)?.length ?? 0);
}

// The aspect type id in an aspect key, `<project>.<location>.<type>` with an
// optional `@<path>`.
function aspectTypeIdOfKey(key: string): string {
  return key.split('@')[0].split('.').pop() ?? '';
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
 * Makes no network calls when the model uses no custom type.
 */
async function validateCustomTypes(
    cat: CatalogClient, model: EmittedModel, opts: KcDeployOptions,
    result: ResultBuilder): Promise<KcDeployResult> {
  const error = await checkCustomTypes(
      cat, opts, collectCustomTypes(model.resources.entries));
  return error ? result(false, error) : result(true);
}

/**
 * Checks that each custom type in `typeIds` exists in the destination
 * project. Returns the error to report, or undefined when every one exists.
 */
async function checkCustomTypes(
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
 * produced even when a later write fails.
 */
function emitModels(models: LoadedModel[], opts: KcDeployOptions):
    {emitted: EmittedModel[]; warnings: string[]} {
  const emitted: EmittedModel[] = [];
  const warnings: string[] = [];
  for (const {model} of models) {
    const resources = kcEmit.generateCatalogResources(model, {
      project: opts.project,
      location: opts.location,
      entryGroup: opts.entryGroup,
      systemTypeProject: opts.systemTypeProject,
      systemTypeLocation: opts.systemTypeLocation,
      overviews: opts.overviews,
    });
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

interface WriteModelsOutcome {
  error?: string;
}

/**
 * What one model's push writes and deletes, worked out before the first write
 * by `planModelWrites`.
 */
interface WritePlan {
  // The emitted entries to write, in emitted order: the ones the listing
  // lacks, those whose read failed, and those whose stored copy differs from
  // what the update would leave. No label counts as a difference. An emitted
  // entry sets none, and the update carries over every stored label it does
  // not set.
  writes: Entry[];
  // The number of emitted entries the catalog already holds as the update
  // would leave them.
  unchanged: number;
  // The entrySource each listed entry holds, by entry ID: the one read for
  // the plan, or the listed one when that read failed.
  sources: Map<string, Entry['entrySource']>;
  // The model entry as read for the plan. Unset when the listing lacks it or
  // its read failed.
  storedAnchor?: Entry;
  // The model's relationship links that it no longer emits. They and the
  // stale links in `staleLinks` are deleted before the link writes.
  orphanedLinks: EntryLink[];
  staleLinks: StaleLinksOutcome;
  // The emitted links the lookup missed that a read found with the same
  // endpoints.
  foundUnchanged: Set<string>;
  // The entries the model owns but no longer emits.
  orphanedEntries: Entry[];
}

/**
 * Works out what the push of `prepared` writes and deletes, before any write,
 * and returns the error that stops it. Writes nothing. Returns each emitted
 * model's write plan, each other model `--force-remove` deletes, the
 * preflight's plan with the lines of what push removes added, and how many
 * entries and links push removes. A thrown error, such as a network failure,
 * is reported like a failed read.
 */
async function planWrites(
    cat: CatalogClient, opts: KcDeployOptions, prepared: KcPreparedDeploy,
    isScopeProject: ProjectMatcher): Promise<{
  writePlans: WritePlan[]; foreign: ForeignModel[]; plan: string[];
  toRemove: {entries: number; links: number};
}|{error: string}> {
  const {emitted, existing} = prepared;
  const writePlans: WritePlan[] = [];
  for (const {model, resources} of emitted) {
    const planned =
        await planModelWrites(
            cat, opts, model, resources, existing, isScopeProject)
            .catch((err: any) => ({error: String(err?.message || err).trim()}));
    if ('error' in planned) return planned;
    writePlans.push(planned);
  }
  const foreignAnchorIds =
      opts.forceRemove ? findForeignAnchorIds(emitted[0], existing) : [];
  const foreign =
      await planForeignModels(
          cat, opts, existing, foreignAnchorIds, isScopeProject)
          .catch((err: any) => ({error: String(err?.message || err).trim()}));
  if ('error' in foreign) return foreign;
  const {lines, ...toRemove} = removalPlan(writePlans, foreign);
  return {writePlans, foreign, plan: [...prepared.plan, ...lines], toRemove};
}

/** Another model in the entry group, which `--force-remove` deletes. */
interface ForeignModel {
  anchorId: string;
  // Its entries in the pre-write listing.
  entries: Entry[];
  // The relationship links of its entity entries.
  links: EntryLink[];
}

/**
 * Returns the model of each anchor ID in `foreignAnchorIds`, with its entries
 * in `existing` and the links of its entity entries, which it looks up while
 * those entries still exist. Returns the error that stops the push when a
 * lookup fails.
 */
async function planForeignModels(
    cat: CatalogClient, opts: KcDeployOptions, existing: readonly Entry[],
    foreignAnchorIds: readonly string[],
    isScopeProject: ProjectMatcher): Promise<ForeignModel[]|{error: string}> {
  const models: ForeignModel[] = [];
  for (const anchorId of foreignAnchorIds) {
    const entries = entriesOfModel(anchorId, existing);
    const lookedUp = await lookupEntryLinks(
        cat, opts, collectEntityNames(entries), isScopeProject);
    if (lookedUp.error) {
      const {entryId, message} = lookedUp.error;
      return {
        error: `Looking up entry links for '${entryId}' from removed model '${
            anchorId}' failed: ${message}`,
      };
    }
    models.push({anchorId, entries, links: [...lookedUp.links.values()]});
  }
  return models;
}

/**
 * The plan lines of what push removes: for each model in `writePlans`, the
 * entries and links it deletes and the links it deletes and creates again with
 * new endpoints, then the entries and links of each model in `foreign`. Each
 * list is sorted by ID, which puts a model's own entry first, since its ID
 * starts the ID of every other entry of the model. A kind with nothing in it
 * gets no line. Also returns how many entries and links push removes for
 * good, which leaves out the links it creates again.
 */
function removalPlan(
    writePlans: readonly WritePlan[], foreign: readonly ForeignModel[]):
    {lines: string[]; entries: number; links: number} {
  // A heading such as "  2 entries to remove:" over one line per item.
  const listed = (items: string[], one: string, many: string, what: string) => {
    if (!items.length) return [];
    const kind = items.length === 1 ? one : many;
    return [
      `  ${items.length} ${kind} ${what}:`,
      ...items.map(item => `    - ${item}`),
    ];
  };
  const byId = <T>(list: readonly T[], id: (item: T) => string) =>
      [...list].sort((a, b) => id(a) < id(b) ? -1 : id(a) > id(b) ? 1 : 0);
  const entries = (list: readonly Entry[]) =>
      byId(list, entryId).map(e => `${entryId(e)} (${entryTypeId(e)})`);
  const links = (list: readonly EntryLink[]) =>
      byId(list, linkId).map(l => `${linkId(l)} (${linkTypeId(l)})`);
  return {
    lines: [
      ...writePlans.flatMap(p => [
        ...listed(entries(p.orphanedEntries), 'entry', 'entries', 'to remove'),
        ...listed(links(p.orphanedLinks), 'link', 'links', 'to remove'),
        ...listed(links(p.staleLinks.links), 'link', 'links', 'to recreate'),
      ]),
      ...foreign.flatMap(m => {
        const what = `of model '${m.anchorId}' to remove (--force-remove)`;
        return [
          ...listed(entries(m.entries), 'entry', 'entries', what),
          ...listed(links(m.links), 'link', 'links', what),
        ];
      }),
    ],
    entries: writePlans.flatMap(p => p.orphanedEntries).length +
        foreign.flatMap(m => m.entries).length,
    links: writePlans.flatMap(p => p.orphanedLinks).length +
        foreign.flatMap(m => m.links).length,
  };
}

/**
 * Works out what the push of one model writes and deletes, and returns the
 * error that stops it. Writes nothing.
 *
 * The method performs the following actions:
 *   1. Reads each emitted entry the pre-write listing `existing` holds, with
 *      the aspect types its update names, at most READ_CONCURRENCY at a time,
 *      and sorts out the entries the update would leave as stored. A read
 *      that fails counts as a difference.
 *   2. Looks up the model's existing relationship links when `existing`
 *      contains entities owned by the model, and finds the orphaned links (no
 *      longer emitted) and stale links (changed endpoints) owned by the model.
 *      When there are any, reads each emitted link ID the lookup did not
 *      return, and fails when a read fails.
 *   3. Finds the existing entries owned by the model that are no longer
 *      emitted.
 */
async function planModelWrites(
    cat: CatalogClient, opts: KcDeployOptions, model: string,
    resources: kcEmit.KcResources, existing: Entry[],
    isScopeProject: ProjectMatcher): Promise<WritePlan|{error: string}> {
  const sources = new Map(existing.map(e => [entryId(e), e.entrySource]));
  const listed = resources.entries.filter(e => sources.has(entryId(e)));
  const stored = await mapConcurrent(
      listed, READ_CONCURRENCY, e => readStored(cat, opts, e));
  const unchanged = new Set<Entry>();
  listed.forEach((entry, i) => {
    const held = stored[i];
    if (!held) return;
    sources.set(entryId(entry), held.entrySource);
    if (isUnchanged(entry, held, opts)) unchanged.add(entry);
  });
  const anchor = resources.entries[0];
  const anchorIndex = anchor ? listed.indexOf(anchor) : -1;

  // When the pre-write listing contains entity entries this model owns, look
  // up the model's existing links once and share the map between
  // findOrphanedEntryLinks (to delete dropped or renamed links) and
  // findStaleEntryLinks (to delete links whose endpoints changed).
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

  // Orphaned links (dropped or renamed) and stale links (same ID, changed
  // endpoints) are deleted BEFORE the current links are created, so renamed
  // links, swapped endpoint pairs, and taken-over endpoint pairs do not
  // collide with an existing link.
  const orphanedLinks = findOrphanedEntryLinks(resources, existingLinks);
  const staleLinks = findStaleEntryLinks(resources, existingLinks);
  // Before a link is deleted, read each emitted ID the lookup did not
  // return. A read that fails here could fail that link's write after the
  // delete too, and leave the relationship with no link.
  const foundUnchanged = new Set<string>();
  if (orphanedLinks.length || staleLinks.links.length) {
    for (const link of resources.entryLinks) {
      if (existingLinks.has(linkId(link))) continue;
      const read =
          await readEmittedLink(cat, link)
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

  return {
    writes: resources.entries.filter(e => !unchanged.has(e)),
    unchanged: unchanged.size,
    sources,
    ...(anchorIndex >= 0 && stored[anchorIndex] ?
            {storedAnchor: stored[anchorIndex]} :
            {}),
    orphanedLinks,
    staleLinks,
    foundUnchanged,
    orphanedEntries: findOrphanedEntries(resources, existing),
  };
}

/**
 * Returns true when the push of `resources` that `plan` describes has nothing
 * to write or delete and the model entry is labeled finished, so the push
 * sends no write for the model.
 */
function isNothingToWrite(
    resources: kcEmit.KcResources, plan: WritePlan): boolean {
  // An emitted link that shares its ID with a stale link fails this check,
  // since `staleLinks.current` leaves out that ID.
  const linksUnchanged = resources.entryLinks.every(link => {
    const found = plan.staleLinks.current.get(linkId(link));
    return found !== undefined && holdsAspects(found.aspects, link.aspects);
  });
  return !plan.writes.length && linksUnchanged && !plan.orphanedLinks.length &&
      !plan.orphanedEntries.length &&
      plan.storedAnchor?.entrySource?.labels?.[PUSH_STATE_LABEL] ===
      PUSH_FINISHED;
}

/**
 * Returns the emitted entry `entry` as the catalog holds it, read with the
 * aspect types its update names and with its source `resource` as stored, or
 * undefined when the read fails.
 */
async function readStored(
    cat: CatalogClient, opts: KcDeployOptions,
    entry: Entry): Promise<Entry|undefined> {
  try {
    const types = [...new Set([...entryAspectKeys(entry, opts)].map(
        key => _typeRefToName(key.split('@')[0], 'aspect')))];
    const res = await readEveryAspect(
        cat, opts, entry, types, {keepSourceResource: true});
    return isOkStatus(res) ? res.result : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes every model's entries and relationship links and deletes orphaned
 * resources in model order, as `writePlans` lays out.
 *
 * For each model, the method performs the following actions:
 *   1. Writes nothing for a model with nothing to write or delete whose anchor
 *      is labeled finished.
 *   2. Labels the anchor writing, and creates or updates the model's new and
 *      changed entries.
 *   3. Deletes the orphaned and stale relationship links.
 *   4. Creates the model's new relationship links, and updates a looked-up
 *      link only when its aspects changed.
 *   5. Deletes any existing entries owned by the model that are no longer
 *      emitted.
 *   6. Labels the anchor finished.
 *
 * Progress accumulates into `counts`, so a mid-way failure still reports what
 * had been written.
 */
async function writeEmittedModels(
    cat: CatalogClient, opts: KcDeployOptions, emitted: EmittedModel[],
    writePlans: WritePlan[], counts: Counts): Promise<WriteModelsOutcome> {
  for (const [i, {model, resources}] of emitted.entries()) {
    const plan = writePlans[i];
    counts.unchangedEntries += plan.unchanged;
    if (isNothingToWrite(resources, plan)) {
      counts.unchangedLinks += resources.entryLinks.length;
      continue;
    }

    const entries = await writeEntries(cat, opts, resources.entries, plan);
    counts.created += entries.created;
    counts.updated += entries.updated;
    if (entries.error) return {error: `Model '${model}': ${entries.error}`};

    const {orphanedLinks, staleLinks, foundUnchanged} = plan;
    // `deletedLinks` collects the links deleted so far. An error after a
    // delete gets the push-again hint when a link is missing because of it.
    const deletedLinks: EntryLink[] = [];
    const hint =
        (written: ReadonlySet<string> = new Set(),
         blocked: ReadonlySet<string> = new Set()) =>
            restoreHint(
                deletedLinks, resources.entryLinks,
                new Set([
                  ...staleLinks.current.keys(), ...foundUnchanged, ...written,
                ]),
                blocked);
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
    const links =
        await writeEntryLinks(cat, opts, resources, staleLinks.current);
    counts.linked += links.linked;
    counts.unchangedLinks += links.unchanged;
    deletedLinks.push(...links.deleted);
    if (links.error) {
      return {
        error: `Model '${model}': ${links.error}${
            hint(links.written, links.blocked)}`,
      };
    }

    // Finally, delete any entry this model owns but no longer emits.
    const deleted = await deleteEntries(cat, opts, plan.orphanedEntries);
    counts.deleted += deleted.deleted;
    if (deleted.error) {
      const {entryId, message} = deleted.error;
      return {
        error: `Deleting orphaned entry '${entryId}' from model '${
            model}' failed: ${message}`,
      };
    }

    if (resources.entries.length) {
      const anchor = resources.entries[0];
      const error = await setPushState(cat, opts, anchor, PUSH_FINISHED);
      if (error) {
        return {
          error: `Model '${model}': ${
              pushStateError(anchor, PUSH_FINISHED, error)}`,
        };
      }
    }
  }
  return {};
}

/**
 * Sets the push-state label of the model entry `anchor` to `state`, and
 * returns the error when that fails. The update names only the entrySource and
 * sends back the one `stored` holds, the model entry as read for the plan.
 * Without `stored`, it reads the entry first and sends back the entrySource
 * the entry holds then, so what another writer set during the push stays.
 */
async function setPushState(
    cat: CatalogClient, opts: KcDeployOptions, anchor: Entry, state: string,
    stored?: Entry): Promise<string|undefined> {
  try {
    let held = stored;
    if (!held) {
      const read = await cat.getEntry(
          opts.project, opts.location, opts.entryGroup, entryId(anchor),
          undefined, {keepSourceResource: true});
      if (!isOkStatus(read)) return errText(read);
      held = read.result;
    }
    const {name, entryType} = anchor;
    const entrySource = withPushState(held?.entrySource, state);
    const res =
        await cat.updateEntry({name, entryType, entrySource}, ['entry_source']);
    return isOkStatus(res) ? undefined : errText(res);
  } catch (err: any) {
    return String(err?.message || err).trim() || 'unknown error';
  }
}

/**
 * Returns the error for a failed write of the push-state label of the model
 * entry `anchor` as `state`, whose cause is `cause`.
 */
function pushStateError(anchor: Entry, state: string, cause: string): string {
  return `setting the ${PUSH_STATE_LABEL} label of entry '${
             entryId(anchor)}' to ${state} failed: ` +
      `${cause.replace(/\.$/, '')}. Push again before you pull.`;
}

// `source` with its kcmd-push-state label set to `state`.
function withPushState(
    source: Entry['entrySource'], state: string): Entry['entrySource'] {
  return {...source, labels: {...source?.labels, [PUSH_STATE_LABEL]: state}};
}

/**
 * Returns the push-again hint for an error, or '' when no link is missing.
 *
 * An emitted link is missing when this push deleted a link with its ID or its
 * two entries, and `presentIds` does not hold it. `presentIds` holds the IDs
 * of the links written or found unchanged. A link in `blockedIds` is never
 * missing: another link holds its two entries, so pushing again cannot write
 * it until that link is deleted, as its error says.
 */
function restoreHint(
    deletedLinks: readonly EntryLink[], emittedLinks: readonly EntryLink[],
    presentIds: ReadonlySet<string>, blockedIds: ReadonlySet<string>): string {
  const ends = (link: EntryLink) =>
      link.entryReferences.map(r => entryId(r)).sort().join('|');
  const missing = emittedLinks.some(
      link => !presentIds.has(linkId(link)) && !blockedIds.has(linkId(link)) &&
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
 * project. A link whose project number push cannot resolve is kept only when
 * every reference spells the same project as the link's name. Dataplex spells
 * a looked-up link's name and references alike, and one reference is the
 * looked-up entry, so such a link is in the destination project.
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
      if (!project) continue;
      const inScope = (await isScopeProject(project)) ??
          link.entryReferences.every(
              r => r.name.startsWith(`projects/${project}/`));
      if (!inScope || !isModelLink(link)) continue;
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
  // The model's own links under an emitted ID whose endpoints changed.
  links: EntryLink[];
  // The looked-up links, by emitted ID, that have the same endpoints.
  current: Map<string, EntryLink>;
}

/**
 * Returns the existing entry links in `existingLinks` that share a bare link ID
 * with an emitted link in `resources.entryLinks` but have different endpoint
 * references, so they must be deleted before recreating the link.
 *
 * A link ID names the link's kind and hashes the model's name, so only this
 * model's push writes a link under one of its IDs.
 */
function findStaleEntryLinks(
    resources: kcEmit.KcResources,
    existingLinks: Map<string, EntryLink>): StaleLinksOutcome {
  const links: EntryLink[] = [];
  const current = new Map<string, EntryLink>();
  if (!existingLinks.size) return {links, current};
  for (const link of resources.entryLinks) {
    const id = linkId(link);
    const existingLink = existingLinks.get(id);
    // Check whether `existingLink` is stale:
    //   1. If no link with this ID exists yet, `writeEntryLinks` creates it.
    //   2. If its endpoint references are unchanged, `writeEntryLinks` updates
    //      its aspects only when they differ.
    // Otherwise, its immutable endpoints changed, so it is stale.
    if (!existingLink) continue;
    if (isStaleLink(existingLink, link)) {
      links.push(existingLink);
    } else {
      current.set(id, existingLink);
    }
  }
  return {links, current};
}

/**
 * Returns true when `existingLink` has different immutable `entryReferences`
 * from `link` and must be deleted and recreated rather than updated in place.
 */
function isStaleLink(existingLink: EntryLink, link: EntryLink): boolean {
  return !sameLinkReferences(existingLink, link);
}

// The entries in `existing` of the model whose anchor ID is `anchor`: the
// anchor, and each entry whose ID starts with the anchor ID and a `.` or `/`.
//
// A foreign model is by definition not in this push, so its emitter's
// `ownedPrefixes` are unavailable. Ownership is instead the anchor followed by
// a separator (`.` or `/`), which matches every ID scheme
// (`<anchor>.entities.x` and `<anchor>/entities/x`) without hardcoding segment
// names. Naming the segments here would leave a model published by a different
// emitter with its children orphaned and unreachable -- the anchor goes, so no
// later push sees a foreign model, and nothing owns the remainder.
function entriesOfModel(anchor: string, existing: readonly Entry[]): Entry[] {
  const owner: KcAnchor = {
    anchorId: anchor,
    ownedPrefixes: [`${anchor}.`, `${anchor}/`],
  };
  return collectOwnedEntries(owner, existing);
}

/**
 * Deletes the other models in `foreign` (`--force-remove`), each with the
 * entries and links planning found for it.
 *
 * Deletes each model's anchor before anything else. Dataplex deletes an
 * entry's child entries with it, and a link with an entry it references, so a
 * push that stops here leaves the whole foreign model or none of it. Pull then
 * returns the whole model or finds none. The links and the children are
 * deleted after the anchor, and a 404 for one already gone counts as success.
 */
async function removeForeignModels(
    cat: CatalogClient, opts: KcDeployOptions,
    foreign: readonly ForeignModel[]):
    Promise<{deleted: number; unlinked: number; error?: string}> {
  let deleted = 0;
  let unlinked = 0;
  for (const model of foreign) {
    const foreignAnchorId = model.anchorId;
    // The anchor goes first and takes its children and their links with it.
    // A failure before it leaves the foreign model whole. The deletes after it
    // remove anything Dataplex left and normally get 404.
    const entryFailure = (e: NonNullable<ReconcileOutcome['error']>) => ({
      deleted,
      unlinked,
      error: `Deleting entry '${e.entryId}' from removed model '${
          foreignAnchorId}' failed: ${e.message}`,
    });
    const anchors =
        await deleteEntries(cat, opts, model.entries.filter(isAnchorEntry));
    deleted += anchors.deleted;
    if (anchors.error) return entryFailure(anchors.error);

    const links = await deleteEntryLinks(cat, opts, model.links);
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
        cat, opts, model.entries.filter(e => !isAnchorEntry(e)));
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
 * Creates or updates the entries of a model, `entries`, that `plan` says to
 * write, in dependency order.
 *
 * The method writes entries in three stages:
 *   1. Labels the model anchor (`entries[0]`) as writing. An anchor to write
 *      carries the label in its own write, since it is the parent of every
 *      child entry and goes first. An unchanged anchor gets a write of the
 *      label alone.
 *   2. Writes independent child entries (such as entities, relationships,
 *      actions, and constraints) concurrently.
 *   3. Writes dependent child entries (`semantic-metric` via
 *      `semantic-metric.entity` and, for LookML, `semantic-explore` via
 *      `semantic-explore.baseEntity` / `joins[].fromEntity`, which reference
 *      entities by name) concurrently.
 *
 * An entry that already exists is updated in place.
 */
async function writeEntries(
    cat: CatalogClient, opts: KcDeployOptions, entries: Entry[],
    plan: WritePlan): Promise<EntriesOutcome> {
  if (!entries.length) return {created: 0, updated: 0};
  const write = (e: Entry) => writeEntry(cat, opts, e, plan.sources);
  const [anchor] = entries;
  const writes = new Set(plan.writes);

  let created = 0;
  let updated = 0;
  if (writes.has(anchor)) {
    const entrySource = withPushState(anchor.entrySource, PUSH_WRITING);
    const anchorRes = await write({...anchor, entrySource});
    if (anchorRes.error) {
      return {created: 0, updated: 0, error: anchorRes.error};
    }
    if (anchorRes.updated) {
      updated++;
    } else {
      created++;
    }
  } else {
    const error = await setPushState(
        cat, opts, anchor, PUSH_WRITING, plan.storedAnchor);
    if (error) {
      return {
        created: 0,
        updated: 0,
        error: pushStateError(anchor, PUSH_WRITING, error),
      };
    }
  }

  const children = plan.writes.filter(e => e !== anchor);
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
  // The number of links written.
  linked: number;
  // The number of links the lookup found with the emitted endpoints and
  // aspects. Push sent no request for them.
  unchanged: number;
  // IDs of the links written or found unchanged.
  written: Set<string>;
  // IDs of the links another link blocks: their create returned 409, no link
  // holds their ID, and a lookup found the other link between their entries.
  blocked: Set<string>;
  // Existing links deleted so that an emitted link with new endpoints could
  // take their ID. The caller uses them for the push-again hint.
  deleted: EntryLink[];
  error?: string;
}

/**
 * Writes a model's relationship entry links concurrently.
 *
 * Both endpoint entries already exist because `writeEntries` runs first, and
 * any orphaned or stale links the lookup found have already been deleted. The
 * emitter gives each pair of entries at most one link of a type, so a 409 on a
 * link whose ID no link holds means another link joined its two entries when
 * push wrote it. Once every write is done, `blockedOutcome` looks that link
 * up. A stale link the lookup missed is replaced during these writes, so the
 * link in the way may be gone by then, and pushing again is enough. Uses
 * `Promise.allSettled` so a thrown network
 * error on one link waits for any in-flight link writes to finish and reports
 * the link ID in the returned error. `current` holds the looked-up links, by
 * emitted ID, that have the same endpoints.
 */
async function writeEntryLinks(
    cat: CatalogClient, opts: KcDeployOptions, resources: kcEmit.KcResources,
    current: ReadonlyMap<string, EntryLink>): Promise<LinksOutcome> {
  const entryLinks = resources.entryLinks;
  const written = new Set<string>();
  const blocked = new Set<string>();
  const deleted: EntryLink[] = [];
  if (!entryLinks.length) {
    return {linked: 0, unchanged: 0, written, blocked, deleted};
  }
  const settled = await Promise.allSettled(
      entryLinks.map(l => writeEntryLink(cat, opts, l, current)));
  const res = await Promise.all(settled.map((s, i): LinkWriteOutcome |
                                              Promise<LinkWriteOutcome> => {
    if (s.status === 'rejected') {
      const id = linkId(entryLinks[i]);
      const msg = s.reason?.message || String(s.reason);
      return {error: `entry link '${id}': ${msg}`};
    }
    const {conflict} = s.value;
    return conflict === undefined ?
        s.value :
        blockedOutcome(cat, opts, entryLinks[i], conflict);
  }));
  res.forEach((r, i) => {
    if (r.deleted) deleted.push(r.deleted);
    if (r.blocked) blocked.add(linkId(entryLinks[i]));
    if (!r.error) written.add(linkId(entryLinks[i]));
  });
  const unchanged = res.filter(r => r.unchanged).length;
  const linked = res.filter(r => !r.error && !r.unchanged).length;
  const firstErr = res.find(r => r.error);
  if (firstErr) {
    return {
      linked,
      unchanged,
      written,
      blocked,
      deleted,
      error: firstErr.error,
    };
  }
  return {linked, unchanged, written, blocked, deleted};
}

interface WriteOutcome {
  updated?: boolean;  // true when the resource already existed and was updated
  error?: string;
}

interface LinkWriteOutcome {
  // True when the looked-up link already holds the emitted aspects, so push
  // sent no request.
  unchanged?: boolean;
  // The existing link deleted so that the emitted link could take its ID.
  deleted?: EntryLink;
  // True when another link holds the two entries of the emitted link.
  blocked?: boolean;
  // The text of a 409 on creating a link whose ID no link holds.
  // `writeEntryLinks` turns it into `error` once every write is done.
  conflict?: string;
  error?: string;
}

/**
 * Writes a single relationship entry link to Knowledge Catalog.
 *
 * `current` holds the looked-up links, by emitted ID, that have the same
 * endpoints. For a link in `current`, push sends nothing when the stored
 * aspects match `link`, and an update when they differ. Any other link is
 * created. When `createEntryLink` returns HTTP 409, push updates the link
 * under its ID, replaces it, or reports why it cannot write it.
 */
async function writeEntryLink(
    cat: CatalogClient, opts: KcDeployOptions, link: EntryLink,
    current: ReadonlyMap<string, EntryLink>): Promise<LinkWriteOutcome> {
  const id = linkId(link);
  const found = current.get(id);
  if (found) {
    if (holdsAspects(found.aspects, link.aspects)) return {unchanged: true};
    return linkOutcome(link, await updateEntryLink(cat, link));
  }
  const res = await cat.createEntryLink(
      opts.project, opts.location, opts.entryGroup, id, link);
  if (!isExistsStatus(res)) return linkOutcome(link, res);

  // The lookup did not return a link under this ID, so read it.
  const read = await readEmittedLink(cat, link);
  if (read.error) return {error: read.error};
  if (!read.existing) {
    // No link holds the ID. Dataplex allows one link of a type between two
    // entries, so the 409 means another link joined them.
    return {conflict: errText(res)};
  }
  // The update patches only the aspects, and a link's references are
  // immutable. A link whose endpoints changed is deleted and created again.
  if (isStaleLink(read.existing, link)) {
    return replaceEntryLink(cat, opts, read.existing, link);
  }
  return linkOutcome(link, await updateEntryLink(cat, link));
}

interface ReadLinkOutcome {
  // The link under the emitted ID. Unset when no link holds the ID.
  existing?: EntryLink;
  error?: string;
}

/**
 * Reads the link under the ID of the emitted link `link`, and returns the
 * error when the read fails with anything but 404.
 */
async function readEmittedLink(
    cat: CatalogClient, link: EntryLink): Promise<ReadLinkOutcome> {
  const found = await cat.getEntryLink(link.name!);
  if (isNotFoundStatus(found)) return {};
  if (!isOkStatus(found) || !found.result) {
    return {
      error: `reading entry link '${linkId(link)}' failed: ${errText(found)}`,
    };
  }
  return {existing: found.result};
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
 * Deletes `existingLink`, a stale relationship entry link, and recreates it as
 * `link` with its updated `entryReferences`.
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
 * Returns true when `stored`, the aspects a link or an entry holds, has every
 * aspect of `sent` with the same data, so writing `sent` would change none of
 * them. An aspect matches by its key without the project part, because
 * Dataplex spells the project of a type as a number. Fields Dataplex adds to
 * an aspect, such as its times and aspectSource, are not compared.
 */
function holdsAspects(
    stored: Record<string, Aspect>|undefined,
    sent: Record<string, Aspect>|undefined): boolean {
  const byKey = new Map(Object.entries(stored ?? {})
                            .map(([key, a]) => [keyWithoutProject(key), a]));
  return Object.entries(sent ?? {}).every(([key, aspect]) => {
    const found = byKey.get(keyWithoutProject(key));
    // The sent data is compared as its JSON, which is what push sends.
    return found !== undefined &&
        isDeepStrictEqual(
               JSON.parse(JSON.stringify(aspect.data ?? {})), found.data ?? {});
  });
}

// An aspect key, `<project>.<location>.<type>` with an optional `@<path>`,
// without its project part.
function keyWithoutProject(key: string): string {
  const [ref, ...path] = key.split('@');
  return [ref.split('.').slice(-2).join('.'), ...path].join('@');
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
 * The outcome of `link`, whose create returned 409 with the text `conflict`
 * although no link holds its ID. Looks up the links of its first entry for
 * another link of its type between its two entries. When one is there, the
 * error names it and says to delete it. Otherwise the link that was in the way
 * is gone, and the error gives the 409's own text, which the caller gives the
 * push-again hint when a delete of this push left the link missing. A failed
 * lookup counts as finding nothing.
 */
async function blockedOutcome(
    cat: CatalogClient, opts: KcDeployOptions, link: EntryLink,
    conflict: string): Promise<LinkWriteOutcome> {
  const id = linkId(link);
  // Dataplex spells a looked-up link's references with the project number.
  const ends = (l: EntryLink) =>
      l.entryReferences.map(r => r.name.replace(/^projects\/[^/]+\//, ''))
          .sort()
          .join('|');
  const found = await cat
                    .lookupEntryLinks(
                        opts.project, opts.location,
                        {entry: link.entryReferences[0].name})
                    .catch(() => undefined);
  const other = found && isOkStatus(found) ?
      (found.result ?? [])
          .find(
              l => linkId(l) !== id && linkTypeId(l) === linkTypeId(link) &&
                  ends(l) === ends(link)) :
      undefined;
  if (!other) return {error: `entry link '${id}': ${conflict}`};
  const source = other.entryReferences.find(r => r.type === 'SOURCE');
  const target = other.entryReferences.find(r => r.type === 'TARGET');
  const joins = source && target ?
      `goes from '${entryId(source)}' to '${entryId(target)}'` :
      `connects ${
          other.entryReferences.map(r => `'${entryId(r)}'`).join(' and ')}`;
  return {
    error: `failed to create entry link '${id}' because another '${
               linkTypeId(link)}' link '${linkId(other)}' already ${joins}; ` +
        `delete that link, then push again`,
    blocked: true,
  };
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
 * deleted, `sql-expressions`, or a field's instance, matched by its `@*` key)
 * is deleted so a later `pull` does not bring it back. Push owns the optional
 * aspects `entryAspectKeys` lists, so it removes any that the model does not
 * declare even if someone added them in the console. Every other
 * aspect another tool attached is left alone, since `aspectKeys` names only the
 * types kcmd writes. The body is `updateBody(entry, source)`.
 */
async function updateEntry(
    cat: CatalogClient, opts: KcDeployOptions, entry: Entry,
    source?: Entry['entrySource']): Promise<WriteOutcome> {
  entry = updateBody(entry, source);
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
 * Returns the entry `updateEntry` sends to update `entry`, given `source`, the
 * entrySource the entry holds before this push.
 *
 * The update mask replaces the whole entrySource, so the update carries over
 * fields from `source`. Of those fields kcmd owns the display name and the
 * description. The update keeps another writer's `resource`, `system`,
 * `platform`, `createTime` and `updateTime`, and every label. A label `entry`
 * carries, such as the model entry's `kcmd-push-state`, replaces the stored
 * one. Dataplex refuses an update that leaves out an `updateTime` the entry
 * has, or moves it back. A kept field another writer changes after `source`
 * was read is written back with the old value. For `updateTime` the update
 * fails instead.
 */
function updateBody(entry: Entry, source?: Entry['entrySource']): Entry {
  const labels = {...source?.labels, ...entry.entrySource?.labels};
  const kept = Object.fromEntries(
      KEPT_SOURCE_FIELDS.filter(k => source?.[k] !== undefined)
          .map(k => [k, source![k]]));
  const merged = {
    ...kept,
    ...entry.entrySource,
    ...(Object.keys(labels).length ? {labels} : {}),
  };
  return Object.keys(merged).length ? {...entry, entrySource: merged} : entry;
}

/**
 * Returns true when the update of the emitted entry `entry` would leave
 * `stored`, the entry as read with the aspect types the update names, exactly
 * as it is:
 *   1. The entrySource the update sends matches the stored one (see
 *      `sameSource`).
 *   2. `stored` holds every aspect of `entry` with the same data.
 *   3. `entry` carries every stored aspect the update's aspect keys name, so
 *      the update removes none.
 */
function isUnchanged(
    entry: Entry, stored: Entry, opts: KcDeployOptions): boolean {
  const sent = updateBody(entry, stored.entrySource).entrySource;
  return sameSource(sent, stored.entrySource) &&
      holdsAspects(stored.aspects, entry.aspects) &&
      sendsNamedAspects(
             stored.aspects, entry.aspects, entryAspectKeys(entry, opts));
}

// The entrySource fields Dataplex sets itself, which an update cannot change.
const OUTPUT_SOURCE_FIELDS: ReadonlySet<string> = new Set(['location']);

/**
 * Returns true when the entrySource `sent` would leave `stored` as it is. The
 * fields Dataplex sets itself are not compared, and an empty string, list or
 * map counts as unset, as Dataplex returns it.
 */
function sameSource(
    sent: Entry['entrySource'], stored: Entry['entrySource']): boolean {
  const compared = (source: Entry['entrySource']) => Object.fromEntries(
      Object.entries(source ?? {})
          .filter(([k, v]) => !OUTPUT_SOURCE_FIELDS.has(k) && !isUnset(v)));
  return isDeepStrictEqual(compared(sent), compared(stored));
}

// Whether Dataplex stores `value` as unset.
function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === '' ||
      (typeof value === 'object' && !Object.keys(value).length);
}

/**
 * Returns true when `sent` carries every aspect in `stored` that `keys`, the
 * aspect keys of an update with `deleteMissingAspects`, name. Such an update
 * removes each named aspect it does not carry. A key names the instance at
 * the entry itself, and `<type>@*` names every instance at a path.
 */
function sendsNamedAspects(
    stored: Record<string, Aspect>|undefined,
    sent: Record<string, Aspect>|undefined, keys: Set<string>): boolean {
  const named = new Set([...keys].map(keyWithoutProject));
  const sentKeys = new Set(Object.keys(sent ?? {}).map(keyWithoutProject));
  return Object.keys(stored ?? {}).map(keyWithoutProject).every(key => {
    const at = key.indexOf('@');
    const isNamed =
        named.has(key) || (at >= 0 && named.has(`${key.slice(0, at)}@*`));
    return !isNamed || sentKeys.has(key);
  });
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
