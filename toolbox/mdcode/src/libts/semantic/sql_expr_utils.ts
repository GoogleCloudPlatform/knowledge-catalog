// Helpers for reading and rewriting entity-qualified SQL expressions across the
// semantic-model layer.
//
// Expressions reference columns as `<Entity>.<column>`. The SQL parser
// (`columnReferences`, `entitiesReached`, `fieldsReadOn`) reads column and
// entity references across dialects for the loader, validator, profile checks,
// pull reader, and transpiler. The BigQuery generator still uses the literal-
// aware regex helpers (`referencedEntityNames`, `stripQualifier`) until
// b/568183888 moves it to the parser.
//

import {Entity, fieldBinding, keysCoveredBy} from './ir';
import {SqlColumn, sqlColumns} from './sql_parser';

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

// The physical column a key or join column names, as the graph generators read
// it: a name that matches one of the entity's fields is that field's column,
// and any other name is a column already. Undefined when the name is a field
// with no column in this binding.
export function keyColumn(
    entity: Pick<Entity, 'name'|'fields'>, name: string): string|undefined {
  const field = entity.fields.find(f => f.name === name);
  if (!field) return name;
  const expr = fieldBinding(field);
  return expr === undefined ? undefined : stripQualifier(expr, entity.name).trim();
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

// Every column an expression reads, with the qualifier written before it, in
// the order written, or undefined when the SQL parser cannot read the
// expression in `dialect`, one of the dialect names a dialect list uses. The
// parser handles string literals, comments and each dialect's quoting, so
// `"orders"."amount"` in a PostgreSQL text reads the column `amount` of
// `orders`, while in BigQuery the same text is not SQL and gives undefined. A struct path reads
// as its first two parts: `orders.shipping_address.city` reads
// `shipping_address` of `orders`.
export function columnReferences(expression: string, dialect: string):
    SqlColumn[]|undefined {
  return sqlColumns(expression, dialect);
}

// Reads the columns of `text` in `dialect`. An `ANSI_SQL` text is read in the
// dialect the model's sources imply (`impliedDialect`), since the database runs
// an `ANSI_SQL` entry as its own SQL. When the sources do not imply a single
// dialect, the generic parser reads the text, and any bare identifier that
// BigQuery's parser does not also read as a bare column (such as a `MONTH`
// date part or a double-quoted string literal) is filtered out.
export function columnsForSource(
    text: string, dialect: string,
    impliedDialect?: string): SqlColumn[]|undefined {
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
export function fieldsReadOn(columns: SqlColumn[], entityName: string):
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
