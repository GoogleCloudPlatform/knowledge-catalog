// An OKF concept: one markdown file with a YAML frontmatter block

import * as yaml from 'yaml';

/** One concept. The `id` is its path in the bundle, without `.md`. */
export interface Concept {
  id: string;
  frontmatter: Record<string, unknown>;
  body: string;
}

export const RESIDUE_KEY = 'x-kcmd';
export const EXTRA_KEY = 'extra';

export const ENTRY_SOURCE_KEYS = ['title', 'description', 'resource'] as const;

export const OKF_METADATA_KEYS = [
  'tags',
  'status',
  'stale_after',
  'generated',
  'verified',
  'sources',
  'usage_window',
] as const;

// Anything not listed keeps its insertion order and follows (SPEC §4.1).
export const KEY_ORDER: readonly string[] = [
  'type',
  ...ENTRY_SOURCE_KEYS,
  ...OKF_METADATA_KEYS,
];

export function fileContentToConcept(text: string, id: string): Concept {
  const lines = text.split(/\r?\n/);
  const end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (end === -1) {
    return {id, frontmatter: {}, body: text};
  }

  let parsed: unknown;
  try {
    parsed = yaml.parse(lines.slice(1, end).join('\n'));
  } catch (e) {
    throw new Error(
      `${id}.md: invalid frontmatter: ${e instanceof Error ? e.message : e}`,
    );
  }
  const frontmatter =
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};

  return {id, frontmatter, body: lines.slice(end + 1).join('\n')};
}

/** Renders a concept back into file content. */
export function conceptToFileContent(concept: Concept): string {
  const {frontmatter, body} = concept;
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    if (key in frontmatter && frontmatter[key] !== undefined) {
      ordered[key] = frontmatter[key];
    }
  }
  for (const [key, value] of Object.entries(frontmatter)) {
    if (
      key === RESIDUE_KEY ||
      key === EXTRA_KEY ||
      key in ordered ||
      value === undefined
    ) {
      continue;
    }
    ordered[key] = value;
  }
  if (frontmatter[EXTRA_KEY] !== undefined) {
    ordered[EXTRA_KEY] = frontmatter[EXTRA_KEY];
  }
  if (frontmatter[RESIDUE_KEY] !== undefined) {
    ordered[RESIDUE_KEY] = frontmatter[RESIDUE_KEY];
  }

  const block = yaml.stringify(ordered).trimEnd();
  const text = body.endsWith('\n') || body === '' ? body : `${body}\n`;
  return `---\n${block}\n---\n${text}`;
}
