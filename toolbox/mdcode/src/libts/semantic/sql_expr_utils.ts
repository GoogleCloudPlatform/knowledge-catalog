// Literal-aware helpers for the entity-qualified SQL expressions used across the
// semantic-model layer.
//
// Expressions reference columns as `<Entity>.<column>`. Detecting and stripping
// those qualifiers must ignore text inside string literals, so a value such as
// 'orders.note' is treated as data, not as a reference to the `orders` entity.
// Both the loader (metric-entity inference) and the BigQuery generator (measure
// placement / qualifier stripping) share this one implementation.
//

// Matches a single- or double-quoted SQL string literal, honoring backslash
// escapes. (Triple-quoted / raw literals are uncommon in these expressions and
// are treated as ordinary text.)
export const STRING_LITERAL = /'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g;

// Escapes a string so it can be embedded literally in a RegExp.
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Replaces string-literal contents with blanks of equal length, so scanning sees
// literal-free text without shifting any offsets.
export function blankStringLiterals(expression: string): string {
  return expression.replace(STRING_LITERAL, m => ' '.repeat(m.length));
}

// Applies `fn` only to the parts of `expression` that lie outside string
// literals, leaving each literal verbatim.
export function mapOutsideStringLiterals(
    expression: string, fn: (segment: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of expression.matchAll(STRING_LITERAL)) {
    out += fn(expression.slice(last, m.index));
    out += m[0];
    last = m.index! + m[0].length;
  }
  out += fn(expression.slice(last));
  return out;
}

// Builds a regex matching an `<entity>.` qualifier, including the BigQuery
// backtick-quoted form (`` `entity`. ``). A negative lookbehind keeps the name
// from matching inside a larger identifier (e.g. `customer_orders.`), and the
// optional backticks let it match whether or not the identifier is quoted.
function entityQualifier(name: string, flags = ''): RegExp {
  return new RegExp(`(?<![\\w\`])\`?${escapeRegExp(name)}\`?\\.`, flags);
}

// Returns the entity names whose `<name>.` qualifier appears in an expression, in
// the order they first appear, ignoring text inside string literals.
export function referencedEntityNames(expression: string, entityNames: string[]): string[] {
  const scannable = blankStringLiterals(expression);
  const hits: Array<{ name: string; at: number }> = [];
  for (const name of entityNames) {
    const m = entityQualifier(name).exec(scannable);
    if (m) hits.push({ name, at: m.index });
  }
  return hits.sort((a, b) => a.at - b.at).map(h => h.name);
}

// Removes the `<entity>.` qualifier (bare or backtick-quoted) so an expression
// references table-local columns, without touching text inside string literals.
export function stripQualifier(expression: string, entity: string): string {
  const re = entityQualifier(entity, 'g');
  return mapOutsideStringLiterals(expression, seg => seg.replace(re, ''));
}
