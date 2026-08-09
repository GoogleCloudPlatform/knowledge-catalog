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

import {SemanticModel} from './ir';
import {generateCatalogResources, idOf, KcResources, modelsFromCatalogResources} from './knowledge_catalog';
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


// Upper bound on concurrent entry / entry-link writes within one model's wave
// (mirrors HYDRATE_CONCURRENCY on the pull side).
const WRITE_CONCURRENCY = 8;

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
  const warnings: string[] = [];
  const counts: Counts =
      {created: 0, updated: 0, deleted: 0, linked: 0, unlinked: 0};
  let plan: string[] = [];
  // Builds the return value from the running state; details is set only on a
  // failure, and counts/plan reflect whatever had been done when called.
  const result = (success: boolean, details?: string): KcDeployResult =>
      ({success, warnings, ...counts, plan, ...(details ? {details} : {})});

  // Emit every model to catalog resources up front (pure -- no network).
  const emit = emitModels(models, opts);
  warnings.push(...emit.warnings);
  if (emit.error) return result(false, emit.error);
  const emitted = emit.emitted;

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
    // entries[0] is the model anchor (the emitter writes it first).
    const anchorId = idOf(resources.entries[0].name);
    anchorIds.add(anchorId);
    childPrefixes.push(`${anchorId}.entities.`, `${anchorId}.metrics.`);
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
  const anchorId = idOf(resources.entries[0].name);
  const entityPrefix = `${anchorId}.entities.`;
  // Look up links via the model's entity entries KNOWN TO THE SERVER (the
  // pre-write snapshot), not the ones this push emits. Only a server-side entry
  // can already carry a link, and enumerating the snapshot also reaches a link
  // both of whose endpoints were removed in this push -- neither is re-emitted,
  // but both entries are still present in `existing` until reconcileDeletions
  // deletes them at the end. A brand-new model has no such entries, so it issues
  // no lookups at all.
  const entityNames = existing.map(e => e.name)
      .filter(name => idOf(name).startsWith(entityPrefix));
  if (!entityNames.length) return Promise.resolve({unlinked: 0});

  const emittedLinkIds =
      new Set(resources.entryLinks.map(l => idOf(l.name ?? '')));
  const ownedByModel = (link: EntryLink) =>
      link.entryReferences.length === 2 &&
      link.entryReferences.every(r => idOf(r.name).startsWith(entityPrefix));

  return deleteOwnedLinks(
      cat, opts, entityNames,
      link =>
          ownedByModel(link) && !emittedLinkIds.has(idOf(link.name ?? '')));
}


// Deletes models already in the entry group that this push does not re-emit
// (--force-remove). For each foreign anchor: remove its schema-join links first
// (they reference entries about to be deleted), then its entries -- the anchor
// and its `<anchor>.entities.` / `<anchor>.metrics.` children present in the
// pre-write listing `existing`.
async function removeForeignModels(
    cat: CatalogClient, opts: KcDeployOptions, existing: Entry[],
    foreignAnchors: string[]):
    Promise<{deleted: number; unlinked: number; error?: string}> {
  let deleted = 0;
  let unlinked = 0;
  for (const anchor of foreignAnchors) {
    const entityPrefix = `${anchor}.entities.`;
    const metricPrefix = `${anchor}.metrics.`;
    const owned = existing.filter(e => {
      const id = idOf(e.name);
      return id === anchor || id.startsWith(entityPrefix) ||
          id.startsWith(metricPrefix);
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
    const res = await mapConcurrent(
        wave, WRITE_CONCURRENCY, e => writeEntry(cat, opts, e));
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
  const res = await mapConcurrent(
      links, WRITE_CONCURRENCY, l => writeEntryLink(cat, opts, l));
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
  const linkId = idOf(link.name ?? '');
  const res = await cat.createEntryLink(
      opts.project, opts.location, opts.entryGroup, linkId, link);
  if (isExists(res)) {
    const upd = await cat.updateEntryLink(
        {name: link.name, aspects: link.aspects} as EntryLink,
        Object.keys(link.aspects ?? {}));
    if (!isOk(upd)) return {error: `entry link '${linkId}': ${errText(upd)}`};
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
        e => `    - ${idOf(e.name)} (${idOf(e.entryType)})`),
  ];
  if (resources.entryLinks.length) {
    lines.push(
        `  ${resources.entryLinks.length} schema-join link${
            resources.entryLinks.length === 1 ? '' : 's'}:`,
        ...resources.entryLinks.map(
            l => `    - ${idOf(l.name ?? '')}`));
  }
  return lines;
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


// ---------------------------------------------------------------------------
// Pull: Knowledge Catalog -> Semantic Model IR.
//
// The read counterpart of deployKnowledgeCatalog and the inverse of push.
// Unlike a write, a pull needs no server-side type provisioning -- only that
// the `semantic-*` entries exist. It enumerates the entry group, keeps the
// semantic entries, hydrates each one's aspect data (a BASIC list omits aspect
// data, so each entry is re-fetched with its aspect types -- an entity needs
// BOTH its `semantic-entity` aspect and the built-in `schema` aspect), and
// hands the hydrated entries to the pure reader (modelsFromCatalogResources).
// ---------------------------------------------------------------------------

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
