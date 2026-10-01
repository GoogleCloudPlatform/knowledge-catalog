// Literal-aware helpers for the entity-qualified SQL expressions used across the
// semantic-model layer.
//
// Expressions reference columns as `<Entity>.<column>`. Detecting and stripping
// those qualifiers must ignore text inside string literals, so a value such as
// 'orders.note' is treated as data, not as a reference to the `orders` entity.
// Both the loader (metric-entity inference) and the BigQuery generator (measure
// placement / qualifier stripping) share this one implementation.
//

import {isSimpleIdentifier} from './sql_identifiers';

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
// the order they first appear, ignoring text inside string literals. Matching is
// case-sensitive by default (the emitter's behavior); pass `caseInsensitive` to
// detect a qualifier regardless of how it was cased.
export function referencedEntityNames(
    expression: string, entityNames: string[],
    opts: { caseInsensitive?: boolean } = {}): string[] {
  const scannable = blankStringLiterals(expression);
  const flags = opts.caseInsensitive ? 'i' : '';
  const hits: Array<{ name: string; at: number }> = [];
  for (const name of entityNames) {
    const m = entityQualifier(name, flags).exec(scannable);
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

// Rewrites every identifier in `expr` that names a bound field into that
// field's expression (its physical column, or the SQL a profile bound it to),
// parenthesized unless it is a bare identifier so operator precedence holds
// (`a * b` with b bound to `x + y` becomes `a * (x + y)`). Token-aware: string
// literals ('…' / "…", with backslash escapes) are copied verbatim; a
// function name (an identifier followed by `(`) and a qualified member (an
// identifier after `.`, e.g. `t.col` or `s.field`) are left alone; a
// backtick-quoted identifier is rewritten when its content names a field. The
// rewrite is a single pass, so a field bound to another field's name is not
// rewritten twice. An identifier that names no bound field (a raw column, a
// keyword) is untouched.
export function rewriteFieldRefs(
    expr: string, fieldExprs: Map<string, string>): string {
  if (!fieldExprs.size) return expr;
  const sub = (field: string): string|undefined => {
    const bound = fieldExprs.get(field);
    if (bound === undefined) return undefined;
    return isSimpleIdentifier(bound) || /^`[^`]+`$/.test(bound) ? bound :
                                                                   `(${bound})`;
  };
  return scanIdentifiers(expr, tok => sub(tok));
}

// The bare identifiers in `expr` that could name a field, in first-appearance
// order and deduplicated: the same tokens rewriteFieldRefs would consider
// (string literals, function names and `x.y` members excluded; a
// backtick-quoted identifier contributes its content). Keywords are NOT
// filtered here -- the caller decides what counts as a name.
export function referencedIdentifiers(expr: string): string[] {
  const seen = new Set<string>();
  scanIdentifiers(expr, tok => {
    seen.add(tok);
    return undefined;
  });
  return [...seen];
}

// The shared token walk behind rewriteFieldRefs / referencedIdentifiers: calls
// `visit` on each candidate identifier and substitutes its result when defined.
function scanIdentifiers(
    expr: string, visit: (tok: string) => string | undefined): string {
  let out = '';
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    // String literal: copy through the closing quote.
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < expr.length && expr[j] !== c) j += expr[j] === '\\' ? 2 : 1;
      out += expr.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    const prev = out.trimEnd().slice(-1);
    // Backtick-quoted identifier.
    if (c === '`') {
      const j = expr.indexOf('`', i + 1);
      const end = j < 0 ? expr.length : j + 1;
      const tok = expr.slice(i, end);
      const inner = tok.slice(1, j < 0 ? undefined : -1);
      const repl = prev !== '.' && !followedByParen(expr, end) ? visit(inner) :
                                                                 undefined;
      out += repl ?? tok;
      i = end;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < expr.length && /[A-Za-z0-9_]/.test(expr[j])) j++;
      const tok = expr.slice(i, j);
      // A digit run before the identifier (`1e5`) is a number, not a name; an
      // r/b prefix glued to a quote (`r'\d+'`, `b'..'`) is part of a literal.
      const inNumber = /[0-9]/.test(out.slice(-1));
      const literalPrefix =
          /^(r|b|rb|br)$/i.test(tok) && (expr[j] === '\'' || expr[j] === '"');
      const repl = !inNumber && !literalPrefix && prev !== '.' &&
              !followedByParen(expr, j) ?
          visit(tok) :
          undefined;
      out += repl ?? tok;
      i = j;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

// True if the next non-space character at or after `from` is `(` -- i.e. the
// token just read is a function name.
function followedByParen(expr: string, from: number): boolean {
  let k = from;
  while (k < expr.length && /\s/.test(expr[k])) k++;
  return expr[k] === '(';
}
