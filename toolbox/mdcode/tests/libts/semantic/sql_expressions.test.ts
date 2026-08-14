// Behavior specification for the sql-expressions aspect codec
// (src/libts/semantic/sql_expressions.ts). expressionRecords (emit) and
// recoverExpressions (read) are exact inverses over the qualifier convention:
// omitted -> primary GoogleSQL, `imported` -> the vendor form.

import {describe, expect, test} from 'bun:test';

import {expressionRecords, recoverExpressions} from '../../../src/libts/semantic/sql_expressions';

describe('expressionRecords (emit)', () => {
  test('primary only -> a single unqualified record', () => {
    expect(expressionRecords('SUM(o.p)', undefined)).toEqual([
      {sql: 'SUM(o.p)'}
    ]);
  });

  test('imported only -> a single `imported`-qualified record', () => {
    expect(expressionRecords(undefined, 'o.p::NUMBER')).toEqual([
      {qualifier: 'imported', sql: 'o.p::NUMBER'},
    ]);
  });

  test('both -> primary first, then imported', () => {
    expect(expressionRecords('CAST(o.p AS INT64)', 'o.p::int')).toEqual([
      {sql: 'CAST(o.p AS INT64)'},
      {qualifier: 'imported', sql: 'o.p::int'},
    ]);
  });

  test('neither -> empty (caller omits the aspect)', () => {
    expect(expressionRecords(undefined, undefined)).toEqual([]);
  });

  test('an empty-string expression is a value, not absence', () => {
    expect(expressionRecords('', undefined)).toEqual([{sql: ''}]);
  });
});


describe('recoverExpressions (read)', () => {
  test('inverts expressionRecords for the both-forms case', () => {
    const records = expressionRecords('CAST(o.p AS INT64)', 'o.p::int');
    expect(recoverExpressions(records)).toEqual({
      expression: 'CAST(o.p AS INT64)',
      importedExpression: 'o.p::int',
    });
  });

  test('an unqualified record is the primary expression', () => {
    expect(recoverExpressions([{sql: 'o.p'}])).toEqual({expression: 'o.p'});
  });

  test('an `imported` record is the imported expression only', () => {
    expect(recoverExpressions([{qualifier: 'imported', sql: 'o.p::int'}]))
        .toEqual({importedExpression: 'o.p::int'});
  });

  test('missing / empty records recover nothing', () => {
    expect(recoverExpressions(undefined)).toEqual({});
    expect(recoverExpressions([])).toEqual({});
  });

  test('the first record of each kind wins', () => {
    expect(recoverExpressions([
      {sql: 'first'},
      {sql: 'second'},
      {qualifier: 'imported', sql: 'imp1'},
      {qualifier: 'imported', sql: 'imp2'},
    ])).toEqual({expression: 'first', importedExpression: 'imp1'});
  });

  test('malformed records (no sql) and unknown qualifiers are skipped', () => {
    expect(recoverExpressions([
      {qualifier: 'sql_always_where', sql: 'x = 1'},  // future role, not ours
      {sql: undefined as any},                        // malformed
      {sql: 'o.p'},
    ])).toEqual({expression: 'o.p'});
  });
});
