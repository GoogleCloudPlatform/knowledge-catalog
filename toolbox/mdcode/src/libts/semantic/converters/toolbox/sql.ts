// Reading a Toolbox tool's statement.
//
// A Toolbox configuration names no tables. Every noun in it -- the tables, the
// columns, the joins between them -- is inside the `statement` string of some
// tool, which is why a config can be a complete description of what an agent
// may call while saying nothing about what the data IS. Recovering those nouns
// is the whole of what makes an import possible, so it lives here, apart from
// the mapping policy in to_ir.ts.
//
// The engine is @polyglot-sql/sdk, already a dependency (transpile.ts uses it
// to move an imported vendor expression onto GoogleSQL). Two of its surfaces
// are used, for two different jobs, because neither one does both:
//
//   - `analyzeQuery` resolves a SELECT's projections back to the tables they
//     came from, so an aliased `c.name` is known to be `customers.name`. It
//     refuses anything that is not a SELECT or a set operation.
//   - `parse` returns the AST for any statement, which is where a DML
//     statement's target table and touched columns are, and where a SELECT's
//     join conditions are. `analyzeQuery` reports which tables a query reads
//     but not which columns it joins them on, and the join columns are exactly
//     what a relationship needs.
//
// Parameters are the third job. A Toolbox statement uses its dialect's own
// placeholder and binds the tool's `parameters` list to them POSITIONALLY; a
// kcmd `sql` executor names them (`@customer_id`) and validate.ts requires
// every name to be a declared parameter. So a statement is rewritten in the
// AST -- replacing the nth placeholder with the nth parameter's name -- and
// regenerated, rather than patched with a regex that cannot tell a `$1` in a
// string literal from one in a predicate.

import {analyzeQuery, generate, parse} from '@polyglot-sql/sdk';

/**
 * A table a statement reads or writes, as the statement spells it.
 *
 * `name` is the reference verbatim (`public.accounts`, `` `proj.ds.orders` ``),
 * which is what an entity's `source` wants; `table` is its final segment, which
 * is what an entity is NAMED after. They differ whenever the statement
 * qualifies the table, and both are needed, so neither is derived at the call
 * site.
 */
export interface TableRef {
  name: string;
  table: string;
  alias?: string;
}

/** One equality that joins two tables, as written in an ON clause. */
export interface JoinFact {
  left: {table: string; column: string};
  right: {table: string; column: string};
}

/** What a SELECT reads. */
export interface ReadFacts {
  kind: 'read';
  tables: TableRef[];
  /** Columns attributed to a table, deduplicated. */
  columns: Array<{table: string; column: string}>;
  joins: JoinFact[];
}

/**
 * What a DML statement writes.
 *
 * `fields` is the columns the statement names: an INSERT's column list, an
 * UPDATE's SET targets. A DELETE names none, which is not a gap -- it takes the
 * whole row, and an `affects` entry with `operation: delete` may carry no
 * fields (validate.ts rejects that pairing).
 */
export interface WriteFacts {
  kind: 'write';
  operation: 'create'|'modify'|'delete';
  table: TableRef;
  fields: string[];
  /**
   * Columns the statement's predicates read, which are not part of the blast
   * radius.
   */
  readColumns: string[];
}

/** A statement this module could not read. */
export interface UnknownFacts {
  kind: 'unknown';
  reason: string;
}

export type StatementFacts = ReadFacts|WriteFacts|UnknownFacts;

// The @polyglot-sql/sdk dialect for a Toolbox source type. The SDK's vocabulary
// is its own (`postgresql`, not `postgres`), and it has no Spanner: Spanner's
// GoogleSQL is close enough to BigQuery's for the three things read here (table
// names, column names, join equalities) that parsing it as `bigquery` recovers
// them, and a Spanner PostgreSQL-dialect database is a PostgreSQL one. Anything
// unrecognized falls back to `generic` rather than failing, because a statement
// that parses generically still yields its tables.
const DIALECTS: ReadonlyMap<string, string> = new Map([
  ['postgres', 'postgresql'],
  ['alloydb-postgres', 'postgresql'],
  ['cloud-sql-postgres', 'postgresql'],
  ['postgresql', 'postgresql'],
  ['mysql', 'mysql'],
  ['cloud-sql-mysql', 'mysql'],
  ['tidb', 'tidb'],
  ['bigquery', 'bigquery'],
  ['spanner', 'bigquery'],
  ['sqlite', 'sqlite'],
  ['clickhouse', 'clickhouse'],
  ['trino', 'trino'],
  ['redshift', 'redshift'],
  ['snowflake', 'snowflake'],
  ['mssql', 'tsql'],
  ['cloud-sql-mssql', 'tsql'],
  ['oracle', 'oracle'],
]);

/** The SQL dialect to parse a source type's statements in. */
export function dialectForSource(sourceType: string|undefined): string {
  return DIALECTS.get((sourceType ?? '').toLowerCase()) ?? 'generic';
}

/**
 * Reads what a statement touches.
 *
 * Returns `unknown` rather than throwing on a statement that will not parse: a
 * config holds many tools, and one unreadable statement should cost that tool,
 * not the import.
 */
export function statementFacts(sql: string, dialect: string): StatementFacts {
  const parsed = parseOne(sql, dialect);
  if (!parsed.ok) return {kind: 'unknown', reason: parsed.reason};
  const stmt = parsed.stmt;

  for (const [key, operation] of [
           ['insert', 'create'], ['update', 'modify'], ['delete', 'delete']] as
       const) {
    if (stmt[key]) return writeFacts(stmt[key], operation);
  }
  if (stmt['select'] || stmt['union'] || stmt['except'] || stmt['intersect']) {
    return readFacts(sql, dialect, stmt);
  }
  return {
    kind: 'unknown',
    reason: `statement is a ${
        Object.keys(stmt)[0] ??
        'form'} the importer does not read; only SELECT, INSERT, UPDATE and DELETE are mapped`,
  };
}

// --- Reads -------------------------------------------------------------------

function readFacts(sql: string, dialect: string, stmt: any): ReadFacts {
  const tables = new Map<string, TableRef>();
  // Keyed by table and column together. A Map rather than a Set of joined
  // strings because there is no separator a SQL identifier cannot contain.
  const columns = new Map<string, {table: string; column: string}>();
  const addColumn = (table: string, column: string) =>
      columns.set(JSON.stringify([table, column]), {table, column});

  // `analyzeQuery` is the authority on which table a projected column came
  // from: it has resolved the aliases, so `c.name` and a bare `name` both
  // arrive attributed. It only handles SELECT and set operations, which is why
  // the AST walk below still runs -- it is what covers the joins, and it is the
  // fallback when analysis fails on a shape the analyzer does not accept.
  const analyzed = analyzeQuery(sql, dialect);
  if (analyzed.success && analyzed.analysis) {
    for (const t of analyzed.analysis.baseTables) {
      const ref = tableRefOf(t.name, t.alias ?? undefined);
      if (ref) tables.set(ref.name, ref);
    }
    for (const p of analyzed.analysis.projections ?? []) {
      for (const up of p.upstream ?? []) {
        if (up.table && up.column) addColumn(up.table, up.column);
      }
    }
  }

  // Every table the AST mentions, so a table joined but never projected from is
  // still an entity, and the alias map the joins are resolved through is
  // complete.
  const aliases = new Map<string, string>();
  for (const t of walkTables(stmt)) {
    const ref = tableRefOf(t.name, t.alias);
    if (!ref) continue;
    tables.set(ref.name, ref);
    if (ref.alias) aliases.set(ref.alias, ref.name);
    aliases.set(ref.table, ref.name);
    aliases.set(ref.name, ref.name);
  }

  const joins: JoinFact[] = [];
  for (const j of walkJoins(stmt)) {
    for (const eq of equalities(j.on)) {
      const left = qualifiedColumn(eq.left, aliases);
      const right = qualifiedColumn(eq.right, aliases);
      // A join equality with an unqualified side cannot be attributed to a
      // table, and guessing which side owns it would invent an edge. Drop it.
      if (!left || !right || left.table === right.table) continue;
      joins.push({left, right});
      addColumn(left.table, left.column);
      addColumn(right.table, right.column);
    }
  }

  // Every other column the statement mentions. A predicate column is evidence
  // of a column exactly as a projected one is -- `WHERE name ILIKE $1` is the
  // whole reason the tool exists -- and `SELECT *` projects nothing the
  // analyzer can name, so a search tool would otherwise contribute a table with
  // no fields at all. An unqualified column is attributed only when the
  // statement reads one table, because then there is nothing to attribute it to
  // but that table.
  const single = tables.size === 1 ? [...tables.values()][0].name : undefined;
  for (const ref of walkColumnRefs(stmt)) {
    const table = ref.qualifier ? aliases.get(ref.qualifier) : single;
    if (table) addColumn(table, ref.name);
  }

  return {
    kind: 'read',
    tables: [...tables.values()],
    columns: [...columns.values()],
    joins,
  };
}

// --- Writes ------------------------------------------------------------------

function writeFacts(
    node: any, operation: 'create'|'modify'|'delete'): WriteFacts {
  const table = tableRefOf(qualifiedTableName(node.table), aliasOf(node.table));
  const fields: string[] = [];
  if (operation === 'create') {
    for (const c of node.columns ?? []) {
      const name = identifier(c);
      if (name) fields.push(name);
    }
  } else if (operation === 'modify') {
    // `set` is a list of [target, value] pairs; the target is the column.
    for (const pair of node.set ?? []) {
      const name = identifier(Array.isArray(pair) ? pair[0] : pair);
      if (name) fields.push(name);
    }
  }
  const readColumns = [...new Set(walkColumnNames(node.where_clause))];
  return {
    kind: 'write',
    operation,
    table: table ?? {name: '', table: ''},
    fields: [...new Set(fields)],
    readColumns,
  };
}

// --- Parameters --------------------------------------------------------------

/** The outcome of rewriting a statement's placeholders to named parameters. */
export interface RewriteResult {
  /** The statement with every placeholder replaced by `@name`. */
  sql: string;
  /** The parameter names actually bound, in the order they appear. */
  bound: string[];
  /** Why the rewrite was not total, if it was not. */
  warnings: string[];
}

/**
 * Rewrites a Toolbox statement's placeholders into the `@name` form a kcmd
 * `sql` executor requires.
 *
 * Toolbox binds a tool's `parameters` list to the statement's placeholders in
 * order, so the nth placeholder takes the nth parameter's name. Three
 * placeholder spellings reach here and they do not parse alike:
 *
 *   - `$1` (PostgreSQL) parses as a parameter node CARRYING its index, so it is
 *     matched by index and an out-of-order `$2 ... $1` is still correct.
 *   - `?` (MySQL) parses as a placeholder node with no index, so it is matched
 *     by position in traversal order -- which is the same rule the server uses.
 *   - `@name` (GoogleSQL) does not parse as a parameter at all; it arrives as a
 *     column whose name begins with `@`. It is also already the form kcmd
 *     wants, so it is left alone, and it is why this function is a no-op on a
 *     BigQuery or Spanner statement rather than an error.
 */
export function rewriteParameters(
    sql: string, dialect: string, parameterNames: string[]): RewriteResult {
  const parsed = parseOne(sql, dialect);
  if (!parsed.ok) {
    return {sql, bound: [], warnings: [`could not parse: ${parsed.reason}`]};
  }

  const warnings: string[] = [];
  const bound: string[] = [];
  let positional = 0;
  let rewrote = false;

  const nameFor = (index: number): string|undefined => {
    const name = parameterNames[index];
    if (name === undefined) {
      warnings.push(`placeholder #${index + 1} has no declared parameter`);
      return undefined;
    }
    return name;
  };

  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.parameter && typeof node.parameter === 'object') {
      const p = node.parameter;
      if (p.name == null && p.index != null) {
        const name = nameFor(p.index - 1);
        if (name !== undefined) {
          p.name = name;
          p.index = null;
          p.style = 'At';
          bound.push(name);
          rewrote = true;
        }
      } else if (p.name != null) {
        // `:name` (or an already-named parameter): keep the author's name and
        // only change the sigil, so the statement still names its own inputs.
        if (p.style !== 'At') {
          p.style = 'At';
          rewrote = true;
        }
        bound.push(p.name);
      }
      return;
    }
    if (node.placeholder && typeof node.placeholder === 'object') {
      const name = nameFor(positional++);
      if (name !== undefined) {
        // A `?` has no slot for a name, so it becomes a named parameter node.
        delete node.placeholder;
        node.parameter = {
          name,
          index: null,
          style: 'At',
          quoted: false,
          string_quoted: false,
          expression: null,
        };
        bound.push(name);
        rewrote = true;
      }
      return;
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value))
        value.forEach(visit);
      else
        visit(value);
    }
  };
  visit(parsed.ast);

  if (!rewrote) return {sql, bound, warnings};

  const generated: any = generate(parsed.ast, dialect as any);
  if (!generated.success || !generated.sql?.length) {
    return {
      sql,
      bound: [],
      warnings: [`could not re-render the statement: ${
          generated.error ?? 'unknown error'}`],
    };
  }
  return {sql: generated.sql.join('; '), bound, warnings};
}

// --- AST helpers -------------------------------------------------------------

function parseOne(
    sql: string, dialect: string): {ok: true; ast: any; stmt: any}|{
  ok: false;
  reason: string
}
{
  let parsed: any;
  try {
    parsed = parse(sql, dialect as any);
  } catch (err: any) {
    return {ok: false, reason: err?.message ?? String(err)};
  }
  if (!parsed?.success) {
    return {ok: false, reason: String(parsed?.error ?? 'parse failed')};
  }
  const statements: any[] = parsed.ast ?? [];
  if (statements.length !== 1) {
    return {
      ok: false,
      reason: `expected one statement, found ${statements.length}`,
    };
  }
  return {ok: true, ast: parsed.ast, stmt: statements[0]};
}

// A table reference as this module reports it, or undefined when the node named
// nothing.
function tableRefOf(name: string|undefined, alias?: string): TableRef|
    undefined {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split('.').filter((p) => p.length > 0);
  const table = (parts.pop() ?? trimmed).replace(/^[`"[]|[`"\]]$/g, '');
  return {name: trimmed, table, alias};
}

// A table node's qualified name (`catalog.schema.table`, as far as it is
// spelled).
function qualifiedTableName(node: any): string|undefined {
  if (!node) return undefined;
  const parts = [
    identifier(node.catalog), identifier(node.schema), identifier(node.name)
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join('.') : undefined;
}

function aliasOf(node: any): string|undefined {
  return identifier(node?.alias);
}

// The text of an identifier node (`{name, quoted}`) or a bare string.
function identifier(node: any): string|undefined {
  if (node == null) return undefined;
  if (typeof node === 'string') return node;
  if (typeof node.name === 'string') return node.name;
  if (node.name && typeof node.name === 'object') return identifier(node.name);
  return undefined;
}

// Every table node anywhere under `node`.
//
// A column reference carries its qualifier in a `table` field of exactly the
// same shape as a real table node -- `c.name` parses to
// `{column: {table: {name: 'c'}, name: {name: 'name'}}}` -- so a walk that
// looked everywhere would report the ALIAS `c` as a table of its own, invent an
// entity for it, and then resolve the joins against that instead of against
// `customers`. The qualifier is not a table reference; it is a reference to
// one. So the walk does not descend into a column.
function* walkTables(node: any): Generator<{name?: string; alias?: string}> {
  if (!node || typeof node !== 'object') return;
  if (node.table && typeof node.table === 'object' && node.table.name) {
    yield {name: qualifiedTableName(node.table), alias: aliasOf(node.table)};
  }
  for (const [key, value] of Object.entries(node)) {
    if (key === 'column' || key === 'columns') continue;
    if (Array.isArray(value)) {
      for (const item of value) yield* walkTables(item);
    } else {
      yield* walkTables(value);
    }
  }
}

// Every join node anywhere under `node`.
function* walkJoins(node: any): Generator<any> {
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'joins' && Array.isArray(value)) {
      for (const join of value) yield join;
    }
    if (Array.isArray(value)) {
      for (const item of value) yield* walkJoins(item);
    } else {
      yield* walkJoins(value);
    }
  }
}

// The equality comparisons in an ON clause, so `ON a.x = b.x AND a.y = b.y`
// yields both rather than only the outermost node.
function* equalities(node: any): Generator<{left: any; right: any}> {
  if (!node || typeof node !== 'object') return;
  if (node.eq) {
    yield {left: node.eq.left, right: node.eq.right};
    return;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) yield* equalities(item);
    } else {
      yield* equalities(value);
    }
  }
}

// A column node resolved through the alias map, or undefined when it names no
// table.
function qualifiedColumn(node: any, aliases: Map<string, string>):
    {table: string; column: string}|undefined {
  const column = node?.column;
  if (!column) return undefined;
  const name = identifier(column.name);
  const qualifier = identifier(column.table);
  if (!name || !qualifier) return undefined;
  const table = aliases.get(qualifier) ?? qualifier;
  return {table, column: name};
}

// Every column reference under `node`, carrying its qualifier when it has one.
function*
    walkColumnRefs(node: any): Generator<{qualifier?: string; name: string}> {
  if (!node || typeof node !== 'object') return;
  if (node.column) {
    const name = identifier(node.column.name);
    if (name) yield {qualifier: identifier(node.column.table), name};
    return;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) yield* walkColumnRefs(item);
    } else {
      yield* walkColumnRefs(value);
    }
  }
}

// The bare column names under `node`, used for an UPDATE's or DELETE's
// predicates.
function* walkColumnNames(node: any): Generator<string> {
  if (!node || typeof node !== 'object') return;
  if (node.column) {
    const name = identifier(node.column.name);
    if (name) yield name;
    return;
  }
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) yield* walkColumnNames(item);
    } else {
      yield* walkColumnNames(value);
    }
  }
}
