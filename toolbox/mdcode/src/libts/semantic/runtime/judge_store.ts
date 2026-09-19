// The database a judge may read while it settles a guard.
//
// `modelJudgeStore` builds the `JudgeStore` that judge.ts declares and
// gcp/gemini.ts consumes. A run creates one when it is given
// `--judge-reads-store`, and it holds two things:
//
//   1. SCHEMA. A block of text naming the tables and columns the judge may
//      use, which the caller puts in the model's instructions. It is composed
//      from the semantic model under its binding profile, so an entity the
//      model does not declare is absent from it, and absent from the database
//      as far as the judge is concerned.
//   2. READ. One method, which the model reaches as a tool call. It takes a
//      statement the model wrote and gives back rows as text.
//
// Everything else here serves one of those two. `readableEntities` and
// `schemaText` compose the first; `readOnly` and `blankOpaque` decide what may
// reach the second.
//
// A guard wants one of these because a rule stated in words divides into two
// kinds. One kind is about the call and nothing else -- *the memo must name a
// specific service failure* -- and the request carries everything needed to
// settle it. The other kind compares the call against what is already recorded
// -- *a credit cannot exceed the total of the order it credits* -- and nothing
// the caller states can settle that, because the order's total is in the
// database and the caller does not have to be honest about it. The second kind
// is what this file gives somewhere to look.
//
// `read` does three things to a statement, in this order:
//
//   1. CHECK. `readOnly` refuses anything that is not a single command
//      beginning with SELECT or WITH. `blankOpaque` blanks comments and quoted
//      runs first, so that a `;` inside a memo cannot pass for a second
//      command.
//   2. WRAP AND SEND. What survives goes to the store as
//      `SELECT * FROM (<the statement>) AS judge_read LIMIT 21`.
//   3. CAP. At most `rowLimit` rows come back and each value is clipped to
//      `cellLimit` characters -- twenty and two hundred, unless the caller
//      sets otherwise -- and the judge is told when either cap bit.
//
// Of those three, the second is the one that makes a read a read. Wrapping the
// statement as a subquery makes the server reject anything that is not a query,
// which catches
// what a keyword check cannot: PostgreSQL accepts a data-modifying common table
// expression at the top level of a statement and refuses one inside a subquery.
// The other two steps are there to turn a server error into a sentence the
// judge can act on. Where the wrap stops short is a query calling a function
// that writes, which is still a query, so the server runs it; AlloyDB sends
// statements outside any transaction this client opened and PostgreSQL commits
// what it wraps implicitly, so such a call would take effect. Spanner's query
// path is read-only and has no such opening.
//
// Assume a judge can be talked into writing a statement the caller chose: the
// caller writes the memo, the memo reaches the judge, and the judge writes the
// SQL. The fence in gemini.ts marks caller-written text as data. Past that,
// what limits the damage is how little can come out -- a few reads, one query
// each, twenty rows apiece, two hundred characters per value. What is NOT
// limited is which tables a statement names. The schema says which tables the
// model declares and no check holds a statement to it, so a read reaches
// whatever the credentials behind the action reach, and rows it returns can be
// quoted back in the reason the verdict gives.
//
// None of this fixes timing. A judge reads before the transaction opens, so two
// concurrent calls can each read the same total and each pass. A rule that has
// to hold under concurrency belongs where the write happens: compute it in the
// store and let the guard read the answer. Settling one here buys the ability
// to state it in words and pays for it in that race.

import {boundTable} from '../binding';
import {Entity} from '../ir';

import {BoundField, boundFields} from './agent_tools';
import {dialectFor, SqlDialect} from './dialect';
import {JudgeQueryResult, JudgeStore} from './judge';
import {runtimeClient, SemanticRuntime} from './runtime';


/** Rows returned to a judge from one read. */
const DEFAULT_ROW_LIMIT = 20;


/** Characters kept per value. Long enough for a memo, short of a document. */
const DEFAULT_CELL_LIMIT = 200;


/** How much a judge may read, and who gets told that it read. */
export interface JudgeStoreOptions {
  /** Rows returned per read, before truncation is reported. */
  rowLimit?: number;
  /** Characters kept per value. */
  cellLimit?: number;
  /**
   * Called with every statement, before it is sent. A judge that reads the
   * store has done something on the caller's behalf that the caller should be
   * able to see, and this is how a transcript shows it.
   */
  onRead?: (sql: string) => void;
}


/**
 * The store to hand a `Judge`: the schema text its instructions carry, and the
 * `read` its tool calls land on.
 *
 * Composed from one runtime, so the tables are the ones that runtime's profile
 * binds, and a judge's reads go to the database the write would go to.
 *
 * Returns an error rather than a store that reads nothing. A judge handed a
 * tool that refuses every call spends its reads finding that out, and the
 * caller who could have been told at setup time is the one who can fix it.
 */
export function modelJudgeStore(
    runtime: SemanticRuntime, options: JudgeStoreOptions = {}): JudgeStore|{
  error: string
}
{
  const client = runtimeClient(runtime);
  if ('error' in client) return {error: client.error};

  const dialect = dialectFor(runtime.store);
  const readable = readableEntities(runtime, dialect);
  if (!readable.length) {
    return {
      error: `No entity of '${runtime.model.name}' is bound to a table under ` +
          `profile '${
                 runtime.profile}', so a judge would have nothing to read.`,
    };
  }

  const rowLimit = options.rowLimit ?? DEFAULT_ROW_LIMIT;
  const cellLimit = options.cellLimit ?? DEFAULT_CELL_LIMIT;

  return {
    schema: schemaText(readable, dialect),
    // Check, wrap and send, cap: the three steps the header lists. A problem
    // at any of them comes back as `problem` on an otherwise empty result,
    // because the model reads this and is expected to try again.
    async read(sql: string): Promise<JudgeQueryResult> {
      const empty = {columns: [], rows: [], truncated: false};
      const checked = readOnly(sql);
      if ('problem' in checked) return {...empty, problem: checked.problem};

      // The statement as a subquery, on its own lines so that a trailing line
      // comment ends where the author meant it to. The extra row is how "there
      // are more" is told from "that is all".
      const wrapped = `SELECT * FROM (\n${checked.sql}\n) AS judge_read LIMIT ${
          rowLimit + 1}`;
      options.onRead?.(checked.sql);

      let rows: Array<Array<string|null>>;
      let columns: string[];
      try {
        const res = await client.withSession(
            sessionName => client.executeQuery(sessionName, {sql: wrapped}));
        if (res.status < 200 || res.status >= 300) {
          return {...empty, problem: res.message ?? `${res.status}`};
        }
        rows = res.result?.rows ?? [];
        columns = (res.result?.metadata?.rowType?.fields ??
                   []).map(field => field?.name ?? '');
      } catch (err) {
        return {
          ...empty,
          problem: err instanceof Error ? err.message : String(err),
        };
      }

      return {
        // Reported only when there is one per column. A partial list read
        // positionally is worse than none, and not every backend supplies them.
        columns: columns.length === (rows[0]?.length ?? columns.length) ?
            columns :
            [],
        rows: rows.slice(0, rowLimit)
                  .map(row => row.map(value => clip(value, cellLimit))),
        truncated: rows.length > rowLimit,
      };
    },
  };
}


/**
 * An entity a judge can be told about: one table, and the columns behind it.
 */
export interface ReadableEntity {
  entity: Entity;
  table: string;
  fields: BoundField[];
}


/**
 * What a judge would be shown under this runtime: one entry per entity the
 * model declares, the profile binds to a table, and a statement can name.
 *
 * The same test the lookup tools apply, for the same reason: an abstract
 * entity has no table, a field bound to an expression is not a column, and a
 * data source that is not a table reference cannot be read from. Exported so
 * that `action list` can tell whether offering a reading judge would work
 * before it prints a command line suggesting one.
 */
export function readableEntities(
    runtime: SemanticRuntime, dialect: SqlDialect): ReadableEntity[] {
  const readable: ReadableEntity[] = [];
  for (const entity of runtime.model.entities ?? []) {
    if (entity.abstract) continue;
    const fields = boundFields(entity);
    if (!fields.length) continue;
    const warnings: string[] = [];
    const table =
        boundTable(entity.dataSource, warnings, entity.name, dialect.quote);
    if (warnings.length) continue;
    readable.push({entity, table, fields});
  }
  return readable;
}


// The schema, written for a model to read. Physical names lead, because those
// are what a statement has to contain; the model's own name for each one
// follows, because the rule the judge is applying is written in those.
function schemaText(readable: ReadableEntity[], dialect: SqlDialect): string {
  const lines = [
    `Write ${dialect.name}. These tables are the whole of what you may read.`,
  ];
  for (const {entity, table, fields} of readable) {
    lines.push('');
    const said = entity.description?.trim();
    lines.push(`${entity.name}${said ? `: ${oneLine(said)}` : ''}`);
    lines.push(`  table ${table}`);
    for (const field of fields) {
      const says = field.description?.trim();
      lines.push(`    ${dialect.quote(field.column)} is ${entity.name}.${
          field.name}, ${field.type}${says ? `. ${oneLine(says)}` : ''}`);
    }
  }
  return lines.join('\n');
}


function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ');
}


function clip(value: string|null, limit: number): string|null {
  if (value === null || value.length <= limit) return value;
  return `${value.slice(0, limit)}...`;
}


/**
 * Step 1 of `read`: decide whether a statement the model wrote may be sent.
 *
 * Passes it only if it is one command and that command is a query. Returns the
 * statement to wrap, with any trailing semicolon removed, or a sentence saying
 * why it will not be sent -- which the model is shown, so it says what to do
 * instead rather than only what went wrong.
 *
 * Exported for the tests, which are the only reason to look at this in
 * isolation: what it refuses is the part worth pinning down.
 */
export function readOnly(sql: string): {sql: string}|{
  problem: string
}
{
  const blanked = blankOpaque(sql);
  const semicolon = blanked.indexOf(';');
  if (semicolon !== -1 && blanked.slice(semicolon + 1).trim()) {
    return {
      problem: 'That is more than one statement. Send one read; run a second ' +
          'one as a second call.',
    };
  }
  const body = semicolon === -1 ? sql : sql.slice(0, semicolon);
  // Leading parentheses come off first, because a union of two reads is written
  // `(SELECT ...) UNION ALL (SELECT ...)`, and the keyword is matched as a
  // prefix rather than as a whole token, because `SELECT*FROM t` is a read as
  // well. Both were refused by an earlier form of this check, and a refusal the
  // judge can do nothing about spends one of the few reads it is allowed.
  const head = (semicolon === -1 ? blanked : blanked.slice(0, semicolon))
                   .replace(/^[\s(]+/, '');
  if (!/^(select|with)\b/i.test(head)) {
    const first = head.split(/\s+/)[0] ?? '';
    return {
      problem: `A read begins with SELECT or WITH; this one begins with '${
          first || 'nothing'}'. This store is read-only.`,
    };
  }
  return {sql: body};
}


// `sql` with the contents of every comment and every quoted run replaced by
// spaces, so that the structure of the statement can be read off it: after
// this, a `;` or a keyword in the result is one the SQL parser would see too.
// Positions are preserved, which is what lets a caller index back into the
// original.
//
// Written here rather than borrowed because the two dialects quote differently
// and this has to be right for both: PostgreSQL nests block comments and has
// dollar quoting, GoogleSQL has backticked identifiers and a `#` line comment,
// and both double a quote to escape it. Where the two disagree the more
// suspicious reading wins, since the consequence of reading a run as quoted is
// a refusal and the consequence of reading a quoted run as code is nothing --
// the statement is still wrapped.
function blankOpaque(sql: string): string {
  const out = sql.split('');
  const blank = (from: number, to: number) => {
    for (let k = Math.max(from, 0); k < Math.min(to, out.length); k++) {
      if (out[k] !== '\n') out[k] = ' ';
    }
  };
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    // `--` in both dialects, `#` in GoogleSQL. Missing the second one costs
    // more than a comment: an apostrophe inside an unrecognised `#` comment
    // opens a quoted run that blanks the rest of the statement, and a semicolon
    // after it stops being visible to the single-statement check below.
    if ((ch === '-' && sql[i + 1] === '-') || ch === '#') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      let depth = 1;
      let k = i + 2;
      while (k < sql.length && depth > 0) {
        if (sql[k] === '/' && sql[k + 1] === '*') {
          depth++;
          k += 2;
        } else if (sql[k] === '*' && sql[k + 1] === '/') {
          depth--;
          k += 2;
        } else {
          k++;
        }
      }
      blank(i, k);
      i = k;
      continue;
    }
    if (ch === `'` || ch === '"' || ch === '`') {
      let k = i + 1;
      let close = -1;
      while (k < sql.length) {
        if (sql[k] === ch) {
          // A doubled quote is an escaped one and the run continues.
          if (sql[k + 1] === ch) {
            k += 2;
            continue;
          }
          close = k;
          break;
        }
        k++;
      }
      blank(i + 1, close === -1 ? sql.length : close);
      i = close === -1 ? sql.length : close + 1;
      continue;
    }
    if (ch === '$') {
      const tag = /^\$([A-Za-z_]\w*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        blank(i, stop);
        i = stop;
        continue;
      }
    }
    i++;
  }
  return out.join('');
}
