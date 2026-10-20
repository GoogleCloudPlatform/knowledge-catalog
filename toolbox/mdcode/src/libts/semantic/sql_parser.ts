// The SQL engine kcmd reads and translates expressions with: the
// @polyglot-sql/sdk Rust/WASM engine, bundled into the tool.
//
// Loading the engine is asynchronous and happens once per process, through
// `loadSqlEngine`. Parsing is synchronous after that, so the validators that
// read expressions stay synchronous: a command that runs them loads the engine
// first, and so does a test.

import {readFileSync} from 'node:fs';

// The subset of the @polyglot-sql/sdk `/manual` surface kcmd uses. Declared
// locally because the package's `/manual` subpath does not re-export its named
// bindings through tsc under this project's CommonJS/nodenext setting; the
// dynamic import is cast to this shape.
export interface PolyglotEngine {
  init(opts: {wasmUrl: string}): Promise<void>;
  transpile(sql: string, read: string, write: string):
      {success: boolean; sql?: string[]; error?: string};
  parse(sql: string, dialect: string):
      {success: boolean; ast?: unknown[]; error?: string};
  tokenize(sql: string, dialect: string):
      {success: boolean; tokens?: SqlToken[]; error?: string};
}

// A token the engine reads, as the engine returns it. `span` counts Unicode
// code points from the start of the text, end exclusive. The comments the
// tokenizer skipped are attached to the token after them or before them.
interface SqlToken {
  text: string;
  span: {start: number; end: number};
  comments: string[];
  trailing_comments: string[];
}

// The engine, initialized once and shared process-wide. The Rust/WASM blob is
// embedded into the standalone binary via bun's `import(... , {with: {type:
// 'file'}})` (statically analyzable, so bundled) and handed to `init()` as
// bytes -- the package's default loader reads the blob from disk at runtime,
// which fails inside a `bun --compile` binary, so we use the `/manual` entry
// instead.
let enginePromise: Promise<PolyglotEngine>|undefined;
let loadedEngine: PolyglotEngine|undefined;

export function loadSqlEngine(): Promise<PolyglotEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const {default: wasmPath} = await import(
          '@polyglot-sql/sdk/polyglot_sql.wasm', {with: {type: 'file'}});
      const engine =
          await import('@polyglot-sql/sdk/manual') as unknown as PolyglotEngine;
      await engine.init({wasmUrl: readFileSync(wasmPath) as unknown as string});
      loadedEngine = engine;
      return engine;
    })().catch(err => {
      // Don't cache the failure: a transient init error (e.g. a failed read)
      // must not permanently disable the engine for a long-lived process.
      // Clear the memo so the next call retries, then propagate.
      enginePromise = undefined;
      throw err;
    });
  }
  return enginePromise;
}

// The engine's dialect for each kcmd dialect. The engine has no Spanner
// dialect, so Spanner's GoogleSQL is read as BigQuery's.
const PARSER_DIALECTS: Record<string, string> = {
  ANSI_SQL: 'generic',
  BIGQUERY: 'bigquery',
  SPANNER: 'bigquery',
  POSTGRES: 'postgresql',
  ALLOYDB: 'postgresql',
  MYSQL: 'mysql',
  SNOWFLAKE: 'snowflake',
  DATABRICKS: 'databricks',
};

// A column an expression reads: its name, and the qualifier written before it,
// if any.
export interface SqlColumn {
  qualifier?: string;
  name: string;
}

// Every column `expression` reads, in the order written, or undefined when the
// engine cannot read it as one expression in `dialect`. An empty expression
// reads none. A struct path reads as
// its first two parts, so `orders.address.city` reads the column `address`
// qualified by `orders`. A function namespace such as `NET` in
// `NET.HOST(orders.url)` is not a column, and the expression a chained call
// applies to, such as `(orders.name)` in `(orders.name).UPPER()`, is read.
// Throws when the engine is not loaded.
export function sqlColumns(expression: string, dialect: string): SqlColumn[]|
    undefined {
  if (!loadedEngine) {
    throw new Error(
        'the SQL parser is not loaded; call loadSqlEngine() first');
  }
  if (!expression.trim()) return [];
  const engineDialect = PARSER_DIALECTS[dialect.toUpperCase()] ?? 'generic';
  // Read as written first. A text that starts with a keyword, such as the
  // entity name in `Order.amount - Order.discount`, reads as a clause there,
  // so it is read again inside parentheses. Either way the text must parse as
  // one expression and nothing more. The line breaks keep a trailing `--`
  // comment from swallowing the closing parenthesis.
  const ast = oneExpression(engineDialect, `SELECT ${expression}`) ??
      oneExpression(engineDialect, `SELECT (\n${expression}\n)`, 'paren');
  if (!ast) return undefined;
  const columns: SqlColumn[] = [];
  collectColumns(ast, columns, new Set(), engineDialect === 'bigquery');
  return columns;
}

// The parsed statement when `sql` is a `SELECT` of exactly one expression and
// nothing else: no alias, no `FROM`, `WHERE`, `DISTINCT` or other clause. The
// expression is of node kind `kind` when given. Undefined otherwise.
function oneExpression(dialect: string, sql: string, kind?: string): unknown {
  const res = loadedEngine!.parse(sql, dialect);
  if (!res.success || res.ast?.length !== 1) return undefined;
  const select = (res.ast[0] as any)?.select;
  const items = select?.expressions;
  if (!Array.isArray(items) || items.length !== 1) return undefined;
  const itemKind = Object.keys(items[0] ?? {})[0];
  if (itemKind === 'alias' || (kind && itemKind !== kind)) return undefined;
  // Inside the parentheses, `x AS y` reads as an alias too.
  const inner = itemKind === 'paren' ? items[0].paren?.this : undefined;
  if (inner && Object.keys(inner)[0] === 'alias') return undefined;
  const isEmpty = (v: unknown) => v === null || v === undefined ||
      v === false || (Array.isArray(v) && v.length === 0) ||
      (typeof v === 'object' && Object.keys(v as object).length === 0);
  for (const [key, value] of Object.entries(select)) {
    if (key !== 'expressions' && !isEmpty(value)) return undefined;
  }
  return res.ast[0];
}

// Functions whose first argument is a date-part unit (such as `DAY` or `MONTH`)
// that the parser represents as an unquoted bare `column` node in MySQL,
// Databricks or generic ANSI SQL.
const LEADING_DATE_PART_FUNCTIONS = new Set([
  'DATEDIFF',
  'DATEADD',
  'DATE_ADD',
  'DATE_DIFF',
  'TIMESTAMPDIFF',
  'TIMESTAMPADD',
]);

// In BigQuery (and Spanner), these put the unit last, as in
// `DATE_DIFF(end_col, start_col, DAY)`, so their first argument is a column
// even when its name matches a short unit such as `d`.
const BIGQUERY_TRAILING_UNIT_FUNCTIONS = new Set(['DATE_ADD', 'DATE_DIFF']);

// BigQuery functions whose last argument is a date part, as in
// `DATE_TRUNC(d, MONTH)` or `DATE_DIFF(a, b, WEEK(MONDAY))`. Under the `SAFE.`
// prefix the engine reads that date part as a column.
const BIGQUERY_DATE_PART_FUNCTIONS = new Set([
  'DATE_DIFF', 'DATETIME_DIFF', 'TIMESTAMP_DIFF', 'TIME_DIFF', 'DATE_TRUNC',
  'DATETIME_TRUNC', 'TIMESTAMP_TRUNC', 'TIME_TRUNC', 'LAST_DAY',
]);

const DATE_PART_KEYWORDS = new Set([
  'YEAR',        'YEARS',        'YYYY',        'YY',          'QUARTER',
  'QUARTERS',    'QQ',           'Q',           'MONTH',       'MONTHS',
  'MM',          'M',            'WEEK',        'WEEKS',       'WK',
  'WW',          'DAYOFYEAR',    'DY',          'DOY',         'DAY',
  'DAYS',        'DD',           'D',           'DAYOFWEEK',   'DW',
  'WEEKDAY',     'HOUR',         'HOURS',       'HH',          'MINUTE',
  'MINUTES',     'MI',           'N',           'SECOND',      'SECONDS',
  'SS',          'S',            'MILLISECOND', 'MILLISECONDS', 'MS',
  'MICROSECOND', 'MICROSECONDS', 'US',          'NANOSECOND',  'NANOSECONDS',
  'NS',          'ISOWEEK',      'ISOYEAR',
]);

function collectColumns(
    node: unknown, out: SqlColumn[], bound: ReadonlySet<string>,
    bigQuery: boolean): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectColumns(item, out, bound, bigQuery);
    }
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, any>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === 'column' &&
      typeof obj.column?.name?.name === 'string') {
    const qualifier = obj.column.table?.name;
    const name = obj.column.name.name;
    if (typeof qualifier === 'string' ? bound.has(qualifier) : bound.has(name)) {
      return;
    }
    out.push({
      ...(typeof qualifier === 'string' ? {qualifier} : {}),
      name,
    });
    return;
  }
  if (keys.length === 1 && keys[0] === 'dot') {
    // A struct path reads as its first two parts. The engine reads `Time.hour`
    // as a field of a column named `Time`, because `Time` is also a type name,
    // so the first part is still the qualifier.
    let inner = obj.dot;
    while (inner?.this && Object.keys(inner.this).length === 1 &&
           inner.this.dot) {
      inner = inner.this.dot;
    }
    const column = inner?.this?.column;
    if (typeof column?.name?.name === 'string') {
      const qualifier = column.table?.name;
      if (typeof qualifier === 'string') {
        if (!bound.has(qualifier)) {
          out.push({qualifier, name: column.name.name});
        }
      } else if (typeof inner.field?.name === 'string') {
        if (!bound.has(column.name.name)) {
          out.push({qualifier: column.name.name, name: inner.field.name});
        }
      }
      return;
    }
    collectColumns(obj.dot?.this, out, bound, bigQuery);
    return;
  }
  if (keys.length === 1 && keys[0] === 'method_call') {
    // In `NET.HOST(x)` and `my_project.my_dataset.my_udf(x)` the part before
    // the dot is a bare name path that names a function namespace, so it is not
    // read. Any other receiver is the expression a chained call applies to, as
    // in `(orders.name).UPPER()` or `LOWER(orders.name).TRIM()`, and it is.
    const receiver = obj.method_call?.this;
    if (!isNamePath(receiver)) {
      collectColumns(receiver, out, bound, bigQuery);
    }
    collectColumns(obj.method_call?.args, out, bound, bigQuery);
    return;
  }
  if (keys.length === 1 && keys[0] === 'function') {
    const fnName = String(obj.function?.name ?? '').toUpperCase();
    const hasLeadingUnit = LEADING_DATE_PART_FUNCTIONS.has(fnName) &&
        !(bigQuery && BIGQUERY_TRAILING_UNIT_FUNCTIONS.has(fnName));
    const args: unknown[] =
        Array.isArray(obj.function?.args) ? obj.function.args : [];
    const col0 = (args[0] as any)?.column;
    if (hasLeadingUnit && args.length >= 3 && col0 &&
        col0.table == null && col0.name?.quoted === false &&
        typeof col0.name?.name === 'string' &&
        DATE_PART_KEYWORDS.has(col0.name.name.toUpperCase())) {
      for (const arg of args.slice(1)) {
        collectColumns(arg, out, bound, bigQuery);
      }
      return;
    }
    if (bigQuery && fnName.startsWith('SAFE.') &&
        BIGQUERY_DATE_PART_FUNCTIONS.has(fnName.slice('SAFE.'.length)) &&
        args.length >= 2 && isDatePart(args[args.length - 1])) {
      collectColumns(args.slice(0, -1), out, bound, bigQuery);
      return;
    }
  }
  if (keys.length === 1 && keys[0] === 'lambda') {
    const next = new Set(bound);
    for (const p of obj.lambda?.parameters ?? []) {
      if (typeof p?.name === 'string') next.add(p.name);
    }
    collectColumns(obj.lambda?.body, out, next, bigQuery);
    return;
  }
  if (keys.length === 1 && keys[0] === 'select') {
    const select = obj.select;
    const next = new Set(bound);
    for (const cte of select?.with?.ctes ?? []) {
      if (typeof cte?.alias?.name === 'string') next.add(cte.alias.name);
      collectColumns(cte?.this, out, next, bigQuery);
    }
    for (const expr of select?.from?.expressions ?? []) {
      collectColumns(expr, out, next, bigQuery);
      addSourceAliases(expr, next);
    }
    // Inside a subquery with its own `FROM` clause, a bare identifier in the
    // remaining clauses may come from that `FROM` source (e.g. a derived
    // table's column or an unaliased `UNNEST` field), so only qualified
    // references outside `next` are kept.
    const target: SqlColumn[] = select?.from ? [] : out;
    for (const join of select?.joins ?? []) {
      addSourceAliases(join?.this, next);
      collectColumns(join, target, next, bigQuery);
    }
    for (const item of select?.expressions ?? []) {
      if (typeof item?.alias?.alias?.name === 'string') {
        next.add(item.alias.alias.name);
      }
    }
    for (const [k, v] of Object.entries(select ?? {})) {
      if (k !== 'with' && k !== 'from' && k !== 'joins') {
        collectColumns(v, target, next, bigQuery);
      }
    }
    if (select?.from) {
      out.push(...target.filter(c => c.qualifier !== undefined));
    }
    return;
  }
  for (const value of Object.values(obj)) {
    collectColumns(value, out, bound, bigQuery);
  }
}

// Whether `node` is a date part written as a bare name, such as `DAY`, or as
// `WEEK(MONDAY)`.
function isDatePart(node: any): boolean {
  const col = node?.column;
  if (col) {
    return col.table == null && col.name?.quoted === false &&
        typeof col.name?.name === 'string' &&
        DATE_PART_KEYWORDS.has(col.name.name.toUpperCase());
  }
  return String(node?.function?.name ?? '').toUpperCase() === 'WEEK';
}

function addSourceAliases(source: any, bound: Set<string>): void {
  if (typeof source?.alias?.alias?.name === 'string') {
    bound.add(source.alias.alias.name);
  }
  const inner = source?.alias?.this ?? source;
  for (const kind of ['unnest', 'table', 'subquery']) {
    const node = inner?.[kind];
    if (typeof node?.alias?.name === 'string') bound.add(node.alias.name);
    if (typeof node?.offset_alias?.name === 'string') {
      bound.add(node.offset_alias.name);
    }
  }
}

// Whether `node` is a name or a dotted run of names, such as `NET` or
// `my_project.my_dataset`, with no other expression inside it.
function isNamePath(node: unknown): boolean {
  if (!node || typeof node !== 'object') return false;
  const obj = node as Record<string, any>;
  const keys = Object.keys(obj);
  if (keys.length !== 1) return false;
  if (keys[0] === 'column') return true;
  return keys[0] === 'dot' && isNamePath(obj.dot?.this);
}

// The tokens of `expression` in `dialect`, or undefined when the engine cannot
// tokenize it. Throws when the engine is not loaded.
function sqlTokens(expression: string, dialect: string): SqlToken[]|undefined {
  if (!loadedEngine) {
    throw new Error(
        'the SQL parser is not loaded; call loadSqlEngine() first');
  }
  const engineDialect = PARSER_DIALECTS[dialect.toUpperCase()] ?? 'generic';
  const res = loadedEngine.tokenize(expression, engineDialect);
  return res.success ? res.tokens ?? [] : undefined;
}

// Whether `expression` holds no SQL in `dialect`: it is empty, only whitespace
// or only comments. False when the engine cannot read it. Throws when the
// engine is not loaded.
export function holdsNoSql(expression: string, dialect: string): boolean {
  return sqlTokens(expression, dialect)?.length === 0;
}

// `expression` with its comments removed, as the engine reads them in
// `dialect`. Comments between two tokens become one space, or nothing when
// either token is a `.`, so `orders/* c */.amount` reads `orders.amount`.
// Comments before the first token or after the last are dropped. The rest of
// the text stays as written. Returns `expression` itself when it has no
// comment, holds nothing but comments, or the engine cannot read it. Throws
// when the engine is not loaded.
export function withoutComments(expression: string, dialect: string): string {
  const tokens = sqlTokens(expression, dialect);
  if (!tokens?.some(t => t.comments.length || t.trailing_comments.length)) {
    return expression;
  }
  const chars = Array.from(expression);
  let out = '';
  let end = 0;
  let previous = '';
  for (const t of tokens) {
    // The text between two tokens is whitespace and comments.
    const between = chars.slice(end, t.span.start).join('');
    const text = chars.slice(t.span.start, t.span.end).join('');
    if (out) {
      if (between.trim() === '') out += between;
      else if (previous !== '.' && text !== '.') out += ' ';
    }
    out += text;
    previous = text;
    end = t.span.end;
  }
  return out;
}
