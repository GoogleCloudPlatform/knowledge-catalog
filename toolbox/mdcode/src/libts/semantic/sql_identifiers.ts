// Quoting for GoogleSQL identifiers emitted into generated graph DDL, the
// words each dialect reads as a keyword or a function when bare
// (`readsAsKeyword`), plus dialect-aware SQL action statement scanners
// (`referencedParameters` and `leadingDmlVerb`).
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

// The words each dialect's database reads, written bare, as a keyword or a
// function rather than a name: its reserved words, and the functions it calls
// without parentheses, such as CURRENT_DATE. For OSSIE_SQL_2026, the words
// Ossie's grammar reserves. Kept in upper case. The SQL parser reads many of
// them as a column, such as `order` in BigQuery and `user` in PostgreSQL, so
// the name writers in sql_expr_utils.ts check this table as well as the
// parser.
const words = (text: string) => text.trim().split(/\s+/);
const BARE_KEYWORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  OSSIE_SQL_2026: new Set(words(`
    AND AS BETWEEN BY CASE CAST CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP
    DISTINCT ELSE END EXTRACT FALSE FROM ILIKE IN IS LIKE NOT NULL OR ORDER
    THEN TRUE TRY_CAST WHEN WHERE`)),
  BIGQUERY: new Set([
    ...RESERVED_KEYWORDS,
    ...words('CURRENT_DATE CURRENT_DATETIME CURRENT_TIME CURRENT_TIMESTAMP'),
  ]),
  POSTGRES: new Set(words(`
    ALL ANALYSE ANALYZE AND ANY ARRAY AS ASC ASYMMETRIC AUTHORIZATION BINARY
    BOTH CASE CAST CHECK COLLATE COLLATION COLUMN CONCURRENTLY CONSTRAINT
    CREATE CROSS CURRENT_CATALOG CURRENT_DATE CURRENT_ROLE CURRENT_SCHEMA
    CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER DEFAULT DEFERRABLE DESC
    DISTINCT DO ELSE END EXCEPT FALSE FETCH FOR FOREIGN FREEZE FROM FULL GRANT
    GROUP HAVING ILIKE IN INITIALLY INNER INTERSECT INTO IS ISNULL JOIN
    LATERAL LEADING LEFT LIKE LIMIT LOCALTIME LOCALTIMESTAMP NATURAL NOT
    NOTNULL NULL OFFSET ON ONLY OR ORDER OUTER OVERLAPS PLACING PRIMARY
    REFERENCES RETURNING RIGHT SELECT SESSION_USER SIMILAR SOME SYMMETRIC
    SYSTEM_USER TABLE TABLESAMPLE THEN TO TRAILING TRUE UNION UNIQUE USER
    USING VARIADIC VERBOSE WHEN WHERE WINDOW WITH`)),
  SNOWFLAKE: new Set(words(`
    ACCOUNT ALL ALTER AND ANY AS BETWEEN BY CASE CAST CHECK COLUMN CONNECT
    CONNECTION CONSTRAINT CREATE CROSS CURRENT CURRENT_DATE CURRENT_TIME
    CURRENT_TIMESTAMP CURRENT_USER DATABASE DELETE DISTINCT DROP ELSE EXISTS
    FALSE FOLLOWING FOR FROM FULL GRANT GROUP GSCLUSTER HAVING ILIKE IN
    INCREMENT INNER INSERT INTERSECT INTO IS ISSUE JOIN LATERAL LEFT LIKE
    LOCALTIME LOCALTIMESTAMP MINUS NATURAL NOT NULL OF ON OR ORDER
    ORGANIZATION QUALIFY REGEXP REVOKE RIGHT RLIKE ROW ROWS SAMPLE SCHEMA
    SELECT SET SOME START TABLE TABLESAMPLE THEN TO TRIGGER TRUE TRY_CAST
    UNION UNIQUE UPDATE USING VALUES VIEW WHEN WHENEVER WHERE WITH`)),
  MYSQL: new Set(words(`
    ACCESSIBLE ADD ALL ALTER ANALYZE AND AS ASC ASENSITIVE BEFORE BETWEEN
    BIGINT BINARY BLOB BOTH BY CALL CASCADE CASE CHANGE CHAR CHARACTER CHECK
    COLLATE COLUMN CONDITION CONSTRAINT CONTINUE CONVERT CREATE CROSS CUBE
    CUME_DIST CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP CURRENT_USER CURSOR
    DATABASE DATABASES DAY_HOUR DAY_MICROSECOND DAY_MINUTE DAY_SECOND DEC
    DECIMAL DECLARE DEFAULT DELAYED DELETE DENSE_RANK DESC DESCRIBE
    DETERMINISTIC DISTINCT DISTINCTROW DIV DOUBLE DROP DUAL EACH ELSE ELSEIF
    EMPTY ENCLOSED ESCAPED EXCEPT EXISTS EXIT EXPLAIN FALSE FETCH FIRST_VALUE
    FLOAT FLOAT4 FLOAT8 FOR FORCE FOREIGN FROM FULLTEXT FUNCTION GENERATED GET
    GRANT GROUP GROUPING GROUPS HAVING HIGH_PRIORITY HOUR_MICROSECOND
    HOUR_MINUTE HOUR_SECOND IF IGNORE IN INDEX INFILE INNER INOUT INSENSITIVE
    INSERT INT INT1 INT2 INT3 INT4 INT8 INTEGER INTERSECT INTERVAL INTO
    IO_AFTER_GTIDS IO_BEFORE_GTIDS IS ITERATE JOIN JSON_TABLE KEY KEYS KILL
    LAG LAST_VALUE LATERAL LEAD LEADING LEAVE LEFT LIKE LIMIT LINEAR LINES
    LOAD LOCALTIME LOCALTIMESTAMP LOCK LONG LONGBLOB LONGTEXT LOOP
    LOW_PRIORITY MANUAL MASTER_BIND MASTER_SSL_VERIFY_SERVER_CERT MATCH
    MAXVALUE MEDIUMBLOB MEDIUMINT MEDIUMTEXT MIDDLEINT MINUTE_MICROSECOND
    MINUTE_SECOND MOD MODIFIES NATURAL NOT NO_WRITE_TO_BINLOG NTH_VALUE NTILE
    NULL NUMERIC OF ON OPTIMIZE OPTIMIZER_COSTS OPTION OPTIONALLY OR ORDER OUT
    OUTER OUTFILE OVER PARALLEL PARTITION PERCENT_RANK PRECISION PRIMARY
    PROCEDURE PURGE QUALIFY RANGE RANK READ READS READ_WRITE REAL RECURSIVE
    REFERENCES REGEXP RELEASE RENAME REPEAT REPLACE REQUIRE RESIGNAL RESTRICT
    RETURN REVOKE RIGHT RLIKE ROW ROWS ROW_NUMBER SCHEMA SCHEMAS
    SECOND_MICROSECOND SELECT SENSITIVE SEPARATOR SET SHOW SIGNAL SMALLINT
    SPATIAL SPECIFIC SQL SQLEXCEPTION SQLSTATE SQLWARNING SQL_BIG_RESULT
    SQL_CALC_FOUND_ROWS SQL_SMALL_RESULT SSL STARTING STORED STRAIGHT_JOIN
    SYSTEM TABLE TABLESAMPLE TERMINATED THEN TINYBLOB TINYINT TINYTEXT TO
    TRAILING TRIGGER TRUE UNDO UNION UNIQUE UNLOCK UNSIGNED UPDATE USAGE USE
    USING UTC_DATE UTC_TIME UTC_TIMESTAMP VALUES VARBINARY VARCHAR
    VARCHARACTER VARYING VIRTUAL WHEN WHERE WHILE WINDOW WITH WRITE XOR
    YEAR_MONTH ZEROFILL`)),
  SQLSERVER: new Set(words(`
    ADD ALL ALTER AND ANY AS ASC AUTHORIZATION BACKUP BEGIN BETWEEN BREAK
    BROWSE BULK BY CASCADE CASE CHECK CHECKPOINT CLOSE CLUSTERED COALESCE
    COLLATE COLUMN COMMIT COMPUTE CONSTRAINT CONTAINS CONTAINSTABLE CONTINUE
    CONVERT CREATE CROSS CURRENT CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP
    CURRENT_USER CURSOR DATABASE DBCC DEALLOCATE DECLARE DEFAULT DELETE DENY
    DESC DISK DISTINCT DISTRIBUTED DOUBLE DROP DUMP ELSE END ERRLVL ESCAPE
    EXCEPT EXEC EXECUTE EXISTS EXIT EXTERNAL FETCH FILE FILLFACTOR FOR FOREIGN
    FREETEXT FREETEXTTABLE FROM FULL FUNCTION GOTO GRANT GROUP HAVING HOLDLOCK
    IDENTITY IDENTITY_INSERT IDENTITYCOL IF IN INDEX INNER INSERT INTERSECT
    INTO IS JOIN KEY KILL LEFT LIKE LINENO LOAD MERGE NATIONAL NOCHECK
    NONCLUSTERED NOT NULL NULLIF OF OFF OFFSETS ON OPEN OPENDATASOURCE
    OPENQUERY OPENROWSET OPENXML OPTION OR ORDER OUTER OVER PERCENT PIVOT PLAN
    PRECISION PRIMARY PRINT PROC PROCEDURE PUBLIC RAISERROR READ READTEXT
    RECONFIGURE REFERENCES REPLICATION RESTORE RESTRICT RETURN REVERT REVOKE
    RIGHT ROLLBACK ROWCOUNT ROWGUIDCOL RULE SAVE SCHEMA SECURITYAUDIT SELECT
    SEMANTICKEYPHRASETABLE SEMANTICSIMILARITYDETAILSTABLE
    SEMANTICSIMILARITYTABLE SESSION_USER SET SETUSER SHUTDOWN SOME STATISTICS
    SYSTEM_USER TABLE TABLESAMPLE TEXTSIZE THEN TO TOP TRAN TRANSACTION
    TRIGGER TRUNCATE TRY_CONVERT TSEQUAL UNION UNIQUE UNPIVOT UPDATE
    UPDATETEXT USE USER VALUES VARYING VIEW WAITFOR WHEN WHERE WHILE WITH
    WITHIN WRITETEXT`)),
  DATABRICKS: new Set(words(`
    ALL AND ANTI ANY AS AUTHORIZATION BOTH CASE CAST CHECK COLLATE COLUMN
    CONSTRAINT CREATE CROSS CURRENT_DATE CURRENT_TIME CURRENT_TIMESTAMP
    CURRENT_USER DEFAULT DISTINCT ELSE END ESCAPE EXCEPT FALSE FETCH FILTER
    FOR FOREIGN FROM FULL GRANT GROUP HAVING IN INNER INTERSECT INTO IS JOIN
    LATERAL LEADING LEFT MINUS NATURAL NOT NULL OFFSET ON ONLY OR ORDER OUTER
    OVERLAPS PRIMARY REFERENCES RIGHT SELECT SEMI SESSION_USER SOME TABLE THEN
    TO TRAILING TRUE UNION UNIQUE UNKNOWN USER USING WHEN WHERE WITH`)),
};

// The dialect whose list in BARE_KEYWORDS a dialect reads by: Spanner's
// GoogleSQL as BigQuery's, and AlloyDB as PostgreSQL.
const KEYWORD_DIALECTS: Readonly<Record<string, string>> = {
  SPANNER: 'BIGQUERY',
  ALLOYDB: 'POSTGRES',
};

// Every word some database in BARE_KEYWORDS reads as a keyword or a function.
const ANY_BARE_KEYWORD =
    new Set(Object.values(BARE_KEYWORDS).flatMap(list => [...list]));

// Whether the database of `dialect` reads `name`, written bare, as a keyword
// or a function rather than a name, as BigQuery reads `order` and PostgreSQL
// reads `user`. Letter case is ignored. A dialect without a list of its own,
// such as ANSI_SQL, reads `name` so when any database listed does, since such
// a text may run on any of them.
export function readsAsKeyword(name: string, dialect: string): boolean {
  const d = dialect.toUpperCase();
  const list = BARE_KEYWORDS[KEYWORD_DIALECTS[d] ?? d] ?? ANY_BARE_KEYWORD;
  return list.has(name.toUpperCase());
}

// The reserved words of ANSI SQL:2003. Kept in upper case.
const ANSI_RESERVED_WORDS = new Set(words(`
  ABS ALL ALLOCATE ALTER AND ANY ARE ARRAY AS ASENSITIVE ASYMMETRIC AT ATOMIC
  AUTHORIZATION AVG BEGIN BETWEEN BIGINT BINARY BLOB BOOLEAN BOTH BY CALL
  CALLED CARDINALITY CASCADED CASE CAST CEIL CEILING CHAR CHAR_LENGTH
  CHARACTER CHARACTER_LENGTH CHECK CLOB CLOSE COALESCE COLLATE COLLECT COLUMN
  COMMIT CONDITION CONNECT CONSTRAINT CONVERT CORR CORRESPONDING COUNT
  COVAR_POP COVAR_SAMP CREATE CROSS CUBE CUME_DIST CURRENT CURRENT_DATE
  CURRENT_DEFAULT_TRANSFORM_GROUP CURRENT_PATH CURRENT_ROLE CURRENT_TIME
  CURRENT_TIMESTAMP CURRENT_TRANSFORM_GROUP_FOR_TYPE CURRENT_USER CURSOR CYCLE
  DATE DAY DEALLOCATE DEC DECIMAL DECLARE DEFAULT DELETE DENSE_RANK DEREF
  DESCRIBE DETERMINISTIC DISCONNECT DISTINCT DOUBLE DROP DYNAMIC EACH ELEMENT
  ELSE END ESCAPE EVERY EXCEPT EXEC EXECUTE EXISTS EXP EXTERNAL EXTRACT FALSE
  FETCH FILTER FLOAT FLOOR FOR FOREIGN FREE FROM FULL FUNCTION FUSION GET
  GLOBAL GRANT GROUP GROUPING HAVING HOLD HOUR IDENTITY IN INDICATOR INNER
  INOUT INSENSITIVE INSERT INT INTEGER INTERSECT INTERSECTION INTERVAL INTO IS
  JOIN LANGUAGE LARGE LATERAL LEADING LEFT LIKE LN LOCAL LOCALTIME
  LOCALTIMESTAMP LOWER MATCH MAX MEMBER MERGE METHOD MIN MINUTE MOD MODIFIES
  MODULE MONTH MULTISET NATIONAL NATURAL NCHAR NCLOB NEW NO NONE NORMALIZE NOT
  NULL NULLIF NUMERIC OCTET_LENGTH OF OLD ON ONLY OPEN OR ORDER OUT OUTER OVER
  OVERLAPS OVERLAY PARAMETER PARTITION PERCENT_RANK PERCENTILE_CONT
  PERCENTILE_DISC POSITION POWER PRECISION PREPARE PRIMARY PROCEDURE RANGE
  RANK READS REAL RECURSIVE REF REFERENCES REFERENCING REGR_AVGX REGR_AVGY
  REGR_COUNT REGR_INTERCEPT REGR_R2 REGR_SLOPE REGR_SXX REGR_SXY REGR_SYY
  RELEASE RESULT RETURN RETURNS REVOKE RIGHT ROLLBACK ROLLUP ROW ROW_NUMBER
  ROWS SAVEPOINT SCOPE SCROLL SEARCH SECOND SELECT SENSITIVE SESSION_USER SET
  SIMILAR SMALLINT SOME SPECIFIC SPECIFICTYPE SQL SQLEXCEPTION SQLSTATE
  SQLWARNING SQRT START STATIC STDDEV_POP STDDEV_SAMP SUBMULTISET SUBSTRING
  SUM SYMMETRIC SYSTEM SYSTEM_USER TABLE TABLESAMPLE THEN TIME TIMESTAMP
  TIMEZONE_HOUR TIMEZONE_MINUTE TO TRAILING TRANSLATE TRANSLATION TREAT
  TRIGGER TRIM TRUE UESCAPE UNION UNIQUE UNKNOWN UNNEST UPDATE UPPER USER
  USING VALUE VALUES VAR_POP VAR_SAMP VARCHAR VARYING WHEN WHENEVER WHERE
  WIDTH_BUCKET WINDOW WITH WITHIN WITHOUT YEAR`));

// Whether a text in `dialect` can name a column by `name` written bare.
// Letter case is ignored. An ANSI_SQL text cannot when ANSI SQL:2003 reserves
// the word, and a text in another dialect cannot when its database reads the
// word as a keyword or a function (see readsAsKeyword).
export function bareColumnName(name: string, dialect: string): boolean {
  return dialect.toUpperCase() === 'ANSI_SQL' ? !ANSI_RESERVED_WORDS.has(name.toUpperCase()) :
      !readsAsKeyword(name, dialect);
}

// The dialects whose database matches a column's name in any letter case,
// quoted or not.
export const ANY_CASE_DIALECTS =
    new Set(['BIGQUERY', 'SPANNER', 'MYSQL', 'DATABRICKS', 'SQLSERVER']);

// The dialects whose database stores a name written without quotes in lower
// case. Every other dialect outside ANY_CASE_DIALECTS stores it in upper
// case, as SNOWFLAKE and standard SQL do.
const LOWER_CASE_DIALECTS = new Set(['POSTGRES', 'ALLOYDB']);

// `name` as the database of `dialect` stores it: as written when it is quoted
// or the database ignores case, and otherwise in the case the database gives
// a name written without quotes.
export function storedName(
    name: string, quoted: boolean, dialect: string): string {
  if (quoted || ANY_CASE_DIALECTS.has(dialect)) return name;
  return LOWER_CASE_DIALECTS.has(dialect) ? name.toLowerCase() :
                                            name.toUpperCase();
}

// `name`, written with or without quotes in a text of `dialect`, in a form
// two names of the text share when they name one thing, as the dialect's
// database matches a column's name. The form is the name in lower case in a
// dialect of ANY_CASE_DIALECTS, and otherwise the name as the database
// stores it (see storedName). So `O` and `o` give one form in BIGQUERY,
// POSTGRES and SNOWFLAKE. A POSTGRES text reads "O" as a name of its own.
export function nameKey(
    name: {name: string; quoted: boolean}, dialect: string): string {
  const d = dialect.toUpperCase();
  return ANY_CASE_DIALECTS.has(d) ? name.name.toLowerCase() :
                                    storedName(name.name, name.quoted, d);
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

// One dialect for each way a statement's comments and parameters are read:
// SPANNER for GoogleSQL, MYSQL for a dialect in which `#` starts a comment
// and a parameter's name follows the `@`, SQLSERVER for one in which `#`
// starts no comment, and POSTGRES for PostgreSQL.
export const SQL_CODE_DIALECTS =
    ['SPANNER', 'MYSQL', 'SQLSERVER', 'POSTGRES'] as const;

// Whether a statement in `dialect` is read as PostgreSQL. Any other is read as
// GoogleSQL.
function readsPostgres(dialect?: string|null): boolean {
  return dialect === 'POSTGRES' || dialect === 'ALLOYDB';
}

// The dialects in which `#` starts a comment that runs to the end of the
// line: BigQuery, GoogleSQL Spanner and MySQL. PostgreSQL and AlloyDB read `#`
// as an operator, SQL Server as the start of a temporary table's name, and
// Snowflake and Databricks start no comment with it.
const HASH_COMMENT_DIALECTS = new Set(['BIGQUERY', 'SPANNER', 'MYSQL']);

// Whether `#` starts a comment in `dialect`. A statement given no dialect is
// read as GoogleSQL, where it does.
export function hashStartsComment(dialect?: string|null): boolean {
  return !dialect || HASH_COMMENT_DIALECTS.has(dialect);
}

// Whether `dialect` reads parameters as GoogleSQL does, as BigQuery and
// GoogleSQL Spanner do: `@ name` and `` @`name` `` are the parameter `name`,
// and names match without regard to case. A statement given no dialect is
// read as GoogleSQL. Every other dialect reads a name only right after the
// `@`, and matches it exactly.
function readsGoogleSqlParameters(dialect?: string|null): boolean {
  return !dialect || dialect === 'BIGQUERY' || dialect === 'SPANNER';
}

// `text` with each comment and each quoted string or identifier replaced by a
// space, read as GoogleSQL by default or as PostgreSQL when `dialect` is
// `POSTGRES` or `ALLOYDB`. `#` starts a comment where hashStartsComment says
// so. With `quotedNames`, a GoogleSQL identifier quoted in backticks is kept,
// and each quoted string is replaced by `''`, so an `@` before a string reads
// no name after it.
function sqlCode(
    text: string, dialect?: string|null, quotedNames = false): string {
  const postgres = readsPostgres(dialect);
  const hashComments = hashStartsComment(dialect);
  const identCont =
      postgres ? /[A-Za-z0-9_$\x80-\uffff]/ : /[A-Za-z0-9_\x80-\uffff]/;
  let out = '';
  let start = 0;
  const skip = (from: number, to: number, by = ' '): number => {
    out += `${text.slice(start, from)}${by}`;
    start = to;
    return to - 1;
  };
  const string = quotedNames ? "''" : ' ';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '-' && text[i + 1] === '-') {
      i = skip(i, endOfLineComment(text, i + 2));
    } else if (hashComments && c === '#') {
      i = skip(i, endOfLineComment(text, i + 1));
    } else if (c === '/' && text[i + 1] === '*') {
      i = skip(i, endOfBlockComment(text, i, postgres));
    } else if (
        !postgres && (c === '\'' || c === '"') && text[i + 1] === c &&
        text[i + 2] === c) {
      i = skip(i, endOfTripleQuoted(text, i), string);
    } else if (c === '\'' || c === '"') {
      i = skip(i, endOfQuoted(text, i, !postgres, postgres), string);
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
// Any other dialect's parameter: `@` and a name, with nothing between them.
const PLAIN_PARAMETER = /@@+|@([A-Za-z_]\w*)/g;

// The distinct `@name` references in a SQL statement, ignoring comments and
// quoted strings or identifiers so prose or a literal containing an '@' is not
// read as a binding. `#` starts a line comment where hashStartsComment says
// so, and is an operator such as `#>` or `#-` on PostgreSQL. BigQuery and
// Spanner also read `@ name` and `` @`name` `` as the parameter `name` (see
// readsGoogleSqlParameters). Used to check that every parameter a statement
// reads is one the caller will bind, and to bind only the parameters a
// statement actually reads.
export function referencedParameters(
    text: string, dialect?: string|null): string[] {
  const googleSql = readsGoogleSqlParameters(dialect);
  const names = new Set<string>();
  for (const m of sqlCode(text, dialect, googleSql)
           .matchAll(googleSql ? GOOGLE_SQL_PARAMETER : PLAIN_PARAMETER)) {
    const name = m[1] ?? m[2];
    if (name) names.add(name);
  }
  return [...names];
}

// The parameter of `declared` that `@name` binds in `dialect`, or undefined
// when none does. BigQuery and Spanner match parameter names without regard
// to case, so a name binds the parameter written the same way, or else the
// one parameter written in another case. Every other dialect matches them
// exactly (see readsGoogleSqlParameters).
export function boundParameter(
    name: string, declared: readonly string[],
    dialect?: string|null): string|undefined {
  if (declared.includes(name)) return name;
  if (!readsGoogleSqlParameters(dialect)) return undefined;
  const same = declared.filter(d => d.toLowerCase() === name.toLowerCase());
  return same.length === 1 ? same[0] : undefined;
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
// `#` is skipped as a line comment alongside `--` where hashStartsComment says
// it starts one, and stays an operator elsewhere, such as `#>` or `#>>` in a
// leading CTE on PostgreSQL.
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
