// Quoting for GoogleSQL identifiers emitted into generated graph DDL, plus
// dialect-aware SQL action statement scanners (`referencedParameters` and
// `leadingDmlVerb`).
//
// The graph generator (./graph_ddl) lowers logical names -- entity and
// relationship labels, property names, key columns -- into identifier
// positions of a `CREATE OR REPLACE PROPERTY GRAPH` statement. A name that is a
// GoogleSQL RESERVED KEYWORD (e.g. an entity named `Order`) is a valid model
// name but, emitted bare as `... AS Order`, makes the DDL a syntax error
// ("Unexpected keyword ORDER"). Backticking it (`... AS `Order``) is always
// safe, so these helpers quote a name exactly when it would otherwise be
// misread. Both BigQuery and Spanner Graph share the GoogleSQL grammar, so one
// reserved set serves both.

// The GoogleSQL reserved keywords. A reserved keyword may not appear as an
// identifier unless quoted. Non-reserved keywords are deliberately absent: they
// are legal bare identifiers, so quoting them would churn existing output for no
// reason. That absence extends to the graph-DDL CONTEXTUAL keywords (KEY, VALUE,
// SOURCE, DESTINATION, LABEL, NODE, EDGE, PROPERTIES, MEASURE): they are
// keywords only inside a CREATE PROPERTY GRAPH clause, and BigQuery accepts them
// bare in every identifier position -- alias, property, KEY/SOURCE
// KEY/DESTINATION KEY column, and REFERENCES label (verified live 2026-08-30).
// Kept uppercase; lookups uppercase first.
//
// Source of truth: the GoogleSQL reserved-keyword lists published for BigQuery
// and Spanner (their lexical-structure docs). This set is their UNION so one
// table serves both engines: the two lists differ only in QUALIFY (BigQuery
// reserves it; Spanner does not, and over-quoting it on Spanner is harmless),
// and both reserve GRAPH_TABLE. NOTE: the @polyglot-sql/sdk transpiler is
// deliberately NOT the oracle -- its reserved set diverges from BigQuery's in
// both directions (misses EXTRACT, over-quotes user/view/column), so delegating
// would emit incorrect DDL. See sql_identifiers.test.ts.
const RESERVED_KEYWORDS = new Set<string>([
  'ALL',
  'AND',
  'ANY',
  'ARRAY',
  'AS',
  'ASC',
  'ASSERT_ROWS_MODIFIED',
  'AT',
  'BETWEEN',
  'BY',
  'CASE',
  'CAST',
  'COLLATE',
  'CONTAINS',
  'CREATE',
  'CROSS',
  'CUBE',
  'CURRENT',
  'DEFAULT',
  'DEFINE',
  'DESC',
  'DISTINCT',
  'ELSE',
  'END',
  'ENUM',
  'ESCAPE',
  'EXCEPT',
  'EXCLUDE',
  'EXISTS',
  'EXTRACT',
  'FALSE',
  'FETCH',
  'FOLLOWING',
  'FOR',
  'FROM',
  'FULL',
  'GRAPH_TABLE',
  'GROUP',
  'GROUPING',
  'GROUPS',
  'HASH',
  'HAVING',
  'IF',
  'IGNORE',
  'IN',
  'INNER',
  'INTERSECT',
  'INTERVAL',
  'INTO',
  'IS',
  'JOIN',
  'LATERAL',
  'LEFT',
  'LIKE',
  'LIMIT',
  'LOOKUP',
  'MERGE',
  'NATURAL',
  'NEW',
  'NO',
  'NOT',
  'NULL',
  'NULLS',
  'OF',
  'ON',
  'OR',
  'ORDER',
  'OUTER',
  'OVER',
  'PARTITION',
  'PRECEDING',
  'PROTO',
  'QUALIFY',
  'RANGE',
  'RECURSIVE',
  'RESPECT',
  'RIGHT',
  'ROLLUP',
  'ROWS',
  'SELECT',
  'SET',
  'SOME',
  'STRUCT',
  'TABLESAMPLE',
  'THEN',
  'TO',
  'TREAT',
  'TRUE',
  'UNBOUNDED',
  'UNION',
  'UNNEST',
  'USING',
  'WHEN',
  'WHERE',
  'WINDOW',
  'WITH',
  'WITHIN',
]);

// A bare (unquoted) GoogleSQL identifier: a letter or underscore followed by
// letters, digits, or underscores. Anything else (a hyphen, a dot, a leading
// digit) must be quoted to appear as an identifier.
export function isSimpleIdentifier(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
}

// Whether `name` is a GoogleSQL reserved keyword (case-insensitive), and so
// cannot appear as a bare identifier.
export function isReservedKeyword(name: string): boolean {
  return RESERVED_KEYWORDS.has(name.toUpperCase());
}

// Backticks `name`, escaping any embedded backtick.
function backtick(name: string): string {
  return `\`${name.replace(/`/g, '\\`')}\``;
}

// Quotes a name that would otherwise be MISREAD as a bare identifier: a simple
// identifier is left bare unless it is a reserved keyword; anything non-simple
// (a hyphen, a dot, a leading digit) is backticked. Use for a full identifier
// token -- a table or graph name.
export function quoteIdentifier(name: string): string {
  if (isSimpleIdentifier(name)) {
    return isReservedKeyword(name) ? backtick(name) : name;
  }
  return backtick(name);
}

// Quotes ONLY a simple identifier that collides with a reserved keyword, and
// passes everything else through unchanged. Use at identifier positions whose
// input is expected to be a simple name already (an alias, a label reference, a
// key column): a non-simple value there is a separate error the generators
// detect and warn about, so this must not rewrite it. A non-reserved name is
// returned byte-for-byte, so existing output is unaffected.
export function quoteIfReserved(name: string): string {
  return isSimpleIdentifier(name) && isReservedKeyword(name) ? backtick(name) :
                                                               name;
}

// The reserved keywords that are values. SQL that is one of them alone, such as
// a field bound to `TRUE`, is that value, not a column of that name.
const VALUE_KEYWORDS = new Set<string>(['TRUE', 'FALSE', 'NULL']);

// Quotes SQL that is a lone reserved keyword, which a field binding reads as
// the column of that name, as in `order`. TRUE, FALSE and NULL stay bare, since
// both engines read a backticked word as a column name. Use on the SQL a field
// binds to, where quoteIfReserved would turn such a value into a column.
export function quoteColumnIfReserved(sql: string): string {
  return VALUE_KEYWORDS.has(sql.toUpperCase()) ? sql : quoteIfReserved(sql);
}


const DOLLAR_QUOTE_TAG =
    /\$(?:[A-Za-z_\x80-\uffff][A-Za-z0-9_\x80-\uffff]*)?\$/y;
const QUOTE_CONTINUE =
    /^[ \t\f]*(?:--[^\n\r]*)?[\n\r](?:[ \t\n\r\f\v]|--[^\n\r]*[\n\r])*'/;

function endOfLineComment(text: string, from: number): number {
  let i = from;
  while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
  return i;
}

function endOfBlockComment(
    text: string, from: number, nested: boolean): number {
  if (!nested) {
    const end = text.indexOf('*/', from + 2);
    return end < 0 ? text.length : end + 2;
  }
  let depth = 1;
  let i = from + 2;
  while (i < text.length && depth > 0) {
    if (text[i] === '/' && text[i + 1] === '*') {
      depth++;
      i += 2;
    } else if (text[i] === '*' && text[i + 1] === '/') {
      depth--;
      i += 2;
    } else {
      i++;
    }
  }
  return i;
}

function endOfQuoted(
    text: string, from: number, backslashEscapes: boolean,
    doubledQuotes: boolean): number {
  const quote = text[from];
  for (let i = from + 1; i < text.length; i++) {
    if (backslashEscapes && text[i] === '\\') {
      i++;
    } else if (text[i] === quote) {
      if (doubledQuotes && text[i + 1] === quote) {
        i++;
        continue;
      }
      return i + 1;
    }
  }
  return text.length;
}

function endOfTripleQuoted(text: string, from: number): number {
  const quote = text[from];
  for (let i = from + 3; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
    } else if (
        text[i] === quote && text[i + 1] === quote && text[i + 2] === quote) {
      return i + 3;
    }
  }
  return text.length;
}

// One dialect for each way sqlCode reads a statement: SPANNER for GoogleSQL,
// which it reads for every dialect but POSTGRES and ALLOYDB, and POSTGRES for
// PostgreSQL.
export const SQL_CODE_DIALECTS = ['SPANNER', 'POSTGRES'] as const;

// Whether a statement in `dialect` is read as PostgreSQL. Any other is read as
// GoogleSQL.
function readsPostgres(dialect?: string|null): boolean {
  return dialect === 'POSTGRES' || dialect === 'ALLOYDB';
}

// `text` with each comment and each quoted string or identifier replaced by a
// space, read as GoogleSQL by default or as PostgreSQL when `dialect` is
// `POSTGRES` or `ALLOYDB` (where `#` stays an operator such as `#>` or `#-`).
// With `quotedNames`, a GoogleSQL identifier quoted in backticks is kept.
function sqlCode(
    text: string, dialect?: string|null, quotedNames = false): string {
  const postgres = readsPostgres(dialect);
  const identCont =
      postgres ? /[A-Za-z0-9_$\x80-\uffff]/ : /[A-Za-z0-9_\x80-\uffff]/;
  let out = '';
  let start = 0;
  const skip = (from: number, to: number): number => {
    out += `${text.slice(start, from)} `;
    start = to;
    return to - 1;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      i = skip(i, endOfLineComment(text, i + 2));
    } else if (!postgres && c === '#') {
      i = skip(i, endOfLineComment(text, i + 1));
    } else if (c === '/' && text[i + 1] === '*') {
      i = skip(i, endOfBlockComment(text, i, postgres));
    } else if (
        !postgres && (c === '\'' || c === '"') && text[i + 1] === c &&
        text[i + 2] === c) {
      i = skip(i, endOfTripleQuoted(text, i));
    } else if (c === '\'' || c === '"') {
      i = skip(i, endOfQuoted(text, i, !postgres, postgres));
    } else if (!postgres && c === '`') {
      const end = endOfQuoted(text, i, true, false);
      i = quotedNames ? end - 1 : skip(i, end);
    } else if (postgres && c === '$') {
      DOLLAR_QUOTE_TAG.lastIndex = i;
      const m = DOLLAR_QUOTE_TAG.exec(text);
      if (m) {
        const end = text.indexOf(m[0], i + m[0].length);
        i = skip(i, end < 0 ? text.length : end + m[0].length);
      }
    } else if (/[A-Za-z_\x80-\uffff]/.test(c)) {
      let j = i + 1;
      while (j < text.length && identCont.test(text[j])) j++;
      if (postgres && j === i + 1 && (c === 'e' || c === 'E') &&
          text[j] === '\'') {
        let end = endOfQuoted(text, j, true, true);
        // A string continued on a later line keeps E's backslash escapes.
        for (let m; (m = QUOTE_CONTINUE.exec(text.slice(end)));) {
          end = endOfQuoted(text, end + m[0].length - 1, true, true);
        }
        i = skip(i, end);
      } else {
        i = j - 1;
      }
    }
  }
  return start === 0 ? text : out + text.slice(start);
}

// A GoogleSQL parameter: `@`, any spaces or comments, and a name, which may be
// quoted in backticks. An identifier quoted elsewhere is matched whole, so an
// `@` inside it is not read.
const GOOGLE_SQL_PARAMETER =
    /`(?:[^`\\]|\\.)*`?|@@+|@\s*(?:([A-Za-z_]\w*)|`((?:[^`\\]|\\.)*)`)/g;
// A PostgreSQL parameter: `@` and a name, with nothing between them.
const POSTGRES_PARAMETER = /@@+|@([A-Za-z_]\w*)/g;

// The distinct `@name` references in a SQL statement, ignoring comments and
// quoted strings or identifiers so prose or a literal containing an '@' is not
// read as a binding. `#` starts a line comment in GoogleSQL (the default), and
// stays an operator (`#>`, `#-`) on PostgreSQL/AlloyDB. GoogleSQL also reads
// `@ name` and `` @`name` `` as the parameter `name`. Used to check that every
// parameter a statement reads is one the caller will bind, and to bind only
// the parameters a statement actually reads.
export function referencedParameters(
    text: string, dialect?: string|null): string[] {
  const googleSql = !readsPostgres(dialect);
  const names = new Set<string>();
  for (const m of sqlCode(text, dialect, googleSql)
           .matchAll(googleSql ? GOOGLE_SQL_PARAMETER : POSTGRES_PARAMETER)) {
    const name = m[1] ?? m[2];
    if (name) names.add(name);
  }
  return [...names];
}


// The DML verb a statement leads with, or '' when none can be read.
//
// Reading the first six characters is not enough: a statement opening with a
// `--` comment, or with a `WITH` clause ahead of its UPDATE, reports a verb
// that is not the statement's. So this walks `sqlCode(sql, dialect)` instead,
// skipping comments, quoted strings or identifiers, and anything nested in
// parentheses, and returns the first DML keyword left standing at the top
// level. For `WITH x AS (SELECT ...) UPDATE ...` that is the UPDATE, because
// the CTE body is inside parentheses; for `UPDATE t SET note = 'DELETE'` it is
// the UPDATE, because the literal is not read as a keyword.
//
// In GoogleSQL (the default), `#` is skipped as a line comment alongside `--`,
// while on PostgreSQL/AlloyDB `#` stays an operator (such as `#>` or `#>>` in a
// leading CTE).
//
// It lives here, rather than beside the one caller that refuses a zero-row
// write, because validation reads the same statements to decide what a model
// may PUBLISH. Two readers meant the library accepted an authored `sql`
// executor -- a leading comment, a CTE -- that `kcmd push` and `kcmd action
// run` then refused before the runtime ever saw it. The verb SET stays wider
// than what an executor may declare: MERGE is read so a caller can be told a
// MERGE matched nothing, and rejected at publish time by SQL_EXECUTOR_VERBS,
// which does not list it.
//
// WHAT A MISREAD COSTS runs one way only, and it is worth knowing which. Since
// noRowMatched refuses everything except a recognized INSERT, failing to read a
// verb cannot hide a write that did nothing -- it can only refuse one that was
// fine. The expensive direction is therefore a real INSERT this misses, and the
// cheap direction is anything else it cannot parse. That is deliberate: a false
// refusal is a failed run someone looks at, and a missed refusal is a caller
// told its write landed when it did not.
//
// This is a scanner, not a parser, and the repo does bundle a real one
// (`@polyglot-sql/sdk`, used by transpile.ts and sql_identifiers.ts). It is not
// used here because it has no Spanner dialect and action DML targets Spanner
// and AlloyDB, so it would have to parse Spanner statements as something else
// and would reject valid ones. Given which direction a misread now falls, a
// scanner that recognizes a leading INSERT is enough; if that stops being true,
// the parser is the thing to reach for rather than more cases here.
export function leadingDmlVerb(sql: string, dialect?: string|null): string {
  const verbs = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);
  const code = sqlCode(sql, dialect);
  let depth = 0;
  for (let i = 0; i < code.length; i++) {
    const c = code[i];
    if (c === '(') {
      depth++;
    } else if (c === ')') {
      if (depth > 0) depth--;
    } else if (depth === 0 && /[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < code.length && /[A-Za-z0-9_]/.test(code[j])) j++;
      const word = code.slice(i, j).toUpperCase();
      if (verbs.has(word)) return word;
      i = j - 1;
    }
  }
  return '';
}
