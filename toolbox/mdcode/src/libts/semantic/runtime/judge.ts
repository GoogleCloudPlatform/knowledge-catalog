// Asking something other than the store whether a rule holds.
//
// A `judgment` states a rule in words, for the rules no expression decides:
// *the credit memo must name a specific service failure* is a real requirement
// with a real owner, and no arithmetic settles it. What answers one is a
// language model reading the attempted call against the rule's own text.
//
// This file is the seam and nothing else. It names what a judge is asked and
// what it must answer, so the runtime can ask one and report the answer with
// no model client on the library's dependency list -- the arrangement
// agent_tools.ts already makes for agent frameworks. Implementations live
// outside: gcp/gemini.ts has one, and a caller may pass its own.

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
  // The arguments as the caller stated them, which is the whole of what this
  // request carries. An implementation may consult whatever else it holds --
  // one built over a store connection can read the rows a rule names, and
  // nothing here forbids it -- but a judge is asked before the transaction
  // opens, so what it cannot be shown is the state the write would produce. A
  // rule about that has no binding point here.
  arguments: Record<string, unknown>;
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
