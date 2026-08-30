// Behavior spec for the GoogleSQL identifier-quoting helpers
// (src/libts/semantic/sql_identifiers.ts) both graph generators use to keep a
// reserved-keyword name (an entity called `Order`, a field called `end`) from
// becoming a syntax error in the emitted DDL.

import {describe, expect, test} from 'bun:test';

import {isReservedKeyword, quoteIdentifier, quoteIfReserved} from '../../../src/libts/semantic/sql_identifiers';

describe('isReservedKeyword', () => {
  test('recognizes reserved keywords case-insensitively', () => {
    expect(isReservedKeyword('order')).toBe(true);
    expect(isReservedKeyword('ORDER')).toBe(true);
    expect(isReservedKeyword('Order')).toBe(true);
    expect(isReservedKeyword('group')).toBe(true);
    expect(isReservedKeyword('from')).toBe(true);
  });

  test('non-reserved keywords are legal bare identifiers', () => {
    // KEY, VALUE, and SOURCE are keywords but NOT reserved, so they are not
    // quoted -- quoting them would churn existing output for no reason.
    expect(isReservedKeyword('key')).toBe(false);
    expect(isReservedKeyword('value')).toBe(false);
    expect(isReservedKeyword('source')).toBe(false);
    expect(isReservedKeyword('Customer')).toBe(false);
    expect(isReservedKeyword('order_id')).toBe(false);
  });
});

describe('quoteIfReserved', () => {
  test('backticks a simple identifier that is a reserved keyword', () => {
    expect(quoteIfReserved('Order')).toBe('`Order`');
    expect(quoteIfReserved('from')).toBe('`from`');
  });

  test('leaves a non-reserved simple identifier byte-for-byte', () => {
    expect(quoteIfReserved('Customer')).toBe('Customer');
    expect(quoteIfReserved('order_id')).toBe('order_id');
    expect(quoteIfReserved('key')).toBe('key');
  });

  test('passes a non-simple value through unchanged', () => {
    // A computed expression at a KEY/REFERENCES site is a separate error the
    // generators warn about; this helper must not rewrite it.
    expect(quoteIfReserved('a + b')).toBe('a + b');
    expect(quoteIfReserved('`already`')).toBe('`already`');
  });
});

describe('quoteIdentifier', () => {
  test(
      'quotes a reserved keyword or a non-simple name; leaves the rest bare',
      () => {
        expect(quoteIdentifier('Order')).toBe('`Order`');
        expect(quoteIdentifier('Customer')).toBe('Customer');
        expect(quoteIdentifier('has-hyphen')).toBe('`has-hyphen`');
      });

  test('escapes an embedded backtick', () => {
    expect(quoteIdentifier('we`ird')).toBe('`we\\`ird`');
  });
});
