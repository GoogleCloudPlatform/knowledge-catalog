// The SQL dialect a store speaks, for the statements the runtime writes itself.
//
// Most of what the runtime sends is not its own: an action's statements come
// from a binding profile, written by hand for the database that profile
// deploys to. Those need no dialect, because their author already chose one.
//
// But some statements the runtime composes. Resolving "Morgan Ellis" to a
// customer id is a SELECT nobody wrote down; so is the lookup behind a derived
// agent tool. Those are generated from the model, and until there was one
// backend they could be generated in one dialect. With Spanner and AlloyDB both
// answering, the generated ones have to be written in whichever dialect will
// receive them.
//
// The surface is deliberately tiny -- two operations -- and that is a claim
// worth stating rather than a coincidence. The generated statements are plain:
// a SELECT of some columns from one table, with equality predicates and a
// LIMIT. Nothing in that shape differs between GoogleSQL and PostgreSQL except
// how an identifier is quoted and how a value is rendered as text. A dialect
// that needed more than this would be a sign the runtime had started
// generating SQL it should be asking the profile for.
//
// Parameters are NOT here. The runtime names its parameters `@name` for every
// backend, and the AlloyDB client rewrites them to PostgreSQL's positional
// `$n` on the way out (see gcp/alloydb.ts). Translating them here instead would
// mean a profile author writing an action for AlloyDB had to count their
// placeholders, and would leave the two backends with two parameter syntaxes
// for the runtime to keep straight.

import {quoteIdentifier} from '../sql_identifiers';

import {Store} from './store';


export interface SqlDialect {
  /** Which dialect this is, for a message that needs to name it. */
  readonly name: 'GoogleSQL'|'PostgreSQL';
  /** An identifier, quoted as this dialect requires. */
  quote(identifier: string): string;
  /** `expr` rendered as text, for a column read back as a string. */
  castToText(expr: string): string;
}


/** Spanner and BigQuery. */
export const GOOGLE_SQL: SqlDialect = {
  name: 'GoogleSQL',
  // Quote only what would otherwise be misread -- a reserved word, or a name
  // that is not a bare identifier. GoogleSQL is case-preserving and
  // case-insensitive, so an ordinary name reaches the column it names without
  // help, and backticking every one of them would churn the statements this
  // has always produced for no gain.
  quote: quoteIdentifier,
  castToText: expr => `CAST(${expr} AS STRING)`,
};


/** AlloyDB. */
export const POSTGRESQL: SqlDialect = {
  name: 'PostgreSQL',
  // Always quoted, which is the opposite of the rule above and is right for
  // the opposite reason. An unquoted PostgreSQL identifier is folded to lower
  // case, so a column physically named `lineItemId` is NOT reached by writing
  // lineItemId -- the server looks for `lineitemid` and reports that no such
  // column exists. A binding profile states physical names exactly, so quoting
  // every one of them is what makes the profile mean what it says. It also
  // removes the need for a PostgreSQL reserved-word list: a quoted identifier
  // is never a keyword.
  quote: identifier => `"${identifier.replace(/"/g, '""')}"`,
  castToText: expr => `CAST(${expr} AS TEXT)`,
};


/**
 * The dialect to write for a store. A store with no client to run statements
 * on -- BigQuery -- still answers GoogleSQL, so this is total rather than
 * partial: a caller composing a statement never has to handle "no dialect".
 */
export function dialectFor(store?: Store): SqlDialect {
  return store?.kind === 'alloydb' ? POSTGRESQL : GOOGLE_SQL;
}
