// OKF frontmatter keys the catalog has no field for, carried in a trailing
// section of the overview body so a push does not drop them.

import * as yaml from 'yaml';

import {
  ENTRY_SOURCE_KEYS,
  EXTRA_KEY,
  OKF_METADATA_KEYS,
  RESIDUE_KEY,
} from './concept';

export {OKF_METADATA_KEYS};

const HEADING = '## OKF Metadata';
const OPEN = '```yaml';
const CLOSE = '```';
const MARKER = `\n\n${HEADING}\n\n${OPEN}\n`;

// Frontmatter keys stored natively on the catalog entry or in kcmd residue/links,
// so they are not duplicated into the trailing `## OKF Metadata` block.
const NON_CARRIED_KEYS = new Set<string>([
  'type',
  ...ENTRY_SOURCE_KEYS,
  RESIDUE_KEY,
  EXTRA_KEY,
  'links',
]);

/** Appends the section. The body is returned unchanged when there is none. */
export function appendOkfMetadata(
  body: string,
  frontmatter: Record<string, unknown>,
): string {
  const carried: Record<string, unknown> = {};
  for (const key of OKF_METADATA_KEYS) {
    if (frontmatter[key] !== undefined) carried[key] = frontmatter[key];
  }
  // Preserve producer-defined additional frontmatter keys (OKF v0.2 §4.1) across
  // push -> pull.
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || key in carried || NON_CARRIED_KEYS.has(key)) {
      continue;
    }
    carried[key] = value;
  }
  if (!Object.keys(carried).length) return body;

  const block = yaml.stringify(carried);
  return `${body.replace(/\n*$/, '')}${MARKER}${block}${CLOSE}\n`;
}

/**
 * Splits a trailing section back off the overview body. Only a well-formed
 * section at the very end counts, so a page that discusses one is left alone.
 */
export function splitOkfMetadata(content: string): {
  body: string;
  metadata: Record<string, unknown>;
} {
  const at = content.lastIndexOf(MARKER);
  if (at === -1) return {body: content, metadata: {}};

  const inner = content.slice(at + MARKER.length);
  if (!inner.endsWith(`${CLOSE}\n`)) return {body: content, metadata: {}};

  let parsed: unknown;
  try {
    parsed = yaml.parse(inner.slice(0, -(CLOSE.length + 1)));
  } catch {
    return {body: content, metadata: {}};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {body: content, metadata: {}};
  }

  return {body: content.slice(0, at), metadata: parsed as Record<string, unknown>};
}
