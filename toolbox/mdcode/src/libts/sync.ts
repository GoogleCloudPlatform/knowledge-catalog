// Implements catalog sync logic for pull and push operations
//

import * as gcp from './gcp';
import { BUNDLE_DIR, OkfLayout } from './layouts/okf';
import { CatalogSnapshot, toLocalEntry } from './snapshot';
import { entryGroupCoordinates } from './source';

export interface SyncResult {
  success: boolean;
  details?: string;
}

export interface PullSyncOptions {
  dryRun?: boolean;
  forceRemove?: boolean;
}

export interface ValidationResult {
  valid: boolean;
}

export interface StatusResult {
  modified: boolean;
}

const READ_CONCURRENCY = 8;
const BATCH_MAX_CHANGES = 250;

export async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    async () => {
      while (!failed) {
        const idx = next++;
        if (idx >= items.length) return;
        try {
          out[idx] = await fn(items[idx], idx);
        } catch (err) {
          failed = true;
          throw err;
        }
      }
    },
  );
  await Promise.all(workers);
  return out;
}

function entryIdFromName(name: string): string {
  return name.split('/entries/')[1] ?? name;
}

function entryId(entry: gcp.Entry): string {
  return entryIdFromName(entry.name);
}

function entryDepth(
  entry: gcp.Entry,
  byName: Map<string, gcp.Entry>,
  seen = new Set<string>(),
): number {
  if (!entry.parentEntry || seen.has(entry.name)) {
    return entryId(entry).split('/').length - 1;
  }
  seen.add(entry.name);
  const parent = byName.get(entry.parentEntry);
  if (!parent) {
    return entryId(entry).split('/').length;
  }
  return 1 + entryDepth(parent, byName, seen);
}

// When intermediate directories (e.g. `assets/bigquery/<project>`,
// `query-context/templates`, or custom user folders) have no index entry of
// their own, walk up the path to the nearest existing ancestor entry (or omit
// `parentEntry` when none exists) so Dataplex never fails on a missing parent.
function resolveMissingParents(
  entries: gcp.Entry[],
  entryGroup: string,
  existing: Map<string, gcp.Entry>,
): void {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const known = (name: string) => byName.has(name) || existing.has(name);
  const prefix = `${entryGroup}/entries/`;
  for (const entry of entries) {
    if (!entry.parentEntry || known(entry.parentEntry)) continue;
    if (!entry.parentEntry.startsWith(prefix)) continue;
    let rel = entry.parentEntry.slice(prefix.length);
    let resolved: string | undefined;
    while (rel.includes('/')) {
      rel = rel.slice(0, rel.lastIndexOf('/'));
      const candidate = `${prefix}${rel}`;
      if (known(candidate)) {
        resolved = candidate;
        break;
      }
    }
    if (
      !resolved &&
      !entry.entryType.endsWith('/entryTypes/query-template') &&
      entry.name !== `${prefix}agents` &&
      known(`${prefix}agents`)
    ) {
      resolved = `${prefix}agents`;
    }
    if (resolved) {
      entry.parentEntry = resolved;
    } else {
      delete entry.parentEntry;
    }
  }
  entries.sort((a, b) => {
    const diff = entryDepth(a, byName) - entryDepth(b, byName);
    if (diff !== 0) return diff;
    const slashDiff = entryId(a).split('/').length - entryId(b).split('/').length;
    return slashDiff !== 0 ? slashDiff : entryId(a).localeCompare(entryId(b));
  });
}

function toChange(
  entry: gcp.Entry,
  entryGroup: string,
  existing: Map<string, gcp.Entry>,
): gcp.MetadataChange {
  if (existing.has(entry.name)) {
    const priorSource = existing.get(entry.name)?.entrySource;
    if (priorSource?.createTime || priorSource?.updateTime) {
      entry.entrySource = { ...entry.entrySource };
      if (priorSource.createTime && !entry.entrySource.createTime) {
        entry.entrySource.createTime = priorSource.createTime;
      }
      if (priorSource.updateTime && !entry.entrySource.updateTime) {
        entry.entrySource.updateTime = priorSource.updateTime;
      }
    }
    return {
      updateEntryRequest: {
        entry,
        updateMask: 'aspects,entry_source',
        aspectKeys: Object.keys(entry.aspects ?? {}),
        deleteMissingAspects: false,
      },
    };
  }
  return {
    createEntryRequest: { parent: entryGroup, entryId: entryId(entry), entry },
  };
}

export function isUnimplementedBatch(res: { status: number; message?: string }): boolean {
  if (res.status === 501) return true;
  if (res.status !== 404 || !res.message) return false;
  try {
    const parsed = JSON.parse(res.message);
    return parsed?.error?.status === 'UNIMPLEMENTED';
  } catch {
    return false;
  }
}

interface BatchTarget {
  project: string;
  location: string;
  groupId: string;
}

function changeLabel(change: gcp.MetadataChange | undefined): string {
  if (!change) return '<unknown>';
  if (change.createEntryRequest) return change.createEntryRequest.entryId;
  if (change.updateEntryRequest) return entryId(change.updateEntryRequest.entry);
  if (change.deleteEntryRequest) return entryIdFromName(change.deleteEntryRequest.name);
  return '<unknown>';
}

async function applyChunk(
  catalog: gcp.CatalogClient,
  target: BatchTarget,
  changes: gcp.MetadataChange[],
): Promise<number> {
  const res = await catalog.batchChangeMetadata(
    target.project,
    target.location,
    target.groupId,
    changes,
  );

  if (isUnimplementedBatch(res)) {
    return await applyViaEntries(catalog, target, changes);
  }

  // A batch that exists and refused the plan validated it as a whole. Replaying
  // it one entry at a time turns an atomic reject into a partial apply.
  if (res.status !== 200 || !res.result) {
    console.error(
      `batchChangeMetadata failed (${res.status}): ${res.message ?? ''}`,
    );
    return changes.length;
  }

  const polled = await catalog.pollOperation(res.result, 'push');
  if (polled.error) {
    console.error(polled.error);
    return changes.length;
  }

  const failures = polled.operation?.metadata?.failedRequests ?? {};
  for (const [index, status] of Object.entries(failures)) {
    const id = changeLabel(changes[Number(index)]);
    console.error(`  ${id}: ${status.message ?? status.code}`);
  }
  return Object.keys(failures).length;
}

/** Per-entry fallback for universes where BatchChangeMetadata is unimplemented. */
async function applyViaEntries(
  catalog: gcp.CatalogClient,
  target: BatchTarget,
  changes: gcp.MetadataChange[],
): Promise<number> {
  let failed = 0;
  for (const change of changes) {
    const create = change.createEntryRequest;
    const update = change.updateEntryRequest;
    const del = change.deleteEntryRequest;
    let res: { status: number; message?: string };
    if (create) {
      // Unlike the batch, entries.create rejects a body carrying `name`.
      const { name, ...body } = create.entry;
      res = await catalog.createEntry(
        target.project,
        target.location,
        target.groupId,
        create.entryId,
        body as gcp.Entry,
      );
    } else if (update) {
      res = await catalog.modifyEntry(
        target.project,
        target.location,
        update.entry,
        update.updateMask.split(',').filter(Boolean),
        update.aspectKeys,
      );
    } else if (del) {
      res = await catalog.deleteEntry(
        target.project,
        target.location,
        target.groupId,
        entryIdFromName(del.name),
      );
    } else {
      continue;
    }
    if (res.status !== 200) {
      console.error(`  ${changeLabel(change)}: HTTP ${res.status} ${res.message ?? ''}`);
      failed++;
    }
  }
  return failed;
}


export class CatalogSync {
  private _catalog: gcp.CatalogClient;
  private _snapshot: CatalogSnapshot;

  constructor(catalog: gcp.CatalogClient, snapshot: CatalogSnapshot) {
    this._catalog = catalog;
    this._snapshot = snapshot;
  }

  // Lists metadata in the Catalog service to create or update the local snapshot.
  async pull(options?: PullSyncOptions): Promise<SyncResult> {
    if (this._snapshot.layout instanceof OkfLayout) {
      try {
        return await this._pullOkf(this._snapshot.layout, options ?? {});
      } catch (e: any) {
        return { success: false, details: e.message };
      }
    }

    try {
      const listedTypes = this._snapshot.manifest.snapshotConfig?.entries ?? [];
      const unreadableTypes = new Set<string>();
      const entries: gcp.Entry[] = [];

      // Loads the type of every entry to pull before fetching any entry, so each
      // entry is fetched with the same aspect types whatever the listing order.
      for await (const entry of this._snapshot.manifest.source.entries(this._catalog.context)) {
        const typeRef = gcp._nameToTypeRef(entry.entryType);
        // Skips the entry Dataplex keeps for the entry group itself.
        if (entry.entryType.endsWith('/entryTypes/entrygroup') || unreadableTypes.has(typeRef) ||
            (listedTypes.length && !listedTypes.includes(typeRef))) {
          continue;
        }
        try {
          await this._snapshot._loadEntryType(typeRef);
        }
        catch (e: any) {
          unreadableTypes.add(typeRef);
          console.warn(`Warning: ${e.message}. Entries of this type are not pulled.`);
          continue;
        }
        entries.push(entry);
      }

      // Pull fetches the aspect types it knows: those catalog.yaml lists and
      // each entry's type requires. It warns about each other aspect type an
      // entry carries, apart from the scope's system aspects.
      const aspectTypes = this._snapshot.aspectTypes;
      const requested = [...aspectTypes.keys()];
      const system = new Set(this._snapshot.manifest.source.systemAspects);
      const leftOut = new Map<string, number>();
      for (const entry of entries) {
        // TODO: Handle local modification conflicts.
        // TODO: Handle config changes or service deletions that require removing local entries.

        const nameParts = entry.name.split('/');
        const res = await this._catalog.lookupEntry(nameParts[1], nameParts[3], entry.name,
                                                    { aspects: requested });
        // The server will respond with 403 permission denied for both resource not exist or 
        // insufficient permission. We cannot tell if a resource not exist or user does not 
        // have the access. Thus using 200 for an ensured result.
        if (res.status != 200 || !res.result) {
          continue;
        }

        // lookupEntry sets every returned aspect's type.
        const stored = new Set(Object.values(res.result.aspects ?? {})
                                   .map(a => gcp._nameToTypeRef(a.aspectType!)));
        await this._snapshot._storeEntry(res.result);

        const onEntry = await this._catalog.lookupEntryAspectTypes(
            nameParts[1], nameParts[3], entry.name);
        for (const type of onEntry.result ?? []) {
          if (!stored.has(type) && !aspectTypes.has(type) && !system.has(type)) {
            leftOut.set(type, (leftOut.get(type) ?? 0) + 1);
          }
        }
      }
      for (const [type, count] of leftOut) {
        console.warn(
            `Warning: pull left out aspect type '${type}' on ${count} ` +
            `${count === 1 ? 'entry' : 'entries'}; list it under ` +
            `snapshot.aspects in catalog.yaml to pull it.`);
      }
      return { success: true };
    }
    catch (e: any) {
      return { success: false, details: e.message };
    }
  }

  // Pushes local metadata to the Catalog service to publish/deploy it. Under
  // `validateOnly` the entries are still walked and the pre-flight lookups run,
  // but no create or update is issued -- mirroring the dry-run contract the
  // semantic-model legs honor, so the flag behaves the same on every scope.
  async push(options?: { force?: boolean, validateOnly?: boolean; }): Promise<SyncResult> {
    if (this._snapshot.layout instanceof OkfLayout) {
      try {
        return await this._pushOkf(this._snapshot.layout, options ?? {});
      } catch (e: any) {
        return { success: false, details: e.message };
      }
    }

    const validateOnly = !!options?.validateOnly;
    const entries = await this._snapshot.listEntries();

    for (const name of entries) {
      const entry = await this._snapshot._fetchEntry(name);
      if (!entry) {
        // If this was filtered out based on publishing config
        continue;
      }

      // TODO: Track what has changed and do minimal update.
      // TODO: Handle creates and deletes, as well as partial updates.
      // TODO: Handle conflicts.

      const nameParts = entry.name.split('/');
      const project = nameParts[1];
      const location = nameParts[3];

      const exist = await this._catalog.lookupEntry(project, location, entry.name);
      if (exist.status != 200 || !exist.result) {
        if (validateOnly) {
          // Would create; write nothing under --validate-only.
          continue;
        }
        const entryGroup = nameParts[5];
        const entryId = nameParts.slice(7).join('/');
        const createEntryRes = await this._catalog.createEntry(project, location, entryGroup, entryId, entry);
        if (createEntryRes.status != 200 || !createEntryRes.result) {
          return { success: false, details: `Failed to create entry ${entry.name}: ${createEntryRes.message || createEntryRes.status}` };
        }
        continue;
      }

      const updateMask = [];
      const aspectKeys = Object.keys(entry.aspects || {});
      if (aspectKeys.length) {
        updateMask.push('aspects');
      }

      if (!this._snapshot.manifest.source.ingestedEntries) {
        if (entry.entrySource) {
          updateMask.push('entry_source');
        }
        if (entry.parentEntry) {
          updateMask.push('parent_entry');
        }
      }

      if (!updateMask.length) {
        continue;
      }

      if (validateOnly) {
        // Would update; write nothing under --validate-only.
        continue;
      }

      const res = await this._catalog.modifyEntry(project, location, entry, updateMask, aspectKeys);
      if (res.status !== 200 || !res.result) {
        return { success: false, details: `Failed to update entry ${name}: ${res.message || res.status}` };
      }
    }

    return { success: true };
  }

  private async _pullOkf(
    layout: OkfLayout,
    options: PullSyncOptions,
  ): Promise<SyncResult> {
    entryGroupCoordinates(this._snapshot.manifest.source);

    const stubs: gcp.Entry[] = [];
    for await (const stub of this._snapshot.manifest.source.entries(this._catalog.context)) {
      if (stub.entryType?.endsWith('/entrygroup')) continue;
      stubs.push(stub);
    }

    const fetched = await mapConcurrent(stubs, READ_CONCURRENCY, async (stub) => {
      const parts = stub.name.split('/');
      const res = await this._catalog.lookupEntry(
        parts[1],
        parts[3],
        stub.name,
        { view: 'ALL' },
      );
      if (res.status !== 200 || !res.result) {
        throw new Error(
          `failed to read entry '${stub.name}' (status ${res.status})`,
        );
      }
      return res.result;
    });

    const planned: Array<{ entry: gcp.Entry; localName: string }> = [];
    const pulledNames = new Set<string>();
    for (const entry of fetched) {
      if (entry.entryType?.endsWith('/entrygroup')) continue;
      const localName = this._snapshot.manifest.source.localName(entry);
      const local = toLocalEntry(entry, localName);
      if (entry.parentEntry) {
        local.resource.parent =
          this._snapshot.manifest.source.localName({ ...entry, name: entry.parentEntry });
      }
      // Pre-validate path containment and residue before writing or deleting files.
      layout.previewConcept(localName, local);
      planned.push({ entry, localName });
      pulledNames.add(localName);
    }

    const stale = layout.listEntries().filter(name => !pulledNames.has(name));

    if (options.dryRun) {
      for (const { localName } of planned) {
        console.log(`would write ${layout.relativeBundlePath(localName)}`);
      }
      for (const name of stale) {
        if (options.forceRemove) {
          console.log(`would remove ${layout.relativeBundlePath(name)}`);
        } else {
          console.warn(
            `Warning: local file '${layout.relativeBundlePath(name)}' is not in ` +
              `Knowledge Catalog; re-run with --force-remove to delete it.`,
          );
        }
      }
      console.log(`${planned.length} concept(s); no files written (--dry-run).`);
      return { success: true };
    }

    for (const { entry } of planned) {
      await this._snapshot._storeEntry(entry);
    }
    for (const name of stale) {
      if (options.forceRemove) {
        await layout.deleteEntry(name);
        console.log(`Removed stale concept ${layout.relativeBundlePath(name)}.`);
      } else {
        console.warn(
          `Warning: local file '${layout.relativeBundlePath(name)}' is not in ` +
            `Knowledge Catalog; re-run with --force-remove to delete it.`,
        );
      }
    }
    console.log(`Wrote ${planned.length} concept(s) to ${BUNDLE_DIR}/.`);
    return { success: true };
  }

  private async _pushOkf(
    layout: OkfLayout,
    options: { force?: boolean; validateOnly?: boolean },
  ): Promise<SyncResult> {
    const {
      project,
      location,
      entryGroup: groupId,
      container: entryGroup,
    } = entryGroupCoordinates(this._snapshot.manifest.source);

    if (!layout.bundleExists()) {
      return { success: false, details: `no ${BUNDLE_DIR}/ directory to push` };
    }

    const names = await this._snapshot.listEntries();
    const entries: gcp.Entry[] = [];
    for (const name of names) {
      const entry = await this._snapshot._fetchEntry(name);
      if (!entry) continue;
      if (entry.entryType.endsWith('/entrygroup')) continue;
      entries.push(entry);
    }

    const existing = new Map<string, gcp.Entry>();
    const remoteEntries: gcp.Entry[] = [];
    for await (const stub of this._snapshot.manifest.source.entries(this._catalog.context)) {
      existing.set(stub.name, stub);
      if (stub.entryType?.endsWith('/entrygroup')) continue;
      if (entryId(stub) === `${groupId}_entry`) continue;
      remoteEntries.push(stub);
    }

    resolveMissingParents(entries, entryGroup, existing);

    const localNames = new Set(entries.map(e => e.name));
    const remoteByName = new Map(remoteEntries.map(e => [e.name, e]));
    const toDelete = remoteEntries
      .filter(e => !localNames.has(e.name))
      .sort((a, b) => {
        // Delete `agents` last so root-level directories parented to `agents`
        // are removed before `agents` itself.
        const aIsAgents = entryId(a) === 'agents' ? 1 : 0;
        const bIsAgents = entryId(b) === 'agents' ? 1 : 0;
        if (aIsAgents !== bIsAgents) return aIsAgents - bIsAgents;
        const depthDiff =
          entryDepth(b, remoteByName) - entryDepth(a, remoteByName);
        if (depthDiff !== 0) return depthDiff;
        const slashDiff =
          entryId(b).split('/').length - entryId(a).split('/').length;
        return slashDiff !== 0 ? slashDiff : entryId(a).localeCompare(entryId(b));
      });

    if (!entries.length && !toDelete.length) {
      return {
        success: false,
        details: `no OKF concepts found in ${BUNDLE_DIR}/`,
      };
    }

    const upsertChanges = entries.map(entry => toChange(entry, entryGroup, existing));
    const deleteChanges: gcp.MetadataChange[] = toDelete.map(e => ({
      deleteEntryRequest: { name: e.name },
    }));
    const changes = [...upsertChanges, ...deleteChanges];
    const creates = upsertChanges.filter(c => c.createEntryRequest).length;
    const updates = upsertChanges.length - creates;
    const deletes = deleteChanges.length;

    if (options.validateOnly) {
      for (const entry of entries) console.log(`would write ${entry.name}`);
      for (const entry of toDelete) console.log(`would delete ${entry.name}`);
      console.log(
        `${changes.length} change(s): ${creates} create, ${updates} update, ` +
          `${deletes} delete. Nothing sent (dry run).`,
      );
      return { success: true };
    }

    let failed = 0;
    for (let i = 0; i < changes.length; i += BATCH_MAX_CHANGES) {
      failed += await applyChunk(
        this._catalog,
        { project, location, groupId },
        changes.slice(i, i + BATCH_MAX_CHANGES),
      );
    }

    console.log(
      `Pushed ${changes.length - failed}/${changes.length} change(s) to ` +
        `${groupId} (${creates} create, ${updates} update, ${deletes} delete).`,
    );
    return failed ? { success: false } : { success: true };
  }

  async validate(): Promise<ValidationResult> {
    throw new Error('Not yet implemented');
  }

  async status(): Promise<StatusResult> {
    throw new Error('Not yet implemented');
  }
}
