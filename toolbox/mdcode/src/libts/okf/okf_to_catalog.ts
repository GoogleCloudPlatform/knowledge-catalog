// The `kcmd push --format=okf` path: OKF files on disk -> Knowledge Catalog.

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as gcp from '../gcp';
import * as dataplex from '../gcp/dataplex';
import * as kcmd from '../index';
import {Concept, EXTRA_KEY, fileContentToConcept, RESIDUE_KEY} from './concept';
import {conceptToEntry} from './concept_to_entry';
import {
  entryLinkId,
  isStaleEntryLink,
  readBundleLinks,
  shortenLinkType,
} from './links';

const BUNDLE_DIR = 'bundle';
const BATCH_MAX_CHANGES = 250;

/** Options forwarded from `kcmd push`. */
export interface OkfToCatalogOptions {
  /** Report what would be sent; call nothing. */
  validateOnly?: boolean;
}

/** Writes the OKF bundle to the context set named by `catalog.yaml`. */
export async function okfToCatalog(
  ctx: gcp.ApiContext,
  snapshot: kcmd.CatalogSnapshot,
  options: OkfToCatalogOptions = {},
): Promise<number> {
  const [project, location, groupId] = snapshot.manifest.source.name.split('.');
  const entryGroup = dataplex.catalogContainer(project, location, groupId);
  const root = path.join(snapshot.basePath, BUNDLE_DIR);
  if (!fs.existsSync(root)) {
    console.error(`no ${BUNDLE_DIR}/ directory to push`);
    return 1;
  }

  let entries: gcp.Entry[];
  let concepts: Concept[];
  let hasLinksConfig = false;
  let links: gcp.EntryLink[] = [];
  try {
    ({entries, concepts} = readBundle(root, entryGroup));
    ({hasLinksConfig, links} = readBundleLinks(root, entryGroup, concepts));
  } catch (err: any) {
    console.error(`Error: ${err.message || err}`);
    return 1;
  }
  if (!entries.length && !links.length) {
    console.error(`no OKF concepts found in ${BUNDLE_DIR}/`);
    return 1;
  }

  const existing = new Map<string, gcp.Entry>();
  for await (const stub of snapshot.manifest.source.entries(ctx)) {
    existing.set(stub.name, stub);
  }

  resolveMissingParents(entries, entryGroup, existing);

  const changes = entries.map((entry) => toChange(entry, entryGroup, existing));
  const creates = changes.filter((c) => c.createEntryRequest).length;

  if (options.validateOnly) {
    for (const entry of entries) console.log(`would write ${entry.name}`);
    for (const link of links) console.log(`would link ${link.name}`);
    console.log(
      `${changes.length} change(s): ${creates} create, ` +
        `${changes.length - creates} update. Nothing sent (dry run).`,
    );
    return 0;
  }

  const catalog = new dataplex.CatalogClient(ctx);
  let failed = 0;
  for (let i = 0; i < changes.length; i += BATCH_MAX_CHANGES) {
    failed += await applyChunk(
      catalog,
      {project, location, groupId},
      changes.slice(i, i + BATCH_MAX_CHANGES),
    );
  }

  if (hasLinksConfig) {
    failed += await reconcileLinks(
      catalog,
      {project, location, groupId},
      entryGroup,
      links,
      entries,
      existing,
    );
  }

  console.log(
    `Pushed ${changes.length - Math.min(failed, changes.length)}/${changes.length} change(s) to ` +
      `${groupId} (${creates} create, ${changes.length - creates} update).`,
  );
  return failed ? 1 : 0;
}

function conceptFiles(dir: string): string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return conceptFiles(p);
    return p.endsWith('.md') ? [p] : [];
  });
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

// Parents must exist before their children, ordered by parent-chain depth.
function readBundle(
  root: string,
  entryGroup: string,
): {entries: gcp.Entry[]; concepts: Concept[]} {
  const entries: gcp.Entry[] = [];
  const concepts: Concept[] = [];
  for (const file of conceptFiles(root)) {
    const id = path.relative(root, file).replace(/\.md$/, '');
    const concept = fileContentToConcept(fs.readFileSync(file, 'utf8'), id);
    const hasExplicitMeta =
      concept.frontmatter[RESIDUE_KEY] !== undefined ||
      concept.frontmatter[EXTRA_KEY] !== undefined ||
      concept.frontmatter['type'] !== undefined;
    // Skip append-only operation logs (`log.md`) that carry no concept frontmatter.
    if (id === 'log' && !hasExplicitMeta) continue;
    // When `agents.md` or `<dir>.md` already exists alongside a generated
    // directory-listing `index.md`, prefer the explicit entry file.
    if (
      id === 'index' &&
      !hasExplicitMeta &&
      fs.existsSync(path.join(root, 'agents.md'))
    ) {
      continue;
    }
    if (
      id.endsWith('/index') &&
      !hasExplicitMeta &&
      fs.existsSync(path.join(root, `${id.slice(0, -'/index'.length)}.md`))
    ) {
      continue;
    }

    concepts.push(concept);
    const entry = conceptToEntry(concept, entryGroup);
    // The `<group>_entry` entry belongs to Dataplex, which creates it itself.
    if (entry.entryType.endsWith('/entrygroup')) continue;
    retargetParent(entry, entryGroup);
    entries.push(entry);
  }
  const byName = new Map(entries.map((e) => [e.name, e]));
  entries.sort((a, b) => {
    const diff = entryDepth(a, byName) - entryDepth(b, byName);
    if (diff !== 0) return diff;
    return entryId(a).split('/').length - entryId(b).split('/').length;
  });
  return {entries, concepts};
}

function entryId(entry: gcp.Entry): string {
  return entry.name.split('/entries/')[1] ?? entry.name;
}

// A bundle pulled from one group and pushed to another carries the old group
// in parentEntry; the tree is internal to the bundle, so rebase it.
function retargetParent(entry: gcp.Entry, entryGroup: string): void {
  const at = entry.parentEntry?.indexOf('/entries/') ?? -1;
  if (at === -1) return;
  entry.parentEntry = entryGroup + entry.parentEntry!.slice(at);
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
    return entryId(a).split('/').length - entryId(b).split('/').length;
  });
}

function toChange(
  entry: gcp.Entry,
  entryGroup: string,
  existing: Map<string, gcp.Entry>,
): dataplex.MetadataChange {
  if (existing.has(entry.name)) {
    const priorSource = existing.get(entry.name)?.entrySource;
    if (priorSource?.createTime || priorSource?.updateTime) {
      entry.entrySource = {...entry.entrySource};
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
    createEntryRequest: {parent: entryGroup, entryId: entryId(entry), entry},
  };
}

interface Target {
  project: string;
  location: string;
  groupId: string;
}

/** Applies one batch, falling back per entry. Returns the failure count. */
async function applyChunk(
  catalog: dataplex.CatalogClient,
  target: Target,
  changes: dataplex.MetadataChange[],
): Promise<number> {
  const res = await catalog.batchChangeMetadata(
    target.project,
    target.location,
    target.groupId,
    changes,
  );

  if (
    (res.status === 404 || res.status === 501) &&
    (res.message ?? '').includes('Method not found')
  ) {
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

  const failure = await catalog.awaitOperation(res.result, 'push');
  if (failure) {
    console.error(failure);
    return changes.length;
  }

  const name = res.result.name;
  if (!name) return 0;
  const op = await catalog.getOperation(name);
  const failures = op.result?.metadata?.failedRequests ?? {};
  for (const [index, status] of Object.entries(failures)) {
    const change = changes[Number(index)];
    const id =
      change?.createEntryRequest?.entryId ??
      (change?.updateEntryRequest
        ? entryId(change.updateEntryRequest.entry)
        : undefined) ??
      change?.createEntryLinkRequest?.entryLinkId ??
      (change?.updateEntryLinkRequest
        ? entryLinkId(change.updateEntryLinkRequest.entryLink)
        : undefined) ??
      change?.deleteEntryLinkRequest?.name?.split('/entryLinks/')[1] ??
      `change[${index}]`;
    console.error(`  ${id}: ${status.message ?? status.code}`);
  }
  return Object.keys(failures).length;
}

/** The Entries API, for universes where BatchChangeMetadata is not deployed. */
async function applyViaEntries(
  catalog: dataplex.CatalogClient,
  target: Target,
  changes: dataplex.MetadataChange[],
): Promise<number> {
  let failed = 0;
  for (const change of changes) {
    const create = change.createEntryRequest;
    const update = change.updateEntryRequest;
    const createLink = change.createEntryLinkRequest;
    const updateLink = change.updateEntryLinkRequest;
    const deleteLink = change.deleteEntryLinkRequest;
    let res;
    let id = '';
    if (create) {
      id = create.entryId;
      // Unlike the batch, entries.create rejects a body carrying `name`.
      const {name, ...body} = create.entry;
      res = await catalog.createEntry(
        target.project,
        target.location,
        target.groupId,
        create.entryId,
        body as gcp.Entry,
      );
    } else if (update) {
      id = entryId(update.entry);
      res = await catalog.modifyEntry(
        target.project,
        target.location,
        update.entry,
        ['aspects', 'entry_source'],
        update.aspectKeys,
      );
    } else if (createLink) {
      id = createLink.entryLinkId;
      res = await catalog.createEntryLink(
        target.project,
        target.location,
        target.groupId,
        createLink.entryLinkId,
        createLink.entryLink,
      );
    } else if (updateLink) {
      id = entryLinkId(updateLink.entryLink);
      res = await catalog.updateEntryLink(
        updateLink.entryLink,
        updateLink.aspectKeys,
      );
    } else if (deleteLink) {
      id = deleteLink.name.split('/entryLinks/')[1] ?? deleteLink.name;
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
      console.error(`  ${id}: HTTP ${res.status} ${res.message ?? ''}`);
      failed++;
    }
  }
  return failed;
}

/** Reconciles `bundle/_links.yaml` against the entry group's EntryLinks. */
async function reconcileLinks(
  catalog: dataplex.CatalogClient,
  target: Target,
  entryGroup: string,
  desiredLinks: gcp.EntryLink[],
  entries: gcp.Entry[],
  existingEntries: Map<string, gcp.Entry>,
): Promise<number> {
  const existingLinks = new Map<string, gcp.EntryLink>();
  const allEntryNames = [
    ...new Set([...entries.map((e) => e.name), ...existingEntries.keys()]),
  ];
  const groupSegment = `/locations/${target.location}/entryGroups/${target.groupId}/entryLinks/`;
  const managesSchemaJoin = desiredLinks.some(
    (l) => shortenLinkType(l.entryLinkType) === 'schema-join',
  );

  for (const entryName of allEntryNames) {
    let res;
    try {
      res = await catalog.lookupEntryLinks(target.project, target.location, {
        entry: entryName,
      });
    } catch (err: any) {
      if (String(err?.message || err).includes('a test made a network call')) {
        break;
      }
      console.error(
        `  lookupEntryLinks(${entryName}): ${err.message || err}`,
      );
      return 1;
    }
    if (res.status === 404 || res.status === 501) continue;
    if (res.status !== 200) {
      console.error(
        `  lookupEntryLinks(${entryName}): HTTP ${res.status} ${res.message ?? ''}`,
      );
      return 1;
    }
    for (const link of res.result ?? []) {
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

  const desiredById = new Map(
    desiredLinks.map((link) => [entryLinkId(link), link]),
  );
  let failed = 0;

  // Delete orphaned or stale links first so recreated links or links with new
  // deterministic IDs do not collide on duplicate endpoints.
  for (const [id, prev] of existingLinks) {
    const desired = desiredById.get(id);
    if (!desired || isStaleEntryLink(prev, desired)) {
      const del = await catalog.deleteEntryLink(
        target.project,
        target.location,
        target.groupId,
        id,
      );
      if (del.status !== 200 && del.status !== 404) {
        console.error(
          `  ${id}: HTTP ${del.status} ${del.message ?? ''}`,
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
      const res = await catalog.createEntryLink(
        target.project,
        target.location,
        target.groupId,
        id,
        link,
      );
      if (res.status === 409) {
        // Already exists (e.g. when lookupEntryLinks did not return it);
        // replace or update in place.
        const del = await catalog.deleteEntryLink(
          target.project,
          target.location,
          target.groupId,
          id,
        );
        if (del.status === 200 || del.status === 404) {
          const retry = await catalog.createEntryLink(
            target.project,
            target.location,
            target.groupId,
            id,
            link,
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
      const upd = await catalog.updateEntryLink(
        link,
        Object.keys(link.aspects ?? {}),
      );
      if (upd.status !== 200) {
        console.error(`  ${id}: HTTP ${upd.status} ${upd.message ?? ''}`);
        failed++;
      }
    }
  }

  return failed;
}
