// Checking a constraint that is settled by judgment.
//
// A `judgment` states the rule in words, for the rules no expression decides:
// *the credit memo must name a specific service failure* is a real requirement
// with a real owner, and no arithmetic settles it. The store cannot answer
// one, so no dialect helps; what answers it is a language model reading the
// proposed change against the rule's own text.
//
// This runtime calls no model, and the honest report of that is a refusal. The
// alternative is an action whose model says it is judged running unjudged,
// which is the failure the whole evaluator exists to prevent. A `warn` rule
// still passes, because index.ts reports an advisory rule it cannot check
// rather than refusing over it.
//
// A judge lands here and nowhere else. What it needs beyond this file is a
// model client threaded to the point of use, since a judgment is answered
// outside the store and therefore outside the action's transaction -- which
// makes WHEN it runs a decision of its own rather than one read off the
// expression, and is why the timing analysis is not shared with it.

import {cannotCheck, CheckPlan, ConstraintChecker} from './check';


/** The checker for a constraint stated as a judgment. */
export const judgedCheck: ConstraintChecker = ({constraint}): CheckPlan =>
    cannotCheck(
        constraint,
        `it is settled by judgment rather than by an expression, and this ` +
            `runtime runs no judge`);
