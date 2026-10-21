// Catalog fields OKF has no key for stored in the `x-kcmd` frontmatter block

import * as gcp from '../gcp';
import {RESIDUE_KEY} from './concept';

export const RESIDUE_VERSION = 1;

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

/** Collects what OKF cannot express. Undefined when there is nothing. */
export function buildResidue(
  entry: gcp.Entry,
  overviewAspectKey: string,
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

  const aspects: Record<string, unknown> = {};
  for (const [key, aspect] of Object.entries(entry.aspects ?? {})) {
    if (key === overviewAspectKey) continue;
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
  if (found.length) {
    throw new ResidueError(
      `residue duplicates native keys: ${found.join(', ')}`,
    );
  }
}
