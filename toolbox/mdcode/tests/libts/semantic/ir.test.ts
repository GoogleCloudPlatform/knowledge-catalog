// Unit tests for the Semantic Model IR types and helpers (ir.ts).

import {describe, expect, test} from 'bun:test';

import {
  DialectExpression,
  expressionForDialect,
  Field,
  Metric,
  normalizeDataType,
} from '../../../src/libts/semantic/ir';

describe('expressionForDialect', () => {
  test('returns the exact engine match even when ANSI_SQL appears first', () => {
    const dialects: DialectExpression[] = [
      {dialect: 'ANSI_SQL', expression: 'a + b'},
      {dialect: 'BIGQUERY', expression: 'SAFE_ADD(a, b)'},
    ];
    expect(expressionForDialect({dialects}, 'BIGQUERY')).toBe('SAFE_ADD(a, b)');
  });

  test('falls back to ANSI_SQL when target engine has no entry', () => {
    const dialects: DialectExpression[] = [
      {dialect: 'ANSI_SQL', expression: 'a + b'},
      {dialect: 'BIGQUERY', expression: 'SAFE_ADD(a, b)'},
    ];
    expect(expressionForDialect({dialects}, 'SPANNER')).toBe('a + b');
  });

  test('returns ANSI_SQL directly when targetDialect is ANSI_SQL', () => {
    const dialects: DialectExpression[] = [
      {dialect: 'BIGQUERY', expression: 'SAFE_ADD(a, b)'},
      {dialect: 'ANSI_SQL', expression: 'a + b'},
    ];
    expect(expressionForDialect({dialects}, 'ANSI_SQL')).toBe('a + b');
  });

  test('returns undefined when neither targetDialect nor ANSI_SQL is present', () => {
    const item: Field = {
      name: 'total',
      expression: 'should_not_be_used_when_dialects_is_non_empty',
      dialects: [
        {dialect: 'POSTGRES', expression: 'a + b'},
        {dialect: 'SNOWFLAKE', expression: 'NVL(a, 0) + b'},
      ],
    };
    expect(expressionForDialect(item, 'BIGQUERY')).toBeUndefined();
    expect(expressionForDialect(item, 'SPANNER')).toBeUndefined();
    expect(expressionForDialect(item, 'ANSI_SQL')).toBeUndefined();
  });

  test('falls back to item.expression when dialects is absent or empty', () => {
    const withoutDialects: Field = {
      name: 'net_amount',
      expression: 'orders.net_amount',
      stringForm: true,
    };
    const withEmptyDialects: Metric = {
      name: 'revenue',
      expression: 'SUM(orders.net_amount)',
      dialects: [],
      stringForm: true,
    };
    const unbound: Field = {
      name: 'unbound_field',
    };

    expect(expressionForDialect(withoutDialects, 'BIGQUERY'))
        .toBe('orders.net_amount');
    expect(expressionForDialect(withoutDialects, 'SPANNER'))
        .toBe('orders.net_amount');
    expect(expressionForDialect(withoutDialects, 'ANSI_SQL'))
        .toBe('orders.net_amount');

    expect(expressionForDialect(withEmptyDialects, 'BIGQUERY'))
        .toBe('SUM(orders.net_amount)');
    expect(expressionForDialect(withEmptyDialects, 'SPANNER'))
        .toBe('SUM(orders.net_amount)');

    expect(expressionForDialect(unbound, 'BIGQUERY')).toBeUndefined();
  });
});

describe('normalizeDataType', () => {
  const CANONICAL = [
    'String',
    'Integer',
    'Decimal',
    'Float',
    'Boolean',
    'Date',
    'Time',
    'DateTime',
    'DateTimeTz',
  ] as const;

  test('0.2.0.dev0 accepts all nine exact-case canonical names', () => {
    for (const name of CANONICAL) {
      expect(normalizeDataType(name, '0.2.0.dev0')).toEqual({
        ok: true,
        type: name,
      });
    }
  });

  test('0.2.0.dev0 rejects non-canonical casing and unknown types', () => {
    expect(normalizeDataType('integer', '0.2.0.dev0')).toEqual({ok: false});
    expect(normalizeDataType('STRING', '0.2.0.dev0')).toEqual({ok: false});
    expect(normalizeDataType('opaque', '0.2.0.dev0')).toEqual({ok: false});
    expect(normalizeDataType('VARCHAR', '0.2.0.dev0')).toEqual({ok: false});
  });

  test('0.2.0.dev0 normalizes Opaque and undefined to type: undefined', () => {
    expect(normalizeDataType('Opaque', '0.2.0.dev0')).toEqual({
      ok: true,
      type: undefined,
    });
    expect(normalizeDataType(undefined, '0.2.0.dev0')).toEqual({
      ok: true,
      type: undefined,
    });
  });

  test('0.2.0.dev0/google accepts any casing and returns the canonical spelling', () => {
    for (const name of CANONICAL) {
      expect(normalizeDataType(name, '0.2.0.dev0/google')).toEqual({
        ok: true,
        type: name,
      });
      expect(normalizeDataType(name.toLowerCase(), '0.2.0.dev0/google'))
          .toEqual({
            ok: true,
            type: name,
          });
      expect(normalizeDataType(name.toUpperCase(), '0.2.0.dev0/google'))
          .toEqual({
            ok: true,
            type: name,
          });
    }
    expect(normalizeDataType('datetime', '0.2.0.dev0/google')).toEqual({
      ok: true,
      type: 'DateTime',
    });
    expect(normalizeDataType('datetimetz', '0.2.0.dev0/google')).toEqual({
      ok: true,
      type: 'DateTimeTz',
    });
    expect(normalizeDataType('DATETIMETZ', '0.2.0.dev0/google')).toEqual({
      ok: true,
      type: 'DateTimeTz',
    });
  });

  test('0.2.0.dev0/google normalizes Opaque in any casing and undefined to type: undefined', () => {
    expect(normalizeDataType('Opaque', '0.2.0.dev0/google')).toEqual({
      ok: true,
      type: undefined,
    });
    expect(normalizeDataType('opaque', '0.2.0.dev0/google')).toEqual({
      ok: true,
      type: undefined,
    });
    expect(normalizeDataType('OPAQUE', '0.2.0.dev0/google')).toEqual({
      ok: true,
      type: undefined,
    });
    expect(normalizeDataType(undefined, '0.2.0.dev0/google')).toEqual({
      ok: true,
      type: undefined,
    });
  });

  test('0.2.0.dev0/google rejects unknown physical types', () => {
    expect(normalizeDataType('VARCHAR', '0.2.0.dev0/google')).toEqual({
      ok: false,
    });
    expect(normalizeDataType('INT64', '0.2.0.dev0/google')).toEqual({
      ok: false,
    });
  });
});

