// Checking an action's guards against a live deployment.
//
// A constraint is a logical invariant over the ontology (`Order.total >= 0`,
// `amount <= Order.total`). An action that names one in `guards` claims the
// rule holds of every call it makes, and this package is what makes the claim
// true: each named constraint becomes one check, run inside the action's own
// transaction, so a rule that does not hold rolls the write back and no
// violating state is ever visible to another reader.
//
// The package is laid out along the two ways a check varies, and they are
// independent:
//
//   * WHAT SETTLES THE RULE. A constraint declares exactly one body and the
//     body says who answers it. An `expression` is answered by the store
//     (sql_check.ts); a `judgment` is answered by a language model reading the
//     proposed change (judgment.ts). CHECKERS below maps one to the other,
//     keyed by the IR's own CONSTRAINT_EVALUATIONS, so a third body cannot be
//     added to the model without this map failing to compile.
//   * HOW A STORE IS ASKED. One rule, one meaning, more than one language to
//     write it in: GoogleSQL over the entity's own table today, GQL over the
//     pushed property graph next, whatever a future engine reads after that.
//     dialect.ts holds that axis alone. Nothing outside it -- not the grammar,
//     not the timing, not the refusals -- changes when a dialect is added.
//
// Everything a check needs to be DECIDED is settled before a session opens and
// with no argument values in hand (analysis.ts, bind.ts), which is what lets
// one call answer both "may this action be offered at all" and "what shall I
// run". The advertised verdict and the real one cannot drift, because they are
// the same answer.
//
// The property that outranks expressive power: planning FAILS CLOSED. A
// constraint this package cannot turn into a check does not quietly pass. It
// returns a reason, and the runtime refuses the action rather than running it
// unchecked, because a gate that lets writes through is worse than no gate --
// it is believed.

import {
  Action,
  Constraint,
  ConstraintEvaluation,
  constraintEvaluation,
  SemanticModel,
} from '../../ir';

import {
  CheckPlan,
  ConstraintChecker,
  ConstraintCheck,
  effectOf,
  UncheckedRule,
} from './check';
import {GOOGLE_SQL, SqlDialect} from './dialect';
import {judgedCheck} from './judgment';
import {sqlCheck} from './sql_check';


// One checker per way a constraint can be settled. Total over the IR's own
// enumeration rather than a lookup with a fallback: a body the model can
// declare and this package has no answer for is a rule that would be silently
// skipped, and the compiler is a better place to find that out than a run.
const CHECKERS: Record<ConstraintEvaluation, ConstraintChecker> = {
  deterministic: sqlCheck,
  judged: judgedCheck,
};


/**
 * Plans every constraint `action` names in `guards`.
 *
 * Returns the checks it could build, the reasons for the ones it could not,
 * and the advisory rules it had to leave unevaluated. A non-empty `errors`
 * means the action cannot be run: the model says the call is checked, and a
 * check that cannot be performed is not one.
 *
 * An ADVISORY rule -- `on_violation: warn` -- is the exception, and it is
 * `unchecked` rather than an error. It reports and lets the write through, so
 * being unable to evaluate it costs the caller a report and stops nothing;
 * refusing over it would turn a rule the author wrote as advice into the one
 * thing that makes the action unrunnable. It is still named, because a report
 * that was owed and not made is news in its own right.
 */
export function planGuards(
    model: SemanticModel, action: Action,
    dialect: SqlDialect = GOOGLE_SQL): {
  checks: ConstraintCheck[];
  errors: string[];
  unchecked: UncheckedRule[];
} {
  const checks: ConstraintCheck[] = [];
  const errors: string[] = [];
  const unchecked: UncheckedRule[] = [];
  for (const name of action.guards ?? []) {
    const constraint = (model.constraints ?? []).find(c => c.name === name);
    if (!constraint) {
      // Not classifiable as advisory: the model declares nothing by this name,
      // so there is no `on_violation` to read, and guessing is not on offer.
      errors.push(
          `action '${action.name}' is guarded by '${name}', which this model ` +
          `does not declare`);
      continue;
    }
    const planned = planGuard(model, action, constraint, dialect);
    if (planned.ok) {
      checks.push(planned.check);
    } else if (effectOf(constraint) === 'warn') {
      unchecked.push({constraint: name, reason: planned.reason});
    } else {
      errors.push(planned.reason);
    }
  }
  return {checks, errors, unchecked};
}


/** Plans one constraint as a gate on `action`, or says why it cannot be. */
export function planGuard(
    model: SemanticModel, action: Action, constraint: Constraint,
    dialect: SqlDialect = GOOGLE_SQL): CheckPlan {
  return CHECKERS[constraintEvaluation(constraint)](
      {model, action, constraint, dialect});
}


export {
  checkStatement,
  effectOf,
  strictestEffect,
  violationFrom,
} from './check';
export type {
  CheckerContext,
  CheckPlan,
  CheckTiming,
  ConstraintCheck,
  ConstraintChecker,
  ConstraintViolation,
  StoreQuery,
  StoreStatement,
  UncheckedRule,
} from './check';
export {GOOGLE_SQL, violating} from './dialect';
export type {EntityProbe, SqlDialect} from './dialect';
