// The SQL dialect a bound store speaks (`GoogleSQL` for Spanner and BigQuery,
// `PostgreSQL` for AlloyDB).
//
// `kcmd skills-generate` uses this surface when emitting the physical table
// and column map in `SKILL.md` (`readableEntities` in `agent_tools.ts` and
// `readableSchema` in `skills.ts`):
// - `name`: names the dialect the store expects (`GoogleSQL` or `PostgreSQL`).
// - `quote`: quotes table and column identifiers according to that dialect's
//   rules (backticks only when needed in GoogleSQL; double quotes in
//   PostgreSQL so mixed-case physical names survive folding).

import {quoteIdentifier} from '../sql_identifiers';

import {Store} from './store';


export interface SqlDialect {
  /** Which dialect this is, for a message that needs to name it. */
  readonly name: 'GoogleSQL'|'PostgreSQL';
  /** An identifier, quoted as this dialect requires. */
  quote(identifier: string): string;
}


/** Spanner and BigQuery. */
export const GOOGLE_SQL: SqlDialect = {
  name: 'GoogleSQL',
  // Quote only what would otherwise be misread -- a reserved word, or a name
  // that is not a bare identifier. GoogleSQL is case-preserving and
  // case-insensitive, so an ordinary name reaches the column it names without
  // help, and backticking every one of them would churn the table map for no
  // gain.
  quote: quoteIdentifier,
};


/** AlloyDB (PostgreSQL). */
export const POSTGRESQL: SqlDialect = {
  name: 'PostgreSQL',
  // PostgreSQL folds an unquoted identifier to lowercase before looking it up,
  // so `OrderId` unquoted asks for a column named `orderid` and misses one
  // created as `"OrderId"`. Quoting unconditionally is the one rule that
  // reaches the column however the schema was written, and escapes an embedded
  // quote by doubling it.
  quote: id => `"${id.replace(/"/g, '""')}"`,
};


/** The dialect `store` speaks; defaults to GoogleSQL when no store is bound. */
export function dialectFor(store: Store|undefined): SqlDialect {
  return store?.kind === 'alloydb' ? POSTGRESQL : GOOGLE_SQL;
}
