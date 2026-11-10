// Helpers for reading and rewriting entity-qualified SQL expressions across the
// semantic-model layer.
//
// An expression names a field of its entity as `<Entity>.<field>`, and a
// column of its table without a qualifier. The SQL parser
// (`columnReferences`, `entitiesReached`, `fieldsReadOn`) reads column and
// entity references across dialects for the loader, validator, profile checks,
// pull reader, and transpiler. The graph generators read them with the parser
// too: `measureEntities` places a measure, `measureAggregates` finds its
// aggregates, `withoutQualifier` makes an expression table-local,
// `qualifiedColumns` finds the sibling fields it names and
// `withSiblingsSpliced` puts their SQL in their place, and `requalified` moves
// an inherited expression onto the entity inheriting it.
//

import {Field, fieldBinding} from './ir';
import {quoteIfReserved} from './sql_identifiers';
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
  const stem = unusedName(expression, 'kcmd_qualifier_');
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

// `base`, a lowercase name, with underscores added until `text` does not hold
// it in any case.
export function unusedName(text: string, base: string): string {
  let name = base;
  while (text.toLowerCase().includes(name)) name += '_';
  return name;
}

// `expression` without each `<qualifier>.` it writes before a column (see
// qualifiersIn), so it reads the columns of the qualifier's own table. The
// rest of the text stays as written. The text is read in `dialect`; an
// ANSI_SQL text, or one with no dialect, is read as BigQuery, as the graph
// generators read it. Returns `expression` itself when it writes no such
// qualifier or the engine cannot tokenize it.
export function withoutQualifier(
    expression: string, qualifier: string, dialect?: string): string {
  return spliced(expression, qualifier, graphReading(dialect), new Map());
}

// `expression`, BigQuery SQL on `qualifier`'s table, as withoutQualifier gives
// it, except that each `<qualifier>.<field>` whose field `siblings` holds is
// replaced, whole, by the SQL it maps to, as given. The graph generators put
// the SQL of each sibling field an expression names in its place so (see
// graph_ddl.fieldSql).
export function withSiblingsSpliced(
    expression: string, qualifier: string,
    siblings: ReadonlyMap<string, string>): string {
  return spliced(expression, qualifier, 'BIGQUERY', siblings);
}

// `expression`, read in `dialect`, without each `<qualifier>.` it writes
// before a column (see qualifiersIn), and with each `<qualifier>.<column>`
// whose column `replacements` holds replaced, whole, by the SQL it maps to.
function spliced(
    expression: string, qualifier: string, dialect: string,
    replacements: ReadonlyMap<string, string>): string {
  const read = qualifiersIn(expression, new Set([qualifier]), dialect);
  if (!read?.at.length) return expression;
  const {tokens, at} = read;
  const chars = Array.from(expression);
  let out = '';
  let end = 0;
  for (const i of at) {
    out += chars.slice(end, tokens[i].span.start).join('');
    const column = tokens[i + 2];
    const replacement = column && replacements.get(nameOf(column, chars));
    if (replacement !== undefined) {
      out += replacement;
      end = column.span.end;
    } else {
      // The qualifier, its dot, and what lies between the dot and the column.
      end = column?.span.start ?? tokens[i + 1].span.end;
    }
  }
  return out + chars.slice(end).join('');
}

// The column written after each `<qualifier>.` that `expression` writes before
// a column (see qualifiersIn), without its quotes, in the order written, so
// ``orders.a + `orders`.`b`.c`` gives `a` and `b`. The text is read in
// `dialect`, as withoutQualifier reads it, so a qualifier the parser reserves,
// such as `Date` in `Date.days`, gives its column too. Undefined when the
// engine cannot tokenize the text.
export function qualifiedColumns(
    expression: string, qualifier: string, dialect?: string): string[]|
    undefined {
  const read =
      qualifiersIn(expression, new Set([qualifier]), graphReading(dialect));
  if (!read) return undefined;
  const chars = Array.from(expression);
  return read.at.filter(i => read.tokens[i + 2])
      .map(i => nameOf(read.tokens[i + 2], chars));
}

// The name token `t` of the text whose characters are `chars` gives, as
// written, without its quotes.
function nameOf(t: SqlToken, chars: string[]): string {
  return t.token_type === 'QUOTED_IDENTIFIER' ?
      t.text :
      chars.slice(t.span.start, t.span.end).join('');
}

// The error for a field of `owner` that names itself. `cycle` starts at that
// field and runs through the fields it names back to it, and `where` follows
// the field's name, as ` in model 'm' (doc)` does. The graph renders a field
// that names a sibling field from that sibling's own SQL (see
// graph_ddl.fieldSql), so a field that reaches itself has none.
export function selfReferenceMessage(
    owner: string, cycle: string[], where = ''): string {
  const [field, ...through] = cycle;
  return `field '${owner}.${field}'${where} names itself` +
      (through.length ?
           ` through ${through.map(n => `'${owner}.${n}'`).join(', ')}` :
           '') +
      `; a field expression may name other fields of its entity, but not ` +
      `itself, directly or through other fields` +
      (through.length ? '' :
                        `; to read the column of that name, write it ` +
               `without the qualifier: '${quoteIfReserved(field)}'`);
}

// `expression` with each `<from>.` qualifier it writes before a column (see
// qualifiersIn) renamed `<to>.`, quoted as it was written. The rest of the
// text stays as written. The text is read in `dialect`, as withoutQualifier
// reads it. Returns `expression` itself when it writes no such qualifier or
// the engine cannot tokenize it.
export function requalified(
    expression: string, from: string, to: string, dialect?: string): string {
  const read = qualifiersIn(expression, new Set([from]), graphReading(dialect));
  if (!read?.at.length) return expression;
  const {tokens, at} = read;
  const chars = Array.from(expression);
  let out = '';
  let end = 0;
  for (const i of at) {
    const {start, end: after} = tokens[i].span;
    out += chars.slice(end, start).join('') +
        chars.slice(start, after).join('').replace(from, () => to);
    end = after;
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
// date part or a double-quoted string literal) is filtered out. When their
// dialect is null, which no lookup read, an `ANSI_SQL` text is not read.
export function columnsForSource(
    text: string, dialect: string,
    impliedDialect?: string|null): ReadonlyArray<SqlColumn>|undefined {
  if (dialect === 'ANSI_SQL' && impliedDialect === null) return undefined;
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
  if (!kind || !isAggregateCall(kind, node[kind]) ||
      aggregateProblem(kind, node[kind])) {
    return undefined;
  }
  // The call as written: its name, `(`, DISTINCT or ALL if written, the
  // operand and `)`, inside any parentheses around the whole call.
  const tokens = unparenthesized(sqlTokens(expression, dialect) ?? []);
  if (tokens.length < 4 ||
      !SUPPORTED_AGGREGATES.includes(tokens[0].text.toUpperCase()) ||
      tokens[1].token_type !== 'L_PAREN' ||
      closingParen(tokens, 1) !== tokens.length - 1) {
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
    distinct: node[kind].distinct === true,
  };
}

// An aggregate a BigQuery measure applies, as measureAggregates gives it:
// where the call is written in the expression, from its name to its `)`, in
// code points with the end exclusive, and the call as singleAggregate reads it.
export interface MeasureAggregate {
  start: number;
  end: number;
  fn: string;
  operand: string;
  distinct: boolean;
}

// `expression` with each of `aggregates` replaced by what `by` gives for it.
export function replacedAggregates(
    expression: string, aggregates: MeasureAggregate[],
    by: (agg: MeasureAggregate, i: number) => string): string {
  const chars = Array.from(expression);
  let text = '';
  let after = 0;
  aggregates.forEach((agg, i) => {
    text += chars.slice(after, agg.start).join('') + by(agg, i);
    after = agg.end;
  });
  return text + chars.slice(after).join('');
}

// The aggregates of `expression`, read in `dialect`, in the order written,
// when it can be a BigQuery measure; else why it cannot, as a clause such as
// `it reads field 'amount' outside an aggregate`. It can be one when it holds
// an aggregate; each aggregate it holds is one singleAggregate reads; no window
// or subquery sits outside them; every field it reads sits inside one; and it
// calls no user-defined function outside them. Arithmetic, CASE, IF and
// BigQuery's other built-in scalar functions, and literals, may surround the
// aggregates, as in `SUM(o.amount) / COUNT(o.id)`. The push checks and the
// BigQuery generator both read a measure so.
export function measureAggregates(expression: string, dialect: string):
    {aggregates: MeasureAggregate[]}|{problem: string} {
  const tree = sqlExpressionTree(expression, dialect);
  const tokens = sqlTokens(expression, dialect);
  if (!tree || !tokens || tokens.some(t => t.token_type === 'SEMICOLON')) {
    return {problem: 'the SQL parser cannot read it as one expression'};
  }
  const {calls, windowOrSubquery} = aggregateCalls(tree);
  if (windowOrSubquery) return {problem: 'it uses a window or a subquery'};
  if (!calls.length) {
    return {
      problem: `it holds no aggregate (${SUPPORTED_AGGREGATES.join(', ')})`
    };
  }
  for (const [kind, call] of calls) {
    const problem = aggregateProblem(kind, call);
    if (problem) return {problem};
  }
  // Where each call is written: the first call, from the left, that
  // singleAggregate reads, then the next one after it. A function in a
  // namespace, such as `ds.SUM`, is not one of the aggregates.
  const chars = Array.from(expression);
  const aggregates: MeasureAggregate[] = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    if (tokens[i + 1].token_type !== 'L_PAREN' ||
        tokens[i - 1]?.token_type === 'DOT') {
      continue;
    }
    const close = closingParen(tokens, i + 1);
    if (close < 0) break;
    const {start} = tokens[i].span;
    const {end} = tokens[close].span;
    const agg = singleAggregate(chars.slice(start, end).join(''), dialect);
    if (!agg) continue;
    aggregates.push({start, end, ...agg});
    i = close;
  }
  if (aggregates.length !== calls.length) {
    return {problem: 'the SQL parser cannot tell where each aggregate is'};
  }
  // The fields read outside the aggregates: those of the text with each
  // aggregate replaced by a literal.
  const rest = replacedAggregates(expression, aggregates, () => ' 0 ');
  const outside = sqlColumns(rest, dialect);
  if (!outside) {
    return {problem: 'the SQL parser cannot read it as one expression'};
  }
  if (outside.length) {
    return {
      problem: `it reads field '${outside[0].name}' outside an aggregate`
    };
  }
  // BigQuery accepts a graph whose measure calls a user-defined function
  // outside its aggregates, but every GRAPH_EXPAND query on that node table
  // then fails with "Function not found". One inside an aggregate's operand
  // becomes a property, so it stays allowed.
  const udf = userDefinedFunction(sqlExpressionTree(rest, dialect));
  if (udf) {
    return {
      problem: `it calls user-defined function '${udf}' outside an ` +
          `aggregate, which BigQuery cannot read in a measure`
    };
  }
  return {aggregates};
}

// The first user-defined function the parser's tree `node` calls, by its
// dotted name, such as `ds.f`, or undefined when it calls none: a call whose
// name has a dot, other than `SAFE.` before one name, as in `SAFE.LOG10`.
// BigQuery reads `ml.f` or `net.f` as the function of a dataset with that
// name. The parser reads `` `p.ds.f`(…) `` as a function of that name, and
// `ds.f(…)` or `p.ds.f(…)` as a method call on a column.
function userDefinedFunction(node: unknown): string|undefined {
  if (node === null || typeof node !== 'object') return undefined;
  for (const [kind, value] of Object.entries(node)) {
    const name = kind === 'function' ? String(value.name) :
        kind === 'method_call' ?
        [...namePath(value.this), value.method?.name].join('.') :
        '';
    const parts = name.split('.');
    if (parts.length > 1 &&
        !(parts.length === 2 && parts[0].toUpperCase() === 'SAFE')) {
      return name;
    }
    const inner = userDefinedFunction(value);
    if (inner) return inner;
  }
  return undefined;
}

// The parts of the dotted name the parser's tree `node` reads, such as
// ['p', 'ds'] for `p.ds`, or none when it reads something else.
function namePath(node: any): string[] {
  if (node?.column) {
    const {table, name} = node.column;
    return table ? [table.name, name.name] : [name.name];
  }
  if (node?.dot) return [...namePath(node.dot.this), node.dot.field.name];
  return [];
}

// Why the parser's aggregate call `call`, of node kind `kind`, cannot be in a
// BigQuery measure, or undefined when it can: when it is one of
// SUPPORTED_AGGREGATES over one operand, or COUNT(*), with at most DISTINCT or
// ALL, and the operand holds no other aggregate, window or subquery.
function aggregateProblem(kind: string, call: any): string|undefined {
  // The parser keeps the call's name in `name` or `original_name`.
  const name = String(call.name ?? call.original_name ?? kind).toUpperCase();
  if (!SUPPORTED_AGGREGATES.includes(name)) {
    return `it uses ${name}, which BigQuery does not allow in a measure (${
        SUPPORTED_AGGREGATES.join(', ')})`;
  }
  // The parser reads an aggregate over several operands, such as
  // `MIN(a, b)`, as a function with arguments, and `COUNT(DISTINCT a, b)` as
  // a count of a tuple.
  const star = kind === 'count' && call.star === true && !call.this;
  const operand = unwrapped(call.this);
  const operands = Array.isArray(call.args) ? call.args.length :
      star                                  ? 1 :
      operand?.tuple                        ? operand.tuple.expressions.length :
                                              operand ? 1 : 0;
  if (operands !== 1) {
    return `it calls ${name} with ${operands} operands, where an aggregate ` +
        `in a measure takes one`;
  }
  if (!star && nestsAggregateOrSubquery(operand)) {
    return 'it nests an aggregate, a window or a subquery';
  }
  const known = new Set(['this', 'star', 'distinct', 'name', 'original_name']);
  if (kind === 'function' || kind === 'aggregate_function' ||
      (!star && operand.star) ||
      !Object.entries(call).every(
          ([key, v]) => known.has(key) || v === null || v === undefined ||
              v === false || (Array.isArray(v) && v.length === 0))) {
    return `it calls ${name} with something other than one operand and ` +
        `DISTINCT or ALL`;
  }
  return undefined;
}

// The outermost aggregate calls in the parser's tree `node`, each as its node
// kind and the call, and whether a window or a subquery sits outside them. A
// call of the name of one of SUPPORTED_AGGREGATES that the parser reads as a
// plain function, such as `MIN(a, b)` or `SAFE.SUM(a)`, counts as one.
function aggregateCalls(node: unknown):
    {calls: Array<[string, any]>; windowOrSubquery: boolean} {
  const found = {calls: [] as Array<[string, any]>, windowOrSubquery: false};
  const visit = (n: unknown): void => {
    if (Array.isArray(n)) return n.forEach(visit);
    if (n === null || typeof n !== 'object') return;
    for (const [kind, value] of Object.entries(n)) {
      if (kind === 'window_function' || kind === 'subquery' ||
          kind === 'select') {
        found.windowOrSubquery = true;
      } else if (
          isAggregateCall(kind, value) ||
          (kind === 'function' &&
           SUPPORTED_AGGREGATES.includes(
               String(value.name).toUpperCase().replace(/^SAFE\./, '')))) {
        found.calls.push([kind, value]);
      } else {
        visit(value);
      }
    }
  };
  visit(node);
  return found;
}

// The index of the `)` that closes the `(` at `open` in `tokens`, or -1.
function closingParen(tokens: SqlToken[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i].token_type === 'L_PAREN') depth++;
    if (tokens[i].token_type === 'R_PAREN' && --depth === 0) return i;
  }
  return -1;
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
// at any depth.
function nestsAggregateOrSubquery(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(nestsAggregateOrSubquery);
  if (node === null || typeof node !== 'object') return false;
  return Object.entries(node).some(
      ([kind, value]) => isAggregateCall(kind, value) ||
          kind === 'window_function' || kind === 'subquery' ||
          kind === 'select' || nestsAggregateOrSubquery(value));
}

// Whether `value`, of node kind `kind` in the parser's tree, is an aggregate
// call. The parser gives an aggregate call `distinct` and `filter` keys, or
// the kind `aggregate_function`.
function isAggregateCall(kind: string, value: any): boolean {
  return kind === 'aggregate_function' ||
      (value !== null && typeof value === 'object' && 'distinct' in value &&
       'filter' in value);
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
