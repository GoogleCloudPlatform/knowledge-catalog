// Tests for the shared expression helpers in
// src/libts/semantic/sql_expr_utils.ts that both the model file's checks and a
// binding profile's checks use.

import {beforeAll, describe, expect, test} from 'bun:test';

import {columnReferences, columnsForSource, entitiesReached, fieldsReadOn, isColumnName, measureAggregates, measureEntities, qualifiedColumns, requalified, selfReferenceMessage, singleAggregate, unusedName, withoutQualifier, withSiblingsSpliced} from '../../../src/libts/semantic/sql_expr_utils';
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

describe('columnsForSource', () => {
  test('reads an ANSI_SQL text in its tables\' dialect, and not at all when no lookup gave it', () => {
    expect(columnsForSource('UPPER("c")', 'ANSI_SQL', 'POSTGRES')).toEqual([{name: 'c'}]);
    expect(columnsForSource('UPPER("c")', 'ANSI_SQL', null)).toBeUndefined();
    expect(columnsForSource('UPPER(c)', 'MYSQL', null)).toEqual([{name: 'c'}]);
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

describe('withSiblingsSpliced', () => {
  test('puts each sibling\'s SQL in place of its column and its qualifier, and leaves the rest as written', () => {
    const sql = new Map([['d', 'order_date'], ['n', '(x + 1)']]);
    expect(withSiblingsSpliced(
               'EXTRACT(DAYOFWEEK FROM orders.d) + orders.n * orders.m',
               'orders', sql))
        .toBe('EXTRACT(DAYOFWEEK FROM order_date) + (x + 1) * m');
    expect(withSiblingsSpliced('`orders`.`n`.f || "orders.n"', 'orders', sql))
        .toBe('(x + 1).f || "orders.n"');
  });

  test('reads a qualifier the parser reserves', () => {
    expect(withSiblingsSpliced('Date.days / 7', 'Date',
                               new Map([['days', 'd_days']])))
        .toBe('d_days / 7');
  });
});

describe('qualifiedColumns', () => {
  test('gives the column after each qualifier, unquoted, in the order written', () => {
    expect(qualifiedColumns(
               "orders.a + `orders`.`b`.c + other.d + 'orders.e' + orders.a",
               'orders'))
        .toEqual(['a', 'b', 'a']);
    expect(qualifiedColumns('amount', 'orders')).toEqual([]);
  });

  test('reads a qualifier the parser reserves, and the dialect\'s quoting', () => {
    expect(qualifiedColumns('Date.days / 7', 'Date')).toEqual(['days']);
    expect(qualifiedColumns('"orders"."a" + 1', 'orders', 'POSTGRES'))
        .toEqual(['a']);
  });
});

describe('selfReferenceMessage', () => {
  test('names the cycle, and how to read the column of a field that names itself directly', () => {
    expect(selfReferenceMessage('orders', ['amount']))
        .toBe(
            `field 'orders.amount' names itself; a field expression may ` +
            `name other fields of its entity, but not itself, directly or ` +
            `through other fields; to read the column of that name, write ` +
            `it without the qualifier: 'amount'`);
    expect(selfReferenceMessage('orders', ['a', 'b', 'c'], ' in model \'m\''))
        .toBe(
            `field 'orders.a' in model 'm' names itself through ` +
            `'orders.b', 'orders.c'; a field expression may name other ` +
            `fields of its entity, but not itself, directly or through other ` +
            `fields`);
  });

  test('quotes a reserved name in how to read the column', () => {
    expect(selfReferenceMessage('Customer', ['order']))
        .toEndWith("write it without the qualifier: '`order`'");
  });
});

describe('unusedName', () => {
  test('adds underscores until the text does not hold the name in any case', () => {
    expect(unusedName('SUM(orders.amount)', 'kcmd_entity')).toBe('kcmd_entity');
    expect(unusedName('SUM(KCMD_ENTITY.a) + kcmd_entity_', 'kcmd_entity'))
        .toBe('kcmd_entity__');
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
describe('measureAggregates', () => {
  const problem = (text: string, dialect = 'BIGQUERY') => {
    const read = measureAggregates(text, dialect);
    return {text, problem: 'problem' in read ? read.problem : undefined};
  };

  test('reads aggregates of the five over one operand, with scalar SQL around them', () => {
    for (const text of [
           'SUM(o.amount)', 'avg(o.amount * o.qty)', 'COUNT(DISTINCT o.id)',
           'SUM(ALL o.amount)', 'COUNT(*)', '(SUM(o.amount))',
           'SUM(o.amount) -- net', '/* net */ MIN(o.amount)', 'SUM((o.amount))',
           'SUM(IF(o.a, o.b, 0))', 'SUM(CASE WHEN o.a THEN o.b END)',
           'MAX(GREATEST(o.a, o.b))', 'SUM(SAFE.DIVIDE(o.a, o.b))',
           'SUM(o.amount) / COUNT(o.id)', 'SUM(o.amount) + 0',
           'SUM(o.amount) / 1000', 'COUNT(*) * 2',
           'SAFE_DIVIDE(SUM(IF(o.s = \'F\', o.a, 0)), SUM(o.a))',
           'CASE WHEN COUNT(o.id) = 0 THEN NULL ELSE SUM(o.a) / COUNT(o.id) END',
           'ROUND(AVG(o.a), 2)', '-MAX(o.a)', 'IFNULL(SUM(o.a), 0)',
         ]) {
      expect(problem(text)).toEqual({text, problem: undefined});
    }
    expect(problem('MIN(o.amount)', 'POSTGRES').problem).toBeUndefined();
    expect(problem('MAX(o.amount)', 'ANSI_SQL').problem).toBeUndefined();
  });

  test('gives each aggregate where it is written, with its operand', () => {
    const text = 'SAFE_DIVIDE(SUM(IF(o.s = \'é\', o.a, 0)), count(DISTINCT o.a))';
    expect(measureAggregates(text, 'BIGQUERY')).toEqual({
      aggregates: [
        {start: 12, end: 38, fn: 'SUM', operand: 'IF(o.s = \'é\', o.a, 0)',
         distinct: false},
        {start: 40, end: 59, fn: 'count', operand: 'o.a', distinct: true},
      ]
    });
    expect(measureAggregates('COUNT(*) + 0', 'BIGQUERY')).toEqual({
      aggregates: [{start: 0, end: 8, fn: 'COUNT', operand: '*', distinct: false}]
    });
  });

  test('says why anything else cannot be a measure', () => {
    const expected: Array<[string, string]> = [
      ['o.amount', 'it holds no aggregate (SUM, AVG, COUNT, MIN, MAX)'],
      ['o.amount * 2', 'it holds no aggregate (SUM, AVG, COUNT, MIN, MAX)'],
      ['o.amount - SUM(o.discount)',
       'it reads column \'amount\' outside an aggregate'],
      ['CASE WHEN o.flag THEN SUM(o.a) END',
       'it reads column \'flag\' outside an aggregate'],
      ['SUM(o.a) + SAFE.SUM(o.b)', 'it reads column \'b\' outside an aggregate'],
      ['STDDEV(o.amount)',
       'it uses STDDEV, which BigQuery does not allow in a measure (SUM, AVG, ' +
           'COUNT, MIN, MAX)'],
      ['SUM(o.a) / COUNTIF(o.amount > 0)',
       'it uses COUNTIF, which BigQuery does not allow in a measure (SUM, ' +
           'AVG, COUNT, MIN, MAX)'],
      ['APPROX_COUNT_DISTINCT(o.id)',
       'it uses APPROX_COUNT_DISTINCT, which BigQuery does not allow in a ' +
           'measure (SUM, AVG, COUNT, MIN, MAX)'],
      ['CORR(o.a, o.b)',
       'it uses CORR, which BigQuery does not allow in a measure (SUM, AVG, ' +
           'COUNT, MIN, MAX)'],
      ['SUM(o.amount) OVER ()', 'it uses a window or a subquery'],
      ['SUM(o.a) / (SELECT 1)', 'it uses a window or a subquery'],
      ['SUM(MAX(o.amount))', 'it nests an aggregate, a window or a subquery'],
      ['SUM(SUM(o.amount) OVER ())',
       'it nests an aggregate, a window or a subquery'],
      ['SUM((SELECT 1))', 'it nests an aggregate, a window or a subquery'],
      ['MIN(o.a, o.b)',
       'it calls MIN with 2 operands, where an aggregate in a measure takes ' +
           'one'],
      ['COUNT(o.a, o.b)',
       'it calls COUNT with 2 operands, where an aggregate in a measure takes ' +
           'one'],
      ['COUNT(DISTINCT o.a, o.b)',
       'it calls COUNT with 2 operands, where an aggregate in a measure takes ' +
           'one'],
      ['SUM(((o.a, o.b)))',
       'it calls SUM with 2 operands, where an aggregate in a measure takes ' +
           'one'],
      ...['SUM(*)', 'COUNT(DISTINCT *)', 'COUNT((*))',
          'SUM(o.amount) FILTER (WHERE o.amount > 0)',
          'SUM(o.amount ORDER BY o.id)', 'SUM(o.amount IGNORE NULLS)']
          .map((text): [string, string] => [
            text,
            `it calls ${text.slice(0, text.indexOf('('))} with something ` +
                `other than one operand and DISTINCT or ALL`
          ]),
      ['MAX(o.amount HAVING MAX o.id)',
       'it calls MAX with something other than one operand and DISTINCT or ALL'],
      ['SUM(', 'the SQL parser cannot read it as one expression'],
      ['  ', 'the SQL parser cannot read it as one expression'],
      ['SUM(o.amount);', 'the SQL parser cannot read it as one expression'],
    ];
    for (const [text, why] of expected) {
      expect(problem(text)).toEqual({text, problem: why});
    }
  });
});
