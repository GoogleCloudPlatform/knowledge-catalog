// Letting a judge read the store it is judging against.
//
// A rule stated in words divides into two kinds. One kind is about the call and
// nothing else -- *the memo must name a specific service failure* -- and the
// request carries everything needed to settle it. The other kind compares the
// call against what is already recorded -- *a credit cannot exceed the total of
// the order it credits* -- and nothing the caller states can settle that,
// because the order's total is in the database and the caller does not have to
// be honest about it.
//
// This builds the second kind a place to look. It is composed from the semantic
// model under its binding profile, so what a judge can see is exactly the
// tables and columns the model declares and the profile binds. An entity the
// model does not declare is not in the schema the judge is shown and not in the
// database as far as the judge is concerned.
//
// Against letting a model write SQL there are two objections, and each gets an
// answer rather than a promise.
//
// The first is that a model could write something that is not a read. Three
// things stop it. A statement carrying more than one command is refused before
// it is sent. A statement that does not begin with SELECT or WITH is refused
// before it is sent. And what IS sent is the statement wrapped as a subquery of
// a SELECT, so the server rejects anything that is not a query -- which is what
// catches the case a keyword check does not, PostgreSQL's data-modifying common
// table expression, legal at the top level of a statement and illegal inside a
// subquery. Only the third of these is a guarantee; the first two are there to
// turn a server error into a sentence the judge can act on.
//
// The second objection is prompt injection: the caller writes the memo, the
// memo reaches the judge, and the judge writes the SQL. The fence in gemini.ts
// marks caller-written text as data, and the wrapping above bounds what a
// judge convinced by it could do to one read of the tables it was already shown.
//
// What none of this fixes is timing. A judge reads before the transaction
// opens, so two concurrent calls can each read the same total and each pass.
// A rule a query can settle belongs in an `expression`, evaluated where the
// write happens; settling one here buys the ability to state it in words and
// pays for it in exactly that race.

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
 * A store a judge may read, composed from one runtime's bindings.
 *
 * Fails rather than returning a store that reads nothing: a judge handed a
 * tool that refuses every call spends its reads finding that out, and the
 * caller who could have been told at setup time is the one who can fix it.
 */
export function modelJudgeStore(
    runtime: SemanticRuntime,
    options: JudgeStoreOptions = {}): JudgeStore|{error: string} {
  const client = runtimeClient(runtime);
  if ('error' in client) return {error: client.error};

  const dialect = dialectFor(runtime.store);
  const readable = readableEntities(runtime, dialect);
  if (!readable.length) {
    return {
      error: `No entity of '${runtime.model.name}' is bound to a table under ` +
          `profile '${runtime.profile}', so a judge would have nothing to read.`,
    };
  }

  const rowLimit = options.rowLimit ?? DEFAULT_ROW_LIMIT;
  const cellLimit = options.cellLimit ?? DEFAULT_CELL_LIMIT;

  return {
    schema: schemaText(readable, dialect),
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
        columns = (res.result?.metadata?.rowType?.fields ?? [])
                      .map(field => field?.name ?? '');
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


/** An entity a judge can be told about: one table, and the columns behind it. */
interface ReadableEntity {
  entity: Entity;
  table: string;
  fields: BoundField[];
}


// The same test the lookup tools apply, for the same reason: an abstract
// entity has no table, a field bound to an expression is not a column, and a
// data source that is not a table reference cannot be read from.
function readableEntities(
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
function schemaText(
    readable: ReadableEntity[], dialect: SqlDialect): string {
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
 * One statement, and a query. Returns the statement to wrap, or why it will
 * not be sent.
 *
 * Exported for the tests, which are the only reason to look at this in
 * isolation: what it refuses is the part worth pinning down.
 */
export function readOnly(sql: string): {sql: string}|{problem: string} {
  const blanked = blankOpaque(sql);
  const semicolon = blanked.indexOf(';');
  if (semicolon !== -1 && blanked.slice(semicolon + 1).trim()) {
    return {
      problem: 'That is more than one statement. Send one read; run a second ' +
          'one as a second call.',
    };
  }
  const body = semicolon === -1 ? sql : sql.slice(0, semicolon);
  const first = (semicolon === -1 ? blanked : blanked.slice(0, semicolon))
                    .trim()
                    .split(/[\s(]+/)[0] ??
      '';
  if (!/^(select|with)$/i.test(first)) {
    return {
      problem: `A read begins with SELECT or WITH; this one begins with '${
          first || 'nothing'}'. This store is read-only.`,
    };
  }
  return {sql: body};
}


// `sql` with the contents of every comment and every quoted run replaced by
// spaces, so that the structure of the statement can be read off it. Positions
// are preserved, which is what lets a caller index back into the original.
//
// Written here rather than borrowed because the two dialects quote differently
// and this has to be right for both: PostgreSQL nests block comments and has
// dollar quoting, GoogleSQL has backticked identifiers, and both double a quote
// to escape it. Where the two disagree the more suspicious reading wins, since
// the consequence of reading a run as quoted is a refusal and the consequence
// of reading a quoted run as code is nothing -- the statement is still wrapped.
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
    if (ch === '-' && sql[i + 1] === '-') {
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
