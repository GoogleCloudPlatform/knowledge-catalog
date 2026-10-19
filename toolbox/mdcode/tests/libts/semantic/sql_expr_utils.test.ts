// Tests for the shared expression helpers in
// src/libts/semantic/sql_expr_utils.ts that both the model file's checks and a
// binding profile's checks use.

import {beforeAll, describe, expect, test} from 'bun:test';

import {columnReferences, entitiesReached, fieldsReadOn, isColumnName, keysCoveredByColumns, referencedEntityNames, stripQualifier} from '../../../src/libts/semantic/sql_expr_utils';
import {loadSqlEngine} from '../../../src/libts/semantic/sql_parser';

beforeAll(async () => {
  await loadSqlEngine();
});

describe('isColumnName', () => {
  test('accepts a plain or backtick-quoted column name', () => {
    for (const ok of ['o_id', '`order date`', 'Col9', '`a.b`']) {
      expect(isColumnName(ok)).toBe(true);
    }
  });

  test('rejects an expression, a field reference or an empty value', () => {
    for (const bad of [
           'order date', 'LOWER(cust_id)', 'a || b', 'customers.id', '',
           '``', '`a` || `b`', 'a,b', 'x+1',
         ]) {
      expect(isColumnName(bad)).toBe(false);
    }
    expect(isColumnName(undefined)).toBe(false);
    expect(isColumnName(7)).toBe(false);
  });
});

describe('columnReferences', () => {
  // The fields a text reads on `entity`, or undefined when it cannot be read.
  const read = (text: string, dialect: string, entity: string) => {
    const columns = columnReferences(text, dialect);
    return columns && fieldsReadOn(columns, entity);
  };

  test('returns each field read through the entity, deduplicated in order', () => {
    expect(read('orders.amount + `orders`.`tax` - orders.amount', 'BIGQUERY',
                'orders'))
        .toEqual(['amount', 'tax']);
  });

  test('ignores string literals, comments and other entities', () => {
    expect(read(
               "IF(orders.status = 'orders.note', customers.id, 0) -- orders.x",
               'BIGQUERY', 'orders'))
        .toEqual(['status']);
  });

  test('reads double quotes as the dialect does', () => {
    expect(read('SUM("orders"."amount")', 'POSTGRES', 'orders'))
        .toEqual(['amount']);
    expect(read('SUM("orders"."amount")', 'SNOWFLAKE', 'orders'))
        .toEqual(['amount']);
    // In BigQuery a double-quoted run is a string, so this is not SQL.
    expect(read('SUM("orders"."amount")', 'BIGQUERY', 'orders'))
        .toBeUndefined();
    expect(read('SUM(IF(orders.s = "x", orders.a, 0))', 'BIGQUERY', 'orders'))
        .toEqual(['s', 'a']);
  });

  test('reads a struct path as the field it starts with', () => {
    expect(read('orders.shipping_address.city', 'BIGQUERY', 'orders'))
        .toEqual(['shipping_address']);
    expect(read('orders.shipping_address.city', 'BIGQUERY',
                'shipping_address'))
        .toEqual([]);
  });

  test('does not read a function or a date part as a column', () => {
    expect(columnReferences(
               'COUNT(DISTINCT DATE_TRUNC(orders.order_date, month))',
               'BIGQUERY'))
        .toEqual([{qualifier: 'orders', name: 'order_date'}]);
    expect(columnReferences('NET.HOST(orders.url)', 'BIGQUERY'))
        .toEqual([{qualifier: 'orders', name: 'url'}]);
    expect(columnReferences('SUM(net_amount)', 'BIGQUERY'))
        .toEqual([{name: 'net_amount'}]);
    for (const [fn, dialect] of [
           ['DATEDIFF', 'DATABRICKS'],
           ['DATEADD', 'DATABRICKS'],
           ['DATE_DIFF', 'DATABRICKS'],
           ['DATE_ADD', 'DATABRICKS'],
           ['TIMESTAMPDIFF', 'MYSQL'],
           ['TIMESTAMPADD', 'MYSQL'],
           ['DATEDIFF', 'ANSI_SQL'],
         ] as const) {
      expect(columnReferences(
                 `AVG(${fn}(DAY, orders.start_date, orders.end_date))`,
                 dialect))
          .toEqual([
            {qualifier: 'orders', name: 'start_date'},
            {qualifier: 'orders', name: 'end_date'},
          ]);
    }
    // BigQuery's `DATE_DIFF(end_col, start_col, DAY)` puts the column first,
    // so a bare column name in the first argument is still collected, even when
    // its name matches a short date-part keyword such as `d`.
    expect(columnReferences(
               'AVG(DATE_DIFF(end_col, orders.start_date, DAY))', 'BIGQUERY'))
        .toEqual([
          {name: 'end_col'},
          {qualifier: 'orders', name: 'start_date'},
        ]);
    expect(columnReferences(
               'AVG(DATE_DIFF(d, orders.start_date, DAY))', 'BIGQUERY'))
        .toEqual([
          {name: 'd'},
          {qualifier: 'orders', name: 'start_date'},
        ]);
  });

  test('ignores subquery/UNNEST/CTE/JOIN/OFFSET/SELECT aliases, subquery FROM bare columns, and lambda parameters', () => {
    expect(columnReferences(
               '(SELECT SUM(s.x) FROM UNNEST(orders.items) AS s)', 'BIGQUERY'))
        .toEqual([{qualifier: 'orders', name: 'items'}]);
    expect(columnReferences(
               '(SELECT SUM(x) FROM UNNEST(orders.items))', 'BIGQUERY'))
        .toEqual([{qualifier: 'orders', name: 'items'}]);
    expect(columnReferences(
               '(SELECT SUM(sub_col) FROM (SELECT orders.net_amount AS sub_col))',
               'BIGQUERY'))
        .toEqual([{qualifier: 'orders', name: 'net_amount'}]);
    expect(columnReferences(
               '(SELECT SUM(x + orders.bad_field) FROM UNNEST(orders.items))',
               'BIGQUERY'))
        .toEqual([
          {qualifier: 'orders', name: 'items'},
          {qualifier: 'orders', name: 'bad_field'},
        ]);
    expect(columnReferences(
               '(SELECT SUM(x) FROM UNNEST(bare_items))', 'BIGQUERY'))
        .toEqual([{name: 'bare_items'}]);
    expect(columnReferences(
               '(WITH c AS (SELECT orders.id AS id) SELECT COUNT(c.id) FROM c)',
               'BIGQUERY'))
        .toEqual([{qualifier: 'orders', name: 'id'}]);
    expect(columnReferences(
               '(SELECT SUM(j.x + off) FROM UNNEST(orders.items) AS i WITH OFFSET AS off JOIN UNNEST(orders.items) AS j ON i.id = j.id)',
               'BIGQUERY'))
        .toEqual([
          {qualifier: 'orders', name: 'items'},
          {qualifier: 'orders', name: 'items'},
        ]);
    // A later FROM item can read the offset alias.
    expect(columnReferences(
               '(SELECT SUM(j) FROM UNNEST(orders.items) AS i WITH OFFSET AS off, UNNEST([off]) AS j)',
               'BIGQUERY'))
        .toEqual([{qualifier: 'orders', name: 'items'}]);
    expect(columnReferences(
               '(SELECT orders.net_amount AS a HAVING a > 0)',
               'BIGQUERY'))
        .toEqual([{qualifier: 'orders', name: 'net_amount'}]);
    expect(columnReferences(
               '(SELECT STRUCT(orders.net_amount AS v) AS a FROM UNNEST(orders.items) HAVING a.v > 0)',
               'BIGQUERY'))
        .toEqual([
          {qualifier: 'orders', name: 'items'},
          {qualifier: 'orders', name: 'net_amount'},
        ]);
    // Bound alias at the head of a struct path (both regular identifier and
    // keyword-like identifier `Time`).
    expect(columnReferences(
               '(SELECT s.addr.city FROM UNNEST(orders.items) AS s)',
               'BIGQUERY'))
        .toEqual([{qualifier: 'orders', name: 'items'}]);
    expect(columnReferences(
               'AGGREGATE(orders.items, 0, (acc, Time) -> acc + Time.addr.zip)',
               'DATABRICKS'))
        .toEqual([{qualifier: 'orders', name: 'items'}]);
    // Inner alias scoping: an inner subquery or lambda alias does not hide an
    // outer `s.x` reference outside that scope.
    expect(columnReferences(
               '(SELECT SUM(s.x) FROM UNNEST(orders.items) AS s) + s.x',
               'BIGQUERY'))
        .toEqual([
          {qualifier: 'orders', name: 'items'},
          {qualifier: 's', name: 'x'},
        ]);
    expect(columnReferences(
               'AGGREGATE(orders.items, 0, (acc, s) -> acc + s.price) + s.x',
               'DATABRICKS'))
        .toEqual([
          {qualifier: 'orders', name: 'items'},
          {qualifier: 's', name: 'x'},
        ]);
  });

  test('SAFE.DATE_DIFF reads the same columns as DATE_DIFF', () => {
    expect(columnReferences('SAFE.DATE_DIFF(orders.a, orders.b, DAY)', 'BIGQUERY'))
        .toEqual(columnReferences('DATE_DIFF(orders.a, orders.b, DAY)', 'BIGQUERY'));
    expect(columnReferences('SAFE.DATE_TRUNC(orders.d, MONTH)', 'BIGQUERY'))
        .toEqual([{qualifier: 'orders', name: 'd'}]);
    // Only the last argument is a date part, so a bare `d` before it is read.
    expect(columnReferences('SAFE.DATE_DIFF(orders.a, d, DAY)', 'BIGQUERY'))
        .toEqual(columnReferences('DATE_DIFF(orders.a, d, DAY)', 'BIGQUERY'));
  });

  test('reads the expression a chained function call applies to', () => {
    const name = [{qualifier: 'orders', name: 'name'}];
    expect(columnReferences('(orders.name).UPPER()', 'BIGQUERY')).toEqual(name);
    expect(columnReferences('(orders.name).LOWER().TRIM()', 'BIGQUERY'))
        .toEqual(name);
    expect(columnReferences('LOWER(orders.name).TRIM()', 'BIGQUERY'))
        .toEqual(name);
    expect(columnReferences('SUM((orders.amount).ABS())', 'BIGQUERY'))
        .toEqual([{qualifier: 'orders', name: 'amount'}]);
    // A namespace or dataset path before the dot is still not a column.
    expect(columnReferences('p.ds.my_udf(orders.amount)', 'BIGQUERY'))
        .toEqual([{qualifier: 'orders', name: 'amount'}]);
  });

  test('reads the first part as the qualifier when it is also a type name', () => {
    // The engine parses `Time.hour` as a field of a column named `Time`.
    expect(columnReferences('COUNT(DISTINCT Time.hour)', 'BIGQUERY'))
        .toEqual([{qualifier: 'Time', name: 'hour'}]);
    expect(columnReferences('Time.address.city', 'BIGQUERY'))
        .toEqual([{qualifier: 'Time', name: 'address'}]);
    expect(columnReferences('orders.address.city', 'BIGQUERY'))
        .toEqual([{qualifier: 'orders', name: 'address'}]);
  });

  test('reads a text that starts with a keyword used as an entity name', () => {
    expect(columnReferences('Order.amount - Order.discount', 'BIGQUERY'))
        .toEqual([
          {qualifier: 'Order', name: 'amount'},
          {qualifier: 'Order', name: 'discount'},
        ]);
    expect(columnReferences('Group.size -- a trailing comment', 'ANSI_SQL'))
        .toEqual([{qualifier: 'Group', name: 'size'}]);
  });

  test('reads only a text that is one whole expression', () => {
    expect(columnReferences('Values.a + 1', 'BIGQUERY'))
        .toEqual([{qualifier: 'Values', name: 'a'}]);
    for (const bad of [
           'a) + (b', 'x) FROM t WHERE (y', 'x FROM t', 'a, b', 'x WHERE y',
           'x) WHERE (y', 'DISTINCT x', 'x AS y', 'a b', 'x LIMIT 1',
         ]) {
      expect(columnReferences(bad, 'BIGQUERY')).toBeUndefined();
    }
  });

  test('reads a dialect name in any case', () => {
    expect(columnReferences('SUM("orders"."amount")', 'snowflake'))
        .toEqual([{qualifier: 'orders', name: 'amount'}]);
  });

  test('matches case-sensitively', () => {
    expect(read('Orders.amount', 'BIGQUERY', 'orders')).toEqual([]);
  });

  test('an empty expression reads nothing', () => {
    expect(columnReferences('', 'BIGQUERY')).toEqual([]);
    expect(columnReferences('  ', 'BIGQUERY')).toEqual([]);
  });

  test('returns undefined for text the parser cannot read', () => {
    expect(columnReferences('SUM(orders.amount', 'ANSI_SQL')).toBeUndefined();
    expect(columnReferences('a; b', 'BIGQUERY')).toBeUndefined();
  });

  test('reads SQL Server text as T-SQL', () => {
    // Bracketed names are T-SQL only: the dialect-neutral parser cannot read
    // them.
    expect(columnReferences('SUM([orders].[amount])', 'SQLSERVER'))
        .toEqual([{qualifier: 'orders', name: 'amount'}]);
    expect(columnReferences('COUNT(DISTINCT orders.[customer id])', 'SQLSERVER'))
        .toEqual([{qualifier: 'orders', name: 'customer id'}]);
    expect(columnReferences('SUM([orders].[amount])', 'ANSI_SQL'))
        .toBeUndefined();
    expect(columnReferences('SUM(ISNULL(orders.discount, 0))', 'SQLSERVER'))
        .toEqual([{qualifier: 'orders', name: 'discount'}]);
    // DATEDIFF puts the date part first; it is not a column.
    for (const unit of ['day', 'dd']) {
      expect(columnReferences(
                 `AVG(DATEDIFF(${unit}, orders.start_date, orders.end_date))`,
                 'SQLSERVER'))
          .toEqual([
            {qualifier: 'orders', name: 'start_date'},
            {qualifier: 'orders', name: 'end_date'},
          ]);
    }
    // DATE_BUCKET puts the date part first too. BigQuery's DATE_BUCKET takes
    // the date first, so there `d` is a column.
    expect(columnReferences(
               'COUNT(DISTINCT DATE_BUCKET(week, 1, orders.order_date))',
               'SQLSERVER'))
        .toEqual([{qualifier: 'orders', name: 'order_date'}]);
    expect(columnReferences(
               "DATE_BUCKET(d, INTERVAL 7 DAY, DATE '2020-01-01')", 'BIGQUERY'))
        .toEqual([{name: 'd'}]);
    // A method of a column, such as geography's STLength, reads the column. A
    // two-part function name is still a function.
    expect(columnReferences('MAX(orders.geo.STLength())', 'SQLSERVER'))
        .toEqual([{qualifier: 'orders', name: 'geo'}]);
    expect(columnReferences('SUM(dbo.fn_tax(orders.amount))', 'SQLSERVER'))
        .toEqual([{qualifier: 'orders', name: 'amount'}]);
  });
});

describe('entitiesReached', () => {
  test('returns declared entities referenced in order without duplicates', () => {
    const cols = columnReferences(
        'orders.amount + customer.id + orders.tax + other.x', 'BIGQUERY')!;
    expect(entitiesReached(cols, new Set(['orders', 'customer'])))
        .toEqual(['orders', 'customer']);
  });
});

describe('referencedEntityNames', () => {
  test('matches only the start of a dotted chain, never a struct subfield', () => {
    const entities = ['orders', 'shipping_address', 'customer'];
    expect(referencedEntityNames('orders.shipping_address.city', entities))
        .toEqual(['orders']);
    expect(referencedEntityNames('`orders`.`shipping_address`.city', entities))
        .toEqual(['orders']);
    expect(referencedEntityNames('orders.`shipping_address`.city', entities))
        .toEqual(['orders']);
    expect(referencedEntityNames("'orders.customer.id'", entities)).toEqual([]);
  });
});

describe('stripQualifier', () => {
  test('strips only the leading entity qualifier and preserves a struct field of the same name', () => {
    expect(stripQualifier('orders.orders.id', 'orders')).toBe('orders.id');
    expect(stripQualifier('`orders`.`orders`.id', 'orders'))
        .toBe('`orders`.id');
  });
});

describe('keysCoveredByColumns', () => {
  test('gives no answer while a key names a field with no column', () => {
    // The primary key reads field `id`, unbound here, so which keys a join
    // covers cannot be told, even though it covers the unique key.
    const customer = {
      name: 'customer',
      fields: [{name: 'id'}, {name: 'email', expression: 'email'}],
    };
    expect(keysCoveredByColumns(customer, ['email'], ['id'], [['email']]))
        .toBeUndefined();
    expect(keysCoveredByColumns(
               {...customer, fields: [{name: 'email', expression: 'email'}]},
               ['email'], ['id'], [['email']]))
        .toEqual(['unique key 1']);
  });

  test('reads a key field\'s column without its comment, as the generators do', () => {
    const orders = {
      name: 'orders',
      fields: [{name: 'id', expression: 'orders.order_id -- the key'}],
    };
    expect(keysCoveredByColumns(orders, ['order_id'], ['id'], []))
        .toEqual(['the primary key']);
  });

  test('reads a key field\'s vendor SQL in its own dialect, as the generators do', () => {
    // PostgreSQL reads `#` as an operator, so the key's column is the whole
    // text, which no join column names.
    const orders = {
      name: 'orders',
      fields: [{
        name: 'id',
        dialects: [{dialect: 'POSTGRES' as const, expression: 'order_id # 1'}],
        importedExpression: 'order_id # 1',
        importedDialect: 'POSTGRES' as const,
      }],
    };
    expect(keysCoveredByColumns(orders, ['order_id'], ['id'], [])).toEqual([]);
    // A target text is read as BigQuery, even when a PostgreSQL entry holds
    // the same text.
    const shared = {
      name: 'orders',
      fields: [{
        name: 'id',
        expression: 'order_id # pk',
        dialects: [
          {dialect: 'POSTGRES' as const, expression: 'order_id # pk'},
          {dialect: 'BIGQUERY' as const, expression: 'order_id # pk'},
        ],
      }],
    };
    expect(keysCoveredByColumns(shared, ['order_id'], ['id'], []))
        .toEqual(['the primary key']);
  });
});
