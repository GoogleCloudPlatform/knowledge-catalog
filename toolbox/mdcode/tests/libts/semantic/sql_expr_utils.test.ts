// Tests for the shared expression helpers in
// src/libts/semantic/sql_expr_utils.ts that both the model file's checks and a
// binding profile's checks use.

import {describe, expect, test} from 'bun:test';

import {isColumnName, referencedEntityFields} from '../../../src/libts/semantic/sql_expr_utils';

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

describe('referencedEntityFields', () => {
  test('returns each field read through the entity, deduplicated in order', () => {
    expect(referencedEntityFields(
               'orders.amount + `orders`.`tax` - orders.amount', 'orders'))
        .toEqual(['amount', 'tax']);
  });

  test('ignores string literals and other entities', () => {
    expect(referencedEntityFields(
               "IF(orders.status = 'orders.note', customers.id, 0)", 'orders'))
        .toEqual(['status']);
  });

  test('reads a struct path as the field it starts with', () => {
    expect(referencedEntityFields('orders.shipping_address.city', 'orders'))
        .toEqual(['shipping_address']);
    expect(referencedEntityFields(
               'orders.shipping_address.city', 'shipping_address'))
        .toEqual([]);
  });

  test('matches case-sensitively unless asked not to', () => {
    expect(referencedEntityFields('Orders.amount', 'orders')).toEqual([]);
    expect(referencedEntityFields(
               'Orders.amount', 'orders', {caseInsensitive: true}))
        .toEqual(['amount']);
  });
});
