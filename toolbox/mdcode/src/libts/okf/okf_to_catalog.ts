// The `kcmd push --format=okf` path: OKF files on disk -> Knowledge Catalog.

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as gcp from '../gcp';
import * as dataplex from '../gcp/dataplex';
import * as kcmd from '../index';
import {fileContentToConcept} from './concept';
import {conceptToEntry} from './concept_to_entry';

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

  const entries = readBundle(root, entryGroup);
  const existing = new Set<string>();
  for await (const stub of snapshot.manifest.source.entries(ctx)) {
    existing.add(stub.name);
  }

  const changes = entries.map((entry) => toChange(entry, entryGroup, existing));
  const creates = changes.filter((c) => c.createEntryRequest).length;

  if (options.validateOnly) {
    for (const entry of entries) console.log(`would write ${entry.name}`);
    console.log(
      `${changes.length} change(s): ${creates} create, ` +
        `${changes.length - creates} update. Nothing sent (--validate-only).`,
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

  console.log(
    `Pushed ${changes.length - failed}/${changes.length} change(s) to ` +
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

// Parents must exist before their children, and id depth is that order.
function readBundle(root: string, entryGroup: string): gcp.Entry[] {
  const entries: gcp.Entry[] = [];
  for (const file of conceptFiles(root)) {
    const id = path.relative(root, file).replace(/\.md$/, '');
    const concept = fileContentToConcept(fs.readFileSync(file, 'utf8'), id);
    const entry = conceptToEntry(concept, entryGroup);
    // The `<group>_entry` entry belongs to Dataplex, which creates it itself.
    if (entry.entryType.endsWith('/entrygroup')) continue;
    retargetParent(entry, entryGroup);
    entries.push(entry);
  }
  return entries.sort(
    (a, b) => entryId(a).split('/').length - entryId(b).split('/').length,
  );
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

function toChange(
  entry: gcp.Entry,
  entryGroup: string,
  existing: Set<string>,
): dataplex.MetadataChange {
  if (existing.has(entry.name)) {
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
      entryId(change!.updateEntryRequest!.entry);
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
    let res;
    if (create) {
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
      res = await catalog.modifyEntry(
        target.project,
        target.location,
        update.entry,
        ['aspects', 'entry_source'],
        update.aspectKeys,
      );
    } else {
      continue;
    }
    if (res.status !== 200) {
      const id = create?.entryId ?? entryId(update!.entry);
      console.error(`  ${id}: HTTP ${res.status} ${res.message ?? ''}`);
      failed++;
    }
  }
  return failed;
}
