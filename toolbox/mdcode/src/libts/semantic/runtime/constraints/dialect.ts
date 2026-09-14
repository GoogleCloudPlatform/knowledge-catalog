// How a check is spelled, for one query language.
//
// Binding decides WHICH table and column a rule reads; a dialect decides how
// to write that reference down and how to wrap it in a statement the store
// will run. They are apart because they vary apart: GoogleSQL and GQL read the
// same Spanner column of the same Spanner table and write the reference
// differently, while the same model deployed on another engine would bind
// different tables and be written much the same way.
//
// A dialect spells; it decides nothing. Whether a rule may be checked at all,
// which entity it reads and when it must run are settled in analysis.ts before
// any dialect is consulted, so adding one cannot widen or narrow what the
// runtime agrees to check.

import {quoteIfReserved} from '../../sql_identifiers';


/** A probe over the rows of one entity. */
export interface EntityProbe {
  // The physical table, resolved and already in the form the store addresses
  // it by (see spannerTable in binding.ts, which quotes as it resolves).
  table: string;
  // Physical key columns, bare, in the entity's declared key order.
  keys: string[];
  // Limits the probe to the rows this call touches.
  scope: string;
  // The constraint, rendered. True of a row that satisfies the rule.
  predicate: string;
  // How many violating rows to return. A gate needs enough to explain itself,
  // not the whole violation set.
  limit: number;
}


export interface SqlDialect {
  // Named in a refusal, so a reader can tell which leg turned the rule away.
  readonly name: string;

  /** A physical column of the probed entity, as written inside a predicate. */
  columnRef(column: string): string;

  /** A reference to one of the action's parameters. */
  parameterRef(name: string): string;

  /** A probe returning the rows of one entity that break the rule. */
  entityProbe(probe: EntityProbe): string;

  /**
   * A probe over the call's arguments alone, which reads no table and returns
   * one row when the rule is broken.
   */
  argumentProbe(predicate: string): string;
}


// NOT COALESCE(p, FALSE) rather than a plain NOT: SQL's three-valued logic
// makes `NULL >= 0` unknown and `NOT unknown` unknown too, so a NULL column
// would slip past a plain negation. Reading unknown as "did not satisfy the
// rule" makes the row a violation, which is the fail-closed answer a gate
// owes. Shared rather than written per dialect because it is ordinary SQL and
// every dialect here inherits the same three-valued logic.
export function violating(predicate: string): string {
  return `NOT COALESCE(${predicate}, FALSE)`;
}


/**
 * GoogleSQL reading the entity's own table.
 *
 * The dialect every Spanner deployment can use, because it needs nothing
 * deployed beyond the tables the action already writes to.
 */
export const GOOGLE_SQL: SqlDialect = {
  name: 'GoogleSQL',

  columnRef: (column) => quoteIfReserved(column),

  parameterRef: (name) => `@${name}`,

  entityProbe: ({table, keys, scope, predicate, limit}) =>
      `SELECT ${keys.map(quoteIfReserved).join(', ')} FROM ${table} WHERE ${
          scope} AND ${violating(predicate)} LIMIT ${limit}`,

  // `UNNEST([1])` is the one-row source GoogleSQL needs for a SELECT that has
  // a WHERE and nothing to select from.
  argumentProbe: (predicate) =>
      `SELECT 1 AS violated FROM UNNEST([1]) WHERE ${violating(predicate)}`,
};
