// Adds translated target-dialect SQL entries to a Semantic Model's expressions
// by transpiling vendor SQL or ANSI_SQL that double-quotes column names.
//
// The loader (./loader) keeps every entry in `dialects` (and records
// `stringForm`), while still picking a target/canonical `expression` valid
// against the target (GoogleSQL/ANSI) and, when the source supplied a vendor
// variant, the first vendor SQL in `importedExpression` (+ `importedDialect`).
// When a node carries ONLY vendor entries (with no target or `ANSI_SQL` entry)
// or carries an `ANSI_SQL` entry that quotes column names with double quotes
// (which BigQuery reads as string literals), this pass translates that source
// SQL into the target dialect, appends `{dialect: target, expression: sql}` to
// `dialects`, and sets `stringForm` to `false`.
//
// It never overwrites an existing dialect entry or `expression`: a node that
// already has a target-dialect entry, or an `ANSI_SQL` entry without
// double-quoted column names, is untouched, so a model authored in
// GoogleSQL/unquoted ANSI is unaffected and its goldens are stable.
//
// Design:
//   - Target-agnostic and non-mutating: `transpileModel(model, {target,
//     transpiler})` returns a `structuredClone`, so the portable IR is
//     preserved. The mechanism is injectable so tests run hermetically; the
//     default adapter is the @polyglot-sql/sdk Rust/WASM engine, bundled into
//     the tool -- there is no external runtime dependency to install.
//   - Graceful degradation: if the engine fails to initialize, errors, meets a
//     construct import does not translate (see "What import translates"
//     below), or would alter which entities an expression references
//     (the qualifier-preservation guard), the node is left as it is and a
//     warning is emitted -- never a throw.
//

import {Field, ProfileSpec, SemanticModel, SqlDialect} from './ir';
import {columnReferences, entitiesReached} from './sql_expr_utils';
import {isSimpleIdentifier} from './sql_identifiers';
import {loadedSqlEngine, loadSqlEngine, PolyglotEngine, sqlExpressionTree} from './sql_parser';

// The target dialect this pass rewrites into. The whole point of the pass is to
// reach GoogleSQL/BigQuery, so it is fixed rather than a knob; the polyglot
// adapter still accepts any target token for reuse/testing.
const DEFAULT_TARGET = 'BIGQUERY';

// One expression to transpile. `id` correlates a response to its request; the
// caller assigns it and never interprets it.
export interface TranspileRequest {
  id: string;
  dialect: string;  // source dialect, as authored (e.g. 'DATABRICKS')
  expression: string;
}

// The result for one request: exactly one of `sql` (success) or `error` (the
// expression could not be transpiled and should be left to the imported form).
export interface TranspileResponse {
  id: string;
  sql?: string;
  error?: string;
}

// The pluggable transpilation mechanism. Must return one response per request
// (order-independent; correlated by `id`) and must not throw -- an unavailable
// or failing engine is reported per-request via `error`.
export type SqlTranspiler = (requests: TranspileRequest[], target: string) =>
    Promise<TranspileResponse[]>;

export interface TranspileOptions {
  target?: string;             // target dialect; default 'BIGQUERY'
  transpiler?: SqlTranspiler;  // mechanism; default `polyglotTranspiler`
  // Whether to translate the field bindings of `profile` of `model`. Defaults
  // to every profile.
  translatesProfile?: (profile: ProfileSpec, model: SemanticModel) => boolean;
}

export interface TranspileResult {
  model: SemanticModel;
  warnings: string[];
}

// A field, metric or profile field binding: what `transpileModel` reads and
// writes on one node.
type TranspileNode = Pick<
    Field, 'expression'|'dialects'|'stringForm'|'importedExpression'|
    'importedDialect'>;

// A pending rewrite: the imported expression to transpile plus a callback that
// applies the resulting SQL to the (cloned) IR node.
interface Pending {
  request: TranspileRequest;
  ctx: string;                    // human label for diagnostics
  accept: (sql: string) => void;  // writes the transpiled SQL into the clone
}

/**
 * Returns true if `expression`, read as generic SQL (`ANSI_SQL`), quotes a
 * column, table qualifier, or struct field with double quotes (`"..."`).
 *
 * The `ANSI_SQL` parser marks both `"..."` and `` `...` `` column identifiers
 * with `quoted: true`, whereas `BIGQUERY` marks only `` `...` `` as `quoted:
 * true` and treats `"..."` as a string literal (or fails to parse `."..."`).
 * Comparing how many `quotedNames` the two ASTs hold yields three cases:
 *   - `ANSI_SQL > BIGQUERY`: at least one column identifier is double-quoted
 *     (e.g., `"orders"."amount"` or `"amount"`).
 *   - `ANSI_SQL < BIGQUERY`: `expression` uses BigQuery-only syntax (such as a
 *     `# "comment"` line comment in `` `orders`.`col` # "comment" ``) that
 *     `BIGQUERY` parses while `ANSI_SQL` fails to parse (`count = 0`).
 *   - `ANSI_SQL === BIGQUERY`: any `"` is inside a string literal or comment
 *     (e.g., `` `orders`.`note` = 'a "quoted" ` string' ``), and any quoted
 *     column identifiers use backticks in both dialects.
 */
export function hasDoubleQuotedColumn(expression: string): boolean {
  if (!expression.includes('"')) return false;
  return quotedNames(sqlExpressionTree(expression, 'ANSI_SQL')).length >
      quotedNames(sqlExpressionTree(expression, 'BIGQUERY')).length;
}

/**
 * Returns the names that `expression` double-quotes, each once, for a
 * message: those the `ANSI_SQL` parser marks quoted that `expression` writes
 * in double quotes, else the first name it marks quoted.
 */
export function doubleQuotedNames(expression: string): string[] {
  const names = quotedNames(sqlExpressionTree(expression, 'ANSI_SQL'));
  const written =
      names.filter(n => expression.includes(`"${n.replaceAll('"', '""')}"`));
  return [...new Set(written.length ? written : names.slice(0, 1))];
}

/**
 * Returns the names of the quoted column, table qualifier, and struct field
 * identifiers (`quoted: true`) in a `@polyglot-sql/sdk` AST `node`, in tree
 * order, with a table qualifier before its column name.
 *
 * `@polyglot-sql/sdk` represents simple or table-qualified column references as
 * `{column: {name: {name, quoted}, table?: {name, quoted}}}` and chained
 * struct field accesses (such as `orders.addr."city"`) as
 * `{dot: {this: <base>, field: {name, quoted}}}`. When `sqlExpressionTree`
 * cannot parse an expression in the requested dialect, it returns `undefined`,
 * for which this function returns `[]`.
 */
function quotedNames(node: unknown): string[] {
  // Base case: `undefined` (when `sqlExpressionTree` fails to parse), `null`,
  // or primitive AST leaf values (`string`, `number`, `boolean`) have no quoted
  // column identifiers.
  if (!node || typeof node !== 'object') return [];
  const obj = node as Record<string, any>;
  const quoted = (id: any): string[] => id?.quoted === true ? [id.name] : [];
  // A `{column: {name, table}}` node represents a bare (`"col"`) or
  // table-qualified (`"orders"."col"`) column reference; take the optional
  // table qualifier and the column name separately whenever `quoted === true`.
  if (obj.column) {
    return [...quoted(obj.column.table), ...quoted(obj.column.name)];
  }
  // A `{dot: {this, field}}` node represents a struct subfield access (e.g.
  // `orders.addr."city"`); recurse into `this` for the base column or outer
  // struct path, and take `field` if `quoted === true`.
  if (obj.dot) {
    return [...quotedNames(obj.dot.this), ...quoted(obj.dot.field)];
  }
  // For any other AST container node (such as `sum`, `eq`, `case`) or array of
  // child AST nodes, recursively collect the names across all child values.
  return Object.values(obj).flatMap(quotedNames);
}

/**
 * Returns the source `{dialect, expression}` to translate into `target` for
 * `node`, or `undefined` when `node` should be left untouched.
 *
 * A field or metric is queued for translation in either of two cases:
 *   1. Its only texts are in vendor dialects, with no `target` or `ANSI_SQL`
 *      entry -> translate from the vendor dialect.
 *   2. It has an `ANSI_SQL` text that double-quotes a column identifier and no
 *      `target` entry -> translate from `ANSI_SQL`.
 */
function sourceToTranspile(node: TranspileNode, target: string):
    {dialect: string; expression: string}|undefined {
  // Parsed models store per-dialect SQL expressions in `node.dialects`.
  if (node.dialects?.length) {
    // Skip if `node` already has an explicit entry for the target dialect.
    if (node.dialects.some(d => d.dialect === target)) return undefined;
    // If `node` has a generic `ANSI_SQL` entry, `expressionForDialect` already
    // falls back to it for `target` unless it double-quotes a column
    // identifier (which `BIGQUERY` would read as a string literal). Only
    // transpile `ANSI_SQL` when it uses double-quoted columns; otherwise skip
    // transpilation even if vendor dialect entries are also present.
    const ansi = node.dialects.find(d => d.dialect === 'ANSI_SQL');
    if (ansi) {
      return hasDoubleQuotedColumn(ansi.expression) ?
          {dialect: 'ANSI_SQL', expression: ansi.expression} :
          undefined;
    }
    // Otherwise `node.dialects` contains only non-target vendor entries (e.g.
    // `SNOWFLAKE`), so transpile from the first vendor entry.
    const first = node.dialects[0];
    return {dialect: first.dialect, expression: first.expression};
  }
  // Hand-built in-memory IR may omit `node.dialects` and set a bare
  // `node.expression` (implicitly `ANSI_SQL`); only transpile it when it
  // double-quotes a column identifier.
  if (node.expression !== undefined) {
    return hasDoubleQuotedColumn(node.expression) ?
        {dialect: 'ANSI_SQL', expression: node.expression} :
        undefined;
  }
  // Hand-built in-memory IR may omit `node.dialects` and carry only a
  // vendor-specific `importedExpression`; transpile it from `importedDialect`
  // (falling back to `ANSI_SQL` if `importedDialect` was omitted).
  if (node.importedExpression) {
    return {
      dialect: node.importedDialect || 'ANSI_SQL',
      expression: node.importedExpression,
    };
  }
  // The node has no SQL expression of any kind, so leave it untouched.
  return undefined;
}

/**
 * Adds a translated `opts.target` dialect entry to every field, metric and
 * profile field binding in `model` whose only texts are in vendor dialects or
 * whose `ANSI_SQL` text double-quotes a column name, returning a cloned model
 * plus diagnostics.
 *
 * The input model is never mutated. When no node needs transpilation, the clone
 * is returned unchanged and the transpiler is not invoked. The
 * qualifier-preservation guard parses the transpiled output with
 * `columnReferences`, which requires the SQL parser to be loaded even when a
 * custom `opts.transpiler` is injected (`loadSqlEngine()` is awaited before
 * running the guard).
 */
export async function transpileModel(
    model: SemanticModel,
    opts: TranspileOptions = {}): Promise<TranspileResult> {
  const target = opts.target ?? DEFAULT_TARGET;
  const transpiler = opts.transpiler ?? polyglotTranspiler;
  const clone: SemanticModel = structuredClone(model);
  const entityNames = clone.entities.map(e => e.name);
  const warnings: string[] = [];

  await loadSqlEngine();
  const pending: Pending[] = [];
  const add = (node: TranspileNode, ctx: string) => {
    const source = sourceToTranspile(node, target);
    if (!source) return;
    const id = String(pending.length);
    pending.push({
      request: {id, dialect: source.dialect, expression: source.expression},
      ctx,
      accept: (sql: string) => {
        node.dialects = [
          ...(node.dialects ?? []),
          {dialect: target as SqlDialect, expression: sql},
        ];
        node.stringForm = false;
      },
    });
  };

  for (const e of clone.entities) {
    for (const f of e.fields) add(f, `field '${e.name}.${f.name}'`);
  }
  for (const r of clone.relationships) {
    // Direct FK edges carry no expressions; only an association (junction
    // table) has edge-property fields, and only when hand-built IR supplies
    // them.
    for (const f of r.association?.fields ?? []) {
      add(f, `relationship '${r.name}' field '${f.name}'`);
    }
  }
  for (const m of clone.metrics) add(m, `metric '${m.name}'`);
  for (const p of clone.profiles ?? []) {
    if (opts.translatesProfile && !opts.translatesProfile(p, clone)) continue;
    for (const pe of p.entities) {
      for (const f of pe.fields ?? []) {
        add(f, `profile '${p.name}': field '${pe.name}.${f.name}'`);
      }
    }
  }

  if (!pending.length) return {model: clone, warnings};

  const responses = await transpiler(pending.map(p => p.request), target);
  const byId = new Map(responses.map(r => [r.id, r]));

  for (const p of pending) {
    const {ctx, request} = p;
    const res = byId.get(request.id);
    if (!res || res.sql === undefined) {
      const reason = res?.error ?? 'no result returned';
      warnings.push(
          `${ctx}: could not transpile '${request.dialect}' -> '${target}' (${
              reason}); left untranslated`);
      continue;
    }
    // Qualifier-preservation guard: the BigQuery emitter locates measures and
    // strips qualifiers by matching `<Entity>.` case-sensitively (see
    // ./sql_expr_utils). A transpiler that re-cases a qualifier (`orders.` ->
    // `Orders.`) leaves SQL the emitter can no longer match, so the measure
    // would silently drop or misplace. Detect that on the OUTPUT with
    // `columnReferences`: every entity the transpiled SQL references
    // case-insensitively must also be matched case-sensitively -- i.e. kept in
    // the exact case the emitter needs. Comparing the output against itself
    // (rather than the vendor input) avoids false positives from dialect-
    // specific identifier quoting.
    const reached = qualifiersReached(res.sql, target, entityNames);
    if (!reached) {
      warnings.push(
          `${ctx}: transpiled '${request.dialect}' -> '${target}' could not ` +
          `be parsed; qualifier check was skipped`);
    } else if (!sameSet(reached.exact, reached.anyCase)) {
      warnings.push(
          `${ctx}: transpiled '${request.dialect}' -> '${target}' but it ` +
          `re-cased an entity qualifier the emitter matches case-sensitively ` +
          `(${fmtSet(reached.exact)} vs ${fmtSet(reached.anyCase)}); left ` +
          `untranslated`);
      continue;
    }
    p.accept(res.sql);
    warnings.push(`${ctx}: transpiled '${request.dialect}' -> '${target}'`);
    if (request.dialect === 'SQLSERVER') {
      warnings.push(
          `${ctx}: SQL Server text is translated to BigQuery on a ` +
          `best-effort basis, and the translator can get some T-SQL wrong; ` +
          `check the ${target} entry.`);
    }
  }

  return {model: clone, warnings};
}

// The entities among `entityNames` that `sql`, in `target`, qualifies a
// column with in their exact case and in any case, or undefined when the
// parser cannot read `sql`.
function qualifiersReached(sql: string, target: string, entityNames: string[]):
    {exact: string[]; anyCase: string[]}|undefined {
  const cols = columnReferences(sql, target);
  if (cols === undefined) return undefined;
  const anyCase = new Set(cols.flatMap(c => {
    const lower = c.qualifier?.toLowerCase();
    return entityNames.filter(n => n.toLowerCase() === lower);
  }));
  return {exact: entitiesReached(cols, entityNames), anyCase: [...anyCase]};
}

/**
 * Whether `transpileModel`, with the default translator, gives `node` a
 * BIGQUERY text in a model whose entities are `entityNames`. False until
 * `loadSqlEngine()` has loaded the engine.
 */
export function translatesToBigQuery(
    node: TranspileNode, entityNames: string[]): boolean {
  const source = sourceToTranspile(node, DEFAULT_TARGET);
  const engine = loadedSqlEngine();
  if (!source || !engine) return false;
  const {sql} = transpileWith(
      engine, {id: '', ...source}, polyglotDialect(DEFAULT_TARGET)!);
  if (sql === undefined) return false;
  const reached = qualifiersReached(sql, DEFAULT_TARGET, entityNames);
  return !reached || sameSet(reached.exact, reached.anyCase);
}

function sameSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every(x => s.has(x));
}

function fmtSet(names: string[]): string {
  return names.length ? `{${names.join(', ')}}` : '{}';
}


// --- polyglot-sql adapter (the default mechanism) ----------------------------

// Maps our dialect tokens (as authored in the AI-first format) to the
// @polyglot-sql/sdk dialect names (lower-case). ANSI_SQL maps to the engine's
// dialect-neutral 'generic' parser. An unknown token has no mapping and
// degrades to a per-request error (the imported form + warning).
const POLYGLOT_DIALECTS: Record<string, string> = {
  ANSI_SQL: 'generic',  // the engine's dialect-neutral parser
  BIGQUERY: 'bigquery',
  SPANNER: 'bigquery',
  POSTGRES: 'postgresql',
  ALLOYDB: 'postgresql',
  MYSQL: 'mysql',
  SQLSERVER: 'tsql',
  SNOWFLAKE: 'snowflake',
  DATABRICKS: 'databricks',
};

function polyglotDialect(token: string): string|undefined {
  if (!token) return undefined;
  return POLYGLOT_DIALECTS[token.toUpperCase()];
}

/**
 * The default {@link SqlTranspiler}: transpiles via the embedded
 * @polyglot-sql/sdk Rust/WASM engine. There is no external runtime dependency
 * -- the WASM blob is bundled into the tool. It never throws: an engine that
 * fails to initialize yields an `error` response for every request, and a
 * per-request parse failure or unsupported dialect yields an `error` for just
 * that request, so the caller degrades to the imported form + warning.
 */
export const polyglotTranspiler: SqlTranspiler = async (requests, target) => {
  if (!requests.length) return [];
  // Map the target to the engine's write dialect. A known token that maps to
  // 'generic' (ANSI_SQL) means dialect-neutral output and must be preserved.
  // An unknown target is an error for every request (symmetric with an unknown
  // source dialect below) rather than a silent fallback to BigQuery, which would
  // emit the wrong dialect while the caller's warning claimed the requested one.
  const write = polyglotDialect(target);
  if (write === undefined)
    return requests.map(
        r => ({id: r.id, error: `unsupported target dialect '${target}'`}));

  let engine: PolyglotEngine;
  try {
    engine = await loadSqlEngine();
  } catch (err) {
    const reason = `SQL transpiler engine unavailable: ${errMessage(err)}`;
    return requests.map(r => ({id: r.id, error: reason}));
  }

  return requests.map(r => transpileWith(engine, r, write));
};

// The engine's answer to `r`, with `write` as the engine's target dialect.
function transpileWith(
    engine: PolyglotEngine, r: TranspileRequest,
    write: string): TranspileResponse {
  const read = polyglotDialect(r.dialect);
  if (read === undefined)
    return {id: r.id, error: `unsupported source dialect '${r.dialect}'`};
  // A SPANNER text is BigQuery's SQL, and the lists below name its rules
  // 'spanner'.
  const spanner = r.dialect.toUpperCase() === 'SPANNER';
  try {
    // A text already in the target dialect needs no translation.
    if (read === write && !spanner) return {id: r.id, sql: r.expression};
    const source = read === 'mysql' ? mysqlDashes(engine, r.expression) : r.expression;
    // A comment that starts the text keeps the engine from translating the
    // functions in it, so the engine reads the text after it.
    const {text, comments} = sqlComments(engine, source, read);
    let repaired: {sql: string}|{error: string};
    if (write === 'bigquery') {
      const tree = sqlExpressionTree(text, r.dialect);
      const unknown = misreadToken(engine, source, read) ??
          (tree ? unknownConstruct(engine, tree, spanner ? 'spanner' : read) :
                  'a text it cannot read as one expression');
      if (unknown) return {id: r.id, error: `kcmd does not translate ${unknown}`};
      if (spanner) repaired = spannerForBigQuery(engine, tree);
    }
    repaired ??= engineTranslation(engine, text, r.dialect, read, write);
    if ('error' in repaired) return {id: r.id, error: repaired.error};
    // Each comment the engine did not keep goes last. The engine may space a
    // comment it keeps another way.
    const squash = (s: string) => s.replace(/\s+/g, '');
    const dropped = comments.filter(c => !squash(repaired.sql).includes(squash(c)));
    return {id: r.id, sql: [repaired.sql, ...dropped].join(' ')};
  } catch (err) {
    return {id: r.id, error: errMessage(err)};
  }
}

// The engine's translation of `text`, an expression in `dialect` that the
// engine reads as `read`, into the engine's dialect `write`, repaired for
// BigQuery, or an error.
function engineTranslation(
    engine: PolyglotEngine, text: string, dialect: string, read: string,
    write: string): {sql: string}|{error: string} {
  const sql = write === 'bigquery' && EXTRACT_FIRST.has(read) ?
      withExtract(engine, text, dialect, read) : text;
  const res = engine.transpile(sql, read, write);
  if (!res.success || !res.sql || res.sql.length === 0)
    return {error: res.error ?? 'transpilation produced no output'};
  // A field/metric is a single scalar expression, so the engine should
  // return exactly one statement. More than one means the input was not a
  // lone expression; taking [0] would silently drop the rest, so reject it.
  if (res.sql.length > 1)
    return {error: `expected a single expression but got ${res.sql.length} statements`};
  return write === 'bigquery' ? repairForBigQuery(engine, res.sql[0], read) :
                                {sql: res.sql[0]};
}

// `sql`, a MySQL text, with a space before and between two dashes that start
// no comment. MySQL starts a -- comment only before whitespace or the end of the
// text, so it reads `3--1` as 3 - -1, where the engine reads a comment to the
// end of the line. The gaps between the engine's tokens hold the comments. The
// rest of the line can hold strings and more dashes, so the engine reads the
// text again after each change.
function mysqlDashes(engine: PolyglotEngine, sql: string): string {
  for (;;) {
    const chars = [...sql];
    const tokens = engine.tokenize(sql, 'mysql').tokens ?? [];
    const gaps = [0, ...tokens.flatMap(t => [t.span.start, t.span.end]), chars.length];
    const spaces: number[] = [];
    for (let g = 0; g < gaps.length; g += 2) {
      const lineEnd = (i: number) => {
        const n = chars.indexOf('\n', i);
        return n < 0 || n > gaps[g + 1] ? gaps[g + 1] : n;
      };
      for (let i = gaps[g]; i < gaps[g + 1]; i++) {
        const two = chars[i] + (chars[i + 1] ?? '');
        if (two === '/*') {
          i += 2;
          while (i < gaps[g + 1] && chars[i] + chars[i + 1] !== '*/') i++;
          i++;
        } else if (chars[i] === '#' || (two === '--' && /^\s?$/.test(chars[i + 2] ?? ''))) {
          i = lineEnd(i);
        } else if (two === '--') {
          spaces.push(i, i + 1);
          i = lineEnd(i);
        }
      }
    }
    if (!spaces.length) return sql;
    for (const i of spaces.reverse()) chars.splice(i, 0, ' ');
    sql = chars.join('');
  }
}

// The text after the comments that start `sql`, in the engine's dialect
// `read`, and every comment in `sql`, each written as a block comment, as the
// engine writes a `--` comment. A comment marker inside a comment gets a space,
// since BigQuery does not nest comments.
function sqlComments(engine: PolyglotEngine, sql: string, read: string):
    {text: string; comments: string[]} {
  const tokens = engine.tokenize(sql, read).tokens ?? [];
  const comments = tokens.flatMap(t => [...t.comments, ...t.trailing_comments])
      .map(c => c.startsWith('/*') ? c.slice(2, -2) : ` ${c.trim()} `)
      .map(c => `/*${c.replaceAll('/*', '/ *').replaceAll('*/', '* /')}*/`);
  const start = tokens[0]?.comments.length ? tokens[0].span.start : 0;
  return {text: [...sql].slice(start).join(''), comments};
}

// The first token of `sql`, a text in the engine's dialect `read`, that the
// engine reads another way than the source, named for a message, or undefined.
// MySQL runs the SQL in a /*! comment, which the engine keeps as a comment, and
// reads a /*+ comment as an optimizer hint. MySQL and Databricks keep the
// backslash of \% and \_ in a string, which LIKE reads as a literal % or _,
// and the engine drops it. Databricks reads 'it''s' as two strings joined,
// and the engine as one string with a quote.
function misreadToken(engine: PolyglotEngine, sql: string, read: string):
    string|undefined {
  if (read !== 'mysql' && read !== 'databricks') return undefined;
  const chars = [...sql];
  for (const t of engine.tokenize(sql, read).tokens ?? []) {
    const comments = [...t.comments, ...t.trailing_comments];
    if (read === 'mysql' && comments.some(c => c.startsWith('/*!'))) {
      return 'a MySQL executable comment';
    }
    if (read === 'mysql' && t.token_type === 'HINT') return 'a MySQL optimizer hint';
    const written = chars.slice(t.span.start, t.span.end).join('');
    if (t.token_type.endsWith('STRING') && /(^|[^\\])(\\\\)*\\[%_]/.test(written)) {
      return `a string with ${/\\%/.test(written) ? '\\%' : '\\_'}`;
    }
    if (read === 'databricks' && t.token_type.endsWith('STRING') &&
        written.slice(1, -1).includes("''")) {
      return "a string with ''";
    }
  }
  return undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// --- What import translates ---------------------------------------------------
//
// Import translates a text only when every construct in it is on the lists
// below, each of which gives the source's value in BigQuery for ordinary data
// under the source's default settings, whatever the column types are. The
// exception is a MySQL date column plus a number, which is a number in MySQL
// and a date in BigQuery. Import cannot see a column's BigQuery type either.
// BigQuery rejects a translation that needs another type for a column, such as
// a DATETIME column compared with the current TIMESTAMP, and the author fixes
// that BIGQUERY entry. The engine writes the BigQuery SQL, and "BigQuery repairs"
// below rewrite what it writes wrong.

// The dialects that import translates from, by the engine's name, and
// 'spanner' for a SPANNER text, which the engine reads as BigQuery's SQL.
const DIALECTS = ['postgresql', 'mysql', 'tsql', 'snowflake', 'databricks', 'generic', 'spanner'];
const except = (...left: string[]) => DIALECTS.filter(d => !left.includes(d));

// The dialects that convert text, numbers and dates into each other where
// BigQuery needs a cast.
const CONVERTING = new Set(['mysql', 'tsql']);

// The kinds of node import translates, with the dialects it translates each
// from. PostgreSQL and SQL Server divide two integers as an integer, and SQL
// Server also averages them as an integer. MySQL rounds a quotient or an
// average to four decimal places. MySQL's LENGTH counts bytes, and SQL
// Server's LEN leaves out trailing spaces. The engine keeps the name of SQL
// Server's IIF, which BigQuery does not have, and writes its || as BigQuery's
// +. An ANSI_SQL text runs by the rules of its tables' database, so its `/`
// of two integers is an integer on PostgreSQL tables, and its AVG of integers
// an integer on SQL Server tables. A SPANNER text gives
// BigQuery's value except where Spanner applies its default time zone (see
// "SPANNER texts" below).
const KINDS: Record<string, string[]> = Object.fromEntries([
  ...['annotated', 'column', 'literal', 'boolean', 'paren', 'neg', 'add', 'sub',
      'mul', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'and', 'or', 'not', 'between',
      'in', 'is_null', 'case', 'coalesce', 'sum', 'count', 'min', 'max', 'trim',
      'upper', 'lower', 'like', 'abs', 'floor', 'ceil', 'cast',
      'try_cast'].map(kind => [kind, DIALECTS]),
  ['div', ['snowflake', 'databricks', 'spanner']], ['avg', except('mysql', 'tsql', 'generic')],
  ['length', except('mysql', 'tsql')],
  ['concat', except('tsql')], ['nvl', ['snowflake', 'databricks']],
  ['if_func', ['mysql', 'snowflake', 'databricks', 'spanner']], ['extract', except('tsql')],
  ...['safe_cast', 'round', 'timestamp', 'at_time_zone', 'interval'].map(
      kind => [kind, ['spanner']]),
  ...['year', 'quarter', 'month', 'day', 'hour', 'minute'].map(
      kind => [kind, ['mysql', 'snowflake', 'databricks', 'tsql']]),
]);

// The functions import translates, by name, with the dialects it translates
// each from and the fewest and most arguments it takes. PostgreSQL's and SQL
// Server's CONCAT skip a NULL, where BigQuery's gives NULL. PostgreSQL and
// MySQL round a FLOAT halfway between two numbers to the even one, and
// Databricks rounds a DOUBLE through its shortest decimal text. Databricks'
// date_sub of a timestamp gives a DATE, which the engine does not write. An
// ANSI_SQL ROUND of a FLOAT rounds to the even number on PostgreSQL tables.
// SPANNER_FUNCTIONS below lists Spanner's.
const FUNCTIONS: Record<string, [string[], number, number]> = {
  NULLIF: [except('spanner'), 2, 2],
  CONCAT: [['mysql', 'snowflake', 'databricks'], 1, Infinity],
  ROUND: [['tsql', 'snowflake'], 1, 2],
  CURRENT_DATE: [except('spanner'), 0, 0],
  CURDATE: [['mysql'], 0, 0],
  CURRENT_TIMESTAMP: [except('spanner'), 0, 0],
  NOW: [['postgresql', 'mysql', 'databricks'], 0, 0],
  GETDATE: [['tsql'], 0, 0],
  DATE_TRUNC: [['postgresql', 'snowflake', 'databricks'], 2, 2],
  DATE_PART: [['postgresql', 'snowflake', 'tsql'], 2, 2],
  DATEADD: [['snowflake', 'tsql', 'databricks'], 3, 3],
  DATE_ADD: [['mysql', 'databricks'], 2, 3],
  DATE_SUB: [['mysql'], 2, 2],
  DATEDIFF: [['tsql'], 3, 3],
};

// The parts of a node, by its kind, that import does not translate, each with
// its name for a message.
const AGGREGATE_CLAUSES = {
  filter: 'FILTER', order_by: 'ORDER BY', ignore_nulls: 'IGNORE NULLS or RESPECT NULLS',
};
const CLAUSES: Record<string, Record<string, string>> = {
  sum: AGGREGATE_CLAUSES, count: AGGREGATE_CLAUSES, avg: AGGREGATE_CLAUSES,
  min: AGGREGATE_CLAUSES, max: AGGREGATE_CLAUSES, in: {query: 'a subquery'},
  like: {escape: 'ESCAPE', quantifier: 'ANY or ALL'},
  between: {symmetric: 'SYMMETRIC'},
  trim: {characters: 'characters', position_explicit: 'BOTH, LEADING or TRAILING'},
  cast: {format: 'FORMAT'}, try_cast: {format: 'FORMAT'}, safe_cast: {format: 'FORMAT'},
  floor: {scale: 'a scale'}, ceil: {decimals: 'a scale'},
};

// The types import casts to, by castType's name, with the dialects it casts to
// each from. A type with a length, precision or scale is left out, since the
// engine drops it. A text type is left out, since a decimal or a timestamp
// becomes other text in BigQuery. The engine writes PostgreSQL's DOUBLE
// PRECISION and FLOAT with a name BigQuery does not have. MySQL's and
// Databricks' FLOAT, and REAL, are single precision. Snowflake's TIMESTAMP is
// TIMESTAMP_NTZ by default, its TIMESTAMP_TZ keeps each value's own offset, and
// its TIMESTAMP_LTZ is read in the session time zone. A SPANNER cast gives
// BigQuery's value, apart from the casts spannerNodes checks.
const CAST_TYPES: Record<string, string[]> = {
  date: DIALECTS, double: except('postgresql', 'spanner'),
  float: ['snowflake', 'tsql', 'generic'],
  timestamp: ['postgresql', 'snowflake', 'spanner'], timestamptz: ['postgresql'],
  TIMESTAMPNTZ: ['snowflake'],
  ...Object.fromEntries(['string', 'INT64', 'FLOAT64', 'decimal'].map(t => [t, ['spanner']])),
};

// The literals import translates. The repairs write a decimal number as a
// NUMERIC, which is exact as in the sources.
const LITERALS = new Set(['string', 'number', 'date']);

// A date as BigQuery reads it in a DATE literal or a cast to DATE. PostgreSQL
// also reads other forms, such as 2024/03/15, and ignores a time of day.
const PLAIN_DATE = /^\d{4}-\d\d?-\d\d?$/;

// BigQuery's name for each date part import translates, which the source
// writes in full.
const PARTS: Record<string, string> = {
  year: 'YEAR', quarter: 'QUARTER', month: 'MONTH', day: 'DAY', hour: 'HOUR',
  minute: 'MINUTE',
};

// DATE_TRUNC also takes a week, which starts on Monday in PostgreSQL,
// Snowflake and Databricks, as BigQuery's ISOWEEK does.
const TRUNC_PARTS: Record<string, string> = {...PARTS, week: 'ISOWEEK'};

// The parts that count months. BigQuery cannot add them to a TIMESTAMP, and
// kcmd cannot see a column's type, so it adds them only to a DATE it can see.
const MONTH_PARTS = new Set(['month', 'quarter', 'year']);

// The functions that give the current date or time.
const CURRENT = new Set(['CURRENT_DATE', 'CURDATE', 'CURRENT_TIMESTAMP', 'NOW', 'GETDATE']);

// The kinds of node that give a BOOL in BigQuery, and 1 or 0 in MySQL.
const BOOLEANS = new Set([
  'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'and', 'or', 'not', 'in', 'between',
  'like', 'is_null', 'boolean',
]);

// The kinds of node that compare two values.
const COMPARISONS = new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte']);

// The kinds of node that compare, which BigQuery does not chain.
const COMPARING = new Set([...COMPARISONS, 'is_null', 'like', 'in', 'between']);

// The kinds in COMPARING that each source dialect binds, tightest first, as
// its documentation orders them. The engine reads them all at one level from
// left to right, so import translates one without parentheses as an operand of
// another only where the dialect binds it tighter. MySQL also reads two of one
// level from left to right. PostgreSQL rejects two of one level, and Databricks
// does not say how it reads them. The other dialects are left out: Snowflake
// documents no order for these operators, Spanner needs parentheses as BigQuery
// does, SQL Server reads no comparison as a value, and an ANSI_SQL text runs by
// the rules of its tables' database.
const BINDING: Record<string, string[][]> = {
  postgresql: [['between', 'in', 'like'], [...COMPARISONS], ['is_null']],
  mysql: [[...COMPARISONS, 'is_null', 'like', 'in'], ['between']],
  databricks: [[...COMPARISONS], ['between', 'in', 'like', 'is_null']],
};

// The operators a message names, by kind.
const OPERATORS: Record<string, string> = {
  add: '+', sub: '-', mul: '*', neg: '-', eq: '=', neq: '<>', lt: '<', lte: '<=',
  gt: '>', gte: '>=', between: 'BETWEEN', in: 'IN', case: 'CASE', like: 'LIKE',
  is_null: 'IS NULL',
};

// The kind in COMPARING of `node`, an engine node, or undefined. The engine
// reads `s NOT LIKE p` as NOT of a LIKE.
function comparingKind(node: any): string|undefined {
  const kind = kindOf(node?.not?.this) === 'like' ? 'like' : kindOf(node);
  return COMPARING.has(kind!) ? kind : undefined;
}

// The operands of a node of `kind` in COMPARING, by name, first operand first.
// IN's list stands inside its own parentheses.
function operandNames(kind: string): string[] {
  return kind === 'is_null' || kind === 'in' ? ['this'] :
      kind === 'between' ? ['this', 'low', 'high'] : ['left', 'right'];
}

// The operator of `node`, a node comparingKind names, as written, for a message.
function operatorName(node: any): string {
  const kind = comparingKind(node)!;
  if (node.not) return 'NOT LIKE';
  const not: Record<string, string> =
      {is_null: 'IS NOT NULL', in: 'NOT IN', between: 'NOT BETWEEN'};
  return node[kind].not ? not[kind] : OPERATORS[kind];
}

// The message for `node`, a node comparingKind names in the engine's dialect
// `read`, when one of its operands compares too and import does not translate
// the pair, or undefined. Without parentheses, the source may group the two
// operators another way than the engine (see BINDING). BigQuery's LIKE also
// takes no BOOL, and its IN and BETWEEN take a BOOL only beside another BOOL,
// where some sources convert it.
function nestedComparison(node: any, read: string): string|undefined {
  const kind = comparingKind(node)!;
  const value = (node.not?.this ?? node)[kind];
  const levels = BINDING[read];
  const level = (k: string) => levels.findIndex(l => l.includes(k));
  for (const [i, name] of operandNames(kind).entries()) {
    const inner = comparingKind(value[name]);
    const grouped = !inner || (levels && (level(inner) < level(kind) ||
        (i === 0 && read === 'mysql' && level(inner) === level(kind))));
    if (grouped) continue;
    const [outer, operand] = [operatorName(node), operatorName(value[name])];
    const [first, second] = i === 0 ? [operand, outer] : [outer, operand];
    return `${first} and ${second} without parentheses, which databases group in different orders`;
  }
  const values = comparedValues(kind, value) ?? [value.left, value.right];
  return ['like', 'in', 'between'].includes(kind) && values.some(v => comparingKind(bare(v))) ?
      `${operatorName(node)} of a comparison` : undefined;
}

// The first construct in `node`, a source expression in the engine's dialect
// `read`, that import does not translate, named for a message, or undefined.
function unknownConstruct(engine: PolyglotEngine, node: any, read: string):
    string|undefined {
  if (!node || typeof node !== 'object') return undefined;
  // An array, an identifier, a data type or another part of a node.
  const next = isNode(node) ? nextNodes(kindOf(node)!, Object.values(node)[0], read) :
                              Object.values(node);
  if (next === undefined) return constructName(engine, node, read);
  if (typeof next === 'string') return next;
  for (const child of next) {
    const unknown = unknownConstruct(engine, child, read);
    if (unknown) return unknown;
  }
  return undefined;
}

// Whether `v` is an engine node: an object with one key, its kind, whose value
// is an object.
function isNode(v: any): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const values = Object.values(v);
  return values.length === 1 && !!values[0] && typeof values[0] === 'object' &&
      !Array.isArray(values[0]);
}

// The kind of `node`, an engine node, or undefined.
function kindOf(node: any): string|undefined {
  return isNode(node) ? Object.keys(node)[0] : undefined;
}

// The parts of a node of `kind` that import still has to check, the name of
// a construct in it import does not translate, or undefined when import does
// not translate the node.
function nextNodes(kind: string, value: any, read: string):
    unknown[]|string|undefined {
  const node = {[kind]: value};
  const nested = comparingKind(node) ? nestedComparison(node, read) : undefined;
  if (nested) return nested;
  // MySQL reads a comparison as the number 1 or 0 outside a condition, and
  // BigQuery gives a BOOL there.
  if (read === 'mysql') {
    const conditions = conditionValues(kind, value);
    const children = (kind === 'function' ? value.args ?? [] : Object.values(value)).flat(Infinity);
    if (children.some((c: any) => !conditions.includes(c) && BOOLEANS.has(kindOf(bare(c))!))) {
      const name = OPERATORS[kind] ?? value.original_name ?? (kind === 'function' ? value.name : kind);
      return `${String(name).toUpperCase()} of a comparison`;
    }
  }
  if (kind === 'function') return functionArgs(value, read);
  if (!KINDS[kind]?.includes(read)) return undefined;
  // An infix NOT, as in `x NOT IN`, sets a `not` flag on the node. A prefix
  // NOT wraps the node in a `not` node, so look through that wrapper to find
  // the node's own clauses.
  const wrapped = kind === 'not' ? kindOf(value?.this) : undefined;
  const [checkKind, checkValue, prefix] = wrapped && CLAUSES[wrapped] ?
      [wrapped, value.this[wrapped], 'NOT '] : [kind, value, value?.not ? 'NOT ' : ''];
  const written = (c: string) => c === 'ignore_nulls' ? c in checkValue :
      ![null, undefined, false].includes(checkValue[c]) && checkValue[c].length !== 0;
  const clause = Object.entries(CLAUSES[checkKind] ?? {}).find(([c]) => written(c));
  if (clause) return `${prefix}${checkKind.toUpperCase()} with ${clause[1]}`;
  const joined = kind === 'concat' && joinProblem('||', [value.left, value.right], read);
  if (joined) return joined;
  if (read === 'spanner') {
    const spanner = spannerNodes(kind, value);
    if (spanner) return spanner;
  }
  if (kind === 'literal') {
    if (value.literal_type === 'number' && !numberFits(value.value)) {
      return `the number ${value.value}`;
    }
    if (value.literal_type === 'date' && !PLAIN_DATE.test(value.value)) {
      return `DATE '${value.value}'`;
    }
    const type = value.literal_type.replaceAll('_', ' ');
    return LITERALS.has(value.literal_type) ? [] : `${article(type)} ${type} literal`;
  }
  if (kind === 'cast' || kind === 'try_cast' || kind === 'safe_cast') {
    return castProblem(kind, value, read) ?? [value.this];
  }
  if (kind === 'count' && bare(value.this)?.tuple) return 'COUNT of more than one value';
  if (kind === 'add' || kind === 'sub' || kind === 'mul') return arithmetic(kind, value, read);
  // The sources read a string beside AND, OR or NOT as a truth value or a
  // number, and BigQuery rejects it. MySQL reads `a || ' '` as OR.
  if (['and', 'or', 'not'].includes(kind) &&
      [value.left, value.right, value.this].some(n => bare(n)?.literal?.literal_type === 'string')) {
    return `${kind.toUpperCase()} of a string`;
  }
  // BigQuery cannot compare a TIMESTAMP with a DATE or a DATETIME, which the
  // sources compare.
  const compared = comparedValues(kind, value);
  if (compared) {
    const times = new Set(compared.map(v => timeType(v, read)));
    const other = ['DATE', 'DATETIME'].find(t => times.has(t));
    if (times.has('TIMESTAMP') && other) return `${OPERATORS[kind]} on a ${other} and a TIMESTAMP`;
  }
  // Snowflake and SQL Server have no default escape character in LIKE, where
  // BigQuery's is a backslash. SQL Server reads [ in a pattern as a set of
  // characters.
  if (kind === 'like') {
    const pattern = String(bare(value.right)?.literal?.value);
    if (['snowflake', 'tsql'].includes(read) && pattern.includes('\\')) {
      return 'LIKE with a backslash in its pattern';
    }
    if (read === 'tsql' && pattern.includes('[')) return 'LIKE with a bracket in its pattern';
  }
  if (kind === 'extract') {
    const part = String(partName(value.field));
    return PARTS[part.toLowerCase()] ? dateValue('EXTRACT', value.this) :
                                       `EXTRACT with part '${part.toUpperCase()}'`;
  }
  if (PARTS[kind]) return dateValue(kind.toUpperCase(), value.this);
  return Object.values(value);
}

// The values of a node of `kind` that MySQL reads as truth values: the
// operands of AND, OR and NOT, the conditions of a CASE without an operand
// and of IF, and the operand of IS NULL and COUNT, whose answer is the same
// for a BOOL. A value in parentheses stands where the parentheses stand.
function conditionValues(kind: string, value: any): unknown[] {
  return kind === 'and' || kind === 'or' ? [value.left, value.right] :
      ['not', 'is_null', 'count', 'paren', 'annotated'].includes(kind) ? [value.this] :
      kind === 'if_func' ? [value.condition] :
      kind === 'case' && !value.operand ? value.whens.map((w: any[]) => w[0]) : [];
}

// The name of a construct in `value`, a cast of `kind` in the
// engine's dialect `read`, that import does not translate, or undefined.
// BigQuery's CAST rejects a string with a time of day as a DATE, and its
// SAFE_CAST gives NULL, where the sources give the date. The engine writes
// Databricks' CAST as SAFE_CAST, and Snowflake's TRY_CAST to TIMESTAMP as a
// TIMESTAMP, where its CAST gives a TIMESTAMP_NTZ.
function castProblem(kind: string, value: any, read: string): string|undefined {
  const type = castType(value.to);
  const size = [value.to.length ?? value.to.precision, value.to.scale].filter(n => n != null);
  const name = kind === 'try_cast' ? 'TRY_CAST' : 'CAST';
  if (!CAST_TYPES[type]?.includes(read) || size.length) {
    return `${name} to ${typeName(type, read)}${size.length ? `(${size.join(', ')})` : ''}`;
  }
  if (kind === 'try_cast' && read === 'snowflake' && type === 'timestamp') return 'TRY_CAST to TIMESTAMP';
  if (type !== 'date') return undefined;
  const b = bare(value.this);
  const text = b?.literal?.literal_type === 'string' ? b.literal.value : undefined;
  if (text !== undefined && !PLAIN_DATE.test(text)) return `${name} to DATE of '${text}'`;
  return text === undefined && (kind !== 'cast' || read === 'databricks') ?
      `${name} to DATE of ${valueName(b)}` : undefined;
}

// Whether BigQuery reads `text`, a number literal, as the source does: an
// integer within INT64, or a decimal a BIGNUMERIC holds.
function numberFits(text: string): boolean {
  const [whole, fraction] = text.split('.');
  if (!/^\d*\.?\d*$/.test(text)) return false;
  if (fraction === undefined) return BigInt(whole || '0') <= 9223372036854775807n;
  return whole.replace(/^0+/, '').length <= 38 && fraction.length <= 38;
}

// The article for `noun`.
function article(noun: string): string {
  return /^[aeiou]/i.test(noun) ? 'an' : 'a';
}

// The operands of `+`, `-` or `*`, a node of `kind` in the engine's dialect
// `read`, to check next, or a message. The same SQL can give another value in
// BigQuery when import cannot see the operands' types: PostgreSQL's date minus
// date is a number of days, where BigQuery gives an INTERVAL. So import
// translates `+` and `-`, and `*` in MySQL and SQL Server, only beside a number
// literal or a SUM, COUNT or AVG, or with an INTERVAL of days, hours or minutes.
// MySQL and SQL Server read a date beside a number as a number or a count of
// days, and every source reads a string beside a number as a number. A date
// column is not visible, so a MySQL date column plus a number is translated.
// SPANNER arithmetic is BigQuery's.
function arithmetic(kind: string, value: any, read: string): unknown[]|string {
  const sides = [value.left, value.right];
  const op = OPERATORS[kind];
  const added = kind !== 'mul' && sides.find(s => s?.interval)?.interval;
  if (added) {
    return interval(added) ? sides.map(s => s.interval ? s.interval.this : s) :
                             `INTERVAL ${intervalText(added)}`;
  }
  if (sides.some(s => bare(s)?.literal?.literal_type === 'string')) return `${op} of a string`;
  const date = (s: any) => isDate(s) || CURRENT.has(String(bare(s)?.function?.name).toUpperCase());
  if (CONVERTING.has(read) && sides.some(date)) return `${op} of a date`;
  if ((kind === 'mul' && !CONVERTING.has(read)) || read === 'spanner') return sides;
  return sides.some(isNumber) ? sides :
      `${op} without a number, SUM, COUNT or AVG on one side`;
}

// The kinds of node and the functions that give a number, a BOOL, a date or a
// time, whatever their operands are.
const NOT_TEXT = new Set([
  ...BOOLEANS, 'neg', 'add', 'sub', 'mul', 'div', 'sum', 'count', 'avg', 'abs', 'floor',
  'ceil', 'length', 'extract', ...Object.keys(PARTS), ...CURRENT, 'ROUND', 'DATE_TRUNC',
  'DATE_PART', 'DATEADD', 'DATE_ADD', 'DATE_SUB', 'DATEDIFF',
]);

// The message for `op`, || or CONCAT in the engine's dialect `read`, when one
// of `parts` is visibly not text, or undefined. Such a value is a literal
// other than a string, a cast import translates, a number, date or time
// function, arithmetic or a comparison. Import translates no cast to text.
// BigQuery writes such a value in its own format, such as '12.5' for the
// NUMERIC 12.50. A column's type is not visible, so a join of columns is
// translated. Spanner joins only text.
function joinProblem(op: string, parts: any[], read: string): string|undefined {
  if (read === 'spanner') return undefined;
  const notText = parts.map(bare).some(b => {
    const kind = kindOf(b) ?? '';
    const cast = b?.cast ?? b?.try_cast;
    return NOT_TEXT.has(kind === 'function' ? String(b.function.name).toUpperCase() : kind) ||
        (cast && CAST_TYPES[castType(cast.to)]?.includes(read)) ||
        (kind === 'literal' && b.literal.literal_type !== 'string');
  });
  return notText ? `${op} of a value that is not text` : undefined;
}

// The values a node of `kind`, a comparison, BETWEEN, IN or a CASE with an
// operand, compares, or undefined for another kind.
function comparedValues(kind: string, value: any): any[]|undefined {
  return COMPARISONS.has(kind) ? [value.left, value.right] :
      kind === 'between' ? [value.this, value.low, value.high] :
      kind === 'in' ? [value.this, ...value.expressions] :
      kind === 'case' && value.operand ? [value.operand, ...value.whens.map((w: any[]) => w[0])] :
      undefined;
}

// BigQuery's type for `node`, a source value in the engine's dialect `read`,
// when the translation is visibly a DATE, a DATETIME or a TIMESTAMP: a DATE
// literal, a cast on the list, or the current date or time. The repairs write
// Snowflake's CURRENT_TIMESTAMP as a DATETIME.
function timeType(node: any, read: string): string|undefined {
  if (isDate(node)) return 'DATE';
  const b = bare(node);
  const name = String(b?.function?.name).toUpperCase();
  if (CURRENT.has(name)) return read === 'snowflake' ? 'DATETIME' : 'TIMESTAMP';
  const type = castType((b?.cast ?? b?.try_cast ?? b?.safe_cast)?.to);
  const types: Record<string, string> = {
    timestamp: read === 'spanner' ? 'TIMESTAMP' : 'DATETIME', TIMESTAMPNTZ: 'DATETIME',
    timestamptz: 'TIMESTAMP',
  };
  return CAST_TYPES[type]?.includes(read) ? types[type] : undefined;
}

// The arguments of `fn`, a source function call in the engine's dialect
// `read`, that import still has to check, the name of a construct in it
// import does not translate, or undefined when import does not translate it.
function functionArgs(fn: any, read: string): unknown[]|string|undefined {
  const name = String(fn.name).toUpperCase();
  const args: any[] = fn.args ?? [];
  if (read === 'spanner') return spannerArgs(name, args);
  const [dialects, fewest, most] = FUNCTIONS[name] ?? [[], 0, 0];
  if (!dialects.includes(read) || args.length < fewest || args.length > most) {
    return undefined;
  }
  if (name === 'CONCAT') return joinProblem(name, args, read) ?? args;
  const part = (arg: any) => String(partName(arg) ?? '?');
  if (name === 'DATE_TRUNC' || name === 'DATE_PART' || name === 'DATEDIFF') {
    const parts = name === 'DATE_TRUNC' ? TRUNC_PARTS : PARTS;
    if (!parts[part(args[0]).toLowerCase()]) {
      return `${name} with part '${part(args[0])}'`;
    }
    const values = args.slice(1).map(a => dateValue(name, a));
    return values.find(v => typeof v === 'string') ?? args.slice(1);
  }
  // DATEADD(day, 1, d), Databricks' DATE_ADD(d, 1), which adds days, and
  // MySQL's DATE_ADD(d, INTERVAL 1 DAY). BigQuery adds no hours or minutes to a
  // DATE, where the sources give a timestamp. Databricks' DATE_ADD(d, n) gives
  // a DATE, which the engine writes only when n is a number or negated.
  if (['DATEADD', 'DATE_ADD', 'DATE_SUB'].includes(name)) {
    const added = args.length === 2 ? args[1].interval : undefined;
    if (args.length === 2 && !added === (read === 'mysql')) return undefined;
    const [count, value] = args.length === 3 ? [args[1], args[2]] :
        [added ? added.this : args[1], args[0]];
    const unit = args.length === 3 ? part(args[0]).toLowerCase() :
        added ? interval(added, true) : 'day';
    if (!unit || !PARTS[unit] || unit === 'hour' || unit === 'minute') {
      return `${name} with ${args.length === 3 ? `part '${part(args[0])}'` :
                                                  `INTERVAL ${intervalText(added)}`}`;
    }
    if (/\./.test(numberText(count) ?? '')) return `${name} of a fraction`;
    if (MONTH_PARTS.has(unit) && !isDate(value)) {
      return `${name} of a ${unit} to a value that may be a TIMESTAMP`;
    }
    if (read === 'databricks' && args.length === 2 && numberText(count) === undefined &&
        !bare(count)?.neg && !isDate(value)) {
      return `${name} of a value that may be a TIMESTAMP`;
    }
    const values = dateValue(name, value);
    return typeof values === 'string' ? values : [count, ...values];
  }
  return args;
}

// `[node]`, the date or timestamp the date function `name` reads in the
// engine's dialect `read`, to check next, or a message. It may be a column, a
// DATE literal, a cast or the current date or time; BigQuery reads a string, a
// number or a sum another way, or rejects it.
function dateValue(name: string, node: any): unknown[]|string {
  const b = bare(node);
  const allowed = b?.column || b?.cast || b?.try_cast || b?.literal?.literal_type === 'date' ||
      CURRENT.has(String(b?.function?.name).toUpperCase());
  return allowed ? [node] : `${name} of ${valueName(b)}`;
}

// What `node`, a source value, is, for a message.
function valueName(node: any): string {
  const kind = kindOf(node) ?? '';
  const value = node?.[kind];
  const type = kind === 'literal' && value.literal_type.replaceAll('_', ' ');
  if (type) return `${article(type)} ${type}`;
  if (kind === 'cast' || kind === 'try_cast') return `a cast to ${typeName(castType(value.to), '')}`;
  if (kind === 'function') return String(value.name).toUpperCase();
  return {column: 'a column', add: 'a sum', sub: 'a difference'}[kind] ?? 'an expression';
}

// The unit of `value`, an engine interval such as INTERVAL '1' DAY or
// PostgreSQL's INTERVAL '1 day', in lower case, when import translates it: a
// whole number of days, hours or minutes. An interval of months is translated
// only in a function that adds it, with `adds`.
function interval(value: any, adds = false): string|undefined {
  const text = numberText(value?.this) ?? literalText(bare(value?.this)?.literal);
  const unit = value?.unit === null ? stringUnit(text)?.unit :
      value?.unit?.type === 'simple' && (text === undefined || /^\s*[+-]?\d+\s*$/.test(text)) ?
      String(value.unit.unit).toLowerCase() : undefined;
  return unit && PARTS[unit] && (adds || !MONTH_PARTS.has(unit)) ? unit : undefined;
}

// `value`, an engine interval, as the source writes it after INTERVAL, for a
// message. Its unit is a name, such as DAY, a node, such as DAY(9), or a span
// of two of either, such as HOUR TO MINUTE.
function intervalText(value: any): string {
  const text = numberText(value?.this) ?? literalText(bare(value?.this)?.literal) ?? '?';
  const spec = value?.unit;
  const unit = !spec ? undefined : spec.type === 'simple' ? unitName(spec.unit) :
      spec.type === 'expr' ? unitName(spec) :
      `${unitName(spec.this)} TO ${unitName(spec.expression)}`;
  return unit ? `${text} ${unit}` : `'${text}'`;
}

// `unit`, an interval unit as the engine reads it, for a message. The engine
// gives a name such as `Day`, a `var` node such as DAY, a node such as DAY(9)
// whose kind is the unit, or a function such as WEEK(2).
function unitName(unit: any): string {
  if (typeof unit === 'string') return unit.toUpperCase();
  if (unit?.var) return String(unit.var.this).toUpperCase();
  const kind = Object.keys(unit ?? {}).find(k => k !== 'type') ?? '?';
  const value = unit?.[kind];
  const name = kind === 'function' ? String(value.name) : kind;
  const sizes = (value?.args ?? [value?.this]).map(numberText).filter((s: any) => s !== undefined);
  return `${name.toUpperCase()}${sizes.length ? `(${sizes.join(', ')})` : ''}`;
}

// The text of `literal`, an engine literal. The engine gives a triple-quoted
// string as its text and its quote.
function literalText(literal: any): string|undefined {
  return Array.isArray(literal?.value) ? literal.value[0] : literal?.value;
}

// The amount and the unit, in lower case, of an interval string such as
// '1 day' or '2 hours', or undefined for another string.
function stringUnit(text: unknown): {amount: string; unit: string}|undefined {
  const [, amount, unit] =
      /^\s*([+-]?\d+)\s*([a-z]+?)s?\s*$/i.exec(String(text)) ?? [];
  return unit ? {amount, unit: unit.toLowerCase()} : undefined;
}

// `node` without the parentheses around it, or the comment after it.
function bare(node: any): any {
  while (node?.paren || node?.annotated) node = (node.paren ?? node.annotated).this;
  return node;
}

// The text of `node`, a source value, when it is a number literal, with its
// sign.
function numberText(node: any): string|undefined {
  const b = bare(node);
  const literal = b?.neg ? bare(b.neg.this)?.literal : b?.literal;
  return literal?.literal_type === 'number' ? `${b?.neg ? '-' : ''}${literal.value}` : undefined;
}

// Whether `node`, a source value, is visibly a number: a number literal, or a
// SUM, COUNT or AVG.
function isNumber(node: any): boolean {
  const b = bare(node);
  return numberText(b) !== undefined || !!(b?.sum ?? b?.count ?? b?.avg);
}

// Whether `node`, a source value, is a DATE: CURRENT_DATE, CURDATE, a DATE
// literal, or a CAST or TRY_CAST to DATE.
function isDate(node: any): boolean {
  const b = bare(node);
  const name = String(b?.function?.name).toUpperCase();
  return castType((b?.cast ?? b?.try_cast)?.to) === 'date' ||
      b?.literal?.literal_type === 'date' || name === 'CURRENT_DATE' ||
      name === 'CURDATE';
}

// The name of `to`, an engine data type, in CAST_TYPES.
function castType(to: any): string {
  return to?.real_spelling ? 'real' : to?.data_type === 'custom' ? to.name :
      to?.data_type === 'timestamp' && to.timezone ? 'timestamptz' : to?.data_type;
}

// `type`, a name in CAST_TYPES, as the engine's dialect `read` writes it, for
// a message.
function typeName(type: string, read: string): string {
  if (read === 'postgresql' && type === 'double') return 'DOUBLE PRECISION';
  if (read === 'snowflake' && type === 'timestamptz') return 'TIMESTAMP_TZ';
  // The engine's names for Snowflake's TIMESTAMP_LTZ and TIMESTAMP_NTZ.
  return /^TIMESTAMP[LN]TZ/.test(type) ? type.replace('TIMESTAMP', 'TIMESTAMP_') :
                                         String(type).replace('_', '').toUpperCase();
}

// The name of the construct `node` is, for a message: the name of a function
// as written, such as MEDIAN, or an operator, such as `/`, as the engine writes
// it in `read`, or else the engine's kind of node.
function constructName(engine: PolyglotEngine, node: any, read: string): string {
  const [kind, value] = Object.entries(node)[0] as [string, any];
  // A `raw` node is SQL the engine kept as one unparsed string, such as a
  // prefix NOT before LIKE in most dialects, so there is no operand to swap
  // for a placeholder column before generating it again. Name it as written.
  if (kind === 'raw') return value.sql;
  const written = [value.original_name, value.name].find(n => typeof n === 'string');
  if (written) return written.toUpperCase();
  if (kind === 'window_function') return 'OVER';
  // The node with a column `x` for each node in it.
  const x = {column: {name: {name: 'x', quoted: false}, table: null}};
  const bareNode = Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, Array.isArray(v) ? v.map(e => isNode(e) ? x : e) : isNode(v) ? x : v]));
  const sql = engine.generate([{[kind]: bareNode}], read === 'spanner' ? 'bigquery' : read).sql?.[0] ?? '';
  const called = /^([A-Za-z_]\w*)\s*\(/.exec(sql)?.[1];
  const operator = sql.replace(/\bx\b/g, '').trim();
  const plain = /^[^()[\].,]+$/.test(operator) ? operator : kind.replaceAll('_', ' ');
  return (called ?? plain).toUpperCase();
}

// The dialects that have YEAR(d), MONTH(d) and similar functions. The engine
// writes them to BigQuery with `d` left in the source dialect.
const EXTRACT_FIRST = new Set(['mysql', 'snowflake', 'databricks', 'tsql']);

// `sql`, in the engine's dialect `read`, with YEAR(d) and the other functions
// of PARTS written as EXTRACT, whose argument the engine translates.
function withExtract(
    engine: PolyglotEngine, sql: string, dialect: string, read: string): string {
  let changed = false;
  const tree = mapTree(sqlExpressionTree(sql, dialect), node => {
    const kind = Object.keys(PARTS).find(k => node[k]?.this);
    if (!kind) return undefined;
    changed = true;
    return {extract: {this: node[kind].this, field: extractField(kind)}};
  });
  if (!changed) return sql;
  const written = engine.generate([tree], read);
  return written.success && written.sql?.length === 1 ? written.sql[0] : sql;
}

// The engine's EXTRACT field for `part`, a key of PARTS, such as `Year`.
function extractField(part: string): string {
  return part[0].toUpperCase() + part.slice(1);
}

// `node` with each node in it, children first, replaced by what `visit` gives
// for it, or kept when `visit` gives undefined.
function mapTree(node: any, visit: (node: any) => unknown): any {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(n => mapTree(n, visit));
  const out: any = {};
  for (const [k, v] of Object.entries(node)) out[k] = mapTree(v, visit);
  return visit(out) ?? out;
}

// --- BigQuery repairs ---------------------------------------------------------
//
// The engine (@polyglot-sql/sdk 0.9.1, and still 0.13.4) reads DATE_TRUNC and
// DATE_PART as functions it does not know and writes them to BigQuery as they
// were. It also keeps an interval string such as `INTERVAL '1 day'`, the name
// of Snowflake's TIMESTAMP_NTZ, and a comparison, IS NULL, LIKE, IN or BETWEEN
// of another without parentheses. BigQuery rejects each of these, and the
// engine reports success.
// It keeps TRIM(s), a decimal number such as 0.29, Snowflake's current date and
// time, and Snowflake's division and average, which give another value in
// BigQuery. So the adapter reads the engine's BigQuery output back and
// rewrites them.

// The types BigQuery has for Snowflake's TIMESTAMP_NTZ, a wall-clock time.
const SNOWFLAKE_TYPES: Record<string, unknown> = {
  TIMESTAMPNTZ: {data_type: 'custom', name: 'DATETIME'},
};

// `sql`, the engine's BigQuery output from the engine's dialect `read`, with
// the forms above rewritten, or an error when the engine cannot write the
// result. A text the engine cannot read back is returned as it is;
// transpileModel's qualifier check reports it.
function repairForBigQuery(engine: PolyglotEngine, sql: string, read: string):
    {sql: string}|{error: string} {
  const tree = sqlExpressionTree(sql, 'BIGQUERY');
  if (!tree) return {sql};
  let changed = false;
  const result = mapTree(tree, node => {
    // The engine reads BigQuery's TIMESTAMP as a timestamp without time zone,
    // which it writes as DATETIME.
    if (node.data_type === 'timestamp') node.timezone = true;
    const dated = withPlainDates(node);
    const repaired = repairNode(dated ?? node, read) ?? dated;
    if (repaired !== undefined) changed = true;
    return repaired;
  });
  if (!changed) return {sql};
  const written = engine.generate([result], 'bigquery');
  if (!written.success || written.sql?.length !== 1) {
    return {error: written.error ?? 'the repaired SQL could not be written'};
  }
  return {sql: written.sql[0]};
}

// The node to put in place of `node`, an engine node of BigQuery SQL from the
// engine's dialect `read`, or undefined to keep it.
function repairNode(node: any, read: string): unknown {
  const fn = node.function;
  const args: any[] = fn?.args ?? [];
  const name = String(fn?.name).toUpperCase();
  // Snowflake reads the current date and time in the session time zone,
  // America/Los_Angeles by default. A TIMESTAMP_NTZ column, its default, is
  // compared with the current time as a wall-clock time there.
  if (read === 'snowflake' && fn && !args.length && SNOWFLAKE_NOW[name]) {
    return sqlExpressionTree(SNOWFLAKE_NOW[name], 'BIGQUERY');
  }
  // Snowflake divides and averages a NUMBER, and PostgreSQL averages an
  // integer or a NUMERIC, as an exact decimal, and BigQuery as a FLOAT64 unless
  // a value is a NUMERIC. A Snowflake FLOAT or PostgreSQL double precision
  // column then gets BigQuery's exact value where the source's is a double.
  if ((read === 'snowflake' && node.div) ||
      (['snowflake', 'postgresql'].includes(read) && node.avg)) {
    return node.div ? {div: {...node.div, left: asNumeric(node.div.left)}} :
                      {avg: {...node.avg, this: asNumeric(node.avg.this)}};
  }
  // BigQuery needs parentheses around an operand of a comparison that
  // compares too.
  const compares = kindOf(node);
  if (COMPARING.has(compares!)) {
    const value = node[compares!];
    const wrapped = operandNames(compares!).filter(n => comparingKind(value[n]));
    if (wrapped.length) {
      const parens = wrapped.map(n => [n, {paren: {this: value[n]}}]);
      return {[compares!]: {...value, ...Object.fromEntries(parens)}};
    }
  }
  // BigQuery's own DATE_TRUNC(d, MONTH) names its part last, unquoted.
  // The engine may already have written that form, with a column first.
  const written = bare(args[0])?.literal;
  const truncPart = name === 'DATE_TRUNC' && args.length === 2 &&
      written?.literal_type === 'string' && TRUNC_PARTS[written.value.toLowerCase()];
  if (truncPart) {
    // The engine reads a lone name in the part position as a `var` node
    // without its quotes, so put it back as a column, quoted if it must be.
    const col = args[1].var?.this;
    const date = col === undefined ? args[1] : {
      column: {name: {name: col, quoted: !isSimpleIdentifier(col)}, table: null},
    };
    return {function: {...fn, args: [date, {var: {this: truncPart}}]}};
  }
  // DATE_PART, and the EXTRACT the engine writes for Snowflake and T-SQL as a
  // DATE_PART.
  const part = name === 'DATE_PART' && args.length === 2 &&
      partName(args[0])?.toLowerCase();
  if (part && PARTS[part]) {
    return {extract: {this: args[1], field: extractField(part)}};
  }
  if (node.data_type === 'custom' && SNOWFLAKE_TYPES[node.name]) {
    return SNOWFLAKE_TYPES[node.name];
  }
  // BigQuery's TRIM(s) removes every kind of whitespace, and the sources' TRIM
  // only spaces.
  if (node.trim && node.trim.characters === null) {
    const characters = {literal: {literal_type: 'string', value: ' '}};
    return {trim: {...node.trim, characters, sql_standard_syntax: false}};
  }
  // A decimal number is exact in the sources, and a FLOAT64 in BigQuery, so it
  // becomes a NUMERIC, or a BIGNUMERIC when a NUMERIC cannot hold it. The engine
  // writes a `var` node's text as it is.
  const decimal = node.literal?.literal_type === 'number' &&
      /^(\d*)\.(\d*)$/.exec(node.literal.value);
  if (decimal) {
    const big = decimal[1].replace(/^0+/, '').length > 29 || decimal[2].length > 9;
    return {var: {this: `${big ? 'BIGNUMERIC' : 'NUMERIC'} '${node.literal.value}'`}};
  }
  const text = node.interval?.unit === null &&
      node.interval.this?.literal?.literal_type === 'string' &&
      stringUnit(node.interval.this.literal.value);
  if (text && PARTS[text.unit]) {
    return {
      interval: {
        this: {literal: {literal_type: 'number', value: text.amount}},
        unit: {type: 'simple', unit: extractField(text.unit), use_plural: false},
      },
    };
  }
  return undefined;
}

// `node`, an engine node of BigQuery SQL, with each cast of a date string to
// DATE that it compares with a value other than a literal written as the plain
// string, or undefined when it has none. The engine writes a DATE literal as
// such a cast, and BigQuery does not compare a DATE with a TIMESTAMP. BigQuery
// reads the plain string in the other value's type, so the field works on a
// DATE, DATETIME or TIMESTAMP column. A TIMESTAMP gets midnight UTC, the
// midnight the sources use under their default settings. A string with a time
// of day keeps its cast. A SPANNER text keeps its DATE literal, since Spanner
// compares one only with a DATE.
function withPlainDates(node: any): unknown {
  const kind = kindOf(node) ?? '';
  const value = node[kind];
  const compared = comparedValues(kind, value) ?? [];
  const date = (n: any) => {
    const cast = bare(n)?.cast;
    const text = castType(cast?.to) === 'date' ? cast.this?.literal : undefined;
    return text?.literal_type === 'string' && PLAIN_DATE.test(text.value) ?
        {literal: text} : undefined;
  };
  if (!compared.some(date) || compared.every(n => date(n) || bare(n)?.literal)) {
    return undefined;
  }
  const plain = (n: any) => date(n) ?? n;
  return {
    [kind]: COMPARISONS.has(kind) ? {...value, left: plain(value.left), right: plain(value.right)} :
        kind === 'between' ?
        {...value, this: plain(value.this), low: plain(value.low), high: plain(value.high)} :
        kind === 'in' ? {...value, this: plain(value.this), expressions: value.expressions.map(plain)} :
        {...value, operand: plain(value.operand),
         whens: value.whens.map((w: any[]) => [plain(w[0]), ...w.slice(1)])},
  };
}

// BigQuery's SQL for Snowflake's current date and time, by function name.
const SNOWFLAKE_NOW: Record<string, string> = {
  CURRENT_DATE: "CURRENT_DATE('America/Los_Angeles')",
  CURRENT_TIMESTAMP: "CURRENT_DATETIME('America/Los_Angeles')",
};

// `node`, an engine node of BigQuery SQL, cast to NUMERIC.
function asNumeric(node: unknown): unknown {
  const cast = sqlExpressionTree('CAST(x AS NUMERIC)', 'BIGQUERY');
  return {cast: {...cast.cast, this: node}};
}

// The date part `part` names, or undefined. `part` is EXTRACT's field, which
// the engine gives as a name such as `Month`, or as {Custom} or
// {WeekWithModifier} for ISOWEEK or WEEK(MONDAY). Or it is a date function's
// argument: a string, a bare name, which the engine reads as a `var` or a
// column, or WEEK(MONDAY), which it reads as a function.
function partName(part: any): string|undefined {
  if (typeof part === 'string') {
    return ({TimezoneHour: 'TIMEZONE_HOUR', TimezoneMinute: 'TIMEZONE_MINUTE'} as
            Record<string, string>)[part] ?? part.toUpperCase();
  }
  if (part?.WeekWithModifier !== undefined) return `WEEK(${part.WeekWithModifier})`;
  if (part?.Custom !== undefined) return part.Custom;
  const b = bare(part);
  if (b?.literal?.literal_type === 'string') return b.literal.value;
  if (b?.var) return b.var.this;
  if (b?.column && !b.column.table) return b.column.name?.name;
  const fn = b?.function;
  const day = String(fn?.name).toUpperCase() === 'WEEK' && fn.args?.length === 1 &&
      partName(fn.args[0]);
  return day ? `${fn.name}(${day})` : undefined;
}

// --- SPANNER texts --------------------------------------------------------------
//
// A SPANNER text is BigQuery's SQL, but Spanner reads the date and time of a
// TIMESTAMP in its default time zone, America/Los_Angeles, where BigQuery reads
// them in UTC. So a SPANNER text goes through the lists above like any other
// text, and import writes that time zone into each function on them that would
// apply the default. Where it cannot tell whether the default applies, the
// text is left untranslated. A time zone the author wrote stays as it is.

const SPANNER_ZONE = "'America/Los_Angeles'";

// The functions import translates from SPANNER, with the fewest and most
// arguments each takes.
const SPANNER_FUNCTIONS: Record<string, [number, number]> = {
  NULLIF: [2, 2], CONCAT: [1, Infinity], CURRENT_TIMESTAMP: [0, 0],
  CURRENT_DATE: [0, 1], DATE: [1, 3], TIMESTAMP_TRUNC: [2, 3], FORMAT_TIMESTAMP: [2, 3],
  PARSE_TIMESTAMP: [2, 3], PARSE_DATE: [2, 2], STRING: [1, 2],
  TIMESTAMP_ADD: [2, 2], TIMESTAMP_SUB: [2, 2], TIMESTAMP_DIFF: [3, 3],
  DATE_ADD: [2, 2], DATE_SUB: [2, 2], DATE_DIFF: [3, 3], DATE_TRUNC: [2, 2],
};

// The functions that take a time zone as an optional last argument, by name,
// with the number of arguments before it.
const ZONE_ARGS: Record<string, number> = {
  CURRENT_DATE: 0, DATE: 1, TIMESTAMP_TRUNC: 2, FORMAT_TIMESTAMP: 2, PARSE_TIMESTAMP: 2,
};

// The parts of EXTRACT a DATE has. The others need a TIMESTAMP.
const SPANNER_DATE_PARTS = new Set([
  'YEAR', 'ISOYEAR', 'QUARTER', 'MONTH', 'WEEK', 'ISOWEEK', 'DAY', 'DAYOFWEEK',
  'DAYOFYEAR',
]);

// The parts of EXTRACT Spanner has. Spanner has no WEEK(<weekday>).
const SPANNER_PARTS = new Set([
  ...SPANNER_DATE_PARTS, 'NANOSECOND', 'MICROSECOND', 'MILLISECOND', 'SECOND', 'MINUTE', 'HOUR',
  'DATE',
]);

// The Spanner functions that visibly give a DATE or a TIMESTAMP.
const SPANNER_DATES = new Set(['CURRENT_DATE', 'DATE', 'DATE_ADD', 'DATE_SUB', 'DATE_TRUNC', 'PARSE_DATE']);
const SPANNER_TIMESTAMPS = new Set([
  'CURRENT_TIMESTAMP', 'TIMESTAMP_ADD', 'TIMESTAMP_SUB', 'TIMESTAMP_TRUNC',
  'TIMESTAMP_SECONDS', 'TIMESTAMP_MILLIS', 'TIMESTAMP_MICROS', 'PARSE_TIMESTAMP',
]);

// A date, or a date and time of day, without a time zone or offset. Spanner
// reads such a string in its default time zone where it needs a TIMESTAMP.
// Spanner and BigQuery read the time zone of any other string the same way,
// or both reject the string.
const PLAIN_TIME = /^\s*\d+-\d\d?-\d\d?([Tt ]\d\d?:\d\d?(:\d\d?(\.\d*)?)?)?\s*$/;

// Whether `literal`, an engine literal, is a string of PLAIN_TIME.
function dateString(literal: any): boolean {
  return literal?.literal_type === 'string' && PLAIN_TIME.test(literal.value);
}

// Whether `node`, the value of a SPANNER EXTRACT, ends with AT TIME ZONE. The
// engine reads `t - INTERVAL 1 HOUR AT TIME ZONE 'UTC'` with the time zone on
// the INTERVAL, and Spanner and BigQuery read it as EXTRACT's.
function zoned(node: any): boolean {
  for (let b = bare(node); b; b = bare((b.add ?? b.sub)?.right)) {
    if (b.at_time_zone) return true;
  }
  return false;
}

// What `node`, a SPANNER value, visibly is: the engine's literal type,
// 'column', 'interval', a type a cast gives, 'date' or 'timestamp'. A
// difference of two dates, timestamps or columns is an interval.
function spannerType(node: any): string|undefined {
  const b = bare(node);
  const kind = kindOf(b) ?? '';
  const value = b?.[kind];
  const name = String(value?.name).toUpperCase();
  const timeOrColumn = (n: any) => ['timestamp', 'date', 'column'].includes(spannerType(n)!);
  return kind === 'literal' ? value.literal_type : kind === 'column' ? 'column' :
      kind === 'interval' || (kind === 'sub' && timeOrColumn(value.left) && timeOrColumn(value.right)) ?
      'interval' : kind === 'cast' || kind === 'safe_cast' ? value.to.data_type :
      kind === 'timestamp' || SPANNER_TIMESTAMPS.has(name) ? 'timestamp' :
      SPANNER_DATES.has(name) ? 'date' : undefined;
}

// The parts of a SPANNER node of `kind` that import still has to check, the
// name of a construct in it import does not translate, or undefined to check
// the node as any other. A date string without a time zone is translated only
// where Spanner visibly reads it as a string or a DATE, or where import
// writes the time zone for it.
function spannerNodes(kind: string, value: any): unknown[]|string|undefined {
  const rest = (...used: unknown[]) =>
      Object.values(value).flat(Infinity).filter(c => !used.includes(c));
  const stringLiteral = (n: any) => bare(n)?.literal?.literal_type === 'string';
  if (kind === 'literal') {
    if (value.literal_type === 'timestamp') return [];
    return dateString(value) ? 'a date string that Spanner may read as a TIMESTAMP' : undefined;
  }
  const compared = comparedValues(kind, value);
  const strings = compared?.filter(v => dateString(bare(v)?.literal)) ?? [];
  if (strings.length) {
    return compared!.every(v => ['string', 'date'].includes(spannerType(v)!)) ? rest(...strings) :
        `${OPERATORS[kind]} of a date string and a value that may be a TIMESTAMP`;
  }
  if (kind === 'timestamp') {
    if (stringLiteral(value.this)) return rest(value.this);
    return value.zone || spannerType(value.this) === 'date' ? rest() :
        'TIMESTAMP of a value that may be a string with its own time zone';
  }
  if (kind === 'extract') {
    const part = String(partName(value.field)).toUpperCase();
    if (!SPANNER_PARTS.has(part)) return `EXTRACT with part '${part}'`;
    const type = zoned(value.this) ? 'zoned' : spannerType(value.this);
    if (type === 'string') return 'EXTRACT of a string';
    if (!['zoned', 'interval', 'date', 'timestamp'].includes(type!) && SPANNER_DATE_PARTS.has(part)) {
      return `EXTRACT of ${part} from a value that may be a TIMESTAMP`;
    }
    return [value.this];
  }
  if (kind === 'interval') {
    return value.unit?.type === 'simple' ? [value.this] : `INTERVAL ${intervalText(value)}`;
  }
  if (kind === 'cast' || kind === 'safe_cast') {
    // CAST(x AS DATE), CAST(x AS STRING) read a TIMESTAMP in the default time
    // zone, and CAST(x AS TIMESTAMP) a string or a DATE. BigQuery's CAST takes
    // no time zone.
    const problem = castProblem('cast', value, 'spanner');
    const to = castType(value.to);
    const type = spannerType(value.this);
    if (problem) return problem;
    if (stringLiteral(value.this)) return [];
    if (to === 'date' && type !== 'date') return 'CAST to DATE of a value that may be a TIMESTAMP';
    if (to === 'string' && !['date', 'number', 'interval'].includes(type!)) {
      return 'CAST to STRING of a value that may be a TIMESTAMP';
    }
    if (to === 'timestamp' && type !== 'timestamp') {
      return 'CAST to TIMESTAMP of a value that may be a string or a DATE';
    }
    return [value.this];
  }
  return undefined;
}

// The arguments of a SPANNER call of `name` that import still has to check,
// the name of a construct in it import does not translate, or undefined when
// import does not translate the call. A string where Spanner reads a
// TIMESTAMP is read in the default time zone, even when the author wrote one.
function spannerArgs(name: string, args: any[]): unknown[]|string|undefined {
  const [fewest, most] = SPANNER_FUNCTIONS[name] ?? [1, 0];
  if (args.length < fewest || args.length > most) return undefined;
  const type = (i: number) => spannerType(args[i]);
  const partAt = ({TIMESTAMP_TRUNC: 1, TIMESTAMP_DIFF: 2, DATE_DIFF: 2, DATE_TRUNC: 1} as
                  Record<string, number>)[name];
  if (partAt !== undefined && !bare(args[partAt])?.var) {
    return `${name} with part '${partName(args[partAt]) ?? '?'}'`;
  }
  const read = ({DATE: 0, TIMESTAMP_TRUNC: 0, FORMAT_TIMESTAMP: 1} as Record<string, number>)[name];
  if (read !== undefined && type(read) === 'string') return `${name} of a string`;
  if (name === 'STRING' && args.length === 1 &&
      !['timestamp', 'date', 'string', 'number', 'interval'].includes(type(0)!)) {
    return 'STRING of a value that may be a TIMESTAMP';
  }
  // PARSE_TIMESTAMP and PARSE_DATE read a string literal as text.
  const text = name.startsWith('PARSE_') && bare(args[1])?.literal?.literal_type === 'string';
  const parsed = text ? 1 : -1;
  return args.filter((_, i) => i !== partAt && i !== parsed);
}

// The node to put in place of `node`, an engine node of a SPANNER text that
// import translates, with Spanner's time zone written out, or undefined to
// keep it.
function spannerZone(node: any): unknown {
  const kind = kindOf(node);
  const value = kind && node[kind];
  const zone = () => sqlExpressionTree(SPANNER_ZONE, 'BIGQUERY');
  // A string literal other than PLAIN_TIME names its own time zone, or
  // neither database reads it.
  const ownZone = (n: any) => bare(n)?.literal?.literal_type === 'string' &&
      !dateString(bare(n).literal);
  // TIMESTAMP(<string>, <zone>), since BigQuery takes no time zone name in a
  // TIMESTAMP literal.
  const inZone = (n: unknown) => {
    const tree = sqlExpressionTree(`TIMESTAMP(x, ${SPANNER_ZONE})`, 'BIGQUERY');
    return {timestamp: {...tree.timestamp, this: n}};
  };
  if (kind === 'function') {
    const name = String(value.name).toUpperCase();
    const args = value.args ?? [];
    if (ZONE_ARGS[name] === args.length ||
        (name === 'STRING' && args.length === 1 && spannerType(args[0]) === 'timestamp')) {
      return {function: {...value, args: [...args, zone()], no_parens: false}};
    }
  }
  if (kind === 'timestamp' && !value.zone && !ownZone(value.this)) {
    return {timestamp: {...value, zone: zone()}};
  }
  if (kind === 'literal' && value.literal_type === 'timestamp' && PLAIN_TIME.test(value.value)) {
    return inZone({literal: {...value, literal_type: 'string'}});
  }
  if (kind === 'extract' && !zoned(value.this) &&
      !['interval', 'date'].includes(spannerType(value.this)!)) {
    const tree = sqlExpressionTree(`EXTRACT(HOUR FROM x AT TIME ZONE ${SPANNER_ZONE})`, 'BIGQUERY');
    return {extract: {...value, this: {at_time_zone: {...tree.extract.this.at_time_zone, this: value.this}}}};
  }
  if ((kind === 'cast' || kind === 'safe_cast') && castType(value.to) === 'timestamp' &&
      dateString(bare(value.this)?.literal)) {
    return {[kind]: {...value, this: inZone(value.this)}};
  }
  return undefined;
}

// The BigQuery SQL for `tree`, a SPANNER text import translates, with
// Spanner's time zone written out, or an error when the engine cannot write
// it.
function spannerForBigQuery(engine: PolyglotEngine, tree: any): {sql: string}|{error: string} {
  // Each node is judged as the author wrote it, before its children change.
  const rewrite = (node: any): any => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(rewrite);
    const zoned = (isNode(node) && spannerZone(node)) || node;
    return Object.fromEntries(Object.entries(zoned).map(([k, v]) => [k, rewrite(v)]));
  };
  // The engine reads BigQuery's TIMESTAMP as a timestamp without time zone,
  // which it writes as DATETIME, and writes DAYOFWEEK and DAYOFYEAR as DOW and
  // DOY.
  const result = mapTree(rewrite(tree), node => {
    if (node.data_type === 'timestamp') node.timezone = true;
    const part = node.extract && partName(node.extract.field);
    if (part === 'DAYOFWEEK' || part === 'DAYOFYEAR') node.extract.field = {Custom: part};
    return undefined;
  });
  const written = engine.generate([result], 'bigquery');
  if (!written.success || written.sql?.length !== 1) {
    return {error: written.error ?? 'the translated SQL could not be written'};
  }
  return {sql: written.sql[0]};
}
