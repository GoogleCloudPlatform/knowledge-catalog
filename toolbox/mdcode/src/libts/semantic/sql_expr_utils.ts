// Helpers for reading and rewriting entity-qualified SQL expressions across the
// semantic-model layer.
//
// Expressions reference columns as `<Entity>.<column>`. The SQL parser
// (`columnReferences`, `entitiesReached`, `fieldsReadOn`) reads column and
// entity references across dialects for the loader, validator, profile checks,
// pull reader, and transpiler. The graph generators still use the literal-
// aware regex helpers (`referencedEntityNames`, `stripQualifier`) until
// b/568183888 moves them to the parser.
//

import {Entity, Field, fieldBinding, keysCoveredBy} from './ir';
import {SqlColumn, sqlColumns, withoutComments} from './sql_parser';
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
// from matching inside a larger identifier (e.g. `customer_orders.`) or after a
// dot in a struct path (e.g. `orders.customer.id`), and the optional backticks
// let it match whether or not the identifier is quoted.
function entityQualifier(name: string, flags = ''): RegExp {
  return new RegExp(`(?<![\\w\`.])\`?${escapeRegExp(name)}\`?\\.`, flags);
}

// Returns the entity names whose `<name>.` qualifier appears in an expression,
// in the order they first appear, ignoring text inside string literals.
// Matching is case-sensitive (the emitter's behavior).
export function referencedEntityNames(
    expression: string, entityNames: string[]): string[] {
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

// `text`, written in `dialect`, with its comments removed. An ANSI_SQL text, or
// a text with no dialect, is read as BigQuery, as the loader and the graph
// generators read it.
export function sqlWithoutComments(text: string, dialect?: string): string {
  return withoutComments(
      text, !dialect || dialect === 'ANSI_SQL' ? 'BIGQUERY' : dialect);
}

// `field`'s binding, as fieldBinding gives it, with its comments removed.
// Undefined when the field is unbound. The target text is read in
// `targetDialect`, BigQuery unless given, which is how the graph generators
// read it. The parser reads Spanner SQL as BigQuery. Imported vendor SQL, the
// binding only when there is no target text, is read in its imported dialect,
// so it keeps what that dialect does not read as a comment.
export function fieldBindingWithoutComments(
    field: Pick<Field, 'expression'|'importedExpression'|'importedDialect'>,
    targetDialect?: string): string|undefined {
  const text = fieldBinding(field);
  if (text === undefined) return undefined;
  return sqlWithoutComments(
      text,
      field.expression === undefined ? field.importedDialect : targetDialect);
}

// The physical column a key or join column names, as the graph generators read
// it: a name that matches one of the entity's fields is that field's column,
// read without its comments, and any other name is a column already. Undefined
// when the name is a field with no column in this binding.
export function keyColumn(
    entity: Pick<Entity, 'name'|'fields'>, name: string): string|undefined {
  const field = entity.fields.find(f => f.name === name);
  if (!field) return name;
  const expr = fieldBindingWithoutComments(field);
  return expr === undefined ? undefined :
                              stripQualifier(expr, entity.name).trim();
}

// Which keys `toColumns` cover once every name is read as its column (see
// keysCoveredBy), or undefined when that cannot be told yet: a join column or
// a key column names a field with no column in this binding.
export function keysCoveredByColumns(
    entity: Pick<Entity, 'name'|'fields'>, toColumns: string[],
    primaryKey: string[], uniqueKeys: string[][]): string[]|undefined {
  const col = (name: string) => keyColumn(entity, name);
  const to = toColumns.map(col);
  if (to.some(c => c === undefined)) return undefined;
  const keys = [primaryKey, ...uniqueKeys].map(k => k.map(col));
  if (keys.some(k => k.some(c => c === undefined))) return undefined;
  return keysCoveredBy(
      to as string[], keys[0] as string[], keys.slice(1) as string[][]);
}

// Results of columnReferences by dialect and text, so the checks one push
// runs read each text once. When full, the oldest entry goes.
const MAX_COLUMN_CACHE_SIZE = 65536;
const COLUMN_CACHE = new Map<string, ReadonlyArray<SqlColumn>|undefined>();

// Every column an expression reads, with the qualifier written before it, in
// the order written, or undefined when the SQL parser cannot read the
// expression in `dialect`, one of the dialect names a dialect list uses. The
// parser handles string literals, comments and each dialect's quoting, so
// `"orders"."amount"` in a PostgreSQL text reads the column `amount` of
// `orders`, while in BigQuery the same text is not SQL and gives undefined. A struct path reads
// as its first two parts: `orders.shipping_address.city` reads
// `shipping_address` of `orders`.
export function columnReferences(expression: string, dialect: string):
    ReadonlyArray<SqlColumn>|undefined {
  const key = `${dialect.toUpperCase()}\0${expression}`;
  if (COLUMN_CACHE.has(key)) return COLUMN_CACHE.get(key);
  const cols = sqlColumns(expression, dialect);
  if (COLUMN_CACHE.size >= MAX_COLUMN_CACHE_SIZE) {
    COLUMN_CACHE.delete(COLUMN_CACHE.keys().next().value!);
  }
  COLUMN_CACHE.set(key, cols);
  return cols;
}

// Reads the columns of `text` in `dialect`. An `ANSI_SQL` text is read in the
// dialect the model's sources imply (`impliedDialect`), since the database runs
// an `ANSI_SQL` entry as its own SQL. When the sources do not imply a single
// dialect, the generic parser reads the text, and any bare identifier that
// BigQuery's parser does not also read as a bare column (such as a `MONTH`
// date part or a double-quoted string literal) is filtered out.
export function columnsForSource(
    text: string, dialect: string,
    impliedDialect?: string): ReadonlyArray<SqlColumn>|undefined {
  if (dialect === 'ANSI_SQL' && impliedDialect) {
    return columnReferences(text, impliedDialect);
  }
  const cols = columnReferences(text, dialect);
  if (!cols || dialect !== 'ANSI_SQL') return cols;
  const bqCols = columnReferences(text, 'BIGQUERY');
  if (!bqCols) return cols;
  const bqBare =
      new Set(bqCols.filter(c => c.qualifier === undefined).map(c => c.name));
  return cols.filter(c => c.qualifier !== undefined || bqBare.has(c.name));
}

// The entities from `entityNames` that `columns` read, deduplicated in
// first-seen order. Matching is case-sensitive.
export function entitiesReached(
    columns: ReadonlyArray<SqlColumn>,
    entityNames: ReadonlyArray<string>|ReadonlySet<string>): string[] {
  const known =
      entityNames instanceof Set ? entityNames : new Set(entityNames);
  const reached: string[] = [];
  for (const c of columns) {
    if (c.qualifier && known.has(c.qualifier) &&
        !reached.includes(c.qualifier)) {
      reached.push(c.qualifier);
    }
  }
  return reached;
}

// The fields `columns` read on `entityName`, written `entityName.field`,
// deduplicated in first-seen order. Matching is case-sensitive.
export function fieldsReadOn(
    columns: ReadonlyArray<SqlColumn>, entityName: string):
    string[] {
  const fields: string[] = [];
  for (const c of columns) {
    if (c.qualifier === entityName && !fields.includes(c.name)) {
      fields.push(c.name);
    }
  }
  return fields;
}

// Whether a key or join column is a physical column name rather than an
// expression. A value that starts and ends with a backtick, with none between,
// passes whatever it holds. An unquoted value may not contain whitespace,
// parentheses, a dot, a comma, a backtick or a SQL operator. Nothing else about
// the character set is checked; the database rejects a bad name.
export function isColumnName(value: unknown): boolean {
  return typeof value === 'string' &&
      (/^`[^`]+`$/.test(value) || /^[^\s().+\-*/%=<>!|&^~,`]+$/.test(value));
}
