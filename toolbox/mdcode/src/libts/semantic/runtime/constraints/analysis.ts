// What a constraint says, before anything decides how to ask it.
//
// Three questions are settled here, and none of them depends on the store, on
// the profile in force or on the query language: whether the rule is inside
// the grammar at all, which names it reads, and WHEN it has to be asked.
// Keeping them here is what lets a second dialect emit the same rule without
// re-deciding any of it, and what lets the answer come before a session is
// ever opened -- the call that decides whether to offer an agent a tool asks
// this with no arguments in hand.
//
// The two moments are genuinely different checks:
//
//   * A GUARD reads an action parameter (`amount <= Order.total`). It asks
//     whether this call may proceed, so it runs BEFORE the writes, against the
//     rows the arguments denote. A parameter is not in the store, so no
//     post-state check could ask it.
//   * An INVARIANT reads only stored state (`Order.total >= 0`). It asks
//     whether the data is still sound, so it runs AFTER the writes and before
//     the commit, when the new state exists to be read.

import {Action, Constraint} from '../../ir';

import {CheckTiming} from './check';
import {Comparison, ParsedExpression, parseExpression} from './expression';


/** A constraint expression, read for everything that does not vary by store. */
export interface AnalyzedRule {
  parsed: ParsedExpression;
  timing: CheckTiming;
  // The entities the rule reads, sorted, empty when it reads only the call's
  // own arguments. Reported rather than judged: how many entities one check
  // may span is a property of the shape it is emitted in, so whoever emits it
  // decides.
  entities: string[];
  // The fields it reads, in first-mention order. Meaningful when `entities`
  // holds exactly one.
  fields: string[];
  // The action parameters it reads, in first-mention order.
  parameters: string[];
}


/** Reads `constraint` as a rule over `action`, or says why it cannot be read. */
export function analyze(action: Action, constraint: Constraint): AnalyzedRule|
    {error: string} {
  const declared = new Map(action.parameters.map(p => [p.name, p]));
  const parsed = parseExpression(constraint.expression ?? '', declared);
  if ('error' in parsed) return parsed;

  const entities = new Set<string>();
  const fields: string[] = [];
  const parameters: string[] = [];
  for (const comparison of parsed.comparisons) {
    for (const operand of [comparison.left, comparison.right]) {
      if (operand.kind === 'field') {
        entities.add(operand.entity);
        if (!fields.includes(operand.field)) fields.push(operand.field);
      } else if (operand.kind === 'parameter') {
        if (!parameters.includes(operand.name)) parameters.push(operand.name);
      }
    }
  }

  const timing = timingOf(parsed, constraint);
  if ('error' in timing) return timing;

  return {
    parsed,
    timing: timing.timing,
    entities: [...entities].sort(),
    fields,
    parameters,
  };
}


// When the rule has to be asked, read off what its comparisons reference.
//
// A comparison that reads a parameter asks about this call, so it is answered
// before the write; one that reads only stored state asks whether the data is
// sound, which only the post-state can answer.
function timingOf(parsed: ParsedExpression, constraint: Constraint):
    {timing: CheckTiming}|{error: string} {
  const readsParameter = (c: Comparison) =>
      c.left.kind === 'parameter' || c.right.kind === 'parameter';
  const readsField = (c: Comparison) =>
      c.left.kind === 'field' || c.right.kind === 'field';
  const aboutTheCall = parsed.comparisons.filter(readsParameter);
  const aboutTheData =
      parsed.comparisons.filter(c => !readsParameter(c) && readsField(c));

  // One check runs at one moment, so an expression that needs both cannot be
  // taken whole. Timing it by whether any comparison reads a parameter would
  // put the stored half against the pre-state and never look again: the write
  // that breaks it commits, and the rule reports as checked.
  if (aboutTheCall.length && aboutTheData.length) {
    return {
      error: `it asks both about this call's arguments and about stored data ` +
          `(${constraint.expression}); the first is answered before the write ` +
          `and the second after it, so write one constraint for each and ` +
          `list them together in 'guards'`,
    };
  }
  return {timing: aboutTheCall.length ? 'before' : 'after'};
}
