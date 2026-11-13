// Tests for the name writers in src/libts/semantic/sql_expr_utils.ts
// (columnName, qualifiedName), the column comparison (columnKey,
// sameColumns) for texts kcmd runs as written, and how columnsRewritten
// reads a quoted name.

import {beforeAll, describe, expect, test} from 'bun:test';

import {columnKey, columnName, columnsRewritten, qualifiedName, sameColumns, WrittenName} from '../../../src/libts/semantic/sql_expr_utils';
import {loadSqlEngine} from '../../../src/libts/semantic/sql_parser';

beforeAll(async () => {
  await loadSqlEngine();
});

// A name as a text writes it: in quotes when it starts with one.
const written = (text: string): WrittenName => {
  const quoted = /^["`[]/.test(text);
  return {written: text, name: quoted ? text.slice(1, -1) : text, quoted};
};

describe('columnName', () => {
  // Each row names the text's dialect, and after a slash its table's dialect.
  test.each([
    ['BIGQUERY', 'amount', 'amount'],
    ['BIGQUERY', 'date', 'date'],
    ['BIGQUERY', 'user', 'user'],
    // Names the dialect reads as a function.
    ['BIGQUERY', 'current_date', '`current_date`'],
    ['SPANNER', 'current_timestamp', '`current_timestamp`'],
    ['MYSQL', 'localtime', '`localtime`'],
    ['SQLSERVER', 'current_user', '[current_user]'],
    ['DATABRICKS', 'current_date', '`current_date`'],
    // Keywords the parser reads as a column.
    ['BIGQUERY', 'order', '`order`'],
    ['BIGQUERY', 'true', '`true`'],
    ['POSTGRES', 'user', '"user"'],
    ['ALLOYDB', 'end', '"end"'],
    ['MYSQL', 'key', '`key`'],
    ['SQLSERVER', 'file', '[file]'],
    ['DATABRICKS', 'user', '`user`'],
    // A database that folds a name written without quotes gets it quoted in
    // that case.
    ['SNOWFLAKE', 'current_date', '"CURRENT_DATE"'],
    ['SNOWFLAKE', 'current', '"CURRENT"'],
    ['POSTGRES', 'CURRENT_USER', '"current_user"'],
    ['ALLOYDB', 'Current_Date', '"current_date"'],
    ['ANSI_SQL', 'current_date', '"CURRENT_DATE"'],
    ['ANSI_SQL', 'key', '"KEY"'],
    // A quoted name stays as written.
    ['POSTGRES', '"Tax"', '"Tax"'],
    ['SNOWFLAKE', '"current_date"', '"current_date"'],
    // An ANSI_SQL text is written as its table's dialect writes a name.
    ['ANSI_SQL/BIGQUERY', 'current_date', '`current_date`'],
    ['ANSI_SQL/BIGQUERY', '"amount"', 'amount'],
    ['ANSI_SQL/POSTGRES', 'USER', '"user"'],
    // A name in quotes the dialect does not read as a name's, which needs
    // quotes for its characters.
    ['ANSI_SQL/BIGQUERY', '"order date"', '`order date`'],
    ['BIGQUERY', '"a`b"', '`a\\`b`'],
    ['MYSQL', '"a`b"', '`a``b`'],
    ['SQLSERVER', '`a]b`', '[a]]b]'],
    ['POSTGRES', '`order`', '"order"'],
  ])('writes in %s %s as %s', (dialects, name, expected) => {
    const [dialect, table] = dialects.split('/');
    expect(columnName(written(name), dialect, table)).toBe(expected);
  });
});

describe('qualifiedName', () => {
  test.each([
    ['BIGQUERY', 'orders', 'amount', 'orders.amount'],
    // A qualifier the parser cannot read before a dot.
    ['BIGQUERY', 'date', 'amount', '`date`.amount'],
    ['ANSI_SQL/BIGQUERY', 'timestamp', 'amount', '`timestamp`.amount'],
    ['SNOWFLAKE', 'Date', 'amount', '"Date".amount'],
    // A qualifier the database reads as a keyword; after a dot it is a name
    // in some databases only.
    ['POSTGRES', 'user', 'current_date', '"user".current_date'],
    ['SQLSERVER', 'order', 'end', '[order].[end]'],
    ['SNOWFLAKE', 'd', 'order', 'd."order"'],
    ['POSTGRES', '"Orders"', 'amount', '"Orders".amount'],
    ['BIGQUERY', '"orders"', '"amount"', 'orders.amount'],
  ])('writes in %s %s.%s as %s', (dialects, qualifier, name, expected) => {
    const [dialect, table] = dialects.split('/');
    expect(qualifiedName(written(qualifier), written(name), dialect, table)).toBe(expected);
  });
});

describe('columnKey and sameColumns', () => {
  // Each column as its text's dialect, as in the columnName rows, and its name
  // as written.
  test.each([
    ['a name written without quotes in two folding dialects', [['POSTGRES', 'tax'], ['SNOWFLAKE', 'tax']], true],
    ['names in dialects that ignore case', [['MYSQL', 'Tax'], ['SQLSERVER', 'TAX'], ['DATABRICKS', 'tax']], true],
    ['an Ossie name and the same name in folding and other dialects', [['OSSIE_SQL_2026', 'o_id'], ['SNOWFLAKE', 'O_ID'], ['BIGQUERY', '`O_Id`']], true],
    ['a quoted name in the folded case', [['SNOWFLAKE', 'tax'], ['SNOWFLAKE', '"TAX"']], true],
    ['a quoted name in another case', [['SNOWFLAKE', 'tax'], ['SNOWFLAKE', '"tax"']], false],
    ['an ANSI_SQL name on a POSTGRES table', [['ANSI_SQL/POSTGRES', 'TAX'], ['POSTGRES', '"tax"']], true],
    ['quoted names in two folding dialects in other cases', [['POSTGRES', '"Tax"'], ['SNOWFLAKE', '"tax"']], false],
    ['quoted names that no unquoted name gives', [['POSTGRES', '"order date"'], ['SNOWFLAKE', '"ORDER DATE"']], false],
    // In each row below the first name matches each of the others, which do
    // not match each other.
    ['a name that ignores case and two that differ', [['BIGQUERY', 'tax'], ['POSTGRES', 'tax'], ['POSTGRES', '"Tax"']], false],
    ['a name each folding dialect may store', [['POSTGRES', '"amount"'], ['SNOWFLAKE', '"amount"'], ['SNOWFLAKE', '"AMOUNT"']], false],
  ])('compares %s', (_, columns, same) => {
    const keys = (columns as string[][]).map(([dialects, name]) => {
      const [dialect, table] = dialects.split('/');
      return columnKey(written(name), dialect, table);
    });
    expect(sameColumns(keys)).toBe(same);
    expect(sameColumns(keys.reverse())).toBe(same);
  });
});

describe('columnsRewritten', () => {
  // A quoted name the parser reads as a function alone is a column.
  test.each([
    ['BIGQUERY', 'MAX(`current_date`)', 'MAX(orders.`current_date`)'],
    ['POSTGRES', 'MAX("current_date")', 'MAX(orders."current_date")'],
    ['SQLSERVER', 'MAX([current_date])', 'MAX(orders.[current_date])'],
    ['BIGQUERY', '`current_date` - CURRENT_DATE', 'orders.`current_date` - CURRENT_DATE'],
  ])('reads in %s %s as %s', (dialect, text, expected) => {
    expect(columnsRewritten(text, dialect, new Set(['current_date']),
                            c => c.qualifier ? undefined : `orders.${c.name.written}`))
        .toBe(expected);
  });

  // A text the parser reads only with each name beside a dot as a placeholder.
  test.each([
    ['BIGQUERY', "DATE_DIFF(date.d, DATE '2026-01-01', DAY)", 'date', "DATE_DIFF(x.d, DATE '2026-01-01', DAY)"],
    ['SNOWFLAKE', 'SUM(amount) / COUNT(order.id)', 'amount order', 'SUM(x.amount) / COUNT(x.id)'],
  ])('reads in %s %s with the names %s', (dialect, text, names, expected) => {
    expect(columnsRewritten(text, dialect, new Set(names.split(' ')), c => `x.${c.name.written}`))
        .toBe(expected);
  });

  test('says a qualifier may name a table of a subquery\'s FROM only when the database matches the two names', () => {
    const seen: string[] = [];
    columnsRewritten('(SELECT MAX(o.amount) FROM t AS "O")', 'POSTGRES', new Set(['o']), c => {
      seen.push(`${c.qualifier?.written}.${c.name.written} bound=${c.bound}`);
      return undefined;
    });
    expect(seen).toEqual(['o.amount bound=false']);
  });

  test.each([
    ['DATEDIFF(date.day, date.a, date.b)', 'DATEDIFF("DAY", a, b)'],
    ['date.if + date.x', '"IF" + x'],
  ])('writes the columns of SNOWFLAKE %s without the qualifier date as each reads where it stands', (text, expected) => {
    expect(columnsRewritten(text, 'SNOWFLAKE', new Set(['date']), c => columnName(c.name, 'SNOWFLAKE', undefined, c.at)))
        .toBe(expected);
  });
});
