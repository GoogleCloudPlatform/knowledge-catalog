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
// `NET.HOST(orders.url)` is not a column. Throws when the engine is not
// loaded.
export function sqlColumns(expression: string, dialect: string): SqlColumn[]|
    undefined {
  if (!loadedEngine) {
    throw new Error(
        'the SQL parser is not loaded; call loadSqlEngine() first');
  }
  if (!expression.trim()) return [];
  // The parentheses keep a text that starts with a keyword, such as the entity
  // name in `Order.amount - Order.discount`, from reading as a clause. The line
  // breaks keep a trailing `--` comment from swallowing the closing one.
  const res = loadedEngine.parse(
      `SELECT (\n${expression}\n)`,
      PARSER_DIALECTS[dialect.toUpperCase()] ?? 'generic');
  if (!res.success || res.ast?.length !== 1) return undefined;
  const columns: SqlColumn[] = [];
  collectColumns(res.ast[0], columns);
  return columns;
}

function collectColumns(node: unknown, out: SqlColumn[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectColumns(item, out);
    return;
  }
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, any>;
  const keys = Object.keys(obj);
  if (keys.length === 1 && keys[0] === 'column' &&
      typeof obj.column?.name?.name === 'string') {
    const qualifier = obj.column.table?.name;
    out.push({
      ...(typeof qualifier === 'string' ? {qualifier} : {}),
      name: obj.column.name.name,
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
        out.push({qualifier, name: column.name.name});
      } else if (typeof inner.field?.name === 'string') {
        out.push({qualifier: column.name.name, name: inner.field.name});
      }
      return;
    }
    collectColumns(obj.dot?.this, out);
    return;
  }
  if (keys.length === 1 && keys[0] === 'method_call') {
    // `NET.HOST(x)`: the part before the dot names a function namespace.
    collectColumns(obj.method_call?.args, out);
    return;
  }
  for (const value of Object.values(obj)) collectColumns(value, out);
}
