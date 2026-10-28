// Helpers for reading and rewriting entity-qualified SQL expressions across the
// semantic-model layer.
//
// Expressions reference columns as `<Entity>.<column>`. The SQL parser
// (`columnReferences`, `entitiesReached`, `fieldsReadOn`) reads column and
// entity references across dialects for the loader, validator, profile checks,
// pull reader, and transpiler. The graph generators read them with the parser
// too: `measureEntities` places a measure, `singleAggregate` finds its
// aggregate, and `withoutQualifier` makes an expression table-local.
//

import {Field, fieldBinding} from './ir';
import {SqlColumn, sqlColumns, sqlExpressionTree, SqlToken, sqlTokens, withoutComments} from './sql_parser';

// The dialect a graph generator reads `dialect` in: an ANSI_SQL text, or a
// text with no dialect, is read as BigQuery.
function graphReading(dialect?: string): string {
  return !dialect || dialect === 'ANSI_SQL' ? 'BIGQUERY' : dialect;
}

// Each `<name>.` qualifier that `expression`, read in `dialect`, writes before
// a column, for a name in `names`, as indexes into the text's tokens, in the
// order written. A name matches case-sensitively, bare or quoted as the
// dialect quotes an identifier, and not after a dot, so the second `orders` in
// the struct path `orders.orders.id` is not one. The SQL parser decides which
// candidates are qualifiers, so a string literal, a comment or a function
// namespace such as `NET.` in `NET.HOST(orders.url)` holds none. The parser
// reads each candidate as a placeholder name, so one it reserves as a keyword,
// such as `Date` in `Date.days`, still reads as a qualifier. When the parser
// cannot read the text even so, every candidate is taken as a qualifier.
// Undefined when the engine cannot tokenize the text.
function qualifiersIn(
    expression: string, names: ReadonlySet<string>,
    dialect: string): {tokens: SqlToken[]; at: number[]}|undefined {
  const tokens = sqlTokens(expression, dialect);
  if (!tokens) return undefined;
  const chars = Array.from(expression);
  const asWritten = (t: SqlToken) =>
      chars.slice(t.span.start, t.span.end).join('');
  const candidates: number[] = [];
  tokens.forEach((t, i) => {
    if (names.has(t.text) && tokens[i + 1]?.token_type === 'DOT' &&
        tokens[i - 1]?.token_type !== 'DOT' &&
        (t.token_type === 'QUOTED_IDENTIFIER' || asWritten(t) === t.text)) {
      candidates.push(i);
    }
  });
  if (!candidates.length) return {tokens, at: []};
  // A placeholder stem the text does not hold.
  let stem = 'kcmd_qualifier_';
  while (expression.toLowerCase().includes(stem)) stem += '_';
  let text = '';
  let end = 0;
  candidates.forEach((i, k) => {
    text += chars.slice(end, tokens[i].span.start).join('') + stem + k;
    end = tokens[i].span.end;
  });
  text += chars.slice(end).join('');
  const columns = columnReferences(text, dialect);
  const at = !columns ? candidates : candidates.filter(
      (_, k) => columns.some(c => c.qualifier?.toLowerCase() === stem + k));
  return {tokens, at};
}

// `expression` without each `<qualifier>.` it writes before a column (see
// qualifiersIn), so it reads the columns of the qualifier's own table. The
// rest of the text stays as written. The text is read in `dialect`; an
// ANSI_SQL text, or one with no dialect, is read as BigQuery, as the graph
// generators read it. Returns `expression` itself when it writes no such
// qualifier or the engine cannot tokenize it.
export function withoutQualifier(
    expression: string, qualifier: string, dialect?: string): string {
  const read =
      qualifiersIn(expression, new Set([qualifier]), graphReading(dialect));
  if (!read?.at.length) return expression;
  const {tokens, at} = read;
  const chars = Array.from(expression);
  let out = '';
  let end = 0;
  for (const i of at) {
    out += chars.slice(end, tokens[i].span.start).join('');
    // The qualifier, its dot, and what lies between the dot and the column.
    end = tokens[i + 2]?.span.start ?? tokens[i + 1].span.end;
  }
  return out + chars.slice(end).join('');
}

// The entities from `entityNames` whose qualifier a metric's BigQuery SQL
// `expression` writes before a column (see qualifiersIn), deduplicated in the
// order written, or else `entity`, the metric's anchor, when given. The
// BigQuery generator places the metric's measure on the entity this gives
// when it gives one, and a BigQuery push rejects a metric it gives several or
// none for (see validate.ts).
export function measureEntities(
    expression: string, entityNames: ReadonlyArray<string>,
    entity?: string): string[] {
  const read = qualifiersIn(expression, new Set(entityNames), 'BIGQUERY');
  const reached = [...new Set(read?.at.map(i => read.tokens[i].text) ?? [])];
  return reached.length || !entity ? reached : [entity];
}

// `text`, written in `dialect`, with its comments removed. An ANSI_SQL text, or
// a text with no dialect, is read as BigQuery, as the loader and the graph
// generators read it.
export function sqlWithoutComments(text: string, dialect?: string): string {
  return withoutComments(text, graphReading(dialect));
}

// `field`'s binding, as fieldBinding gives it, with its comments removed.
// Undefined when the field is unbound. The target text is read in
// `targetDialect`, BigQuery unless given. The parser reads Spanner SQL as
// BigQuery. Imported vendor SQL, the binding only when there is no target
// text, is read in its imported dialect, so it keeps what that dialect does
// not read as a comment.
export function fieldBindingWithoutComments(
    field: Pick<Field, 'expression'|'importedExpression'|'importedDialect'>,
    targetDialect?: string): string|undefined {
  const text = fieldBinding(field);
  if (text === undefined) return undefined;
  return sqlWithoutComments(
      text,
      field.expression === undefined ? field.importedDialect : targetDialect);
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

// The aggregates BigQuery accepts in a MEASURE, its complete list. BigQuery
// rejects any other there, such as COUNTIF or APPROX_COUNT_DISTINCT.
export const SUPPORTED_AGGREGATES = ['SUM', 'AVG', 'COUNT', 'MIN', 'MAX'];

// When `expression`, read in `dialect`, is one of SUPPORTED_AGGREGATES over
// one operand, or COUNT(*), with at most DISTINCT or ALL, and the operand holds
// no other aggregate, window or subquery: the function's name as written, the
// operand as written without the parentheses around it (so
// `COUNT(DISTINCT(x))` gives `x`), and whether the call is DISTINCT. COUNT(*)
// gives the operand `*`. Undefined otherwise.
export function singleAggregate(expression: string, dialect: string):
    {fn: string; operand: string; distinct: boolean}|undefined {
  const node = unwrapped(sqlExpressionTree(expression, dialect));
  const kind = node && Object.keys(node).length === 1 ? Object.keys(node)[0] :
                                                        undefined;
  if (!kind || !SUPPORTED_AGGREGATES.includes(kind.toUpperCase())) {
    return undefined;
  }
  const call = node[kind];
  const star = kind === 'count' && call.star === true && !call.this;
  const operand = unwrapped(call.this);
  if (!star &&
      (!operand || operand.star || operand.tuple ||
       nestsAggregateOrSubquery(operand))) {
    return undefined;
  }
  // The parser keeps the call's name in `name` or `original_name`.
  const known = new Set(['this', 'star', 'distinct', 'name', 'original_name']);
  if (!Object.entries(call).every(
          ([key, v]) => known.has(key) || v === null || v === undefined ||
              v === false || (Array.isArray(v) && v.length === 0))) {
    return undefined;
  }
  // The call as written: its name, `(`, DISTINCT or ALL if written, the
  // operand and `)`, inside any parentheses around the whole call.
  const tokens = unparenthesized(sqlTokens(expression, dialect) ?? []);
  if (tokens.length < 4 || tokens[1].token_type !== 'L_PAREN' ||
      tokens[tokens.length - 1].token_type !== 'R_PAREN') {
    return undefined;
  }
  let inner = tokens.slice(2, -1);
  if (inner[0]?.token_type === 'DISTINCT' || inner[0]?.token_type === 'ALL') {
    inner = inner.slice(1);
  }
  inner = unparenthesized(inner);
  if (!inner.length) return undefined;
  const chars = Array.from(expression);
  return {
    fn: tokens[0].text,
    operand: chars.slice(inner[0].span.start, inner[inner.length - 1].span.end)
                 .join(''),
    distinct: call.distinct === true,
  };
}

// Whether `expression`, read in `dialect`, is a single aggregate (see
// singleAggregate), the form a BigQuery measure takes.
export function isSingleAggregate(expression: string, dialect: string):
    boolean {
  return singleAggregate(expression, dialect) !== undefined;
}

// `tokens` without the parentheses around all of them.
function unparenthesized(tokens: SqlToken[]): SqlToken[] {
  while (tokens.length >= 2 && tokens[0].token_type === 'L_PAREN') {
    let depth = 0;
    let closesAt = -1;
    for (let i = 0; i < tokens.length && closesAt < 0; i++) {
      if (tokens[i].token_type === 'L_PAREN') depth++;
      if (tokens[i].token_type === 'R_PAREN' && --depth === 0) closesAt = i;
    }
    if (closesAt !== tokens.length - 1) break;
    tokens = tokens.slice(1, -1);
  }
  return tokens;
}

// The parser's tree `node` without the parentheses and comments around it.
function unwrapped(node: any): any {
  while (node?.paren || node?.annotated) {
    node = (node.paren ?? node.annotated).this;
  }
  return node;
}

// Whether the parser's tree `node` holds an aggregate, a window or a subquery
// at any depth. The parser gives an aggregate call `distinct` and `filter`
// keys, or the kind `aggregate_function`.
function nestsAggregateOrSubquery(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(nestsAggregateOrSubquery);
  if (node === null || typeof node !== 'object') return false;
  return Object.entries(node).some(
      ([kind, value]) => kind === 'aggregate_function' ||
          kind === 'window_function' || kind === 'subquery' ||
          kind === 'select' ||
          (value !== null && typeof value === 'object' && 'distinct' in value &&
           'filter' in value) ||
          nestsAggregateOrSubquery(value));
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
