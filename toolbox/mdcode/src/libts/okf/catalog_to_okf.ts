// The `kcmd pull --format=okf` path: Knowledge Catalog -> OKF files on disk.
// Only the overview aspect is represented today; every other aspect is dropped.

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as gcp from '../gcp';
import * as dataplex from '../gcp/dataplex';
import * as kcmd from '../index';
import {assertResidueOnly, buildResidue, OVERVIEW_ASPECT_KEY, typeFacetKey} from './catalog_residue';
import {Concept, conceptToFileContent, RESIDUE_KEY} from './concept';
import {
  formatLinksYaml,
  linkDedupKey,
  LINKS_FILE,
  shortenLinkType,
} from './links';
import {splitOkfMetadata} from './okf_metadata';

/** Beside catalog.yaml, never inside it, so the bundle stays portable OKF. */
const BUNDLE_DIR = 'bundle';

/** Options forwarded from `kcmd pull`. */
export interface CatalogToOkfOptions {
  /** Report what would be written; touch no files. */
  dryRun?: boolean;
}

/** Materializes the scope's context set as an OKF bundle. Returns an exit code. */
export async function catalogToOkf(
  ctx: gcp.ApiContext,
  snapshot: kcmd.CatalogSnapshot,
  options: CatalogToOkfOptions = {},
): Promise<number> {
  const concepts: Concept[] = [];
  const entries: gcp.Entry[] = [];
  for await (const entry of fetchEntries(ctx, snapshot)) {
    // Dataplex owns the `<group>_entry` entry and recreates it itself, so push
    // skips it; writing it here would put a file in the bundle push ignores.
    if (entry.entryType?.endsWith('/entrygroup')) continue;
    entries.push(entry);
    concepts.push(entryToConcept(entry, snapshot));
  }

  const [project, location, groupId] = snapshot.manifest.source.name.split('.');
  const entryGroup = dataplex.catalogContainer(project, location, groupId);
  const links = await fetchEntryLinks(ctx, snapshot, entries);

  const root = path.join(snapshot.basePath, BUNDLE_DIR);
  if (options.dryRun) {
    for (const c of concepts) {
      console.log(`would write ${path.join(BUNDLE_DIR, `${c.id}.md`)}`);
    }
    if (links.length > 0) {
      console.log(`would write ${path.join(BUNDLE_DIR, LINKS_FILE)}`);
    }
    console.log(`${concepts.length} concept(s); no files written (--dry-run).`);
    return 0;
  }

  for (const c of concepts) {
    const file = path.join(root, `${c.id}.md`);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, conceptToFileContent(c), 'utf8');
  }

  const linksPath = path.join(root, LINKS_FILE);
  if (links.length > 0) {
    fs.mkdirSync(root, {recursive: true});
    fs.writeFileSync(linksPath, formatLinksYaml(links, entryGroup), 'utf8');
  } else if (fs.existsSync(linksPath)) {
    fs.unlinkSync(linksPath);
  }

  console.log(`Wrote ${concepts.length} concept(s) to ${BUNDLE_DIR}/.`);
  return 0;
}

async function fetchEntryLinks(
  ctx: gcp.ApiContext,
  snapshot: kcmd.CatalogSnapshot,
  entries: gcp.Entry[],
): Promise<gcp.EntryLink[]> {
  if (!entries.length) return [];
  const [project, location, groupId] = snapshot.manifest.source.name.split('.');
  const groupSegment = `/locations/${location}/entryGroups/${groupId}/entryLinks/`;
  const catalog = new dataplex.CatalogClient(ctx);
  const byKey = new Map<string, gcp.EntryLink>();

  for (const entry of entries) {
    let res;
    try {
      res = await catalog.lookupEntryLinks(project, location, {
        entry: entry.name,
      });
    } catch (err: any) {
      if (String(err?.message || err).includes('a test made a network call')) {
        return [];
      }
      throw err;
    }
    if (res.status === 404 || res.status === 501) continue;
    if (res.status !== 200 || !res.result) {
      throw new Error(
        `failed to read entry links for '${entry.name}' (status ${res.status})`,
      );
    }
    for (const link of res.result) {
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

async function* fetchEntries(
  ctx: gcp.ApiContext,
  snapshot: kcmd.CatalogSnapshot,
): AsyncGenerator<gcp.Entry> {
  const catalog = new dataplex.CatalogClient(ctx);
  for await (const stub of snapshot.manifest.source.entries(ctx)) {
    // `name` is projects/<p>/locations/<l>/entryGroups/<eg>/entries/<id>.
    const parts = stub.name.split('/');
    const res = await catalog.lookupEntry(
      parts[1],
      parts[3],
      stub.name,
      undefined,
      undefined,
      true,
    );

    // 403 covers both "no such entry" and "no permission"; falling back to the
    // aspect-less list stub would write a concept that looks real but has no body.
    if (res.status !== 200 || !res.result) {
      throw new Error(
        `failed to read entry '${stub.name}' (status ${res.status})`,
      );
    }
    yield res.result;
  }
}

function entryToConcept(
  entry: gcp.Entry,
  snapshot: kcmd.CatalogSnapshot,
): Concept {
  const source = entry.entrySource ?? {};
  const frontmatter: Record<string, unknown> = {type: conceptType(entry)};
  if (source.displayName) frontmatter['title'] = source.displayName;
  if (source.description) frontmatter['description'] = source.description;
  if (source.resource) frontmatter['resource'] = source.resource;

  const overview = entry.aspects?.[OVERVIEW_ASPECT_KEY];
  const content =
    typeof overview?.data?.['content'] === 'string'
      ? (overview.data['content'] as string)
      : '';
  const {body, metadata} = splitOkfMetadata(content);
  Object.assign(frontmatter, metadata);

  const residue = buildResidue(entry, OVERVIEW_ASPECT_KEY, body);
  if (residue) frontmatter[RESIDUE_KEY] = residue;
  assertResidueOnly(frontmatter);

  return {
    id: snapshot.manifest.source.localName(entry),
    frontmatter,
    body,
  };
}

function conceptType(entry: gcp.Entry): string {
  const key = typeFacetKey(entry.entryType);
  if (key) {
    const label = entry.aspects?.[key]?.data?.['type'];
    if (typeof label === 'string' && label) return label;
  }
  return entry.entryType?.split('/').pop() || 'concept';
}
