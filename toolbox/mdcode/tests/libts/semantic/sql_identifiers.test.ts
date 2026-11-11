// Behavior spec for the GoogleSQL identifier-quoting helpers
// (src/libts/semantic/sql_identifiers.ts) both graph generators use to keep a
// reserved-keyword name (an entity called `Order`, a field called `end`) from
// becoming a syntax error in the emitted DDL.

import {describe, expect, test} from 'bun:test';

import {isReservedKeyword, leadingDmlVerb, quoteColumnIfReserved, quoteIdentifier, quoteIfReserved, referencedParameters} from '../../../src/libts/semantic/sql_identifiers';

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

describe('quoteColumnIfReserved', () => {
  test('backticks a lone reserved keyword, which a binding reads as a column', () => {
    expect(quoteColumnIfReserved('order')).toBe('`order`');
    expect(quoteColumnIfReserved('Range')).toBe('`Range`');
  });

  // Backticked, each would be a column of that name.
  test('leaves TRUE, FALSE and NULL bare, in any case, since they are values', () => {
    for (const value of ['TRUE', 'false', 'Null']) {
      expect(quoteColumnIfReserved(value)).toBe(value);
    }
  });

  test('passes anything else through unchanged', () => {
    expect(quoteColumnIfReserved('order_id')).toBe('order_id');
    expect(quoteColumnIfReserved('a + b')).toBe('a + b');
    expect(quoteColumnIfReserved('`order`')).toBe('`order`');
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


describe('leadingDmlVerb', () => {
  test('reads the verb past both line-comment forms', () => {
    // GoogleSQL takes `#` as well as `--`, and action DML runs against
    // Spanner. A `#` comment mentioning another verb used to hand that verb
    // back, which costs in the expensive direction: the INSERT exemption is
    // lost and a legitimate zero-row INSERT is refused.
    expect(leadingDmlVerb('# update the audit trail\nINSERT INTO t VALUES (1)'))
        .toBe('INSERT');
    expect(leadingDmlVerb('-- update the audit trail\nINSERT INTO t VALUES (1)'))
        .toBe('INSERT');
  });

  test('reads past a block comment and a CTE', () => {
    expect(leadingDmlVerb('/* delete later */ UPDATE t SET a = 1'))
        .toBe('UPDATE');
    expect(leadingDmlVerb('WITH x AS (SELECT 1) UPDATE t SET a = 1'))
        .toBe('UPDATE');
  });

  test('a quoted literal is not a verb', () => {
    expect(leadingDmlVerb("UPDATE t SET note = 'DELETE'")).toBe('UPDATE');
  });

  test('a statement holding no DML verb reads as none', () => {
    expect(leadingDmlVerb('SELECT * FROM t')).toBe('');
    expect(leadingDmlVerb('# nothing here')).toBe('');
  });
});


describe('referencedParameters', () => {
  test('ignores @name inside -- and /* */ comments, including \\r line endings and EOF',
       () => {
         expect(referencedParameters(
                    'UPDATE orders SET status = @status -- @note is optional'))
             .toEqual(['status']);
         expect(referencedParameters(
                    'UPDATE orders SET status = @status /* @note */'))
             .toEqual(['status']);
         expect(referencedParameters(
                    '-- @before\nUPDATE orders SET status = @status\n/* @after */'))
             .toEqual(['status']);
         expect(referencedParameters(
                    'UPDATE orders -- @before\rSET status = @status'))
             .toEqual(['status']);
         expect(referencedParameters(
                    'UPDATE orders SET status = @status /* @unterminated'))
             .toEqual(['status']);
         // An apostrophe inside a comment never opens a string literal.
         expect(referencedParameters(
                    '-- don\'t bind @note\n' +
                    'UPDATE orders SET status = @status, kind = \'rush\''))
             .toEqual(['status']);
       });

  test('treats # as a comment in GoogleSQL and as an operator in PostgreSQL/AlloyDB',
       () => {
         expect(referencedParameters(
                    'UPDATE orders SET status = @status # @note is optional'))
             .toEqual(['status']);
         expect(referencedParameters(
                    '# @before\rINSERT INTO orders (id) VALUES (@id)', 'SPANNER'))
             .toEqual(['id']);
         expect(referencedParameters(
                    'UPDATE orders SET doc = doc #- \'{draft}\' WHERE id = @id',
                    'ALLOYDB'))
             .toEqual(['id']);
         expect(referencedParameters(
                    'UPDATE orders SET doc = doc #- \'{draft}\' WHERE id = @id',
                    'POSTGRES'))
             .toEqual(['id']);
       });

  test('handles GoogleSQL string/raw/triple literals and backticked identifiers',
       () => {
         expect(referencedParameters(
                    'UPDATE `my@table` SET email = \'a@b.com\', ' +
                    'note = \'it\\\'s @nobody\', id = @id'))
             .toEqual(['id']);
         expect(referencedParameters(
                    'UPDATE customer SET a = \'\'\'don\'t @bind\'\'\', ' +
                    'b = """say "hi" to @nobody""", ' +
                    'pat = r\'it\\\'s @skip\', esc = r\'\\\'\', ' +
                    'dir = r\'\'\'C:\\\\\'\'\', ' +
                    'bytes = b\'it\\\'s @skip\' WHERE id = @id -- \''))
             .toEqual(['id']);
       });

  test('handles PostgreSQL/AlloyDB quotes, E\'...\', dollar-quotes, and nested comments',
       () => {
         // Single backslash does not escape `'` in standard PG strings (even
         // after a keyword ending in E); `''''` is a complete literal.
         expect(referencedParameters(
                    'DELETE FROM "user@table" WHERE path LIKE\'C:\\\' ' +
                        'AND quote = \'\'\'\' AND note = \'it\'\'s @nobody\' ' +
                        'AND id = @id',
                    'POSTGRES'))
             .toEqual(['id']);
         expect(referencedParameters(
                    'UPDATE t SET body = E\'it\'\'s \\\'@nobody\\\'\' WHERE id = @id',
                    'POSTGRES'))
             .toEqual(['id']);
         // Nested block comments, ` operator, $-identifiers, and $tag$ strings.
         expect(referencedParameters(
                    '/* outer /* inner */ @skip */ UPDATE t SET x = a ` b, ' +
                        'col$a$b = $$@skip$$, fn = $fn$a $$ @skip $$ b$fn$, ' +
                        's = e\'it\\\'s @skip\' WHERE id = $1 AND k = @id',
                    'ALLOYDB'))
             .toEqual(['id']);
         expect(referencedParameters('SELECT $1$$@id', 'POSTGRES'))
             .toEqual(['id']);
         expect(referencedParameters(
                    '/* outer /* inner */ @ignored', 'POSTGRES'))
             .toEqual([]);
       });

  test('returns distinct parameter names in order and ignores @@ and bare @',
       () => {
         expect(referencedParameters(
                    'UPDATE account SET balance = balance - -@amount_1 ' +
                    'WHERE account_id = @_source AND @amount_1 > 0 ' +
                    'AND tz = @@time_zone'))
             .toEqual(['amount_1', '_source']);
         expect(referencedParameters(
                    'DELETE FROM docs WHERE tsv @@ plainto_tsquery(@query) ' +
                        'AND x@@y',
                    'POSTGRES'))
             .toEqual(['query']);
         expect(referencedParameters('SELECT @1, @')).toEqual([]);
       });
});
