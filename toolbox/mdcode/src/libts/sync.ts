// Implements catalog sync logic for pull and push operations
//

import * as gcp from './gcp';
import { BUNDLE_DIR, OkfLayout } from './layouts/okf';
import {
  entryLinkId,
  isStaleEntryLink,
  linkDedupKey,
  LINKS_FILE,
  shortenLinkType,
} from './okf/links';
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

export interface PushSyncOptions {
  force?: boolean;
  validateOnly?: boolean;
  /**
   * Maximum milliseconds to wait for Dataplex link IAM permissions on a newly
   * created EntryGroup (default: 120_000; 0 disables waiting).
   */
  propagationTimeoutMs?: number;
  /**
   * Base retry delay in milliseconds for link rate-limit and propagation
   * backoff (default: 500; 0 skips backoff sleep in unit tests).
   */
  retryDelayMs?: number;
}

export interface ValidationResult {
  valid: boolean;
}

export interface StatusResult {
  modified: boolean;
}

const READ_CONCURRENCY = 8;
const BATCH_MAX_CHANGES = 250;
const CLOCK_SKEW_ALLOWANCE_MS = 60_000;
// Workaround for Dataplex new-EntryGroup IAM lag: `getEntryGroup`,
// `listEntries`, and `batchChangeMetadata` honor IAM on a newly created
// context-set EntryGroup immediately, while `:lookupEntryLinks` and
// `entryLinks` writes can return 403 ("... (or it may not exist)") or
// transient 404 for ~1-2+ minutes (Google Cloud IAM documents up to 7+ minutes
// in worst cases). Remove once Dataplex `entryLinks` honors new-group IAM
// immediately.
const NEW_ENTRY_GROUP_WINDOW_MS = 180_000;
const DEFAULT_LINK_PROPAGATION_TIMEOUT_MS = 120_000;
const DEFAULT_LINK_RETRY_DELAY_MS = 500;
const MIN_PROPAGATION_SLEEP_MS = 250;
const MAX_LINK_RETRY_DELAY_MS = 5_000;
const PROPAGATION_PROGRESS_INTERVAL_MS = 10_000;
const ENTRY_GROUP_RESOURCE_RE = /\/entryGroups\/([^/'"\s)]+)/g;
// Substring observed in Dataplex 403 errors while new-EntryGroup IAM
// propagates, e.g.: `Permission 'dataplex.entryGroups.useRelatedEntryLink'
// denied on resource '//dataplex.googleapis.com/projects/p/locations/us/entryGroups/g'
// (or it may not exist).`
const IAM_MAY_NOT_EXIST_HINT = 'or it may not exist';

function createdWithin(
  createTime: string | undefined,
  windowMs: number,
  now = Date.now(),
): boolean {
  const created = createTime ? Date.parse(createTime) : NaN;
  return (
    Number.isFinite(created) &&
    now - created >= -CLOCK_SKEW_ALLOWANCE_MS &&
    now - created < windowMs
  );
}

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

function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as object).sort()) {
        const inner = (v as Record<string, unknown>)[key];
        if (inner !== undefined) out[key] = sort(inner);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value ?? null));
}

// entrySource fields an OKF concept owns; a remote value with no local
// counterpart still differs, since the update rewrites `entry_source` whole.
const OKF_SOURCE_FIELDS = ['displayName', 'description', 'resource'];
const SERVER_SOURCE_FIELDS = new Set(['createTime', 'updateTime']);

/**
 * True when an OKF update of `local` over `remote` would change nothing the
 * update writes: the concept's entrySource fields and the data of each aspect
 * it carries. Remote-only aspects are ignored (the update never deletes them),
 * as is `parentEntry` (not in the update mask).
 */
export function okfEntryUnchanged(local: gcp.Entry, remote: gcp.Entry): boolean {
  const localSource = (local.entrySource ?? {}) as Record<string, unknown>;
  const remoteSource = (remote.entrySource ?? {}) as Record<string, unknown>;
  const keys = new Set([...Object.keys(localSource), ...OKF_SOURCE_FIELDS]);
  for (const key of keys) {
    if (SERVER_SOURCE_FIELDS.has(key)) continue;
    if (canonicalJson(localSource[key]) !== canonicalJson(remoteSource[key])) {
      return false;
    }
  }
  for (const [key, aspect] of Object.entries(local.aspects ?? {})) {
    const prior = remote.aspects?.[key];
    if (!prior) return false;
    if (canonicalJson(aspect?.data ?? {}) !== canonicalJson(prior.data ?? {})) {
      return false;
    }
  }
  return true;
}

/** The location segment of a `projects/<p>/locations/<loc>/...` name. */
function locationOf(name: string): string | undefined {
  return name.match(/^projects\/[^/]+\/locations\/([^/]+)\//)?.[1];
}

export function isUnimplementedBatch(res: { status: number; body?: string }): boolean {
  if (res.status === 501) return true;
  if (res.status !== 404 || !res.body) return false;
  try {
    const parsed = JSON.parse(res.body);
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
  if (change.createEntryLinkRequest) return change.createEntryLinkRequest.entryLinkId;
  if (change.updateEntryLinkRequest) return entryLinkId(change.updateEntryLinkRequest.entryLink);
  if (change.deleteEntryLinkRequest) {
    return change.deleteEntryLinkRequest.name.split('/entryLinks/')[1] ??
      change.deleteEntryLinkRequest.name;
  }
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
    const createLink = change.createEntryLinkRequest;
    const updateLink = change.updateEntryLinkRequest;
    const deleteLink = change.deleteEntryLinkRequest;
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
    } else if (createLink) {
      res = await catalog.createEntryLink(
        target.project,
        target.location,
        target.groupId,
        createLink.entryLinkId,
        createLink.entryLink,
      );
    } else if (updateLink) {
      res = await catalog.updateEntryLink(
        updateLink.entryLink,
        updateLink.aspectKeys,
      );
    } else if (deleteLink) {
      const id = deleteLink.name.split('/entryLinks/')[1] ?? deleteLink.name;
      res = await catalog.deleteEntryLink(
        target.project,
        target.location,
        target.groupId,
        id,
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

async function fetchEntryLinks(
  catalog: gcp.CatalogClient,
  target: BatchTarget,
  entries: gcp.Entry[],
): Promise<gcp.EntryLink[]> {
  if (!entries.length) return [];
  const groupSegment = `/locations/${target.location}/entryGroups/${target.groupId}/entryLinks/`;

  const perEntry = await mapConcurrent(entries, READ_CONCURRENCY, async (entry) => {
    let res;
    try {
      res = await catalog.lookupEntryLinks(target.project, target.location, {
        entry: entry.name,
      });
    } catch (err: any) {
      if (String(err?.message || err).includes('a test made a network call')) {
        return [] as gcp.EntryLink[];
      }
      throw err;
    }
    if (res.status === 404 || res.status === 501) return [] as gcp.EntryLink[];
    if (res.status !== 200 || !res.result) {
      throw new Error(
        `failed to read entry links for '${entry.name}' (status ${res.status})`,
      );
    }
    return res.result;
  });

  const byKey = new Map<string, gcp.EntryLink>();
  for (const list of perEntry) {
    for (const link of list) {
      if (link.name && !link.name.includes(groupSegment)) continue;
      if (shortenLinkType(link.entryLinkType) === 'schema-join') continue;
      const key = linkDedupKey(link);
      if (!byKey.has(key)) {
        byKey.set(key, link);
      }
    }
  }
  return [...byKey.values()];
}

function extractNamedEntryGroups(res: {
  message?: string;
  body?: string;
}): string[] {
  const texts: string[] = [];
  if (res.message) texts.push(res.message);
  if (res.body) {
    try {
      const error = JSON.parse(res.body)?.error;
      if (typeof error?.message === 'string') texts.push(error.message);
      if (Array.isArray(error?.details)) {
        for (const detail of error.details) {
          if (typeof detail?.resourceName === 'string') {
            texts.push(detail.resourceName);
          }
          if (typeof detail?.metadata?.resource === 'string') {
            texts.push(detail.metadata.resource);
          }
        }
      }
    } catch {
      // Non-JSON error body; res.message already holds the extracted text.
    }
  }
  const named = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(ENTRY_GROUP_RESOURCE_RE)) {
      named.add(match[1]);
    }
  }
  return [...named];
}

function isGroupPropagationError(
  res: { status: number; message?: string; body?: string },
  groupId: string,
  allow404 = false,
): boolean {
  if (res.status !== 403 && !(allow404 && res.status === 404)) return false;
  const named = extractNamedEntryGroups(res);
  // Do not retry 403/404 naming any external or sibling entry group (for
  // example `/entryGroups/<groupId>_archive` or `@bigquery`).
  if (named.some((g) => g !== groupId)) return false;
  if (named.includes(groupId)) return true;
  return (
    res.status === 403 &&
    (res.message ?? '').includes(IAM_MAY_NOT_EXIST_HINT)
  );
}

function jitteredLinkDelay(delayMs: number): number {
  return delayMs > 0 ? Math.round(delayMs * (0.5 + Math.random() * 0.5)) : 0;
}

async function withRateLimitRetry<T extends { status: number }>(
  fn: () => Promise<T>,
  baseDelayMs = DEFAULT_LINK_RETRY_DELAY_MS,
): Promise<T> {
  let delay = baseDelayMs;
  let attempts = 0;
  let res = await fn();
  while (res.status === 429 && attempts < 3) {
    attempts++;
    const sleepMs = jitteredLinkDelay(delay);
    if (sleepMs > 0) {
      await new Promise((r) => setTimeout(r, sleepMs));
    }
    delay =
      baseDelayMs === 0 ? 0 : Math.min(delay * 2, MAX_LINK_RETRY_DELAY_MS);
    res = await fn();
  }
  return res;
}

interface LinkReadinessOptions {
  groupId: string;
  startedAt: number;
  deadline: number;
  timeoutMs: number;
  baseDelayMs: number;
  allow404?: boolean;
}

interface LinkReadinessResult<T> {
  response: T;
  timedOut: boolean;
}

function propagationTimeoutHint(groupId: string, timeoutMs: number): string {
  const secs = Math.round(timeoutMs / 1000);
  const elapsed = secs > 0 ? ` after ${secs}s` : '';
  return (
    `links not written yet: permissions on new context set '${groupId}' ` +
    `are still propagating${elapsed}; re-run 'kcmd push' in ~2 minutes ` +
    `(or pass '--propagation-timeout <seconds>').`
  );
}

/**
 * Probes a single link operation with jittered exponential backoff and visible
 * stderr progress until new-EntryGroup IAM permissions propagate or the shared
 * timeout budget runs out.
 */
async function awaitLinkReadiness<
  T extends { status: number; message?: string; body?: string },
>(
  probe: () => Promise<T>,
  options: LinkReadinessOptions,
): Promise<LinkReadinessResult<T>> {
  const { groupId, startedAt, deadline, timeoutMs, baseDelayMs, allow404 } =
    options;
  let delay =
    baseDelayMs === 0 ? 0 : Math.max(MIN_PROPAGATION_SLEEP_MS, baseDelayMs);
  let rateLimitAttempts = 0;
  let waited = false;
  let lastProgressAt = 0;

  const retryReason = (r: T): 'rate-limit' | 'propagation' | undefined => {
    if (r.status === 429 && rateLimitAttempts < 3) return 'rate-limit';
    if (
      timeoutMs > 0 &&
      isGroupPropagationError(r, groupId, allow404) &&
      Date.now() < deadline
    ) {
      return 'propagation';
    }
    return undefined;
  };

  let res = await probe();
  for (let reason = retryReason(res); reason; reason = retryReason(res)) {
    if (reason === 'rate-limit') {
      rateLimitAttempts++;
      const sleepMs = jitteredLinkDelay(baseDelayMs);
      if (sleepMs > 0) {
        await new Promise((r) => setTimeout(r, sleepMs));
      }
    } else {
      const now = Date.now();
      if (!waited || now - lastProgressAt >= PROPAGATION_PROGRESS_INTERVAL_MS) {
        const elapsedSec = Math.max(0, Math.round((now - startedAt) / 1000));
        const totalSec = Math.max(1, Math.round(timeoutMs / 1000));
        console.error(
          `Waiting for Dataplex permissions on new context set '${groupId}' ` +
            `(${elapsedSec}s / ${totalSec}s)...`,
        );
        lastProgressAt = now;
      }
      waited = true;
      const remaining = Math.max(0, deadline - Date.now());
      const sleepMs =
        baseDelayMs === 0
          ? Math.min(2, remaining)
          : Math.min(
              Math.max(MIN_PROPAGATION_SLEEP_MS, jitteredLinkDelay(delay)),
              remaining,
            );
      if (sleepMs > 0) {
        await new Promise((r) => setTimeout(r, sleepMs));
      }
      delay =
        baseDelayMs === 0 ? 0 : Math.min(delay * 2, MAX_LINK_RETRY_DELAY_MS);
    }
    res = await probe();
  }

  if (isGroupPropagationError(res, groupId, allow404)) {
    return { response: res, timedOut: true };
  }
  if (waited) {
    const waitedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
    console.error(
      `Dataplex permissions on '${groupId}' ready after ${waitedSec}s.`,
    );
  }
  return { response: res, timedOut: false };
}

interface ReconcileLinksOptions {
  /** True when the target EntryGroup was created within the IAM propagation window. */
  isRecentEntryGroup?: boolean;
  /** Skip `:lookupEntryLinks` when a newly created EntryGroup has no prior entries. */
  skipInitialLookup?: boolean;
  /** Maximum milliseconds to wait for IAM propagation on a new EntryGroup. */
  propagationTimeoutMs?: number;
  /** Base retry delay in milliseconds (0 in unit tests). */
  retryDelayMs?: number;
}

interface ReconcileLinksResult {
  failed: number;
  details?: string;
}

/** Reconciles `bundle/_links.yaml` against the entry group's EntryLinks. */
async function reconcileLinks(
  catalog: gcp.CatalogClient,
  target: BatchTarget,
  desiredLinks: gcp.EntryLink[],
  entries: gcp.Entry[],
  existingEntries: Map<string, gcp.Entry>,
  options: ReconcileLinksOptions = {},
): Promise<ReconcileLinksResult> {
  const existingLinks = new Map<string, gcp.EntryLink>();
  const allEntryNames = [
    ...new Set([...entries.map((e) => e.name), ...existingEntries.keys()]),
  ];
  const groupSegment = `/locations/${target.location}/entryGroups/${target.groupId}/entryLinks/`;
  const managesSchemaJoin = desiredLinks.some(
    (l) => shortenLinkType(l.entryLinkType) === 'schema-join',
  );
  const timeoutMs =
    options.propagationTimeoutMs ?? DEFAULT_LINK_PROPAGATION_TIMEOUT_MS;
  const baseDelayMs = options.retryDelayMs ?? DEFAULT_LINK_RETRY_DELAY_MS;
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;

  if (!options.skipInitialLookup) {
    const preflightLookup = new Map<string, gcp.ApiResult<gcp.EntryLink[]>>();
    // On a recently created group with existing entries, probe a single entry
    // sequentially before fanning out so concurrent workers do not retry in
    // lockstep while IAM propagates.
    if (options.isRecentEntryGroup && existingEntries.size > 0) {
      const firstEntry = existingEntries.keys().next().value;
      if (firstEntry !== undefined) {
        const ready = await awaitLinkReadiness(
          () =>
            catalog.lookupEntryLinks(target.project, target.location, {
              entry: firstEntry,
            }),
          {
            groupId: target.groupId,
            startedAt,
            deadline,
            timeoutMs,
            baseDelayMs,
          },
        );
        if (ready.timedOut) {
          const hint = propagationTimeoutHint(target.groupId, timeoutMs);
          console.error(`  ${hint}`);
          return { failed: 1, details: hint };
        }
        preflightLookup.set(firstEntry, ready.response);
      }
    }

    let lookupFailed = false;
    const lookedUp = await mapConcurrent(
      allEntryNames,
      READ_CONCURRENCY,
      async (entryName) => {
        try {
          const cached = preflightLookup.get(entryName);
          const res =
            cached ??
            (await withRateLimitRetry(
              () =>
                catalog.lookupEntryLinks(target.project, target.location, {
                  entry: entryName,
                }),
              baseDelayMs,
            ));
          // A brand-new entry created milliseconds earlier in batchChangeMetadata
          // can return 403 ("or it may not exist") during regional read-after-create
          // IAM propagation and has no pre-existing links to delete.
          if (
            res.status === 404 ||
            res.status === 501 ||
            (res.status === 403 && !existingEntries.has(entryName))
          ) {
            return [] as gcp.EntryLink[];
          }
          if (res.status !== 200) {
            console.error(
              `  lookupEntryLinks(${entryName}): HTTP ${res.status} ${res.message ?? ''}`,
            );
            lookupFailed = true;
            return [] as gcp.EntryLink[];
          }
          return res.result ?? [];
        } catch (err: any) {
          console.error(
            `  lookupEntryLinks(${entryName}): ${err.message || err}`,
          );
          lookupFailed = true;
          return [] as gcp.EntryLink[];
        }
      },
    );
    if (lookupFailed) return { failed: 1 };

    for (const list of lookedUp) {
      for (const link of list) {
        if (link.name && !link.name.includes(groupSegment)) continue;
        if (
          !managesSchemaJoin &&
          shortenLinkType(link.entryLinkType) === 'schema-join'
        ) {
          continue;
        }
        const id = entryLinkId(link);
        if (id && !existingLinks.has(id)) {
          existingLinks.set(id, link);
        }
      }
    }
  }

  const desiredById = new Map(
    desiredLinks.map((link) => [entryLinkId(link), link]),
  );
  let failed = 0;
  let writeConfirmedReady = !options.isRecentEntryGroup;

  const runLinkWrite = async <
    T extends { status: number; message?: string; body?: string },
  >(
    fn: () => Promise<T>,
    allow404 = false,
  ): Promise<LinkReadinessResult<T>> => {
    if (writeConfirmedReady) {
      return {
        response: await withRateLimitRetry(fn, baseDelayMs),
        timedOut: false,
      };
    }
    const ready = await awaitLinkReadiness(fn, {
      groupId: target.groupId,
      startedAt,
      deadline,
      timeoutMs,
      baseDelayMs,
      allow404,
    });
    if (
      !ready.timedOut &&
      ((ready.response.status >= 200 && ready.response.status < 300) ||
        ready.response.status === 409)
    ) {
      writeConfirmedReady = true;
    }
    return ready;
  };

  // Delete orphaned or stale links first so recreated links or links with new
  // deterministic IDs do not collide on duplicate endpoints.
  for (const [id, prev] of existingLinks) {
    const desired = desiredById.get(id);
    if (!desired || isStaleEntryLink(prev, desired)) {
      const del = await runLinkWrite(() =>
        catalog.deleteEntryLink(
          target.project,
          target.location,
          target.groupId,
          id,
        ),
      );
      if (del.timedOut) {
        const hint = propagationTimeoutHint(target.groupId, timeoutMs);
        console.error(`  ${hint}`);
        return { failed: failed + 1, details: hint };
      }
      if (del.response.status !== 200 && del.response.status !== 404) {
        console.error(
          `  ${id}: HTTP ${del.response.status} ${del.response.message ?? ''}`,
        );
        failed++;
      } else if (desired) {
        existingLinks.delete(id);
      }
    }
  }

  for (const link of desiredLinks) {
    const id = entryLinkId(link);
    const prev = existingLinks.get(id);
    if (!prev) {
      const created = await runLinkWrite(
        () =>
          catalog.createEntryLink(
            target.project,
            target.location,
            target.groupId,
            id,
            link,
          ),
        true,
      );
      if (created.timedOut) {
        const hint = propagationTimeoutHint(target.groupId, timeoutMs);
        console.error(`  ${hint}`);
        return { failed: failed + 1, details: hint };
      }
      const res = created.response;
      if (res.status === 409) {
        const del = await withRateLimitRetry(
          () =>
            catalog.deleteEntryLink(
              target.project,
              target.location,
              target.groupId,
              id,
            ),
          baseDelayMs,
        );
        if (del.status === 200 || del.status === 404) {
          const retry = await withRateLimitRetry(
            () =>
              catalog.createEntryLink(
                target.project,
                target.location,
                target.groupId,
                id,
                link,
              ),
            baseDelayMs,
          );
          if (retry.status !== 200) {
            console.error(
              `  ${id}: HTTP ${retry.status} ${retry.message ?? ''}`,
            );
            failed++;
          }
        } else {
          console.error(`  ${id}: HTTP ${del.status} ${del.message ?? ''}`);
          failed++;
        }
      } else if (res.status !== 200) {
        console.error(`  ${id}: HTTP ${res.status} ${res.message ?? ''}`);
        failed++;
      }
    } else if (
      JSON.stringify(prev.aspects ?? {}) !== JSON.stringify(link.aspects ?? {})
    ) {
      const upd = await runLinkWrite(() =>
        catalog.updateEntryLink(link, Object.keys(link.aspects ?? {})),
      );
      if (upd.timedOut) {
        const hint = propagationTimeoutHint(target.groupId, timeoutMs);
        console.error(`  ${hint}`);
        return { failed: failed + 1, details: hint };
      }
      if (upd.response.status !== 200) {
        console.error(
          `  ${id}: HTTP ${upd.response.status} ${upd.response.message ?? ''}`,
        );
        failed++;
      }
    }
  }

  return { failed };
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
      let wouldCreate = 0;
      let wouldUpdate = 0;
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
        if (options?.dryRun) {
          // Reconstruct and report only; never touch the local snapshot.
          const { localName, exists } = this._snapshot._previewStoreEntry(res.result);
          console.log(`would ${exists ? 'update' : 'create'} ${localName}`);
          if (exists) wouldUpdate++;
          else wouldCreate++;
        } else {
          await this._snapshot._storeEntry(res.result);
        }

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
      if (options?.dryRun) {
        console.log(
            `Dry run: would write ${wouldCreate} new and ${wouldUpdate} updated ` +
            `entr${wouldCreate + wouldUpdate === 1 ? 'y' : 'ies'}; no files written (--dry-run).`);
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
  async push(options?: PushSyncOptions): Promise<SyncResult> {
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
    const {
      project,
      location,
      entryGroup: groupId,
    } = entryGroupCoordinates(this._snapshot.manifest.source);

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

    const links = await fetchEntryLinks(
      this._catalog,
      { project, location, groupId },
      planned.map(p => p.entry),
    );
    const stale = layout.listEntries().filter(name => !pulledNames.has(name));

    if (options.dryRun) {
      for (const { localName } of planned) {
        console.log(`would write ${layout.relativeBundlePath(localName)}`);
      }
      if (links.length > 0) {
        console.log(`would write ${BUNDLE_DIR}/${LINKS_FILE}`);
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
    await layout.writeLinks(links);
    console.log(`Wrote ${planned.length} concept(s) to ${BUNDLE_DIR}/.`);
    return { success: true };
  }

  private async _pushOkf(
    layout: OkfLayout,
    options: PushSyncOptions,
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
    const { hasLinksConfig, links: declaredLinks } = layout.readLinks();

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

    if (!entries.length && !toDelete.length && !declaredLinks.length) {
      return {
        success: false,
        details: `no OKF concepts found in ${BUNDLE_DIR}/`,
      };
    }

    // An EntryLink can only reference an entry in its own region or `global`;
    // refuse up front rather than fail after the entries were written.
    const crossRegion: string[] = [];
    for (const link of declaredLinks) {
      for (const ref of link.entryReferences ?? []) {
        const refLocation = locationOf(ref.name);
        if (refLocation && refLocation !== location && refLocation !== 'global') {
          crossRegion.push(
            `${entryLinkId(link)}: '${ref.name}' is in region '${refLocation}', ` +
              `but entry links in ${groupId} must reference entries in ` +
              `'${location}' or 'global'`,
          );
        }
      }
    }
    if (crossRegion.length) {
      return {
        success: false,
        details:
          `${BUNDLE_DIR}/${LINKS_FILE} links entries outside the entry group's region:\n  ` +
          crossRegion.join('\n  '),
      };
    }

    // A link to an in-group entry that is neither a local concept nor a
    // surviving remote entry (e.g. its concept file was just deleted) cannot be
    // created; drop it with a warning instead of failing the push.
    const deletedNames = new Set(toDelete.map(e => e.name));
    const knownInGroup = new Set([
      ...localNames,
      ...[...existing.keys()].filter(name => !deletedNames.has(name)),
    ]);
    const inGroupPrefix = `${entryGroup}/entries/`;
    const links = declaredLinks.filter(link => {
      const missing = (link.entryReferences ?? [])
        .map(ref => ref.name)
        .filter(name => name.startsWith(inGroupPrefix) && !knownInGroup.has(name));
      if (!missing.length) return true;
      console.warn(
        `Warning: skipping ${BUNDLE_DIR}/${LINKS_FILE} link ${entryLinkId(link)}: ` +
          `${missing.map(entryIdFromName).join(', ')} is not a concept in ${BUNDLE_DIR}/.`,
      );
      return false;
    });

    // Skip updates that would rewrite an entry with what it already holds, so
    // the plan reports only real changes and unchanged entries keep their
    // updateTime. A remote read that fails falls back to updating.
    const toUpdate = entries.filter(entry => existing.has(entry.name));
    const unchanged = new Set<string>();
    await mapConcurrent(toUpdate, READ_CONCURRENCY, async (entry) => {
      try {
        const res = await this._catalog.lookupEntry(project, location, entry.name, {
          view: 'ALL',
        });
        if (res.status === 200 && res.result && okfEntryUnchanged(entry, res.result)) {
          unchanged.add(entry.name);
        }
      } catch {
        // Treat as changed.
      }
    });
    const toWrite = entries.filter(entry => !unchanged.has(entry.name));

    const upsertChanges = toWrite.map(entry => toChange(entry, entryGroup, existing));
    const deleteChanges: gcp.MetadataChange[] = toDelete.map(e => ({
      deleteEntryRequest: { name: e.name },
    }));
    const changes = [...upsertChanges, ...deleteChanges];
    const creates = upsertChanges.filter(c => c.createEntryRequest).length;
    const updates = upsertChanges.length - creates;
    const deletes = deleteChanges.length;
    const unchangedNote = unchanged.size ? `, ${unchanged.size} unchanged` : '';

    if (options.validateOnly) {
      for (const entry of toWrite) console.log(`would write ${entry.name}`);
      for (const entry of toDelete) console.log(`would delete ${entry.name}`);
      for (const link of links) console.log(`would link ${link.name}`);
      console.log(
        `${changes.length} change(s): ${creates} create, ${updates} update, ` +
          `${deletes} delete${unchangedNote}. Nothing sent (dry run).`,
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

    let linkFailed = 0;
    let linkDetails: string | undefined;
    if (hasLinksConfig) {
      if (failed > 0) {
        console.error(
          'Skipping entry link reconciliation because entry changes failed.',
        );
      } else {
        // Exclude the synthetic `entryTypes/entrygroup` (`<groupId>_entry`) entry
        // Dataplex creates automatically on every group, so a brand-new group is
        // not treated as having a pre-existing concept entry.
        const survivingExisting = new Map(
          remoteEntries
            .filter((e) => !deletedNames.has(e.name))
            .map((e) => [e.name, e]),
        );
        const windowMs = Math.max(
          NEW_ENTRY_GROUP_WINDOW_MS,
          options.propagationTimeoutMs ?? DEFAULT_LINK_PROPAGATION_TIMEOUT_MS,
        );
        const isRecentEntryGroup = createdWithin(
          this._snapshot.manifest.source.entryGroupCreateTime,
          windowMs,
        );
        const reconciled = await reconcileLinks(
          this._catalog,
          { project, location, groupId },
          links,
          entries,
          survivingExisting,
          {
            isRecentEntryGroup,
            skipInitialLookup:
              isRecentEntryGroup && survivingExisting.size === 0,
            propagationTimeoutMs: options.propagationTimeoutMs,
            retryDelayMs: options.retryDelayMs,
          },
        );
        linkFailed = reconciled.failed;
        linkDetails = reconciled.details;
      }
    }

    console.log(
      `Pushed ${changes.length - Math.min(failed, changes.length)}/${changes.length} change(s) to ` +
        `${groupId} (${creates} create, ${updates} update, ${deletes} delete${unchangedNote}).`,
    );
    if (linkFailed) {
      console.error(`${linkFailed} entry link change(s) failed.`);
    }
    return failed || linkFailed
      ? { success: false, ...(linkDetails ? { details: linkDetails } : {}) }
      : { success: true };
  }

  async validate(): Promise<ValidationResult> {
    throw new Error('Not yet implemented');
  }

  async status(): Promise<StatusResult> {
    throw new Error('Not yet implemented');
  }
}
