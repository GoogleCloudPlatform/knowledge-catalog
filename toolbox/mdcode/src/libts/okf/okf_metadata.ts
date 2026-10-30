// OKF frontmatter keys the catalog has no field for, carried in a trailing
// section of the overview body so a push does not drop them.

import * as yaml from 'yaml';

const HEADING = '## OKF Metadata';
const OPEN = '```yaml';
const CLOSE = '```';
const MARKER = `\n\n${HEADING}\n\n${OPEN}\n`;

export const OKF_METADATA_KEYS: readonly string[] = [
  'tags',
  'status',
  'stale_after',
  'generated',
  'verified',
  'sources',
  'usage_window',
];

/** Appends the section. The body is returned unchanged when there is none. */
export function appendOkfMetadata(
  body: string,
  frontmatter: Record<string, unknown>,
): string {
  const carried: Record<string, unknown> = {};
  for (const key of OKF_METADATA_KEYS) {
    if (frontmatter[key] !== undefined) carried[key] = frontmatter[key];
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
