// Tests for the default transpilation MECHANISM (the polyglotTranspiler adapter
// in src/libts/semantic/transpile.ts).
//
// The engine is the @polyglot-sql/sdk Rust/WASM blob bundled into the tool, so
// there is no external dependency and these tests run everywhere -- both the
// invariants and the real Snowflake/Databricks -> GoogleSQL transformations.
// The adapter is still designed to never throw: an unsupported source dialect
// or an unparseable expression degrades to a per-request `error`.

import {describe, expect, spyOn, test} from 'bun:test';

import {Field, SemanticModel} from '../../../src/libts/semantic/ir';
import {loadSqlEngine, mysqlForEngine, sqlExpressionTree} from '../../../src/libts/semantic/sql_parser';
import {polyglotTranspiler, transpileModel} from '../../../src/libts/semantic/transpile';

// A model with one entity, `orders`, holding `fields`.
function ordersModel(fields: Field[]): SemanticModel {
  return {
    name: 'sales',
    entities: [{name: 'orders', dataSource: 'p.d.orders', keys: ['id'], fields}],
    relationships: [],
    metrics: [],
  };
}

describe('polyglotTranspiler (mechanism invariants)', () => {
  test(
      'returns exactly one response per request, correlated by id',
      async () => {
        const requests = [
          {id: 'a', dialect: 'SNOWFLAKE', expression: 'NVL(x, 0)'},
          {id: 'b', dialect: 'DATABRICKS', expression: 'x::double'},
        ];
        const responses = await polyglotTranspiler(requests, 'BIGQUERY');
        expect(responses.length).toBe(2);
        expect(new Set(responses.map(r => r.id))).toEqual(new Set(['a', 'b']));
        // Each response is exactly one of sql|error, never both, never neither.
        for (const r of responses) {
          expect((r.sql === undefined) !== (r.error === undefined)).toBe(true);
        }
      });

  test('resolves to an empty array for no requests', async () => {
    expect(await polyglotTranspiler([], 'BIGQUERY')).toEqual([]);
  });

  test(
      'degrades to a per-request error (never throws) for an unsupported ' +
          'source dialect',
      async () => {
        for (const unsupported
                 of ['NOT_A_DIALECT',
                     'SPARK',
                     'POSTGRESQL',
                     'TERADATA',
                     'PRESTO',
                     'TRINO',
                     'DUCKDB',
                     'REDSHIFT',
                     'ORACLE',
                     'TSQL',
        ]) {
          const responses = await polyglotTranspiler(
              [{id: '0', dialect: unsupported, expression: 'NVL(x, 0)'}],
              'BIGQUERY');
          expect(responses.length).toBe(1);
          expect(responses[0].sql).toBeUndefined();
          expect(responses[0].error)
              .toContain(`unsupported source dialect '${unsupported}'`);
        }
      });

  test(
      'warns that SQL Server text is translated on a best-effort basis',
      async () => {
        // The engine gets common T-SQL forms wrong without an error (a CONVERT
        // style, DATEDIFF(dd, ...), DATEPART, N'' strings), so translating
        // SQLSERVER text warns the user to check the BIGQUERY entry.
        const {model, warnings} = await transpileModel(ordersModel([{
          name: 'd',
          dialects: [{dialect: 'SQLSERVER', expression: 'COALESCE(orders.d, 0)'}],
          stringForm: false,
        }]));
        expect(model.entities[0].fields[0].dialects).toEqual([
          {dialect: 'SQLSERVER', expression: 'COALESCE(orders.d, 0)'},
          {dialect: 'BIGQUERY', expression: 'COALESCE(orders.d, 0)'},
        ]);
        expect(warnings).toEqual([
          'field \'orders.d\': transpiled \'SQLSERVER\' -> \'BIGQUERY\'',
          'field \'orders.d\': SQL Server text is translated to BigQuery on a ' +
              'best-effort basis, and the translator can get some T-SQL wrong; ' +
              'check the BIGQUERY entry.',
        ]);
      });

  test(
      'translates double-quoted identifiers in vendor and ANSI_SQL text to ' +
          'BigQuery backticks while keeping string literals intact',
      async () => {
        const responses = await polyglotTranspiler(
            [
              {
                id: 'vendor',
                dialect: 'SNOWFLAKE',
                expression: 'SUM("orders"."col")',
              },
              {
                id: 'ansi',
                dialect: 'ANSI_SQL',
                expression: '"orders"."col"',
              },
              {
                id: 'lit',
                dialect: 'ANSI_SQL',
                expression: `'a "quoted" string'`,
              },
            ],
            'BIGQUERY');
        const byId = new Map(responses.map(r => [r.id, r]));
        expect(byId.get('vendor')!.sql).toBe('SUM(`orders`.`col`)');
        expect(byId.get('ansi')!.sql).toBe('`orders`.`col`');
        expect(byId.get('lit')!.sql).toBe(`'a "quoted" string'`);
      });

  test(
      'errors every request for an unsupported target dialect rather than ' +
          'silently emitting BigQuery',
      async () => {
        const responses = await polyglotTranspiler(
            [
              {id: 'a', dialect: 'SNOWFLAKE', expression: 'NVL(x, 0)'},
              {id: 'b', dialect: 'DATABRICKS', expression: 'x::double'},
            ],
            'NOT_A_DIALECT');
        expect(responses.length).toBe(2);
        for (const r of responses) {
          expect(r.sql).toBeUndefined();
          expect(r.error).toContain('unsupported target dialect');
        }
      });
});

describe('polyglotTranspiler (transformations)', () => {
  test('rewrites Snowflake NVL/IFF to GoogleSQL', async () => {
    const responses = await polyglotTranspiler(
        [
          {id: 'nvl', dialect: 'SNOWFLAKE', expression: 'NVL(orders.amt, 0)'},
          {
            id: 'iff',
            dialect: 'SNOWFLAKE',
            expression: 'IFF(orders.s = \'F\', 1, 0)'
          },
        ],
        'BIGQUERY');
    const byId = new Map(responses.map(r => [r.id, r]));
    expect(byId.get('nvl')!.sql).toBe('COALESCE(orders.amt, 0)');
    expect(byId.get('iff')!.sql).toBe('IF(orders.s = \'F\', 1, 0)');
  });

  test('preserves the entity qualifier through a rewrite', async () => {
    // The qualifier-preservation guard depends on this: the engine must not
    // re-case or requalify `orders.` when it rewrites the surrounding function.
    const [res] = await polyglotTranspiler(
        [{
          id: '0',
          dialect: 'SNOWFLAKE',
          expression: 'DATEADD(day, 7, orders.d)'
        }],
        'BIGQUERY');
    expect(res.sql).toContain('orders.d');
  });

  test(
      'targets ANSI_SQL as dialect-neutral, not silently BigQuery',
      async () => {
        // ANSI_SQL maps to the engine's neutral 'generic' dialect; it must not
        // be clobbered to BigQuery. `::double` renders as the generic
        // `CAST(... AS DOUBLE)` under ANSI, vs `SAFE_CAST(... AS FLOAT64)`
        // under BigQuery.
        const [ansi] = await polyglotTranspiler(
            [{id: '0', dialect: 'DATABRICKS', expression: 'x::double'}],
            'ANSI_SQL');
        expect(ansi.sql).toBe('CAST(x AS DOUBLE)');
        const [bq] = await polyglotTranspiler(
            [{id: '0', dialect: 'DATABRICKS', expression: 'x::double'}],
            'BIGQUERY');
        expect(bq.sql).toBe('SAFE_CAST(x AS FLOAT64)');
      });

  // Each construct import translates, with the BigQuery SQL it writes, and
  // constructs it leaves untranslated. Every construct a `sql` row uses gives
  // the source dialect's value in BigQuery for ordinary data, and every `sql`
  // passes a BigQuery dry run against a table that has each column the row
  // names.
  test.each([
    // Values, operators, CASE and NULL handling.
    ['POSTGRES', 'SUM(x) * COUNT(*) + COUNT(DISTINCT a) - 1', {sql: 'SUM(x) * COUNT(*) + COUNT(DISTINCT a) - 1'}],
    ['POSTGRES', "CASE WHEN a > 2 THEN 'big' WHEN a BETWEEN 1 AND 2 THEN NULL ELSE COALESCE(s, 'none') END", {sql: "CASE WHEN a > 2 THEN 'big' WHEN a BETWEEN 1 AND 2 THEN NULL ELSE COALESCE(s, 'none') END"}],
    ['POSTGRES', 'CASE a WHEN 7 THEN -1.5 END + 1', {sql: "CASE a WHEN 7 THEN -NUMERIC '1.5' END + 1"}],
    ['POSTGRES', 'FLOOR(a * 0.29 * 100) + 0.1234567891', {sql: "FLOOR(a * NUMERIC '0.29' * 100) + BIGNUMERIC '0.1234567891'"}],
    ['SNOWFLAKE', 'IFF(a > 2, NVL(z, 0), IFNULL(b, 1))', {sql: 'IF(a > 2, COALESCE(z, 0), COALESCE(b, 1))'}],
    ['MYSQL', 'IF(a NOT IN (7, 8) AND z IS NOT NULL, NULLIF(a, 0), 0)', {sql: 'IF(a NOT IN (7, 8) AND z IS NOT NULL, NULLIF(a, 0), 0)'}],
    ['MYSQL', 'IF(flag, a + 1, a) = CASE WHEN NOT flag THEN a END', {sql: 'IF(flag, a + 1, a) = CASE WHEN NOT flag THEN a END'}],
    ['SQLSERVER', 'COALESCE([order total], 0) * 2 - 1', {sql: 'COALESCE(`order total`, 0) * 2 - 1'}],
    ['POSTGRES', "s LIKE 'a%' OR NOT (a <> b) AND TRUE", {sql: "s LIKE 'a%' OR NOT (a <> b) AND TRUE"}],
    ['ALLOYDB', '"orders"."amount" + 1', {sql: '`orders`.`amount` + 1'}],
    ['SPANNER', 'SUM(IF(a = 1, a - b, 0)) / COUNT(*)', {sql: 'SUM(IF(a = 1, a - b, 0)) / COUNT(*)'}],
    ['BIGQUERY', 'EXTRACT(HOUR FROM t)', {sql: 'EXTRACT(HOUR FROM t)'}],
    ['MYSQL', 'SUM(a)--1 -- note', {sql: 'SUM(a) - -1 /* note */'}],
    ['MYSQL', "IF(a--1 > 0, '--x', '#')", {sql: "IF(a - -1 > 0, '--x', '#')"}],
    ['MYSQL', "IF(a--1 > 0, 'x\n--y', 'z')", {sql: "IF(a - -1 > 0, 'x\\n--y', 'z')"}],
    ['MYSQL', 'a = b IS NULL', {sql: '(a = b) IS NULL'}],
    ['POSTGRES', "a = b IS NOT NULL OR s NOT LIKE 'a%' = flag", {sql: "(a = b) IS NOT NULL OR (s NOT LIKE 'a%') = flag"}],
    ['DATABRICKS', 'a < b IS NULL', {sql: '(a < b) IS NULL'}],
    // Strings and numbers.
    ['SNOWFLAKE', 'LENGTH(UPPER(TRIM(s)) || LOWER(s))', {sql: "LENGTH(UPPER(TRIM(s, ' ')) || LOWER(s))"}],
    ['SNOWFLAKE', "CONCAT(s, 'x') || s", {sql: "CONCAT(s, 'x') || s"}],
    ['POSTGRES', "s || ' ' || 1.5", {error: 'kcmd does not translate || of a value that is not text'}],
    ['DATABRICKS', 'concat(s, YEAR(d))', {error: 'kcmd does not translate concat of a value that is not text'}],
    ['SNOWFLAKE', 'ROUND(x, 1) * ABS(x) * FLOOR(x) * CEIL(x)', {sql: 'ROUND(x, 1) * ABS(x) * FLOOR(x) * CEIL(x)'}],
    ['SNOWFLAKE', 'SUM(a) / AVG(x)', {sql: 'CAST(SUM(a) AS NUMERIC) / AVG(CAST(x AS NUMERIC))'}],
    ['SNOWFLAKE', '((SUM(a) - SUM(b)) / SUM(a)) * 100', {sql: '(CAST((SUM(a) - SUM(b)) AS NUMERIC) / SUM(a)) * 100'}],
    ['POSTGRES', 'AVG(x)', {sql: 'AVG(CAST(x AS NUMERIC))'}],
    ['POSTGRES', 'TRIM(FROM s)', {sql: "TRIM(s, ' ')"}],
    // Text compared by a collation, which differs only for text that differs in
    // letter case, accents or trailing spaces, and in PostgreSQL also in the
    // spaces and punctuation it sorts by.
    ['MYSQL', 'MAX(s) > MIN(s) OR COUNT(DISTINCT s) IN (1, 2)', {sql: 'MAX(s) > MIN(s) OR COUNT(DISTINCT s) IN (1, 2)'}],
    ['SQLSERVER', "CASE s WHEN 'a' THEN NULLIF(UPPER(s), LOWER(s)) END LIKE 'A%'", {sql: "CASE s WHEN 'a' THEN NULLIF(UPPER(s), LOWER(s)) END LIKE 'A%'"}],
    ['POSTGRES', "a < b OR s BETWEEN 'a' AND 'b'", {sql: "a < b OR s BETWEEN 'a' AND 'b'"}],
    // Casts and literals.
    ['POSTGRES', "t::timestamp >= ds::timestamp AND t < ds::timestamptz OR d = DATE '2024-01-01'", {sql: "CAST(t AS DATETIME) >= CAST(ds AS DATETIME) AND t < CAST(ds AS TIMESTAMP) OR d = '2024-01-01'"}],
    ['MYSQL', "t BETWEEN DATE '2024-01-01' AND DATE '2024-02-01' OR d IN (DATE '2024-1-2') OR DATE '2024-01-01' < DATE '2024-02-01'", {sql: "t BETWEEN '2024-01-01' AND '2024-02-01' OR d IN ('2024-1-2') OR CAST('2024-01-01' AS DATE) < CAST('2024-02-01' AS DATE)"}],
    ['SNOWFLAKE', 't::TIMESTAMP_NTZ < CURRENT_TIMESTAMP() OR t::TIMESTAMP_NTZ < ds::TIMESTAMP OR d = CURRENT_DATE', {sql: "CAST(t AS DATETIME) < CURRENT_DATETIME('America/Los_Angeles') OR CAST(t AS DATETIME) < CAST(ds AS DATETIME) OR d = CURRENT_DATE('America/Los_Angeles')"}],
    ['SQLSERVER', 'CAST(a AS FLOAT) * 2', {sql: 'CAST(a AS FLOAT64) * 2'}],
    // Dates.
    ['SQLSERVER', 'CAST(ds AS DATE) = CAST(GETDATE() AS DATE)', {sql: 'CAST(ds AS DATE) = CAST(CURRENT_TIMESTAMP() AS DATE)'}],
    ['POSTGRES', "DATE_TRUNC('month', \"order date\") = CURRENT_DATE AND t = NOW()", {sql: 'DATE_TRUNC(`order date`, MONTH) = CURRENT_DATE AND t = CURRENT_TIMESTAMP()'}],
    ['SNOWFLAKE', 'DATE_TRUNC(week, d)', {sql: 'DATE_TRUNC(d, ISOWEEK)'}],
    ['DATABRICKS', "date_trunc('QUARTER', d)", {error: 'kcmd does not translate DATE_TRUNC'}],
    ['POSTGRES', "date_part('year', d) * EXTRACT(MINUTE FROM t)", {sql: 'EXTRACT(YEAR FROM d) * EXTRACT(MINUTE FROM t)'}],
    ['SQLSERVER', 'DATEPART(month, d) - 1', {sql: 'EXTRACT(MONTH FROM d) - 1'}],
    ['SQLSERVER', 't >= GETDATE() OR d + 1 > d', {sql: 't >= CURRENT_TIMESTAMP() OR d + 1 > d'}],
    ['MYSQL', 'QUARTER(CURDATE()) + 1', {sql: 'EXTRACT(QUARTER FROM CURRENT_DATE) + 1'}],
    ['DATABRICKS', 'hour(t) * minute(t)', {sql: 'EXTRACT(HOUR FROM t) * EXTRACT(MINUTE FROM t)'}],
    ['MYSQL', 'INTERVAL 1 DAY + order_date', {sql: "DATE_ADD(order_date, INTERVAL '1' DAY)"}],
    ['MYSQL', 'CURDATE() - INTERVAL 1 QUARTER', {sql: "DATE_SUB(CURRENT_DATE, INTERVAL '1' QUARTER)"}],
    ['MYSQL', 'CURRENT_DATE + INTERVAL -2 WEEK', {sql: 'DATE_ADD(CURRENT_DATE, INTERVAL -2 WEEK)'}],
    ['MYSQL', 'DATE_ADD(d, INTERVAL 1 DAY) - INTERVAL 10 SECOND', {sql: "DATE_ADD(d, INTERVAL '1' DAY) - INTERVAL '10' SECOND"}],
    ['MYSQL', 'INTERVAL 30 MINUTE + DATE_SUB(CURDATE(), INTERVAL 1 YEAR)', {sql: "INTERVAL '30' MINUTE + DATE_SUB(CURRENT_DATE, INTERVAL '1' YEAR)"}],
    ['POSTGRES', "d + INTERVAL '1 day'", {sql: 'd + INTERVAL 1 DAY'}],
    ['POSTGRES', "CURRENT_DATE - INTERVAL '1 month'", {sql: 'CURRENT_DATE - INTERVAL 1 MONTH'}],
    ['POSTGRES', "INTERVAL '2 weeks' + d", {sql: 'INTERVAL 2 WEEK + d'}],
    ['SNOWFLAKE', "CURRENT_DATE - INTERVAL '2 days'", {sql: "DATE_SUB(CURRENT_DATE('America/Los_Angeles'), INTERVAL 2 DAY)"}],
    ['SNOWFLAKE', "DATEADD(day, 1, d) + INTERVAL '2 hours'", {sql: "DATE_ADD(d, INTERVAL '1' DAY) + INTERVAL 2 HOUR"}],
    ['DATABRICKS', 'current_date() + INTERVAL 1 MONTH', {sql: "DATE_ADD(CURRENT_DATE, INTERVAL '1' MONTH)"}],
    ['DATABRICKS', 'date_add(d, 1) - INTERVAL 3 DAY', {sql: "DATE_SUB(DATE_ADD(CAST(CAST(d AS DATETIME) AS DATE), INTERVAL '1' DAY), INTERVAL '3' DAY)"}],
    ['POSTGRES', 'CURRENT_DATE - 7', {sql: 'DATE_SUB(CURRENT_DATE, INTERVAL 7 DAY)'}],
    ['SNOWFLAKE', 'd + 30 < 7 + DATEADD(day, 1, d)', {sql: "d + 30 < DATE_ADD(DATE_ADD(d, INTERVAL '1' DAY), INTERVAL 7 DAY)"}],
    ['DATABRICKS', 'date_add(d, 1) - 7', {sql: "DATE_SUB(DATE_ADD(CAST(CAST(d AS DATETIME) AS DATE), INTERVAL '1' DAY), INTERVAL 7 DAY)"}],
    ['MYSQL', 'DATE_SUB(NOW(), INTERVAL 2 DAY)', {sql: "DATE_SUB(CURRENT_TIMESTAMP(), INTERVAL '2' DAY)"}],
    ['DATABRICKS', 'date_add(d, 1)', {sql: 'DATE_ADD(CAST(CAST(d AS DATETIME) AS DATE), INTERVAL 1 DAY)'}],
    ['SQLSERVER', 'DATEADD(month, 1, CAST(d AS DATE))', {sql: 'DATE_ADD(CAST(d AS DATE), INTERVAL 1 MONTH)'}],
    ['MYSQL', 'DATE_ADD(CURDATE(), INTERVAL 1 MONTH)', {sql: "DATE_ADD(CURRENT_DATE, INTERVAL '1' MONTH)"}],
    ['SQLSERVER', 'DATEDIFF(day, t, d)', {sql: 'DATE_DIFF(CAST(d AS DATETIME), CAST(t AS DATETIME), DAY)'}],
    ['ANSI_SQL', 'EXTRACT(YEAR FROM "d")', {sql: 'EXTRACT(YEAR FROM `d`)'}],
    // SPANNER texts, with Spanner's default time zone written out.
    ['SPANNER', "EXTRACT(HOUR FROM t) + EXTRACT(DAY FROM DATE '2024-01-01')", {sql: "EXTRACT(HOUR FROM t AT TIME ZONE 'America/Los_Angeles') + EXTRACT(DAY FROM CAST('2024-01-01' AS DATE))"}],
    ['SPANNER', "TIMESTAMP_TRUNC(t, DAY) = TIMESTAMP '2024-01-01 00:00:00'", {sql: "TIMESTAMP_TRUNC(t, DAY, 'America/Los_Angeles') = TIMESTAMP('2024-01-01 00:00:00', 'America/Los_Angeles')"}],
    ['SPANNER', "DATE(t) < CURRENT_DATE OR d = DATE '2024-01-01'", {sql: "DATE(t, 'America/Los_Angeles') < CURRENT_DATE('America/Los_Angeles') OR d = CAST('2024-01-01' AS DATE)"}],
    ['SPANNER', "CAST('2024-01-01 03:00:00' AS TIMESTAMP) = PARSE_TIMESTAMP('%F %T', ds)", {sql: "CAST(TIMESTAMP('2024-01-01 03:00:00', 'America/Los_Angeles') AS TIMESTAMP) = PARSE_TIMESTAMP('%F %T', ds, 'America/Los_Angeles')"}],
    ['SPANNER', "STRING(CURRENT_TIMESTAMP()) || FORMAT_TIMESTAMP('%F', t, 'UTC')", {sql: "STRING(CURRENT_TIMESTAMP(), 'America/Los_Angeles') || FORMAT_TIMESTAMP('%F', t, 'UTC')"}],
    ['SPANNER', "TIMESTAMP_DIFF(TIMESTAMP_ADD(t, INTERVAL 1 HOUR), t, MINUTE) + DATE_DIFF(DATE(t), d, DAY)", {sql: "TIMESTAMP_DIFF(TIMESTAMP_ADD(t, INTERVAL '1' HOUR), t, MINUTE) + DATE_DIFF(DATE(t, 'America/Los_Angeles'), d, DAY)"}],
    ['SPANNER', "EXTRACT(HOUR FROM t - (INTERVAL 1 HOUR)) + EXTRACT(HOUR FROM IF(s = 'AT', t, t)) -- note", {sql: "EXTRACT(HOUR FROM t - (INTERVAL '1' HOUR) AT TIME ZONE 'America/Los_Angeles') + EXTRACT(HOUR FROM IF(s = 'AT', t, t) AT TIME ZONE 'America/Los_Angeles') /* note */"}],
    ['SPANNER', "TIMESTAMP('2024-01-01T00:00:00Z') < TIMESTAMP '2024-01-01 00:00:00 GMT'", {sql: "TIMESTAMP('2024-01-01T00:00:00Z') < CAST('2024-01-01 00:00:00 GMT' AS TIMESTAMP)"}],
    ['SPANNER', "TIMESTAMP('2024-01-01 10:05:5Z') < TIMESTAMP '2024-01-01 00:00:00 UTC-08:00'", {sql: "TIMESTAMP('2024-01-01 10:05:5Z') < CAST('2024-01-01 00:00:00 UTC-08:00' AS TIMESTAMP)"}],
    ['SPANNER', "EXTRACT(HOUR FROM t - INTERVAL 1 HOUR AT TIME ZONE 'UTC')", {sql: "EXTRACT(HOUR FROM t - INTERVAL '1' HOUR AT TIME ZONE 'UTC')"}],
    ['SPANNER', 'TIMESTAMP(s)', {error: 'kcmd does not translate TIMESTAMP of a value that may be a string with its own time zone'}],
    ['SPANNER', "TIMESTAMP_DIFF(t, '2024-01-01', DAY)", {error: 'kcmd does not translate a date string that Spanner may read as a TIMESTAMP'}],
    ['SPANNER', 'SAFE.DATE(t)', {error: 'kcmd does not translate SAFE.DATE'}],
    ['SPANNER', 'a; b', {error: 'kcmd does not translate a text it cannot read as one expression'}],
    ['SPANNER', 'EXTRACT(DAYOFYEAR FROM d)', {error: 'kcmd does not translate EXTRACT of DAYOFYEAR from a value that may be a TIMESTAMP'}],
    ['SPANNER', 'EXTRACT(WEEK(MONDAY) FROM d)', {error: "kcmd does not translate EXTRACT with part 'WEEK(MONDAY)'"}],
    ['SPANNER', 'EXTRACT(TIMEZONE_HOUR FROM t)', {error: "kcmd does not translate EXTRACT with part 'TIMEZONE_HOUR'"}],
    ['SPANNER', 'DATE_TRUNC(d, WEEK(MONDAY))', {error: "kcmd does not translate DATE_TRUNC with part 'WEEK(MONDAY)'"}],
    ['SPANNER', 'CAST(t AS DATE)', {error: 'kcmd does not translate CAST to DATE of a value that may be a TIMESTAMP'}],
    ['SPANNER', 'CAST(ds AS TIMESTAMP)', {error: 'kcmd does not translate CAST to TIMESTAMP of a value that may be a string or a DATE'}],
    ['SPANNER', "PARSE_DATE('%F', CAST(CAST(t AS DATE) AS STRING))", {error: 'kcmd does not translate CAST to DATE of a value that may be a TIMESTAMP'}],
    ['SPANNER', "DATE('2024-01-01 03:00:00')", {error: 'kcmd does not translate DATE of a string'}],
    ['SPANNER', "t BETWEEN '2024-01-01' AND '2024-02-01 10:00:00'", {error: 'kcmd does not translate BETWEEN of a date string and a value that may be a TIMESTAMP'}],
    // Comments.
    ['SNOWFLAKE', '-- next day\nNVL(d, DATEADD(day, 1, d))', {sql: 'COALESCE(d, DATE_ADD(d, INTERVAL 1 DAY)) /* next day */'}],
    ['POSTGRES', '/* a /* b */ c */ d', {sql: 'd /* a / * b * / c */'}],
    ['SQLSERVER', 'COALESCE(a, b) -- fallback', {sql: 'COALESCE(a, b) /* fallback */'}],
    ['POSTGRES', 'x /*note*/', {sql: 'x /* note */'}],
    ['POSTGRES', "DATE_TRUNC('month' /* c */, d)", {sql: 'DATE_TRUNC(d, MONTH) /* c */'}],
    ['MYSQL', 'COALESCE(ordered_at, NOW())  # when the order was placed', {sql: 'COALESCE(ordered_at, CURRENT_TIMESTAMP()) /* when the order was placed */'}],
    ['MYSQL', "COALESCE(a, 0) # the customer's", {sql: "COALESCE(a, 0) /* the customer's */"}],
    ['MYSQL', 'amount# note', {sql: 'amount /* note */'}],
    ['MYSQL', 'SUM(a)--1 /* a--b */#c', {sql: 'SUM(a) - -1 /* a--b */ /* c */'}],
    ['MYSQL', 'SUM(a) -- a--b /*\n + 1 # c', {sql: 'SUM(a) /* a--b / * */ + 1 /* c */'}],
    ['MYSQL', "CONCAT('😀', a) # a's", {sql: "CONCAT('😀', a) /* a's */"}],
    ['MYSQL', "CONCAT('a#\nb', s) # note", {sql: "CONCAT('a#\\nb', s) /* note */"}],
    ['MYSQL', 'a /* # x\n# y */ + 1 # z', {sql: 'a /* # x\n# y */ + 1 /* z */'}],
    ['MYSQL', 'b /* s3://b/*.csv, s3://c/*.csv */ + 1', {sql: 'b /* s3://b/ *.csv, s3://c/ *.csv */ + 1'}],
    ['MYSQL', "IF(s = '#', `a#b`, c /* # */) # note", {sql: "IF(s = '#', `a#b`, c /* # */) /* note */"}],
    // Constructs off the list.
    ['POSTGRES', "TO_CHAR(d, 'YYYY-MM')", {error: 'kcmd does not translate TO_CHAR'}],
    ['SNOWFLAKE', 'MEDIAN(x)', {error: 'kcmd does not translate MEDIAN'}],
    ['SNOWFLAKE', 'SUM(x) OVER (PARTITION BY y)', {error: 'kcmd does not translate OVER'}],
    ['POSTGRES', 'a % b', {error: 'kcmd does not translate %'}],
    ['POSTGRES', 'SUM(a) / COUNT(*)', {error: 'kcmd does not translate /'}],
    ['SQLSERVER', 'AVG(a)', {error: 'kcmd does not translate AVG'}],
    ['ANSI_SQL', 'AVG("x")', {error: 'kcmd does not translate AVG'}],
    ['SQLSERVER', 'IIF(a > 0, 1, 0)', {error: 'kcmd does not translate IIF'}],
    ['SQLSERVER', 'ISNULL(z, 0)', {error: 'kcmd does not translate ISNULL'}],
    ['POSTGRES', "CONCAT(s, 'x')", {error: 'kcmd does not translate CONCAT'}],
    ['MYSQL', 'LENGTH(s)', {error: 'kcmd does not translate LENGTH'}],
    // The message names a function and a date part as written, though the
    // engine reads them by other names.
    ['MYSQL', 'CHAR_LENGTH(s)', {error: 'kcmd does not translate CHAR_LENGTH'}],
    ['DATABRICKS', 'substr(s, 1, 3)', {error: 'kcmd does not translate substr'}],
    ['SQLSERVER', 'DATEPART(w, d)', {error: "kcmd does not translate DATEPART with part 'w'"}],
    ['DATABRICKS', 'round(x, 2)', {error: 'kcmd does not translate round'}],
    ['DATABRICKS', 'date_sub(t, 1)', {error: 'kcmd does not translate date_sub'}],
    ['DATABRICKS', 'dateadd(DAY, 1, d)', {error: 'kcmd does not translate dateadd'}],
    ['DATABRICKS', 'date_add(DAY, 1, d)', {error: 'kcmd does not translate date_add'}],
    ['DATABRICKS', 'date_add(t, n)', {error: 'kcmd does not translate date_add of a value that may be a TIMESTAMP'}],
    ['ANSI_SQL', '"a" / "b"', {error: 'kcmd does not translate /'}],
    ['ANSI_SQL', 'ROUND("x")', {error: 'kcmd does not translate ROUND'}],
    ['SNOWFLAKE', 'FLOOR(a, 1)', {error: 'kcmd does not translate FLOOR with a scale'}],
    ['POSTGRES', 'x * 1e3', {error: 'kcmd does not translate the number 1e3'}],
    ['POSTGRES', '9223372036854775808 + 1', {error: 'kcmd does not translate the number 9223372036854775808'}],
    ['POSTGRES', "E'a'", {error: 'kcmd does not translate an escape string literal'}],
    ['POSTGRES', 'CAST(a AS VARCHAR)', {error: 'kcmd does not translate CAST to VARCHAR'}],
    ['POSTGRES', 'a::double precision', {error: 'kcmd does not translate CAST to DOUBLE PRECISION'}],
    ['POSTGRES', 'a::timestamp(3)', {error: 'kcmd does not translate CAST to TIMESTAMP(3)'}],
    ['SNOWFLAKE', 'CAST(a AS TIMESTAMP_TZ)', {error: 'kcmd does not translate CAST to TIMESTAMP_TZ'}],
    ['SNOWFLAKE', 'TRY_CAST(a AS TIMESTAMP)', {error: 'kcmd does not translate TRY_CAST to TIMESTAMP'}],
    ['POSTGRES', "CAST('2024-03-15 10:00:00' AS DATE)", {error: "kcmd does not translate CAST to DATE of '2024-03-15 10:00:00'"}],
    ['POSTGRES', "DATE '2024-03-15 10:00:00'", {error: "kcmd does not translate DATE '2024-03-15 10:00:00'"}],
    ['SQLSERVER', 'TRY_CAST(ds AS DATE)', {error: 'kcmd does not translate TRY_CAST to DATE of a column'}],
    ['MYSQL', 'COUNT(DISTINCT a, b)', {error: 'kcmd does not translate COUNT of more than one value'}],
    ['POSTGRES', 'SUM(x) FILTER (WHERE y > 0)', {error: 'kcmd does not translate SUM with FILTER'}],
    ['SNOWFLAKE', 'COUNT(x) IGNORE NULLS', {error: 'kcmd does not translate COUNT with IGNORE NULLS or RESPECT NULLS'}],
    ['POSTGRES', "TIMESTAMP '2024-01-01 10:00:00'", {error: 'kcmd does not translate a timestamp literal'}],
    ['SNOWFLAKE', "s LIKE 'a\\\\_b'", {error: 'kcmd does not translate LIKE with a backslash in its pattern'}],
    ['SQLSERVER', "s LIKE '[a-c]%' -- first letters", {error: 'kcmd does not translate LIKE with a bracket in its pattern'}],
    ['SQLSERVER', "s NOT LIKE '%[0-9]%'", {error: 'kcmd does not translate NOT LIKE with a bracket in its pattern'}],
    ['DATABRICKS', "s = 'it''s'", {error: "kcmd does not translate a string with ''"}],
    ['MYSQL', "s LIKE '%\\_%'", {error: 'kcmd does not translate a string with \\_'}],
    ['MYSQL', 'a /*!50000 + 1 */', {error: 'kcmd does not translate a MySQL executable comment'}],
    ['MYSQL', 'a /*+ BKA(t) */', {error: 'kcmd does not translate a MySQL optimizer hint'}],
    ['POSTGRES', 'TRIM(BOTH FROM s)', {error: 'kcmd does not translate TRIM with BOTH, LEADING or TRAILING'}],
    // The message keeps an infix NOT in the operator's name.
    ['POSTGRES', "s NOT LIKE 'a%' ESCAPE '!'", {error: 'kcmd does not translate NOT LIKE with ESCAPE'}],
    ['POSTGRES', 's NOT IN (SELECT 1)', {error: 'kcmd does not translate NOT IN with a subquery'}],
    ['POSTGRES', 'n NOT BETWEEN SYMMETRIC 1 AND 2', {error: 'kcmd does not translate NOT BETWEEN with SYMMETRIC'}],
    ['POSTGRES', "s NOT ILIKE 'a%'", {error: 'kcmd does not translate NOT ILIKE'}],
    ['DATABRICKS', "s NOT RLIKE 'a'", {error: 'kcmd does not translate NOT RLIKE'}],
    // A prefix NOT is its own operator, so the message names the node it wraps.
    ['POSTGRES', 'NOT s IN (SELECT 1)', {error: 'kcmd does not translate IN with a subquery'}],
    ['POSTGRES', 'NOT n BETWEEN SYMMETRIC 1 AND 2', {error: 'kcmd does not translate BETWEEN with SYMMETRIC'}],
    ['DATABRICKS', 'NOT MAX(b) FILTER (WHERE y > 0)', {error: 'kcmd does not translate MAX with FILTER'}],
    ['POSTGRES', "DATE_TRUNC('decade', d)", {error: "kcmd does not translate DATE_TRUNC with part 'decade'"}],
    // The part is not a column named like it, and has no parentheses.
    ['SPANNER', "DATE_TRUNC(d, 'D')", {error: "kcmd does not translate DATE_TRUNC with part 'D'"}],
    ['SPANNER', "TIMESTAMP_TRUNC(year, 'YEAR')", {error: "kcmd does not translate TIMESTAMP_TRUNC with part 'YEAR'"}],
    ['SPANNER', 'DATE_TRUNC(week, (WEEK))', {error: "kcmd does not translate DATE_TRUNC with part 'WEEK'"}],
    ['POSTGRES', "DATE_TRUNC(('decade'), d)", {error: "kcmd does not translate DATE_TRUNC with part 'decade'"}],
    ['SQLSERVER', 'DATEPART(wk, week)', {error: "kcmd does not translate DATEPART with part 'wk'"}],
    ['POSTGRES', 'EXTRACT(DOW FROM d)', {error: "kcmd does not translate EXTRACT with part 'DOW'"}],
    ['POSTGRES', 'EXTRACT(week(monday) FROM d)', {error: "kcmd does not translate EXTRACT with part 'week(monday)'"}],
    ['POSTGRES', 'EXTRACT(DAY FROM shipped - ordered)', {error: 'kcmd does not translate EXTRACT of a difference'}],
    ['MYSQL', 'YEAR(COALESCE(d + 1, d))', {error: 'kcmd does not translate YEAR of an expression'}],
    ['MYSQL', "YEAR('2024-01-31')", {error: 'kcmd does not translate YEAR of a string'}],
    ['SQLSERVER', 'YEAR(DATEADD(day, 1, d))', {error: 'kcmd does not translate YEAR of DATEADD'}],
    ['SNOWFLAKE', 'YEAR(t::TIMESTAMP_LTZ)', {error: 'kcmd does not translate CAST to TIMESTAMP_LTZ'}],
    ['SNOWFLAKE', "DATEADD('hour', -2, t)", {error: "kcmd does not translate DATEADD with part 'hour'"}],
    ['SNOWFLAKE', 'DATEADD(day, 1.5, d)', {error: 'kcmd does not translate DATEADD of a fraction'}],
    ['POSTGRES', "NOW() - INTERVAL '1 month'", {error: 'kcmd does not translate - of NOW'}],
    ['POSTGRES', "d + INTERVAL '1.5' DAY", {error: 'kcmd does not translate INTERVAL 1.5 DAY'}],
    ['MYSQL', 'd + INTERVAL -1.5 DAY', {error: 'kcmd does not translate INTERVAL -1.5 DAY'}],
    ['POSTGRES', "d + INTERVAL '1:30' HOUR TO MINUTE", {error: 'kcmd does not translate INTERVAL 1:30 HOUR TO MINUTE'}],
    ['SNOWFLAKE', "d + INTERVAL '1' DAY(9) TO SECOND(3)", {error: 'kcmd does not translate INTERVAL 1 DAY(9) TO SECOND(3)'}],
    ['POSTGRES', "d + INTERVAL '1' DAY TO SECOND(3)", {error: 'kcmd does not translate INTERVAL 1 DAY TO SECOND(3)'}],
    ['DATABRICKS', "d + INTERVAL '2' SECOND(3)", {error: 'kcmd does not translate INTERVAL 2 SECOND(3)'}],
    ['SPANNER', "d + INTERVAL '''1''' DAY", {error: 'kcmd does not translate a triple quoted string literal'}],
    ['POSTGRES', "2 * INTERVAL '1 day'", {error: 'kcmd does not translate INTERVAL'}],
    ['MYSQL', "'2024-01-01' + INTERVAL 1 DAY", {error: 'kcmd does not translate + of a string'}],
    ['MYSQL', '-20240101 + INTERVAL 1 DAY', {error: 'kcmd does not translate + of a number'}],
    ['MYSQL', "DATE '2024-01-31' + INTERVAL 1 DAY", {error: 'kcmd does not translate + of a DATE literal'}],
    ['MYSQL', 'd + 1 + INTERVAL 1 DAY', {error: 'kcmd does not translate + of a sum'}],
    ['MYSQL', 'd - 1 - INTERVAL 1 DAY', {error: 'kcmd does not translate - of a difference'}],
    ['MYSQL', 'COALESCE(d - 1, d) + INTERVAL 1 DAY', {error: 'kcmd does not translate + of an expression'}],
    ['MYSQL', 'd + 1 + INTERVAL 1 HOUR', {error: 'kcmd does not translate + of a sum'}],
    ['MYSQL', "INTERVAL 1 DAY + '2 day'", {error: 'kcmd does not translate + of an INTERVAL'}],
    ['MYSQL', 'INTERVAL 1 DAY - d', {error: 'kcmd does not translate - with INTERVAL 1 DAY first'}],
    ['MYSQL', 'd + INTERVAL n DAY', {error: 'kcmd does not translate INTERVAL of a column'}],
    ['MYSQL', 'd + INTERVAL -9223372036854775808 DAY', {error: 'kcmd does not translate the number 9223372036854775808'}],
    ['MYSQL', 'd + INTERVAL 1 MICROSECOND', {error: 'kcmd does not translate INTERVAL 1 MICROSECOND'}],
    ['MYSQL', 'd + INTERVAL 1 MONTH', {error: 'kcmd does not translate + INTERVAL 1 MONTH on a value that may be a TIMESTAMP'}],
    ['MYSQL', 'DATE_SUB(CURDATE(), INTERVAL 1 DAY) - INTERVAL 1 MONTH', {sql: "DATE_SUB(DATE_SUB(CURRENT_DATE, INTERVAL '1' DAY), INTERVAL '1' MONTH)"}],
    ['MYSQL', 'DATE_SUB(DATE_SUB(CURDATE(), INTERVAL 1 DAY), INTERVAL 1 MONTH)', {error: 'kcmd does not translate DATE_SUB of DATE_SUB'}],
    ['DATABRICKS', 'd - INTERVAL 1 WEEK', {error: 'kcmd does not translate - INTERVAL 1 WEEK on a value that may be a TIMESTAMP'}],
    ['MYSQL', 'COALESCE(i, INTERVAL 1 DAY) + INTERVAL 1 DAY', {error: 'kcmd does not translate + of an expression'}],
    ['POSTGRES', "COALESCE(i, INTERVAL '1 day') + INTERVAL '1 day'", {error: 'kcmd does not translate + of an expression'}],
    ['SNOWFLAKE', "IFF(a, INTERVAL '1 day', i) + INTERVAL '1 day'", {error: 'kcmd does not translate + of an expression'}],
    ['DATABRICKS', 'IF(flag, INTERVAL 1 HOUR + INTERVAL 2 HOUR, i) + INTERVAL 1 DAY', {error: 'kcmd does not translate + of an expression'}],
    ['ANSI_SQL', `COALESCE("i", INTERVAL '1' DAY) + INTERVAL '1' DAY`, {error: 'kcmd does not translate + INTERVAL 1 DAY, which gives a DATE in some databases and a timestamp in others'}],
    ['DATABRICKS', 'd + INTERVAL 1 DAY + INTERVAL 2 HOUR', {error: 'kcmd does not translate + INTERVAL 2 HOUR, which gives a TIMESTAMP for a DATE in Databricks and a DATETIME in BigQuery'}],
    ['ANSI_SQL', `"d" + INTERVAL '1' DAY`, {error: 'kcmd does not translate + INTERVAL 1 DAY, which gives a DATE in some databases and a timestamp in others'}],
    ['POSTGRES', 'a AS b', {error: 'kcmd does not translate a text it cannot read as one expression'}],
    ['POSTGRES', 'flag = n BETWEEN 1 AND 2', {error: 'kcmd does not translate = and BETWEEN without parentheses, which databases group in different orders'}],
    ['MYSQL', 'n BETWEEN 1 AND 2 IS NULL', {error: 'kcmd does not translate BETWEEN and IS NULL without parentheses, which databases group in different orders'}],
    ['DATABRICKS', "s LIKE 'a%' = TRUE", {error: 'kcmd does not translate LIKE and = without parentheses, which databases group in different orders'}],
    ['SNOWFLAKE', 'a = b IS NULL', {error: 'kcmd does not translate = and IS NULL without parentheses, which databases group in different orders'}],
    ['POSTGRES', "a = b NOT LIKE 'a%'", {error: 'kcmd does not translate = and NOT LIKE without parentheses, which databases group in different orders'}],
    // A prefix NOT before LIKE, which most dialects read as unparsed SQL,
    // named as written, keeping its operand and letter case.
    ['POSTGRES', "NOT s LIKE 'a%'", {error: "kcmd does not translate NOT s LIKE 'a%'"}],
    ['POSTGRES', "NOT x LIKE 'a%'", {error: "kcmd does not translate NOT x LIKE 'a%'"}],
    // Values whose types import cannot see.
    ['POSTGRES', 'a - b', {error: 'kcmd does not translate - without a number, SUM, COUNT or AVG on one side'}],
    ['SQLSERVER', "first_name + ' '", {error: 'kcmd does not translate + of a string'}],
    ['MYSQL', 'CURDATE() - 7', {error: 'kcmd does not translate - of a date'}],
    ['MYSQL', 'INTERVAL 1 DAY + d - 1', {error: 'kcmd does not translate - of a date'}],
    ['MYSQL', 'd - INTERVAL 1 DAY - 1', {error: 'kcmd does not translate - of a date'}],
    ['MYSQL', 'DATE_ADD(d, INTERVAL 1 DAY) - 1', {error: 'kcmd does not translate - of a date'}],
    ['SQLSERVER', 'DATEADD(day, 1, GETDATE()) - 1', {error: 'kcmd does not translate - of a date'}],
    ['SQLSERVER', 'GETDATE() - 7', {error: 'kcmd does not translate - of a date'}],
    ['POSTGRES', 'CURRENT_DATE - 7 - 1', {error: 'kcmd does not translate - of a date'}],
    ['POSTGRES', 'CURRENT_DATE * 7', {error: 'kcmd does not translate * of a date'}],
    ['SNOWFLAKE', 'CURRENT_DATE - 1.5', {error: 'kcmd does not translate - of a date'}],
    ['MYSQL', 'COALESCE(e, CASE WHEN a > 0 THEN IF(a > 1, MIN(NULLIF(MAX(d + INTERVAL 1 DAY), e)), d) END) - 1', {error: 'kcmd does not translate - of a date'}],
    ['SNOWFLAKE', 'CASE WHEN a > 0 THEN e ELSE IFF(a > 1, e, NVL(e, CURRENT_DATE)) END - 1', {error: 'kcmd does not translate - of a date'}],
    ['SNOWFLAKE', "DATE_TRUNC('month', d) - 1", {error: 'kcmd does not translate - of a date'}],
    ['MYSQL', 'SUM(a > 2)', {error: 'kcmd does not translate SUM of a comparison'}],
    ['MYSQL', 'MAX(a > 2)', {error: 'kcmd does not translate MAX of a comparison'}],
    ['MYSQL', 'COALESCE(a > b, 0)', {error: 'kcmd does not translate COALESCE of a comparison'}],
    ['MYSQL', "a || ' ' || b", {error: 'kcmd does not translate OR of a string'}],
    ['DATABRICKS', "flag = s IN ('a', 'b')", {error: 'kcmd does not translate IN of a comparison'}],
    ['MYSQL', "flag = s NOT LIKE 'a%'", {error: 'kcmd does not translate NOT LIKE of a comparison'}],
    ['MYSQL', '(a = b) IS NOT TRUE', {error: 'kcmd does not translate IS NOT TRUE'}],
    ['MYSQL', '(a = b) <=> c', {error: 'kcmd does not translate <=>'}],
    ['POSTGRES', 'd::date < now()', {error: 'kcmd does not translate < on a DATE and a TIMESTAMP'}],
    ['POSTGRES', 'd::date NOT BETWEEN a AND now()', {error: 'kcmd does not translate NOT BETWEEN on a DATE and a TIMESTAMP'}],
    ['MYSQL', 'CURDATE() - INTERVAL 1 QUARTER < NOW()', {error: 'kcmd does not translate < on a DATE and a TIMESTAMP'}],
    ['POSTGRES', "t::timestamptz >= CURRENT_DATE - INTERVAL '1 month'", {error: 'kcmd does not translate >= on a DATETIME and a TIMESTAMP'}],
    ['POSTGRES', 'CURRENT_DATE - 7 < NOW()', {error: 'kcmd does not translate < on a DATE and a TIMESTAMP'}],
    ['MYSQL', 'DATE_SUB(CURDATE(), INTERVAL 1 MONTH) < NOW()', {error: 'kcmd does not translate < on a DATE and a TIMESTAMP'}],
    ['SQLSERVER', 'DATEADD(day, 1, CAST(d AS DATE)) < GETDATE()', {error: 'kcmd does not translate < on a DATE and a TIMESTAMP'}],
    ['DATABRICKS', 'date_add(d, 1) < current_timestamp()', {error: 'kcmd does not translate < on a DATE and a TIMESTAMP'}],
    ['MYSQL', 'DATE_ADD(CURDATE(), INTERVAL 1 HOUR) < NOW()', {error: 'kcmd does not translate DATE_ADD with INTERVAL 1 HOUR'}],
    // Date, format and conversion functions off the list.
    ['SQLSERVER', 'DATEADD(month, -1, GETDATE())', {error: 'kcmd does not translate DATEADD of a month to a value that may be a TIMESTAMP'}],
    ['MYSQL', 'DAYNAME(order_date)', {error: 'kcmd does not translate DAYNAME'}],
    ['SQLSERVER', 'CONVERT(varchar(10), d, 103)', {error: 'kcmd does not translate CONVERT'}],
    ['DATABRICKS', "to_date(s, 'yyyy-MM-dd HH:mm:ss')", {error: 'kcmd does not translate to_date'}],
    ['SNOWFLAKE', 'TO_TIMESTAMP(n, 3)', {error: 'kcmd does not translate TO_TIMESTAMP'}],
    ['SQLSERVER', "FORMAT(d, 'yyyy-MM')", {error: 'kcmd does not translate FORMAT'}],
    ['MYSQL', 'LAST_DAY(CURDATE())', {error: 'kcmd does not translate LAST_DAY'}],
    ['DATABRICKS', 'datediff(a, b)', {error: 'kcmd does not translate datediff'}],
    ['DATABRICKS', 'datediff(MONTH, a, b)', {error: 'kcmd does not translate datediff'}],
    ['SNOWFLAKE', 'DATEADD(week, -1, CURRENT_TIMESTAMP())', {error: "kcmd does not translate DATEADD with part 'week'"}],
    ['SNOWFLAKE', 'ADD_MONTHS(CURRENT_DATE(), -1)', {error: 'kcmd does not translate ADD_MONTHS'}],
    ['SNOWFLAKE', 'DATEADD(m, 30, CURRENT_DATE)', {error: "kcmd does not translate DATEADD with part 'm'"}],
    ['SQLSERVER', 'DATEDIFF(dd, a, b)', {error: "kcmd does not translate DATEDIFF with part 'dd'"}],
    ['SQLSERVER', 'DATEADD(day, DATEDIFF(day, 0, GETDATE()), 0)', {error: 'kcmd does not translate DATEADD of a number'}],
    ['SQLSERVER', 'TRY_CONVERT(date, s)', {error: 'kcmd does not translate TRY_CONVERT'}],
    ['MYSQL', 'TO_DAYS(d)', {error: 'kcmd does not translate TO_DAYS'}],
    ['DATABRICKS', 'make_date(2024, 2, 30)', {error: 'kcmd does not translate make_date'}],
    ['SNOWFLAKE', 'TO_NUMBER(s)', {error: 'kcmd does not translate TO_NUMBER'}],
  ] as const)('translates %s %s, or leaves it untranslated', async (dialect, expression, want) => {
    expect(await polyglotTranspiler([{id: '0', dialect, expression}], 'BIGQUERY'))
        .toEqual([{id: '0', ...want}]);
  });

  test('reports an error when the engine cannot write the repaired SQL', async () => {
    const generate = spyOn(await loadSqlEngine(), 'generate')
                         .mockReturnValue({success: false, error: 'boom'});
    try {
      expect(await polyglotTranspiler(
                 [{id: '0', dialect: 'POSTGRES', expression: "DATE_TRUNC('month', d)"}],
                 'BIGQUERY'))
          .toEqual([{id: '0', error: 'boom'}]);
    } finally {
      generate.mockRestore();
    }
  });

  // A canary for the repairs above. It calls the engine directly, without
  // the adapter, and expects the broken BigQuery it writes today. When an
  // engine upgrade makes this fail, the engine translates that form itself:
  // delete its repair from "BigQuery repairs" in transpile.ts, and its case
  // here.
  test('the engine still writes the forms the adapter repairs unchanged', async () => {
    const engine = await loadSqlEngine();
    const unchanged = [
      ['postgresql', "DATE_TRUNC('month', d)", "DATE_TRUNC('month', d)"],
      ['postgresql', "date_part('year', d)", "DATE_PART('year', d)"],
      ['postgresql', "d + INTERVAL '1 day'", "d + INTERVAL '1 day'"],
      ['mysql', 'd + INTERVAL 1 DAY', "d + INTERVAL '1' DAY"],
      ['tsql', 'YEAR(DATEADD(day, 1, d))', 'YEAR(DATEADD(day, 1, d))'],
      ['mysql', 'QUARTER(d)', 'QUARTER(d)'],
      ['snowflake', 'd::TIMESTAMP_NTZ', 'CAST(d AS TIMESTAMPNTZ)'],
      ['bigquery', 'EXTRACT(DAYOFWEEK FROM t)', 'EXTRACT(DOW FROM t)'],
      ['databricks', 'a = b = c', 'a = b = c'],
      ['postgresql', 'a = b IS NULL', 'a = b IS NULL'],
      ['postgresql', 'TRIM(s) || 0.29', 'TRIM(s) || 0.29'],
    ];
    expect(unchanged.map(([dialect, sql]) => [
      dialect, sql, engine.transpile(sql, dialect, 'bigquery').sql?.[0],
    ])).toEqual(unchanged);
    // The engine reads BigQuery's TIMESTAMP back without its time zone.
    expect(engine.generate([sqlExpressionTree('CAST(x AS TIMESTAMP)', 'BIGQUERY')], 'bigquery')
               .sql?.[0]).toBe('CAST(x AS DATETIME)');
  });

  test('leaves a field it refuses without a BIGQUERY entry, with a warning', async () => {
    const field = (name: string, expression: string): Field =>
        ({name, dialects: [{dialect: 'POSTGRES', expression}], stringForm: false});
    const {model, warnings} = await transpileModel(ordersModel([
      field('month', "DATE_TRUNC('month', orders.d)"),
      field('label', "TO_CHAR(orders.d, 'YYYY-MM')"),
    ]));
    expect(model.entities[0].fields.map(f => f.dialects)).toEqual([
      [
        {dialect: 'POSTGRES', expression: "DATE_TRUNC('month', orders.d)"},
        {dialect: 'BIGQUERY', expression: 'DATE_TRUNC(orders.d, MONTH)'},
      ],
      [{dialect: 'POSTGRES', expression: "TO_CHAR(orders.d, 'YYYY-MM')"}],
    ]);
    expect(warnings).toEqual([
      "field 'orders.month': transpiled 'POSTGRES' -> 'BIGQUERY'",
      "field 'orders.label': could not transpile 'POSTGRES' -> 'BIGQUERY' " +
          '(kcmd does not translate TO_CHAR); left untranslated',
    ]);
  });

  test('reports a parse error per request rather than throwing', async () => {
    const [res] = await polyglotTranspiler(
        [{id: '0', dialect: 'SNOWFLAKE', expression: 'SELECT SELECT ((('}],
        'BIGQUERY');
    // Whatever the engine makes of it, the adapter must return a single
    // correlated response and never reject.
    expect(res.id).toBe('0');
    expect(res.error).toBeDefined();
  });
});

describe('mysqlForEngine', () => {
  test('reads past a line that ends in an open string before it rewrites a # after it', async () => {
    await loadSqlEngine();
    // The engine reads $$ as a string that runs to the end of the text.
    expect(mysqlForEngine('a $$# x\n b # c')).toBe('a $$# x\n b # c');
  });
});
