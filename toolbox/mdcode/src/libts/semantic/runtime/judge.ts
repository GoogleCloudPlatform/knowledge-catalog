// Asking something other than the store whether a rule holds.
//
// A `judgment` states a rule in words, and it is the one body a constraint
// has: *the credit memo must name a specific service failure* is a real
// requirement with a real owner, and no arithmetic settles it. What answers one
// is a language model reading the attempted call against the rule's own text.
//
// This file is the seam and nothing else. It names what a judge is asked and
// what it must answer, so the runtime can ask one and report the answer with
// no model client on the library's dependency list -- the arrangement
// agent_tools.ts already makes for agent frameworks. Implementations live
// outside: gcp/gemini.ts has one, and a caller may pass its own.
//
// A judge may also be given a store to read while it decides, which is the
// second interface here. Some rules are about the call alone -- whether a memo
// names a service failure -- and some compare the call against what is already
// recorded, which nothing in the request can carry because the request is
// written before anyone knows which rows matter. `JudgeStore` is how an
// implementation finds out.

/** What a judge is asked about one attempted call. */
export interface JudgeRequest {
  // The rule's name, so an answer can be traced back to what asked for it.
  constraint: string;
  // The rule in the author's words, verbatim. A judge is never handed a
  // paraphrase: the text is the thing the catalog governs and the thing every
  // caller is held to.
  rule: string;
  // What the caller is trying to do, and why the model says it exists.
  action: string;
  actionDescription?: string;
  // The arguments as the caller stated them. This is the whole of what the
  // request carries, and not the whole of what a judge may know: one holding a
  // `JudgeStore` reads the rows a rule names. What no judge can be shown is the
  // state the write would produce, because a guard is settled before the
  // transaction opens, so a rule about that has no binding point here.
  arguments: Record<string, unknown>;
}


/** What one read returned, or why it returned nothing. */
export interface JudgeQueryResult {
  /**
   * The column names, in the order the rows carry them. Empty when the store
   * reports none, which some backends do; the rows are positional either way.
   */
  columns: string[];
  /** The rows, every value rendered as text. */
  rows: Array<Array<string|null>>;
  /** Set when the read hit its row cap and more rows matched. */
  truncated: boolean;
  /**
   * Why the read returned nothing: a statement that was refused, a table that
   * does not exist, a store that could not be reached. Present instead of
   * rows, and written to be read back to whoever asked, because the thing that
   * asked is a language model that can correct itself and try again.
   */
  problem?: string;
}


/**
 * A store a judge may read from while it decides.
 *
 * Read-only, and not by convention: `problem` rather than a thrown error is
 * how a refused statement comes back, so an implementation can refuse anything
 * that is not a query and the judge reads the refusal as an answer.
 *
 * A judge reads OUTSIDE the transaction the write will run in, because a guard
 * is settled before that transaction opens. So what a read here reports is
 * true when it is read and not guaranteed still true when the write commits.
 * That is the standing limit on settling an arithmetic rule this way. A rule
 * that has to hold under concurrency wants the store enforcing it inside the
 * transaction -- compute it there and let the guard read the answer.
 */
export interface JudgeStore {
  /**
   * The tables and columns that may be read, written for a model to read. An
   * implementation composes this from the semantic model's bindings, so a
   * judge is told the physical schema of exactly what it is allowed to see.
   */
  readonly schema: string;
  /** Runs one read. Never throws: every failure comes back as `problem`. */
  read(sql: string): Promise<JudgeQueryResult>;
}


/** What a judge answers. */
export interface JudgeVerdict {
  // Whether the rule holds for this call.
  holds: boolean;
  // Why, in a sentence or two, written for whoever made the call. Required
  // even when the rule holds: a judge that cannot say why is one nobody can
  // audit, and the reason is the only part of a model's answer a reader can
  // check.
  reason: string;
}


/**
 * Something that can settle a rule stated in words.
 *
 * Asynchronous because every implementation is a network call, and named so a
 * report can say what answered. Throwing is allowed and means the judge was
 * unavailable, which leaves the rule unchecked: an advisory rule reports that
 * it was not checked, and anything stricter stops the call.
 */
export interface Judge {
  readonly name: string;
  decide(request: JudgeRequest): Promise<JudgeVerdict>;
}
