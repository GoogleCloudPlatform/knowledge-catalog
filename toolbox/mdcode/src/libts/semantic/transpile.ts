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
import {columnReferences, entitiesReached, quotedName, unusedName} from './sql_expr_utils';
import {bareColumnName, isReservedKeyword, isSimpleIdentifier} from './sql_identifiers';
import {expressionStatement, forParser, loadedSqlEngine, loadSqlEngine, mysqlForEngine, PolyglotEngine, SqlToken, sqlExpressionTree, withoutEngineMessages} from './sql_parser';

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
 * Returns true if `expression`, an `ANSI_SQL` text, writes the name of a
 * column, table qualifier or struct field in double quotes (`"..."`), which
 * BigQuery reads as a string (see doubleQuotedNames).
 */
export function hasDoubleQuotedColumn(expression: string): boolean {
  return doubleQuotedNames(expression).length > 0;
}

/**
 * Returns the names that `expression`, an `ANSI_SQL` text, writes in double
 * quotes, each once. It finds the quoted names as the translator does (see
 * quotedNameTokens), so a quoted name that the parser reads as a function,
 * such as `"CURRENT_DATE"`, counts too. A text that the `ANSI_SQL` reader
 * cannot read, such as one with BigQuery's `#` comment, has none.
 */
export function doubleQuotedNames(expression: string): string[] {
  if (!expression.includes('"') || !sqlExpressionTree(expression, 'ANSI_SQL')) return [];
  const chars = [...expression];
  const names = quotedNameTokens(loadedSqlEngine()!, expression, 'generic')
      .filter(token => chars[token.span.start] === '"').map(token => token.text);
  return [...new Set(names)];
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
 * The BIGQUERY text `transpileModel`, with the default translator, gives
 * `node` in a model whose entities are `entityNames`, or undefined when it
 * gives none. Undefined until `loadSqlEngine()` has loaded the engine.
 */
export function bigQueryTranslation(
    node: TranspileNode, entityNames: string[]): string|undefined {
  const source = sourceToTranspile(node, DEFAULT_TARGET);
  const engine = loadedSqlEngine();
  if (!source || !engine) return undefined;
  const {sql} = transpileWith(
      engine, {id: '', ...source}, polyglotDialect(DEFAULT_TARGET)!);
  if (sql === undefined) return undefined;
  const reached = qualifiersReached(sql, DEFAULT_TARGET, entityNames);
  return !reached || sameSet(reached.exact, reached.anyCase) ? sql : undefined;
}

/**
 * Whether `transpileModel`, with the default translator, gives `node` a
 * BIGQUERY text in a model whose entities are `entityNames`. False until
 * `loadSqlEngine()` has loaded the engine.
 */
export function translatesToBigQuery(
    node: TranspileNode, entityNames: string[]): boolean {
  return bigQueryTranslation(node, entityNames) !== undefined;
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
  OSSIE_SQL_2026: 'generic',  // read under the rules of "OSSIE_SQL_2026 texts"
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
  // The lists below name the rules of a text by the engine's dialect, except
  // for a SPANNER text, which the engine reads as BigQuery's SQL, and an
  // OSSIE_SQL_2026 text, which it reads as generic SQL.
  const dialect = r.dialect.toUpperCase();
  const spanner = dialect === 'SPANNER';
  const rules = spanner ? 'spanner' : dialect === 'OSSIE_SQL_2026' ? 'ossie' : read;
  // A message names each quoted name the engine reads as a placeholder as
  // written, and the BigQuery text names it as BigQuery writes it (see
  // placedNames).
  let names = new Map<string, PlacedName>();
  const spelled = (s: string, as: keyof PlacedName) => withNames(s, names, as);
  try {
    // A text already in the target dialect needs no translation.
    if (read === write && !spanner) return {id: r.id, sql: r.expression};
    const prepared = read === 'mysql' ? mysqlCompounds(engine, mysqlForEngine(r.expression)) :
        rules === 'ossie' && write === 'bigquery' ? ossieText(engine, r.expression) : r.expression;
    const placed = write === 'bigquery' ? placedNames(engine, prepared, read) : {text: prepared, names};
    const source = placed.text;
    names = placed.names;
    // A comment that starts the text keeps the engine from translating the
    // functions in it, so the engine reads the text after it.
    const {text, comments} = sqlComments(engine, source, read);
    let repaired: {sql: string}|{error: string};
    if (write === 'bigquery') {
      const tree = sourceTree(text, r.dialect, read);
      const named = () => {
        const found = unknownConstruct(engine, tree, rules);
        return found && writtenName(engine, text, r.dialect, read, rules, found);
      };
      const unknown = misreadToken(engine, prepared, read, rules) ?? lostName(engine, text, r.dialect, read, spanner ? tree : undefined) ??
          (tree ? named() : 'a text it cannot read as one expression');
      if (unknown) return {id: r.id, error: `kcmd does not translate ${spelled(unknown.replaceAll(PASS, ''), 'written')}`};
      if (spanner) repaired = spannerForBigQuery(engine, tree);
    }
    repaired ??= engineTranslation(engine, text, r.dialect, read, write, rules);
    if ('error' in repaired) return {id: r.id, error: spelled(repaired.error, 'written')};
    // Each comment the engine did not keep goes last, as often as the text
    // writes it more than the translation does. Both count, by the engine's
    // tokens, only the comments outside strings.
    const sql = commentsAsWritten(engine, repaired.sql, write, comments);
    const kept = sqlComments(engine, sql, write).comments.map(squash);
    const dropped = comments.filter(c => {
      const i = kept.indexOf(squash(c));
      if (i >= 0) kept.splice(i, 1);
      return i < 0;
    });
    return {id: r.id, sql: spelled([sql, ...dropped].join(' '), 'bigQuery')};
  } catch (err) {
    return {id: r.id, error: spelled(errMessage(err), 'written')};
  }
}

// The tokens the engine reads as an operator between two values.
const INFIX = new Set([
  'PLUS', 'DASH', 'STAR', 'SLASH', 'PERCENT', 'D_PIPE', 'EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE', 'NULLSAFE_EQ',
  'AND', 'OR', 'XOR', 'IS', 'NOT', 'IN', 'BETWEEN', 'LIKE', 'I_LIKE', 'R_LIKE', 'I_R_LIKE', 'NOT_R_LIKE',
  'TILDE', 'AMP', 'PIPE', 'CARET', 'LT_LT', 'GT_GT',
]);

// A keyword of `text`, an expression in `dialect` that the engine reads as
// `read`, written before an operator, that the engine leaves out of the tree
// it translates, named for a message, or undefined. Such a word names a
// column, and the engine reads it as a keyword: ANSI_SQL's `if + 1` as 1, and
// SQL Server's `true + 1`, where true is a column, as 1 + 1. Only a word that
// `dialect` allows as a bare column name counts (see bareColumnName). The
// engine may write a word `dialect` reserves another way or leave it out, as
// ALL in SUM(ALL -x). The engine keeps a word when it writes the word back
// from the tree in `read` as often as `text` writes it. Both count only the
// words outside strings and comments.
function lostName(engine: PolyglotEngine, text: string, dialect: string, read: string, translated?: unknown):
    string|undefined {
  const chars = [...text];
  const tokens = engine.tokenize(text, read).tokens ?? [];
  const spelled = (t: SqlToken) => chars.slice(t.span.start, t.span.end).join('').toLowerCase();
  const keywords = tokens.filter((t, i) => t.token_type !== 'VAR' && /^[\p{L}_][\p{L}\p{N}_$]*$/u.test(spelled(t)) &&
      bareColumnName(spelled(t), dialect) && INFIX.has(tokens[i + 1]?.token_type));
  if (!keywords.length) return undefined;
  // The engine translates the text alone where it reads it as push does,
  // else after SELECT (see engineTranslation). A SPANNER text is translated
  // from its tree, `translated`.
  const tree = translated ? [translated] : readsAlone(engine, text, dialect, read) ?
      withoutEngineMessages(() => engine.parse(text, read)).ast :
      [expressionStatement(text, dialect)?.tree].filter(t => t);
  if (!tree?.length) return undefined;
  // The words of `sql`, by the engine's tokens, which leave out its comments,
  // apart from its strings. The engine may write a kept word back as a quoted
  // name, which counts as the word.
  const words = (sql: string) => (engine.tokenize(sql, read).tokens ?? [])
      .filter(t => !t.token_type.endsWith('STRING')).map(t => t.text.toLowerCase());
  const count = (list: string[], word: string) => list.filter(w => w === word).length;
  const written = (withoutEngineMessages(() => engine.generate(tree, read)).sql ?? []).flatMap(words);
  const inText = tokens.filter(t => !t.token_type.endsWith('STRING')).map(spelled);
  const lost = keywords.find(t => count(written, spelled(t)) < count(inText, spelled(t)));
  if (!lost) return undefined;
  return `the name ${chars.slice(lost.span.start, lost.span.end).join('')}, which kcmd's SQL parser reads as a keyword`;
}

// A quoted name a text reads, as the text writes it and as BigQuery writes it.
interface PlacedName {
  written: string;
  bigQuery: string;
}

// The quoted names of `sql`, a text in the engine's dialect `read`, as the
// tokens that hold them. A quoted word before a parenthesis is a function,
// and one after AS or :: is a type, as in CAST(x AS [date]), so neither is a
// name.
function quotedNameTokens(engine: PolyglotEngine, sql: string, read: string): SqlToken[] {
  const tokens = engine.tokenize(sql, read).tokens ?? [];
  return tokens.filter((token, i) => {
    const [before, after] = [tokens[i - 1]?.token_type, tokens[i + 1]?.token_type];
    return token.token_type === 'QUOTED_IDENTIFIER' && after !== 'L_PAREN' && before !== 'AS' && before !== 'D_COLON';
  });
}

// `sql`, a text in the engine's dialect `read`, with each quoted name (see
// quotedNameTokens) in place of a placeholder, a bare name the engine keeps as
// it is, and the name each placeholder stands for. The engine reads some
// quoted names, such as "current_date" in PostgreSQL or [current_date] in SQL
// Server, as a function, where the source reads the column. BigQuery writes
// each in backticks, with a backtick or a backslash in it escaped, also after
// a dot, as in orders."a`b".
function placedNames(engine: PolyglotEngine, sql: string, read: string):
    {text: string; names: Map<string, PlacedName>} {
  const chars = [...sql];
  const stem = unusedName(sql, 'kcmd_name_');
  const names = new Map<string, PlacedName>();
  // A space keeps a placeholder apart from a word written against the name,
  // as WHEN is in WHEN"x".
  const word = (c: string|undefined) => !!c && /[\p{L}\p{N}_$]/u.test(c);
  let [text, end] = ['', 0];
  for (const t of quotedNameTokens(engine, sql, read)) {
    const placeholder = stem + names.size;
    names.set(placeholder, {written: chars.slice(t.span.start, t.span.end).join(''), bigQuery: quotedName(t.text, 'BIGQUERY')});
    text += chars.slice(end, t.span.start).join('') + (word(chars[t.span.start - 1]) ? ' ' : '') + placeholder +
        (word(chars[t.span.end]) ? ' ' : '');
    end = t.span.end;
  }
  return {text: text + chars.slice(end).join(''), names};
}

// `text` with each placeholder of `names` in place of its name as `as` gives
// it.
function withNames(text: string, names: Map<string, PlacedName>, as: keyof PlacedName): string {
  if (!names.size) return text;
  // The longest first, so that kcmd_name_1 does not match in kcmd_name_10.
  const pattern = new RegExp([...names.keys()].sort((a, b) => b.length - a.length).join('|'), 'gi');
  return text.replace(pattern, p => names.get(p.toLowerCase())![as]);
}

// The engine's translation of `text`, an expression in `dialect` that the
// engine reads as `read`, into the engine's dialect `write`, repaired for
// BigQuery by the lists' `rules` for the text, or an error.
function engineTranslation(
    engine: PolyglotEngine, text: string, dialect: string, read: string,
    write: string, rules: string): {sql: string}|{error: string} {
  const prepared = write === 'bigquery' ? forBigQuery(engine, text, dialect, read, rules) : {sql: text};
  if ('error' in prepared) return prepared;
  const sql = prepared.sql;
  // The engine reads some expressions only after SELECT, such as one that
  // starts with `((`, and some alone as a statement (see readsAlone). Where
  // it does not read the text alone as push does, it reads the SELECT
  // statement push reads (see expressionStatement), whose parentheses, if
  // push adds them, are taken off again. After SELECT, the engine writes the
  // functions of a comparison or a CASE before a comment as the source does,
  // so it reads the expression there without its comments. transpileWith puts
  // them last.
  let res = readsAlone(engine, sql, dialect, read) ? engine.transpile(sql, read, write) : {success: false};
  if (!res.success) {
    const chars = [...sql];
    const code = (engine.tokenize(sql, read).tokens ?? [])
        .map(t => chars.slice(t.span.start, t.span.end).join('')).join(' ');
    const statement = expressionStatement(code, dialect);
    const selected = statement ? engine.transpile(statement.sql, read, write) : {success: false};
    const wrapped = statement?.sql.startsWith('SELECT (\n');
    if (selected.success) {
      res = {...selected, sql: selected.sql?.map(s => wrapped ? s.replace(/^SELECT \((.*)\)$/s, '$1') : s.replace(/^SELECT /, ''))};
    }
  }
  if (!res.success || !res.sql || res.sql.length === 0)
    return {error: res.error ?? 'transpilation produced no output'};
  // A field/metric is a single scalar expression, so the engine should
  // return exactly one statement. More than one means the input was not a
  // lone expression; taking [0] would silently drop the rest, so reject it.
  if (res.sql.length > 1)
    return {error: `expected a single expression but got ${res.sql.length} statements`};
  return write === 'bigquery' ? repairForBigQuery(engine, res.sql[0], rules) :
                                {sql: res.sql[0]};
}

// Whether the engine reads `sql`, an expression in `dialect` that the engine
// reads as `read`, alone as push reads it (see sqlExpressionTree): as one
// tree of the same kind, apart from parentheses and comments. The engine
// reads some texts alone as a statement, such as PostgreSQL's `desc IS NULL`
// as DESCRIBE, where push reads the column desc. Push reads some texts in
// parentheses, such as T-SQL's `a = b`, which it reads after SELECT as an
// alias.
function readsAlone(engine: PolyglotEngine, sql: string, dialect: string, read: string): boolean {
  const alone = withoutEngineMessages(() => engine.parse(sql, read));
  if (!alone.success || alone.ast?.length !== 1) return false;
  const pushed = sqlExpressionTree(sql, dialect);
  return !pushed || kindOf(bare(alone.ast[0])) === kindOf(bare(pushed));
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

// `s` without white space. The engine may space a comment it keeps another
// way than sqlComments writes it.
function squash(s: string): string {
  return s.replace(/\s+/g, '');
}

// `sql`, the engine's translation into its dialect `write` of a text with
// `comments` (see sqlComments), with each of those comments as often as the
// text writes it. The engine writes a comment once for each node that ends
// where it stands, so `x = y -- c` becomes `x = y /* c */ /* c */`, and it may
// write a copy after the next operator. Each copy past that count is
// removed, with the spaces before it. The text between two tokens holds only
// spaces and comments.
function commentsAsWritten(engine: PolyglotEngine, sql: string, write: string, comments: string[]): string {
  const tokens = engine.tokenize(sql, write).tokens;
  if (!tokens) return sql;
  const left = new Map<string, number>();
  comments.forEach(c => left.set(squash(c), (left.get(squash(c)) ?? 0) + 1));
  const chars = [...sql];
  let out = '';
  let end = 0;
  for (const {span} of [...tokens, {span: {start: chars.length, end: chars.length}}]) {
    out += chars.slice(end, span.start).join('').replace(/\s*(\/\*[\s\S]*?\*\/)/g, (copy, c) => {
      const n = left.get(squash(c));
      if (n !== undefined) left.set(squash(c), n - 1);
      return n === undefined || n > 0 ? copy : '';
    });
    out += chars.slice(span.start, span.end).join('');
    end = span.end;
  }
  return out;
}

// The first token of `sql`, a text in the engine's dialect `read`, that the
// engine reads another way than the source, named for a message, or undefined.
// A date part written as a quoted name, such as DATEADD("day", 1, d),
// DATEADD([day], 1, d) or DATEADD(("day"), 1, d), is a column or an error in
// the source, and the engine reads it as the part. A function is read by the
// dialect's table, so Databricks' dateadd(d, 7) has no part. A SPANNER text,
// which the engine reads as BigQuery's SQL, names its date parts last.
// MySQL runs the SQL in a /*! comment, which the engine keeps as a comment, and
// reads a /*+ comment as an optimizer hint. MySQL and Databricks keep the
// backslash of \% and \_ in a string, which LIKE reads as a literal % or _,
// and the engine drops it. Databricks reads 'it''s' as two strings joined,
// and the engine as one string with a quote. The engine reads EXTRACT's part
// DOW as DAYOFWEEK and DOY as DAYOFYEAR, so the part of EXTRACT in an
// OSSIE_SQL_2026 text is checked as written. The engine holds a size,
// precision or scale of a type as a 32-bit number, and kcmd reads one past
// 2^31 - 1 as negative (see ossieCast). `rules` names the lists' rules for the
// text.
function misreadToken(engine: PolyglotEngine, sql: string, read: string, rules: string):
    string|undefined {
  const tokens = engine.tokenize(sql, read).tokens ?? [];
  const table = DATE_TABLES[rules];
  // The date-part function whose first argument starts at token `i`, perhaps
  // in parentheses, or undefined.
  const partFunction = (i: number) => {
    let j = i - 1;
    while (tokens[j]?.token_type === 'L_PAREN') j--;
    const fn = String(tokens[j]?.text).toUpperCase();
    const part = table?.functions[fn] ? table.functions[fn] === 'part' : !!PART_FUNCTIONS[fn]?.includes(rules);
    return tokens[j]?.token_type === 'VAR' && part ? fn : undefined;
  };
  const quoted = read === 'bigquery' ? undefined :
      tokens.map((t, i) => t.token_type === 'QUOTED_IDENTIFIER' ? partFunction(i) : undefined).find(f => f);
  if (quoted) return `${quoted} with a quoted part`;
  const part = rules !== 'ossie' ? -1 : tokens.findIndex((t, i) => String(t.text).toUpperCase() === 'EXTRACT' &&
      tokens[i + 1]?.token_type === 'L_PAREN' && tokens[i + 3]?.token_type === 'FROM' &&
      !OSSIE_PARTS[String(tokens[i + 2].text).toLowerCase()]);
  if (part >= 0) return ossiePart(tokens[part].text, tokens[part + 2].text);
  const chars = [...sql];
  const spelled = (t: SqlToken|undefined) => t ? chars.slice(t.span.start, t.span.end).join('') : '';
  // BigQuery has no time of day with a time zone.
  const zoned = rules !== 'ossie' ? -1 :
      tokens.findIndex((_, i) => tokens.slice(i, i + 4).map(spelled).join(' ').toUpperCase() === 'TIME WITH TIME ZONE');
  if (zoned >= 0) return `the type ${tokens.slice(zoned, zoned + 4).map(spelled).join(' ')}, which BigQuery does not have`;
  const sized = sizedType(tokens, chars);
  if (sized) return `the type ${sized}, with a number larger than kcmd's SQL parser holds`;
  if (read !== 'mysql' && read !== 'databricks') return undefined;
  for (const t of tokens) {
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

// The words after a type's first word that belong to its name, as in
// CHARACTER VARYING(10) or INTERVAL DAY TO SECOND(6).
const TYPE_NAME_WORDS = new Set(['VARYING', 'PRECISION', 'CHARACTER', 'CHAR', 'LARGE', 'OBJECT', 'YEAR',
  'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'TO']);

// A type of `tokens`, a text's tokens, whose `chars` are the text's, as
// written, with a number past 2^31 - 1 in the parentheses right after its
// name, such as VARCHAR(4294967297), or undefined. A type follows :: or the AS
// of a CAST, TRY_CAST or SAFE_CAST. A word of its name may start with PASS
// (see ossieText).
function sizedType(tokens: SqlToken[], chars: string[]): string|undefined {
  const word = (t: SqlToken|undefined) => !!t && /^[A-Za-z_]\w*$/.test(String(t.text));
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].token_type !== 'D_COLON' && !(tokens[i].token_type === 'AS' && isCastAs(tokens, i))) continue;
    if (!word(tokens[i + 1])) continue;
    let open = i + 2;
    while (word(tokens[open]) && TYPE_NAME_WORDS.has(String(tokens[open].text).replace(PASS, '').toUpperCase())) open++;
    if (tokens[open]?.token_type !== 'L_PAREN') continue;
    let close = open + 1;
    let big = false;
    for (let depth = 1; close < tokens.length; close++) {
      const {token_type: type, text} = tokens[close];
      if (type === 'L_PAREN') depth++;
      if (type === 'R_PAREN' && --depth === 0) break;
      big ||= depth === 1 && type === 'NUMBER' && /^\d+$/.test(String(text)) && BigInt(text) >= 2n ** 31n;
    }
    if (big) return chars.slice(tokens[i + 1].span.start, tokens[close]?.span.end ?? chars.length).join('');
  }
  return undefined;
}

// Whether `tokens[i]`, an AS, is that of a CAST, TRY_CAST or SAFE_CAST.
function isCastAs(tokens: SqlToken[], i: number): boolean {
  for (let k = i - 1, depth = 0; k > 0; k--) {
    if (tokens[k].token_type === 'R_PAREN') depth++;
    if (tokens[k].token_type === 'L_PAREN' && depth-- === 0) {
      return ['CAST', 'TRY_CAST', 'SAFE_CAST'].includes(String(tokens[k - 1].text).toUpperCase());
    }
  }
  return false;
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
// 'spanner' for a SPANNER text, which the engine reads as BigQuery's SQL. An
// OSSIE_SQL_2026 text has rules of its own, named 'ossie' (see "OSSIE_SQL_2026
// texts" below).
const DIALECTS = ['postgresql', 'mysql', 'tsql', 'snowflake', 'databricks', 'generic', 'spanner'];
const except = (...left: string[]) => DIALECTS.filter(d => !left.includes(d));

// The engine's dialect for each name of rules that is not one.
const ENGINE_DIALECTS: Record<string, string> = {spanner: 'bigquery', ossie: 'generic'};

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
  ...['annotated', 'column', 'literal', 'boolean', 'null', 'paren', 'neg', 'add', 'sub',
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
// Databricks rounds a DOUBLE through its shortest decimal text. An ANSI_SQL
// ROUND of a FLOAT rounds to the even number on PostgreSQL tables.
// DATE_TABLES lists the functions that give the current date or timestamp or
// add a unit. SPANNER_FUNCTIONS below lists Spanner's.
const FUNCTIONS: Record<string, [string[], number, number]> = {
  NULLIF: [except('spanner'), 2, 2],
  CONCAT: [['mysql', 'snowflake', 'databricks'], 1, Infinity],
  ROUND: [['tsql', 'snowflake'], 1, 2],
  DATE_TRUNC: [['postgresql', 'snowflake', 'databricks'], 2, 2],
  DATE_PART: [['postgresql', 'snowflake', 'tsql'], 2, 2],
  DATEDIFF: [['tsql', 'databricks'], 3, 3],
  DATE_DIFF: [['databricks'], 3, 3],
  TIMESTAMPDIFF: [['databricks'], 3, 3],
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
const CAST_TYPES = lookup({
  date: DIALECTS, double: except('postgresql', 'spanner'),
  float: ['snowflake', 'tsql', 'generic'],
  timestamp: ['postgresql', 'snowflake', 'spanner'], timestamptz: ['postgresql'],
  TIMESTAMPNTZ: ['snowflake'],
  ...Object.fromEntries(['string', 'INT64', 'FLOAT64', 'decimal'].map(t => [t, ['spanner']])),
});

// The literals import translates. The repairs write a decimal number as a
// NUMERIC, which is exact as in the sources.
const LITERALS = new Set(['string', 'number', 'date']);

// A date as BigQuery reads it in a DATE literal or a cast to DATE. PostgreSQL
// also reads other forms, such as 2024/03/15, and ignores a time of day.
const PLAIN_DATE = /^\d{4}-\d\d?-\d\d?$/;

// BigQuery's name for each date part import translates in EXTRACT, DATE_PART,
// DATE_TRUNC, DATEDIFF and functions such as YEAR(d), which the source writes
// in full.
const PARTS = lookup({
  year: 'YEAR', quarter: 'QUARTER', month: 'MONTH', day: 'DAY', hour: 'HOUR',
  minute: 'MINUTE',
});

// DATE_TRUNC also takes a week, which starts on Monday in PostgreSQL and
// Snowflake, as BigQuery's ISOWEEK does.
const TRUNC_PARTS = lookup({...PARTS, week: 'ISOWEEK'});

// The units of Databricks' date_trunc, by the string that names them in lower
// case, as BigQuery's TIMESTAMP_TRUNC names them. A week starts on Monday.
const DATABRICKS_TRUNC = lookup({
  year: 'YEAR', yyyy: 'YEAR', yy: 'YEAR', quarter: 'QUARTER', month: 'MONTH', mm: 'MONTH', mon: 'MONTH',
  week: 'WEEK(MONDAY)', day: 'DAY', dd: 'DAY', hour: 'HOUR', minute: 'MINUTE', second: 'SECOND',
  millisecond: 'MILLISECOND', microsecond: 'MICROSECOND',
});

// The date of _2 that Databricks counts months to from _1, both read in UTC:
// a day earlier when _2 is on a later date at an earlier time of day than _1,
// and a day later when it is on an earlier date at a later time of day.
const END_DAY = 'CASE WHEN DATE(TIMESTAMP(_2)) > DATE(TIMESTAMP(_1)) AND TIME(TIMESTAMP(_2)) < TIME(TIMESTAMP(_1)) ' +
    'THEN DATE_SUB(DATE(TIMESTAMP(_2)), INTERVAL 1 DAY) ' +
    'WHEN DATE(TIMESTAMP(_2)) < DATE(TIMESTAMP(_1)) AND TIME(TIMESTAMP(_2)) > TIME(TIMESTAMP(_1)) ' +
    'THEN DATE_ADD(DATE(TIMESTAMP(_2)), INTERVAL 1 DAY) ELSE DATE(TIMESTAMP(_2)) END';

// The whole months from _1 to END_DAY, toward zero: each date as 32 times
// its month plus its day of the month, which keeps their order, divided by 32.
const MONTHS_DIFF =
    `DIV(DATE_DIFF(${END_DAY}, DATE(TIMESTAMP(_1)), MONTH) * 32 + EXTRACT(DAY FROM ${END_DAY}) - ` +
    'EXTRACT(DAY FROM TIMESTAMP(_1)), 32)';

// BigQuery's SQL for Databricks' timestampdiff(unit, _1, _2), by the unit's
// name in lower case. Databricks counts the whole units from _1 to _2, toward
// zero, reading a DATE as midnight UTC, as BigQuery's TIMESTAMP_DIFF counts
// them between TIMESTAMP(x) values. A week is 7 days. It counts months by the
// calendar (see MONTHS_DIFF), a quarter as 3 of them and a year as 12.
const TIMESTAMP_DIFFS = lookup({
  ...Object.fromEntries(['microsecond', 'millisecond', 'second', 'minute', 'hour', 'day'].map(
      u => [u, `TIMESTAMP_DIFF(TIMESTAMP(_2), TIMESTAMP(_1), ${u.toUpperCase()})`])),
  week: 'DIV(TIMESTAMP_DIFF(TIMESTAMP(_2), TIMESTAMP(_1), DAY), 7)',
  month: MONTHS_DIFF, quarter: `DIV(${MONTHS_DIFF}, 3)`, year: `DIV(${MONTHS_DIFF}, 12)`,
});

// The SQL in TIMESTAMP_DIFFS for `part`, the unit of Databricks'
// timestampdiff and its other names, which is a name, or undefined.
function diffSql(part: any): string|undefined {
  const name = bare(part)?.column?.name;
  return name && !name.quoted ? TIMESTAMP_DIFFS[String(name.name).toLowerCase()] : undefined;
}

// BigQuery's name for the unit `part` names as DATE_TRUNC's first argument in
// the engine's dialect `read`, or undefined. Databricks names it in a string.
function truncUnit(part: any, read: string): string|undefined {
  if (read !== 'databricks') return TRUNC_PARTS[String(partName(part)).toLowerCase()];
  const literal = bare(part)?.literal;
  return literal?.literal_type === 'string' ? DATABRICKS_TRUNC[String(literal.value).toLowerCase()] : undefined;
}

// `entries` as a lookup that inherits no keys, so that a name in a source
// text, such as 'constructor', finds nothing.
function lookup<T>(entries: Record<string, T>): Record<string, T> {
  return Object.assign(Object.create(null), entries);
}

// --- Date arithmetic ------------------------------------------------------------
//
// Import translates a date or time plus or minus an amount of one unit only
// as its dialect's table in DATE_TABLES gives. Each spelling of the same
// arithmetic reads as one operand, amount and unit, and so finds the same row:
// MySQL's `x - INTERVAL 7 DAY` and DATE_SUB(x, INTERVAL 7 DAY), or Snowflake's
// `x - INTERVAL '7 days'` and DATEADD(day, -7, x). A `+` may name the INTERVAL
// first. The row gives the BigQuery SQL, which import writes itself (see
// dateSql), since the engine writes some units as another unit, such as
// Snowflake's DATEADD(m, 1, x), where m is a minute.

// The units import adds, as BigQuery names them.
const UNITS = [
  'MICROSECOND', 'MILLISECOND', 'SECOND', 'MINUTE', 'HOUR', 'DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR',
] as const;
type Unit = typeof UNITS[number];

// What import writes for an amount added to an operand: BigQuery's DATE_ADD or
// DATE_SUB, its TIME_ADD or TIME_SUB, or its `+` or `-`, and the row of the
// result in the same table.
// With `timestamp`, BigQuery adds to TIMESTAMP(x), the operand at midnight UTC.
// With `utc`, BigQuery adds to DATETIME(x, 'UTC'), the wall-clock time in UTC
// of a TIMESTAMP, and reads the result back with TIMESTAMP(y, 'UTC'), as a
// source adds a month to a timestamp in its time zone, UTC. With `inDays`,
// BigQuery adds each week as 7 days, which its DATE_ADD also adds to a
// TIMESTAMP. With `dayCount`, BigQuery's DATE_ADD adds the days from the
// operand's date to that date plus the amount, which keeps the type of a
// DATE, a DATETIME and a TIMESTAMP alike, and reads the date of a TIMESTAMP
// in BigQuery's default time zone, UTC.
interface Addition {
  form: 'DATE_ADD'|'TIME_ADD'|'+';
  gives: string;
  timestamp?: true;
  utc?: true;
  inDays?: true;
  dayCount?: true;
}

// One row of a dialect's table: an operand of one type in the source.
interface DateRow {
  // The operand's type in BigQuery. A column has none, since import cannot see
  // its type.
  type?: 'DATE'|'DATETIME'|'TIMESTAMP'|'TIME';
  // How a message names the operand.
  name: string;
  // The units import adds to the operand.
  units: Partial<Record<Unit, Addition>>;
  // What import writes for a whole number n added, which the dialect adds as n
  // days. DATE_ADD writes DATE_ADD(x, INTERVAL n DAY). `+` keeps the sum as
  // the source writes it, which BigQuery adds as days to a DATE and rejects
  // beside a timestamp, as the source does.
  days?: Addition;
  // Set when the dialect also adds a decimal number as days with their
  // fraction: the microseconds the fraction must be a whole number of, which
  // the operand's type holds exactly. Import adds the number as a whole amount
  // of the longest unit that holds it, by the row's `units`, such as 1.25 as
  // 30 hours.
  fractionStep?: bigint;
}

// The date arithmetic table of one dialect.
interface DateTable {
  // The rows, by the operand's type in the source. The row `column` is a
  // column, whose type import cannot see.
  rows: Record<string, DateRow>;
  // The row of a cast to DATE, a DATE literal and the current date.
  date: string;
  // The row of a cast to each other type that has one, by castType's name.
  casts?: Record<string, string>;
  // The row of a literal of each other type that has one, such as a
  // TIMESTAMP literal, by the engine's literal type.
  literals?: Record<string, string>;
  // The row of the value of each function that gives one type whatever its
  // arguments are, such as TO_DATE.
  typed?: Record<string, string>;
  // True when a value whose type import cannot see, such as COALESCE(a, b),
  // gets the row `column`, since BigQuery gives its own value for each type.
  anyOperand?: true;
  // Why a string beside an INTERVAL stays untranslated, for a message, where
  // the dialect gives the sum as text.
  stringNote?: string;
  // The functions whose value has the type of their last argument, such as
  // Snowflake's DATE_TRUNC, and so its row. MIN and MAX have the type of their
  // operand in every dialect.
  keepsType?: string[];
  // The functions that count whole units from a start to an end, with the
  // unit first, as Databricks' timestampdiff does (see TIMESTAMP_DIFFS).
  diffs?: string[];
  // The functions that count the days from a start to an end with two
  // arguments, the end first, as Databricks' datediff(end, start) does (see
  // dayDiffForm).
  dayDiffs?: string[];
  // The functions that give the current date. A name the engine keeps, which
  // BigQuery does not have, also needs an entry in CURRENT_TIME.
  today: string[];
  // The functions that give the current timestamp, and their row. A name the
  // engine keeps also needs an entry in CURRENT_TIME.
  now: {functions: string[]; row: string};
  // The functions that add a unit, by name, each with how it names the amount:
  // `interval` for MySQL's DATE_ADD(x, INTERVAL n unit), `interval or days`
  // for MySQL's ADDDATE, which also takes a number of days, `part` for
  // DATEADD(part, n, x), `days` for Databricks' date_add(x, n), which reads
  // x as a DATE and adds n days, and `days or part` for Databricks' date_add
  // and dateadd, which take either (see `partReads`).
  functions: Record<string, 'interval'|'interval or days'|'part'|'days'|'days or part'>;
  // The unit each word names, in lower case, in an INTERVAL string such as
  // '2 days' and as DATEADD's part.
  words: Record<string, Unit>;
  // The unit each word names as the part of a `part` or `days or part`
  // function, where the part's words differ from `words`.
  parts?: Record<string, Unit>;
  // The row a `days or part` function with a part reads its operand as, and
  // the rows of the operands it reads so.
  partReads?: {row: string; rows: string[]};
  // False when DATEADD's part may not be a string, such as 'day'.
  quotedParts?: false;
  // False when an INTERVAL may not name its unit outside its string, as in
  // INTERVAL 1 DAY or INTERVAL '1' DAY.
  keywords?: false;
  // True when an INTERVAL's amount may be any expression, as in INTERVAL n
  // DAY.
  expressions?: true;
  // True when DATEADD reads a string of a whole number, such as '1', as the
  // number.
  stringAmounts?: true;
  // Set when the dialect reads the amount of a date function, and a whole
  // number added to a DATE, as a 32-bit INT, where BigQuery reads an INT64: the
  // units by which an amount outside the INT range can still move a date to
  // one in the years 1 to 9999. The dialect wraps such an amount or rejects
  // it, so a number outside the range stays untranslated, and so does an
  // amount of these units that is not a number (see intRange).
  intAmounts?: Unit[];
  // True when the dialect turns a DATE or a DATETIME into the number of its
  // digits in arithmetic, negated or compared with a number, and into text
  // among number results, which import leaves untranslated (see valueForms).
  numbers?: true;
  // True when the dialect compares a DATE or a timestamp without time zone
  // with a TIMESTAMP, and gives them as results of one COALESCE, IF or CASE,
  // as the TIMESTAMP at its midnight or wall-clock time in UTC, as BigQuery's
  // TIMESTAMP(x) reads it (see valueForms).
  stamps?: true;
  // True when the dialect gives the difference of two dates or times, one of
  // them a timestamp, as an INTERVAL of days and a time of day (see
  // timeDifference).
  differences?: true;
  // True when the dialect's EXTRACT gives each part of an INTERVAL as a
  // numeric, and its DATE_PART as a double (see INTERVAL_PARTS).
  intervalParts?: true;
  // The units an INTERVAL may name, when the dialect has fewer than UNITS or
  // than its function names.
  intervals?: Unit[];
  // The words in an INTERVAL string that name a multiple of a unit, such as
  // decade, by the word in lower case, with the unit and the multiple.
  multiples?: Record<string, [Unit, bigint]>;
  // True when an INTERVAL string may name several units, such as '1 day 2
  // hours'.
  severalUnits?: true;
  // True when an INTERVAL may restrict a string to the fields down to a unit,
  // as INTERVAL '90 minutes' HOUR does (see restricted).
  fields?: true;
  // The compound units an INTERVAL may name, such as HOUR_MINUTE, with the
  // units of their parts (see compoundParts).
  compounds?: Record<string, Unit[]>;
  // The groups of units that one INTERVAL value may join, in a dialect whose
  // INTERVALs are values: a sum or difference of INTERVALs, such as INTERVAL
  // '1 day' + INTERVAL '2 hours', or an INTERVAL times an amount. Each group is
  // a type, by its name for a message, which the dialect compares with no
  // other.
  sums?: Record<string, Unit[]>;
  // The finest unit of an INTERVAL value of weeks or shorter units that holds
  // a product, in a dialect whose product of such an INTERVAL is of that unit.
  products?: Unit;
  // Why import adds a unit to no operand, or to the operands of some rows, by
  // unit, for a message.
  notes?: Partial<Record<Unit, string>>;
}

// `units`, each added in `form`, giving the row `gives`.
function adds(units: readonly Unit[], form: Addition['form'], gives: string):
    Partial<Record<Unit, Addition>> {
  return Object.fromEntries(units.map(u => [u, {form, gives}]));
}

// Weeks added with DATE_ADD as days (see Addition), giving the row `gives`.
function weeksAsDays(gives: string): Partial<Record<Unit, Addition>> {
  return {WEEK: {form: 'DATE_ADD', gives, inDays: true}};
}

// `units`, each added as a number of days with DATE_ADD (see Addition),
// giving the row `gives`.
function asDays(units: readonly Unit[], gives: string): Partial<Record<Unit, Addition>> {
  return Object.fromEntries(units.map(u => [u, {form: 'DATE_ADD', gives, dayCount: true}]));
}

// `units`, each added with `+` to the wall-clock time in UTC (see Addition),
// giving the row `gives`.
function inUtc(units: readonly Unit[], gives: string): Partial<Record<Unit, Addition>> {
  return Object.fromEntries(units.map(u => [u, {form: '+', gives, utc: true}]));
}

// The unit each word in `words` names, by the word in lower case.
function named(words: Partial<Record<Unit, string[]>>): Record<string, Unit> {
  return Object.fromEntries(Object.entries(words).flatMap(
      ([unit, list]) => [unit.toLowerCase(), ...list!].map(w => [w, unit as Unit])));
}

const SUB_DAY: Unit[] = ['MICROSECOND', 'MILLISECOND', 'SECOND', 'MINUTE', 'HOUR'];
const DAY_OR_LONGER: Unit[] = ['DAY', 'WEEK', 'MONTH', 'QUARTER', 'YEAR'];
const MAY_BE_TIMESTAMP = 'a value that may be a TIMESTAMP';

// The date arithmetic table of each dialect, by the engine's name. Each
// dialect runs under its default settings: PostgreSQL, MySQL, SQL Server and
// Databricks in UTC, and Snowflake in America/Los_Angeles, with TIMESTAMP read
// as TIMESTAMP_NTZ. A column may be a DATE, a DATETIME or a TIMESTAMP in
// BigQuery, so its row holds only the units that give the source's value and
// type for each, or that BigQuery rejects for one, such as a month on a
// TIMESTAMP. BigQuery's DATE_ADD adds no hour, minute or second to a DATE,
// and no week, month, quarter or year to a TIMESTAMP. Its `+` gives a DATETIME
// for a DATE plus any INTERVAL, and adds no month, quarter or year to a
// TIMESTAMP. An ANSI_SQL text runs by the rules of its tables' database, and
// the databases add a unit to a DATE as different types. A SPANNER text has no
// table. spannerNodes keeps its weeks, days, hours and minutes, which BigQuery
// adds as Spanner does.
const DATE_TABLES: Record<string, DateTable> = {
  // MySQL gives a DATE for a DATE plus a day or longer, and a DATETIME for a
  // DATE plus an hour, a minute or a second, as BigQuery's DATE_ADD and `+`
  // do. ADDDATE and SUBDATE are DATE_ADD and DATE_SUB, and with a number they
  // add days. Its current timestamp is a DATETIME in whole seconds, which the
  // repairs write as DATETIME_TRUNC(CURRENT_DATETIME('UTC'), SECOND). It reads a
  // date plus a number as a number. It reads a string beside an INTERVAL as a
  // date and gives the sum as text.
  mysql: {
    date: 'DATE', today: ['CURRENT_DATE', 'CURDATE'], numbers: true, stringNote: 'whose sum MySQL gives as text',
    now: {functions: ['NOW', 'CURRENT_TIMESTAMP', 'LOCALTIMESTAMP', 'LOCALTIME'], row: 'DATETIME'},
    functions: {DATE_ADD: 'interval', DATE_SUB: 'interval', ADDDATE: 'interval or days', SUBDATE: 'interval or days'},
    words: {}, expressions: true, intervals: UNITS.filter(u => u !== 'MILLISECOND'),
    compounds: {
      YEAR_MONTH: ['YEAR', 'MONTH'], DAY_HOUR: ['DAY', 'HOUR'], DAY_MINUTE: ['DAY', 'HOUR', 'MINUTE'],
      DAY_SECOND: ['DAY', 'HOUR', 'MINUTE', 'SECOND'],
      DAY_MICROSECOND: ['DAY', 'HOUR', 'MINUTE', 'SECOND', 'MICROSECOND'], HOUR_MINUTE: ['HOUR', 'MINUTE'],
      HOUR_SECOND: ['HOUR', 'MINUTE', 'SECOND'], HOUR_MICROSECOND: ['HOUR', 'MINUTE', 'SECOND', 'MICROSECOND'],
      MINUTE_SECOND: ['MINUTE', 'SECOND'], MINUTE_MICROSECOND: ['MINUTE', 'SECOND', 'MICROSECOND'],
      SECOND_MICROSECOND: ['SECOND', 'MICROSECOND'],
    },
    rows: {
      column: {
        name: MAY_BE_TIMESTAMP,
        units: {
          ...adds(['DAY', 'MONTH', 'QUARTER', 'YEAR'], 'DATE_ADD', 'column'), ...weeksAsDays('column'),
          ...adds(SUB_DAY, '+', 'column'),
        },
      },
      DATE: {
        type: 'DATE', name: 'a DATE',
        units: {...adds(DAY_OR_LONGER, 'DATE_ADD', 'DATE'), ...adds(SUB_DAY, '+', 'DATETIME')},
      },
      DATETIME: {type: 'DATETIME', name: 'a DATETIME', units: adds(UNITS, 'DATE_ADD', 'DATETIME')},
    },
  },
  // PostgreSQL gives a timestamp without time zone for a date or a timestamp
  // plus any INTERVAL, as BigQuery's `+` gives a DATETIME, and a date for a
  // date plus a whole number. A column plus an INTERVAL is a timestamp, which
  // no whole number is added to. Its current timestamp is a timestamptz, a
  // TIMESTAMP in BigQuery, and a day there is 24 hours in UTC. It adds a month
  // or a year to it in UTC (see Addition). It has no
  // INTERVAL of a quarter. It joins INTERVALs of any units into one value,
  // which it adds months first, then days, then time, as BigQuery adds an
  // INTERVAL. Its difference of two dates or times, one of them a timestamp,
  // is an INTERVAL (see timeDifference).
  postgresql: {
    date: 'date', today: ['CURRENT_DATE'], now: {functions: ['NOW', 'CURRENT_TIMESTAMP'], row: 'timestamptz'},
    casts: lookup({timestamp: 'timestamp', timestamptz: 'timestamptz'}), functions: {},
    words: named({
      MICROSECOND: ['microseconds', 'microsecon', 'us', 'usec', 'usecs', 'useconds'],
      MILLISECOND: ['milliseconds', 'millisecon', 'ms', 'msec', 'msecs', 'mseconds'],
      SECOND: ['seconds', 'sec', 'secs', 's'], MINUTE: ['minutes', 'min', 'mins', 'm'],
      HOUR: ['hours', 'h', 'hr', 'hrs'], DAY: ['days', 'd'], WEEK: ['weeks', 'w'],
      MONTH: ['months', 'mon', 'mons'], YEAR: ['years', 'y', 'yr', 'yrs'],
    }),
    multiples: Object.fromEntries(([
      [10n, ['decade', 'decades', 'dec', 'decs']], [100n, ['century', 'centuries', 'c', 'cent']],
      [1000n, ['millennium', 'millennia', 'mil', 'mils']],
    ] as [bigint, string[]][]).flatMap(([n, words]) => words.map(w => [w, ['YEAR', n]]))),
    severalUnits: true, fields: true, sums: {INTERVAL: [...UNITS]}, stamps: true, differences: true, intervalParts: true,
    rows: {
      column: {name: MAY_BE_TIMESTAMP, units: adds([...SUB_DAY, 'DAY', 'WEEK', 'MONTH', 'YEAR'], '+', 'column')},
      date: {
        type: 'DATE', name: 'a DATE',
        units: adds([...SUB_DAY, 'DAY', 'WEEK', 'MONTH', 'YEAR'], '+', 'timestamp'),
        days: {form: 'DATE_ADD', gives: 'date'},
      },
      timestamp: {
        type: 'DATETIME', name: 'a timestamp',
        units: adds([...SUB_DAY, 'DAY', 'WEEK', 'MONTH', 'YEAR'], '+', 'timestamp'),
      },
      timestamptz: {
        type: 'TIMESTAMP', name: 'a timestamptz',
        units: {
          ...adds([...SUB_DAY, 'DAY', 'WEEK'], '+', 'timestamptz'),
          ...inUtc(['MONTH', 'YEAR'], 'timestamptz'),
        },
      },
    },
  },
  // Snowflake's DATEADD, and its TIMEADD and TIMESTAMPADD, give a DATE for a
  // DATE plus a day or longer, and a TIMESTAMP_NTZ for a DATE plus an hour, a
  // minute or a second, which no whole number is added to. A TIMESTAMP_NTZ,
  // such as a cast to TIMESTAMP, gets every unit, as BigQuery adds them to a
  // DATETIME. Its DATE_TRUNC keeps the type of its date. A month that
  // lacks the day gives its last day, as in BigQuery. An interval string such
  // as '1 day' also gives a DATE for a DATE, but its rule for a month that
  // lacks the day may differ from DATEADD's, so an interval string names a day
  // or less. An INTERVAL that names its unit outside its string is of another
  // type, which gives a timestamp for a DATE plus a day. Snowflake adds a whole
  // number to a DATE as days and rejects it beside a timestamp. A week is 7
  // days, so a column gets weeks as days. Its current timestamp is a
  // TIMESTAMP_LTZ, which the repairs write as the DATETIME in
  // America/Los_Angeles. Snowflake adds a day to it in local time, as BigQuery
  // adds one to a DATETIME. Import adds no hour, minute or second to it, which
  // Snowflake may add as elapsed time, unlike a DATETIME near a daylight saving
  // change.
  snowflake: {
    date: 'DATE', today: ['CURRENT_DATE'], now: {functions: ['CURRENT_TIMESTAMP'], row: 'TIMESTAMP_LTZ'},
    casts: lookup({timestamp: 'TIMESTAMP_NTZ', TIMESTAMPNTZ: 'TIMESTAMP_NTZ'}), keepsType: ['DATE_TRUNC'],
    functions: {DATEADD: 'part', TIMEADD: 'part', TIMESTAMPADD: 'part'}, keywords: false,
    intervals: [...SUB_DAY, 'DAY'],
    words: named({
      MICROSECOND: ['us', 'usec', 'microseconds'], MILLISECOND: ['ms', 'msec', 'milliseconds'],
      SECOND: ['s', 'sec', 'seconds', 'secs'], MINUTE: ['m', 'mi', 'min', 'minutes', 'mins'],
      HOUR: ['h', 'hh', 'hr', 'hours', 'hrs'], DAY: ['d', 'dd', 'days', 'dayofmonth'],
      WEEK: ['w', 'wk', 'weekofyear', 'woy', 'wy'], MONTH: ['mm', 'mon', 'mons', 'months'],
      QUARTER: ['q', 'qtr', 'qtrs', 'quarters'], YEAR: ['y', 'yy', 'yyy', 'yyyy', 'yr', 'years', 'yrs'],
    }),
    rows: {
      column: {
        name: MAY_BE_TIMESTAMP,
        units: {
          ...adds(['DAY', 'MONTH', 'QUARTER', 'YEAR'], 'DATE_ADD', 'column'), ...weeksAsDays('column'),
          ...adds(SUB_DAY, '+', 'TIMESTAMP_NTZ'),
        },
        days: {form: '+', gives: 'column'},
      },
      DATE: {
        type: 'DATE', name: 'a DATE',
        units: {...adds(DAY_OR_LONGER, 'DATE_ADD', 'DATE'), ...adds(SUB_DAY, '+', 'TIMESTAMP_NTZ')},
        days: {form: 'DATE_ADD', gives: 'DATE'},
      },
      TIMESTAMP_NTZ: {
        type: 'DATETIME', name: 'a TIMESTAMP_NTZ',
        units: {...adds(DAY_OR_LONGER, 'DATE_ADD', 'TIMESTAMP_NTZ'), ...adds(SUB_DAY, '+', 'TIMESTAMP_NTZ')},
      },
      TIMESTAMP_LTZ: {type: 'DATETIME', name: 'a TIMESTAMP_LTZ', units: adds(DAY_OR_LONGER, 'DATE_ADD', 'TIMESTAMP_LTZ')},
    },
  },
  // Databricks gives a DATE for a DATE plus an INTERVAL of days, weeks, months
  // or years and for date_add(x, n), date_sub(x, n) and dateadd(x, n), and a
  // TIMESTAMP for a DATE plus an hour, a minute or a second, which it reads
  // at midnight UTC, as BigQuery's TIMESTAMP(x) does. It joins INTERVALs of
  // months and years, or of weeks and smaller units, into one value, whose
  // smallest unit gives the type of a DATE plus it. A product of weeks or
  // smaller units is of seconds, so a DATE plus it is a TIMESTAMP. It adds a
  // whole number to a DATE as days. Its current timestamp is a TIMESTAMP, and
  // a day there is 24 hours in UTC. It adds a month or a year to it in UTC.
  // Its difference of two dates or times, one of them a TIMESTAMP, is a day
  // and time INTERVAL (see timeDifference).
  // Its timestampadd, and its three-argument dateadd and date_add, whose part
  // is a name, read a DATE as a TIMESTAMP at midnight UTC and give a
  // TIMESTAMP. They keep the type of a TIMESTAMP_NTZ, which a column may be, so
  // a column gets no part. They add a quarter, which an INTERVAL does not name.
  // They read their amount as an INT, and wrap a larger one, such as
  // 4294967301 as 5. Its date_add and date_sub of a number of days, and a DATE
  // plus a whole number, reject an amount that is not an INT. 2^31 minutes,
  // about 4083 years, can move a date to another in the years 1 to 9999, and
  // 2^31 hours cannot.
  databricks: {
    date: 'DATE', today: ['CURRENT_DATE', 'CURDATE'], now: {functions: ['NOW', 'CURRENT_TIMESTAMP'], row: 'TIMESTAMP'},
    functions: {DATE_ADD: 'days or part', DATE_SUB: 'days', DATEADD: 'days or part', TIMESTAMPADD: 'part'},
    diffs: ['TIMESTAMPDIFF', 'DATEDIFF', 'DATE_DIFF'], dayDiffs: ['DATEDIFF', 'DATE_DIFF'],
    words: named({
      MICROSECOND: ['microseconds'], MILLISECOND: ['milliseconds'], SECOND: ['seconds'], MINUTE: ['minutes'],
      HOUR: ['hours'], DAY: ['days'], WEEK: ['weeks'], MONTH: ['months'], YEAR: ['years'],
    }),
    parts: named({...Object.fromEntries(UNITS.map(u => [u, []])), DAY: ['dayofyear']}),
    quotedParts: false, intervals: UNITS.filter(u => u !== 'QUARTER'),
    partReads: {row: 'TIMESTAMP', rows: ['DATE', 'TIMESTAMP']},
    notes: Object.fromEntries(SUB_DAY.map(
        unit => [unit, 'which gives a TIMESTAMP for a DATE in Databricks and a DATETIME in BigQuery'])),
    sums: {'year-month INTERVAL': ['MONTH', 'YEAR'], 'day-time INTERVAL': [...SUB_DAY, 'DAY', 'WEEK']},
    products: 'SECOND', stamps: true, differences: true, intAmounts: ['MICROSECOND', 'MILLISECOND', 'SECOND', 'MINUTE'],
    rows: {
      column: {
        name: MAY_BE_TIMESTAMP, units: {...adds(['DAY', 'MONTH', 'YEAR'], 'DATE_ADD', 'column'), ...weeksAsDays('column')},
        days: {form: '+', gives: 'column'},
      },
      DATE: {
        type: 'DATE', name: 'a DATE',
        units: {
          ...adds(['DAY', 'WEEK', 'MONTH', 'YEAR'], 'DATE_ADD', 'DATE'),
          ...Object.fromEntries(SUB_DAY.map(u => [u, {form: '+', gives: 'TIMESTAMP', timestamp: true}])),
        },
        days: {form: 'DATE_ADD', gives: 'DATE'},
      },
      TIMESTAMP: {
        type: 'TIMESTAMP', name: 'a TIMESTAMP',
        units: {...adds([...SUB_DAY, 'DAY', 'WEEK'], '+', 'TIMESTAMP'), ...inUtc(['MONTH', 'QUARTER', 'YEAR'], 'TIMESTAMP')},
      },
    },
  },
  // SQL Server's DATEADD gives the type of its date, and a month that lacks
  // the day gives its last day, as in BigQuery. It adds no hour or minute to
  // a date, as BigQuery's DATE_ADD does not, and a smalldatetime ignores some
  // seconds, so a column gets no second. Its part is a name, never a
  // string, and its dayofyear and weekday parts add days. GETDATE() and
  // CURRENT_TIMESTAMP give a datetime, which the repairs write as
  // CURRENT_DATETIME('UTC'). It has no INTERVAL, and its date plus a number
  // depends on the date's type: a datetime plus a number adds that many days,
  // with their fraction, and a date rejects it. A datetime counts 1/300 of a
  // second, which holds a decimal fraction of a day exactly when it is whole
  // hundredths of a second.
  tsql: {
    date: 'date', today: ['CURRENT_DATE'], now: {functions: ['GETDATE', 'CURRENT_TIMESTAMP'], row: 'datetime'},
    functions: {DATEADD: 'part'}, quotedParts: false, intervals: [], stringAmounts: true,
    words: named({
      SECOND: ['ss', 's'], MINUTE: ['mi', 'n'], HOUR: ['hh'],
      DAY: ['dd', 'd', 'dayofyear', 'dy', 'y', 'weekday', 'dw', 'w'], WEEK: ['wk', 'ww'],
      MONTH: ['mm', 'm'], QUARTER: ['qq', 'q'], YEAR: ['yy', 'yyyy'],
    }),
    rows: {
      column: {
        name: 'a value that may be a date or a TIMESTAMP',
        units: {
          ...adds(['MINUTE', 'HOUR', 'DAY', 'MONTH', 'QUARTER', 'YEAR'], 'DATE_ADD', 'column'), ...weeksAsDays('column'),
        },
      },
      date: {type: 'DATE', name: 'a date', units: adds(DAY_OR_LONGER, 'DATE_ADD', 'date')},
      datetime: {
        type: 'DATETIME', name: 'a datetime', units: adds(UNITS.filter(u => u !== 'MICROSECOND'), 'DATE_ADD', 'datetime'),
        days: {form: 'DATE_ADD', gives: 'datetime'}, fractionStep: 10000n,
      },
    },
  },
  // An OSSIE_SQL_2026 text adds a unit with DATEADD(part, n, x), which gives
  // BigQuery's own value and type for each type of x. A column, or any other
  // value whose type import cannot see, gets forms that BigQuery runs for a
  // DATE, a DATETIME and a TIMESTAMP alike: DATE_ADD for a day, a week as 7
  // days, a month, a quarter or a year as the days it adds to the value's date
  // (see Addition), and `+` for an hour or less, which gives a DATETIME for a
  // DATE. BigQuery's DATE_ADD adds no month, quarter or year to a TIMESTAMP, so
  // a TIMESTAMP gets them in UTC (see Addition). A TIMESTAMP_NTZ is a
  // DATETIME. A TIME, such as the current time, gets TIME_ADD for an hour or
  // less, and no longer unit, since it holds no date.
  ossie: {
    date: 'DATE', today: ['CURRENT_DATE'], now: {functions: ['CURRENT_TIMESTAMP'], row: 'TIMESTAMP'},
    casts: lookup({timestamp: 'TIMESTAMP', TIMESTAMPNTZ: 'TIMESTAMP_NTZ', time: 'TIME'}),
    literals: {timestamp: 'TIMESTAMP', time: 'TIME'},
    typed: {TO_DATE: 'DATE', TO_TIMESTAMP: 'TIMESTAMP', CURRENT_TIME: 'TIME'}, keepsType: ['DATE_TRUNC'], anyOperand: true,
    functions: {DATEADD: 'part'}, words: named(Object.fromEntries(UNITS.map(u => [u, []]))),
    rows: {
      column: {
        name: MAY_BE_TIMESTAMP,
        units: {
          ...adds(['DAY'], 'DATE_ADD', 'column'), ...weeksAsDays('column'), ...asDays(['MONTH', 'QUARTER', 'YEAR'], 'column'),
          ...adds(SUB_DAY, '+', 'column'),
        },
      },
      DATE: {
        type: 'DATE', name: 'a DATE',
        units: {...adds(DAY_OR_LONGER, 'DATE_ADD', 'DATE'), ...adds(SUB_DAY, '+', 'TIMESTAMP_NTZ')},
      },
      TIMESTAMP_NTZ: {type: 'DATETIME', name: 'a TIMESTAMP_NTZ', units: adds(UNITS, 'DATE_ADD', 'TIMESTAMP_NTZ')},
      TIMESTAMP: {
        type: 'TIMESTAMP', name: 'a TIMESTAMP',
        units: {...adds([...SUB_DAY, 'DAY', 'WEEK'], '+', 'TIMESTAMP'), ...inUtc(['MONTH', 'QUARTER', 'YEAR'], 'TIMESTAMP')},
      },
      TIME: {type: 'TIME', name: 'a TIME', units: adds(SUB_DAY, 'TIME_ADD', 'TIME')},
    },
  },
  generic: {
    date: 'DATE', today: ['CURRENT_DATE'], now: {functions: ['CURRENT_TIMESTAMP'], row: 'TIMESTAMP'},
    functions: {}, words: {},
    notes: {DAY: 'which gives a DATE in some databases and a timestamp in others'},
    rows: {
      column: {name: MAY_BE_TIMESTAMP, units: {}},
      DATE: {type: 'DATE', name: 'a DATE', units: {}},
      TIMESTAMP: {type: 'TIMESTAMP', name: 'a TIMESTAMP', units: {}},
    },
  },
};

// One date arithmetic in a source text: `operand` plus or minus `amount`, a
// whole number or an expression of `unit`, and what its row gives. A whole number added as days
// that import writes as the source does has no unit. The INTERVAL may come
// `first`. A `call` is a function, such as DATEADD. The source reads an
// operand of another type as `reads`, a DATE or a TIMESTAMP, first.
interface DateSum {
  operand: any;
  amount: any;
  unit?: Unit;
  subtract: boolean;
  first?: boolean;
  call?: boolean;
  reads?: 'DATE'|'TIMESTAMP';
  addition: Addition;
  // The values in an INTERVAL value that import writes as the source does,
  // for the checks, and the value itself when a function adds it.
  values?: any[];
  interval?: any;
}

// The date arithmetic in `node`, a source node in the engine's dialect `read`.
// A message when import does not translate it, and undefined when `node` is no
// date arithmetic. A sum of a column and a number is no date arithmetic, since
// import cannot see whether the column is a date.
function dateSum(node: any, read: string): DateSum|string|undefined {
  const table = DATE_TABLES[read];
  const kind = kindOf(node);
  if (!table || !kind) return undefined;
  if (kind === 'add' || kind === 'sub') return operatorSum(kind, node[kind], read, table);
  const name = String(node.function?.name).toUpperCase();
  return kind === 'function' && table.functions[name] ?
      functionSum(name, node.function.args ?? [], read, table) : undefined;
}

// The date arithmetic of `value`, a `+` or `-` of `kind`, as dateSum gives it.
function operatorSum(kind: string, value: any, read: string, table: DateTable):
    DateSum|string|undefined {
  const op = OPERATORS[kind];
  const values = [value.left, value.right].map(s => intervalValue(s, read, table));
  // A sum of two INTERVAL values is an INTERVAL value (see intervalValue).
  if (values[0] && values[1] && table.sums) return undefined;
  if (values[0] || values[1]) {
    const first = !!values[0];
    const [side, operand] = first ? [value.left, value.right] : [value.right, value.left];
    const added = intervalOf(side, read);
    const written = added ? `INTERVAL ${intervalText(added, table)}` : 'an INTERVAL value';
    if (first && kind === 'sub') return `- with ${written} first`;
    const joined = values[first ? 0 : 1]!;
    if (typeof joined === 'string') return joined;
    const subtract = kind === 'sub';
    if (!added || joined.parts.length > 1) return valueOn(table, read, {operand, joined, subtract, first, op});
    const {amount, unit} = joined.parts[0];
    return sumOn(table, read, {
      operand, amount, unit, subtract, first, name: op, spelling: `${op} ${written}`, unitText: written,
    });
  }
  // A number added to a date, which some dialects add as days.
  const [operand, amount] = dayOperands(kind, value);
  const text = numberText(amount) ?? '';
  if (!/^-?\d*\.?\d+$/.test(text) || bare(operand)?.column) return undefined;
  const found = operandRow(operand, read, table);
  if (typeof found === 'string') return found;
  const row = found && table.rows[found.row];
  const subtract = kind === 'sub';
  const range = /^-?\d+$/.test(text) ? intRange(text, table) : undefined;
  // A whole number added to a DATE that COALESCE or a similar function gives
  // stays as written, where the dialect adds it to a DATE as days.
  if (!found && /^-?\d+$/.test(text) && table.rows[table.date].days && dateResults(operand, read)) {
    return range ? `${op} ${range}` : {operand, amount: wholeNumber(text), subtract, addition: {form: '+', gives: table.date}};
  }
  if (!row?.days) return undefined;
  if (/^-?\d+$/.test(text)) {
    if (range) return `${op} ${range}`;
    const unit = row.days.form === 'DATE_ADD' ? 'DAY' : undefined;
    return {operand, amount: wholeNumber(text), unit, subtract, addition: row.days};
  }
  const part = row.fractionStep && dayFraction(text, row.fractionStep);
  const addition = part && row.units[part.unit];
  return addition ? {operand, ...part, subtract, addition} : undefined;
}

// Whether `node`, a source value, is one that COALESCE, IF, CASE or a similar
// function gives, whose results are visibly DATEs, besides columns and NULL.
// The sources add a whole number to it as days, and reject it when a column
// makes it a timestamp, as BigQuery does for a DATETIME or a TIMESTAMP.
function dateResults(node: any, read: string): boolean {
  const given = returned(node).length ? givenValues(node) : [];
  const types = given.map(g => timeType(g, read));
  return types.includes('DATE') &&
      given.every((g, i) => types[i] === 'DATE' || !g || bare(g).column || bare(g).null !== undefined);
}

// `text`, a decimal number of days, as a whole amount of the longest unit of a
// day or less that holds it, or undefined when it is not a whole number of
// `step` microseconds.
function dayFraction(text: string, step: bigint): {amount: unknown; unit: Unit}|undefined {
  const [, sign, whole, fraction] = /^(-?)(\d*)\.(\d+)$/.exec(text)!;
  const scale = 10n ** BigInt(fraction.length);
  const micros = BigInt(whole + fraction) * DAY_MICROS;
  if (micros % scale || (micros / scale) % step) return undefined;
  const per: Partial<Record<Unit, bigint>> = {DAY: DAY_MICROS, ...MICROS};
  const unit = (['DAY', ...[...SUB_DAY].reverse()] as Unit[]).find(u => (micros / scale) % per[u]! === 0n)!;
  return {amount: wholeNumber(`${sign}${micros / scale / per[unit]!}`), unit};
}

// The date arithmetic of a call of `name` with `args`, a function in the
// `functions` of `table`, as dateSum gives it.
function functionSum(name: string, args: any[], read: string, table: DateTable): DateSum|string {
  const how = table.functions[name];
  const subtract = name.includes('SUB');
  // A `days or part` function names a part with three arguments.
  const byPart = how === 'part' || (how === 'days or part' && args.length === 3);
  const byDays = how === 'days' || (how === 'days or part' && !byPart);
  const added = !byPart && args.length === 2 ? bare(args[1])?.interval : undefined;
  if (added && !byDays) {
    const parsed = readInterval(added, table, read);
    const spelling = `${name} with INTERVAL ${intervalText(added, table)}`;
    if (typeof parsed === 'string') return `${name} with ${parsed}`;
    if (parsed.length > 1) {
      const text = `INTERVAL ${intervalText(added, table)}`;
      const joined = {parts: parsed.map(p => ({...p, text, negative: false})), values: []};
      return valueOn(table, read, {operand: args[0], joined, subtract, op: name, call: true, interval: args[1]});
    }
    return sumOn(table, read, {operand: args[0], ...parsed[0], subtract, call: true, name, spelling, unitText: spelling});
  }
  const [part, amount, operand] = byPart ? args : [undefined, args[1], args[0]];
  if (how === 'interval' || args.length !== (byPart ? 3 : 2) || added) return name;
  const whole = functionAmount(amount, read, table);
  if (typeof whole === 'string') return `${name} ${whole}`;
  const spelling = byPart ? `${name} with part '${partName(part) ?? '?'}'` : name;
  // A part is a name, or a string where the dialect takes one.
  const named = !bare(part)?.column?.name?.quoted && (table.quotedParts !== false || !bare(part)?.literal);
  const words = table.parts ?? table.words;
  const unit = !byPart ? 'DAY' : named ? words[String(partName(part)).toLowerCase()] : undefined;
  if (!unit) return spelling;
  if (table.intAmounts?.includes(unit) && numberText(whole) === undefined) return `${spelling} by an expression`;
  const as = byDays ? {row: table.date, rows: Object.keys(table.rows)} : byPart ? table.partReads : undefined;
  return sumOn(table, read, {operand, amount: whole, unit, subtract, call: true, as, name, spelling, unitText: spelling});
}

// The amount of `amount`, the number of units a function such as DATEADD(day,
// n, d) adds, in `table`, the table of the engine's dialect `read`, as import
// writes it, or a message. A number is whole, and a string of a whole number
// is the number where the dialect reads it so. Any other expression that is
// not visibly an INTERVAL is written as it is. BigQuery rejects one that is
// not an INT64, where the sources may round it. The sources and BigQuery
// reject an INTERVAL there. A dialect with `intAmounts` reads a number as an
// INT (see intRange).
function functionAmount(amount: any, read: string, table: DateTable): unknown {
  const b = bare(amount);
  const text = literalText(b?.literal);
  const string = b?.literal?.literal_type === 'string' && /^\s*[+-]?\d+\s*$/.test(text ?? '');
  const written = numberText(b) ?? (table.stringAmounts && string ? text : undefined);
  if (written === undefined) {
    return b?.literal ? `by ${valueName(b)}` : intervalTyped(b, read) ? 'by an INTERVAL' : amount;
  }
  if (!/^\s*[+-]?\d+\s*$/.test(written)) return 'of a fraction';
  return intRange(written, table) ?? wholeNumber(written);
}

// A message when `table`'s dialect reads `text`, a whole number of a date
// function or added to a DATE, as an INT and it is outside the INT range, or
// undefined (see `intAmounts`).
function intRange(text: string, table: DateTable): string|undefined {
  const n = BigInt(text.trim());
  return table.intAmounts && (n < -(2n ** 31n) || n >= 2n ** 31n) ? 'by a number outside the INT range' : undefined;
}

// The amount and the unit of each INTERVAL in `added`, an engine interval, in
// `table`, the table of the engine's dialect `read`, or a message. An amount
// is a whole number, or an expression where the dialect's INTERVAL takes one
// that may be an INT64 (see notWhole). A string such as '1 day'
// names one unit, or several in a dialect with `severalUnits`. With `fields`,
// a string with its unit outside, such as INTERVAL '90 minutes' HOUR, is
// restricted to that unit (see restricted), as is a PostgreSQL cast with
// fields, such as '90 minutes'::interval hour.
function readInterval(added: any, table: DateTable, read: string): {amount: any; unit: Unit}[]|string {
  const text = `INTERVAL ${intervalText(added, table)}`;
  // A number, or a string such as '1' or '1 day'. A hex, bit, national or
  // triple-quoted string is refused, since the sources read some of them as
  // another number.
  const literal = bare(added.this)?.literal;
  const written = numberText(added.this) ??
      (literal?.literal_type === 'string' && typeof literal.value === 'string' ? literal.value : undefined);
  const unit = String(added.unit?.unit).toUpperCase() as Unit;
  const simple = added.unit?.type === 'simple' && UNITS.includes(unit);
  if (written === undefined && table.expressions && !literal && simple) {
    const other = notWhole(added.this, read);
    return other ? `INTERVAL of ${other}` : [{amount: added.this, unit}];
  }
  if (written === undefined) return `INTERVAL of ${valueName(bare(added.this))}`;
  const span = added.unit?.type === 'span' ? `${unitName(added.unit.this)}_${unitName(added.unit.expression)}` : '';
  const compound = table.compounds?.[span];
  if (compound) return compoundParts(written, compound) ?? text;
  const whole = /^\s*[+-]?\d+\s*$/.test(written);
  const named = simple && table.keywords !== false && (!table.intervals || table.intervals.includes(unit));
  const fields = added.fields ?? (named && table.fields && !whole ? unit : undefined);
  if (added.unit === null || fields) {
    const parts = stringParts(written, table);
    return !parts ? text : fields ? restricted(parts, fields) : parts;
  }
  return named && whole ? [{amount: wholeNumber(written), unit}] : text;
}

// The INTERVALs MySQL reads from `text`, the amount of an INTERVAL with a
// compound unit whose parts are `units`, such as '1:30' for HOUR_MINUTE. A
// minus sign first, after any spaces, negates every part. Each part is a whole
// number, with any characters other than digits between them, and fewer
// numbers fill the smallest parts. The digits of microseconds are a fraction
// of a second, so fewer than six are scaled up: '1.5' SECOND_MICROSECOND is
// 1.5 seconds. Undefined for no number or more numbers than parts, which
// MySQL reads as 0 or NULL.
function compoundParts(text: string, units: Unit[]): {amount: any; unit: Unit}[]|undefined {
  const trimmed = text.replace(/^\s+/, '');
  const negative = trimmed.startsWith('-');
  const groups = (negative ? trimmed.slice(1) : trimmed).match(/\d+/g) ?? [];
  if (!groups.length || groups.length > units.length || groups.some(g => g.length > 18)) return undefined;
  const values = [...units.slice(groups.length).map(() => 0n), ...groups.map(g => BigInt(g))];
  const last = groups[groups.length - 1];
  if (units.at(-1) === 'MICROSECOND' && last.length < 6) values[values.length - 1] *= 10n ** BigInt(6 - last.length);
  return units.map((unit, i) => ({amount: wholeNumber(`${negative ? '-' : ''}${values[i]}`), unit}));
}

// `sql`, a MySQL text, with each compound unit of an INTERVAL whose amount is
// a number or a string, such as HOUR_MINUTE in INTERVAL '1:30' HOUR_MINUTE,
// written as the span HOUR TO MINUTE. The engine reads a span, and MySQL has
// none, so readInterval reads the span as the compound unit.
function mysqlCompounds(engine: PolyglotEngine, sql: string): string {
  const tokens = engine.tokenize(sql, 'mysql').tokens ?? [];
  const chars = [...sql];
  const type = (i: number) => tokens[i]?.token_type;
  for (let i = tokens.length - 1; i >= 2; i--) {
    const name = String(tokens[i].text).toUpperCase();
    const first = type(i - 2) === 'DASH' ? i - 3 : i - 2;
    if (type(i) !== 'VAR' || !DATE_TABLES.mysql.compounds![name] || !['STRING', 'NUMBER'].includes(type(i - 1)!) ||
        type(first) !== 'INTERVAL') {
      continue;
    }
    const {start, end} = tokens[i].span;
    chars.splice(start, end - start, ...name.replace('_', ' TO '));
  }
  return chars.join('');
}

// The INTERVALs in `text`, an INTERVAL string such as '2 days', in `table`'s
// dialect: a whole number and a word for each unit, one unit unless the
// dialect has `severalUnits`. Undefined when import does not read it.
function stringParts(text: string, table: DateTable): {amount: any; unit: Unit}[]|undefined {
  if (!/^\s*([+-]?\d+\s*[a-z]+\s*)+$/i.test(text)) return undefined;
  const pairs = [...text.matchAll(/([+-]?\d+)\s*([a-z]+)/gi)];
  if (pairs.length > 1 && !table.severalUnits) return undefined;
  const parts = [];
  for (const [, amount, word] of pairs) {
    const [unit, times] = table.multiples?.[word.toLowerCase()] ?? [table.words[word.toLowerCase()], 1n];
    if (!unit || (table.intervals && !table.intervals.includes(unit))) return undefined;
    parts.push({amount: wholeNumber(times === 1n ? amount : String(BigInt(amount) * times)), unit});
  }
  return parts;
}

// The months in a month, a quarter and a year, the days in a day and a week,
// and the microseconds in each unit of a day or less.
const MONTHS: Partial<Record<Unit, bigint>> = {MONTH: 1n, QUARTER: 3n, YEAR: 12n};
const DAYS: Partial<Record<Unit, bigint>> = {DAY: 1n, WEEK: 7n};
const MICROS: Partial<Record<Unit, bigint>> = {
  HOUR: 3600000000n, MINUTE: 60000000n, SECOND: 1000000n, MILLISECOND: 1000n, MICROSECOND: 1n,
};
const DAY_MICROS = 86400000000n;

// The INTERVALs PostgreSQL keeps of `parts`, whole numbers, when it restricts
// them to the fields down to `smallest`, as in '90 minutes'::interval hour. It
// adds up the months, the days and the time, then drops from each what is
// smaller than `smallest`, toward zero, and with YEAR the months short of a
// year. SECOND keeps the fraction of a second. The time does not carry into
// days, so '1 day 25 hours' restricted to DAY is 1 day.
function restricted(parts: {amount: any; unit: Unit}[], smallest: Unit): {amount: any; unit: Unit}[] {
  const sum = (per: Partial<Record<Unit, bigint>>) =>
      parts.reduce((t, p) => t + BigInt(numberText(p.amount)!) * (per[p.unit] ?? 0n), 0n);
  const step = smallest === 'SECOND' ? 1n : MICROS[smallest];
  let [months, days, micros] = [sum(MONTHS), sum(DAYS), sum(MICROS)];
  if (smallest === 'YEAR') months = months / 12n * 12n;
  if (!step) [days, micros] = [smallest === 'DAY' ? days : 0n, 0n];
  if (step) micros = micros / step * step;
  const time = Object.keys(MICROS).find(u => micros % MICROS[u as Unit]! === 0n) as Unit;
  const kept: [bigint, Unit][] = [
    months % 12n === 0n ? [months / 12n, 'YEAR'] : [months, 'MONTH'], [days, 'DAY'], [micros / MICROS[time]!, time],
  ];
  const out = kept.filter(([n]) => n !== 0n).map(([n, unit]) => ({amount: wholeNumber(String(n)), unit}));
  return out.length ? out : [{amount: wholeNumber('0'), unit: smallest}];
}

// `text`, a whole number with an optional sign, as an engine number literal.
function wholeNumber(text: string): unknown {
  const number = {literal: {literal_type: 'number', value: text.trim().replace(/^[+-]/, '')}};
  return text.trim().startsWith('-') ? {neg: {this: number}} : number;
}

// One INTERVAL in an INTERVAL value: `amount` `unit`, the INTERVAL's text for
// a message, whether it is `negative`, as after a `-`, and the amounts it is
// multiplied by, if any, as `times`.
interface IntervalPart {
  amount: any;
  unit: Unit;
  text: string;
  negative: boolean;
  times?: any[];
}

// An INTERVAL value: its INTERVALs, and the values in it that import checks,
// such as n in n * INTERVAL '1 day'.
interface IntervalValue {
  parts: IntervalPart[];
  values: any[];
}

// The INTERVAL value that `node`, a source value in the engine's dialect
// `read`, is in `table`: an INTERVAL or, in a dialect with `sums`, a sum or
// difference of INTERVAL values or an INTERVAL value times an amount. A
// message when import does not read it, and undefined when `node` is no
// INTERVAL value.
function intervalValue(node: any, read: string, table: DateTable): IntervalValue|string|undefined {
  const b = bare(node);
  const added = intervalOf(b, read);
  if (added) {
    const parsed = readInterval(added, table, read);
    const text = `INTERVAL ${intervalText(added, table)}`;
    return typeof parsed === 'string' ? parsed : {parts: parsed.map(p => ({...p, text, negative: false})), values: []};
  }
  const kind = kindOf(b) ?? '';
  if (!table.sums || !['add', 'sub', 'mul'].includes(kind)) return undefined;
  const [left, right] = [b[kind].left, b[kind].right].map(s => intervalValue(s, read, table));
  if (kind === 'mul') {
    if (!left === !right) return undefined;
    const [joined, times] = left ? [left, b.mul.right] : [right!, b.mul.left];
    if (typeof joined === 'string') return joined;
    const other = notWhole(times, read);
    if (other) return `${joined.parts[0].text} times ${other}`;
    return {parts: joined.parts.map(p => ({...p, times: [...p.times ?? [], times]})), values: [...joined.values, times]};
  }
  if (!left || !right) return undefined;
  if (typeof left === 'string') return left;
  if (typeof right === 'string') return right;
  const parts = [...left.parts, ...right.parts.map(p => ({...p, negative: p.negative !== (kind === 'sub')}))];
  const other = parts.find(p => sumType(p.unit, table) !== sumType(parts[0].unit, table));
  if (other) return `${OPERATORS[kind]} of ${parts[0].text} and ${other.text}`;
  return {parts, values: [...left.values, ...right.values]};
}

// The name in `table`'s `sums` of the type of an INTERVAL of `unit`.
function sumType(unit: Unit, table: DateTable): string|undefined {
  return Object.keys(table.sums ?? {}).find(name => table.sums![name].includes(unit));
}

// What `node`, an amount an INTERVAL holds or is multiplied by, in the engine's
// dialect `read`, is, for a message, when it may not be an INT64, the only
// amount BigQuery takes there. A whole number, a column, COUNT, a date part
// such as DAY(d), SUM of such an amount, and a sign, a sum, a difference or a
// product of them may be one. PostgreSQL's EXTRACT of an INTERVAL is a NUMERIC.
function notWhole(node: any, read: string): string|undefined {
  const b = bare(node);
  const kind = kindOf(b) ?? '';
  if (isInterval(b, read)) return 'an INTERVAL';
  if (b?.column || b?.count || PARTS[kind]) return undefined;
  if (b?.extract) return intervalPart(partName(b.extract.field), b.extract.this, read) ? 'EXTRACT of an INTERVAL' : undefined;
  if (b?.sum) return notWhole(b.sum.this, read);
  if (kind === 'neg') return notWhole(b.neg.this, read);
  if (['add', 'sub', 'mul'].includes(kind)) return notWhole(b[kind].left, read) ?? notWhole(b[kind].right, read);
  const text = numberText(b);
  if (text !== undefined) return /^\d+$/.test(text) ? undefined : /^\d*\.\d*$/.test(text) ? 'a decimal number' : `the number ${text}`;
  return b?.null !== undefined ? 'NULL' : valueName(b);
}

// Whether `node`, a source value in the engine's dialect `read`, is visibly an
// INTERVAL (see intervalKind), or a negation, product, sum or difference with
// one, or one that MAX, COALESCE or a similar function returns.
function intervalTyped(node: any, read: string): boolean {
  const b = bare(node);
  if (!DATE_TABLES[read]?.sums) return false;
  if (intervalKind(b, read)) return true;
  const kind = kindOf(b) ?? '';
  const operands = kind === 'neg' ? [b.neg.this] : ['add', 'sub', 'mul'].includes(kind) ?
      [b[kind].left, b[kind].right] : returned(b);
  return operands.some(o => intervalTyped(o, read));
}

// Whether `node`, a source value in the engine's dialect `read`, is visibly an
// INTERVAL (see intervalKind). intervalTyped also counts a value plus an
// INTERVAL, which is a date or a time.
function isInterval(node: any, read: string): boolean {
  return !!intervalKind(node, read);
}

// The type of INTERVAL `node`, a source value in the engine's dialect `read`,
// visibly is, or undefined: its name in the dialect's `sums`, or INTERVAL in a
// SPANNER text, which has one type of INTERVAL. Such a value is an INTERVAL
// (see intervalOf), whose first unit gives its type, a difference of dates or
// times (see timeDifference and spannerDifference), which is of days, a
// negation of one, a sum or difference of two of one type, a product with one,
// a NULLIF with one, or one that MIN, MAX, COALESCE or a similar function
// returns. `literals` holds its INTERVALs when it is only INTERVALs, negated,
// added or subtracted. An INTERVAL import does not read has the dialect's type
// when it has only one.
interface IntervalKind {
  type: string;
  literals?: any[];
}
function intervalKind(node: any, read: string): IntervalKind|undefined {
  const spanner = read === 'spanner';
  const table = DATE_TABLES[read];
  if (!spanner && !table?.sums) return undefined;
  const b = bare(node);
  const added = intervalOf(b, read);
  if (added) {
    const parsed = spanner ? undefined : readInterval(added, table, read);
    const names = Object.keys(table?.sums ?? {});
    const type = spanner ? 'INTERVAL' : typeof parsed === 'object' ? sumType(parsed[0].unit, table) :
        names.length === 1 ? names[0] : undefined;
    return type ? {type, literals: [added]} : undefined;
  }
  if (spanner ? spannerDifference(b) : timeDifference(b, read)) {
    return {type: spanner ? 'INTERVAL' : sumType('DAY', table)!};
  }
  const kind = kindOf(b) ?? '';
  if (kind === 'neg') return intervalKind(b.neg.this, read);
  if (kind === 'add' || kind === 'sub') {
    const left = intervalKind(b[kind].left, read);
    const right = left && intervalKind(b[kind].right, read);
    if (!left || right?.type !== left.type) return undefined;
    return {type: left.type, literals: left.literals && right.literals && [...left.literals, ...right.literals]};
  }
  // NULLIF compares an INTERVAL only with one of its type, so either argument
  // gives it.
  const nullif = String(b?.function?.name).toUpperCase() === 'NULLIF';
  const operands = kind === 'mul' ? [b.mul.left, b.mul.right] : nullif ? b.function.args ?? [] : returned(b);
  for (const operand of operands) {
    const found = intervalKind(operand, read);
    if (found) return {type: found.type};
  }
  return undefined;
}

// Whether `node`, a source value in the engine's dialect `read`, is visibly a
// date or a time: a value of a visible date or time type, the current date or
// time, a date function, DATE_TRUNC, a sum or difference with an INTERVAL or a
// date, or a date or time that COALESCE or a similar function returns. With
// `local`, a function counts only where the dialect's table names it.
function dateValued(node: any, read: string, local = false): boolean {
  const b = bare(node);
  const table = DATE_TABLES[read];
  const name = String(b?.function?.name).toUpperCase();
  const call = local ? !!table && ([...table.today, ...table.now.functions].includes(name) || !!table.functions[name]) :
      [...CURRENT, ...DATE_FUNCTIONS, 'DATE_TRUNC'].includes(name);
  const dated = (v: any) => dateValued(v, read, local);
  return !!timeType(b, read) || returned(b).some(dated) || call ||
      [b?.add, b?.sub].some(v => v && (intervalOf(v.left, read) || intervalOf(v.right, read) || dated(v.left) || dated(v.right)));
}

// Whether `node` is a string literal that MySQL and BigQuery read as the same
// DATE beside a date, or as the same DATETIME beside DATETIME values when
// `datetime`: a date written YYYY-MM-DD that exists, and beside a DATETIME also
// one with a time written HH:MM:SS and up to six digits of a fraction.
function canonicalDate(node: any, datetime: boolean): boolean {
  const text = bare(node)?.literal?.literal_type === 'string' ? literalText(bare(node).literal) : undefined;
  const m = /^(\d{4})-(\d\d)-(\d\d)(?: (\d\d):(\d\d):(\d\d)(?:\.\d{1,6})?)?$/.exec(text ?? '');
  if (!m || (m[4] !== undefined && !datetime)) return false;
  const [y, mo, d, h = 0, mi = 0, se = 0] = m.slice(1, 7).filter(p => p !== undefined).map(Number);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= days && h <= 23 && mi <= 59 && se <= 59;
}

// The type of `node`, a MySQL date or time, for a message: its visible type,
// that of the value it negates, or 'date'.
function dateName(node: any, read: string): string {
  const b = bare(node);
  return timeType(b, read) ?? (b?.neg ? dateName(b.neg.this, read) : 'date');
}

// The kind of `node`, a MySQL value: a date or a time, a number, text, or
// undefined where import cannot see it, as for a column. MySQL turns a date or
// a time beside a number into its digits, compares one beside text by reading
// the text as a date by its own rules, and gives one among number or text
// results as text.
const NUMBER_KINDS = new Set(['sum', 'count', 'avg', 'abs', 'floor', 'ceil', 'length', 'extract', ...Object.keys(PARTS)]);
const TEXT_KINDS = new Set(['upper', 'lower', 'trim', 'substring']);
function mysqlKind(node: any, read: string): 'date'|'number'|'text'|undefined {
  const b = bare(node);
  const kind = kindOf(b) ?? '';
  const name = String(b?.function?.name).toUpperCase();
  if (dateValued(b, read, true)) return 'date';
  if (numberText(b) !== undefined || NUMBER_KINDS.has(kind) || name === 'ROUND' ||
      ['double', 'decimal', 'float'].includes(castType(b?.cast?.to))) {
    return 'number';
  }
  if (b?.literal?.literal_type === 'string' || TEXT_KINDS.has(kind) || ['CONCAT', 'REPLACE'].includes(name)) return 'text';
  // Negation keeps its operand's kind. Arithmetic with a date is a date, and
  // arithmetic of numbers a number.
  if (kind === 'neg') return mysqlKind(b.neg.this, read);
  if (['add', 'sub', 'mul', 'div'].includes(kind)) {
    const kinds = [b[kind].left, b[kind].right].map(v => mysqlKind(v, read));
    return kinds.includes('date') ? 'date' : kinds.every(k => k === 'number') ? 'number' : undefined;
  }
  const kinds = new Set(returned(b).filter(v => v && bare(v).null === undefined).map(v => mysqlKind(v, read)));
  return kinds.size === 1 ? [...kinds][0] : undefined;
}

// The one amount and unit that `parts`, INTERVALs of whole numbers, add up
// to, in their smallest unit, or undefined. They must all be months, quarters
// and years, or all be weeks or smaller units. A week is 7 days, a quarter 3
// months and a year 12 months, in each source as in BigQuery. A day is 24
// hours, as it is for a DATETIME and for a timestamp in UTC. An INTERVAL
// times whole numbers adds their product. Times any other amount, the sum is
// an expression, which BigQuery rejects unless it is an INT64.
const FOLDS: Partial<Record<Unit, bigint>>[] = [
  {WEEK: 7n * DAY_MICROS, DAY: DAY_MICROS, ...MICROS}, {YEAR: 12n, QUARTER: 3n, MONTH: 1n},
];
function folded(parts: IntervalPart[]): {amount: unknown; unit: Unit}|undefined {
  const fold = FOLDS.find(f => parts.every(p => f[p.unit]));
  const numbers = parts.map(p => numberText(p.amount));
  if (!fold || numbers.some(n => n === undefined)) return undefined;
  const unit = parts.reduce((a, p) => fold[p.unit]! < fold[a]! ? p.unit : a, parts[0].unit);
  const whole = (n: any) => /^-?\d+$/.test(numberText(n) ?? '');
  // Each part's amount of `unit`, with the amounts it is multiplied by that
  // are not whole numbers.
  const terms = parts.map((p, i) => {
    const product = (p.times ?? []).filter(whole).reduce((t, n) => t * BigInt(numberText(n)!), 1n);
    const n = (p.negative ? -1n : 1n) * BigInt(numbers[i]!) * fold[p.unit]! / fold[unit]! * product;
    return {n, others: (p.times ?? []).filter(t => !whole(t))};
  });
  const total = terms.filter(t => !t.others.length).reduce((sum, t) => sum + t.n, 0n);
  const products = terms.filter(t => t.others.length);
  if (!products.length) return {amount: wholeNumber(String(total)), unit};
  const operands: any[] = [];
  const written = products.map(t =>
      [...t.n === 1n ? [] : [String(t.n)], ...t.others.map(o => `(_${operands.push(o)})`)].join(' * '));
  return {amount: formCall([...total ? [String(total)] : [], ...written].join(' + '), operands), unit};
}

// The date arithmetic `operand` plus or minus `joined`, an INTERVAL value of
// more than one INTERVAL or with a product, in `table`, the table of the
// engine's dialect `read`, or a message. The row's addition of the value's
// finest unit gives the form and the type, as in the sources. A DATE_ADD
// needs one amount, so the INTERVALs must add up to one amount of their
// smallest unit (see folded). A `+` keeps the value as the source writes it,
// which BigQuery adds months first, then days, then time, as the sources do.
// A function, such as MySQL's DATE_ADD, has its `interval` added with `+`.
function valueOn(table: DateTable, read: string, sum: {
  operand: any; joined: IntervalValue; subtract: boolean; first?: boolean; op: string; call?: boolean;
  interval?: any;
}): DateSum|string {
  const {operand, joined, subtract, first, op, call, interval} = sum;
  const found = operandRow(operand, read, table) ?? daysRow(operand, table);
  if (typeof found === 'string') return found;
  if (!found) return `${op} of ${operandName(operand, table)}`;
  const finest = joined.parts.reduce((a, p) => UNITS.indexOf(p.unit) < UNITS.indexOf(a.unit) ? p : a);
  const spelled = (p: IntervalPart) => `${op}${call ? ' with' : ''} ${p.text}${p.times ? ' times an amount' : ''}`;
  const row = table.rows[found.row];
  // A product of weeks or shorter units is of the dialect's `products` unit.
  const product = table.products && joined.parts.some(p => p.times) && FOLDS[0][finest.unit];
  const addition = row.units[product ? table.products! : finest.unit];
  const note = table.notes?.[finest.unit];
  if (!addition) return note ? `${spelled(finest)}, ${note}` : `${spelled(finest)} on ${found.name}`;
  if (addition.form !== '+') {
    const fold = folded(joined.parts);
    const one = fold && row.units[fold.unit];
    if (!one) return `${spelled(finest)} on ${found.name}`;
    return {operand, amount: fold.amount, unit: fold.unit, subtract, first, call, addition: one, values: joined.values};
  }
  // A month added in UTC (see Addition) puts the whole value there.
  const utc = joined.parts.some(p => row.units[p.unit]?.utc);
  return {
    operand, amount: undefined, subtract, first, call, interval, addition: utc ? {...addition, utc} : addition,
    values: joined.values,
  };
}

// The interval `node`, a side of a `+` or `-` in the engine's dialect `read`,
// is, or undefined. PostgreSQL also casts a string to an INTERVAL. A cast to
// an INTERVAL with fields, such as INTERVAL HOUR, gives the smallest field as
// `fields` (see restricted).
function intervalOf(node: any, read: string): any {
  const b = bare(node);
  if (b?.interval) return b.interval;
  const cast = read === 'postgresql' && b?.cast;
  if (!cast || castType(cast.to) !== 'interval' || bare(cast.this)?.literal?.literal_type !== 'string') {
    return undefined;
  }
  const fields = cast.to.to ?? cast.to.unit;
  return {this: cast.this, unit: null, ...(fields ? {fields: String(fields).toUpperCase()} : {})};
}

// The date arithmetic `operand` plus or minus `amount` `unit` in `table`, the
// table of the engine's dialect `read`, or a message. `name` names the
// arithmetic for a message about its operand, `unitText` for one about its
// unit, and `spelling` for one about the unit on the operand.
function sumOn(table: DateTable, read: string, sum: {
  operand: any; amount: any; unit: Unit; subtract: boolean; first?: boolean; call?: boolean;
  as?: {row: string; rows: string[]}; name: string; spelling: string; unitText: string;
}): DateSum|string {
  const note = table.notes?.[sum.unit];
  if (!Object.values(table.rows).some(r => r.units[sum.unit])) {
    return note ? `${sum.spelling}, ${note}` : sum.unitText;
  }
  const found = operandRow(sum.operand, read, table) ?? daysRow(sum.operand, table);
  if (typeof found === 'string') return found;
  if (!found) return `${sum.name} of ${operandName(sum.operand, table)}`;
  // A function that reads its operand as another row first, such as
  // Databricks' date_add(x, n), which reads x as a DATE, reads the rows `as`
  // names.
  if (sum.as && !sum.as.rows.includes(found.row)) return `${sum.spelling} on ${found.name}`;
  const row = sum.as?.row ?? found.row;
  const reads = row !== found.row ? table.rows[row].type as 'DATE'|'TIMESTAMP' : undefined;
  const addition = table.rows[row].units[sum.unit];
  if (!addition) return note ? `${sum.spelling}, ${note}` : `${sum.spelling} on ${found.name}`;
  const {operand, amount, unit, subtract, first, call} = sum;
  return {operand, amount, unit, subtract, first, call, reads, addition};
}

// What `node`, an operand of date arithmetic that `table` has no row for, is,
// for a message, with the table's `stringNote` for a string.
function operandName(node: any, table: DateTable): string {
  const b = bare(node);
  return b?.literal?.literal_type === 'string' && table.stringNote ? `a string, ${table.stringNote}` : valueName(b);
}

// The row in `table`, the table of the engine's dialect `read`, of `node`, a
// source value import adds a unit to, with the name a message gives it: a
// column, a cast to DATE or to a type in `casts`, a DATE literal or a literal
// in `literals`, the current date or timestamp, a function in `typed`, or a
// date arithmetic import translates, whose row is the one its addition gives.
// MIN, MAX and a function of `keepsType` take the row of the value whose type
// they keep. Otherwise a message about the date arithmetic in `node`, or
// undefined. Where the table has `anyOperand`, it is the row of the widest
// type that COALESCE or a similar function visibly returns, or else the row
// `column`.
function operandRow(node: any, read: string, table: DateTable):
    {row: string; name: string}|string|undefined {
  const b = bare(node);
  if (b?.column) return {row: 'column', name: table.rows.column.name};
  if (isDate(b)) return {row: table.date, name: valueName(b)};
  const cast = table.casts?.[castType((b?.cast ?? b?.try_cast)?.to)] ?? table.literals?.[b?.literal?.literal_type];
  if (cast) return {row: cast, name: valueName(b)};
  const name = String(b?.function?.name).toUpperCase();
  const kept = b?.min?.this ?? b?.max?.this ?? (table.keepsType?.includes(name) ? b.function.args?.at(-1) : undefined);
  if (kept) return operandRow(kept, read, table);
  if (b?.function && !b.function.args?.length && table.now.functions.includes(name)) {
    return {row: table.now.row, name};
  }
  if (b?.function && table.typed?.[name]) return {row: table.typed[name], name};
  const sum = dateSum(b, read);
  if (sum === undefined && table.anyOperand) {
    const types = returned(b).map(v => timeType(v, read));
    const widest = WIDER.filter(t => types.includes(t)).at(-1);
    const row = Object.keys(table.rows).find(r => widest && table.rows[r].type === widest) ?? 'column';
    return {row, name: table.rows[row].name};
  }
  if (typeof sum !== 'object') return sum;
  return {row: sum.addition.gives, name: table.rows[sum.addition.gives].name};
}

// Whether `node` is a string literal of a date written YYYY-M-D, perhaps with
// a time of whole seconds written H:M:S after a space or a T, that exists, in
// a year from 1000. Databricks and BigQuery's CAST to DATETIME read it alike.
function dateText(node: any): boolean {
  const text = node?.literal?.literal_type === 'string' ? literalText(node.literal) : undefined;
  const parts = /^(\d{4})-(\d\d?)-(\d\d?)(?:[ T](\d\d?):(\d\d?):(\d\d?))?$/.exec(text ?? '');
  if (!parts) return false;
  const [y, mo, d, h = 0, mi = 0, se = 0] = parts.slice(1).filter(p => p !== undefined).map(Number);
  const days = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  return y >= 1000 && mo >= 1 && mo <= 12 && d >= 1 && d <= days && h <= 23 && mi <= 59 && se <= 59;
}

// The row in `table` of `node`, a source value beside an INTERVAL, when it is
// a column plus or minus a whole number: the row of a DATE plus days, where
// the dialect adds a whole number to a DATE as days. Undefined otherwise. The
// sources and BigQuery add an INTERVAL to no number and a whole number to no
// timestamp, so the column can only be a DATE.
function daysRow(node: any, table: DateTable): {row: string; name: string}|undefined {
  const b = bare(node);
  const kind = kindOf(b);
  if (kind !== 'add' && kind !== 'sub') return undefined;
  const [operand, amount] = dayOperands(kind, b[kind]);
  const days = table.rows[table.date].days;
  return days && bare(operand)?.column && /^-?\d+$/.test(numberText(amount) ?? '') ?
      {row: days.gives, name: table.rows[days.gives].name} : undefined;
}

// The names in any dialect's table: the functions that give the current date,
// those that give the current date or timestamp, and those that add a unit.
const TODAY = new Set(Object.values(DATE_TABLES).flatMap(t => t.today));
const CURRENT = new Set(Object.values(DATE_TABLES).flatMap(t => [...t.today, ...t.now.functions]));
const DATE_FUNCTIONS = new Set(Object.values(DATE_TABLES).flatMap(t => Object.keys(t.functions)));

// The functions whose first argument is a date part, besides those DATE_TABLES
// lists as 'part', with the dialects that read it so. MySQL's and Databricks'
// DATEDIFF(end, start) take two dates.
const PART_FUNCTIONS: Record<string, string[]> = {
  DATE_TRUNC: [...DIALECTS, 'ossie'], DATE_PART: [...DIALECTS, 'ossie'], DATEPART: DIALECTS,
  DATEDIFF: [...except('mysql', 'databricks'), 'ossie'], TIMESTAMPDIFF: ['databricks'],
};

// The functions written only with parentheses. Without them, quoted or not,
// NOW, CURDATE, GETDATE and SYSDATE name a column, which the engine reads as
// the function.
const CALLED_ONLY = new Set(['NOW', 'CURDATE', 'GETDATE', 'SYSDATE']);

// The engine's tree of `text`, a source text in `dialect` that the engine
// reads as `read`, as the source reads it: a function of CALLED_ONLY without
// parentheses is a column (see calledColumns), and a MySQL sum that names its
// INTERVAL first adds it to all that follows (see mysqlRest).
function sourceTree(text: string, dialect: string, read: string): any {
  const tree = calledColumns(sqlExpressionTree(text, dialect));
  return read === 'mysql' ? mapTree(tree, mysqlRest) : tree;
}

// `tree`, an engine tree, with each function of CALLED_ONLY written without
// parentheses as a quoted column of its name.
function calledColumns(tree: any): any {
  return mapTree(tree, node => {
    const fn = node.function;
    if (!fn?.no_parens || !CALLED_ONLY.has(String(fn.name).toUpperCase())) return undefined;
    const column = sqlExpressionTree('x', 'BIGQUERY').column;
    return {column: {...column, name: {...column.name, name: fn.name, quoted: true}}};
  });
}

// The MySQL operators that a sum which names its INTERVAL first takes into the
// value it adds the INTERVAL to, by kind: the key of the operand written first,
// and for a binary operator the key of the one written last. MySQL reads
// `INTERVAL 1 MONTH + d - INTERVAL 1 DAY` as INTERVAL 1 MONTH +
// (d - INTERVAL 1 DAY), and `INTERVAL 1 DAY + d > x` as
// INTERVAL 1 DAY + (d > x). It leaves AND, OR and XOR outside the sum.
const INTERVAL_REST: Record<string, string[]> = {
  ...Object.fromEntries([
    'add', 'sub', 'bitwise_or', 'bitwise_and', 'bitwise_xor', 'bitwise_left_shift',
    'bitwise_right_shift', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'null_safe_eq',
  ].map(kind => [kind, ['left', 'right']])),
  like: ['left'], member_of: ['left'], is_null: ['this'], is_true: ['this'], in: ['this'],
  between: ['this'], regexp_like: ['this'],
};

// `node`, a MySQL source node whose operands are grouped as MySQL groups them,
// grouped so too, or undefined when it already is. The engine reads an
// operator after a sum as applying to the sum. MySQL reads an operator of
// INTERVAL_REST after a sum that names its INTERVAL first as part of the value
// the sum adds the INTERVAL to.
function mysqlRest(node: any): any {
  const kind = kindOf(node) ?? '';
  const [first] = INTERVAL_REST[kind] ?? [];
  if (!first) return undefined;
  // The operators between `node` and the sum, which ends its first operand.
  const path: any[] = [];
  let sum = node[kind][first];
  while (!(sum?.add && intervalOf(sum.add.left, 'mysql'))) {
    const last = INTERVAL_REST[kindOf(sum) ?? '']?.[1];
    if (!last) return undefined;
    path.push(sum);
    sum = sum[kindOf(sum)!][last];
  }
  const rest = {[kind]: {...node[kind], [first]: sum.add.right}};
  const grouped = {add: {...sum.add, right: mysqlRest(rest) ?? rest}};
  return path.reduceRight((inner, outer) => {
    const k = kindOf(outer)!;
    return {[k]: {...outer[k], [INTERVAL_REST[k][1]]: inner}};
  }, grouped);
}

// The kinds of node that give a BOOL in BigQuery, and 1 or 0 in MySQL.
const BOOLEANS = new Set([
  'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'and', 'or', 'not', 'in', 'between',
  'like', 'is_null', 'boolean',
]);

// The kinds of node that compare two values.
const COMPARISONS = new Set(['eq', 'neq', 'lt', 'lte', 'gt', 'gte']);

// The kinds of node that compare, which BigQuery does not chain.
const COMPARING = new Set([...COMPARISONS, 'is_null', 'like', 'in', 'between']);

// The kinds of node that compare in an OSSIE_SQL_2026 text, which Ossie's
// grammar does not chain without parentheses: those of COMPARING, ILIKE and
// IS [NOT] DISTINCT FROM.
const OSSIE_COMPARING = new Set([...COMPARING, 'i_like', 'null_safe_eq', 'null_safe_neq']);

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
  is_null: 'IS NULL', i_like: 'ILIKE', null_safe_eq: 'IS NOT DISTINCT FROM', null_safe_neq: 'IS DISTINCT FROM',
};

// The kind in `kinds`, COMPARING unless given, of `node`, an engine node, or
// undefined. The engine reads `s NOT LIKE p` as NOT of a LIKE, and `s NOT
// ILIKE p` as NOT of an ILIKE.
function comparingKind(node: any, kinds = COMPARING): string|undefined {
  const negated = kindOf(node?.not?.this);
  const kind = negated === 'like' || negated === 'i_like' ? negated : kindOf(node);
  return kinds.has(kind!) ? kind : undefined;
}

// The operands of a node of `kind` in COMPARING, by name, first operand first.
// IN's list stands inside its own parentheses.
function operandNames(kind: string): string[] {
  return kind === 'is_null' || kind === 'in' ? ['this'] :
      kind === 'between' ? ['this', 'low', 'high'] : ['left', 'right'];
}

// The operator of `node`, a node comparingKind names, as written, for a message.
function operatorName(node: any): string {
  const kind = comparingKind(node, OSSIE_COMPARING)!;
  if (node.not) return `NOT ${OPERATORS[kind]}`;
  const not: Record<string, string> =
      {is_null: 'IS NOT NULL', in: 'NOT IN', between: 'NOT BETWEEN'};
  return node[kind].not ? not[kind] : OPERATORS[kind];
}

// The message for `node`, a node comparingKind names in the engine's dialect
// `read`, when one of its operands compares too and import does not translate
// the pair, or undefined. Without parentheses, the source may group the two
// operators another way than the engine (see BINDING). BigQuery's LIKE also
// takes no BOOL, and its IN and BETWEEN take a BOOL only beside another BOOL,
// where some sources convert it. Ossie's grammar needs the parentheses, and
// an OSSIE_SQL_2026 text gets BigQuery's types.
function nestedComparison(node: any, read: string): string|undefined {
  const kinds = read === 'ossie' ? OSSIE_COMPARING : COMPARING;
  const kind = comparingKind(node, kinds)!;
  const value = (node.not?.this ?? node)[kind];
  const levels = BINDING[read];
  const level = (k: string) => levels.findIndex(l => l.includes(k));
  for (const [i, name] of operandNames(kind).entries()) {
    const inner = comparingKind(value[name], kinds);
    const grouped = !inner || (levels && (level(inner) < level(kind) ||
        (i === 0 && read === 'mysql' && level(inner) === level(kind))));
    if (grouped) continue;
    const [outer, operand] = [operatorName(node), operatorName(value[name])];
    const [first, second] = i === 0 ? [operand, outer] : [outer, operand];
    const why = read === 'ossie' ? "Ossie's grammar requires" : 'databases group in different orders';
    return `${first} and ${second} without parentheses, which ${why}`;
  }
  if (read === 'ossie') return undefined;
  const values = comparedValues(kind, value) ?? [value.left, value.right];
  return ['like', 'in', 'between'].includes(kind) && values.some(v => comparingKind(bare(v))) ?
      `${operatorName(node)} of a comparison` : undefined;
}

// The first construct in `node`, a source expression in the engine's dialect
// `read`, that import does not translate, named for a message, with the node
// whose check named it, or undefined.
function unknownConstruct(engine: PolyglotEngine, node: any, read: string):
    {name: string; node: any}|undefined {
  if (!node || typeof node !== 'object') return undefined;
  // An array, an identifier, a data type or another part of a node.
  const next = isNode(node) ? nextNodes(kindOf(node)!, Object.values(node)[0], read) :
                              Object.values(node);
  if (next === undefined) return {name: constructName(engine, node, read), node};
  if (typeof next === 'string') return {name: next, node};
  for (const child of next) {
    const unknown = unknownConstruct(engine, child, read);
    if (unknown) return unknown;
  }
  return undefined;
}

// `found.name`, which names `found.node`, a construct of `text`, an
// expression in `dialect` the engine reads as `read`, with the function and
// the date part as the author wrote them. `rules` is the dialect whose rules
// named it (see unknownConstruct). The engine reads some calls as another
// function, such as MySQL's CHAR_LENGTH as LENGTH, and some date parts by
// another name, such as SQL Server's `w` as WEEK. The name stays as it is when
// it does not start with the node's own, or the node is not a call found in
// `text`.
function writtenName(
    engine: PolyglotEngine, text: string, dialect: string, read: string,
    rules: string, found: {name: string; node: any}): string {
  const own = constructName(engine, found.node, rules);
  const lead = /^[A-Za-z_]\w*/.exec(found.name)?.[0];
  if (!lead || lead.toUpperCase() !== own.toUpperCase()) return found.name;
  const call = writtenCall(engine, text, dialect, read, found.node);
  if (!call) return found.name;
  const name = call.name + found.name.slice(lead.length);
  const part = / with part '(.*)'$/.exec(name);
  const written = part ? writtenPart(found.node, part[1], call) : undefined;
  return written === undefined ? name :
      `${name.slice(0, part!.index)} with part '${written}'`;
}

// A call as written: its function name, and the tokens of each argument.
// `text` gives the text of a run of its tokens.
interface WrittenCall {
  name: string;
  args: SqlToken[][];
  text: (tokens: SqlToken[]) => string;
}

// The call in `text`, an expression in `dialect` the engine reads as `read`,
// whose tree as sourceTree reads it is `node`, or undefined when no call in
// `text` gives `node`.
function writtenCall(
    engine: PolyglotEngine, text: string, dialect: string, read: string,
    node: any): WrittenCall|undefined {
  const chars = [...text];
  const slice = (from: SqlToken, to: SqlToken) =>
      chars.slice(from.span.start, to.span.end).join('');
  const tokens = engine.tokenize(text, read).tokens ?? [];
  const wanted = JSON.stringify(treeWithoutComments(node));
  for (const [i, t] of tokens.entries()) {
    if (tokens[i + 1]?.token_type !== 'L_PAREN') continue;
    // The arguments, split at each comma outside parentheses.
    const args: SqlToken[][] = [[]];
    let depth = 0;
    let end = -1;
    for (let j = i + 2; j < tokens.length && end < 0; j++) {
      const k = tokens[j].token_type;
      if (k === 'R_PAREN' && depth === 0) end = j;
      else if (k === 'COMMA' && depth === 0) args.push([]);
      else {
        if (k === 'L_PAREN') depth++;
        if (k === 'R_PAREN') depth--;
        args.at(-1)!.push(tokens[j]);
      }
    }
    if (end < 0) continue;
    const tree = sourceTree(slice(t, tokens[end]), dialect, read);
    if (JSON.stringify(treeWithoutComments(tree)) === wanted) {
      return {
        name: slice(t, t),
        args: args.filter(a => a.length),
        text: run => slice(run[0], run[run.length - 1]),
      };
    }
  }
  return undefined;
}

// The date part a message names `part` in `node`, the tree of `call`, as the
// author wrote it, without quotes or enclosing parentheses, or undefined when
// no single argument gives it. A column named like the part is left out when
// another argument names it too. In EXTRACT it is the text before FROM.
function writtenPart(node: any, part: string, call: WrittenCall):
    string|undefined {
  const extract = kindOf(node) === 'extract';
  const args = (Object.values(node)[0] as any)?.args ?? [];
  const named = args.flatMap((a: any, i: number) =>
      String(partName(a)).toUpperCase() === part.toUpperCase() ? [i] : []);
  const at = extract ? [0] :
      named.length > 1 ? named.filter((i: number) => !bare(args[i])?.column) :
                         named;
  const arg = at.length === 1 ? call.args[at[0]] : undefined;
  if (!arg) return undefined;
  const from = extract ? arg.findIndex(t => t.token_type === 'FROM') : -1;
  let tokens = from < 0 ? arg : arg.slice(0, from);
  while (tokens.length > 2 && tokens[0].token_type === 'L_PAREN' &&
         tokens.at(-1)!.token_type === 'R_PAREN') {
    tokens = tokens.slice(1, -1);
  }
  if (!tokens.length) return undefined;
  return tokens.length === 1 ? tokens[0].text : call.text(tokens);
}

// `node` with no comments, which a tree keeps beside the tokens they follow.
function treeWithoutComments(node: any): any {
  if (Array.isArray(node)) return node.map(treeWithoutComments);
  if (!node || typeof node !== 'object') return node;
  return Object.fromEntries(
      Object.entries(node)
          .filter(([k]) => !k.endsWith('comments'))
          .map(([k, v]) => [k, treeWithoutComments(v)]));
}

// Whether `v` is an engine node: an object with one key, its kind, whose value
// is an object, or null for a node with no parts, such as PI() or NULL.
function isNode(v: any): boolean {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const values = Object.values(v);
  return values.length === 1 && (values[0] === null ||
      (typeof values[0] === 'object' && !Array.isArray(values[0])));
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
  if (read === 'ossie') return ossieNodes(kind, value);
  // A node with no parts, such as NULL.
  if (value === null) return KINDS[kind]?.includes(read) ? [] : undefined;
  const node = {[kind]: value};
  const nested = comparingKind(node) ? nestedComparison(node, read) : undefined;
  if (nested) return nested;
  // The engine reads infix NOT LIKE, NOT ILIKE and NOT RLIKE, and PostgreSQL's
  // !~ and !~*, as a `not` node wrapping the operator, so import checks the
  // operator at the `not` node and the message names NOT for those. NOT after
  // the operand of IN or BETWEEN sets a `not` flag on the node. For any other
  // `not` node, such as a prefix NOT, the message names the node it wraps
  // without NOT.
  const wrapped = kind === 'not' ? kindOf(value.this) : undefined;
  const [checkKind, checkValue, prefix] =
      ['like', 'i_like', 'regexp_like', 'regexp_i_like'].includes(wrapped!) ?
      [wrapped!, value.this[wrapped!], 'NOT '] :
      [kind, value, ['in', 'between'].includes(kind) && value.not ? 'NOT ' : ''];
  // In a dialect whose INTERVALs are values, an INTERVAL that import reads,
  // alone or compared, is BigQuery's INTERVAL of its units (see forBigQuery).
  const table = DATE_TABLES[read];
  const added = table?.sums && isNode(node) ? intervalOf(node, read) : undefined;
  if (added) {
    const parsed = readInterval(added, table, read);
    return typeof parsed === 'string' ? parsed : parsed.map(p => p.amount);
  }
  // MySQL reads a comparison as the number 1 or 0 outside a condition, and
  // BigQuery gives a BOOL there. For a kind import translates from no dialect,
  // such as IS TRUE, the message names the node instead (see constructName).
  if (read === 'mysql' && (checkKind === 'function' || KINDS[checkKind])) {
    const conditions = conditionValues(checkKind, checkValue);
    const children = (checkKind === 'function' ? checkValue.args ?? [] : Object.values(checkValue))
                         .flat(Infinity);
    if (children.some((c: any) => !conditions.includes(c) && BOOLEANS.has(kindOf(bare(c))!))) {
      const name = OPERATORS[checkKind] ?? checkValue.original_name ??
          (checkKind === 'function' ? checkValue.name : checkKind);
      return `${prefix}${String(name).toUpperCase()} of a comparison`;
    }
  }
  if (kind === 'function') return functionArgs(value, read);
  if (!KINDS[kind]?.includes(read) || !KINDS[checkKind]?.includes(read)) return undefined;
  const written = (c: string) => c === 'ignore_nulls' ? c in checkValue :
      ![null, undefined, false].includes(checkValue[c]) && checkValue[c].length !== 0;
  const clause = Object.entries(CLAUSES[checkKind] ?? {}).find(([c]) => written(c));
  if (clause) return `${prefix}${checkKind.toUpperCase()} with ${clause[1]}`;
  const joined = kind === 'concat' && joinProblem('||', [value.left, value.right], read);
  if (joined) return joined;
  if (read === 'spanner') {
    const spanner = spannerNodes(kind, value, prefix);
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
  // BigQuery averages and divides an INTERVAL to whole microseconds, rounding
  // down. PostgreSQL and Databricks round to the nearest microsecond, and
  // Databricks gives a year-month INTERVAL in whole months.
  const averaged = (kind === 'avg' ? [value.this] : kind === 'div' ? [value.left, value.right] : [])
      .filter(n => intervalTyped(n, read));
  if (averaged.length) {
    return `${kind === 'avg' ? 'AVG' : '/'} of ${averaged.some(n => isInterval(n, read)) ? 'an INTERVAL' : 'a date'}`;
  }
  if (kind === 'add' || kind === 'sub' || kind === 'mul') return arithmetic(kind, value, read);
  // The sources read a string beside AND, OR or NOT as a truth value or a
  // number, and BigQuery rejects it. MySQL reads `a || ' '` as OR.
  if (['and', 'or', 'not'].includes(kind) &&
      [value.left, value.right, value.this].some(n => bare(n)?.literal?.literal_type === 'string')) {
    return `${kind.toUpperCase()} of a string`;
  }
  const exact = exactForm(node, read);
  if (typeof exact === 'string') return `${prefix}${exact}`;
  // Snowflake and SQL Server have no default escape character in LIKE, where
  // BigQuery's is a backslash. SQL Server reads [ in a pattern as a set of
  // characters.
  if (checkKind === 'like') {
    const pattern = String(bare(checkValue.right)?.literal?.value);
    if (['snowflake', 'tsql'].includes(read) && pattern.includes('\\')) {
      return `${prefix}LIKE with a backslash in its pattern`;
    }
    if (read === 'tsql' && pattern.includes('[')) {
      return `${prefix}LIKE with a bracket in its pattern`;
    }
  }
  if (kind === 'extract') {
    const part = String(partName(value.field));
    return intervalPart(part, value.this, read) ? [value.this] : PARTS[part.toLowerCase()] ?
        dateValue('EXTRACT', value.this) : `EXTRACT with part '${part.toUpperCase()}'`;
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
// TIMESTAMP, where its CAST gives a TIMESTAMP_NTZ. Snowflake's TRY_CAST to a
// timestamp also reads date and time formats that BigQuery's SAFE_CAST gives
// NULL for, such as '05-Mar-2016'.
function castProblem(kind: string, value: any, read: string): string|undefined {
  const type = castType(value.to);
  const size = [value.to.length ?? value.to.precision, value.to.scale].filter(n => n != null);
  const name = kind === 'try_cast' ? 'TRY_CAST' : 'CAST';
  if (!CAST_TYPES[type]?.includes(read) || size.length) {
    return `${name} to ${typeName(type, read)}${size.length ? `(${size.join(', ')})` : ''}`;
  }
  if (kind === 'try_cast' && read === 'snowflake' && ['timestamp', 'TIMESTAMPNTZ'].includes(type)) {
    return `TRY_CAST to ${typeName(type, read)}`;
  }
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
// literal or a SUM, COUNT or AVG, or as date arithmetic its dialect's table in
// DATE_TABLES holds. MySQL and SQL Server read a date beside a number as a
// number or a count of days, and every source reads a string beside a number as
// a number. So import refuses a value it can see is a date or a time in any
// other arithmetic, also when MAX, COALESCE or a similar function returns it.
// MySQL turns such a value into the number of its digits. A
// date column is not visible, so a date column plus a number is translated as
// written, which in BigQuery adds days to a DATE. MySQL gives a number there.
// SPANNER arithmetic is BigQuery's.
function arithmetic(kind: string, value: any, read: string): unknown[]|string {
  const sides = [value.left, value.right];
  const op = OPERATORS[kind];
  const table = DATE_TABLES[read];
  const joined = table?.sums ? intervalValue({[kind]: value}, read, table) : undefined;
  if (joined) return typeof joined === 'string' ? joined : joined.values;
  const sum = kind === 'mul' ? undefined : dateSum({[kind]: value}, read);
  if (sum) return typeof sum === 'string' ? sum : [sum.operand, ...(sum.values ?? [sum.amount])];
  if (timeDifference({[kind]: value}, read)) return sides;
  // An INTERVAL times an amount that may not be an INT64 (see notWhole).
  const interval = kind === 'mul' && read !== 'spanner' ? sides.findIndex(s => isInterval(s, read)) : -1;
  const factor = interval >= 0 ? notWhole(sides[1 - interval], read) : undefined;
  if (factor) return `an INTERVAL times ${factor}`;
  if (sides.some(s => bare(s)?.literal?.literal_type === 'string')) return `${op} of a string`;
  if (read === 'spanner') return sides;
  // A `+` or `-` with an INTERVAL that the steps above do not translate, such
  // as an INTERVAL plus a number, which the sources and BigQuery reject.
  const dated = sides.find(s => dateValued(s, read) || (kind !== 'mul' && isInterval(s, read)));
  if (dated) return `${op} of ${isInterval(dated, read) ? 'an INTERVAL' : `a date${table?.numbers ? `, which ${DIGITS_NOTE}` : ''}`}`;
  if (kind === 'mul' && !CONVERTING.has(read)) return sides;
  return sides.some(isNumber) ? sides :
      `${op} without a number, SUM, COUNT or AVG on one side`;
}

// The amount of `added`, an engine interval, as written, or undefined when it
// is not a number or a string.
function intervalAmount(added: any): string|undefined {
  return numberText(added?.this) ?? literalText(bare(added?.this)?.literal);
}

// The date and the number of days in `value`, a `+` or `-` of `kind`. A `+`
// may name the number first.
function dayOperands(kind: string, value: any): [any, any] {
  return kind === 'add' && numberText(value.left) !== undefined ? [value.right, value.left] :
                                                                  [value.left, value.right];
}

// The operands whose value `node`, a source value, can give as its own: the
// operand of MIN or MAX, each operand of COALESCE, IFNULL or NVL, each result of
// IF or CASE, and the first operand of NULLIF. The other nodes import translates
// compute a new value.
function returned(node: any): any[] {
  const b = bare(node);
  return b?.min ? [b.min.this] : b?.max ? [b.max.this] : b?.coalesce ? b.coalesce.expressions :
      b?.nvl ? [b.nvl.this, b.nvl.expression] :
      b?.if_func ? [b.if_func.true_value, b.if_func.false_value] :
      b?.case ? [...b.case.whens.map((w: any[]) => w[1]), b.case.else_] :
      String(b?.function?.name).toUpperCase() === 'NULLIF' ? [b.function.args[0]] : [];
}

// The kinds of node and the functions that give a number, a BOOL, a date or a
// time, whatever their operands are.
const NOT_TEXT = new Set([
  ...BOOLEANS, 'neg', 'add', 'sub', 'mul', 'div', 'sum', 'count', 'avg', 'abs', 'floor',
  'ceil', 'length', 'extract', ...Object.keys(PARTS), ...CURRENT, ...DATE_FUNCTIONS, 'ROUND',
  'DATE_TRUNC', 'DATE_PART', 'DATEDIFF', 'DATE_DIFF', 'TIMESTAMPDIFF', 'interval',
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

// The groups of visible types that BigQuery compares with each other, or gives
// as results of one COALESCE, NVL, IF or CASE. The sources also compare a
// TIMESTAMP with a DATE or a DATETIME, and MySQL a date or a time with a
// number (see valueForms). Each type of INTERVAL in a dialect's `sums` is a
// group of its own.
const COMPARED = [['DATE', 'DATETIME'], ['TIMESTAMP'], ['number']];

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
// when the translation is visibly a DATE, a DATETIME, a TIMESTAMP or, in an
// OSSIE_SQL_2026 text, a TIME: a DATE literal, a cast on the list, the current
// date, time or timestamp, a literal or function the dialect's table in
// DATE_TABLES gives a row, date arithmetic import translates, by its row,
// PostgreSQL's DATE_TRUNC of a DATE, Databricks' date_trunc, or the widest
// type of the values that COALESCE or a similar function returns, in the
// order of WIDER. A SPANNER text's current timestamp is a TIMESTAMP.
function timeType(node: any, read: string): string|undefined {
  if (isDate(node)) return 'DATE';
  const b = bare(node);
  // PostgreSQL truncates a DATE as a timestamp with time zone.
  const fn = b?.function;
  if (read === 'postgresql' && String(fn?.name).toUpperCase() === 'DATE_TRUNC' && isDate(fn.args?.[1])) {
    return 'TIMESTAMP';
  }
  // Databricks truncates any value as a TIMESTAMP.
  if (read === 'databricks' && String(fn?.name).toUpperCase() === 'DATE_TRUNC') return 'TIMESTAMP';
  const table = DATE_TABLES[read];
  const found = table && operandRow(b, read, table);
  if (typeof found === 'object') return table.rows[found.row].type;
  const results = returned(b).map(v => timeType(v, read));
  const widest = WIDER.filter(t => results.includes(t)).at(-1);
  if (widest) return widest;
  if (read === 'spanner' && CURRENT.has(String(b?.function?.name).toUpperCase())) return 'TIMESTAMP';
  const type = castType((b?.cast ?? b?.try_cast ?? b?.safe_cast)?.to);
  const types: Record<string, string> = {
    timestamp: read === 'spanner' ? 'TIMESTAMP' : 'DATETIME', TIMESTAMPNTZ: 'DATETIME',
    timestamptz: 'TIMESTAMP',
  };
  return CAST_TYPES[type]?.includes(read) ? types[type] : undefined;
}

// The types of values that one COALESCE, IF or CASE can give, each giving
// way to those after it: BigQuery merges a DATE into a DATETIME, and import a
// DATE or a DATETIME into a TIMESTAMP where it writes TIMESTAMP(x) around it
// (see valueForms). BigQuery merges a TIME with no other type, so one TIME
// among the values makes them all TIMEs, or BigQuery refuses them.
const WIDER = ['DATE', 'DATETIME', 'TIMESTAMP', 'TIME'];

// The values `node`, a source value, can give: `node`, or each value it gives
// as its own, such as COALESCE's operands.
function givenValues(node: any): any[] {
  const results = returned(node);
  return results.length ? results.flatMap(givenValues) : [node];
}

// --- Exact forms ----------------------------------------------------------------
//
// Some constructs give another value or type when the engine translates them,
// and BigQuery has a form that gives the source's. forBigQuery puts a FORM_CALL
// for that form in place of the construct, and formSql writes the form with the
// operands the engine translated.

// The name of the call that stands for a form in the text the engine
// translates. Its first argument is the form's BigQuery SQL, in which _1, _2
// and so on stand for the arguments that follow, each as an argument of a
// function or of CAST. A source text that calls it is refused, since it is no
// function on the lists.
const FORM_CALL = 'KCMD_BIGQUERY_FORM';

// The dialects whose NULLIF gives the type of its first value, and those
// whose NULLIF is BigQuery's.
const NULLIF_FIRST = new Set(['postgresql', 'databricks', 'tsql', 'snowflake']);
const NULLIF_BIGQUERY = new Set(['spanner']);

// A FORM_CALL of `sql`, BigQuery SQL that names `operands`, source values, _1,
// _2 and so on.
function formCall(sql: string, operands: any[]): any {
  const call = sqlExpressionTree(`${FORM_CALL}('')`, 'BIGQUERY').function;
  return {function: {...call, args: [{literal: {literal_type: 'string', value: sql}}, ...operands]}};
}

// The source comparison `left` = `right`.
function equal(left: any, right: any): any {
  return {eq: {left, right, left_comments: [], operator_comments: [], trailing_comments: []}};
}

// `node` with each value in it that `swap` has replaced by what `swap` gives.
function swapped(node: any, swap: Map<any, any>): any {
  if (swap.has(node)) return swap.get(node);
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map(n => swapped(n, swap));
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, swapped(v, swap)]));
}

// The node to write in place of `node`, a source node in the engine's dialect
// `read`, with a FORM_CALL for each form it needs; a message when import does
// not translate it; or undefined to translate it as it is. PostgreSQL
// truncates a DATE as a timestamp with time zone at midnight UTC, which a unit
// of a day or less leaves at the date. A comparison, a negated value, and the
// results of one COALESCE, NVL, IF or CASE, get the forms valueForms gives.
function exactForm(node: any, read: string): any {
  const kind = kindOf(node) ?? '';
  const value = node[kind];
  const args: any[] = kind === 'function' ? value.args ?? [] : [];
  const name = String(value?.name).toUpperCase();
  if (read === 'postgresql' && name === 'DATE_TRUNC' && args.length === 2 && isDate(args[1])) {
    const unit = TRUNC_PARTS[String(partName(args[0])).toLowerCase()];
    const day = ['DAY', ...SUB_DAY].includes(unit);
    return unit && formCall(day ? 'TIMESTAMP(_1)' : `TIMESTAMP(DATE_TRUNC(_1, ${unit}))`, [args[1]]);
  }
  // Databricks truncates a DATE, a TIMESTAMP or a TIMESTAMP_NTZ as a TIMESTAMP
  // in UTC, as BigQuery truncates TIMESTAMP(x).
  const unit = read === 'databricks' && name === 'DATE_TRUNC' && args.length === 2 && truncUnit(args[0], read);
  if (unit) return formCall(`TIMESTAMP_TRUNC(TIMESTAMP(_1), ${unit})`, [args[1]]);
  // Databricks' timestampdiff counts whole units (see TIMESTAMP_DIFFS).
  const diff = DATE_TABLES[read]?.diffs?.includes(name) && args.length === 3 && diffSql(args[0]);
  if (diff) return formCall(diff, args.slice(1));
  if (DATE_TABLES[read]?.dayDiffs?.includes(name) && args.length === 2) return dayDiffForm(name, args, read);
  if (name === 'NULLIF' && args.length === 2) return nullifForm(args, read);
  if (kind === 'sub' && timeDifference(node, read)) return formCall(DIFFERENCE, [value.left, value.right]);
  // EXTRACT and DATE_PART of an INTERVAL (see INTERVAL_PARTS). PostgreSQL's
  // DATE_PART gives a double.
  const extracted = kind === 'extract' ? [partName(value.field), value.this] :
      name === 'DATE_PART' && args.length === 2 ? [partName(args[0]), args[1]] : [];
  const part = extracted.length ? intervalPart(extracted[0], extracted[1], read) : undefined;
  if (part) return formCall(kind === 'extract' ? part : `CAST(${part} AS FLOAT64)`, [extracted[1]]);
  const merged = ['coalesce', 'nvl', 'if_func', 'case'].includes(kind) ? returned(node) : [];
  const pairs: [any[], string, Use][] = [
    [comparedValues(kind, value) ?? [], OPERATORS[kind], kind === 'in' || kind === 'case' ? 'matched' : kind === 'between' ? 'between' : 'compared'],
    [kind === 'neg' ? [value.this] : [], OPERATORS[kind], 'negated'],
    [merged, valueName(node), 'results'],
  ];
  const swap = new Map();
  for (const [values, how, use] of pairs) {
    const forms = valueForms(values, read, use);
    if (typeof forms === 'string') return `${how} on ${forms}`;
    forms.forEach((f, v) => swap.set(v, f));
  }
  const result = swap.size ? swapped(node, swap) : undefined;
  const over = overInterval(node, read);
  if (typeof over === 'string') return over;
  return over ? equalities(kind, (result ?? node)[kind]) : result;
}

// Whether `node`, a source node in the engine's dialect `read`, is IN or a
// CASE with an operand that compares an INTERVAL, or a message. BigQuery
// rejects IN and CASE over an INTERVAL when the query runs, though a dry run
// accepts them, so import writes the equalities they compare by (see
// equalities), where each value is an INTERVAL literal, a sum, difference or
// negation of them, a column or NULL. Any other value stays untranslated.
function overInterval(node: any, read: string): boolean|string {
  const kind = kindOf(node) ?? '';
  const value = node[kind];
  if (kind !== 'in' && !(kind === 'case' && value.operand)) return false;
  const values = comparedValues(kind, value)!;
  if (!values.some(v => intervalKind(v, read))) return false;
  const plain = (v: any) => !bare(v) || bare(v).null !== undefined || bare(v).column || intervalKind(v, read)?.literals;
  return values.every(plain) || `${kind === 'in' ? 'IN' : 'CASE'} over an INTERVAL other than a literal, a sum of literals or a column`;
}

// `value`, IN or a CASE with an operand, as the equalities it compares by:
// `x IN (a, b)` as `(x = a OR x = b)`, NOT IN as NOT of them, and `CASE x WHEN
// a` as `CASE WHEN x = a`. They give the same truth values, also when a value
// is NULL. An equality with a literal NULL is NULL whatever the other value
// is, and BigQuery's `=` takes no literal NULL, so it becomes
// CAST(NULL AS BOOL).
function equalities(kind: string, value: any): any {
  const is = (a: any, b: any) =>
      [a, b].some(n => bare(n)?.null !== undefined) ? sqlExpressionTree('CAST(NULL AS BOOL)', 'BIGQUERY') : equal(a, b);
  if (kind === 'case') {
    return {case: {...value, operand: null, whens: value.whens.map(([w, r]: any[]) => [is(value.operand, w), r])}};
  }
  const or = (left: any, right: any) =>
      ({or: {left, right, left_comments: [], operator_comments: [], trailing_comments: []}});
  const any = {paren: {this: value.expressions.map((e: any) => is(value.this, e)).reduce(or), trailing_comments: []}};
  return value.not ? {paren: {this: {not: {this: any}}, trailing_comments: []}} : any;
}

// Whether `node`, a source value in the engine's dialect `read`, is a
// difference the dialect gives as an INTERVAL of days and a time of day (see
// `differences`): a `-` of two values visibly a DATE, a DATETIME or a
// TIMESTAMP, one of them not a DATE. PostgreSQL and Databricks read a date or
// a timestamp without time zone there at its midnight or wall-clock time in
// UTC, as TIMESTAMP(x) does, and give each whole 24 hours of the difference as
// days, with the time of day of the same sign. BigQuery's difference of two
// TIMESTAMPs is in hours, which JUSTIFY_HOURS moves into days the same way.
function timeDifference(node: any, read: string): boolean {
  const b = bare(node);
  if (!DATE_TABLES[read]?.differences || !b?.sub) return false;
  const types = [b.sub.left, b.sub.right].map(v => timeType(v, read));
  return types.every(t => WIDER.includes(t!)) && types.some(t => t !== 'DATE');
}
const DIFFERENCE = 'JUSTIFY_HOURS(TIMESTAMP(_1) - TIMESTAMP(_2))';

// BigQuery's SQL for each part of an INTERVAL _1 that PostgreSQL's EXTRACT
// gives, by its name in lower case, as an exact NUMERIC. Both keep an
// INTERVAL's months, days and time of day apart, and give each field with
// its own sign: the years of its months toward zero and the rest of the
// months, its days, the hours of its time of day and the minutes and seconds
// below them. BigQuery gives the seconds whole and their fraction as
// MICROSECOND. PostgreSQL's quarter is the rest of the months divided by 3,
// toward zero, plus 1. Its epoch counts a year as 365.25 days and a month as
// 30.
const MICROS_OF_SECONDS = 'EXTRACT(SECOND FROM _1) * 1000000 + EXTRACT(MICROSECOND FROM _1)';
const INTERVAL_PARTS = lookup({
  ...Object.fromEntries(['year', 'month', 'day', 'hour', 'minute'].map(
      p => [p, `CAST(EXTRACT(${p.toUpperCase()} FROM _1) AS NUMERIC)`])),
  quarter: 'CAST(DIV(EXTRACT(MONTH FROM _1), 3) + 1 AS NUMERIC)',
  ...Object.fromEntries(([['decade', 10], ['century', 100], ['millennium', 1000]] as const).map(
      ([p, n]) => [p, `CAST(DIV(EXTRACT(YEAR FROM _1), ${n}) AS NUMERIC)`])),
  second: `(CAST(${MICROS_OF_SECONDS} AS NUMERIC) / 1000000)`,
  millisecond: `(CAST(${MICROS_OF_SECONDS} AS NUMERIC) / 1000)`,
  microsecond: `CAST(${MICROS_OF_SECONDS} AS NUMERIC)`,
  epoch: '(CAST(EXTRACT(YEAR FROM _1) * 31557600000000 + EXTRACT(MONTH FROM _1) * 2592000000000 + ' +
      `EXTRACT(DAY FROM _1) * 86400000000 + EXTRACT(HOUR FROM _1) * 3600000000 + ` +
      `EXTRACT(MINUTE FROM _1) * 60000000 + ${MICROS_OF_SECONDS} AS NUMERIC) / 1000000)`,
});

// The SQL in INTERVAL_PARTS for EXTRACT or DATE_PART of `part` from `node`, a
// source value in the engine's dialect `read`, when the dialect has
// `intervalParts` and `node` is visibly an INTERVAL value, or undefined.
function intervalPart(part: unknown, node: any, read: string): string|undefined {
  return DATE_TABLES[read]?.intervalParts && intervalKind(node, read) ?
      INTERVAL_PARTS[String(part).toLowerCase()] : undefined;
}

// How a node uses the values valueForms gets: it compares them with `=`, `<`
// and the like, tests the first with BETWEEN, matches them with IN or a CASE
// with a value, negates one, or gives them as its results.
type Use = 'compared'|'between'|'matched'|'negated'|'results';

// Why a MySQL date or time used as a number stays untranslated, for a
// message.
const DIGITS_NOTE = 'MySQL turns into its digits';

// The FORM_CALL in place of each of `values`, the values a node uses as `use`
// says, by value, or the types BigQuery does not compare, for a message.
// BigQuery compares the visible types of one group of COMPARED. A dialect that
// `stamps` compares a DATE or a DATETIME with a TIMESTAMP, and gives them as
// results, as TIMESTAMP(x). BigQuery negates no literal NULL. A dialect that
// reads `numbers`, MySQL, turns a date or a time negated or compared with a
// number into the number of its digits, and one among number or text results
// into text, which import leaves untranslated (see mysqlKind).
function valueForms(values: any[], read: string, use: Use): Map<any, any>|string {
  const order = COMPARED.flat();
  const typeOf = (v: any) => timeType(v, read) ?? (isNumber(v) ? 'number' : intervalKind(v, read)?.type);
  const numbers = DATE_TABLES[read]?.numbers;
  if (use === 'negated' && bare(values[0])?.null !== undefined) return 'NULL';
  const date = numbers ? values.find(v => v && mysqlKind(v, read) === 'date') : undefined;
  if (date) {
    const name = dateName(date, read);
    // A string MySQL and BigQuery read as the same date or DATETIME compares
    // alike in both, with `=`, `<` and the like, or as the bounds of a date in
    // BETWEEN. IN and CASE match strings with each other as text.
    const datetime = values.every(v => !v || mysqlKind(v, read) !== 'date' || timeType(v, read) === 'DATETIME');
    const paired = use === 'compared' || (use === 'between' && mysqlKind(values[0], read) === 'date');
    const plain = (v: any) => paired && canonicalDate(v, datetime);
    const other = values.map(v => v && !plain(v) && mysqlKind(v, read)).find(k => k === 'number' || k === 'text');
    const why = use === 'results' ? 'gives as text' : other === 'number' ? 'compares by the digits of the date' :
        'compares by reading the string as a date by its own rules';
    if (use === 'negated') return `${article(name)} ${name}, which ${DIGITS_NOTE}`;
    if (other) return `${article(name)} ${name} and a ${other === 'text' ? 'string' : 'number'}, which MySQL ${why}`;
  }
  const types = [...new Set(values.map(typeOf))]
      .filter((t): t is string => !!t).sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const group = COMPARED.find(g => g.includes(types[0])) ?? [types[0]];
  const other = types.find(t => !group.includes(t));
  if (!other) return new Map();
  const problem = `${article(types[0])} ${types[0]} and ${article(other)} ${other}`;
  if (DATE_TABLES[read]?.stamps && use !== 'negated' && types.every(t => WIDER.includes(t))) {
    const stamped = values.filter(v => v && ['DATE', 'DATETIME'].includes(typeOf(v)!));
    return new Map(stamped.map(v => [v, formCall('TIMESTAMP(_1)', [v])]));
  }
  return problem;
}

// The node to write in place of NULLIF(a, b), whose arguments are `args`, in
// the engine's dialect `read`; a message; or undefined to translate it as it
// is. BigQuery's NULLIF gives the common type of its values, as Spanner's
// does, PostgreSQL's, Databricks', SQL Server's and Snowflake's the type of a,
// and MySQL's a date or a time as text, which import leaves untranslated, as
// it does a date or a time in an ANSI_SQL text, which may run on MySQL.
// IF(a = b, NULL, a) gives the type of a, with TIMESTAMP(x) around a DATE or a
// DATETIME compared with a TIMESTAMP, which the sources read as midnight UTC.
// BigQuery's NULLIF takes no INTERVAL when the query runs, though a dry run
// accepts it, so NULLIF with an INTERVAL gets that form from every dialect. A
// value with no visible type, such as a column, may be any type. NULLIF(a,
// NULL) of a date, a time or an INTERVAL a is a, and NULLIF(NULL, b) stays
// untranslated.
function nullifForm(args: any[], read: string): any {
  const [a, b] = args;
  const interval = args.some(v => isInterval(v, read));
  if (NULLIF_BIGQUERY.has(read) && !interval) return undefined;
  if (bare(a)?.null !== undefined) return 'NULLIF of NULL';
  const dated = read === 'mysql' ? args.findIndex(v => mysqlKind(v, read) === 'date') : -1;
  if (dated >= 0) {
    const name = dateName(args[dated], read);
    if (dated === 0) return `NULLIF of ${article(name)} ${name} first, which MySQL gives as text`;
    const first = mysqlKind(a, read);
    return `NULLIF on ${article(name)} ${name} and ${first === 'number' ? 'a number, which MySQL compares by the digits of the date' :
        first === 'text' ? 'a string, which MySQL gives as text' : 'a value that may be another type'}`;
  }
  const forms = valueForms([a, b], read, 'compared');
  if (typeof forms === 'string') return `NULLIF on ${forms}`;
  const types = [...new Set(args.flatMap(givenValues).map(v => timeType(v, read)))];
  const time = types.find(t => t);
  if (time && !NULLIF_FIRST.has(read)) {
    const other = types.find(t => t && t !== time) ??
        (types.includes(undefined) && bare(b)?.null === undefined ? 'value that may be another type' : undefined);
    return other ? `NULLIF on a ${time} and a ${other}` : `NULLIF of a ${time}`;
  }
  if (bare(b)?.null !== undefined && (timeType(a, read) || interval)) return formCall('(_1)', [a]);
  if (types.length === 1 && !interval) return undefined;
  return formCall('IF(_1, NULL, _2)', [equal(a, b), a]);
}

// The FORM_CALL for `name`(end, start), a function of `dayDiffs` whose
// arguments are `args`, in the engine's dialect `read`, or a message.
// Databricks reads each value as a DATE and counts the days from start to
// end, as BigQuery's DATE_DIFF(end, start, DAY) counts them. A DATE and NULL
// stay as they are. BigQuery reads a column, the current timestamp, date
// arithmetic import translates, and a string of a date with or without a time
// of day, as Databricks does, with CAST(CAST(x AS DATETIME) AS DATE) (see
// READS).
function dayDiffForm(name: string, args: any[], read: string): any {
  const table = DATE_TABLES[read];
  const sql: string[] = [];
  for (const [i, arg] of args.entries()) {
    const b = bare(arg);
    const found = operandRow(b, read, table);
    if (typeof found === 'string') return found;
    const dated = dateText(b);
    if (!found && !dated && b?.null === undefined) return `${name} of ${valueName(b)}`;
    const date = b?.null !== undefined || found?.row === table.date;
    sql.push(date ? `_${i + 1}` : READS.DATE.replace('_1', `_${i + 1}`));
  }
  return formCall(`DATE_DIFF(${sql[0]}, ${sql[1]}, DAY)`, args);
}

// The arguments of `fn`, a source function call in the engine's dialect
// `read`, that import still has to check, the name of a construct in it
// import does not translate, or undefined when import does not translate it.
function functionArgs(fn: any, read: string): unknown[]|string|undefined {
  const name = String(fn.name).toUpperCase();
  const args: any[] = fn.args ?? [];
  const nullif = name === 'NULLIF' && args.length === 2 ? nullifForm(args, read) : undefined;
  if (typeof nullif === 'string') return nullif;
  if (read === 'spanner') return spannerArgs(name, args);
  // The current date and timestamp, DATEADD(day, 1, d), MySQL's DATE_ADD(d,
  // INTERVAL 1 DAY) and Databricks' date_add(d, 1), by the dialect's table in
  // DATE_TABLES.
  const table = DATE_TABLES[read];
  if ([...table.today, ...table.now.functions].includes(name)) return args.length ? undefined : [];
  if (table.functions[name]) {
    const sum = dateSum({function: fn}, read);
    return typeof sum === 'object' ? [sum.operand, sum.amount] : sum;
  }
  if (table.dayDiffs?.includes(name) && args.length === 2) {
    const form = dayDiffForm(name, args, read);
    return typeof form === 'string' ? form : args;
  }
  const [dialects, fewest, most] = FUNCTIONS[name] ?? [[], 0, 0];
  if (!dialects.includes(read) || args.length < fewest || args.length > most) {
    return undefined;
  }
  if (name === 'CONCAT') return joinProblem(name, args, read) ?? args;
  const part = (arg: any) => String(partName(arg) ?? '?');
  if (name === 'DATE_PART' && intervalPart(part(args[0]), args[1], read)) return [args[1]];
  if (['DATE_TRUNC', 'DATE_PART', 'DATEDIFF', 'DATE_DIFF', 'TIMESTAMPDIFF'].includes(name)) {
    const unit = table.diffs?.includes(name) ? diffSql(args[0]) :
        name === 'DATE_TRUNC' ? truncUnit(args[0], read) : PARTS[part(args[0]).toLowerCase()];
    if (!unit) return `${name} with part '${part(args[0])}'`;
    const values = args.slice(1).map(a => dateValue(name, a));
    return values.find(v => typeof v === 'string') ?? args.slice(1);
  }
  return args;
}

// `[node]`, the date or timestamp the date function `name` reads, to check
// next, or a message. It may be a column, a DATE literal, a cast or the
// current date or time; BigQuery reads a string, a number or a sum another way,
// or rejects it.
function dateValue(name: string, node: any): unknown[]|string {
  const b = bare(node);
  const allowed = b?.column || b?.cast || b?.try_cast || b?.literal?.literal_type === 'date' ||
      CURRENT.has(String(b?.function?.name).toUpperCase());
  return allowed ? [node] : `${name} of ${valueName(b)}`;
}

// What `node`, a source value, is, for a message.
function valueName(node: any): string {
  if (numberText(node) !== undefined) return 'a number';
  const kind = kindOf(node) ?? '';
  const value = node?.[kind];
  const type = kind === 'literal' && value.literal_type.replaceAll('_', ' ');
  if (type) return type === 'string' ? 'a string' : `${article(type)} ${type} literal`;
  if (kind === 'cast' || kind === 'try_cast') return `a cast to ${typeName(castType(value.to), '')}`;
  // The engine keeps the name a function is written with, such as IFNULL or
  // IFF, as `original_name`, and MIN's or MAX's as `name`.
  const written = [value?.original_name, value?.name].find(n => typeof n === 'string');
  if (written) return written.toUpperCase();
  return ({column: 'a column', add: 'a sum', sub: 'a difference', interval: 'an INTERVAL',
           coalesce: 'COALESCE', case: 'CASE', if_func: 'IF', nvl: 'NVL'} as Record<string, string>)[kind] ??
      'an expression';
}

// Whether import keeps `value`, an engine interval in a SPANNER text outside
// DATE_ADD, the other functions of SPANNER_ADDS and a comparison: an amount
// of weeks, days, hours or minutes. A week is 7 days, as in BigQuery, since
// Spanner's INTERVAL has no part for weeks. Spanner adds a month or a year to
// no TIMESTAMP and an INTERVAL to no DATE, where BigQuery adds one to a DATE,
// and such an INTERVAL can reach `+` or `-` through COALESCE, a product or any
// other expression.
function spannerInterval(value: any): boolean {
  return spannerAmount(value) &&
      ['WEEK', 'DAY', 'HOUR', 'MINUTE'].includes(String(value.unit.unit).toUpperCase());
}

// The functions that add their INTERVAL as Spanner does, for any unit they take.
const SPANNER_ADDS = new Set(['DATE_ADD', 'DATE_SUB', 'TIMESTAMP_ADD', 'TIMESTAMP_SUB']);

// Whether `value`, an engine interval in a SPANNER text, names one unit and a
// whole number or an expression, which Spanner and BigQuery both need to be an
// INT64.
function spannerAmount(value: any): boolean {
  const b = bare(value?.this);
  const expression = !!b && !b.literal && b.boolean === undefined;
  return value?.unit?.type === 'simple' && (expression || /^\s*[+-]?\d+\s*$/.test(intervalAmount(value) ?? ''));
}

// `value`, an engine interval, as the source writes it after INTERVAL, for a
// message. Its unit is a name, such as DAY, a node, such as DAY(9), or a span
// of two of either, such as HOUR TO MINUTE, which is a compound unit, such as
// HOUR_MINUTE, where `table` has one.
function intervalText(value: any, table?: DateTable): string {
  const text = intervalAmount(value) ?? '?';
  const spec = value?.unit;
  const span = [unitName(spec?.this), unitName(spec?.expression)];
  const unit = !spec ? undefined : spec.type === 'simple' ? unitName(spec.unit) :
      spec.type === 'expr' ? unitName(spec) :
      table?.compounds?.[span.join('_')] ? span.join('_') : span.join(' TO ');
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

// Whether `node`, a source value, is a DATE: the current date, a DATE
// literal, or a CAST or TRY_CAST to DATE.
function isDate(node: any): boolean {
  const b = bare(node);
  return castType((b?.cast ?? b?.try_cast)?.to) === 'date' ||
      b?.literal?.literal_type === 'date' || TODAY.has(String(b?.function?.name).toUpperCase());
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
// it in the dialect of the lists' `rules`, or else the engine's kind of node.
function constructName(engine: PolyglotEngine, node: any, rules: string): string {
  const [kind, value] = Object.entries(node)[0] as [string, any];
  // A `raw` node is SQL the engine kept as one unparsed string, such as a
  // prefix NOT before LIKE in most dialects, so there is no operand to swap
  // for a placeholder column before generating it again. Name it as written.
  if (kind === 'raw') return value.sql;
  // A `not` node here wraps an operator import does not translate, such as
  // ILIKE in `s NOT ILIKE p` (see nextNodes).
  if (kind === 'not') return `NOT ${constructName(engine, value.this, rules)}`;
  const written = [value?.original_name, value?.name].find(n => typeof n === 'string');
  if (written) return written.toUpperCase();
  if (kind === 'window_function') return 'OVER';
  // The node with a column `x` for each node in it. A node such as PI() has
  // none.
  const x = {column: {name: {name: 'x', quoted: false}, table: null}};
  const bareNode = value && Object.fromEntries(Object.entries(value).map(([k, v]) =>
      [k, Array.isArray(v) ? v.map(e => isNode(e) ? x : e) : isNode(v) ? x : v]));
  const sql = engine.generate([{[kind]: bareNode}], ENGINE_DIALECTS[rules] ?? rules).sql?.[0] ?? '';
  const called = /^([A-Za-z_]\w*)\s*\(/.exec(sql)?.[1];
  const operator = sql.replace(/\bx\b/g, '').trim();
  const plain = /^[^()[\].,]+$/.test(operator) ? operator : kind.replaceAll('_', ' ');
  return (called ?? plain).toUpperCase();
}

// The dialects that have YEAR(d), MONTH(d) and similar functions. The engine
// writes them to BigQuery with `d` left in the source dialect.
const EXTRACT_FIRST = new Set(['mysql', 'snowflake', 'databricks', 'tsql']);

// The name of the call that stands for a date arithmetic in the text the
// engine translates. The engine keeps a call it does not know and translates
// its arguments, and dateSql writes the arithmetic in its place. A source
// text that calls it is refused, since it is no function on the lists.
const DATE_CALL = 'KCMD_DATE_ARITHMETIC';

// `sql`, in the engine's dialect `read`, ready for the engine to translate to
// BigQuery by the lists' `rules` for the text, or an error. Each date
// arithmetic in DATE_TABLES with a unit is a DATE_CALL (see dateCall), and
// each construct exactForm, or ossieForm for an OSSIE_SQL_2026 text, gives a
// form for has its FORM_CALL. A whole number added to a column has no unit
// and is kept, since the engine writes it as written. In a dialect of
// EXTRACT_FIRST, YEAR(d) and the other functions of PARTS are written as
// EXTRACT, whose argument the engine translates.
function forBigQuery(engine: PolyglotEngine, sql: string, dialect: string, read: string, rules: string):
    {sql: string}|{error: string} {
  let changed = false;
  const rewrite = (node: any, whole = false): any => {
    if (!node || typeof node !== 'object') return node;
    if (Array.isArray(node)) return node.map(n => rewrite(n));
    const sum = isNode(node) ? dateSum(node, rules) : undefined;
    // A function that adds an INTERVAL value becomes `+` or `-`, in parentheses
    // unless it is the `whole` text.
    if (typeof sum === 'object' && !sum.unit && sum.call) {
      changed = true;
      const kind = sum.subtract ? 'sub' : 'add';
      const template = sqlExpressionTree(sum.subtract ? 'x - y' : 'x + y', dialect)[kind];
      const written = {[kind]: {...template, left: sum.operand, right: {paren: {this: sum.interval}}}};
      return rewrite(whole ? written : {paren: {this: written}});
    }
    if (typeof sum === 'object' && sum.unit) {
      changed = true;
      // An operand of DATE_ADD or TIME_ADD, or of a function that reads it,
      // needs no parentheses.
      let operand = sum.operand;
      while ((sum.addition.form !== '+' || readsOf(sum).length) && operand?.paren) {
        operand = operand.paren.this;
      }
      return dateCall(sum, rewrite(operand), rewrite(sum.amount), whole, dialect);
    }
    // An INTERVAL that import keeps as the source writes it, in an INTERVAL
    // value, is BigQuery's INTERVAL of each of its units.
    const table = DATE_TABLES[rules];
    const added = table && isNode(node) && intervalOf(node, rules);
    const parsed = added && readInterval(added, table, rules);
    if (parsed && typeof parsed === 'object') {
      changed = true;
      // Months first, then days, then time, as the sources add them.
      const sorted = [...parsed].sort((a, b) => UNITS.indexOf(b.unit) - UNITS.indexOf(a.unit));
      const sql = sorted.map((p, i) => `INTERVAL _${i + 1} ${p.unit}`).join(' + ');
      return formCall(sorted.length > 1 ? `(${sql})` : sql, sorted.map(p => p.amount));
    }
    // A `+` that BigQuery adds to TIMESTAMP(x) or in UTC reads its operand so,
    // and one in UTC reads its result back.
    let inner = typeof sum === 'object' ? sum.operand : undefined;
    while (inner?.paren) inner = inner.paren.this;
    const reads = typeof sum === 'object' ? readsOf(sum) : [];
    const stamped = typeof sum === 'object' && reads.length ?
        swapped(node, new Map([[sum.operand, formCall(readSql(reads), [inner])]])) : undefined;
    const exact = stamped ??
        (!isNode(node) ? undefined : rules === 'ossie' ? ossieForm(node) : exactForm(node, rules));
    if (exact && typeof exact === 'object') changed = true;
    const source = exact && typeof exact === 'object' ? exact : node;
    const out: any = Object.fromEntries(Object.entries(source).map(([k, v]) => [k, rewrite(v)]));
    if (reads.includes('UTC')) return formCall(UTC_BACK, [out]);
    const part = EXTRACT_FIRST.has(rules) && Object.keys(PARTS).find(k => out[k]?.this);
    if (!part) return out;
    changed = true;
    return {extract: {this: out[part].this, field: extractField(part)}};
  };
  // The engine reads a column named NOW, CURDATE, GETDATE or SYSDATE as the
  // function, quoted or not, so it gets a form that writes the quoted column.
  const tree = mapTree(rewrite(sourceTree(sql, dialect, read), true), node => {
    const name = node.column?.table ? undefined : node.column?.name?.name;
    if (!CALLED_ONLY.has(String(name).toUpperCase())) return undefined;
    changed = true;
    return formCall(`\`${name}\``, []);
  });
  if (!changed) return {sql};
  const written = engine.generate([commentsOnce(tree)], read);
  return written.success && written.sql?.length === 1 ? {sql: written.sql[0]} :
      {error: written.error ?? 'the text could not be written for the engine'};
}

// The DATE_CALL for `sum`, with `operand` and `amount`, its operand and amount
// ready for the engine, in `dialect`: the operand, the amount, the unit and
// BigQuery's form, then the names in READS of how BigQuery reads the operand
// first (see readsOf). A sum written with `+` or `-` for a function call goes
// in parentheses, unless it is the `whole` text or BigQuery reads it back.
function dateCall(sum: DateSum, operand: unknown, amount: unknown, whole: boolean, dialect: string): unknown {
  const op = sum.first ? 'INTERVAL +' : sum.subtract ? '-' : '+';
  const reads = readsOf(sum);
  const form = sum.addition.dayCount ? (sum.subtract ? 'DAYS_SUB' : 'DAYS_ADD') :
      sum.addition.form !== '+' ? sum.addition.form.replace('ADD', sum.subtract ? 'SUB' : 'ADD') :
      sum.call && !whole && !reads.includes('UTC') ? `(${op})` : op;
  const call = sqlExpressionTree(`${DATE_CALL}(x, 1, 'x', 'x')`, dialect).function;
  const text = (value: string) => ({literal: {literal_type: 'string', value}});
  // Weeks as days (see Addition): 7 times a whole number, or times any other
  // amount.
  const number = numberText(amount);
  const days = !sum.addition.inDays ? amount : /^-?\d+$/.test(number ?? '') ?
      wholeNumber(String(7n * BigInt(number!))) : formCall('7 * (_1)', [amount]);
  const unit = sum.addition.inDays ? 'DAY' : sum.unit!;
  return {function: {...call, args: [operand, days, text(unit), text(form), ...reads.map(text)]}};
}

// How BigQuery reads the operand of `sum` first, as names in READS, in order:
// the type the source reads it as first, TIMESTAMP when BigQuery adds to
// TIMESTAMP(x), and UTC when it adds in UTC (see Addition).
function readsOf(sum: DateSum): string[] {
  const first = sum.reads ? [sum.reads] : sum.addition.timestamp ? ['TIMESTAMP'] : [];
  return sum.addition.utc ? [...first, 'UTC'] : first;
}

// BigQuery's SQL that reads _1 as `reads`, names in READS, say in order.
function readSql(reads: string[]): string {
  return reads.reduce((sql, r) => READS[r].replace('_1', sql), '_1');
}

// The engine's EXTRACT field for `part`, a key of PARTS, such as `Year`.
function extractField(part: string): string {
  return part[0].toUpperCase() + part.slice(1);
}

// `node`, an engine tree, with each comment once. The engine gives a comment
// to each node that ends where it stands, which is the last node of each of
// them, and to the operator after it as `left_comments`, and writes every
// copy, so a placeholder call before a comment gets more copies with each
// pass through the engine.
function commentsOnce(node: any, held: string[] = []): any {
  if (!node || typeof node !== 'object') return node;
  if (Array.isArray(node)) return node.map((n, i) => commentsOnce(n, i === node.length - 1 ? held : []));
  const list = (k: string): string[] => Array.isArray(node[k]) ? node[k] : [];
  const nodes = Object.keys(node).filter(k => !k.endsWith('comments') && node[k] && typeof node[k] === 'object');
  return Object.fromEntries(Object.entries(node).map(([k, v]) => [k,
    k === 'trailing_comments' ? [...new Set(list(k))].filter(c => !held.includes(c)) :
    k === 'left_comments' ? [...new Set(list(k))] : k.endsWith('comments') ? v :
    commentsOnce(v, [...(k === nodes.at(-1) ? [...held, ...list('trailing_comments')] : []),
                     ...(k === 'left' ? list('left_comments') : [])])]));
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
// were. It also keeps the name of Snowflake's TIMESTAMP_NTZ, and a comparison,
// IS NULL, LIKE, IN or BETWEEN of another without parentheses. BigQuery
// rejects each of these, and the engine reports success.
// It keeps TRIM(s), a decimal number such as 0.29, Snowflake's current date and
// timestamp, MySQL's and SQL Server's current timestamp, and Snowflake's
// division and average, which give another value or type in BigQuery. So the
// adapter reads the engine's BigQuery output back and rewrites them. It also
// writes each date arithmetic in place of its DATE_CALL (see dateSql), and each
// form in place of its FORM_CALL (see formSql).

// The types BigQuery has for Snowflake's TIMESTAMP_NTZ, a wall-clock time.
const SNOWFLAKE_TYPES: Record<string, unknown> = {
  TIMESTAMPNTZ: {data_type: 'custom', name: 'DATETIME'},
};

// Sets `node`, an engine node read from BigQuery's SQL, to be written as it
// was read. The engine reads BigQuery's TIMESTAMP as a timestamp without time
// zone, which it writes as DATETIME, writes BOOL as BOOLEAN, and writes
// DAYOFWEEK and DAYOFYEAR as DOW and DOY.
function asWritten(node: any): void {
  if (node.data_type === 'timestamp') node.timezone = true;
  if (node.data_type === 'boolean') Object.assign(node, {data_type: 'custom', name: 'BOOL'});
  const part = node.extract && partName(node.extract.field);
  if (part === 'DAYOFWEEK' || part === 'DAYOFYEAR') node.extract.field = {Custom: part};
}

// `sql`, the engine's BigQuery output from a text with the lists' rules
// `read`, with the forms above rewritten, or an error when the engine cannot
// write the result. A text the engine cannot read back is returned as it is;
// transpileModel's qualifier check reports it.
function repairForBigQuery(engine: PolyglotEngine, sql: string, read: string):
    {sql: string}|{error: string} {
  const tree = sqlExpressionTree(sql, 'BIGQUERY');
  if (!tree) return {sql};
  let changed = false;
  const result = mapTree(tree, visited => {
    const named = withQuotedNames(visited);
    const written = named ?? visited;
    const wrapped = spliced(written);
    const node: any = wrapped ?? written;
    asWritten(node);
    const dated = withPlainDates(node);
    const repaired = repairNode(dated ?? node, read) ?? dated ?? wrapped ?? named;
    if (repaired !== undefined) changed = true;
    return repaired;
  });
  if (!changed) return {sql};
  const written = engine.generate([commentsOnce(result)], 'bigquery');
  if (!written.success || written.sql?.length !== 1) {
    return {error: written.error ?? 'the repaired SQL could not be written'};
  }
  return {sql: written.sql[0]};
}

// Whether BigQuery reads `name` as a name without quotes: a letter or
// underscore followed by letters, digits and underscores, and no reserved
// word.
function plainBigQueryName(name: string): boolean {
  return isSimpleIdentifier(name) && !isReservedKeyword(name);
}

// `node`, an engine node of BigQuery SQL, with the name of its column, its
// table or its struct field quoted where BigQuery cannot read the name without
// quotes, or undefined when no name needs them. The engine writes a name as
// the source writes it, such as amt$, which BigQuery refuses.
function withQuotedNames(node: any): unknown {
  const plain = (id: any) => !id || id.quoted || plainBigQueryName(id.name);
  const quoted = (id: any) => plain(id) ? id : {...id, quoted: true};
  const column = node.column;
  if (column && !(plain(column.name) && plain(column.table))) {
    return {...node, column: {...column, name: quoted(column.name), table: quoted(column.table)}};
  }
  if (node.dot && !plain(node.dot.field)) return {...node, dot: {...node.dot, field: quoted(node.dot.field)}};
  return undefined;
}

// The node to put in place of `node`, an engine node of BigQuery SQL from the
// engine's dialect `read`, or undefined to keep it.
function repairNode(node: any, read: string): unknown {
  const fn = node.function;
  const args: any[] = fn?.args ?? [];
  const name = String(fn?.name).toUpperCase();
  if (fn && !args.length && CURRENT_TIME[read]?.[name]) {
    return sqlExpressionTree(CURRENT_TIME[read][name], 'BIGQUERY');
  }
  if (name === DATE_CALL) return dateSql(args);
  if (name === FORM_CALL) return formSql(args);
  // A call outside Ossie's tables keeps its name (see ossieText), and a
  // window's ORDER BY item gets its NULL placement (see windowForm).
  if (read === 'ossie' && name.startsWith(PASS)) return {function: {...fn, name: fn.name.slice(PASS.length)}};
  const placed = read === 'ossie' && 'nulls_first' in node ?
      NULLS_CALLS.indexOf(String(node.this?.function?.name).toUpperCase()) : -1;
  if (placed >= 0) return {...node, this: node.this.function.args[0], nulls_first: placed === 0};
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
      column: {name: {name: col, quoted: !plainBigQueryName(col)}, table: null},
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
  // BigQuery's TRIM(s) removes every kind of whitespace, as Ossie's does, and
  // the other sources' TRIM only spaces.
  if (node.trim && node.trim.characters === null && read !== 'ossie') {
    const characters = {literal: {literal_type: 'string', value: ' '}};
    return {trim: {...node.trim, characters, sql_standard_syntax: false}};
  }
  // A decimal number is exact in the sources, and a FLOAT64 in BigQuery, so it
  // becomes a NUMERIC, or a BIGNUMERIC when a NUMERIC cannot hold it. The engine
  // writes a `var` node's text as it is. So does a whole number past INT64 in
  // an OSSIE_SQL_2026 text.
  const number = node.literal?.literal_type === 'number' ? String(node.literal.value) : '';
  const whole = read === 'ossie' && /^\d+$/.test(number) && BigInt(number) >= 2n ** 63n;
  const decimal = /^(\d*)\.(\d*)$/.exec(number) ?? (whole ? [number, number, ''] : undefined);
  if (decimal) {
    const big = decimal[1].replace(/^0+/, '').length > 29 || decimal[2].length > 9;
    return {var: {this: `${big ? 'BIGNUMERIC' : 'NUMERIC'} '${node.literal.value}'`}};
  }
  return undefined;
}

// BigQuery's SQL for a DATE_CALL whose arguments are `args`, engine nodes of
// BigQuery SQL: the operand, the amount, the unit and BigQuery's form, and
// how BigQuery reads the operand first, if it does (see READS). The form is
// DATE_ADD, DATE_SUB, `+`, `-`, or DAYS_ADD or DAYS_SUB for an amount added
// as days (see Addition). A form in parentheses puts the sum in parentheses,
// since it stands where the source calls a function.
function dateSql(args: any[]): unknown {
  const [operand, amount, unit, form, ...given] = args;
  const text = (n: any) => String(bare(n)?.literal?.value);
  const reads = given.map(text);
  const sql = (value: string) => ({literal: {literal_type: 'string', value}});
  const date = reads.length ? formSql([sql(readSql(reads)), operand]) : operand;
  const back = (sum: unknown) => reads.includes('UTC') ? formSql([sql(UTC_BACK), sum]) : sum;
  const name = text(unit);
  const added = {
    interval: {this: amount, unit: {type: 'simple', unit: extractField(name.toLowerCase()), use_plural: false}},
  };
  const how = text(form);
  if (how === 'DAYS_ADD' || how === 'DAYS_SUB') {
    const shifted = `${how === 'DAYS_ADD' ? 'DATE_ADD' : 'DATE_SUB'}(CAST(_1 AS DATE), INTERVAL _2 ${name})`;
    return back(formSql([sql(`DATE_ADD(_1, INTERVAL DATE_DIFF(${shifted}, CAST(_1 AS DATE), DAY) DAY)`), date, amount]));
  }
  if (['DATE_ADD', 'DATE_SUB', 'TIME_ADD', 'TIME_SUB'].includes(how)) {
    const call = sqlExpressionTree(`${how}(x, y)`, 'BIGQUERY');
    return back({function: {...call.function, args: [date, added]}});
  }
  const op = how.replace(/^\((.*)\)$/, '$1');
  const kind = op === '-' ? 'sub' : 'add';
  const template = sqlExpressionTree(op === '-' ? 'x - y' : 'x + y', 'BIGQUERY')[kind];
  const sum = {[kind]: {...template, ...(op === 'INTERVAL +' ? {left: added, right: date} : {left: date, right: added})}};
  return back(op === how ? sum : {paren: {this: sum}});
}

// How BigQuery reads an operand first, by the name a DATE_CALL gives. Its
// CAST(CAST(x AS DATETIME) AS DATE) gives the date of a DATE, a DATETIME, a
// TIMESTAMP in UTC, or a string with or without a time of day, as Databricks'
// date_add does. TIMESTAMP(x) gives a DATE at midnight UTC. DATETIME(x, 'UTC')
// gives the wall-clock time in UTC of a TIMESTAMP, and UTC_BACK reads a sum
// of it back as the TIMESTAMP.
const READS: Record<string, string> = {
  DATE: 'CAST(CAST(_1 AS DATETIME) AS DATE)',
  TIMESTAMP: 'TIMESTAMP(_1)',
  UTC: "DATETIME(_1, 'UTC')",
};
const UTC_BACK = "TIMESTAMP(_1, 'UTC')";

// BigQuery's SQL for a FORM_CALL whose arguments are `args`, engine nodes of
// BigQuery SQL: the form's SQL, then the operands it names _1, _2 and so on.
// A quoted NOW, CURDATE, GETDATE or SYSDATE in the form is a column, as in
// BigQuery.
// The form and each operand are written as one value (see spliced).
function formSql(args: any[]): unknown {
  const [sql, ...operands] = args;
  const form = mapTree(calledColumns(sqlExpressionTree(String(bare(sql)?.literal?.value), 'BIGQUERY')), node => {
    asWritten(node);
    const index = /^_(\d+)$/.exec(node.column?.table ? '' : node.column?.name?.name ?? '')?.[1];
    if (!index) return spliced(node);
    const operand = operands[Number(index) - 1];
    if (operand && typeof operand === 'object') SPLICED.add(operand);
    return operand;
  });
  if (form && typeof form === 'object') SPLICED.add(form);
  return form;
}

// The forms formSql writes, and the operands it writes into them.
const SPLICED = new WeakSet<object>();

// The kinds of node, other than those with a `left` and a `right` operand,
// that are an operator, with the parts that are its operands.
const OPERANDS: Record<string, string[]> = {
  neg: ['this'], not: ['this'], bitwise_not: ['this'], is_null: ['this'], is_true: ['this'],
  is_false: ['this'], in: ['this'], between: ['this', 'low', 'high'], collation: ['this'], at_time_zone: ['this'],
};

// The parts of `node`, an engine node, that stand beside an operator outside
// parentheses: the operands of an operator, and the value of a subscript or
// a field access, such as x in x[OFFSET(0)].
function operandParts(node: any): string[] {
  const kind = kindOf(node) ?? '';
  const value = node?.[kind];
  if (!value || typeof value !== 'object') return [];
  if ('left' in value && 'right' in value) return ['left', 'right'];
  return OPERANDS[kind] ?? (kind === 'subscript' || kind === 'dot' ? ['this'] : []);
}

// Whether `node`, an engine node, is an operator with its operands, whose text
// another operator beside it can split. A single token, a call, a subscript, a
// field access and a value in parentheses are not.
function isOperator(node: any): boolean {
  while (node?.annotated) node = node.annotated.this;
  const kind = kindOf(node);
  return kind !== 'subscript' && kind !== 'dot' && operandParts(node).length > 0;
}

// `node`, an engine node of BigQuery SQL, with each of its operands in
// parentheses that is in SPLICED and is an operator, or undefined when it has
// none. The engine writes only the parentheses a tree holds, so these keep an
// operator beside a form, such as the `/` of `10 / MEDIAN(x)`, from binding
// to part of it.
function spliced(node: any): unknown {
  const kind = kindOf(node);
  const value = kind ? node[kind] : undefined;
  const parts = operandParts(node).filter(p => SPLICED.has(value[p]) && isOperator(value[p]));
  if (!parts.length) return undefined;
  return {[kind!]: {...value, ...Object.fromEntries(parts.map(p => [p, {paren: {this: value[p], trailing_comments: []}}]))}};
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

// BigQuery's SQL for the current date and timestamp the engine writes, by the
// engine's dialect and the name the engine writes. Snowflake reads them in its
// default time zone, America/Los_Angeles, and its TIMESTAMP_NTZ column, its
// default, is compared with the current timestamp as a wall-clock time there.
// MySQL's NOW(), CURRENT_TIMESTAMP, LOCALTIMESTAMP and LOCALTIME give a
// DATETIME in whole seconds, and SQL Server's GETDATE() and CURRENT_TIMESTAMP a
// DATETIME, each in UTC by default.
const CURRENT_TIME: Record<string, Record<string, string>> = {
  snowflake: {
    CURRENT_DATE: "CURRENT_DATE('America/Los_Angeles')",
    CURRENT_TIMESTAMP: "CURRENT_DATETIME('America/Los_Angeles')",
  },
  mysql: Object.fromEntries(['CURRENT_TIMESTAMP', 'LOCALTIMESTAMP', 'LOCALTIME']
      .map(n => [n, "DATETIME_TRUNC(CURRENT_DATETIME('UTC'), SECOND)"])),
  tsql: {CURRENT_TIMESTAMP: "CURRENT_DATETIME('UTC')"},
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
// column, or WEEK(MONDAY), which it reads as a function. A column with a
// qualifier gives both names, as `orders.day`, which no date part matches,
// so a message names it.
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
  if (b?.column) {
    const table = b.column.table?.name;
    return table === undefined ? b.column.name?.name : `${table}.${b.column.name?.name}`;
  }
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
// 'column', a type a cast gives, 'date', 'timestamp', or 'interval' for an
// INTERVAL (see intervalKind) and a difference of two dates, timestamps or
// columns (see spannerDifference). A difference of two columns may be a
// number, which needs no time zone either.
function spannerType(node: any): string|undefined {
  const b = bare(node);
  return spannerTime(b) ?? (intervalKind(b, 'spanner') || spannerDifference(b, true) ? 'interval' : undefined);
}

// What `node`, a SPANNER value, visibly is when that is not an INTERVAL: the
// engine's literal type, 'column', a type a cast gives, 'date' or 'timestamp'.
function spannerTime(node: any): string|undefined {
  const b = bare(node);
  const kind = kindOf(b) ?? '';
  const value = b?.[kind];
  const name = String(value?.name).toUpperCase();
  return kind === 'literal' ? value.literal_type : kind === 'column' ? 'column' :
      kind === 'cast' || kind === 'safe_cast' ? value.to.data_type :
      kind === 'timestamp' || SPANNER_TIMESTAMPS.has(name) ? 'timestamp' :
      SPANNER_DATES.has(name) ? 'date' : undefined;
}

// Whether `node`, a SPANNER value, is a difference of two dates, timestamps or
// columns, one of them a date or a timestamp, or with `columns` also of two
// columns. Spanner has no INTERVAL column and subtracts no number from a date,
// so the first is an INTERVAL. A difference of two columns may be a number.
function spannerDifference(node: any, columns = false): boolean {
  const types = node?.sub ? [node.sub.left, node.sub.right].map(spannerTime) : [];
  return types.length === 2 && types.every(t => ['timestamp', 'date', 'column'].includes(t!)) &&
      (columns || types.some(t => t !== 'column'));
}

// The parts of a SPANNER node of `kind` that import still has to check, the
// name of a construct in it import does not translate, or undefined to check
// the node as any other. A message that names the node's operator starts with
// `prefix`, which is NOT for NOT IN and NOT BETWEEN. A date string without a
// time zone is translated only where Spanner visibly reads it as a string or a
// DATE, or where import writes the time zone for it.
function spannerNodes(kind: string, value: any, prefix: string): unknown[]|string|undefined {
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
        `${prefix}${OPERATORS[kind]} of a date string and a value that may be a TIMESTAMP`;
  }
  // Spanner and BigQuery compare INTERVALs with a month as 30 days and a day
  // as 24 hours, so a comparison takes an INTERVAL of any unit, as do BETWEEN,
  // IN and CASE, which compare with `=` (see equalities).
  const over = overInterval({[kind]: value}, 'spanner');
  if (typeof over === 'string') return `${prefix}${over}`;
  const intervals = compared?.filter(v => spannerAmounts(v)) ?? [];
  if (intervals.length) {
    const forms = valueForms(compared!, 'spanner', 'compared');
    if (typeof forms === 'string') return `${prefix}${OPERATORS[kind]} on ${forms}`;
    return [...rest(...intervals), ...intervals.flatMap(v => spannerAmounts(v)!)];
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
    // Spanner and BigQuery give an INTERVAL's parts as Y-M D H:M:S, so EXTRACT
    // takes an INTERVAL of any unit, as DATE_ADD does.
    return spannerAmounts(value.this) ?? [value.this];
  }
  if (kind === 'interval') return spannerInterval(value) ? [value.this] : `INTERVAL ${intervalText(value)}`;
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

// The amounts of the INTERVALs in `node`, a SPANNER value, when it is only
// INTERVALs, negated, added or subtracted (see intervalKind), each of one unit
// and a whole number or an expression (see spannerAmount), or undefined.
function spannerAmounts(node: any): unknown[]|undefined {
  const literals = intervalKind(node, 'spanner')?.literals;
  return literals?.every(spannerAmount) ? literals.map(l => l.this) : undefined;
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
  const added = SPANNER_ADDS.has(name) ? bare(args[1])?.interval : undefined;
  if (added) return spannerAmount(added) ? [args[0], added.this] : `INTERVAL ${intervalText(added)}`;
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
    // The exact forms, such as the equalities of IN over an INTERVAL (see
    // exactForm), and Spanner's time zone.
    const exact = isNode(node) ? exactForm(node, 'spanner') : undefined;
    const zoned = (typeof exact === 'object' && exact) || (isNode(node) && spannerZone(node)) || node;
    return Object.fromEntries(Object.entries(zoned).map(([k, v]) => [k, rewrite(v)]));
  };
  // Each FORM_CALL becomes its form (see formSql).
  const result = mapTree(rewrite(tree), node => {
    asWritten(node);
    return String(node.function?.name).toUpperCase() === FORM_CALL ? formSql(node.function.args) : spliced(node);
  });
  const written = engine.generate([result], 'bigquery');
  if (!written.success || written.sql?.length !== 1) {
    return {error: written.error ?? 'the translated SQL could not be written'};
  }
  return {sql: written.sql[0]};
}

// --- OSSIE_SQL_2026 texts -------------------------------------------------------
//
// An OSSIE_SQL_2026 text is Apache Ossie's SQL. BigQuery is the only database
// kcmd runs it on, so import gives each construct the value Ossie defines, and
// BigQuery's own value where Ossie defines none. Ossie defines true division,
// ROUND's ties away from zero, the base first in LOG, `%` and `_` as the only
// wildcards of LIKE, whose strings have no escapes, FILTER, which an
// aggregate reads as the aggregate of IF(p, x, NULL), since it skips NULL, and
// a window's ORDER BY without NULLS FIRST or NULLS LAST, which sorts NULL as
// the largest value, where BigQuery sorts it as the smallest. A call of a function
// outside Ossie's tables, or with another number of arguments, is written as
// it is, so that BigQuery's function of that name gives its value. The engine
// reads the text as generic SQL, which also reads some text outside Ossie's
// grammar, such as an INTERVAL or a subquery. Import leaves such text
// untranslated. Weeks start on Monday in DATE_TRUNC, as Ossie defines, and in
// EXTRACT, DATE_PART and DATEDIFF, as BigQuery's ISOWEEK numbers them.

// The prefix import gives the name of a call outside Ossie's tables, so that
// the engine keeps the call as written (see ossieText). The repairs remove it.
const PASS = 'KCMD_PASS_';

// The functions in Ossie's tables, by name, with the fewest and most
// arguments of each.
const OSSIE_CALLS: Record<string, [number, number]> = Object.fromEntries([
  ...([
    [0, 0, [
      'PI', 'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'CURRENT_TIME', 'ROW_NUMBER', 'RANK', 'DENSE_RANK', 'PERCENT_RANK',
      'CUME_DIST',
    ]],
    [1, 1, [
      'STDDEV', 'STDDEV_POP', 'STDDEV_SAMP', 'VARIANCE', 'VAR_POP', 'VAR_SAMP', 'MEDIAN', 'PERCENTILE_CONT',
      'PERCENTILE_DISC', 'APPROX_COUNT_DISTINCT', 'NTILE', 'FIRST_VALUE', 'LAST_VALUE',
      'YEAR', 'QUARTER', 'MONTH', 'DAY', 'DAYOFYEAR', 'HOUR', 'MINUTE', 'SECOND',
      'SUM', 'COUNT', 'AVG', 'MIN', 'MAX', 'LENGTH', 'LOWER', 'UPPER', 'TRIM', 'LTRIM', 'RTRIM', 'ABS',
      'FLOOR', 'CEIL', 'CEILING', 'SIGN', 'SQRT', 'EXP', 'LN', 'LOG10', 'SIN', 'COS', 'TAN', 'ASIN',
      'ACOS', 'ATAN', 'RADIANS', 'DEGREES', 'ZEROIFNULL', 'NULLIFZERO',
    ]],
    [1, 2, ['ROUND', 'TRUNC', 'TRUNCATE', 'TO_DATE', 'TO_TIMESTAMP']],
    [1, 3, ['LAG', 'LEAD']],
    [2, 2, [
      'APPROX_PERCENTILE', 'NTH_VALUE', 'DATE_PART', 'DATE_TRUNC', 'TO_CHAR',
      'LEFT', 'RIGHT', 'CHARINDEX', 'CONTAINS', 'STARTSWITH', 'ENDSWITH', 'REGEXP_LIKE', 'REGEXP_EXTRACT',
      'REGEXP_COUNT', 'MOD', 'POWER', 'LOG', 'ATAN2', 'NULLIF', 'IFNULL', 'NVL',
    ]],
    [2, 3, ['SUBSTRING']],
    [3, 3, ['DATEADD', 'DATEDIFF', 'REPLACE', 'SPLIT_PART', 'REGEXP_REPLACE', 'IF', 'IFF', 'NVL2']],
    [1, Infinity, ['CONCAT', 'COALESCE', 'GREATEST', 'LEAST']],
  ] as [number, number, string[]][]).flatMap(([fewest, most, names]) => names.map(n => [n, [fewest, most]])),
]);

// The words before a parenthesis in an OSSIE_SQL_2026 text that name no
// function, or a construct of its own, such as CAST. AGG is reserved.
const OSSIE_WORDS = new Set([
  'AND', 'OR', 'NOT', 'IN', 'IS', 'LIKE', 'ILIKE', 'BETWEEN', 'CASE', 'WHEN', 'THEN', 'ELSE', 'OVER',
  'FILTER', 'GROUP', 'BY', 'AS', 'FROM', 'DISTINCT', 'WHERE', 'SELECT', 'EXISTS', 'ANY', 'ALL', 'SOME',
  'ARRAY', 'STRUCT', 'ROW', 'VALUES', 'INTERVAL', 'CAST', 'TRY_CAST', 'EXTRACT', 'POSITION', 'AGG',
]);

// `sql`, an OSSIE_SQL_2026 text, with each TIMESTAMP WITHOUT TIME ZONE as
// TIMESTAMP_NTZ. ANSI SQL:2003 defines that type as a date and a wall-clock
// time, which is Ossie's TIMESTAMP_NTZ and BigQuery's DATETIME, where the
// engine reads it as TIMESTAMP.
function wallClockTypes(engine: PolyglotEngine, sql: string): string {
  const tokens = engine.tokenize(sql, 'generic').tokens ?? [];
  const chars = [...sql];
  const spelled = (t: SqlToken|undefined) => t ? chars.slice(t.span.start, t.span.end).join('').toUpperCase() : '';
  for (let i = tokens.length - 4; i >= 0; i--) {
    if (tokens.slice(i, i + 4).map(spelled).join(' ') !== 'TIMESTAMP WITHOUT TIME ZONE') continue;
    // A comment between the words stays where it is.
    for (const t of tokens.slice(i + 1, i + 4).reverse()) chars.splice(t.span.start, t.span.end - t.span.start);
    chars.splice(tokens[i].span.start, tokens[i].span.end - tokens[i].span.start, ...'TIMESTAMP_NTZ');
  }
  return chars.join('');
}

// `sql`, an OSSIE_SQL_2026 text, as import gives it to the engine: as the
// parser reads it, with each TIMESTAMP_NTZ literal as a cast (see forParser),
// each TIMESTAMP WITHOUT TIME ZONE as TIMESTAMP_NTZ (see wallClockTypes), and
// each call outside OSSIE_CALLS, by name and number of arguments, with PASS
// before its name. A call whose arguments hold FROM or FOR, such as
// SUBSTRING(s FROM 1 FOR 2), keeps its name, so that the engine reads the
// construct and the checks name it.
function ossieText(engine: PolyglotEngine, sql: string): string {
  const text = forParser(wallClockTypes(engine, sql), 'OSSIE_SQL_2026');
  const tokens = engine.tokenize(text, 'generic').tokens ?? [];
  const chars = [...text];
  const written = (t: SqlToken) => chars.slice(t.span.start, t.span.end).join('');
  for (let i = tokens.length - 1; i >= 0; i--) {
    const [t, next] = [tokens[i], tokens[i + 1]];
    const word = written(t);
    const name = word.toUpperCase();
    const before = tokens[i - 1]?.token_type;
    if (next?.token_type !== 'L_PAREN' || !/^[A-Za-z_][\w$]*$/.test(word) || OSSIE_WORDS.has(name) ||
        before === 'DOT' || before === 'AS') {
      continue;
    }
    // The number of arguments: the commas outside parentheses, plus one.
    let [args, depth, keywords] = [tokens[i + 2]?.token_type === 'R_PAREN' ? 0 : 1, 0, false];
    for (let j = i + 2; j < tokens.length && depth >= 0; j++) {
      const type = tokens[j].token_type;
      depth += type === 'L_PAREN' ? 1 : type === 'R_PAREN' ? -1 : 0;
      if (type === 'COMMA' && depth === 0) args++;
      keywords ||= depth === 0 && (type === 'FROM' || type === 'FOR');
    }
    const [fewest, most] = OSSIE_CALLS[name] ?? [1, 0];
    if (!(keywords && OSSIE_CALLS[name]) && (args < fewest || args > most)) chars.splice(t.span.start, 0, ...PASS);
  }
  return chars.join('');
}

// The kinds of node import translates from an OSSIE_SQL_2026 text and checks
// every part of.
const OSSIE_KINDS = new Set([
  'annotated', 'column', 'dot', 'boolean', 'null', 'paren', 'neg', 'add', 'sub', 'mul', 'div', 'mod',
  'concat', 'eq', 'neq', 'lt', 'lte', 'gt', 'gte', 'and', 'or', 'not', 'between', 'in', 'is_null',
  'null_safe_eq', 'null_safe_neq', 'like', 'i_like', 'case', 'coalesce', 'nvl', 'nvl2', 'if_func', 'sum',
  'count', 'avg', 'min', 'max', 'abs', 'floor', 'ceil', 'sqrt', 'exp', 'ln', 'log', 'sin', 'cos', 'tan',
  'asin', 'acos', 'atan', 'atan2', 'radians', 'degrees', 'pi', 'mod_func', 'upper', 'lower', 'length',
  'trim', 'substring', 'str_position', 'contains', 'starts_with', 'ends_with', 'cast', 'try_cast',
  'extract', 'year', 'quarter', 'month', 'day', 'day_of_year', 'hour', 'minute', 'second', 'stddev',
  'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp', 'median', 'approx_count_distinct',
]);

// The kinds of aggregate in an OSSIE_SQL_2026 text that take FILTER, besides
// the aggregates by name such as APPROX_PERCENTILE.
const OSSIE_AGGREGATES = [
  'sum', 'count', 'avg', 'min', 'max', 'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp',
  'median', 'approx_count_distinct',
];

// BigQuery's name for each date part of EXTRACT and DATE_PART in an
// OSSIE_SQL_2026 text, by the part in lower case, and for the part of the
// functions such as YEAR(d), by kind without its underscores.
const OSSIE_PARTS = lookup({
  year: 'YEAR', quarter: 'QUARTER', month: 'MONTH', week: 'ISOWEEK', day: 'DAY', dayofweek: 'DAYOFWEEK',
  dayofyear: 'DAYOFYEAR', hour: 'HOUR', minute: 'MINUTE', second: 'SECOND', millisecond: 'MILLISECOND',
});

// Ossie's name for each part of EXTRACT and DATE_PART that other dialects
// name another way, by that name in lower case.
const OSSIE_PART_NAMES = lookup({dow: 'DAYOFWEEK, which counts Sunday as 1 in BigQuery', doy: 'DAYOFYEAR'});

// The construct `call`, EXTRACT or DATE_PART, with `part`, which is not one of
// Ossie's parts, for a message.
function ossiePart(call: string, part: string): string {
  const named = OSSIE_PART_NAMES[part.toLowerCase()];
  return `${call} with part '${part}'${named ? `, since Ossie names that part ${named}` : ''}`;
}

// BigQuery's name for each part of DATE_TRUNC in an OSSIE_SQL_2026 text.
const OSSIE_TRUNC = lookup({
  year: 'YEAR', quarter: 'QUARTER', month: 'MONTH', week: 'ISOWEEK', day: 'DAY', hour: 'HOUR',
  minute: 'MINUTE', second: 'SECOND',
});

// The parts of each date function of an OSSIE_SQL_2026 text, by the part in
// lower case. DATEDIFF takes the units of DATEADD.
const OSSIE_FUNCTION_PARTS: Record<string, Record<string, string>> = {
  DATE_PART: OSSIE_PARTS, DATE_TRUNC: OSSIE_TRUNC, DATEDIFF: DATE_TABLES.ossie.words,
};

// The functions of an OSSIE_SQL_2026 text with a format, which import
// translates only from a string, by the position of the format.
const OSSIE_FORMATS: Record<string, number> = {TO_CHAR: 1, TO_DATE: 1, TO_TIMESTAMP: 1};

// Ossie's core format tokens, longest first, with BigQuery's format element for
// each.
const FORMAT_TOKENS: [string, string][] = [
  ['MONTH', '%B'], ['YYYY', '%Y'], ['HH24', '%H'], ['HH12', '%I'], ['MON', '%b'], ['DAY', '%A'], ['YY', '%y'],
  ['MM', '%m'], ['DD', '%d'], ['DY', '%a'], ['HH', '%I'], ['MI', '%M'], ['SS', '%S'], ['AM', '%p'], ['PM', '%p'],
];

// The elements of a BigQuery format that write part of a date, and those that
// write part of a time of day.
const DATE_ELEMENTS = /%[YymbBdaA]/;
const TIME_ELEMENTS = /%[HIMSp]/;

// Whether `format`, a BigQuery format, holds one of `elements`.
function holds(format: string, elements: RegExp): boolean {
  return elements.test(format.replaceAll('%%', ''));
}

// `format`, an Ossie format, as a BigQuery format: each core token, in any
// letter case, as its element, each `%` doubled, and any other character as
// it is, which BigQuery copies.
function bigQueryFormat(format: string): string {
  let out = '';
  for (let i = 0; i < format.length;) {
    const token = FORMAT_TOKENS.find(([t]) => format.slice(i, i + t.length).toUpperCase() === t);
    out += token ? token[1] : format[i] === '%' ? '%%' : format[i];
    i += token ? token[0].length : 1;
  }
  return out;
}

// The parts of a node in an OSSIE_SQL_2026 text, by its kind, that are outside
// Ossie's grammar, each with its name for a message.
const OSSIE_AGGREGATE = {order_by: 'ORDER BY', ignore_nulls: 'IGNORE NULLS or RESPECT NULLS'};
const OSSIE_CLAUSES: Record<string, Record<string, string>> = {
  ...Object.fromEntries(OSSIE_AGGREGATES.map(k => [k, OSSIE_AGGREGATE])),
  in: {query: 'a subquery'}, between: {symmetric: 'SYMMETRIC'}, like: {escape: 'ESCAPE', quantifier: 'ANY or ALL'},
  i_like: {escape: 'ESCAPE', quantifier: 'ANY or ALL'}, trim: {characters: 'characters', position_explicit: 'BOTH, LEADING or TRAILING'},
  substring: {from_for_syntax: 'FROM or FOR'}, floor: {scale: 'a scale'}, ceil: {decimals: 'a scale'},
  cast: {format: 'FORMAT'}, try_cast: {format: 'FORMAT'},
};

// The types an OSSIE_SQL_2026 text casts to, by castType's name: VARCHAR and
// STRING, INTEGER, INT and BIGINT, DECIMAL and NUMERIC, FLOAT, DOUBLE, BOOLEAN,
// DATE, TIME, TIMESTAMP and TIMESTAMP_NTZ.
const OSSIE_CASTS = new Set([
  'var_char', 'string', 'int', 'big_int', 'decimal', 'float', 'double', 'boolean', 'date', 'time',
  'timestamp', 'TIMESTAMPNTZ',
]);

// The parts of a node of `kind` in an OSSIE_SQL_2026 text that import still
// has to check, the name of a construct in it import does not translate, or
// undefined when import does not translate the node.
function ossieNodes(kind: string, value: any): unknown[]|string|undefined {
  if (OSSIE_WINDOWED[kind]) return `${OSSIE_WINDOWED[kind][0]} without OVER`;
  if (value === null) return OSSIE_KINDS.has(kind) ? [] : undefined;
  const node = {[kind]: value};
  const nested = comparingKind(node, OSSIE_COMPARING) ? nestedComparison(node, 'ossie') : undefined;
  if (nested) return nested;
  if (kind === 'function') return ossieArgs(value);
  if (kind === 'literal') return ossieLiteral(value);
  if (kind === 'interval') return 'INTERVAL';
  if (kind === 'aggregate_function' || kind === 'within_group' || kind === 'filter') return ossiePercentile(kind, value);
  if (kind === 'window_function') return ossieWindow(value);
  if (!OSSIE_KINDS.has(kind)) return undefined;
  if (value.double_colon_syntax) return '::';
  const written = (c: string) => c === 'ignore_nulls' ? c in value :
      ![null, undefined, false].includes(value[c]) && value[c].length !== 0;
  const clause = Object.entries(OSSIE_CLAUSES[kind] ?? {}).find(([c]) => written(c));
  if (clause) return `${kind === 'i_like' ? 'ILIKE' : kind.toUpperCase()} with ${clause[1]}`;
  if (kind === 'cast' || kind === 'try_cast') {
    const problem = ossieCast(kind, value.to);
    return typeof problem === 'string' ? problem : [value.this];
  }
  const part = kind === 'extract' && String(partName(value.field));
  if (part && !OSSIE_PARTS[part.toLowerCase()]) return ossiePart('EXTRACT', part);
  return Object.values(value);
}

// The arguments of `fn`, a function call in an OSSIE_SQL_2026 text, that
// import still has to check, the name of a construct in it import does not
// translate, or undefined when import does not translate it.
function ossieArgs(fn: any): unknown[]|string|undefined {
  const name = String(fn.name).toUpperCase();
  const args: any[] = fn.args ?? [];
  if (name === 'AGG') return `${fn.name}, which Ossie reserves`;
  // A word without parentheses other than the current date and time is a
  // column, as in BigQuery. BigQuery also reads CURRENT_DATETIME so as its
  // function, which Ossie's tables do not hold.
  if (fn.no_parens) return name === 'CURRENT_DATETIME' ? fn.name : [];
  if (name.startsWith(PASS)) return args;
  const [fewest, most] = OSSIE_CALLS[name] ?? [1, 0];
  if (args.length < fewest || args.length > most) return undefined;
  // A date part is a string, such as 'month', or a word, such as month.
  const part = String(partName(args[0]) ?? '?');
  const parts = OSSIE_FUNCTION_PARTS[name];
  if (parts === OSSIE_PARTS && !parts[part.toLowerCase()]) return ossiePart(fn.name, part);
  const unit = parts?.[part.toLowerCase()];
  if (parts && !unit) return `${fn.name} with part '${part}'`;
  // A TIME has no date, so BigQuery's TIME_TRUNC and TIME_DIFF take an hour or
  // less.
  if (parts && parts !== OSSIE_PARTS && args.slice(1).some(isTime) && !SUB_DAY.includes(unit as Unit)) {
    return `${fn.name} with part '${part}' on a TIME`;
  }
  if (parts) return args.slice(1);
  if (name === 'DATEADD') {
    const sum = dateSum({function: fn}, 'ossie');
    return typeof sum === 'object' ? [sum.operand, sum.amount] : sum;
  }
  const format = args[OSSIE_FORMATS[name]];
  if (format && bare(format)?.literal?.literal_type !== 'string') {
    return `${fn.name} with a format that is not a string, whose tokens are known only when the query runs`;
  }
  // BigQuery's FORMAT_TIME writes a date element as it is, such as %Y.
  if (name === 'TO_CHAR' && isTime(args[0]) && holds(bigQueryFormat(String(bare(format).literal.value)), DATE_ELEMENTS)) {
    return `${fn.name} of a TIME with a date in its format, since a TIME has no date`;
  }
  return args;
}

// The parts of `value`, a literal in an OSSIE_SQL_2026 text, to check, which
// are none, or the name of a literal import does not translate. BigQuery
// reads a number with an exponent, such as 1e3, as a FLOAT64, as Ossie's
// approximate number. The repairs write a decimal number, and a whole number
// past INT64, as a NUMERIC or a BIGNUMERIC, which are exact, and no BigQuery
// type holds more than 38 digits before the point. Ossie's number has digits,
// a point and an exponent only, so a number the parser reads with another
// character, such as 1_000, is not translated.
function ossieLiteral(value: any): unknown[]|string {
  const type = value.literal_type;
  const number = /^(\d*)(\.\d*)?(e[+-]?\d+)?$/i.exec(type === 'number' ? value.value : '');
  if (type === 'number' && !number) return `the number ${value.value}`;
  if (number && !number[3] && (number[1].replace(/^0+/, '').length > 38 || (number[2]?.length ?? 0) > 39)) {
    return `the number ${value.value}`;
  }
  return ['string', 'number', 'date', 'time', 'timestamp'].includes(type) ? [] :
      `${article(type)} ${type.replaceAll('_', ' ')} literal`;
}

// The BigQuery type an OSSIE_SQL_2026 text casts to with `to`, an engine data
// type, as BigQuery SQL, undefined when the engine writes it, or a message.
// BigQuery's NUMERIC holds 29 digits before the point and 9 after it, and its
// BIGNUMERIC 38 and 38. DECIMAL and NUMERIC without a precision have a scale
// of 0, as in ANSI SQL:2003, Ossie's base, so they become NUMERIC(29), which
// rounds half away from zero.
function ossieCast(kind: string, to: any): string|{sql: string}|undefined {
  const type = castType(to);
  const name = `${kind === 'cast' ? 'CAST' : 'TRY_CAST'} to ${typeName(type, 'generic')}`;
  // The engine reads a negative size as 2^32 plus it.
  const [size, scale = 0] = [to.length ?? to.precision, to.scale].filter(n => n != null)
      .map(n => n >= 2 ** 31 ? n - 2 ** 32 : n);
  if (!OSSIE_CASTS.has(type)) return name;
  if (type === 'timestamp' && size === undefined) return {sql: 'TIMESTAMP'};
  if (type === 'decimal' && size === undefined) return {sql: 'NUMERIC(29)'};
  if (size === undefined) return undefined;
  const sized = `${size}${to.scale == null ? '' : `, ${scale}`}`;
  if (size < 1 || scale < 0) return `${name}(${sized})`;
  if (type === 'var_char' || type === 'string') return {sql: `STRING(${size})`};
  if (type === 'decimal' && scale <= size && scale <= 9 && size - scale <= 29) return {sql: `NUMERIC(${sized})`};
  if (type === 'decimal' && scale <= size && scale <= 38 && size - scale <= 38) return {sql: `BIGNUMERIC(${sized})`};
  return `${name}(${sized})`;
}

// BigQuery's SQL for TRY_CAST(_1 AS <type>) where `type`, as BigQuery SQL,
// has a length, precision or scale, such as STRING(3), or undefined for
// another type. Ossie's TRY_CAST gives NULL for a value that does not fit,
// where BigQuery's SAFE_CAST raises an error, and otherwise CAST's value. So
// a string is cast to STRING and checked by its length. A number is cast to
// the type's NUMERIC or BIGNUMERIC and rounded to the scale, half away from
// zero, as the cast to the type does: a NUMERIC holds 9 digits after the
// point and a BIGNUMERIC 38. That value is checked by its digits before the
// point and cast to the type. The check uses SAFE.ROUND and SAFE.ABS, which
// give NULL where BigQuery's ROUND and ABS raise an error: rounding past the
// largest NUMERIC or BIGNUMERIC, as for 99999999999999999999999999999.5, and
// the absolute value of the smallest BIGNUMERIC.
function fittedCast(type: string): string|undefined {
  const [, base, size, scale = '0'] = /^(STRING|NUMERIC|BIGNUMERIC)\((\d+)(?:, (\d+))?\)$/.exec(type) ?? [];
  if (!base) return undefined;
  const value = 'SAFE_CAST(_1 AS STRING)';
  if (base === 'STRING') return `IF(LENGTH(${value}) <= ${size}, CAST(${value} AS ${type}), NULL)`;
  const rounded = `ROUND(SAFE_CAST(_1 AS ${base}), ${scale})`;
  const digits = Number(size) - Number(scale);
  const bound = digits <= 18 ? `1${'0'.repeat(digits)}` : `CAST('1${'0'.repeat(digits)}' AS BIGNUMERIC)`;
  return `IF(SAFE.ABS(SAFE.${rounded}) < ${bound}, CAST(${rounded} AS ${type}), NULL)`;
}

// BigQuery's SQL for the functions of an OSSIE_SQL_2026 text that BigQuery
// names or computes another way, by name, with _1, _2 and so on for the
// arguments.
const OSSIE_CALL_FORMS: Record<string, string> = {
  ZEROIFNULL: 'COALESCE(_1, 0)', NULLIFZERO: 'NULLIF(_1, 0)', SPLIT_PART: 'SPLIT(_1, _2)[SAFE_ORDINAL(_3)]',
  CHARINDEX: 'INSTR(_2, _1)', REGEXP_COUNT: 'ARRAY_LENGTH(REGEXP_EXTRACT_ALL(_1, _2))',
};

// BigQuery's SQL for the nodes of an OSSIE_SQL_2026 text that BigQuery names or
// computes another way, by kind, with the parts that are its operands. π is
// ACOS(-1), which BigQuery gives as the FLOAT64 nearest π.
const OSSIE_FORMS: Record<string, [string, string[]]> = {
  mod: ['MOD(_1, _2)', ['left', 'right']], pi: ['ACOS(-1)', []],
  radians: ['(_1 * ACOS(-1) / 180)', ['this']], degrees: ['(_1 * 180 / ACOS(-1))', ['this']],
  contains: ['(INSTR(_1, _2) > 0)', ['this', 'expression']],
};

// The node to write in place of `node`, a node of an OSSIE_SQL_2026 text, with
// a FORM_CALL for each form it needs, or undefined to translate it as it is.
// A LIKE or ILIKE pattern reads each backslash as a character, which
// BigQuery's LIKE reads as one only when doubled. SUBSTRING(s, start, n)
// follows ANSI SQL:2003, Ossie's base: a start below 1 still ends the
// substring at start + n - 1, where BigQuery's SUBSTRING reads 0 as 1 and counts
// a negative start from the end. So a start that is not a whole number from
// 1 gets a form that starts at 1 and shortens n by the positions before 1.
// A negative n keeps BigQuery's error, as ANSI raises one. Without n, such a
// start gives the whole string, from position 1. The values that a
// comparison, IS [NOT] DISTINCT FROM, BETWEEN, IN or a CASE with an operand
// compares, and those that COALESCE, IFNULL, NVL, IF, CASE, GREATEST or LEAST
// gives, get the casts that ossieStamps gives. NULLIF(a, b) compares a and b
// with those casts and gives a, as ANSI SQL defines it, so a keeps its type.
function ossieForm(node: any): any {
  const kind = kindOf(node) ?? '';
  const value = node[kind];
  const name = String(value?.name).toUpperCase();
  if (kind === 'window_function') return windowForm(value);
  if (kind === 'within_group' || kind === 'filter' || kind === 'aggregate_function' || kind === 'median') {
    return percentileForm(node);
  }
  if (OSSIE_AGGREGATES.includes(kind) && value.filter) return filtered(node);
  const args: any[] = kind === 'function' ? value.args ?? [] : [];
  const nullif = name === 'NULLIF' && args.length === 2 ? ossieStamps(args) : undefined;
  if (nullif?.size) return formCall('IF(_1 = _2, NULL, _3)', [...args.map(a => nullif.get(a) ?? a), args[0]]);
  const stamps = new Map([
    ...ossieStamps(comparedValues(kind, value) ??
        (kind === 'null_safe_eq' || kind === 'null_safe_neq' ? [value.left, value.right] : [])),
    ...ossieStamps(name === 'GREATEST' || name === 'LEAST' ? args : returned(node)),
  ]);
  if (stamps.size) return swapped(node, stamps);
  if (kind === 'function' && OSSIE_CALL_FORMS[name]) return formCall(OSSIE_CALL_FORMS[name], value.args);
  if (kind === 'function') return ossieDateForm(name, args);
  const [sql, parts] = OSSIE_FORMS[kind] ?? [];
  if (sql) return formCall(sql, parts!.map(p => value[p]));
  const part = OSSIE_PARTS[kind === 'extract' ? String(partName(value.field)).toLowerCase() : kind.replaceAll('_', '')];
  if (part) return formCall(`EXTRACT(${part} FROM _1)`, [value.this]);
  if (kind === 'substring' && !/^0*[1-9]\d*$/.test(numberText(value.start) ?? '')) {
    return value.length ?
        formCall('SUBSTRING(_1, GREATEST(_2, 1), GREATEST(_3 - GREATEST(1 - _2, 0), LEAST(_3, 0)))',
            [value.this, value.start, value.length]) :
        formCall('SUBSTRING(_1, GREATEST(_2, 1))', [value.this, value.start]);
  }
  if (kind === 'literal' && value.literal_type === 'timestamp') {
    return formCall('CAST(_1 AS TIMESTAMP)', [{literal: {...value, literal_type: 'string'}}]);
  }
  const cast = (kind === 'cast' || kind === 'try_cast') && ossieCast(kind, value.to);
  const sized = typeof cast === 'object' && kind === 'try_cast' && fittedCast(cast.sql);
  if (sized) return formCall(sized, [value.this]);
  if (typeof cast === 'object') return formCall(`${kind === 'cast' ? 'CAST' : 'SAFE_CAST'}(_1 AS ${cast.sql})`, [value.this]);
  if (kind !== 'like' && kind !== 'i_like') return undefined;
  const pattern = bare(value.right)?.literal;
  const text = pattern?.literal_type === 'string' ? String(pattern.value) : undefined;
  const doubled = text?.includes('\\') ? {literal: {...pattern, value: text.replaceAll('\\', '\\\\')}} :
      pattern || bare(value.right)?.null !== undefined ? undefined : formCall("REPLACE(_1, '\\\\', '\\\\\\\\')", [value.right]);
  return doubled && {[kind]: {...value, right: doubled}};
}

// The FORM_CALL in place of each of `values`, by value, for the values that
// one node of an OSSIE_SQL_2026 text compares or gives. A value that is
// visibly a DATE or a DATETIME beside one that is visibly a TIMESTAMP is cast
// to TIMESTAMP, since BigQuery compares neither with a TIMESTAMP or gives
// both from one function. The cast reads a DATE at midnight and a DATETIME at
// its wall-clock time in BigQuery's default time zone, UTC, and BigQuery then
// works with TIMESTAMPs. A value whose type import cannot see, such as a
// column, stays as written.
function ossieStamps(values: any[]): Map<any, any> {
  const types = values.map(v => timeType(v, 'ossie'));
  const cast = types.includes('TIMESTAMP') ? values.filter((_, i) => types[i] === 'DATE' || types[i] === 'DATETIME') : [];
  return new Map(cast.map(v => [v, formCall('CAST(_1 AS TIMESTAMP)', [v])]));
}

// The FORM_CALL for a call of the date function `name` with `args` in an
// OSSIE_SQL_2026 text, or undefined for another function. DATEDIFF counts as
// BigQuery's DATE_DIFF does. DATE_DIFF counts no week, month, quarter or year
// between TIMESTAMPs, so unless both values are visibly DATEs or both
// DATETIMEs, it counts them between the values cast to DATETIME. That reads the
// wall-clock time of a TIMESTAMP in BigQuery's default time zone, UTC, as a
// month is added to one. For a day or less, a value beside one that is visibly
// a TIMESTAMP is cast to TIMESTAMP, as a comparison casts a DATE or a DATETIME
// (see ossieStamps), and DATE_DIFF counts between TIMESTAMPs. Otherwise a value
// that is visibly a DATE beside one that is not gets the casts to DATETIME for
// every part. That keeps the count for a DATE and a DATETIME, and counts the
// days to the date of a value whose type import cannot see.
// TO_CHAR formats a TIME with FORMAT_TIME, a
// TIMESTAMP in UTC, as FORMAT_TIMESTAMP does, and a DATE as itself where the
// format has no time of day. A value whose type import cannot see is
// formatted as its TIME() where the format has a time of day and no date.
// BigQuery's TIME() takes a DATE, a TIME, a DATETIME and a TIMESTAMP alike,
// and gives midnight for a DATE. With any other format, the value is
// formatted as the DATETIME it casts to, which BigQuery casts from a DATE, a
// DATETIME and a TIMESTAMP, as is any other value.
function ossieDateForm(name: string, args: any[]): any {
  const part = String(partName(args[0])).toLowerCase();
  if (name === 'DATE_PART') return formCall(`EXTRACT(${OSSIE_PARTS[part]} FROM _1)`, [args[1]]);
  if (name === 'DATE_TRUNC') return formCall(`${isTime(args[1]) ? 'TIME' : 'DATE'}_TRUNC(_1, ${OSSIE_TRUNC[part]})`, [args[1]]);
  const text = (value: string) => ({literal: {literal_type: 'string', value}});
  const format = name in OSSIE_FORMATS && args[1] ? bigQueryFormat(String(bare(args[1]).literal.value)) : undefined;
  if (name === 'DATEDIFF') {
    const unit = DATE_TABLES.ossie.words[part];
    if (args.slice(1).some(isTime)) return formCall(`TIME_DIFF(_2, _1, ${unit})`, args.slice(1));
    const types = new Set(args.slice(1).map(a => timeType(a, 'ossie')));
    const long = ['WEEK', 'MONTH', 'QUARTER', 'YEAR'].includes(unit);
    // DATE_DIFF takes no DATE or DATETIME beside a TIMESTAMP, so for a day or
    // less a value beside one that is visibly a TIMESTAMP is cast to TIMESTAMP.
    const instant = !long && types.has('TIMESTAMP') && types.size > 1;
    const stamped = !instant && ((types.has('DATE') && types.size > 1) ||
        (long && !(types.size === 1 && (types.has('DATE') || types.has('DATETIME')))));
    const own = (i: number) => timeType(args[i], 'ossie') === 'TIMESTAMP' ? `_${i}` : `CAST(_${i} AS TIMESTAMP)`;
    // A DATE plus no hours is its DATETIME, and a DATETIME or a TIMESTAMP plus
    // none is itself, so DATE_DIFF counts hours or less between DATEs too.
    const hours = !stamped && !instant && SUB_DAY.includes(unit) &&
        !(types.size === 1 && (types.has('DATETIME') || types.has('TIMESTAMP')));
    const [end, start] = stamped ? ['CAST(_2 AS DATETIME)', 'CAST(_1 AS DATETIME)'] : instant ? [own(2), own(1)] :
        hours ? ['_2 + INTERVAL 0 HOUR', '_1 + INTERVAL 0 HOUR'] : ['_2', '_1'];
    return formCall(`DATE_DIFF(${end}, ${start}, ${unit === 'WEEK' ? 'ISOWEEK' : unit})`, args.slice(1));
  }
  if (name === 'TO_DATE' || name === 'TO_TIMESTAMP') {
    const type = name === 'TO_DATE' ? 'DATE' : 'TIMESTAMP';
    return format === undefined ? formCall(`CAST(_1 AS ${type})`, [args[0]]) : formCall(`PARSE_${type}(_1, _2)`, [text(format), args[0]]);
  }
  if (name !== 'TO_CHAR') return undefined;
  const type = isTime(args[0]) ? 'TIME' : timeType(args[0], 'ossie');
  const sql = type === 'TIME' ? 'FORMAT_TIME(_1, _2)' : type === 'TIMESTAMP' ? 'FORMAT_TIMESTAMP(_1, _2)' :
      type === 'DATETIME' ? 'FORMAT_DATETIME(_1, _2)' :
      type === 'DATE' && !holds(format!, TIME_ELEMENTS) ? 'FORMAT_DATE(_1, _2)' :
      type === undefined && holds(format!, TIME_ELEMENTS) && !holds(format!, DATE_ELEMENTS) ?
      'FORMAT_TIME(_1, TIME(_2))' :
      'FORMAT_DATETIME(_1, CAST(_2 AS DATETIME))';
  return formCall(sql, [text(format!), args[0]]);
}

// Whether `node`, a value in an OSSIE_SQL_2026 text, is visibly a TIME: the
// current time, a TIME literal, a cast to TIME, a TIME plus an amount, its
// DATE_TRUNC, or a COALESCE, IF or CASE that gives one (see timeType).
function isTime(node: any): boolean {
  return timeType(node, 'ossie') === 'TIME';
}

// The parts of `value`, a node of `kind` in an OSSIE_SQL_2026 text that is an
// aggregate by name, WITHIN GROUP or the FILTER of WITHIN GROUP, that import
// still has to check, or the name of a construct in it import does not
// translate. PERCENTILE_CONT and PERCENTILE_DISC take WITHIN GROUP with one
// value, and they and APPROX_PERCENTILE a fraction from 0 to 1, which the
// forms write into their SQL. The forms write it as a NUMERIC or BIGNUMERIC,
// which holds 38 decimal places, and APPROX_PERCENTILE's form asks
// APPROX_QUANTILES for 10 to the power of its decimal places, which BigQuery
// runs up to 100000.
function ossiePercentile(kind: string, value: any): unknown[]|string|undefined {
  if (kind === 'filter') return bare(value.this)?.within_group ? [value.this, value.expression] : undefined;
  const fn = kind === 'within_group' ? bare(value.this)?.aggregate_function ?? bare(value.this)?.function : value;
  const name = String(fn?.name).toUpperCase();
  if (name.startsWith(PASS)) {
    return `${kind === 'within_group' ? 'WITHIN GROUP' : 'FILTER'} on ${fn.name}, a function outside Ossie's tables`;
  }
  const within = name === 'PERCENTILE_CONT' || name === 'PERCENTILE_DISC';
  if (within && kind !== 'within_group') return `${fn.name} without WITHIN GROUP`;
  if (!within && name !== 'APPROX_PERCENTILE' || within !== (kind === 'within_group')) return undefined;
  if (kind === 'within_group' && value.order_by.length !== 1) return `${fn.name} ordered by ${value.order_by.length} values`;
  const p = fraction(fn.args.at(-1));
  if (p === undefined) return `${fn.name} with a fraction that is not a number from 0 to 1`;
  const most = name === 'APPROX_PERCENTILE' ? 5 : 38;
  if ((/\.0$/.test(p) ? 0 : p.length - p.indexOf('.') - 1) > most) {
    return `${fn.name} with a fraction of more than ${most} decimal places, ${most === 5 ?
        "which needs more than 100000 quantiles in BigQuery's APPROX_QUANTILES" : 'more than a BigQuery BIGNUMERIC holds'}`;
  }
  return kind === 'within_group' ? [value.order_by[0].this] : [fn.args[0], fn.filter];
}

// The text of `node`, a number literal from 0 to 1, as a decimal number with
// a point and no zeros at the end of its fraction, such as 0.5 for 5e-1, or
// undefined for any other value. A point more than 39 places to the left
// counts as 39 places. That keeps the text short. A number other than zero
// then still has more than 38 decimal places, and zero gives 0.0. A point more
// than 39 places to the right counts as 40 places, so zero still gives 0.0.
function fraction(node: any): string|undefined {
  const text = bare(node)?.literal?.literal_type === 'number' ? String(bare(node).literal.value) : '';
  const match = /^(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!text || !match) return undefined;
  const [, whole = '', part = '', exponent = '0'] = match;
  // The number is `digits` with its point after `point` of them.
  const [digits, point] = [whole + part, Math.min(Math.max(whole.length + Number(exponent), -39), 40)];
  if (point > 39 && /[1-9]/.test(digits)) return undefined;
  const before = point <= 0 ? '0' : digits.slice(0, point).padEnd(point, '0').replace(/^0+(?=\d)/, '');
  const after = point <= 0 ? '0'.repeat(-point) + digits : digits.slice(point);
  return before === '0' || (before === '1' && !/[1-9]/.test(after)) ? `${before}.${after.replace(/0+$/, '') || '0'}` : undefined;
}

// BigQuery's SQL for the aggregates of an OSSIE_SQL_2026 text that BigQuery
// computes another way, by name, with _1 for the value, _2 for the fraction,
// {A} for the values in order and {C} for their count. PERCENTILE_CONT
// interpolates between the values at the floor and the ceiling of its
// position, the fraction times {C} - 1. Its difference divided by 1 is a
// FLOAT64 for INT64 values and a NUMERIC for NUMERIC values, which gives the
// type BigQuery's own PERCENTILE_CONT gives. PERCENTILE_DISC takes the first
// value whose position reaches the fraction times {C}.
const POSITION = '_2 * ({C} - 1)';
const PERCENTILE_FORMS: Record<string, string> = {
  MEDIAN: '({A}[SAFE_OFFSET(DIV({C} - 1, 2))] + {A}[SAFE_OFFSET(DIV({C}, 2))]) / 2',
  PERCENTILE_CONT: `{A}[SAFE_OFFSET(CAST(FLOOR(${POSITION}) AS INT64))] + ({A}[SAFE_OFFSET(CAST(CEIL(${POSITION}) ` +
      `AS INT64))] - {A}[SAFE_OFFSET(CAST(FLOOR(${POSITION}) AS INT64))]) / 1 * (${POSITION} - FLOOR(${POSITION}))`,
  PERCENTILE_DISC: '{A}[SAFE_OFFSET(GREATEST(CAST(CEIL(_2 * {C}) AS INT64), 1) - 1)]',
};

// The FORM_CALL for `node`, MEDIAN, APPROX_PERCENTILE, or PERCENTILE_CONT or
// PERCENTILE_DISC with WITHIN GROUP, in an OSSIE_SQL_2026 text, with any
// FILTER and DISTINCT it has. The values in order are ARRAY_AGG's, which skips
// NULL as the aggregate does. APPROX_PERCENTILE takes the quantile of
// APPROX_QUANTILES whose number of buckets, 100 or a power of 10, gives the
// fraction exactly.
function percentileForm(node: any): any {
  const kind = kindOf(node)!;
  const value = node[kind];
  const within = kind === 'filter' ? bare(value.this).within_group : kind === 'within_group' ? value : undefined;
  const fn = within ? bare(within.this).aggregate_function : kind === 'aggregate_function' ? value : undefined;
  const filter = kind === 'filter' ? value.expression : within ? undefined : value.filter;
  const x = within ? within.order_by[0].this : fn ? fn.args[0] : value.this;
  const operand = filter ? formCall('IF(_1, _2, NULL)', [filter, x]) : x;
  const distinct = (fn ?? value).distinct ? 'DISTINCT ' : '';
  const p = fn && fraction(fn.args.at(-1))!;
  const name = fn ? String(fn.name).toUpperCase() : 'MEDIAN';
  if (name === 'APPROX_PERCENTILE') {
    const [int, frac] = p!.split('.');
    const decimals = frac === '0' ? 0 : frac.length;
    const buckets = 10n ** BigInt(Math.max(2, decimals));
    const quantile = BigInt(int + (frac === '0' ? '' : frac)) * buckets / 10n ** BigInt(decimals);
    return formCall(`APPROX_QUANTILES(${distinct}_1, ${buckets})[SAFE_OFFSET(${quantile})]`, [operand]);
  }
  const values = `ARRAY_AGG(${distinct}_1 IGNORE NULLS ORDER BY _1${within?.order_by[0].desc ? ' DESC' : ''})`;
  const sql = PERCENTILE_FORMS[name].replaceAll('{A}', values).replaceAll('{C}', `COUNT(${distinct}_1)`);
  return formCall(sql, p ? [operand, {literal: {literal_type: 'number', value: p}}] : [operand]);
}

// `node`, an aggregate of an OSSIE_SQL_2026 text with FILTER (WHERE p), as the
// aggregate of IF(p, x, NULL), which gives the same value, since the
// aggregate skips NULL. COUNT(*) counts IF(p, 1, NULL).
function filtered(node: any): any {
  const kind = kindOf(node)!;
  const value = node[kind];
  const counted = value.star ? formCall('IF(_1, 1, NULL)', [value.filter]) :
      formCall('IF(_1, _2, NULL)', [value.filter, value.this]);
  return {[kind]: {...value, filter: null, this: counted, ...(value.star ? {star: false} : {})}};
}

// The functions an OSSIE_SQL_2026 text calls only with OVER, by kind, with
// the name of each and the parts that are its arguments.
const OSSIE_WINDOWED: Record<string, [string, string[]]> = {
  row_number: ['ROW_NUMBER', []], rank: ['RANK', []], dense_rank: ['DENSE_RANK', []],
  percent_rank: ['PERCENT_RANK', []], cume_dist: ['CUME_DIST', []], n_tile: ['NTILE', ['num_buckets']],
  lag: ['LAG', ['this', 'offset', 'default']], lead: ['LEAD', ['this', 'offset', 'default']],
  first_value: ['FIRST_VALUE', ['this']], last_value: ['LAST_VALUE', ['this']], nth_value: ['NTH_VALUE', ['this', 'offset']],
};

// The parts of `value`, a window function in an OSSIE_SQL_2026 text, that
// import still has to check, the name of a construct in it import does not
// translate, or undefined when import does not translate it. The function is
// one of OSSIE_WINDOWED, an aggregate, or a function outside Ossie's tables.
// BigQuery computes MEDIAN and the percentiles over a window with its own
// PERCENTILE_CONT and PERCENTILE_DISC, which order the values ascending, take
// no DISTINCT, and take a window with neither ORDER BY nor a frame. BigQuery
// has no approximate aggregate over a window. Ossie's frame is ROWS or RANGE
// with one or two bounds, and BigQuery takes only a number or a parameter as
// a bound's offset.
function ossieWindow(value: any): unknown[]|string|undefined {
  const fn = value.this;
  const kind = kindOf(fn)!;
  const {window_name: named, partition_by: partitions, order_by: items, frame} = value.over;
  if (named) return 'OVER with a window name';
  if (frame?.kind === 'Groups' || frame?.exclude) return `OVER with ${frame.exclude ? 'EXCLUDE' : 'GROUPS'}`;
  const bounds = [frame?.start, frame?.end].flatMap(b => b && typeof b === 'object' ? Object.values(b) : []);
  const offset = bounds.find(b => bare(b)?.literal?.literal_type !== 'number');
  if (offset) {
    const sql = withoutEngineMessages(() => loadedSqlEngine()!.generate([offset], 'generic')).sql?.[0];
    return `OVER with the frame offset ${sql}, since BigQuery takes only a number there`;
  }
  const parts = [...partitions, ...items.map((o: any) => o.this), ...bounds];
  const windowed = OSSIE_WINDOWED[kind];
  if (windowed && fn[kind]?.ignore_nulls) return `${windowed[0]} with IGNORE NULLS`;
  if (windowed) return [...windowed[1].map(p => fn[kind][p]).filter(p => p), ...parts];
  const within = kind === 'filter' ? bare(fn.filter.this).within_group : fn.within_group;
  const name = String((within ? bare(within.this).aggregate_function : fn[kind])?.name).toUpperCase();
  if (name.startsWith('APPROX_')) return `${name} with OVER, since BigQuery has no approximate aggregate over a window`;
  if (['MEDIAN', 'PERCENTILE_CONT', 'PERCENTILE_DISC'].includes(name) && (items.length || frame)) {
    return `${name} with ORDER BY or a frame in OVER, since BigQuery has no percentile over an ordered window or a frame`;
  }
  const distinct = name === 'MEDIAN' ? fn.median.distinct : within && bare(within.this).aggregate_function?.distinct;
  if (['MEDIAN', 'PERCENTILE_CONT', 'PERCENTILE_DISC'].includes(name) && distinct) {
    const own = name === 'PERCENTILE_DISC' ? name : 'PERCENTILE_CONT';
    return `${name} with DISTINCT and OVER, since BigQuery's ${own} over a window takes no DISTINCT`;
  }
  if (name === 'PERCENTILE_DISC' && within?.order_by[0]?.desc) {
    return "PERCENTILE_DISC with DESC and OVER, since BigQuery's PERCENTILE_DISC over a window orders values ascending";
  }
  const passed = kind === 'function' && name.startsWith(PASS);
  return passed || within || OSSIE_AGGREGATES.includes(kind) || kind === 'aggregate_function' ? [fn, ...parts] : undefined;
}

// The functions that write the NULL placement of a window's ORDER BY item
// into its value in the text the engine translates, NULLS FIRST and NULLS
// LAST, since the engine drops the clause when it translates generic SQL.
// repairNode writes the clause in its place.
const NULLS_CALLS = ['KCMD_NULLS_FIRST', 'KCMD_NULLS_LAST'];

// The window functions that take no frame.
const FRAMELESS = new Set(['row_number', 'rank', 'dense_rank', 'percent_rank', 'cume_dist', 'n_tile', 'lag', 'lead']);

// `value`, a window function in an OSSIE_SQL_2026 text, with each ORDER BY
// item placing NULL as Ossie does. An item without NULLS FIRST or NULLS LAST
// places NULL as the largest value: last for ASC and first for DESC. BigQuery
// takes NULLS FIRST and NULLS LAST, which import writes with a call of
// NULLS_CALLS, only in a window function without a frame and in a ROWS frame.
// It refuses the one it does not place NULL by in a RANGE frame, which is also
// the frame an aggregate or another function gets with ORDER BY and no frame.
// There, an item is sorted first by whether it is NULL, as in `x IS NULL, x`,
// which leaves the same rows equal. A RANGE frame with an offset, such as 2
// PRECEDING, takes one item, so the item is negated and sorted the other way,
// as `-x DESC` for `x ASC NULLS LAST`, which frames the same rows and places
// NULL as BigQuery's DESC does. MEDIAN and the percentiles become BigQuery's
// PERCENTILE_CONT and PERCENTILE_DISC, the fraction of a descending
// PERCENTILE_CONT taken from 1. PERCENTILE_CONT reads x / 1 and a NUMERIC
// fraction, which gives a FLOAT64 for INT64 values and a NUMERIC for NUMERIC
// values, the type of MEDIAN and PERCENTILE_CONT without OVER. RESPECT NULLS
// is the default in ANSI SQL and in BigQuery, whose LAG and LEAD take none, so
// it is left out.
function windowForm(value: any): any {
  const call = sqlExpressionTree(`${NULLS_CALLS[0]}(x)`, 'BIGQUERY').function;
  const fn = value.this;
  const kind = kindOf(fn)!;
  const frame = value.over.frame;
  const ranged = frame ? frame.kind === 'Range' : !FRAMELESS.has(kind);
  const offset = [frame?.start, frame?.end].some(b => b && typeof b === 'object');
  const items = value.over.order_by.flatMap((o: any) => {
    const first = o.nulls_first ?? !!o.desc;
    if (!ranged) return [{...o, nulls_first: null, this: {function: {...call, name: NULLS_CALLS[first ? 0 : 1], args: [o.this]}}}];
    const item = {...o, nulls_first: null};
    // BigQuery places NULL first for ASC and last for DESC.
    if (first !== !!o.desc) return [item];
    if (offset) return [{...item, desc: !o.desc, explicit_asc: false, this: formCall('-_1', [o.this])}];
    return [{...item, this: formCall('_1 IS NULL', [o.this])}, item];
  });
  const within = kind === 'filter' ? bare(fn.filter.this).within_group : fn.within_group;
  const filter = kind === 'filter' ? fn.filter.expression : fn.median?.filter;
  let percentile;
  if (within || kind === 'median') {
    const x = within ? within.order_by[0].this : fn.median.this;
    const aggregate = within && bare(within.this).aggregate_function;
    const p = aggregate ? fraction(aggregate.args[0])! : '0.5';
    const [int, frac] = p.split('.');
    const scale = 10n ** BigInt(frac.length);
    const desc = within?.order_by[0].desc ? scale - BigInt(int + frac) : BigInt(int + frac);
    const [whole, part] = [String(desc / scale), String(desc % scale).padStart(frac.length, '0')];
    const name = aggregate ? String(aggregate.name).toUpperCase() : 'PERCENTILE_CONT';
    const operand = filter ? formCall('IF(_1, _2, NULL)', [filter, x]) : x;
    // The repairs write the fraction as a NUMERIC or a BIGNUMERIC, which both
    // functions take, so it keeps every digit.
    const share = {literal: {literal_type: 'number', value: `${whole}.${part}`}};
    percentile = formCall(name === 'PERCENTILE_CONT' ? 'PERCENTILE_CONT(_1 / 1, _2)' : `${name}(_1, _2)`, [operand, share]);
  }
  const respected = OSSIE_WINDOWED[kind] && fn[kind]?.ignore_nulls === false ? {[kind]: {...fn[kind], ignore_nulls: null}} : fn;
  return {window_function: {...value, this: percentile ?? respected, over: {...value.over, order_by: items}}};
}
