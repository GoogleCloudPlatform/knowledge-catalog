/**
 * Text helpers and budgets shared by the skill generators.
 *
 * `skills.ts` (the act router) and `skills_query.ts` (the query index) write
 * the same kind of document under the same Agent Skills limits, so the limits
 * and the small Markdown/YAML helpers live here once rather than in each.
 */

/** One file of the generated package, at a path relative to the skill root. */
export interface SkillFile {
  /** Relative to the skill directory, POSIX-separated. `SKILL.md` is first. */
  path: string;
  text: string;
}

// The most a client reads before deciding the skill is relevant.
export const MAX_DESCRIPTION = 1024;
// What the spec recommends a body stay under. Both are advisory in the sense
// that nothing rejects a longer one; what a longer one costs is context, on
// every request, whether or not the skill is used.
export const MAX_BODY_LINES = 500;
export const MAX_BODY_TOKENS = 5000;

// Cut to a length in characters without splitting a surrogate pair -- a lone
// half is not valid UTF-8 and reaches the file as U+FFFD -- and without
// leaving a half-word where a space was close by.
export function truncate(text: string, max: number): string {
  let end = max - 1;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  const cut = text.slice(0, end);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The body of a skill document: everything after the YAML frontmatter. */
export function skillBody(document: string): string {
  return document.replace(/^---\n[\s\S]*?\n---\n/, '');
}

/** The body's size as the budget warnings count it. */
export function bodySize(document: string): {lines: number; tokens: number} {
  const body = skillBody(document);
  // Four characters to the token is the usual rough count. Approximate on
  // purpose: the point is to notice a body that has outgrown the router shape,
  // and being exact about it would mean shipping a tokenizer.
  return {lines: body.split('\n').length, tokens: Math.ceil(body.length / 4)};
}

// The spec's budgets are about what a body costs the agent that loads it, so
// what is measured is the body rather than the file: frontmatter is read at
// startup and is accounted for by its own limits.
export function overBudget(document: string): string[] {
  const {lines, tokens} = bodySize(document);
  const warnings: string[] = [];
  if (lines > MAX_BODY_LINES) {
    warnings.push(`SKILL.md body is ${lines} lines, over the ${
        MAX_BODY_LINES}-line guidance. Move detail into references/.`);
  }
  if (tokens > MAX_BODY_TOKENS) {
    warnings.push(`SKILL.md body is roughly ${tokens} tokens, over the ${
        MAX_BODY_TOKENS}-token guidance. Move detail into references/.`);
  }
  return warnings;
}

/** A YAML double-quoted scalar, on one line, safe for any description. */
export function yamlString(text: string): string {
  return `"${collapse(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Folded YAML and hand-wrapped prose both arrive with newlines in them. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Markdown reads a newline inside a table cell as the end of the row. */
export function cell(text: string): string {
  return collapse(text).replace(/\|/g, '\\|');
}

/** Keeps the author's paragraphs and drops their line wrapping. */
export function paragraph(text: string): string {
  return text.trim().split(/\n\s*\n/).map(collapse).join('\n\n');
}

export function firstLine(text: string): string {
  return collapse(text.split(/\n\s*\n/)[0] ?? '');
}

export function sentenceEnd(text: string): string {
  return !text || /[.!?]$/.test(text) ? text : `${text}.`;
}

/** Joins lines into a document: no runs of blank lines, one trailing newline. */
export function finish(lines: string[]): string {
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}
