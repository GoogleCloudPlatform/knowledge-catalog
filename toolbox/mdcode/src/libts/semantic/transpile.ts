// Fills a Semantic Model's missing target expressions by transpiling the vendor
// SQL the loader kept verbatim.
//
// The loader (./loader) collapses each field/metric to at most two forms: a
// target/canonical `expression` valid against the target (GoogleSQL/ANSI) and,
// when the source only supplied a vendor variant, the original vendor SQL in
// `importedExpression` (+ `importedDialect`). When a node carries ONLY the
// imported form -- e.g. a Databricks or Snowflake expression BigQuery does not
// accept verbatim -- `expression` is left unset and the loader warns that it
// "needs transpilation" (see pickDialect). This pass fills that gap: it
// rewrites each such imported expression to the target dialect and sets
// `expression`, while leaving `importedExpression`/`importedDialect` in place
// so nothing is lost and the Knowledge Catalog leg can still emit the vendor
// form.
//
// It is deliberately a GAP-FILLER, not a rewriter: a node that already has an
// `expression` (target or portable canonical) is untouched, so a model authored
// in GoogleSQL/ANSI is unaffected and its goldens are stable. Both deploy legs
// consume the result -- the BigQuery generator and the Knowledge Catalog
// emitter both read `expression ?? importedExpression`, so filling `expression`
// makes each emit the transpiled GoogleSQL instead of the raw vendor SQL.
//
// Design:
//   - Target-agnostic and non-mutating: `transpileModel(model, {target,
//     transpiler})` returns a `structuredClone`, so the portable IR is
//     preserved. The mechanism is injectable so tests run hermetically; the
//     default adapter is the @polyglot-sql/sdk Rust/WASM engine, bundled into
//     the tool -- there is no external runtime dependency to install.
//   - Graceful degradation: if the engine fails to initialize, errors, or would
//     alter which entities an expression references (the qualifier-preservation
//     guard), the node is left with no target `expression` and a warning is
//     emitted -- never a throw. The downstream emitter then falls back to the
//     imported form exactly as it would have without this pass.
//

import {readFileSync} from 'node:fs';

import {Field, Metric, SemanticModel} from './ir';
import {LoadedModel} from './loader';
import {referencedEntityNames} from './sql_expr_utils';

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

// True when a node needs transpilation: it has no target `expression`, but does
// carry an imported vendor form to derive one from. A node that already has an
// `expression` is left alone; one with neither has nothing to transpile.
function needsTranspile(node: Field|Metric): node is(Field | Metric)&{
  importedExpression: string;
}
{
  return node.expression === undefined && node.importedExpression !== undefined;
}

/**
 * Fills every missing target `expression` in `model` by transpiling the node's
 * `importedExpression` to `opts.target`, returning a clone plus diagnostics.
 * The input model is never mutated. When no node needs transpilation, the clone
 * is returned unchanged and the transpiler is not invoked.
 */
export async function transpileModel(
    model: SemanticModel,
    opts: TranspileOptions = {}): Promise<TranspileResult> {
  const target = opts.target ?? DEFAULT_TARGET;
  const transpiler = opts.transpiler ?? polyglotTranspiler;
  const clone: SemanticModel = structuredClone(model);
  const entityNames = clone.entities.map(e => e.name);
  const warnings: string[] = [];

  const pending: Pending[] = [];
  const add = (node: Field|Metric, ctx: string) => {
    if (!needsTranspile(node)) return;
    const id = String(pending.length);
    pending.push({
      request: {
        id,
        // A node can carry an imported expression without a declared dialect
        // (hand-built IR); treat that as portable ANSI (a dialect-neutral
        // parse) rather than passing `undefined` into the adapter and crashing
        // it.
        dialect: node.importedDialect ?? 'ANSI_SQL',
        expression: node.importedExpression,
      },
      ctx,
      accept: (sql: string) => {
        node.expression = sql;
        // Keep `importedExpression`/`importedDialect`: the IR carries both
        // forms on purpose (round-trip fidelity, and the KC leg may still emit
        // the vendor form). We only fill the previously-missing target
        // expression.
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
              reason}); leaving the imported expression for the emitter`);
      continue;
    }
    // Qualifier-preservation guard: the BigQuery emitter locates measures and
    // strips qualifiers by matching `<Entity>.` case-sensitively (see
    // ./sql_expr_utils). If the transpiler re-cased or quoted a qualifier, the
    // referenced-entity set would change and the metric would silently drop or
    // misplace. Reject any such rewrite: leave `expression` unset (the emitter
    // falls back to the imported form) and warn.
    const before = referencedEntityNames(request.expression, entityNames);
    const after = referencedEntityNames(res.sql, entityNames);
    if (!sameSet(before, after)) {
      warnings.push(
          `${ctx}: transpiled '${request.dialect}' -> '${
              target}' but it altered ` +
          `the referenced entities (${fmtSet(before)} -> ${fmtSet(after)}); ` +
          `leaving the imported expression for the emitter`);
      continue;
    }
    p.accept(res.sql);
    warnings.push(`${ctx}: transpiled '${request.dialect}' -> '${target}'`);
  }

  return {model: clone, warnings};
}

/**
 * Convenience over {@link transpileModel} for the shared, document-tagged
 * models a push loads once (see loadSemanticModels). Transpiles each model's
 * missing target expressions, returning new `LoadedModel`s (originals
 * untouched) and all warnings, each prefixed with the originating document name
 * so they attribute back to the author's file like the loader's own warnings.
 */
export async function transpileModels(
    models: LoadedModel[], opts: TranspileOptions = {}):
    Promise<{models: LoadedModel[]; warnings: string[]}> {
  // Models are independent; transpile them concurrently. They share the single
  // process-wide WASM engine instance (initialized once), so this is cheap.
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
  BIGQUERY: 'bigquery',
  ANSI_SQL: 'generic',  // the engine's dialect-neutral parser
  SNOWFLAKE: 'snowflake',
  DATABRICKS: 'databricks',
  SPARK: 'spark',
  POSTGRES: 'postgresql',
  POSTGRESQL: 'postgresql',
  TERADATA: 'teradata',
  PRESTO: 'presto',
  TRINO: 'trino',
  DUCKDB: 'duckdb',
  MYSQL: 'mysql',
  REDSHIFT: 'redshift',
  ORACLE: 'oracle',
  TSQL: 'tsql',
};

function polyglotDialect(token: string): string|undefined {
  if (!token) return undefined;
  return POLYGLOT_DIALECTS[token.toUpperCase()];
}

// The subset of the @polyglot-sql/sdk `/manual` surface we use. Declared
// locally because the package's `/manual` subpath does not re-export its named
// bindings through tsc under this project's CommonJS/nodenext setting; the
// dynamic import is cast to this shape.
interface PolyglotEngine {
  init(opts: {wasmUrl: string}): Promise<void>;
  transpile(sql: string, read: string, write: string):
      {success: boolean; sql?: string[]; error?: string};
}

// The WASM engine, initialized once and shared process-wide. The Rust/WASM blob
// is embedded into the standalone binary via bun's `import(... , {with: {type:
// 'file'}})` (statically analyzable, so bundled) and handed to `init()` as
// bytes
// -- the package's default loader reads the blob from disk at runtime, which
// fails inside a `bun --compile` binary, so we use the `/manual` entry instead.
let enginePromise: Promise<PolyglotEngine>|undefined;
function loadEngine(): Promise<PolyglotEngine> {
  if (!enginePromise) {
    enginePromise = (async () => {
      const {default: wasmPath} = await import(
          '@polyglot-sql/sdk/polyglot_sql.wasm', {with: {type: 'file'}});
      const engine =
          await import('@polyglot-sql/sdk/manual') as unknown as PolyglotEngine;
      await engine.init({wasmUrl: readFileSync(wasmPath) as unknown as string});
      return engine;
    })();
  }
  return enginePromise;
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
  // 'generic' (ANSI_SQL) means dialect-neutral output and must be preserved;
  // only an absent/unknown target falls back to BigQuery, the pass's reason for
  // existing.
  const write = polyglotDialect(target) ?? 'bigquery';

  let engine: PolyglotEngine;
  try {
    engine = await loadEngine();
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
      return {id: r.id, sql: res.sql[0]};
    } catch (err) {
      return {id: r.id, error: errMessage(err)};
    }
  });
};

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
