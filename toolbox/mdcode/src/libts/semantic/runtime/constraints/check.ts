// What a constraint check is, whatever settles it.
//
// A model states an invariant over the ontology. Enforcing one against a live
// deployment means turning that statement into something that can answer it,
// and more than one thing can: the store, asked a query, and a language model,
// asked to read the proposed change. What every answer has in common is here
// -- when the check is made, what a failure looks like, and what a failure
// does to the write -- so the runtime handles any of them the same way and no
// module has to know which others exist.

import {Action, Constraint, SemanticModel, ViolationEffect} from '../../ir';

import {SqlDialect} from './dialect';


// When a check runs, relative to the action's own writes.
//
//   - `before` the write has not happened. The check reads the pre-state and
//              the call's arguments, and a failure means the call is refused.
//   - `after`  the writes have run in the transaction but nothing is
//              committed. The check reads the post-state, and a failure rolls
//              it back.
export type CheckTiming = 'before'|'after';


/**
 * A query against the store, in whatever language the dialect emitted.
 *
 * `parameters` names the action parameters `text` reads, reported by the
 * emitter rather than recovered from the text afterwards. An action's
 * parameter list is wider than any single rule, a statement carrying a
 * parameter it never reads is one the store may refuse, and only the emitter
 * knows which sigil it wrote.
 */
export interface StoreQuery {
  text: string;
  parameters: string[];
}


/** A constraint turned into something runnable, and when to run it. */
export interface ConstraintCheck {
  constraint: Constraint;
  timing: CheckTiming;
  // The entity the check reads, absent when the rule names none: a rule over
  // the call's arguments alone, such as `amount <= 25`, reads no table.
  entity?: string;
  // Returns the rows that VIOLATE the constraint, so an empty result means the
  // rule holds. Parameters are the action's own, bound by the caller at run
  // time.
  query: StoreQuery;
  // The columns `query` returns, so a violation can name the rows it found
  // rather than only reporting that one exists.
  columns: string[];
}


export type CheckPlan = {
  ok: true; check: ConstraintCheck;
}|{
  ok: false;
  // Why this constraint cannot be checked here, phrased for whoever wrote the
  // model: the runtime surfaces it verbatim when it refuses the action.
  reason: string;
};


/** Everything a checker is handed. Each uses the part its own kind needs. */
export interface CheckerContext {
  model: SemanticModel;
  action: Action;
  constraint: Constraint;
  // How a check that asks the store spells its query. A checker that asks
  // something other than the store ignores it.
  dialect: SqlDialect;
}


/**
 * Plans one constraint as a gate on an action, or says why it cannot be.
 *
 * One implementation per way a constraint can be settled, and which one runs
 * is read off the constraint's own body rather than chosen by a caller. See
 * CONSTRAINT_EVALUATIONS in ir.ts and the registry in index.ts.
 */
export type ConstraintChecker = (ctx: CheckerContext) => CheckPlan;


/** A refusal, in the wording every checker gives one. */
export function cannotCheck(constraint: Constraint, reason: string): CheckPlan {
  return {
    ok: false,
    reason: `constraint '${constraint.name}' cannot be checked: ${reason}`,
  };
}


/** A statement as a store client takes it: the query and its bindings. */
export interface StoreStatement {
  sql: string;
  params?: Record<string, unknown>;
  paramTypes?: Record<string, {code: string}>;
}


/**
 * `check` as a statement, carrying the argument values it reads.
 *
 * Filtered to the parameters the query names, which the emitter reported when
 * it wrote them: a statement carrying one it never reads is a statement the
 * store may refuse, and an action's parameter list is wider than any single
 * rule.
 */
export function checkStatement(
    check: ConstraintCheck, params: Record<string, unknown>,
    types: Record<string, {code: string}>): StoreStatement {
  const statement: StoreStatement = {sql: check.query.text};
  const used: Record<string, unknown> = {};
  const usedTypes: Record<string, {code: string}> = {};
  for (const name of new Set(check.query.parameters)) {
    if (!(name in params)) continue;
    used[name] = params[name];
    if (types[name]) usedTypes[name] = types[name];
  }
  if (Object.keys(used).length) {
    statement.params = used;
    statement.paramTypes = usedTypes;
  }
  return statement;
}


// A rule that did not hold, in the terms a caller acts on.
export interface ConstraintViolation {
  constraint: string;
  effect: ViolationEffect;
  // The constraint's own `description` where it has one, which is written as
  // the instruction to the refused caller, followed by the citation.
  message: string;
  // The violating rows, each as its key values joined by '/'. Empty for a rule
  // over the arguments alone, which has no row to name.
  instances: string[];
}


// A rule that was named as a guard and not evaluated. Only an advisory rule
// reaches this: one that stops the call and cannot be checked refuses the
// action instead.
export interface UncheckedRule {
  constraint: string;
  // Why it could not be checked, in the same words a refusal would have used.
  reason: string;
}


/**
 * A violation of `check`, given the rows it returned.
 *
 * The constraint's `description` leads, because it is the model author's own
 * words about what the caller should do differently; the name and the body
 * follow as the citation for it. The body cited is whichever one the
 * constraint declares, so a rule settled in words cites the words.
 */
export function violationFrom(
    check: ConstraintCheck, rows: string[][]): ConstraintViolation {
  const constraint = check.constraint;
  const lead = constraint.description?.trim() ||
      `Constraint '${constraint.name}' does not hold.`;
  const body = constraint.expression ?? constraint.judgment;
  const parts = [
    lead,
    `Stopped by '${constraint.name}'${body ? ` (${body})` : ''}.`,
  ];
  // Rows are named only when they identify something: the one-row result of a
  // rule over the arguments alone says nothing a reader can use.
  const instances = check.entity ? rows.map(row => row.join('/')) : [];
  if (instances.length) {
    parts.push(`Violating ${check.entity}: ${instances.join(', ')}.`);
  }
  return {
    constraint: constraint.name,
    effect: effectOf(constraint),
    message: parts.join(' '),
    instances,
  };
}


/**
 * What a violated constraint does to the write.
 *
 * An `expression` that does not say defaults to `reject`, which is the safe
 * reading of an author who did not say. See VIOLATION_EFFECTS in ir.ts.
 */
export function effectOf(constraint: Constraint): ViolationEffect {
  return constraint.onViolation ?? 'reject';
}


// Harshest first. A call that trips two rules gets the stricter answer: being
// told a supervisor could approve a write another rule forbids outright would
// send the caller to ask for something nobody can give.
const EFFECT_ORDER: ViolationEffect[] = ['reject', 'escalate', 'warn'];


/** The strictest effect among `violations`, or null if there are none. */
export function strictestEffect(violations: readonly ConstraintViolation[]):
    ViolationEffect|null {
  for (const effect of EFFECT_ORDER) {
    if (violations.some(v => v.effect === effect)) return effect;
  }
  return null;
}
