// The SQL engine kcmd reads and translates expressions with: the
// @polyglot-sql/sdk Rust/WASM engine, bundled into the tool.
//
// Loading the engine is asynchronous and happens once per process, through
// `loadSqlEngine`. Parsing is synchronous after that, so the validators that
// read expressions stay synchronous: a command that runs them loads the engine
// first, and so does a test.

import {readFileSync} from 'node:fs';

import {nameKey} from './sql_identifiers';

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
  // Writes each tree in `ast` as SQL in `dialect`. A tree is a statement
  // from `parse` or an expression from `sqlExpressionTree`.
  generate(ast: unknown[], dialect: string):
      {success: boolean; sql?: string[]; error?: string};
  // On failure, `errorStart` is where the text the engine cannot read starts.
  // It counts Unicode code points, as a token's `span` does, though the SDK's
  // type declarations call both byte offsets. The MySQL comment row with an
  // emoji in transpile.polyglot.test.ts checks it.
  tokenize(sql: string, dialect: string):
      {success: boolean; tokens?: SqlToken[]; error?: string; errorStart?: number};
}

// A token the engine reads, as the engine returns it. `token_type` is the
// engine's kind, such as `VAR`, `QUOTED_IDENTIFIER`, `DOT` or `STRING`. `text`
// is the token as written, except that a quoted identifier or a string literal
// gives what is inside its quotes. `span` counts Unicode code points from the
// start of the text, end exclusive. The comments the tokenizer skipped are
// attached to the token after them or before them.
export interface SqlToken {
  token_type: string;
  text: string;
  span: {start: number; end: number};
  comments: string[];
  trailing_comments: string[];
}

// The engine, initialized once and shared process-wide. Under Bun, the
// Rust/WASM blob is embedded into the standalone binary via `import(...,
// {with: {type: 'file'}})` (statically analyzable, so bundled); under Node.js,
// it is resolved from `node_modules` via `require.resolve(...)`. In both
// cases the bytes are handed to `init()` via the `/manual` entry so the same
// loader works inside a `bun --compile` binary and a standard npm install.
let enginePromise: Promise<PolyglotEngine>|undefined;
let loadedEngine: PolyglotEngine|undefined;

export function loadSqlEngine(): Promise<PolyglotEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const wasmPath = 'Bun' in globalThis ?
          (await import(
               '@polyglot-sql/sdk/polyglot_sql.wasm', {with: {type: 'file'}}))
              .default :
          require.resolve('@polyglot-sql/sdk/polyglot_sql.wasm');
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

// The engine loadSqlEngine has loaded, or undefined before it has.
export function loadedSqlEngine(): PolyglotEngine|undefined {
  return loadedEngine;
}

// Runs `read` and drops the message the engine prints to the console when it
// panics on a text. The engine then reports that text unread, as it reports
// any text it cannot parse.
export function withoutEngineMessages<T>(read: () => T): T {
  const error = console.error;
  console.error = () => {};
  try {
    return read();
  } finally {
    console.error = error;
  }
}

// The engine's dialect for each kcmd dialect. The engine has no Spanner
// dialect, so Spanner's GoogleSQL is read as BigQuery's. Apache Ossie's
// OSSIE_SQL_2026 is read as generic SQL, which reads a double-quoted name as
// a name, as Ossie does.
const PARSER_DIALECTS: Record<string, string> = {
  ANSI_SQL: 'generic',
  OSSIE_SQL_2026: 'generic',
  BIGQUERY: 'bigquery',
  SPANNER: 'bigquery',
  POSTGRES: 'postgresql',
  ALLOYDB: 'postgresql',
  MYSQL: 'mysql',
  SQLSERVER: 'tsql',
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
  const tree = sqlExpressionTree(expression, dialect);
  if (!expression.trim()) return [];
  if (!tree) return undefined;
  const columns: SqlColumn[] = [];
  collectColumns(tree, columns, new Set(), dialect.toUpperCase());
  return columns;
}

// Each word `expression` reads as a date part where a call takes one, in
// the order written, as sqlColumns reads it in `dialect`: so `day` in
// `DATEDIFF(day, a, b)` but not `x` in `DATEDIFF(x, a, b)`. Undefined when
// the engine cannot read the text as one expression. Throws when the engine
// is not loaded.
export function sqlDateParts(expression: string, dialect: string): string[]|
    undefined {
  const tree = sqlExpressionTree(expression, dialect);
  if (!expression.trim()) return [];
  if (!tree) return undefined;
  const parts: string[] = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    const fn = (node as any).function;
    if (fn && Object.keys(node).length === 1) {
      const args: any[] = Array.isArray(fn.args) ? fn.args : [];
      const at = datePartIndex(
          String(fn.name ?? ''), args.length, dialect.toUpperCase());
      if (at !== undefined && args[at]?.column &&
          isDatePartNode(args[at], dialect.toUpperCase())) {
        parts.push(args[at].column.name.name);
      }
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(tree);
  return parts;
}

// The column `expression` is, read in `dialect`, when it is one column and
// nothing else, perhaps in parentheses: `orders.amount`, `` (`order`) `` or
// `amount`, but not a struct path such as `orders.address.city` or any other
// expression, and whether its name is quoted. Undefined otherwise, or when
// the engine cannot read it. Throws when the engine is not loaded.
export function soleColumn(expression: string, dialect: string):
    (SqlColumn&{quoted: boolean})|undefined {
  let tree = sqlExpressionTree(expression, dialect);
  const kind = (node: any) =>
      node && Object.keys(node).length === 1 ? Object.keys(node)[0] : undefined;
  while (kind(tree) === 'paren') tree = tree.paren.this;
  if (kind(tree) !== 'column') return undefined;
  const columns = sqlColumns(expression, dialect);
  return columns?.length === 1 ?
      {...columns[0], quoted: tree.column.name?.quoted === true} :
      undefined;
}

// The engine's tree of `expression` read as one expression in `dialect`, or
// undefined when it cannot be read so or is empty (see expressionStatement).
export function sqlExpressionTree(expression: string, dialect: string): any {
  return expressionStatement(expression, dialect)?.tree.select.expressions[0];
}

// The SELECT statement in which the engine reads `expression`, a text of
// `dialect`, as one expression, as SQL in the engine's dialect, and its tree,
// or undefined when it cannot be read so or is empty. A text that starts
// with a keyword, such as `Order.amount`, or that T-SQL reads after SELECT
// as an alias, such as `lock = 1`, is read again inside parentheses on lines
// of their own, so a trailing `--` comment stays inside. The engine reads the
// text as forParser writes it.
export function expressionStatement(expression: string, dialect: string):
    {sql: string; tree: any}|undefined {
  if (!loadedEngine) {
    throw new Error(
        'the SQL parser is not loaded; call loadSqlEngine() first');
  }
  if (!expression.trim()) return undefined;
  const engineDialect = engineDialectOf(dialect);
  const text = forParser(expression, dialect);
  const forms: [string, string|undefined][] =
      [[`SELECT ${text}`, undefined], [`SELECT (\n${text}\n)`, 'paren']];
  for (const [sql, kind] of forms) {
    const tree = oneExpression(engineDialect, sql, kind);
    if (tree) return {sql, tree};
  }
  return undefined;
}

// The type names a dialect writes before a string literal that the engine's
// parser cannot read there, by dialect: OSSIE_SQL_2026's TIMESTAMP_NTZ, a
// timestamp without a time zone.
const TYPED_LITERALS: Readonly<Record<string, ReadonlySet<string>>> = {
  OSSIE_SQL_2026: new Set(['TIMESTAMP_NTZ']),
};

// `expression`, a text of `dialect`, as the engine's parser reads it. A MySQL
// text has its comments written as MySQL reads them, as mysqlForEngine writes
// it. A literal that names a type of TYPED_LITERALS, in any letter case, is
// written as a cast, so `TIMESTAMP_NTZ '2026-01-01'` becomes
// `CAST('2026-01-01' AS TIMESTAMP_NTZ)`. A comment between the type name and
// the literal stays, before the cast. Throws when the engine is not loaded.
export function forParser(expression: string, dialect: string): string {
  if (engineDialectOf(dialect) === 'mysql') return mysqlForEngine(expression);
  const types = TYPED_LITERALS[dialect.toUpperCase()];
  const tokens = types && sqlTokens(expression, dialect);
  if (!tokens) return expression;
  const chars = [...expression];
  const written = (t: SqlToken) =>
      chars.slice(t.span.start, t.span.end).join('');
  for (let i = tokens.length - 2; i >= 0; i--) {
    const [t, next] = [tokens[i], tokens[i + 1]];
    if (types.has(written(t).toUpperCase()) && next.token_type === 'STRING' &&
        tokens[i - 1]?.token_type !== 'DOT') {
      // A comment between the type name and the literal stays before the cast.
      const between = chars.slice(t.span.end, next.span.start).join('').trimStart();
      chars.splice(
          t.span.start, next.span.end - t.span.start,
          ...`${between}CAST(${written(next)} AS ${written(t).toUpperCase()})`);
    }
  }
  return chars.join('');
}

// `sql`, a MySQL text, with each comment marker written so that the engine
// reads it as MySQL does. Throws when the engine is not loaded.
export function mysqlForEngine(sql: string): string {
  return mysqlForEngineAt(sql).text;
}

// Returns `text`, which is `sql`, a MySQL text, as mysqlForEngine writes it.
// `from[i]` is the index in `sql` of code point i of `text`. `tokens` holds the
// engine's tokens of `text` when one call to tokenize read all of it. Each
// change can turn the rest of the text into code or into a comment, so the
// first one goes first. The engine then reads again from the start of the gap
// or token that held the marker, up to the end of the line of the next marker.
// When a string or a comment is still open there, which a token placed after
// the line shows, the engine reads to the end of the text.
function mysqlForEngineAt(sql: string):
    {text: string; from: number[]; tokens?: SqlToken[]} {
  if (!loadedEngine) {
    throw new Error(
        'the SQL parser is not loaded; call loadSqlEngine() first');
  }
  const chars = [...sql];
  const from = chars.map((_, i) => i);
  // No string or comment is open at `start`, and every marker before it is
  // written as MySQL reads it.
  let start = 0;
  let end = lineOfMarker(chars, start);
  while (end !== undefined) {
    const probe = end < chars.length ? '\n1' : '';
    let res = loadedEngine.tokenize(chars.slice(start, end).join('') + probe, 'mysql');
    // When the engine cannot tokenize the text, such as at an unclosed quote in
    // a # comment, it reads the text before the point where it stopped.
    let read = end;
    let open = false;
    if (!res.success && res.errorStart !== undefined) {
      read = Math.min(end, start + res.errorStart);
      res = loadedEngine.tokenize(chars.slice(start, read).join(''), 'mysql');
    } else if (res.success && probe) {
      open = res.tokens?.at(-1)?.span.start !== end - start + 1;
      if (!open) res.tokens!.pop();
    }
    if (!res.success) break;
    const tokens = (res.tokens ?? []).map(t => ({
      ...t, span: {...t.span, start: t.span.start + start, end: t.span.end + start},
    }));
    const fix = mysqlMisreadComment(chars, tokens, start, read);
    if (fix === 'open' || (!fix && (read < end || open))) {
      // A string or a comment runs past `end`, or the text cannot be read.
      if (end === chars.length) break;
      end = chars.length;
    } else if (!fix) {
      if (start === 0 && end === chars.length) {
        return {text: chars.join(''), from, tokens};
      }
      start = end;
      end = lineOfMarker(chars, start);
    } else {
      // Each part takes the place of one code point.
      const written = fix.parts.flatMap(
          (part, k) => [...part].map(c => ({c, at: from[fix.at + k]})));
      chars.splice(fix.at, fix.parts.length, ...written.map(w => w.c));
      from.splice(fix.at, fix.parts.length, ...written.map(w => w.at));
      start = fix.restart;
      end = lineOfMarker(chars, fix.at);
    }
  }
  return {text: chars.join(''), from};
}

// The end of the line that holds the first #, -- or /* in `chars` at or after
// `start`, or undefined when there is none. Only these can start a comment
// the engine reads another way than MySQL.
function lineOfMarker(chars: string[], start: number): number|undefined {
  for (let i = start; i < chars.length; i++) {
    const two = chars[i] + chars[i + 1];
    if (chars[i] === '#' || two === '--' || two === '/*') {
      const n = chars.indexOf('\n', i);
      return n < 0 ? chars.length : n;
    }
  }
  return undefined;
}

// The first comment marker in `chars` between `start` and `read` that the
// engine reads another way than MySQL, given the engine's `tokens` of that
// text, the parts written in place of its code points, and the start of the
// gap or token that holds it, where the engine has nothing open. 'open' when a
// comment is still open at `read`, and undefined when there is neither. MySQL
// starts a -- comment only before whitespace, so `3--1` is 3 - -1, and starts
// one at a # outside a string or a quoted name. MySQL ends a block comment at
// the first */, where the engine nests block comments, so a /* inside a block
// comment is written as `/ *`. The gaps between the tokens hold the engine's
// comments.
function mysqlMisreadComment(
    chars: string[], tokens: SqlToken[], start: number,
    read: number): {at: number; parts: string[]; restart: number}|'open'|undefined {
  const quoted = (type: string) =>
      type.endsWith('STRING') || type === 'QUOTED_IDENTIFIER' || type === 'HINT';
  // Whether `chars[i]` is whitespace or past the end, as MySQL needs after
  // the dashes of a -- comment.
  const spaced = (i: number) => (chars[i] ?? '').trim() === '';
  for (const t of [...tokens, undefined]) {
    const end = t?.span.start ?? read;
    for (let i = start; i < end; i++) {
      const two = chars[i] + (chars[i + 1] ?? '');
      if (two === '/*') {
        i += 2;
        while (i < end && chars[i] + chars[i + 1] !== '*/') {
          if (chars[i] + chars[i + 1] === '/*') return {at: i, parts: ['/', ' *'], restart: start};
          i++;
        }
        if (i >= end) return 'open';
        i++;
      } else if (two === '--' && !spaced(i + 2)) {
        return {at: i, parts: [' -', ' -'], restart: start};
      } else if (two === '--') {
        const n = chars.indexOf('\n', i);
        i = n < 0 || n > end ? end : n;
      }
    }
    if (!t) return undefined;
    const hash = chars.slice(t.span.start, t.span.end).indexOf('#');
    if (hash >= 0 && !quoted(t.token_type)) {
      const at = t.span.start + hash;
      return {at, parts: [spaced(at + 1) ? ' --' : ' -- '], restart: t.span.start};
    }
    start = t.span.end;
  }
  return undefined;
}

// The parsed statement when `sql` is a `SELECT` of exactly one expression and
// nothing else: no alias, no `FROM`, `WHERE`, `DISTINCT` or other clause. The
// expression is of node kind `kind` when given. Undefined otherwise. T-SQL
// reads `SELECT name = value`, with an unqualified name, as an alias that
// names the column, though the engine's tree holds a comparison.
function oneExpression(dialect: string, sql: string, kind?: string): unknown {
  const res = loadedEngine!.parse(sql, dialect);
  if (!res.success || res.ast?.length !== 1) return undefined;
  const select = (res.ast[0] as any)?.select;
  const items = select?.expressions;
  if (!Array.isArray(items) || items.length !== 1) return undefined;
  const itemKind = Object.keys(items[0] ?? {})[0];
  if (itemKind === 'alias' || (kind && itemKind !== kind)) return undefined;
  const left = items[0].eq?.left?.column;
  if (dialect === 'tsql' && left && !left.table) return undefined;
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

// The functions whose first argument is a date part written without quotes,
// such as `DAY` in `DATEDIFF(day, a, b)`, each with the fewest arguments it
// takes then. The parser reads such a part as a column in most dialects.
// With two arguments, MySQL's and Databricks' DATEDIFF take two dates.
// `dialects` lists the kcmd dialects whose function takes such a part first,
// where only some do. Apache Ossie's and Snowflake's DATE_TRUNC and
// DATE_PART do, as in `DATE_TRUNC(week, d)`. PostgreSQL's, AlloyDB's and
// Databricks' take the part as a string, so a word there is a column, as it
// is in the engine's generic dialect, which reads ANSI_SQL. MySQL and SQL
// Server have no such function, and BigQuery's takes the date first (see
// BIGQUERY_DATE_PARTS).
const LEADING_DATE_PART_FUNCTIONS: Readonly<
    Record<string, {fewest: number; dialects?: ReadonlySet<string>}>> = {
  DATE_PART: {fewest: 2, dialects: new Set(['OSSIE_SQL_2026', 'SNOWFLAKE'])},
  DATE_TRUNC: {fewest: 2, dialects: new Set(['OSSIE_SQL_2026', 'SNOWFLAKE'])},
  DATEDIFF: {fewest: 3},
  DATEADD: {fewest: 3},
  DATE_ADD: {fewest: 3},
  DATE_BUCKET: {fewest: 3},
  DATE_DIFF: {fewest: 3},
  TIMESTAMPDIFF: {fewest: 3},
  TIMESTAMPADD: {fewest: 3},
};

// In BigQuery (and Spanner), these take a column first, as in
// `DATE_DIFF(end_col, start_col, DAY)` or `DATE_BUCKET(d, INTERVAL 7 DAY)`, so
// their first argument is a column even when its name matches a short unit
// such as `d`.
const BIGQUERY_TRAILING_UNIT_FUNCTIONS =
    new Set(['DATE_ADD', 'DATE_BUCKET', 'DATE_DIFF']);

// The BigQuery functions that take a date part, with or without the `SAFE.`
// prefix, each with the index of the argument that is the part. A DIFF
// function takes it third, as in `DATE_DIFF(a, b, WEEK(MONDAY))`. A TRUNC
// function and LAST_DAY take it second, as in `TIMESTAMP_TRUNC(ts, MONTH,
// 'UTC')`, whose third argument is a time zone. Under the `SAFE.` prefix the
// engine reads the date part as a column.
const BIGQUERY_DATE_PARTS: Readonly<Record<string, number>> = {
  DATE_DIFF: 2,
  DATETIME_DIFF: 2,
  TIMESTAMP_DIFF: 2,
  TIME_DIFF: 2,
  DATE_TRUNC: 1,
  DATETIME_TRUNC: 1,
  TIMESTAMP_TRUNC: 1,
  TIME_TRUNC: 1,
  LAST_DAY: 1,
};

// The days BigQuery's `WEEK(<day>)` date part takes.
const WEEKDAYS = new Set([
  'SUNDAY', 'MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY',
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

// Adds each column `node`, the parser's tree of a text of `dialect`, a kcmd
// dialect in upper case, reads to `out`, apart from one whose qualifier, or
// whose name when it has none, the query around it binds. `bound` holds each
// name the query binds there, such as a table's alias, a CTE's name or a
// lambda's parameter, as boundName gives it, so a name matches as the
// dialect's database matches it.
function collectColumns(
    node: unknown, out: SqlColumn[], bound: ReadonlySet<string>,
    dialect: string): void {
  if (Array.isArray(node)) {
    for (const item of node) {
      collectColumns(item, out, bound, dialect);
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
    if (bound.has(boundName(
            typeof qualifier === 'string' ? obj.column.table : obj.column.name,
            dialect))) {
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
        if (!bound.has(boundName(column.table, dialect))) {
          out.push({qualifier, name: column.name.name});
        }
      } else if (typeof inner.field?.name === 'string') {
        if (!bound.has(boundName(column.name, dialect))) {
          out.push({qualifier: column.name.name, name: inner.field.name});
        }
      }
      return;
    }
    collectColumns(obj.dot?.this, out, bound, dialect);
    return;
  }
  if (keys.length === 1 && keys[0] === 'method_call') {
    // In `NET.HOST(x)` and `my_project.my_dataset.my_udf(x)` the part before
    // the dot is a bare name path that names a function namespace, so it is not
    // read. In T-SQL, `orders.geo.STLength()` calls a method of the column
    // `orders.geo`, so a receiver written as a qualified column is read. Any
    // other receiver is the expression a chained call applies to, as in
    // `(orders.name).UPPER()` or `LOWER(orders.name).TRIM()`, and it is.
    const receiver = obj.method_call?.this;
    const columnMethod = engineDialectOf(dialect) === 'tsql' &&
        typeof receiver?.column?.table?.name === 'string';
    if (columnMethod || !isNamePath(receiver)) {
      collectColumns(receiver, out, bound, dialect);
    }
    collectColumns(obj.method_call?.args, out, bound, dialect);
    return;
  }
  if (keys.length === 1 && keys[0] === 'function') {
    const args: unknown[] =
        Array.isArray(obj.function?.args) ? obj.function.args : [];
    const at = datePartIndex(String(obj.function?.name ?? ''), args.length, dialect);
    if (at !== undefined && isDatePartNode(args[at], dialect)) {
      collectColumns(args.filter((_, i) => i !== at), out, bound, dialect);
      return;
    }
  }
  if (keys.length === 1 && keys[0] === 'lambda') {
    const next = new Set(bound);
    for (const p of obj.lambda?.parameters ?? []) {
      if (typeof p?.name === 'string') next.add(boundName(p, dialect));
    }
    collectColumns(obj.lambda?.body, out, next, dialect);
    return;
  }
  if (keys.length === 1 && keys[0] === 'select') {
    const select = obj.select;
    const next = new Set(bound);
    // A CTE's name is bound once its body is read, so the body reads only
    // the CTEs before it, unless WITH RECURSIVE binds every name first.
    const ctes: any[] = select?.with?.ctes ?? [];
    const bind = (cte: any) => {
      if (typeof cte?.alias?.name === 'string') {
        next.add(boundName(cte.alias, dialect));
      }
    };
    if (select?.with?.recursive) ctes.forEach(bind);
    for (const cte of ctes) {
      collectColumns(cte?.this, out, next, dialect);
      bind(cte);
    }
    for (const expr of select?.from?.expressions ?? []) {
      collectColumns(expr, out, next, dialect);
      addSourceAliases(expr, next, dialect);
    }
    // Inside a subquery with its own `FROM` clause, a bare identifier in the
    // remaining clauses may come from that `FROM` source (e.g. a derived
    // table's column or an unaliased `UNNEST` field), so only qualified
    // references outside `next` are kept.
    const target: SqlColumn[] = select?.from ? [] : out;
    for (const join of select?.joins ?? []) {
      addSourceAliases(join?.this, next, dialect);
      collectColumns(join, target, next, dialect);
    }
    for (const item of select?.expressions ?? []) {
      if (typeof item?.alias?.alias?.name === 'string') {
        next.add(boundName(item.alias.alias, dialect));
      }
    }
    for (const [k, v] of Object.entries(select ?? {})) {
      if (k !== 'with' && k !== 'from' && k !== 'joins') {
        collectColumns(v, target, next, dialect);
      }
    }
    if (select?.from) {
      out.push(...target.filter(c => c.qualifier !== undefined));
    }
    return;
  }
  for (const value of Object.values(obj)) {
    collectColumns(value, out, bound, dialect);
  }
}

// The argument that is a date part in a call to `fn` with `count` arguments,
// in a text of `dialect`, a kcmd dialect in upper case, by its index, or
// undefined when the call takes none (see LEADING_DATE_PART_FUNCTIONS and
// BIGQUERY_DATE_PARTS).
function datePartIndex(fn: string, count: number, dialect: string):
    number|undefined {
  const name = fn.toUpperCase();
  if (engineDialectOf(dialect) === 'bigquery') {
    const safe = name.startsWith('SAFE.') ? name.slice('SAFE.'.length) : name;
    if (Object.hasOwn(BIGQUERY_DATE_PARTS, safe)) {
      const at = BIGQUERY_DATE_PARTS[safe];
      return at < count ? at : undefined;
    }
    if (BIGQUERY_TRAILING_UNIT_FUNCTIONS.has(name)) return undefined;
  }
  const leading = Object.hasOwn(LEADING_DATE_PART_FUNCTIONS, name) ?
      LEADING_DATE_PART_FUNCTIONS[name] :
      undefined;
  return leading && count >= leading.fewest &&
          (!leading.dialects || leading.dialects.has(dialect)) ?
      0 :
      undefined;
}

// Whether `node`, the parser's tree of an argument where a call takes a date
// part, in a text of `dialect`, a kcmd dialect, is one: the name of a date
// part written without quotes or a qualifier, such as `DAY`, or, in BigQuery,
// `WEEK` of a day written so, such as `WEEK(MONDAY)`.
function isDatePartNode(node: any, dialect: string): boolean {
  const bare = (col: any, names: ReadonlySet<string>) => col?.table == null &&
      col?.name?.quoted === false && typeof col?.name?.name === 'string' &&
      names.has(col.name.name.toUpperCase());
  if (node?.column) return bare(node.column, DATE_PART_KEYWORDS);
  const args = node?.function?.args;
  return engineDialectOf(dialect) === 'bigquery' &&
      String(node?.function?.name ?? '').toUpperCase() === 'WEEK' &&
      Array.isArray(args) && args.length === 1 &&
      (args[0]?.var !== undefined || bare(args[0]?.column, WEEKDAYS));
}

// The engine's dialect for `dialect`, a kcmd dialect (see PARSER_DIALECTS).
function engineDialectOf(dialect: string): string {
  return PARSER_DIALECTS[dialect.toUpperCase()] ?? 'generic';
}

// Adds to `bound` each alias that `source`, the parser's tree of a FROM or
// JOIN item in a text of `dialect`, gives, as boundName gives it.
function addSourceAliases(
    source: any, bound: Set<string>, dialect: string): void {
  if (typeof source?.alias?.alias?.name === 'string') {
    bound.add(boundName(source.alias.alias, dialect));
  }
  const inner = source?.alias?.this ?? source;
  for (const kind of ['unnest', 'table', 'subquery']) {
    const node = inner?.[kind];
    if (typeof node?.alias?.name === 'string') {
      bound.add(boundName(node.alias, dialect));
    }
    if (typeof node?.offset_alias?.name === 'string') {
      bound.add(boundName(node.offset_alias, dialect));
    }
  }
}

// The name `id`, the parser's tree of a name in a text of `dialect`, with or
// without quotes, as nameKey gives it.
function boundName(id: any, dialect: string): string {
  return nameKey({name: String(id.name), quoted: id.quoted === true}, dialect);
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
// tokenize it. A MySQL text is read with its comments as MySQL reads them, and
// each span still counts from the start of `expression`. Throws when the
// engine is not loaded.
export function sqlTokens(expression: string, dialect: string): SqlToken[]|undefined {
  if (!loadedEngine) {
    throw new Error(
        'the SQL parser is not loaded; call loadSqlEngine() first');
  }
  const engineDialect = engineDialectOf(dialect);
  if (engineDialect !== 'mysql') {
    const res = loadedEngine.tokenize(expression, engineDialect);
    return res.success ? res.tokens ?? [] : undefined;
  }
  const at = mysqlForEngineAt(expression);
  const res = at.tokens ? {success: true, tokens: at.tokens} :
                          loadedEngine.tokenize(at.text, engineDialect);
  return res.success ? (res.tokens ?? []).map(t => ({
    ...t,
    span: {...t.span, start: at.from[t.span.start], end: at.from[t.span.end - 1] + 1},
  })) : undefined;
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
