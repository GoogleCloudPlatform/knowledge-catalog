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
// identifier unless quoted. Non-reserved keywords (e.g. KEY, VALUE, SOURCE) are
// deliberately absent: they are legal bare identifiers, so quoting them would
// churn existing output for no reason. Kept uppercase; lookups uppercase first.
// Source: GoogleSQL lexical structure (reserved keywords), shared by BigQuery
// and Spanner.
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
