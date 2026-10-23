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
//   - Graceful degradation: if the engine fails to initialize, errors, or would
//     alter which entities an expression references (the qualifier-preservation
//     guard), the node is left as it is and a warning is emitted -- never a
//     throw.
//

import {Field, Metric, SemanticModel, SqlDialect} from './ir';
import {LoadedModel} from './loader';
import {columnReferences, entitiesReached} from './sql_expr_utils';
import {loadSqlEngine, PolyglotEngine, sqlExpressionTree} from './sql_parser';

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
}

export interface TranspileResult {
  model: SemanticModel;
  warnings: string[];
}

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
 * Comparing `quotedColumnCount` across the two ASTs yields three cases:
 *   - `ANSI_SQL > BIGQUERY`: at least one column identifier is double-quoted
 *     (e.g., `"orders"."amount"` or `"amount"`).
 *   - `ANSI_SQL < BIGQUERY`: `expression` uses BigQuery-only syntax (such as a
 *     `# "comment"` line comment in `` `orders`.`col` # "comment" ``) that
 *     `BIGQUERY` parses while `ANSI_SQL` fails to parse (`count = 0`).
 *   - `ANSI_SQL === BIGQUERY`: any `"` is inside a string literal or comment
 *     (e.g., `` `orders`.`note` = 'a "quoted" ` string' ``), and any quoted
 *     column identifiers use backticks in both dialects.
 */
function hasDoubleQuotedColumn(expression: string): boolean {
  if (!expression.includes('"')) return false;
  return quotedColumnCount(sqlExpressionTree(expression, 'ANSI_SQL')) >
      quotedColumnCount(sqlExpressionTree(expression, 'BIGQUERY'));
}

/**
 * Returns the number of quoted column, table qualifier, and struct field
 * identifiers (`quoted: true`) in a `@polyglot-sql/sdk` AST `node`.
 *
 * `@polyglot-sql/sdk` represents simple or table-qualified column references as
 * `{column: {name: {name, quoted}, table?: {name, quoted}}}` and chained
 * struct field accesses (such as `orders.addr."city"`) as
 * `{dot: {this: <base>, field: {name, quoted}}}`. When `sqlExpressionTree`
 * cannot parse an expression in the requested dialect, it returns `undefined`,
 * for which this function returns `0`.
 */
function quotedColumnCount(node: unknown): number {
  // Base case: `undefined` (when `sqlExpressionTree` fails to parse), `null`,
  // or primitive AST leaf values (`string`, `number`, `boolean`) have 0 quoted
  // column identifiers.
  if (!node || typeof node !== 'object') return 0;
  const obj = node as Record<string, any>;
  // A `{column: {name, table}}` node represents a bare (`"col"`) or
  // table-qualified (`"orders"."col"`) column reference; count the column name
  // and optional table qualifier separately whenever `quoted === true`.
  if (obj.column) {
    return (obj.column.name?.quoted === true ? 1 : 0) +
        (obj.column.table?.quoted === true ? 1 : 0);
  }
  // A `{dot: {this, field}}` node represents a struct subfield access (e.g.
  // `orders.addr."city"`); count `field` if `quoted === true` and recurse into
  // `this` for the base column or outer struct path.
  if (obj.dot) {
    return (obj.dot.field?.quoted === true ? 1 : 0) +
        quotedColumnCount(obj.dot.this);
  }
  // For any other AST container node (such as `sum`, `eq`, `case`) or array of
  // child AST nodes, recursively sum the counts across all child values.
  return Object.values(obj).reduce<number>(
      (sum, val) => sum + quotedColumnCount(val), 0);
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
function sourceToTranspile(node: Field|Metric, target: string):
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
 * Adds a translated `opts.target` dialect entry to every field or metric in
 * `model` whose only texts are in vendor dialects or whose `ANSI_SQL` text
 * double-quotes a column name, returning a cloned model plus diagnostics.
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
  const add = (node: Field|Metric, ctx: string) => {
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
    const cols = columnReferences(res.sql, target);
    if (cols === undefined) {
      warnings.push(
          `${ctx}: transpiled '${request.dialect}' -> '${target}' could not ` +
          `be parsed; qualifier check was skipped`);
    } else {
      const emitterVisible = entitiesReached(cols, entityNames);
      const anyCase = [
        ...new Set(
            cols.flatMap(c => {
              if (!c.qualifier) return [];
              const lower = c.qualifier.toLowerCase();
              return entityNames.filter(n => n.toLowerCase() === lower);
            })),
      ];
      if (!sameSet(emitterVisible, anyCase)) {
        warnings.push(
            `${ctx}: transpiled '${request.dialect}' -> '${
                target}' but it re-cased an entity qualifier the emitter matches ` +
            `case-sensitively (${fmtSet(emitterVisible)} vs ${fmtSet(anyCase)}); ` +
            `left untranslated`);
        continue;
      }
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

/**
 * Runs {@link transpileModel} across `models`, returning new `LoadedModel`s
 * (originals untouched) and all warnings prefixed with `[<document>]`.
 *
 * Convenience wrapper for the shared, document-tagged models a push loads once
 * (see `loadSemanticModels`), attributing each warning back to the originating
 * document name like the loader's own warnings.
 */
export async function transpileModels(
    models: LoadedModel[], opts: TranspileOptions = {}):
    Promise<{models: LoadedModel[]; warnings: string[]}> {
  // Models are independent, so map over them together; they share the single
  // process-wide WASM engine instance (initialized once). The engine's
  // transpile call is synchronous, so this does not run expressions in
  // parallel -- it just avoids re-initializing the engine per model.
  const results =
      await Promise.all(models.map(({model}) => transpileModel(model, opts)));
  const out: LoadedModel[] = [];
  const warnings: string[] = [];
  models.forEach(({document}, i) => {
    out.push({document, model: results[i].model});
    for (const w of results[i].warnings) warnings.push(`[${document}] ${w}`);
  });
  return {models: out, warnings};
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
 * Returns true if the default translator reads SQL written in `dialect`
 * (treating an empty string as `ANSI_SQL`).
 *
 * `transpileModel` leaves a text in any other dialect as written, with a
 * warning.
 */
export function transpilesFrom(dialect: string): boolean {
  return polyglotDialect(dialect || 'ANSI_SQL') !== undefined;
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

  return requests.map(r => {
    const read = polyglotDialect(r.dialect);
    if (read === undefined)
      return {id: r.id, error: `unsupported source dialect '${r.dialect}'`};
    try {
      const res = engine.transpile(r.expression, read, write);
      if (!res.success || !res.sql || res.sql.length === 0)
        return {
          id: r.id,
          error: res.error ?? 'transpilation produced no output'
        };
      // A field/metric is a single scalar expression, so the engine should
      // return exactly one statement. More than one means the input was not a
      // lone expression; taking [0] would silently drop the rest, so reject it.
      if (res.sql.length > 1)
        return {
          id: r.id,
          error: `expected a single expression but got ${
              res.sql.length} statements`
        };
      return {id: r.id, sql: res.sql[0]};
    } catch (err) {
      return {id: r.id, error: errMessage(err)};
    }
  });
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
