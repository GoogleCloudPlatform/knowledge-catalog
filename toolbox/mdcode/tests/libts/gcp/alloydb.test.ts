// Behavior spec for the three pure translations the AlloyDB client performs:
// named parameters into PostgreSQL's positional ones, a SQLSTATE into the HTTP
// status the runtime reasons about, and a PostgreSQL value into the string the
// runtime reads.
//
// These are the whole of what makes AlloyDB look like the other operational
// backend, and none of them needs a database to check. What does need one --
// the connection, the token-as-password, the cluster CA -- is exercised by the
// live suite; everything here is the part that has to be right before a
// connection is worth opening.

import {describe, expect, test} from 'bun:test';

import {asString, hasMultipleCommands, shapeResult, statusForSqlState, toPositional} from '../../../src/libts/gcp/alloydb';

describe('named parameters become positional ones', () => {
  test('each name takes the next slot, in the order it appears', () => {
    const {text, values} = toPositional(
        'INSERT INTO "orders" ("id", "customer") VALUES (@id, @customer)',
        {id: 'o-1', customer: 'c-9'});
    expect(text).toBe('INSERT INTO "orders" ("id", "customer") VALUES ($1, $2)');
    expect(values).toEqual(['o-1', 'c-9']);
  });

  // A name is a name, not an occurrence: the planner writes a key column into
  // both a SET and a WHERE often enough that sending the value twice would be
  // the common case rather than the odd one.
  test('a repeated name reuses its placeholder and sends one value', () => {
    const {text, values} =
        toPositional('SELECT * FROM t WHERE a = @x OR b = @x', {x: 7});
    expect(text).toBe('SELECT * FROM t WHERE a = $1 OR b = $1');
    expect(values).toEqual([7]);
  });

  // Spanner is told each parameter's type alongside the statement. PostgreSQL
  // infers, and infers wrongly often enough -- a bare $1 compared against a
  // bigint column is the usual way to meet it -- that a declared type is cast
  // onto the placeholder rather than left to the planner.
  test('a declared type is cast onto the placeholder', () => {
    const {text} = toPositional(
        'SELECT * FROM t WHERE id = @id AND at < @at', {id: 1, at: 'now'},
        {id: {code: 'INT64'}, at: {code: 'TIMESTAMP'}});
    expect(text).toBe(
        'SELECT * FROM t WHERE id = $1::bigint AND at < $2::timestamptz');
  });

  test('a type this client does not know leaves the placeholder bare', () => {
    const {text} = toPositional('SELECT @x', {x: 1}, {x: {code: 'STRUCT'}});
    expect(text).toBe('SELECT $1');
  });

  // A parameter the caller never bound is null rather than missing: a missing
  // one would shift every placeholder after it onto the wrong value, which is
  // a far worse failure than a NULL the statement can refuse on its own terms.
  test('an unbound name binds null and still takes its slot', () => {
    const {text, values} = toPositional('SELECT @a, @b, @c', {a: 1, c: 3});
    expect(text).toBe('SELECT $1, $2, $3');
    expect(values).toEqual([1, null, 3]);
  });
});

describe('an @ that is not a parameter is left alone', () => {
  test('inside a string literal', () => {
    const {text, values} = toPositional(
        `UPDATE t SET memo = 'ping @alex' WHERE id = @id`, {id: 1});
    expect(text).toBe(`UPDATE t SET memo = 'ping @alex' WHERE id = $1`);
    expect(values).toEqual([1]);
  });

  test('inside a doubled quote within a string literal', () => {
    const {text} = toPositional(`SELECT 'it''s @here', @id`, {id: 1});
    expect(text).toBe(`SELECT 'it''s @here', $1`);
  });

  test('inside a quoted identifier', () => {
    const {text} = toPositional('SELECT "@odd" FROM t WHERE a = @a', {a: 1});
    expect(text).toBe('SELECT "@odd" FROM t WHERE a = $1');
  });

  test('inside a dollar-quoted body', () => {
    const {text, values} =
        toPositional('SELECT $tag$ @not_a_param $tag$, @real', {real: 'x'});
    expect(text).toBe('SELECT $tag$ @not_a_param $tag$, $1');
    expect(values).toEqual(['x']);
  });

  test('inside a line comment and a block comment', () => {
    const {text, values} = toPositional(
        'SELECT 1 -- @nope\n/* @also_nope */, @yes', {yes: 2});
    expect(text).toBe('SELECT 1 -- @nope\n/* @also_nope */, $1');
    expect(values).toEqual([2]);
  });

  // PostgreSQL spells absolute value `@`, and an operator is not a parameter
  // just because a parameter starts the same way.
  test('as an operator, where no identifier follows', () => {
    const {text, values} = toPositional('SELECT @ -3, @x', {x: 1});
    expect(text).toBe('SELECT @ -3, $1');
    expect(values).toEqual([1]);
  });
});

// The runtime decides whether a failed statement definitely did not commit by
// reading a status, and it learned those statuses from Spanner. Every mapping
// below exists to make one of those conclusions come out the same way here.
describe('a SQLSTATE reads as the status the runtime reasons about', () => {
  test('a serialization failure and a deadlock are the retryable 409', () => {
    expect(statusForSqlState('40001')).toBe(409);
    expect(statusForSqlState('40P01')).toBe(409);
  });

  test('a constraint violation is equally definite', () => {
    expect(statusForSqlState('23505')).toBe(409);
    expect(statusForSqlState('23503')).toBe(409);
  });

  test('a privilege refusal is 403, and a rejected credential is 401', () => {
    expect(statusForSqlState('42501')).toBe(403);
    expect(statusForSqlState('28P01')).toBe(401);
  });

  test('a wrong statement is 400', () => {
    expect(statusForSqlState('42601')).toBe(400);
    expect(statusForSqlState('42P01')).toBe(400);
    expect(statusForSqlState('22P02')).toBe(400);
  });

  test('a missing database or schema is 404', () => {
    expect(statusForSqlState('3D000')).toBe(404);
    expect(statusForSqlState('3F000')).toBe(404);
  });

  // 500 is the runtime's "outcome unknown", and an unrecognized SQLSTATE is
  // exactly that -- claiming anything more definite would let a caller retry a
  // write that may already have landed.
  test('an unrecognized or absent SQLSTATE is the indeterminate 500', () => {
    expect(statusForSqlState('XX000')).toBe(500);
    expect(statusForSqlState('57014')).toBe(500);
    expect(statusForSqlState(undefined)).toBe(500);
  });

  // The one member of class 40 that is not a rollback. PostgreSQL raises it
  // when it cannot say whether the transaction committed, so reporting it the
  // way its neighbours are reported would tell the runtime the write definitely
  // did not land -- and a caller acting on that applies it twice.
  test('an unknown completion is 500, not the 409 its neighbours get', () => {
    expect(statusForSqlState('40003')).toBe(500);
    expect(statusForSqlState('40001')).toBe(409);
    expect(statusForSqlState('40000')).toBe(409);
  });
});

describe('a value is rendered the way Spanner renders it', () => {
  test('null and undefined are both null, and nothing else is', () => {
    expect(asString(null)).toBeNull();
    expect(asString(undefined)).toBeNull();
    expect(asString('')).toBe('');
    expect(asString(0)).toBe('0');
    expect(asString(false)).toBe('false');
  });

  test('a timestamp is ISO-8601 and bytes are base64', () => {
    expect(asString(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))))
        .toBe('2026-01-02T03:04:05.000Z');
    expect(asString(new Uint8Array([104, 105]))).toBe('aGk=');
  });

  test('jsonb comes back as its text, not as [object Object]', () => {
    expect(asString({a: 1})).toBe('{"a":1}');
    expect(asString([1, 'x'])).toBe('[1,"x"]');
  });
});


describe('a second command is refused before it is sent', () => {
  // PostgreSQL's extended protocol rejects a multi-command string on its own,
  // but a statement that binds no parameters goes out in simple query mode,
  // where the server runs all of them. So the answer cannot depend on how many
  // parameters a statement happened to have, and neither do these.
  test('one statement is one statement, with or without a trailing semicolon',
       () => {
         expect(hasMultipleCommands('UPDATE t SET a = 1')).toBe(false);
         expect(hasMultipleCommands('UPDATE t SET a = 1;')).toBe(false);
         expect(hasMultipleCommands('UPDATE t SET a = 1;  \n')).toBe(false);
       });

  test('a command after a semicolon is a second command', () => {
    expect(hasMultipleCommands('UPDATE t SET a = 1; DROP TABLE t')).toBe(true);
    expect(hasMultipleCommands('SELECT 1;SELECT 2')).toBe(true);
  });

  test('a trailing comment is not a command', () => {
    expect(hasMultipleCommands('SELECT 1; -- done')).toBe(false);
    expect(hasMultipleCommands('SELECT 1; /* done */')).toBe(false);
  });

  // The whole reason the check shares a lexer with `toPositional`: a semicolon
  // that is part of a value has not ended anything.
  test('a semicolon inside a literal, an identifier or a comment ends nothing',
       () => {
         expect(hasMultipleCommands(`UPDATE t SET memo = 'a; b'`)).toBe(false);
         expect(hasMultipleCommands('SELECT "a;b" FROM t')).toBe(false);
         expect(hasMultipleCommands('SELECT $$ a; b $$')).toBe(false);
         expect(hasMultipleCommands('SELECT 1 -- a; b\n')).toBe(false);
         expect(hasMultipleCommands('SELECT /* a; b */ 1')).toBe(false);
       });

  test('a comment before the semicolon belongs to the first command', () => {
    expect(hasMultipleCommands('SELECT 1 /* note */; SELECT 2')).toBe(true);
    expect(hasMultipleCommands('SELECT 1 /* note */;')).toBe(false);
  });
});

describe('a result keeps its columns in the order the SELECT listed them', () => {
  // Rows arrive from `.values()` as arrays rather than as objects keyed by
  // column name, because two columns of one SELECT can share an output name --
  // a profile may bind two fields to the same column -- and a keyed row would
  // collapse them into one entry, shortening the row. Callers read by position,
  // so a short row is not a missing value but every later value misread.
  test('two columns sharing a name stay two columns', () => {
    const shaped = shapeResult([['12.50', '12.50'], ['3.00', '3.00']]);
    expect(shaped.rows).toEqual([['12.50', '12.50'], ['3.00', '3.00']]);
  });

  test('every value is rendered, nulls included', () => {
    const shaped = shapeResult([[1, null, new Date(Date.UTC(2026, 0, 2))]]);
    expect(shaped.rows).toEqual([['1', null, '2026-01-02T00:00:00.000Z']]);
  });

  test('an affected-row count rides along when Bun reports one', () => {
    const rows: any = [];
    rows.count = 2;
    expect(shapeResult(rows).stats?.rowCountExact).toBe('2');
    expect(shapeResult([]).stats).toBeUndefined();
  });
});
