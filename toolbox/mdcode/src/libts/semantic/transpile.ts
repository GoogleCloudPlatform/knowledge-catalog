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
//     default adapter shells out to Python's `sqlglot` out of process.
//   - Graceful degradation: if the transpiler is missing, errors, or would
//   alter
//     which entities an expression references (the qualifier-preservation
//     guard), the node is left with no target `expression` and a warning is
//     emitted -- never a throw. The downstream emitter then falls back to the
//     imported form exactly as it would have without this pass.
//

import {spawn, spawnSync} from 'node:child_process';

import {Field, Metric, SemanticModel} from './ir';
import {LoadedModel} from './loader';
import {referencedEntityNames} from './sql_expr_utils';

// The target dialect this pass rewrites into. The whole point of the pass is to
// reach GoogleSQL/BigQuery, so it is fixed rather than a knob; the sqlglot
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
  transpiler?: SqlTranspiler;  // mechanism; default `sqlglotTranspiler`
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
  importedDialect: string
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
  const transpiler = opts.transpiler ?? sqlglotTranspiler;
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
        dialect: node.importedDialect!,
        expression: node.importedExpression!
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

  return {model: clone, warnings: dedupe(warnings)};
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
  const out: LoadedModel[] = [];
  const warnings: string[] = [];
  for (const {document, model} of models) {
    const t = await transpileModel(model, opts);
    out.push({document, model: t.model});
    for (const w of t.warnings) warnings.push(`[${document}] ${w}`);
  }
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

// Order-preserving de-duplication, so identical outcome lines (e.g. the same
// dialect transpiled across several fields) collapse to one.
function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (!seen.has(item)) {
      seen.add(item);
      out.push(item);
    }
  }
  return out;
}


// --- sqlglot adapter (the default mechanism) ---------------------------------

// Maps our dialect tokens (as authored in the AI-first format) to sqlglot's
// read dialect names. Unknown tokens fall through as their lower-cased form,
// which sqlglot either accepts or rejects (rejection degrades to the imported
// form + warning).
const SQLGLOT_DIALECTS: Record<string, string> = {
  BIGQUERY: 'bigquery',
  ANSI_SQL: '',  // sqlglot's dialect-neutral parser
  SNOWFLAKE: 'snowflake',
  DATABRICKS: 'databricks',
  SPARK: 'spark',
  POSTGRES: 'postgres',
  POSTGRESQL: 'postgres',
  TERADATA: 'teradata',
  PRESTO: 'presto',
  TRINO: 'trino',
  DUCKDB: 'duckdb',
  MYSQL: 'mysql',
  REDSHIFT: 'redshift',
  ORACLE: 'oracle',
  TSQL: 'tsql',
};

function sqlglotDialect(token: string): string {
  const up = token.toUpperCase();
  return up in SQLGLOT_DIALECTS ? SQLGLOT_DIALECTS[up] : token.toLowerCase();
}

// Embedded, dependency-free driver run as `python3 -c <SCRIPT>`. It reads one
// JSON request object from stdin and writes a JSON array of responses to
// stdout. A missing sqlglot is caught and reported per-item (exit 0), so the
// absence of the optional dependency degrades to the imported form rather than
// a hard failure.
const SQLGLOT_SCRIPT = `
import sys, json
data = json.load(sys.stdin)
write = data["write"]
items = data["items"]
try:
    import sqlglot
except Exception as e:
    print(json.dumps([{"id": it["id"], "error": "sqlglot unavailable: %s" % (e,)} for it in items]))
    sys.exit(0)
out = []
for it in items:
    try:
        tree = sqlglot.parse_one(it["expr"], read=(it["read"] or None))
        out.append({"id": it["id"], "sql": tree.sql(dialect=write)})
    except Exception as e:
        out.append({"id": it["id"], "error": str(e)})
print(json.dumps(out))
`;

/**
 * The default {@link SqlTranspiler}: transpiles via Python's `sqlglot` in a
 * subprocess. The Python interpreter is `$KCMD_PYTHON` or `python3`. It never
 * throws: a spawn failure (e.g. no interpreter), non-zero exit, or unparseable
 * output yields an `error` response for every request, so the caller degrades
 * to the imported form + warning. `sqlglot` itself is optional -- see
 * {@link SQLGLOT_SCRIPT}.
 */
export const sqlglotTranspiler: SqlTranspiler = (requests, target) => {
  if (!requests.length) return Promise.resolve([]);
  const write = sqlglotDialect(target) || 'bigquery';
  const payload = JSON.stringify({
    write,
    items: requests.map(
        r => ({id: r.id, read: sqlglotDialect(r.dialect), expr: r.expression})),
  });
  const python = process.env.KCMD_PYTHON || 'python3';

  return new Promise<TranspileResponse[]>(resolve => {
    const fail = (reason: string) =>
        resolve(requests.map(r => ({id: r.id, error: reason})));

    let child;
    try {
      child = spawn(
          python, ['-c', SQLGLOT_SCRIPT], {stdio: ['pipe', 'pipe', 'pipe']});
    } catch (err: any) {
      fail(`could not start '${python}': ${err?.message ?? err}`);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (fn: () => void) => {
      if (!settled) {
        settled = true;
        fn();
      }
    };

    // Decode as UTF-8 via the stream's StringDecoder so a multibyte character
    // split across two chunks is reassembled correctly (concatenating raw
    // Buffers would decode each half independently and corrupt it).
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', d => {
      stdout += d;
    });
    child.stderr.on('data', d => {
      stderr += d;
    });
    child.on(
        'error',
        err => done(
            () => fail(`could not run '${python}': ${err?.message ?? err}`)));
    child.on(
        'close',
        code => done(() => {
          if (code !== 0) {
            fail(`'${python}' exited ${code}${
                stderr.trim() ? `: ${stderr.trim()}` : ''}`);
            return;
          }
          let parsed: unknown;
          try {
            parsed = JSON.parse(stdout);
          } catch {
            fail(`could not parse transpiler output: ${stdout.slice(0, 200)}`);
            return;
          }
          if (!Array.isArray(parsed)) {
            fail('transpiler output was not a JSON array');
            return;
          }
          resolve(parsed as TranspileResponse[]);
        }));

    child.stdin.on('error', () => {/* handled via 'error'/'close' above */});
    child.stdin.end(payload);
  });
};

/**
 * Synchronously reports whether the sqlglot mechanism is usable: the
 * `$KCMD_PYTHON` (or `python3`) interpreter exists and can `import sqlglot`.
 * Returns false on any failure (missing interpreter, missing module, non-zero
 * exit).
 *
 * This is a test/tooling convenience -- it lets a `bun test` file gate
 * sqlglot-dependent cases at registration time without a top-level `await`
 * (which `tsc` rejects under this project's CommonJS module setting). The
 * production path uses {@link sqlglotTranspiler}, which degrades gracefully
 * instead of probing.
 */
export function sqlglotInstalled(): boolean {
  const python = process.env.KCMD_PYTHON || 'python3';
  try {
    return spawnSync(python, ['-c', 'import sqlglot'], {
             stdio: 'ignore'
           }).status === 0;
  } catch {
    return false;
  }
}
