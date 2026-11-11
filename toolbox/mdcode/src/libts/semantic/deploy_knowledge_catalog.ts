// Deploys a semantic model's Knowledge Catalog resources.
//
// This is the Knowledge Catalog leg of `kcmd push` for the semantic-model
// scope, the counterpart to `deploy_bigquery.ts`. It consumes models already
// parsed into the semantic IR (see loadSemanticModels, shared with the BigQuery
// leg so a multi-destination push parses each document once), maps each to
// catalog Entries + Aspects (the pure emitter in knowledge_catalog.ts), and
// writes them through the Knowledge Catalog client.
//
// Types: the `semantic-model`/`semantic-entity`/`semantic-metric`/
// `semantic-relationship` entry and aspect types — and the built-in `schema`,
// `guidelines`, `overview`, `semantic-extensions` and `sql-expressions` aspects
// — are built-in system types in `dataplex-types/global`, while `kcmd`-owned
// custom types (`semantic-action` and `semantic-constraint`) live in the
// destination project. Push does NOT provision any type, nor the entry group
// (those are created at `init`); it only validates and writes entries and entry
// links.
//
// Publish sequence (split into read-only `preflightKnowledgeCatalog` and write
// `applyKnowledgeCatalog`):
//   * Preflight validates that exactly one model is deployed per entry group,
//     snapshots the destination entry group to guard against foreign models
//     (unless `--force-remove` is set), and checks that any required custom
//     entry/aspect types exist in the target project. It also checks every
//     aspect's size.
//   * Apply creates or updates each model's entries in dependency order: the
//     `semantic-model` anchor first, then independent child entries
//     concurrently, and finally dependent child entries (`semantic-metric` and
//     `semantic-explore`).
//   * Relationships are published as entry links after that model's entries
//     exist: a `semantic-link` per ordered pair of related entities, a
//     `reference` link from each relationship entry to each of its entities,
//     and one from each entity to each parent it extends. When
//     `bigQueryEntries` is resolved, `@bigquery` binding links (`schema-join`
//     to node view / table and graph node entries) are reconciled non-fatally.
//     All link writes retry HTTP 429 quota responses (`withLinkQuotaRetry`).
//   * Reconcile deletions: after writing, delete any child entry this push owns
//     (by `ownedPrefixes`) that is present in the pre-write listing but was not
//     re-emitted.
//   * The anchor's write labels it `kcmd-push-state: writing`, and the push's
//     last write, after the deletions, relabels it `finished`.
//
// This is a library module: it emits no console output. Warnings and the
// dry-run plan are returned in `KcDeployResult` for the CLI (commands.ts) to
// print.

import {isDeepStrictEqual} from 'node:util';

import {ApiResult} from '../gcp/api';
import * as context from '../gcp/context';
import * as crm from '../gcp/crm';
import {Aspect, CatalogClient, Entry, EntryLink} from '../gcp/dataplex';
import type {OverviewSidecar} from '../layouts/semantic-model';

import {ConstraintRates} from './constraint_enforcement';
import {BigQueryEntryLocator} from './kc_annotations';
import {resolveBigQueryEntries} from './kc_closure_env';
import {collectCustomTypes, customTypeHome, PUSH_FINISHED, PUSH_STATE_LABEL, PUSH_WRITING} from './kc_custom_types';
import {anchorId, collectEntityNames, collectOwnedEntries, entryAspectKeys, entryId, entryTypeId, isAnchorEntry, isDependentEntry, isEntryOwner, isLinkOwner, isModelLink, KcAnchor, linkId, linkTypeId, sameLinkReferences,} from './kc_entries';
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
  // The overview sidecar of each entry, by entry id, which the emitter writes
  // into the entry's overview.
  overviews?: ReadonlyMap<string, OverviewSidecar>;
  // Resolved `@bigquery` dataset locations and project numbers for entity
  // binding links (K3).
  bigQueryEntries?: BigQueryEntryLocator;
  // Measured constraint violation rates per model -> entity -> constraint.
  constraintRates?: ReadonlyMap<string, ConstraintRates>;
  // Append derived runtime grounding trailers (`Contents:`, `Read through:`,
  // `Relationships:`, `Query:`) on entry descriptions.
  groundingTrailers?: boolean;
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
  // Optional overrides for entry-link HTTP 429 quota retries.
  linkWriteTries?: number;
  linkRetryMs?: number;
}

export interface KcDeployResult {
  // Whether the push (or --validate-only run) completed without error.
  success: boolean;
  // On failure, a human-readable reason; unset on success.
  details?: string;
  // Loader and emitter warnings collected across all documents.
  warnings: string[];
  // New entries created in the entry group (0 for validateOnly).
  created: number;
  // Existing entries updated in place by an idempotent re-push (0 for
  // validateOnly).
  updated: number;
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
  // K3: `@bigquery` binding links written. Set only when `bigQueryEntries` was
  // supplied; a binding link that fails is a warning, not a failed push.
  bound?: number;
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
  unchangedLinks: number;
  unlinked: number;
  bound?: number;
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

// Entry-link writes share a per-minute, per-region quota (300 by default). A
// push that writes more links than that in a minute gets HTTP 429 on the rest;
// waiting 20 s, 40 s, then 60 s spans a full quota window.
const LINK_WRITE_TRIES = 4;
const LINK_RETRY_MS = 20000;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// Runs one entry-link write, retrying while the entry-link quota refuses it.
async function withLinkQuotaRetry<T>(
    opts: KcDeployOptions,
    call: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  const tries = opts.linkWriteTries ?? LINK_WRITE_TRIES;
  const retryMs = opts.linkRetryMs ?? LINK_RETRY_MS;
  let res = await call();
  for (let attempt = 1; attempt < tries && res.status === 429; attempt++) {
    await sleep(retryMs * attempt);
    res = await call();
  }
  return res;
}

/**
 * Runs every read-only check for a Knowledge Catalog push without writing to
 * the catalog.
 *
 * The method performs the following actions:
 *   1. Translates the IR models into catalog resources.
 *   2. Verifies that exactly one model is being deployed, builds the dry-run
 *      plan, and returns early when `opts.validateOnly` is set.
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
 * Writes a preflight-checked Knowledge Catalog deployment.
 *
 * The method performs the following actions:
 *   1. Removes foreign models when `--force-remove` is set.
 *   2. Writes each emitted model's entries and relationship links (plus any
 *      `@bigquery` binding links) and deletes any orphaned links and entries.
 */
export async function applyKnowledgeCatalog(
    prepared: KcPreparedDeploy, ctx: context.ApiContext,
    opts: KcDeployOptions): Promise<KcDeployResult> {
  const warnings: string[] = [...prepared.warnings];
  const counts: Counts = {
    created: 0,
    updated: 0,
    deleted: 0,
    linked: 0,
    unchangedLinks: 0,
    unlinked: 0,
  };
  const plan = prepared.plan;
  const result: ResultBuilder = (success, details) =>
      ({success, warnings, ...counts, plan, ...(details ? {details} : {})});

  const cat = new CatalogClient(ctx);
  const {emitted, existing} = prepared;
  // Resource Manager is asked for the project number at most once per push.
  const isScopeProject = scopeProjectMatcher(ctx, opts.project);

  if (opts.forceRemove) {
    const foreignAnchorIds = findForeignAnchorIds(emitted[0], existing);
    if (foreignAnchorIds.length) {
      // A thrown error is reported like a failed delete.
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
      if (removed.error) return result(false, removed.error);
    }
  }

  // Write each emitted model's entries and relationship links and delete any
  // orphaned resources. A thrown error, such as a network failure, can stop
  // the writes partway too, so it is reported the same way. The counts then
  // leave out what the step that threw had already written.
  const written =
      await writeEmittedModels(
          cat, opts, emitted, existing, counts, warnings, isScopeProject)
          .catch((err: any): WriteModelsOutcome =>
                     ({error: String(err?.message || err).trim()}));
  if (written.error) return result(false, written.error);

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
 * Post-BigQuery grounding pass for two-phase `kcmd push`: once BigQuery node
 * views and property graphs have been deployed (and optional `constraintRates`
 * measured), resolves `@bigquery` entry locations/project numbers, reconciles
 * non-fatal `@bigquery` `bindingLinks`, and refreshes entity descriptions when
 * `constraintRates` are present. No-op when `prepared.emitted` is empty.
 */
export async function syncBigQueryCatalogGrounding(
    prepared: KcPreparedDeploy, models: LoadedModel[],
    constraintRates: ReadonlyMap<string, ConstraintRates>|undefined,
    ctx: context.ApiContext,
    opts: KcDeployOptions): Promise<{bound: number; warnings: string[]}> {
  if (!prepared.emitted.length) return {bound: 0, warnings: []};
  const warnings: string[] = [];
  const bigQueryEntries =
      await resolveBigQueryEntries(models.map(m => m.model), ctx);
  const cat = new CatalogClient(ctx);
  const isScopeProject = scopeProjectMatcher(ctx, opts.project);
  let bound = 0;

  for (const {model} of models) {
    const resources = kcEmit.generateCatalogResources(model, {
      project: opts.project,
      location: opts.location,
      entryGroup: opts.entryGroup,
      systemTypeProject: opts.systemTypeProject,
      systemTypeLocation: opts.systemTypeLocation,
      overviews: opts.overviews,
      bigQueryEntries,
      constraintRates,
      groundingTrailers: true,
    });
    for (const w of resources.warnings) warnings.push(`[${model.name}] ${w}`);

    if (constraintRates?.get(model.name)?.size) {
      for (const entry of resources.entries) {
        if (!entry.entryType?.endsWith('/entryTypes/semantic-entity')) continue;
        await writeEntry(cat, opts, entry, new Map());
      }
    }

    if (resources.bindingLinks) {
      const entityNames = collectEntityNames(resources.entries);
      const lookedUp = entityNames.length ?
          await lookupEntryLinks(cat, opts, entityNames, isScopeProject) :
          {links: new Map<string, EntryLink>()};
      if (!lookedUp.error) {
        const stale = findStaleBindingLinks(
            model.name, resources.bindingLinks, lookedUp.links);
        await deleteEntryLinks(cat, opts, stale);
      }
      for (const link of resources.bindingLinks) {
        const res = await writeBindingLink(cat, opts, link)
                        .catch((err: any) => ({
                                 error: `entry link '${linkId(link)}': ${
                                     String(err?.message || err).trim()}`,
                               }));
        if (res.error) {
          warnings.push(`[${model.name}] binding link skipped: ${res.error}`);
        } else {
          bound++;
        }
      }
    }
  }
  return {bound, warnings: [...new Set(warnings)]};
}

/**
 * Runs read-only preflight checks on already-emitted models.
 */
async function preflightEmittedModels(
    emitted: EmittedModel[], emitWarnings: string[], ctx: context.ApiContext,
    opts: KcDeployOptions):
    Promise<{prepared?: KcPreparedDeploy; result?: KcDeployResult}> {
  const warnings: string[] = [...emitWarnings];
  const counts: Counts = {
    created: 0,
    updated: 0,
    deleted: 0,
    linked: 0,
    unchangedLinks: 0,
    unlinked: 0,
  };
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
  if (opts.validateOnly) return {result: result(true)};

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
 */
function findForeignAnchorIds(
    model: EmittedModel|undefined, existing: readonly Entry[]): string[] {
  const modelAnchorId = anchorId(model?.resources.entries[0]);
  return existing.map(anchorId).filter(
      (id): id is string => id !== undefined && id !== modelAnchorId);
}

/**
 * Validates that `emitted` contains a single model.
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

/** The error for a push to an entry group that does not exist. */
function missingEntryGroupMessage(opts: KcDeployOptions): string {
  const {project, location, entryGroup} = opts;
  return `entry group '${entryGroup}' does not exist in location ` +
      `'${location}' of project '${project}'; run 'kcmd init ` +
      `--semantic-model ${project}.${location}.${entryGroup}' to create it, ` +
      `or correct the scope in catalog.yaml.`;
}

/**
 * Validates that `existing` (the destination entry-group snapshot) contains no
 * foreign `semantic-model` anchors unless `--force-remove` is set.
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
      bigQueryEntries: opts.bigQueryEntries,
      constraintRates: opts.constraintRates,
      groundingTrailers: opts.groundingTrailers,
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
  if (resources.bindingLinks?.length) {
    lines.push(
        `  ${resources.bindingLinks.length} binding link${
            resources.bindingLinks.length === 1 ? '' : 's'} (to @bigquery):`,
        ...resources.bindingLinks.map(
            l => `    - ${linkId(l)} -> ${
                entryIdOf(l.entryReferences[1]?.name ?? '')}`));
  }
  return lines;
}

interface WriteModelsOutcome {
  error?: string;
}

/**
 * Writes every model's entries and relationship links and deletes orphaned
 * resources in model order.
 */
async function writeEmittedModels(
    cat: CatalogClient, opts: KcDeployOptions, emitted: EmittedModel[],
    existing: Entry[], counts: Counts, warnings: string[],
    isScopeProject: ProjectMatcher): Promise<WriteModelsOutcome> {
  for (const {model, resources} of emitted) {
    const entries =
        await writeEntries(cat, opts, resources.entries, existing);
    counts.created += entries.created;
    counts.updated += entries.updated;
    if (entries.error) return {error: `Model '${model}': ${entries.error}`};

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

    const orphanedLinks = findOrphanedEntryLinks(resources, existingLinks);
    const staleLinks = findStaleEntryLinks(resources, existingLinks);
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

    // K3: binding links point into `@bigquery`, whose entries exist only once
    // BigQuery has created the view / graph and Dataplex has indexed it. A
    // refusal there says nothing about the model, so each is written on its
    // own and a failure is a warning.
    if (resources.bindingLinks) {
      const staleBindings =
          findStaleBindingLinks(model, resources.bindingLinks, existingLinks);
      const unbound = await deleteEntryLinks(cat, opts, staleBindings);
      counts.unlinked += unbound.deleted.length;
      if (unbound.error) {
        const {linkId, message} = unbound.error;
        return {
          error: `Deleting stale binding link '${linkId}' from model '${
              model}' failed: ${message}`,
        };
      }
      counts.bound ??= 0;
      for (const link of resources.bindingLinks) {
        const res = await writeBindingLink(cat, opts, link)
                        .catch((err: any) => ({
                                 error: `entry link '${linkId(link)}': ${
                                     String(err?.message || err).trim()}`,
                               }));
        if (res.error) {
          warnings.push(`[${model}] binding link skipped: ${res.error}`);
        } else {
          counts.bound = (counts.bound ?? 0) + 1;
        }
      }
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

    if (resources.entries.length) {
      const anchor = resources.entries[0];
      const error =
          await finishPush(cat, opts, anchor)
              .catch((err: any) =>
                         String(err?.message || err).trim() || 'unknown error');
      if (error) {
        return {
          error: `Model '${model}': setting the ${PUSH_STATE_LABEL} label of ` +
              `entry '${entryId(anchor)}' to ${PUSH_FINISHED} failed: ` +
              `${error.replace(/\.$/, '')}. Push again before you pull.`,
        };
      }
    }
  }
  return {};
}

/**
 * Labels the model entry `anchor` finished, and returns the error when that
 * fails.
 */
async function finishPush(
    cat: CatalogClient, opts: KcDeployOptions,
    anchor: Entry): Promise<string|undefined> {
  const read = await cat.getEntry(
      opts.project, opts.location, opts.entryGroup, entryId(anchor),
      undefined, {keepSourceResource: true});
  if (!isOkStatus(read)) return errText(read);
  const {name, entryType} = anchor;
  const entrySource = withPushState(read.result?.entrySource, PUSH_FINISHED);
  const res =
      await cat.updateEntry({name, entryType, entrySource}, ['entry_source']);
  return isOkStatus(res) ? undefined : errText(res);
}

// `source` with its kcmd-push-state label set to `state`.
function withPushState(
    source: Entry['entrySource'], state: string): Entry['entrySource'] {
  return {...source, labels: {...source?.labels, [PUSH_STATE_LABEL]: state}};
}

/**
 * Returns the push-again hint for an error, or '' when no link is missing.
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
 */
function findOrphanedEntries(
    resources: kcEmit.KcResources, existing: Entry[]): Entry[] {
  if (!resources.entries.length) return [];
  const emittedIds = new Set(resources.entries.map(entryId));
  return existing.filter(
      e => isEntryOwner(resources, e) && !emittedIds.has(entryId(e)));
}

/**
 * Deletes every entry in `entries`.
 */
async function deleteEntries(
    cat: CatalogClient, opts: KcDeployOptions,
    entries: Iterable<Entry>): Promise<ReconcileOutcome> {
  let deleted = 0;
  for (const entry of entries) {
    const id = entryId(entry);
    const res =
        await cat.deleteEntry(opts.project, opts.location, opts.entryGroup, id);
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
 */
async function listEntryGroup(
    cat: CatalogClient,
    opts: KcDeployOptions): Promise<{entries: Entry[]; error?: string}> {
  const entries: Entry[] = [];
  try {
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

type ProjectMatcher = (nameProject: string) => Promise<boolean|undefined>;

function scopeProjectMatcher(
    ctx: context.ApiContext, project: string): ProjectMatcher {
  let crmNumber: Promise<string|undefined>|undefined;
  return async (nameProject: string) => {
    if (nameProject === project) return true;
    if (!/^\d+$/.test(nameProject)) return false;
    const number = await (crmNumber ??= crm.projectNumber(project, ctx));
    return number === undefined ? undefined : nameProject === number;
  };
}

/**
 * Deletes every entry link in `links`.
 */
async function deleteEntryLinks(
    cat: CatalogClient, opts: KcDeployOptions,
    links: Iterable<EntryLink>): Promise<LinkReconcileOutcome> {
  const deleted: EntryLink[] = [];
  for (const link of links) {
    const id = linkId(link);
    let del: ApiResult<EntryLink>;
    try {
      del = await withLinkQuotaRetry(
          opts,
          () => cat.deleteEntryLink(
              opts.project, opts.location, opts.entryGroup, id));
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
 */
function findOrphanedEntryLinks(
    resources: kcEmit.KcResources,
    existingLinks: Map<string, EntryLink>): EntryLink[] {
  if (!resources.entries.length || !existingLinks.size) return [];
  const emittedLinkIds = new Set(resources.entryLinks.map(linkId));
  return [...existingLinks.values()].filter(
      link =>
          isLinkOwner(resources, link) && !emittedLinkIds.has(linkId(link)));
}

interface StaleLinksOutcome {
  links: EntryLink[];
  current: Map<string, EntryLink>;
}

/**
 * Returns the existing entry links in `existingLinks` that share a bare link ID
 * with an emitted link in `resources.entryLinks` but have different endpoint
 * references.
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
    if (!existingLink) continue;
    if (isStaleLink(existingLink, link)) {
      links.push(existingLink);
    } else {
      current.set(id, existingLink);
    }
  }
  return {links, current};
}

function isStaleLink(existingLink: EntryLink, link: EntryLink): boolean {
  return !sameLinkReferences(existingLink, link);
}

/**
 * Deletes models already in the entry group that this push does not re-emit
 * (`--force-remove`).
 */
async function removeForeignModels(
    cat: CatalogClient, opts: KcDeployOptions, existing: Entry[],
    foreignAnchorIds: string[], isScopeProject: ProjectMatcher):
    Promise<{deleted: number; unlinked: number; error?: string}> {
  let deleted = 0;
  let unlinked = 0;
  for (const foreignAnchorId of foreignAnchorIds) {
    const foreignAnchor: KcAnchor = {
      anchorId: foreignAnchorId,
      ownedPrefixes: [`${foreignAnchorId}.`, `${foreignAnchorId}/`],
    };
    const foreignEntries = collectOwnedEntries(foreignAnchor, existing);
    const foreignEntityNames = collectEntityNames(foreignEntries);

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
 */
async function writeEntries(
    cat: CatalogClient, opts: KcDeployOptions, entries: Entry[],
    existing: Entry[] = []): Promise<EntriesOutcome> {
  if (!entries.length) return {created: 0, updated: 0};
  const sources = new Map(existing.map(e => [entryId(e), e.entrySource]));
  const write = (e: Entry) => writeEntry(cat, opts, e, sources);
  const [anchor, ...children] = entries;

  const entrySource = withPushState(anchor.entrySource, PUSH_WRITING);
  const anchorRes = await write({...anchor, entrySource});
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
  unchanged: number;
  written: Set<string>;
  blocked: Set<string>;
  deleted: EntryLink[];
  error?: string;
}

/**
 * Writes a model's relationship entry links concurrently.
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
  updated?: boolean;
  error?: string;
}

interface LinkWriteOutcome {
  unchanged?: boolean;
  deleted?: EntryLink;
  blocked?: boolean;
  conflict?: string;
  error?: string;
}

/**
 * Writes a single relationship entry link to Knowledge Catalog.
 */
async function writeEntryLink(
    cat: CatalogClient, opts: KcDeployOptions, link: EntryLink,
    current: ReadonlyMap<string, EntryLink>): Promise<LinkWriteOutcome> {
  const id = linkId(link);
  const found = current.get(id);
  if (found) {
    if (hasLinkAspects(found, link)) return {unchanged: true};
    return linkOutcome(link, await updateEntryLink(cat, opts, link));
  }
  const res = await withLinkQuotaRetry(
      opts,
      () => cat.createEntryLink(
          opts.project, opts.location, opts.entryGroup, id, link));
  if (!isExistsStatus(res)) return linkOutcome(link, res);

  const read = await readEmittedLink(cat, link);
  if (read.error) return {error: read.error};
  if (!read.existing) {
    return {conflict: errText(res)};
  }
  if (isStaleLink(read.existing, link)) {
    return replaceEntryLink(cat, opts, read.existing, link);
  }
  return linkOutcome(link, await updateEntryLink(cat, opts, link));
}

interface ReadLinkOutcome {
  existing?: EntryLink;
  error?: string;
}

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

function linkOutcome(
    link: EntryLink, res: {status: number; message?: string}): LinkWriteOutcome {
  return isOkStatus(res) ? {} :
                           {error: `entry link '${linkId(link)}': ${errText(res)}`};
}

async function replaceEntryLink(
    cat: CatalogClient, opts: KcDeployOptions, existingLink: EntryLink,
    link: EntryLink): Promise<LinkWriteOutcome> {
  const id = linkId(link);
  const del = await withLinkQuotaRetry(
      opts,
      () => cat.deleteEntryLink(
          opts.project, opts.location, opts.entryGroup, id));
  if (!isOkStatus(del) && !isNotFoundStatus(del)) {
    return {error: `entry link '${id}': ${errText(del)}`};
  }
  try {
    const recreated = await withLinkQuotaRetry(
        opts,
        () => cat.createEntryLink(
            opts.project, opts.location, opts.entryGroup, id, link));
    return {...linkOutcome(link, recreated), deleted: existingLink};
  } catch (err: any) {
    const message = String(err?.message || err).trim();
    return {error: `entry link '${id}': ${message}`, deleted: existingLink};
  }
}

function hasLinkAspects(existing: EntryLink, link: EntryLink): boolean {
  const stored = new Map(Object.entries(existing.aspects ?? {})
                             .map(([key, a]) => [keyWithoutProject(key), a]));
  return Object.entries(link.aspects ?? {}).every(([key, aspect]) => {
    const found = stored.get(keyWithoutProject(key));
    return found !== undefined &&
        isDeepStrictEqual(
               JSON.parse(JSON.stringify(aspect.data ?? {})), found.data ?? {});
  });
}

function keyWithoutProject(key: string): string {
  const [ref, ...path] = key.split('@');
  return [ref.split('.').slice(-2).join('.'), ...path].join('@');
}

async function updateEntryLink(
    cat: CatalogClient, opts: KcDeployOptions,
    link: EntryLink): Promise<ApiResult<EntryLink>> {
  if (!link.aspects) return {status: 200};
  return withLinkQuotaRetry(
      opts,
      () => cat.updateEntryLink(
          {name: link.name, aspects: link.aspects} as EntryLink,
          Object.keys(link.aspects!)));
}

/**
 * Writes one `@bigquery` binding link (K3): creates it, and when it already
 * exists (HTTP 409) refreshes its aspects in place. Treats 404/403 on update
 * as success for catalog surfaces that expose only create and lookup.
 */
async function writeBindingLink(
    cat: CatalogClient, opts: KcDeployOptions,
    link: EntryLink): Promise<{error?: string}> {
  const id = linkId(link);
  const res = await withLinkQuotaRetry(
      opts,
      () => cat.createEntryLink(
          opts.project, opts.location, opts.entryGroup, id, link));
  if (!isExistsStatus(res)) return linkOutcome(link, res);
  const upd = await updateEntryLink(cat, opts, link);
  if (upd.status === 404 || upd.status === 403) return {};
  return linkOutcome(link, upd);
}

/**
 * Returns the model's existing `@bigquery` binding links (K3) that
 * `bindingLinks` no longer emits, or whose type or endpoints changed.
 */
function findStaleBindingLinks(
    model: string, bindingLinks: readonly EntryLink[],
    existingLinks: ReadonlyMap<string, EntryLink>): EntryLink[] {
  const prefix = `${kcEmit.bindingLinkPrefix(model)}-`;
  const emitted = new Map(bindingLinks.map(l => [linkId(l), l] as const));
  return [...existingLinks.values()].filter(link => {
    const id = linkId(link);
    if (!id.startsWith(prefix)) return false;
    const current = emitted.get(id);
    return !current || linkTypeId(link) !== linkTypeId(current) ||
        isStaleLink(link, current);
  });
}

async function blockedOutcome(
    cat: CatalogClient, opts: KcDeployOptions, link: EntryLink,
    conflict: string): Promise<LinkWriteOutcome> {
  const id = linkId(link);
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

const KEPT_SOURCE_FIELDS =
    ['resource', 'system', 'platform', 'createTime', 'updateTime'] as const;

async function updateEntry(
    cat: CatalogClient, opts: KcDeployOptions, entry: Entry,
    source?: Entry['entrySource']): Promise<WriteOutcome> {
  const labels = {...source?.labels, ...entry.entrySource?.labels};
  const kept = Object.fromEntries(
      KEPT_SOURCE_FIELDS.filter(k => source?.[k] !== undefined)
          .map(k => [k, source![k]]));
  const merged = {
    ...kept,
    ...entry.entrySource,
    ...(Object.keys(labels).length ? {labels} : {}),
  };
  if (Object.keys(merged).length) entry = {...entry, entrySource: merged};
  const aspectKeys = entryAspectKeys(entry, opts);
  const upd = await cat.updateEntry(
      entry, ['entry_source', 'aspects'], [...aspectKeys],
      /* deleteMissingAspects= */ true);
  if (!isOkStatus(upd)) {
    return {error: `entry '${entryId(entry)}': ${errText(upd)}`};
  }
  return {updated: true};
}

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

function isOkStatus(res: {status: number}): boolean {
  return res.status === 200;
}

function isExistsStatus(res: {status: number}): boolean {
  return res.status === 409;
}

function isNotFoundStatus(res: {status: number}): boolean {
  return res.status === 404;
}

function isPropagationError(res: {message?: string}): boolean {
  const msg = res.message ?? '';
  return /may not exist/i.test(msg) ||
      /entry group .*(not found|does not exist)/i.test(msg);
}

function errText(res: {status: number; message?: string}): string {
  return res.message?.trim() || `HTTP ${res.status}`;
}
