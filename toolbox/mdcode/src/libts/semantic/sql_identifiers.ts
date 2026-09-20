// Quoting for GoogleSQL identifiers emitted into generated graph DDL.
//
// Both graph generators (./bigquery, ./spanner) lower logical names -- entity
// and relationship labels, property names, key columns -- into identifier
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
// table serves both generators: the two lists differ only in QUALIFY (BigQuery
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


// The distinct `@name` references in a SQL statement, ignoring the ones inside
// a single-quoted string so a literal containing an '@' is not read as a
// binding. Used to check that every parameter a statement reads is one the
// caller will bind, and to bind only the parameters a statement actually reads.
export function referencedParameters(text: string): string[] {
  const withoutStrings = text.replace(/'(?:[^'\\]|\\.)*'/g, "''");
  const names = new Set<string>();
  for (const m of withoutStrings.matchAll(/@([A-Za-z_]\w*)/g)) names.add(m[1]);
  return [...names];
}


// The DML verb a statement leads with, or '' when none can be read.
//
// Reading the first six characters is not enough: a statement opening with a
// `--` comment, or with a `WITH` clause ahead of its UPDATE, reports a verb
// that is not the statement's. So this walks the text instead, skipping what
// cannot hold the verb -- comments, quoted strings, and anything nested in
// parentheses -- and returns the first DML keyword left standing at the top
// level. For `WITH x AS (SELECT ...) UPDATE ...` that is the UPDATE, because
// the CTE body is inside parentheses; for `UPDATE t SET note = 'DELETE'` it is
// the UPDATE, because the literal is not read as a keyword.
//
// BOTH line-comment forms are skipped. GoogleSQL takes `#` as well as `--`, and
// action DML runs against Spanner, so `# credit the account` ahead of an INSERT
// would otherwise hand back whatever verb the prose happened to use.
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
export function leadingDmlVerb(sql: string): string {
  const verbs = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);
  let depth = 0;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if ((c === '-' && sql[i + 1] === '-') || c === '#') {
      const end = sql.indexOf('\n', i);
      if (end < 0) break;
      i = end;
    } else if (c === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end < 0) break;
      i = end + 1;
    } else if (c === '\'' || c === '"' || c === '`') {
      for (i++; i < sql.length; i++) {
        if (sql[i] === '\\') {
          i++;
        } else if (sql[i] === c) {
          break;
        }
      }
    } else if (c === '(') {
      depth++;
    } else if (c === ')') {
      if (depth > 0) depth--;
    } else if (depth === 0 && /[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j])) j++;
      const word = sql.slice(i, j).toUpperCase();
      if (verbs.has(word)) return word;
      i = j - 1;
    }
  }
  return '';
}
