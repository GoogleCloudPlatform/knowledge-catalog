// Deploys a semantic model's Knowledge Catalog resources.
//
// This is the Knowledge Catalog leg of `kcmd push` for the semantic-model
// scope, the counterpart to `deploy_bigquery.ts`. It consumes models already
// parsed into the semantic IR (see loadSemanticModels, shared with the BigQuery
// leg so a multi-destination push parses each document once), maps each to catalog
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
//   * Relationship edges are published as schema-join entry links between the
//     two entity entries, written after that model's entries (both endpoints
//     must exist first). A re-push upserts the link's aspect; a many-to-many
//     (association) edge is not published yet (the emitter warns and skips it).
//     The caller additionally needs `dataplex.entryGroups.useSchemaJoinEntryLink`
//     and `useSchemaJoinAspect` on the destination entry group.
//
// This is a library module: it emits no console output. Warnings and the
// dry-run plan are returned in `KcDeployResult` for the CLI (commands.ts) to
// print.
//

import {ApiResult} from '../gcp/api';
import * as context from '../gcp/context';
import {CatalogClient, Entry, EntryLink} from '../gcp/dataplex';

import {generateCatalogResources, KcResources} from './knowledge_catalog';
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
  // Relationship (schema-join) entry links written -- created or upserted (0 for
  // validateOnly).
  linked: number;
  // Orphaned schema-join links deleted -- from relationships dropped or renamed
  // on a still-present model, and from force-removed models (0 for validateOnly).
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

// One authored model paired with the catalog resources it emitted.
type EmittedModel = {model: string; resources: KcResources};


// entries.create propagation retry: a just-created entry group can briefly 404.
const ENTRY_CREATE_TRIES = 3;
const ENTRY_CREATE_RETRY_MS = 3000;

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}


// Deploys every authored model's Knowledge Catalog resources. The body is the
// sequence of phases, each a helper below:
//   emitModels           -- turn the model into catalog resources (pure)
//   buildPlan            -- the dry-run plan (and stop here for --validate-only)
//   listEntryGroup       -- snapshot the group once, before any write
//   guardForeignModels   -- refuse (or --force-remove) models no longer pushed
//   writeModels          -- create/upsert each model's entries and links
//   reconcileDeletions   -- delete entries orphaned by removed entities/metrics
// Emits no console output; warnings and the plan are returned in KcDeployResult
// for the caller (commands.ts) to print.
export async function deployKnowledgeCatalog(
    models: LoadedModel[], ctx: context.ApiContext,
    opts: KcDeployOptions): Promise<KcDeployResult> {
  // Emit every model to catalog resources up front (pure -- no network).
  const emit = emitModels(models, opts);
  if (emit.error) {
    return {
      success: false, details: emit.error, warnings: emit.warnings,
      created: 0, updated: 0, deleted: 0, linked: 0, unlinked: 0, plan: [],
    };
  }
  return deployEmittedModels(emit.emitted, emit.warnings, ctx, opts);
}


// Publishes models that are already mapped to catalog resources. Origin-
// agnostic: everything below operates on EmittedModel and never looks at the
// source format, so an origin with its own emitter (LookML, which does not use
// the Ossie IR) calls this directly instead of deployKnowledgeCatalog.
export async function deployEmittedModels(
    emitted: EmittedModel[], emitWarnings: string[], ctx: context.ApiContext,
    opts: KcDeployOptions): Promise<KcDeployResult> {
  const warnings: string[] = [...emitWarnings];
  const counts: Counts =
      {created: 0, updated: 0, deleted: 0, linked: 0, unlinked: 0};
  let plan: string[] = [];
  // Builds the return value from the running state; details is set only on a
  // failure, and counts/plan reflect whatever had been done when called.
  const result = (success: boolean, details?: string): KcDeployResult =>
      ({success, warnings, ...counts, plan, ...(details ? {details} : {})});

  // Exactly one model per entry group is supported for now. An empty workspace
  // is a clean no-op under --validate-only and a configuration error on a real
  // push; more than one model in a single push is always rejected (which also
  // means two models can never race for the same entry id).
  if (emitted.length !== 1) {
    if (!emitted.length) {
      if (opts.validateOnly) {
        warnings.push(
            'No semantic model documents found; nothing to validate.');
        return result(true);
      }
      return result(
          false, 'No semantic model documents found; nothing to deploy.');
    }
    return result(
        false,
        `entry group '${opts.entryGroup}' would receive ${
            emitted.length} models, but only one model per entry group is ` +
            `supported; split them into separate entry groups.`);
  }

  // The plan is built for every push (printed with --print) and is the only
  // output of a --validate-only run, which writes nothing.
  plan = buildPlan(emitted, opts);
  if (opts.validateOnly) return result(true);

  // From here on we write. The entry group is provisioned at `init`, not here;
  // a missing group surfaces as a clear entry-creation error, and createEntries
  // rides out the brief post-init propagation window.
  const cat = new CatalogClient(ctx);

  // Snapshot the entry group once, before any write: the same listing feeds the
  // foreign-model guard, link reconciliation, and deletion reconciliation. A
  // re-emitted entry is never a deletion candidate, so a pre-write snapshot is
  // correct for all three.
  const listing = await listEntryGroup(cat, opts);
  if (listing.error) return result(false, listing.error);
  const existing = listing.entries;

  // Whole-model lifecycle: refuse (or, with --force-remove, delete) any model
  // the group still holds that this push no longer includes.
  const guard = await guardForeignModels(cat, opts, emitted, existing, counts);
  if (guard.error) return result(false, guard.error);

  // Write each model's entries and relationship links.
  const written = await writeModels(cat, opts, emitted, existing, counts);
  if (written.error) return result(false, written.error);

  // Finally, delete entries orphaned by entities/metrics removed from a
  // still-present model since its last push.
  const recon = await reconcileDeletions(cat, opts, emitted, existing);
  if (recon.error) return result(false, recon.error);
  counts.deleted += recon.deleted;

  return result(true);
}


// Turns every authored model into its catalog resources. Pure -- no network I/O
// -- so the dry-run plan and any generation warnings are produced even when a
// later write fails. A malformed GOOGLE custom_extension (reached via the
// semantic-model aspect) throws; report it against its document, as the BigQuery
// leg does, rather than letting it escape as an uncaught stack trace.
function emitModels(models: LoadedModel[], opts: KcDeployOptions):
    {emitted: EmittedModel[]; warnings: string[]; error?: string} {
  const emitted: EmittedModel[] = [];
  const warnings: string[] = [];
  for (const {document, model} of models) {
    let resources: KcResources;
    try {
      resources = generateCatalogResources(model, {
        project: opts.project,
        location: opts.location,
        entryGroup: opts.entryGroup,
        systemTypeProject: opts.systemTypeProject,
        systemTypeLocation: opts.systemTypeLocation,
        emitExpressions: opts.emitExpressions,
      });
    } catch (err: any) {
      return {
        emitted, warnings,
        error: `Model '${model.name}' (${document}): ${err.message || err}`,
      };
    }
    for (const w of resources.warnings) warnings.push(`[${model.name}] ${w}`);
    emitted.push({model: model.name, resources});
  }
  return {emitted, warnings};
}


// The full dry-run plan across all models (one block per model; see planSummary).
function buildPlan(emitted: EmittedModel[], opts: KcDeployOptions): string[] {
  const plan: string[] = [];
  for (const {model, resources} of emitted) {
    plan.push(...planSummary(model, resources, opts));
  }
  return plan;
}


// Whole-model lifecycle guard. A `semantic-model` anchor already in the group
// whose id this push does not re-emit belongs to a model whose document is gone
// (removed or renamed). Refuse the push and name them -- unless --force-remove,
// which deletes each such model's links and entries first (tallied into counts).
async function guardForeignModels(
    cat: CatalogClient, opts: KcDeployOptions, emitted: EmittedModel[],
    existing: Entry[], counts: Counts): Promise<{error?: string}> {
  const pushedAnchors =
      new Set(emitted.map(e => idOf(e.resources.entries[0].name)));
  const foreignAnchors = existing
      .filter(e => (e.entryType ?? '').endsWith('/semantic-model'))
      .map(e => idOf(e.name))
      .filter(id => !pushedAnchors.has(id));
  if (!foreignAnchors.length) return {};
  if (!opts.forceRemove) {
    return {
      error:
          `entry group '${opts.entryGroup}' already contains model(s) this ` +
          `push does not include: ${foreignAnchors.join(', ')}. Re-run with ` +
          `--force-remove to delete them, or add their documents to this push.`,
    };
  }
  const removed = await removeForeignModels(cat, opts, existing, foreignAnchors);
  if (removed.error) return {error: removed.error};
  counts.deleted += removed.deleted;
  counts.unlinked += removed.unlinked;
  return {};
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
    for (const e of resources.entries) emittedIds.add(idOf(e.name));
    // entries[0] is the model anchor (the emitter writes it first). An emitter
    // that produced no entries has no anchor and owns nothing, so skip it
    // rather than index into an empty array -- a throw here escapes the
    // KcDeployResult contract, and it would do so *after* writes.
    if (!resources.entries.length) continue;
    anchorIds.add(idOf(resources.entries[0].name));
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

  const orphans = existing.map(e => idOf(e.name))
                      .filter(id => owned(id) && !emittedIds.has(id));

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
    if (isOk(res) || res.status === 404) {
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


// Snapshots the destination entry group's entries once, before any write. A
// brand-new entry group can briefly fail to list its entries collection (the
// same propagation window createEntryWithRetry rides out); treat only that
// not-yet-visible error as empty -- there is nothing to guard against or
// reconcile, and the create path retries the window. The match mirrors
// isPropagating (entry-group-scoped) so any OTHER listing failure -- a real
// backend error, a permission problem -- is surfaced rather than masked.
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
    if (/may not exist/i.test(msg) ||
        /entry group .*(not found|does not exist)/i.test(msg)) {
      return {entries: []};
    }
    return {entries: [], error: `listing entries in entry group '${
                                    opts.entryGroup}': ${msg}`};
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
    if (!isOk(res)) {
      return {unlinked, error: `looking up entry links for '${idOf(entry)}': ${
                                   errText(res)}`};
    }
    for (const link of res.result ?? []) {
      const id = idOf(link.name ?? '');
      if (seen.has(id)) continue;
      seen.add(id);
      if (!shouldDelete(link)) continue;
      const del = await cat.deleteEntryLink(
          opts.project, opts.location, opts.entryGroup, id);
      if (isOk(del) || del.status === 404) {
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
    cat: CatalogClient, opts: KcDeployOptions, resources: KcResources,
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
          .filter(name => ownedId(idOf(name)));
  if (!entityNames.length) return Promise.resolve({unlinked: 0});

  const emittedLinkIds =
      new Set(resources.entryLinks.map(l => idOf(l.name ?? '')));
  const ownedByModel = (link: EntryLink) =>
      link.entryReferences.length === 2 &&
      link.entryReferences.every(r => ownedId(idOf(r.name)));

  return deleteOwnedLinks(
      cat, opts, entityNames,
      link =>
          ownedByModel(link) && !emittedLinkIds.has(idOf(link.name ?? '')));
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
      const id = idOf(e.name);
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
      const id = idOf(e.name);
      const res = await cat.deleteEntry(
          opts.project, opts.location, opts.entryGroup, id);
      if (isOk(res) || res.status === 404) {
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
  const linkId = linkIdOf(link.name ?? '');
  const res = await cat.createEntryLink(
      opts.project, opts.location, opts.entryGroup, linkId, link);
  if (isExists(res)) {
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
    if (!isOk(upd) && !isLinkNotAddressable(upd)) {
      return {error: `entry link '${linkId}': ${errText(upd)}`};
    }
    return {};
  }
  if (!isOk(res)) return {error: `entry link '${linkId}': ${errText(res)}`};
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
        e => `    - ${idOf(e.name)} (${typeIdOf(e.entryType)})`),
  ];
  if (resources.entryLinks.length) {
    lines.push(
        `  ${resources.entryLinks.length} schema-join link${
            resources.entryLinks.length === 1 ? '' : 's'}:`,
        ...resources.entryLinks.map(
            l => `    - ${linkIdOf(l.name ?? '')}`));
  }
  return lines;
}


function idOf(name: string): string {
  // Match the container's SHAPE rather than any exact text. Two reasons:
  //   - names from listEntries do not always spell the project the way the
  //     scope does (the server mixes project ids and numbers, and _fixEntry
  //     normalizes them only when its Cloud Resource Manager lookup succeeds);
  //   - an entry id may itself contain slashes, as the LookML emitter's
  //     `<model>/metrics/<view>/<name>` does, so taking the last segment alone
  //     would return `<name>` and match no ownership prefix.
  // Falls back to the last segment, which is correct for entry-link and type
  // resource names that have no `/entries/` container.
  const m = name.match(
      /^projects\/[^/]+\/locations\/[^/]+\/entryGroups\/[^/]+\/entries\/(.+)$/);
  return m ? m[1] : (name.split('/').pop() ?? name);
}

// The entry-link id: everything after `/entryLinks/`. Link ids are restricted to
// a single segment (see linkSlug), but this stays symmetric with idOf so a
// link name is never parsed by the wrong rule.
function linkIdOf(name: string): string {
  const i = name.indexOf('/entryLinks/');
  return i < 0 ? name : name.slice(i + '/entryLinks/'.length);
}

// The trailing id of a *type* resource name, e.g.
// `projects/dataplex-types/locations/global/entryTypes/semantic-metric` ->
// `semantic-metric`. Type ids are always one segment, so last-segment is right
// here -- and is why one shared helper worked until entry ids gained slashes.
function typeIdOf(name: string): string {
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

// An entry link that a create reported as already existing (409) but that the
// by-name UpdateEntryLink then could not address: NOT_FOUND (404) or a masked
// PERMISSION_DENIED (403). Some catalog surfaces expose only create + lookup for
// entry links, so the aspect-refresh update is unavailable there even though the
// link itself is present -- writeEntryLink treats this as a no-op success.
function isLinkNotAddressable(res: {status: number}): boolean {
  return res.status === 404 || res.status === 403;
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
