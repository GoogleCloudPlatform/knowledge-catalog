// Catalog fields OKF has no key for stored in the `x-kcmd` frontmatter block

import * as gcp from '../gcp';
import {EXTRA_KEY, RESIDUE_KEY} from './concept';

export const RESIDUE_VERSION = 1;

export const OVERVIEW_ASPECT_KEY = 'dataplex-types.global.overview';
export const DOCUMENT_ASPECT_KEY = 'dataplex-types.global.document';
export const QUERY_TEMPLATE_ASPECT_KEY =
  'dataplex-types.global.query-template';
export const DEFAULT_DOCUMENT_ENTRY_TYPE =
  'projects/dataplex-types/locations/global/entryTypes/document';
export const QUERY_TEMPLATE_ENTRY_TYPE =
  'projects/dataplex-types/locations/global/entryTypes/query-template';

export class ResidueError extends Error {}

const NATIVE_KEYS: readonly string[] = [
  'type',
  'title',
  'description',
  'resource',
  'tags',
  'status',
  'stale_after',
  'generated',
  'verified',
  'sources',
  'usage_window',
];

const NATIVE_PATHS: ReadonlyArray<[string, string]> = [
  ['entrySource.displayName', 'title'],
  ['entrySource.description', 'description'],
  ['entrySource.resource', 'resource'],
];

/** The aspect whose `type` field becomes the concept's OKF `type`. */
export function typeFacetKey(entryType?: string): string | undefined {
  const short = entryType?.split('/').pop();
  return short ? `dataplex-types.global.${short}` : undefined;
}

function liftedType(data: Record<string, unknown> | undefined): boolean {
  return typeof data?.['type'] === 'string' && data['type'] !== '';
}

/** Collects what OKF cannot express. Undefined when there is nothing. */
export function buildResidue(
  entry: gcp.Entry,
  overviewAspectKey: string,
  body?: string,
): Record<string, unknown> | undefined {
  const residue: Record<string, unknown> = {};

  if (entry.entryType) residue['entryType'] = entry.entryType;
  if (entry.parentEntry) residue['parentEntry'] = entry.parentEntry;

  const source = entry.entrySource ?? {};
  const carried: Record<string, unknown> = {};
  if (source.system) carried['system'] = source.system;
  if (source.platform) carried['platform'] = source.platform;
  if (source.ancestors?.length) carried['ancestors'] = source.ancestors;
  if (source.labels && Object.keys(source.labels).length) {
    carried['labels'] = source.labels;
  }
  if (Object.keys(carried).length) residue['entrySource'] = carried;

  // An OKF file always ends in a newline, so a body that does not must say so.
  // This is the body as written to disk, after any trailing section is split
  // off, since that is what push has to reconstruct.
  const content = body ?? entry.aspects?.[overviewAspectKey]?.data?.['content'];
  if (typeof content === 'string' && content && !content.endsWith('\n')) {
    residue['trailingNewline'] = false;
  }

  const facetKey = typeFacetKey(entry.entryType);
  const aspects: Record<string, unknown> = {};
  for (const [key, aspect] of Object.entries(entry.aspects ?? {})) {
    if (key === overviewAspectKey) continue;
    if (key === facetKey && liftedType(aspect.data)) {
      const {type, ...rest} = aspect.data as Record<string, unknown>;
      aspects[key] = rest;
      continue;
    }
    aspects[key] = aspect.data;
  }
  if (Object.keys(aspects).length) residue['aspects'] = aspects;

  if (!Object.keys(residue).length) return undefined;
  return {v: RESIDUE_VERSION, ...residue};
}

function at(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function assertResidueOnly(frontmatter: Record<string, unknown>): void {
  const rawExtra = frontmatter[EXTRA_KEY];
  if (
    rawExtra !== undefined &&
    rawExtra !== null &&
    (typeof rawExtra !== 'object' || Array.isArray(rawExtra))
  ) {
    throw new ResidueError(`${EXTRA_KEY} must be a mapping`);
  }
  const raw = frontmatter[RESIDUE_KEY];
  if (raw === undefined || raw === null) return;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ResidueError(`${RESIDUE_KEY} must be a mapping`);
  }
  const residue = raw as Record<string, unknown>;

  const found: string[] = [];
  for (const key of NATIVE_KEYS) {
    if (residue[key] !== undefined)
      found.push(`${RESIDUE_KEY}.${key} (${key})`);
  }
  for (const [dotted, native] of NATIVE_PATHS) {
    if (at(residue, dotted) !== undefined) {
      found.push(`${RESIDUE_KEY}.${dotted} (${native})`);
    }
  }
  const entryType = residue['entryType'];
  const facetKey = typeFacetKey(
    typeof entryType === 'string' ? entryType : undefined,
  );
  const facet = facetKey
    ? (at(residue, 'aspects') as Record<string, unknown>)?.[facetKey]
    : undefined;
  if (facet && typeof facet === 'object' &&
      (facet as Record<string, unknown>)['type'] !== undefined) {
    found.push(`${RESIDUE_KEY}.aspects.${facetKey}.type (type)`);
  }
  if (found.length) {
    throw new ResidueError(
      `residue duplicates native keys: ${found.join(', ')}`,
    );
  }
}
