// Tests for the shared expression helpers in
// src/libts/semantic/sql_expr_utils.ts that both the model file's checks and a
// binding profile's checks use.

import {beforeAll, describe, expect, test} from 'bun:test';

import {columnReferences, entitiesReached, fieldsReadOn, isColumnName, isSingleAggregate, measureEntities, requalified, singleAggregate, withoutQualifier} from '../../../src/libts/semantic/sql_expr_utils';
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

describe('measureEntities', () => {
  test('matches only the start of a dotted chain, never a struct subfield', () => {
    const entities = ['orders', 'shipping_address', 'customer'];
    expect(measureEntities('orders.shipping_address.city', entities))
        .toEqual(['orders']);
    expect(measureEntities('`orders`.`shipping_address`.city', entities))
        .toEqual(['orders']);
    expect(measureEntities('orders.`shipping_address`.city', entities))
        .toEqual(['orders']);
    expect(measureEntities("'orders.customer.id'", entities)).toEqual([]);
  });

  test('reads the entities the SQL parser reads, in the order written', () => {
    const entities = ['orders', 'customer', 'NET', 'Date'];
    expect(measureEntities(
               'SUM(customer.a + orders.b + customer.c)', entities))
        .toEqual(['customer', 'orders']);
    // A function namespace, a comment and a string literal of any quoting
    // read no entity.
    expect(measureEntities('COUNT(DISTINCT NET.HOST(orders.url))', entities))
        .toEqual(['orders']);
    expect(measureEntities('SUM(orders.amount) -- customer.id', entities))
        .toEqual(['orders']);
    expect(measureEntities(
               "SUM(IF(orders.s = '''customer.x''', 1, 0))", entities))
        .toEqual(['orders']);
    // A qualifier the parser reserves as a keyword still reads.
    expect(measureEntities('SUM(Date.days)', entities)).toEqual(['Date']);
    expect(measureEntities('SUM(orders.amount * Date.factor)', entities))
        .toEqual(['orders', 'Date']);
  });

  test('falls back to the anchor only when the SQL reads no entity', () => {
    expect(measureEntities('COUNT(*)', ['orders'], 'orders'))
        .toEqual(['orders']);
    expect(measureEntities('COUNT(*)', ['orders'])).toEqual([]);
    expect(measureEntities('SUM(customer.id)', ['orders', 'customer'],
                           'orders'))
        .toEqual(['customer']);
  });
});

describe('withoutQualifier', () => {
  test('strips only the leading entity qualifier and preserves a struct field of the same name', () => {
    expect(withoutQualifier('orders.orders.id', 'orders')).toBe('orders.id');
    expect(withoutQualifier('`orders`.`orders`.id', 'orders'))
        .toBe('`orders`.id');
  });

  test('keeps the rest of the text as written', () => {
    expect(withoutQualifier('IF(orders.a > 0, orders.b, NULL)', 'orders'))
        .toBe('IF(a > 0, b, NULL)');
    expect(withoutQualifier("REGEXP_CONTAINS(orders.s, r'^a')", 'orders'))
        .toBe("REGEXP_CONTAINS(s, r'^a')");
    expect(withoutQualifier('customer_orders.x + orders.y', 'orders'))
        .toBe('customer_orders.x + y');
    expect(withoutQualifier('amount', 'orders')).toBe('amount');
  });

  test('leaves a string literal, a comment and a function namespace alone', () => {
    expect(withoutQualifier("CONCAT(orders.a, 'orders.b')", 'orders'))
        .toBe("CONCAT(a, 'orders.b')");
    expect(withoutQualifier("orders.a || '''orders.b'''", 'orders'))
        .toBe("a || '''orders.b'''");
    expect(withoutQualifier('SUM(orders.amount) -- orders.x', 'orders'))
        .toBe('SUM(amount) -- orders.x');
    expect(withoutQualifier('NET.HOST(NET.url)', 'NET')).toBe('NET.HOST(url)');
  });

  test('reads the qualifier as the dialect quotes it, and one the parser reserves', () => {
    expect(withoutQualifier('Date.days * 2', 'Date')).toBe('days * 2');
    expect(withoutQualifier('Order.id', 'Order')).toBe('id');
    // BigQuery reads a double-quoted name as a string, PostgreSQL as a name.
    expect(withoutQualifier('"orders".amount', 'orders'))
        .toBe('"orders".amount');
    expect(withoutQualifier('"orders".amount', 'orders', 'POSTGRES'))
        .toBe('amount');
  });

  test('strips every qualifier of SQL the parser cannot read', () => {
    expect(withoutQualifier('orders.', 'orders')).toBe('');
    expect(withoutQualifier('orders.a orders.b', 'orders')).toBe('a b');
  });
});

describe('withoutQualifier with replacements', () => {
  test('puts each replacement in place of its column and its qualifier, and leaves the rest as written', () => {
    const sql = new Map([['d', 'order_date'], ['n', '(x + 1)']]);
    expect(withoutQualifier(
               'EXTRACT(DAYOFWEEK FROM orders.d) + orders.n * orders.m',
               'orders', undefined, sql))
        .toBe('EXTRACT(DAYOFWEEK FROM order_date) + (x + 1) * m');
    expect(withoutQualifier('`orders`.`n`.f || "orders.n"', 'orders',
                            undefined, sql))
        .toBe('(x + 1).f || "orders.n"');
  });
});

describe('requalified', () => {
  test('renames the qualifier and leaves the rest as written', () => {
    expect(requalified("Person.a || 'Person.b' || Person.Person.c", 'Person',
                       'Customer'))
        .toBe("Customer.a || 'Person.b' || Customer.Person.c");
    expect(requalified('People.a + Person', 'Person', 'Customer'))
        .toBe('People.a + Person');
  });

  test('keeps the qualifier\'s quotes as the dialect reads them', () => {
    expect(requalified('`Person`.a', 'Person', 'Customer'))
        .toBe('`Customer`.a');
    expect(requalified('"Person".a', 'Person', 'Customer'))
        .toBe('"Person".a');
    expect(requalified('"Person".a', 'Person', 'Customer', 'POSTGRES'))
        .toBe('"Customer".a');
  });
});

describe('singleAggregate', () => {
  test('gives the function, the operand and DISTINCT as written', () => {
    const agg = (text: string) => singleAggregate(text, 'BIGQUERY');
    expect(agg('COUNT(DISTINCT(orders.id))'))
        .toEqual({fn: 'COUNT', operand: 'orders.id', distinct: true});
    expect(agg('count(distinct `orders`.id)'))
        .toEqual({fn: 'count', operand: '`orders`.id', distinct: true});
    expect(agg('SUM(ALL o.amount)'))
        .toEqual({fn: 'SUM', operand: 'o.amount', distinct: false});
    expect(agg('(SUM((o.amount * o.qty))) -- net'))
        .toEqual({fn: 'SUM', operand: 'o.amount * o.qty', distinct: false});
    expect(agg('COUNT(DISTINCT (o.a + o.b))'))
        .toEqual({fn: 'COUNT', operand: 'o.a + o.b', distinct: true});
    expect(agg('MAX(SAFE.DIVIDE(o.a, o.b))'))
        .toEqual({fn: 'MAX', operand: 'SAFE.DIVIDE(o.a, o.b)', distinct: false});
    expect(agg('COUNT(*)'))
        .toEqual({fn: 'COUNT', operand: '*', distinct: false});
    expect(agg('SUM(o.amount) / 2')).toBeUndefined();
  });
});
describe('isSingleAggregate', () => {
  test('reads one of the five aggregates over one operand, and nothing else', () => {
    const read = (text: string, dialect = 'BIGQUERY') =>
        ({text, single: isSingleAggregate(text, dialect)});
    for (const text of [
           'SUM(o.amount)', 'avg(o.amount * o.qty)', 'COUNT(DISTINCT o.id)',
           'SUM(ALL o.amount)', 'COUNT(*)', '(SUM(o.amount))',
           'SUM(o.amount) -- net', '/* net */ MIN(o.amount)', 'SUM((o.amount))',
           'SUM(IF(o.a, o.b, 0))', 'SUM(CASE WHEN o.a THEN o.b END)',
           'MAX(GREATEST(o.a, o.b))', 'SUM(SAFE.DIVIDE(o.a, o.b))',
         ]) {
      expect(read(text)).toEqual({text, single: true});
    }
    expect(read('MIN(o.amount)', 'POSTGRES').single).toBe(true);
    expect(read('MAX(o.amount)', 'ANSI_SQL').single).toBe(true);
    for (const text of [
           'o.amount', 'SUM(o.amount) / COUNT(o.id)', 'SUM(o.amount) + 0',
           'COUNTIF(o.amount > 0)', 'APPROX_COUNT_DISTINCT(o.id)',
           'SUM(o.amount) OVER ()', 'COUNT(o.a, o.b)', 'MIN(o.a, o.b)',
           'COUNT(DISTINCT o.a, o.b)', 'SUM(*)', 'COUNT(DISTINCT *)',
           'SUM(o.amount) FILTER (WHERE o.amount > 0)',
           'SUM(o.amount ORDER BY o.id)', 'SUM(o.amount IGNORE NULLS)',
           'MAX(o.amount HAVING MAX o.id)', 'SUM(MAX(o.amount))',
           'SUM(SUM(o.amount) OVER ())', 'SUM((SELECT 1))', 'COUNT((*))',
           'SUM(((o.a, o.b)))', 'SUM(', '  ', 'SUM(o.amount);',
         ]) {
      expect(read(text)).toEqual({text, single: false});
    }
  });
});
