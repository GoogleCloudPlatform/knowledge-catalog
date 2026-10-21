// The `kcmd pull --format=okf` path: Knowledge Catalog -> OKF files on disk.
// Only the overview aspect is represented today; every other aspect is dropped.

import * as fs from 'node:fs';
import * as path from 'node:path';

import * as gcp from '../gcp';
import * as dataplex from '../gcp/dataplex';
import * as kcmd from '../index';
import {assertResidueOnly, buildResidue, typeFacetKey} from './catalog_residue';
import {Concept, conceptToFileContent, RESIDUE_KEY} from './concept';

/** Beside catalog.yaml, never inside it, so the bundle stays portable OKF. */
const BUNDLE_DIR = 'bundle';

const OVERVIEW_ASPECT_KEY = 'dataplex-types.global.overview';

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
  for await (const entry of fetchEntries(ctx, snapshot)) {
    concepts.push(entryToConcept(entry, snapshot));
  }

  const root = path.join(snapshot.basePath, BUNDLE_DIR);
  if (options.dryRun) {
    for (const c of concepts) {
      console.log(`would write ${path.join(BUNDLE_DIR, `${c.id}.md`)}`);
    }
    console.log(`${concepts.length} concept(s); no files written (--dry-run).`);
    return 0;
  }

  for (const c of concepts) {
    const file = path.join(root, `${c.id}.md`);
    fs.mkdirSync(path.dirname(file), {recursive: true});
    fs.writeFileSync(file, conceptToFileContent(c), 'utf8');
  }
  console.log(`Wrote ${concepts.length} concept(s) to ${BUNDLE_DIR}/.`);
  return 0;
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
  const body =
    typeof overview?.data?.['content'] === 'string'
      ? (overview.data['content'] as string)
      : '';

  const residue = buildResidue(entry, OVERVIEW_ASPECT_KEY);
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
