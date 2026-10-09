// Tests for the shared expression helpers in
// src/libts/semantic/sql_expr_utils.ts that both the model file's checks and a
// binding profile's checks use.

import {beforeAll, describe, expect, test} from 'bun:test';

import {columnReferences, fieldsReadOn, isColumnName, keysCoveredByColumns, referencedEntityNames} from '../../../src/libts/semantic/sql_expr_utils';
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
    expect(referencedEntityNames(
               'orders.Customer.id', entities, {caseInsensitive: true}))
        .toEqual(['orders']);
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
});
