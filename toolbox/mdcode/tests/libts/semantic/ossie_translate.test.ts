// Tests for the translator of OSSIE_SQL_2026 texts into BigQuery's SQL,
// src/libts/semantic/ossie_translate.ts, and for the routing of such texts to
// it in src/libts/semantic/transpile.ts.

import {describe, expect, test} from 'bun:test';

import {Field, SemanticModel} from '../../../src/libts/semantic/ir';
import {ossieToBigQuery} from '../../../src/libts/semantic/ossie_translate';
import {loadSqlEngine} from '../../../src/libts/semantic/sql_parser';
import {bigQueryTranslation, transpileModel} from '../../../src/libts/semantic/transpile';

// The reminder of each form whose value can differ from the source's.
const REMINDER = {
  SPLIT_PART: "SPLIT_PART: BigQuery's SPLIT gives NULL past the last part and for a negative part, where the source may give '' and count a negative part from the end; check the BIGQUERY entry.",
  SUBSTRING: 'SUBSTRING: BigQuery reads a start of 0 as 1 and counts a negative start from the end, where the source shortens the substring for a start below 1; check the BIGQUERY entry.',
  REGEXP_EXTRACT: 'REGEXP_EXTRACT: BigQuery gives the match of a capturing group where the pattern has one, where the source gives the whole match; check the BIGQUERY entry.',
  VARCHAR: 'CAST to VARCHAR(n): BigQuery cuts the text of any value to n characters, where the source raises an error, or TRY_CAST gives NULL, for a longer value that is not a string; check the BIGQUERY entry.',
  EXTRACT_SECOND: "EXTRACT(SECOND) and DATE_PART('second'): BigQuery gives whole seconds, where the source keeps the fraction; check the BIGQUERY entry.",
  PERCENTILE: "MEDIAN, PERCENTILE_CONT and PERCENTILE_DISC without OVER: BigQuery's APPROX_QUANTILES gives an approximate value, where the source gives the exact one; check the BIGQUERY entry.",
};

// An OSSIE_SQL_2026 text, then its BigQuery SQL and its reminders, or the
// message for a text kcmd does not translate. The texts read the columns x,
// y and n (INT64), amount (FLOAT64), s, p and region (STRING), d (DATE), ts
// (TIMESTAMP), b (BOOL) and range (INT64) of a table named orders. Any other
// column is an INT64.
type Row = [string, string, ...(keyof typeof REMINDER)[]];

const ROWS: Row[] = [
  // Operators, predicates, CASE, literals and names.
  ['-x + +y * (n - 1) / 2', '-x + +y * (n - 1) / 2'],
  ['x % 2 = 1 OR NOT b AND x <> y', 'MOD(x, 2) = 1 OR NOT b AND x <> y'],
  ['x <= y AND x >= y AND (x < y OR x > y)', 'x <= y AND x >= y AND (x < y OR x > y)'],
  ['- -x', '- -x'],
  ['NOT s LIKE \'a%\' AND NOT x IN (1) AND NOT NOT b', 'NOT (s LIKE \'a%\') AND NOT (x IN (1)) AND NOT (NOT b)'],
  ['s || \'-\' || s', 's || \'-\' || s'],
  ['x BETWEEN 1 AND 3 AND x NOT BETWEEN y AND n', 'x BETWEEN 1 AND 3 AND x NOT BETWEEN y AND n'],
  ['x IN (1, 2) AND x NOT IN (3)', 'x IN (1, 2) AND x NOT IN (3)'],
  ['s LIKE \'a%\' AND s NOT LIKE p', 's LIKE \'a%\' AND s NOT LIKE p'],
  ['s ILIKE \'A%\' OR s NOT ILIKE p', 'LOWER(s) LIKE LOWER(\'A%\') OR LOWER(s) NOT LIKE LOWER(p)'],
  ['s IS NULL OR s IS NOT NULL', 's IS NULL OR s IS NOT NULL'],
  ['x IS DISTINCT FROM y AND x IS NOT DISTINCT FROM n', 'x IS DISTINCT FROM y AND x IS NOT DISTINCT FROM n'],
  ['CASE WHEN x > 1 THEN \'a\' WHEN x > 0 THEN \'b\' ELSE \'c\' END', 'CASE WHEN x > 1 THEN \'a\' WHEN x > 0 THEN \'b\' ELSE \'c\' END'],
  ['CASE x WHEN 1 THEN \'one\' END', 'CASE x WHEN 1 THEN \'one\' END'],
  ['1.5 + .5 + 1e3 + amount', '1.5 + .5 + 1e3 + amount'],
  ['\'it\'\'s\' || \'a\\b\'', '\'it\\\'s\' || \'a\\\\b\''],
  ['"Amount" + range + orders.x', '`Amount` + `range` + orders.x'],
  ['COUNT(date.date_key) + COUNT(current_datetime)', 'COUNT(`date`.date_key) + COUNT(`current_datetime`)'],
  ['DATE \'2024-01-15\' < CURRENT_DATE', 'DATE \'2024-01-15\' < CURRENT_DATE()'],
  ['TIME \'10:30:00\' < CURRENT_TIME()', 'TIME \'10:30:00\' < CURRENT_TIME()'],
  ['TIMESTAMP_NTZ \'2024-01-15 10:30:00\'', 'DATETIME \'2024-01-15 10:30:00\''],
  ['SUM(x) -- total', 'SUM(x) /* total */'],
  ['SUM(x) -- a /* b */', 'SUM(x) /* a / * b * / */'],

  // Casts.
  ['CAST(x AS INTEGER) + CAST(x AS INT) + CAST(x AS BIGINT)', 'CAST(x AS INT64) + CAST(x AS INT64) + CAST(x AS INT64)'],
  ['CAST(amount AS DECIMAL) + CAST(amount AS NUMERIC(10, 2)) + CAST(x AS FLOAT) + TRY_CAST(s AS DOUBLE)',
   'CAST(amount AS NUMERIC) + CAST(amount AS NUMERIC(10, 2)) + CAST(x AS FLOAT64) + SAFE_CAST(s AS FLOAT64)'],
  ['CAST(x AS VARCHAR) || CAST(b AS STRING)', 'CAST(x AS STRING) || CAST(b AS STRING)'],
  ['CAST(s AS BOOLEAN)', 'CAST(s AS BOOL)'],
  ['CAST(s AS DATE)', 'CAST(s AS DATE)'],
  ['CAST(s AS TIME)', 'CAST(s AS TIME)'],
  ['CAST(s AS TIMESTAMP_NTZ)', 'CAST(s AS DATETIME)'],
  ['CAST(amount AS DECIMAL(38, 2)) + CAST(s AS NUMERIC(30))', 'CAST(amount AS BIGNUMERIC(38, 2)) + CAST(s AS BIGNUMERIC(30))'],
  ['TRY_CAST(s AS DECIMAL(4, 0))', 'kcmd does not translate TRY_CAST to DECIMAL(4, 0)'],
  ['CAST(amount AS DECIMAL(80, 2))', 'kcmd does not translate CAST to DECIMAL(80, 2)'],
  ['CAST(x AS VARCHAR(1.5))', 'kcmd does not translate CAST to VARCHAR(1.5)'],

  // Aggregates.
  ['SUM(x) + COUNT(x) + COUNT(*) + AVG(x) + MIN(x) + MAX(x)', 'SUM(x) + COUNT(x) + COUNT(*) + AVG(x) + MIN(x) + MAX(x)'],
  ['STDDEV(x) + STDDEV_POP(x) + STDDEV_SAMP(x) + VARIANCE(x) + VAR_POP(x) + VAR_SAMP(x) + APPROX_COUNT_DISTINCT(x)',
   'STDDEV(x) + STDDEV_POP(x) + STDDEV_SAMP(x) + VARIANCE(x) + VAR_POP(x) + VAR_SAMP(x) + APPROX_COUNT_DISTINCT(x)'],
  ['COUNT(DISTINCT x) + SUM(DISTINCT x)', 'COUNT(DISTINCT x) + SUM(DISTINCT x)'],
  ['SUM(x) FILTER (WHERE b) + COUNT(*) FILTER (WHERE b) + COUNT(DISTINCT x) FILTER (WHERE b)',
   'SUM(IF(b, x, NULL)) + COUNT(IF(b, 1, NULL)) + COUNT(DISTINCT IF(b, x, NULL))'],
  ['MEDIAN(x)', 'APPROX_QUANTILES(x, 100)[OFFSET(50)]', 'PERCENTILE'],
  ['PERCENTILE_DISC(0.975) WITHIN GROUP (ORDER BY x)', 'APPROX_QUANTILES(x, 1000)[OFFSET(975)]', 'PERCENTILE'],
  ['APPROX_PERCENTILE(x, 0.5)', 'APPROX_QUANTILES(x, 100)[OFFSET(50)]'],
  ['PERCENTILE_CONT(125E-3) WITHIN GROUP (ORDER BY x)', 'APPROX_QUANTILES(x, 1000)[OFFSET(125)]', 'PERCENTILE'],
  ['MEDIAN(x) OVER (PARTITION BY region)', 'PERCENTILE_CONT(x, 0.5) OVER (PARTITION BY region)'],
  ['PERCENTILE_CONT(1 / 4) WITHIN GROUP (ORDER BY x) OVER ()', 'PERCENTILE_CONT(x, 0.25) OVER ()'],
  ['PERCENTILE_DISC(0.5) WITHIN GROUP (ORDER BY x) OVER ()', 'PERCENTILE_DISC(x, 0.5) OVER ()'],

  // Window functions, with the NULL placement Ossie requires.
  ['ROW_NUMBER() OVER (ORDER BY x) + RANK() OVER (ORDER BY x DESC)',
   'ROW_NUMBER() OVER (ORDER BY x NULLS LAST) + RANK() OVER (ORDER BY x DESC NULLS FIRST)'],
  ['DENSE_RANK() OVER (ORDER BY x ASC) + PERCENT_RANK() OVER (ORDER BY x NULLS FIRST) + CUME_DIST() OVER (ORDER BY x DESC NULLS LAST)',
   'DENSE_RANK() OVER (ORDER BY x ASC NULLS LAST) + PERCENT_RANK() OVER (ORDER BY x NULLS FIRST) + CUME_DIST() OVER (ORDER BY x DESC NULLS LAST)'],
  ['LAG(x) OVER (PARTITION BY region ORDER BY x) + LEAD(x, 2, 0) OVER (ORDER BY x)',
   'LAG(x) OVER (PARTITION BY region ORDER BY x NULLS LAST) + LEAD(x, 2, 0) OVER (ORDER BY x NULLS LAST)'],
  ['SUM(x) OVER (ORDER BY x ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)',
   'SUM(x) OVER (ORDER BY x NULLS LAST ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)'],
  ['SUM(x) OVER (ORDER BY x)', 'SUM(x) OVER (ORDER BY x IS NULL, x)'],
  ['FIRST_VALUE(x) OVER (ORDER BY x + 1 DESC RANGE UNBOUNDED PRECEDING)',
   'FIRST_VALUE(x) OVER (ORDER BY x + 1 IS NULL DESC, x + 1 DESC RANGE UNBOUNDED PRECEDING)'],
  ['LAST_VALUE(x) OVER (ORDER BY x NULLS FIRST RANGE BETWEEN 1 PRECEDING AND 1 FOLLOWING)',
   'LAST_VALUE(x) OVER (ORDER BY x NULLS FIRST RANGE BETWEEN 1 PRECEDING AND 1 FOLLOWING)'],
  ['SUM(x) OVER (ORDER BY x RANGE BETWEEN 1 PRECEDING AND CURRENT ROW)',
   'kcmd does not translate a RANGE frame with an offset, where BigQuery cannot put NULL last after ASC'],

  // Window forms BigQuery refuses.
  ['MEDIAN(x) OVER (ORDER BY x)', 'kcmd does not translate MEDIAN over a window with ORDER BY or a frame'],
  ['MEDIAN(DISTINCT x) OVER ()', 'kcmd does not translate MEDIAN with DISTINCT and OVER'],
  ['STDDEV(DISTINCT x) OVER (PARTITION BY region)', 'kcmd does not translate STDDEV with DISTINCT and OVER'],
  ['COUNT(DISTINCT x) OVER (ORDER BY x)', 'kcmd does not translate COUNT with DISTINCT over a window with ORDER BY or a frame'],
  ['APPROX_COUNT_DISTINCT(x) OVER (PARTITION BY region)', 'kcmd does not translate APPROX_COUNT_DISTINCT with OVER'],
  ['ROW_NUMBER()', 'kcmd does not translate ROW_NUMBER without OVER'],
  ['RANK() OVER (ORDER BY x ROWS UNBOUNDED PRECEDING)', 'kcmd does not translate RANK with a frame'],

  // Constant folding where BigQuery takes only a literal.
  ['LAG(x, 1 + 1) OVER (ORDER BY x)', 'LAG(x, 2) OVER (ORDER BY x NULLS LAST)'],
  ['NTILE(CAST(2.4 AS INTEGER)) OVER (ORDER BY x)', 'NTILE(2) OVER (ORDER BY x NULLS LAST)'],
  ['NTH_VALUE(x, ABS(-2)) OVER (ORDER BY x ROWS BETWEEN (1 + 1) PRECEDING AND CURRENT ROW)',
   'NTH_VALUE(x, 2) OVER (ORDER BY x NULLS LAST ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)'],
  ['LAG(x, n) OVER (ORDER BY x)', 'kcmd does not translate LAG with the offset n, since BigQuery takes only a literal INT64 of 0 or more there'],
  ['LAG(x, 1e2) OVER (ORDER BY x) + SUM(x) OVER (ORDER BY x NULLS FIRST RANGE BETWEEN 1e2 PRECEDING AND CURRENT ROW)',
   'LAG(x, 100) OVER (ORDER BY x NULLS LAST) + SUM(x) OVER (ORDER BY x NULLS FIRST RANGE BETWEEN 100 PRECEDING AND CURRENT ROW)'],
  ['LAG(x, 1 / 2) OVER (ORDER BY x)', 'kcmd does not translate LAG with the offset 1 / 2, since BigQuery takes only a literal INT64 of 0 or more there'],
  ['NTILE(0) OVER (ORDER BY x)', 'kcmd does not translate NTILE with the count 0, since BigQuery takes only a literal INT64 of 1 or more there'],
  ['SUM(x) OVER (ORDER BY x ROWS (2 - 5) PRECEDING)',
   'kcmd does not translate the frame offset (2 - 5), since BigQuery takes only a literal INT64 of 0 or more there'],
  ['SUM(x) OVER (ORDER BY CAST(x AS INTEGER) NULLS FIRST RANGE BETWEEN 1.5 PRECEDING AND CURRENT ROW)',
   'kcmd does not translate the frame offset 1.5, since BigQuery takes only a literal INT64 of 0 or more there'],
  ['LAG(x, 1234567890123456789) OVER (ORDER BY x) + x - 1234567890123456789',
   'LAG(x, 1234567890123456789) OVER (ORDER BY x NULLS LAST) + x - 1234567890123456789'],

  // Date and time functions.
  ['YEAR(d) + QUARTER(d) + MONTH(d) + DAY(d) + DAYOFYEAR(d)',
   'EXTRACT(YEAR FROM d) + EXTRACT(QUARTER FROM d) + EXTRACT(MONTH FROM d) + EXTRACT(DAY FROM d) + EXTRACT(DAYOFYEAR FROM d)'],
  ['HOUR(ts) + MINUTE(ts) + SECOND(ts)', 'EXTRACT(HOUR FROM ts) + EXTRACT(MINUTE FROM ts) + EXTRACT(SECOND FROM ts)'],
  ['EXTRACT(week FROM d) + EXTRACT(MILLISECOND FROM ts)', 'EXTRACT(ISOWEEK FROM d) + EXTRACT(MILLISECOND FROM ts)'],
  ['DATE_PART(\'year\', d) + DATE_PART(dayofweek, d)', 'EXTRACT(YEAR FROM d) + EXTRACT(DAYOFWEEK FROM d)'],
  ['DATE_TRUNC(\'month\', d) < DATE_TRUNC(week, d)', 'DATE_TRUNC(d, MONTH) < DATE_TRUNC(d, ISOWEEK)'],
  ['DATEADD(day, -7, d) < DATEADD(\'week\', 1, d)', 'DATE_ADD(d, INTERVAL -7 DAY) < DATE_ADD(d, INTERVAL 1 WEEK)'],
  ['DATEDIFF(day, d, d) + DATEDIFF(week, d, d)', 'DATE_DIFF(d, d, DAY) + DATE_DIFF(d, d, ISOWEEK)'],
  ['TO_DATE(s) < CURRENT_DATE', 'CAST(s AS DATE) < CURRENT_DATE()'],
  ['TO_TIMESTAMP(s) < CURRENT_TIMESTAMP', 'CAST(s AS TIMESTAMP) < CURRENT_TIMESTAMP()'],
  ['TO_CHAR(d, \'YYYY-MM-DD\') || TO_CHAR(ts, \'DD Mon YYYY HH24:MI\')',
   'FORMAT_DATE(\'%Y-%m-%d\', d) || FORMAT_TIMESTAMP(\'%d %b %Y %H:%M\', ts)'],
  ['TO_DATE(s, \'YYYY-MM-DD\')', 'PARSE_DATE(\'%Y-%m-%d\', s)'],
  ['TO_DATE(s, \'YYYY-MM-DD HH24:MI:SS\')', 'DATE(PARSE_DATETIME(\'%Y-%m-%d %H:%M:%S\', s))'],
  ['TO_TIMESTAMP(s, \'YYYY-MM-DD"T"HH24:MI:SS\')', 'PARSE_TIMESTAMP(\'%Y-%m-%dT%H:%M:%S\', s)'],

  // String functions.
  ['CONCAT(LOWER(s), UPPER(s), TRIM(s), LTRIM(s), RTRIM(s), LEFT(s, 1), RIGHT(s, 1))',
   'CONCAT(LOWER(s), UPPER(s), TRIM(s), LTRIM(s), RTRIM(s), LEFT(s, 1), RIGHT(s, 1))'],
  ['REPLACE(s, \'a\', \'b\') || REGEXP_REPLACE(s, \'a+\', \'b\') || SUBSTRING(s, 2) || SUBSTRING(s, 2, 1)',
   'REPLACE(s, \'a\', \'b\') || REGEXP_REPLACE(s, \'a+\', \'b\') || SUBSTRING(s, 2) || SUBSTRING(s, 2, 1)'],
  ['LENGTH(s) + POSITION(\'a\' IN s) + CHARINDEX(\'a\', s) + REGEXP_COUNT(s, \'a\')',
   'LENGTH(s) + STRPOS(s, \'a\') + STRPOS(s, \'a\') + ARRAY_LENGTH(REGEXP_EXTRACT_ALL(s, \'a\'))'],
  ['CONTAINS(s, \'a\') AND STARTSWITH(s, \'a\') AND ENDSWITH(s, \'a\') AND REGEXP_LIKE(s, \'a\')',
   '(STRPOS(s, \'a\') > 0) AND STARTS_WITH(s, \'a\') AND ENDS_WITH(s, \'a\') AND REGEXP_CONTAINS(s, \'a\')'],
  ['REGEXP_EXTRACT(s, \'(?:a)b\')', 'REGEXP_EXTRACT(s, \'(?:a)b\')'],

  // Numeric functions.
  ['ABS(x) + FLOOR(amount) + CEIL(amount) + CEILING(amount) + SIGN(x) + SQRT(x) + EXP(x) + LN(x) + LOG10(x)',
   'ABS(x) + FLOOR(amount) + CEIL(amount) + CEILING(amount) + SIGN(x) + SQRT(x) + EXP(x) + LN(x) + LOG10(x)'],
  ['SIN(x) + COS(x) + TAN(x) + ASIN(x) + ACOS(x) + ATAN(x) + ATAN2(x, y) + POWER(x, 2) + MOD(x, 2)',
   'SIN(x) + COS(x) + TAN(x) + ASIN(x) + ACOS(x) + ATAN(x) + ATAN2(x, y) + POWER(x, 2) + MOD(x, 2)'],
  ['ROUND(amount) + ROUND(amount, 1) + TRUNC(amount, 1) + TRUNCATE(amount, 1) + LOG(2, x)',
   'ROUND(amount) + ROUND(amount, 1) + TRUNC(amount, 1) + TRUNC(amount, 1) + LOG(x, 2)'],
  ['PI() + RADIANS(x + 1) + DEGREES(x)', 'ACOS(-1) + ((x + 1) * ACOS(-1) / 180) + (x * 180 / ACOS(-1))'],
  ['GREATEST(x, y, 1) + LEAST(x, y)', 'GREATEST(x, y, 1) + LEAST(x, y)'],

  // Conditional functions.
  ['IF(b, x, y) + IFF(b, x, y) + NULLIF(x, 0) + COALESCE(x, y, 0) + IFNULL(x, 0) + NVL(x, 0)',
   'IF(b, x, y) + IF(b, x, y) + NULLIF(x, 0) + COALESCE(x, y, 0) + IFNULL(x, 0) + IFNULL(x, 0)'],
  ['NVL2(x, y, 0) + NVL2(x > 1, 1, 0) + ZEROIFNULL(x) + NULLIFZERO(x)',
   'IF(x IS NULL, 0, y) + IF((x > 1) IS NULL, 0, 1) + IFNULL(x, 0) + NULLIF(x, 0)'],

  // A cast to TIMESTAMP beside a visible TIMESTAMP, and to DATETIME beside a
  // visible DATE and a column.
  ['ts >= DATE \'2024-01-01\' AND ts IN (CURRENT_DATE)',
   'CAST(ts AS DATETIME) >= CAST(DATE \'2024-01-01\' AS DATETIME) AND CAST(ts AS DATETIME) IN (CAST(CURRENT_DATE() AS DATETIME))'],
  ['ts BETWEEN DATE \'2024-01-01\' AND DATE \'2024-12-31\'',
   'CAST(ts AS DATETIME) BETWEEN CAST(DATE \'2024-01-01\' AS DATETIME) AND CAST(DATE \'2024-12-31\' AS DATETIME)'],
  ['DATEDIFF(day, ts, CURRENT_DATE)', 'DATE_DIFF(CAST(CURRENT_DATE() AS DATETIME), CAST(ts AS DATETIME), DAY)'],
  ['CURRENT_TIMESTAMP > d', 'CURRENT_TIMESTAMP() > CAST(d AS TIMESTAMP)'],
  ['CAST(s AS TIMESTAMP) = TIMESTAMP \'2024-01-01 00:00:00\'', 'CAST(s AS TIMESTAMP) = TIMESTAMP \'2024-01-01 00:00:00\''],
  ['d BETWEEN DATE \'2024-01-01\' AND CURRENT_TIMESTAMP',
   'CAST(d AS TIMESTAMP) BETWEEN CAST(DATE \'2024-01-01\' AS TIMESTAMP) AND CURRENT_TIMESTAMP()'],
  ['TO_TIMESTAMP(s) IN (d, CURRENT_DATE)', 'CAST(s AS TIMESTAMP) IN (CAST(d AS TIMESTAMP), CAST(CURRENT_DATE() AS TIMESTAMP))'],
  ['COALESCE(d, CURRENT_TIMESTAMP)', 'COALESCE(CAST(d AS TIMESTAMP), CURRENT_TIMESTAMP())'],
  ['CASE WHEN b THEN d ELSE CURRENT_TIMESTAMP END', 'CASE WHEN b THEN CAST(d AS TIMESTAMP) ELSE CURRENT_TIMESTAMP() END'],
  ['CASE CURRENT_TIMESTAMP WHEN d THEN 1 END', 'CASE CURRENT_TIMESTAMP() WHEN CAST(d AS TIMESTAMP) THEN 1 END'],
  ['IF(b, d, CURRENT_TIMESTAMP)', 'IF(b, CAST(d AS TIMESTAMP), CURRENT_TIMESTAMP())'],
  ['NULLIF(d, CURRENT_TIMESTAMP)', 'NULLIF(CAST(d AS TIMESTAMP), CURRENT_TIMESTAMP())'],
  ['GREATEST(d, CURRENT_TIMESTAMP) < LEAST(ts, CURRENT_TIMESTAMP)',
   'GREATEST(CAST(d AS TIMESTAMP), CURRENT_TIMESTAMP()) < LEAST(CAST(ts AS TIMESTAMP), CURRENT_TIMESTAMP())'],
  ['DATEDIFF(hour, d, CURRENT_TIMESTAMP)', 'DATE_DIFF(CURRENT_TIMESTAMP(), CAST(d AS TIMESTAMP), HOUR)'],
  ['DATEDIFF(day, d, DATE_TRUNC(\'day\', CURRENT_TIMESTAMP)) + DATEDIFF(day, d, DATEADD(day, -7, CURRENT_TIMESTAMP))',
   'DATE_DIFF(DATE_TRUNC(CURRENT_TIMESTAMP(), DAY), CAST(d AS TIMESTAMP), DAY) + DATE_DIFF(DATE_ADD(CURRENT_TIMESTAMP(), INTERVAL -7 DAY), CAST(d AS TIMESTAMP), DAY)'],
  ['DATEDIFF(month, d, CURRENT_TIMESTAMP)',
   'kcmd does not translate DATEDIFF with part \'month\' of a TIMESTAMP, since BigQuery takes no part longer than DAY there'],
  ['DATEADD(week, -1, CURRENT_TIMESTAMP)',
   'kcmd does not translate DATEADD with part \'week\' of a TIMESTAMP, since BigQuery takes no part longer than DAY there'],
  ['DATEADD(month, -1, DATE_TRUNC(\'month\', CURRENT_TIMESTAMP))',
   'kcmd does not translate DATEADD with part \'month\' of a TIMESTAMP, since BigQuery takes no part longer than DAY there'],
  ['DATE_TRUNC(\'hour\', CURRENT_DATE)',
   'kcmd does not translate DATE_TRUNC with part \'hour\' of a DATE, since BigQuery takes no part shorter than DAY there'],
  ['DATEADD(hour, 1, DATE_TRUNC(\'day\', CURRENT_DATE))',
   'kcmd does not translate DATEADD with part \'hour\' of a DATE, since BigQuery takes no part shorter than DAY there'],
  ['EXTRACT(HOUR FROM CURRENT_DATE)',
   'kcmd does not translate EXTRACT with part \'HOUR\' of a DATE, since BigQuery takes no part shorter than DAY there'],
  ['GREATEST(COALESCE(d, CURRENT_TIMESTAMP), CURRENT_DATE)',
   'GREATEST(COALESCE(CAST(d AS TIMESTAMP), CURRENT_TIMESTAMP()), CAST(CURRENT_DATE() AS TIMESTAMP))'],
  ['CASE WHEN b THEN CURRENT_TIMESTAMP END > d', 'CASE WHEN b THEN CURRENT_TIMESTAMP() END > CAST(d AS TIMESTAMP)'],

  // A typed NULL where BigQuery refuses a literal NULL.
  ['x + NULL - (NULL) * 2', 'x + CAST(NULL AS INT64) - CAST(NULL AS INT64) * 2'],
  ['-NULL', '-CAST(NULL AS INT64)'],
  ['NULL || s', 'CAST(NULL AS STRING) || s'],
  ['s LIKE NULL', 's LIKE CAST(NULL AS STRING)'],
  ['NOT NULL', 'NOT CAST(NULL AS BOOL)'],
  ['DATE \'2024-01-01\' = NULL', 'DATE \'2024-01-01\' = CAST(NULL AS DATE)'],
  ['RADIANS(NULL)', '(CAST(NULL AS INT64) * ACOS(-1) / 180)'],
  ['x = NULL', 'kcmd does not translate = on NULL'],

  // The reminders.
  ['SPLIT_PART(s, \'-\', 2)', 'SPLIT(s, \'-\')[SAFE_ORDINAL(2)]', 'SPLIT_PART'],
  ['SUBSTRING(s, 0, 3)', 'SUBSTRING(s, 0, 3)', 'SUBSTRING'],
  ['REGEXP_EXTRACT(s, \'(a)b\')', 'REGEXP_EXTRACT(s, \'(a)b\')', 'REGEXP_EXTRACT'],
  ['REGEXP_EXTRACT(s, \'(?P<y>\\d{4})-\\d\\d\')', 'REGEXP_EXTRACT(s, \'(?P<y>\\\\d{4})-\\\\d\\\\d\')', 'REGEXP_EXTRACT'],
  ['CAST(x AS VARCHAR(3)) || TRY_CAST(s AS STRING(2))', 'SUBSTRING(CAST(x AS STRING), 1, 3) || SUBSTRING(SAFE_CAST(s AS STRING), 1, 2)', 'VARCHAR'],
  ['EXTRACT(SECOND FROM ts)', 'EXTRACT(SECOND FROM ts)', 'EXTRACT_SECOND'],
  ['DATE_PART(\'second\', ts) + DATE_PART(second, ts)', 'EXTRACT(SECOND FROM ts) + EXTRACT(SECOND FROM ts)', 'EXTRACT_SECOND'],

  // Texts kcmd does not translate.
  ['NOW()', 'kcmd does not translate NOW'],
  ['TO_CHAR(d, \'Q\')', 'kcmd does not translate TO_CHAR with \'Q\' in its format, which is not one of Ossie\'s format tokens'],
  ['TO_CHAR(d, s)', 'kcmd does not translate TO_CHAR with a format that is not a literal'],
  ['SUM(x, y)', 'kcmd does not translate SUM with 2 arguments'],
  ['LOWER(DISTINCT s)', 'kcmd does not translate LOWER with DISTINCT'],
  ['DATE_TRUNC(\'decade\', d)', 'kcmd does not translate DATE_TRUNC with part \'decade\''],
  ['EXTRACT(dow FROM d)', 'kcmd does not translate EXTRACT with part \'dow\''],
  ['CAST(x AS JSON)', 'kcmd does not translate CAST to JSON'],
  ['PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY x DESC)',
   'kcmd does not translate PERCENTILE_CONT without WITHIN GROUP (ORDER BY a value ascending)'],
  ['APPROX_PERCENTILE(x, 0.5) OVER ()', 'kcmd does not translate APPROX_PERCENTILE with OVER'],
  ['APPROX_PERCENTILE(x, 0.123456)', 'kcmd does not translate APPROX_PERCENTILE with a fraction of more than 5 decimal places'],
  ['APPROX_PERCENTILE(x, 95)', 'kcmd does not translate APPROX_PERCENTILE with the fraction 95, since a fraction is at most 1'],
  ['SUM(x', 'kcmd does not translate a text that Ossie\'s grammar does not read: line 1, column 6: expected an operator, \',\' or \')\', found the end of the text'],
];

describe('ossieToBigQuery', () => {
  test.each(ROWS)('%s', (text, expected, ...reminders) => {
    expect(ossieToBigQuery(text)).toEqual(expected.startsWith('kcmd does not translate') ?
        {error: expected} : {sql: expected, reminders: reminders.map(r => REMINDER[r])});
  });

  test('refuses a text that nests deeper than the stack holds', () => {
    expect(ossieToBigQuery(Array(100000).fill('x').join(' + ')))
        .toEqual({error: 'kcmd does not translate a text that nests this deep'});
  });
});

// A model with one entity, `orders`, whose field `code` has `dialects`.
function ordersModel(dialects: Field['dialects']): SemanticModel {
  return {
    name: 'sales',
    entities: [{name: 'orders', dataSource: 'p.d.orders', keys: ['id'], fields: [{name: 'code', dialects}]}],
    relationships: [],
    metrics: [],
  };
}

describe('the routing of OSSIE_SQL_2026 texts', () => {
  const dialects: Field['dialects'] = [{dialect: 'OSSIE_SQL_2026', expression: 'SPLIT_PART(code_raw, \'-\', 2)'}];
  const sql = 'SPLIT(code_raw, \'-\')[SAFE_ORDINAL(2)]';

  test('transpileModel adds the Ossie translator\'s BIGQUERY entry and its reminders, without the transpiler', async () => {
    const {model, warnings} = await transpileModel(ordersModel(dialects), {
      transpiler: async () => {
        throw new Error('the transpiler is called');
      },
    });
    expect(model.entities[0].fields[0].dialects).toEqual([...dialects, {dialect: 'BIGQUERY', expression: sql}]);
    expect(warnings).toEqual([
      'field \'orders.code\': transpiled \'OSSIE_SQL_2026\' -> \'BIGQUERY\'',
      `field 'orders.code': ${REMINDER.SPLIT_PART}`,
    ]);
  });

  test('bigQueryTranslation gives the Ossie translator\'s SQL', async () => {
    await loadSqlEngine();
    expect(bigQueryTranslation({dialects}, ['orders'])).toBe(sql);
  });
});
