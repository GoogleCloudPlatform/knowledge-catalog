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

describe('pins to the authoritative GoogleSQL reserved set (not the transpiler)',
         () => {
           // The set is the UNION of the BigQuery and Spanner GoogleSQL reserved
           // lists so one table serves both generators. Both were checked
           // against the published lexical-structure docs (2026-08-30); they
           // differ only in QUALIFY (BigQuery reserves it, Spanner does not --
           // over-quoting on Spanner is harmless) and both reserve GRAPH_TABLE.
           // GRAPH_TABLE was verified live: rejected bare, accepted quoted. The
           // @polyglot-sql/sdk engine's reserved set diverges from this in BOTH
           // directions -- it misses EXTRACT and over-quotes
           // user/view/column/references -- so it is deliberately not the oracle.
           // These cases pin our set so the hand-kept list cannot silently drift.
           const MUST_QUOTE = [
             'Order', 'Group', 'From', 'Select', 'End', 'Range', 'Hash', 'All',
             'Extract', 'Within', 'Qualify', 'Rollup', 'Graph_Table',
           ];
           const MUST_STAY_BARE = [
             'Customer', 'order_id', 'segment', 'revenue',
             // keywords that are NOT reserved in BigQuery and must stay bare,
             // including ones the transpiler wrongly quotes:
             'key', 'value', 'source', 'user', 'view', 'column', 'references',
           ];
           test('reserved words are quoted', () => {
             for (const n of MUST_QUOTE) {
               expect(quoteIfReserved(n)).toBe(`\`${n}\``);
             }
           });
           test('non-reserved identifiers stay bare', () => {
             for (const n of MUST_STAY_BARE) expect(quoteIfReserved(n)).toBe(n);
           });
         });
