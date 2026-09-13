// Checking a model's constraints against a live store.
//
// A constraint is a logical invariant over the ontology (`Order.total >= 0`,
// `amount <= Order.total`). Enforcing one against a store means turning that
// logical statement into a query the store can answer. That is this module:
// given a model, an action and a constraint the action `guards`, it produces a
// PROBE -- a SELECT that returns the rows which VIOLATE the constraint. No rows
// means the rule holds.
//
// WHEN a probe runs is derived from the expression rather than authored, and
// the two answers are genuinely different checks:
//
//   * A GUARD reads an action parameter (`amount <= Order.total`). It asks
//     whether this call may proceed, so it runs BEFORE the writes, against the
//     rows the arguments denote. A parameter is not in the store, so no
//     post-state check could ask it.
//   * An INVARIANT reads only stored state (`Order.total >= 0`). It asks
//     whether the data is still sound, so it runs AFTER the writes and before
//     the commit, when the new state exists to be read.
//
// Both run inside the action's own transaction, so a violation rolls back with
// everything else and no violating state is ever visible to another reader.
//
// Three properties matter more than expressive power:
//
//   * The lowering FAILS CLOSED. An expression this module cannot lower does
//     not quietly pass: it returns a reason, and the runtime refuses the action
//     rather than running it unchecked. A gate that lets writes through is
//     worse than no gate, because it is believed.
//   * The lowering needs no argument VALUES. A probe is SQL with the action's
//     own parameters left as `@name`, so the call that decides whether an
//     action is runnable at all -- asked before any argument arrives, to decide
//     whether to offer an agent the tool -- produces the very SQL that later
//     runs. One answer, so the advertised verdict and the real one cannot
//     drift.
//   * A probe is SCOPED to the rows the call touches. An action writes a
//     handful of rows, and a gate whose cost grows with the table is a gate
//     that gets switched off.
//
// The grammar is small (see parseExpression): comparisons between a field, an
// action parameter and a literal, joined by AND/OR. It covers the rules an
// operational action actually trips -- an amount over a ceiling, a credit
// larger than what it credits -- and everything outside it is reported rather
// than approximated. Aggregates, parentheses and function calls are named as
// unlowerable, which refuses the action rather than guessing at it.

import * as spanner from '../../gcp/spanner';

import {spannerTable} from '../binding';
import {
  Action,
  Constraint,
  constraintEvaluation,
  Entity,
  fieldBinding,
  SemanticModel,
  ViolationEffect,
} from '../ir';
import {blankStringLiterals, STRING_LITERAL} from '../sql_expr_utils';
import {quoteIfReserved, referencedParameters} from '../sql_identifiers';


// When a probe runs, relative to the action's own writes.
//
//   - `before` the write has not happened. The probe reads the pre-state and
//              the call's arguments, and a violation means the call is refused.
//   - `after`  the writes have run in the transaction but nothing is committed.
//              The probe reads the post-state, and a violation rolls it back.
export type ProbeTiming = 'before'|'after';


// A constraint lowered to SQL, ready to run inside the action's transaction.
export interface ConstraintProbe {
  constraint: Constraint;
  timing: ProbeTiming;
  // The entity the probe reads, absent when the expression names none: a rule
  // over the call's arguments alone, such as `amount <= 25`, reads no table.
  entity?: string;
  // A SELECT returning violating rows; an empty result means the rule holds.
  // Parameters are the action's own, bound by the caller at run time.
  sql: string;
  // The columns `sql` selects, so a violation can name the rows it found
  // rather than only reporting that one exists.
  columns: string[];
}


export type Lowering = {
  ok: true; probe: ConstraintProbe;
}|{
  ok: false;
  // Why this constraint cannot be checked here, phrased for whoever wrote the
  // model: the runtime surfaces it verbatim when it refuses the action.
  reason: string;
};


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


// How many violating rows a probe returns. A gate needs enough to explain
// itself, not the whole violation set.
const PROBE_LIMIT = 5;


// The comparison operators the grammar accepts, longest first so `>=` is
// matched before `>`.
const OPERATORS = ['>=', '<=', '!=', '<>', '=', '>', '<'] as const;


/**
 * Lowers every constraint `action` names in `guards`.
 *
 * Returns the probes it could build, the reasons for the ones it could not,
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
export function lowerGuards(model: SemanticModel, action: Action): {
  probes: ConstraintProbe[];
  errors: string[];
  unchecked: UncheckedRule[];
} {
  const probes: ConstraintProbe[] = [];
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
    const lowered = lowerGuard(model, action, constraint);
    if (lowered.ok) {
      probes.push(lowered.probe);
    } else if (effectOf(constraint) === 'warn') {
      unchecked.push({constraint: name, reason: lowered.reason});
    } else {
      errors.push(lowered.reason);
    }
  }
  return {probes, errors, unchecked};
}


/** Lowers one constraint as a gate on `action`, or says why it cannot be. */
export function lowerGuard(
    model: SemanticModel, action: Action, constraint: Constraint): Lowering {
  const fail = (reason: string): Lowering => ({
    ok: false,
    reason: `constraint '${constraint.name}' cannot be checked: ${reason}`,
  });

  // A judged rule is settled by a language model reading the proposed change.
  // Nothing here calls one, and the honest report of that is a refusal: the
  // alternative is an action whose model says it is judged running unjudged.
  if (constraintEvaluation(constraint) === 'judged') {
    return fail(
        `it is settled by judgment rather than by an expression, and this ` +
        `runtime runs no judge`);
  }

  const parameters = new Map(action.parameters.map(p => [p.name, p]));
  const parsed = parseExpression(constraint.expression ?? '', parameters);
  if ('error' in parsed) return fail(parsed.error);

  const entityNames = new Set<string>();
  for (const comparison of parsed.comparisons) {
    for (const operand of [comparison.left, comparison.right]) {
      if (operand.kind === 'field') entityNames.add(operand.entity);
    }
  }
  if (entityNames.size > 1) {
    return fail(
        `it spans ${[...entityNames].sort().join(' and ')}; a probe reads ` +
        `one entity's table, so write one constraint per entity and list ` +
        `them together in 'guards'`);
  }

  // A rule that reads a parameter asks about this call, so it is answered
  // before the write; one that reads only stored state asks whether the data
  // is sound, which only the post-state can answer.
  const readsParameter = parsed.comparisons.some(
      c => c.left.kind === 'parameter' || c.right.kind === 'parameter');
  const timing: ProbeTiming = readsParameter ? 'before' : 'after';

  if (!entityNames.size) {
    // No table to read: the rule is entirely about the call's own arguments.
    // `UNNEST([1])` is the one-row source GoogleSQL needs for a SELECT that
    // has a WHERE and nothing to select from.
    const predicate = renderPredicate(parsed, new Map());
    return {
      ok: true,
      probe: {
        constraint,
        timing,
        sql: `SELECT 1 AS violated FROM UNNEST([1]) WHERE ${
            violating(predicate)}`,
        columns: ['violated'],
      },
    };
  }

  const entityName = [...entityNames][0];
  const entity = (model.entities ?? []).find(e => e.name === entityName);
  if (!entity) return fail(`'${entityName}' is not an entity of this model`);
  if (entity.abstract) {
    return fail(`'${entityName}' is abstract, so it has no table to read`);
  }

  const columns = new Map<string, string>();
  for (const comparison of parsed.comparisons) {
    for (const operand of [comparison.left, comparison.right]) {
      if (operand.kind !== 'field') continue;
      if (columns.has(operand.field)) continue;
      const column = columnFor(entity, operand.field);
      if ('error' in column) return fail(column.error);
      columns.set(operand.field, column.column);
    }
  }

  const scope = scopeToTouchedRows(action, entity);
  if ('error' in scope) return fail(scope.error);

  const keys = keyColumns(entity);
  if ('error' in keys) return fail(keys.error);

  const warnings: string[] = [];
  const table =
      spannerTable(entity.dataSource, warnings, `entity '${entity.name}'`);
  if (warnings.length) {
    return fail(`'${entityName}' has no usable table (${warnings.join('; ')})`);
  }

  const predicate = renderPredicate(parsed, columns);
  return {
    ok: true,
    probe: {
      constraint,
      timing,
      entity: entityName,
      sql: `SELECT ${keys.columns.join(', ')} FROM ${table} WHERE ${
          scope.predicate} AND ${violating(predicate)} LIMIT ${PROBE_LIMIT}`,
      columns: keys.columns,
    },
  };
}


/**
 * `probe` as a statement, carrying the argument values it reads.
 *
 * Filtered to the parameters the SQL actually names: a statement carrying one
 * it never reads is a statement the store may refuse, and an action's
 * parameter list is wider than any single rule.
 */
export function probeStatement(
    probe: ConstraintProbe, params: Record<string, unknown>,
    types: Record<string, {code: string}>): spanner.Statement {
  const statement: spanner.Statement = {sql: probe.sql};
  const used: Record<string, unknown> = {};
  const usedTypes: Record<string, {code: string}> = {};
  for (const name of new Set(referencedParameters(probe.sql))) {
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


/**
 * A violation of `probe`, given the rows it returned.
 *
 * The constraint's `description` leads, because it is the model author's own
 * words about what the caller should do differently; the name and the
 * expression follow as the citation for it.
 */
export function violationFrom(
    probe: ConstraintProbe, rows: string[][]): ConstraintViolation {
  const constraint = probe.constraint;
  const lead = constraint.description?.trim() ||
      `Constraint '${constraint.name}' does not hold.`;
  const parts =
      [lead, `Stopped by '${constraint.name}' (${constraint.expression}).`];
  // Rows are named only when they identify something: the one-row result of a
  // rule over the arguments alone says nothing a reader can use.
  const instances = probe.entity ? rows.map(row => row.join('/')) : [];
  if (instances.length) {
    parts.push(`Violating ${probe.entity}: ${instances.join(', ')}.`);
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


// NOT COALESCE(p, FALSE) rather than a plain NOT: SQL's three-valued logic
// makes `NULL >= 0` unknown and `NOT unknown` unknown too, so a NULL column
// would slip past a plain negation. Reading unknown as "did not satisfy the
// rule" makes the row a violation, which is the fail-closed answer a gate owes.
function violating(predicate: string): string {
  return `NOT COALESCE(${predicate}, FALSE)`;
}


// Restricts the probe to the rows this call touches.
//
// An action names the rows it acts on through its entity-typed parameters, and
// that reference is what makes the probe cheap and its answer relevant.
// Without one, `amount <= Order.total` would be asked of every order in the
// table and fail on the first unrelated one, so a constraint over an entity
// the action does not take as a parameter is refused rather than widened into
// a table scan. Checking stored state at large is a different binding point --
// a conformance sweep over the data rather than a gate on one call -- and it
// needs its own reference instead of this one silently standing in for it.
//
// EVERY parameter of that entity is in scope, not the first one found.
// `TransferFunds(source: Account, target: Account, amount)` writes both
// accounts, so a rule over `Account` that asked only about `source` would let
// the write that breaks `target` through while reporting the rule as checked.
// A gate that answers about some of the rows it was asked about is worse than
// one that refuses, because its answer is believed.
function scopeToTouchedRows(
    action: Action, entity: Entity): {predicate: string}|{error: string} {
  const params =
      action.parameters.filter(p => p.isEntityRef && p.type === entity.name);
  if (!params.length) {
    return {
      error: `it reads ${entity.name}, and action '${action.name}' takes no ` +
          `${entity.name} parameter, so the probe could not be limited to ` +
          `the rows this call touches`,
    };
  }
  const keys = keyColumns(entity);
  if ('error' in keys) return {error: keys.error};
  if (keys.columns.length !== 1) {
    return {
      error: `${entity.name} has a ${keys.columns.length}-part key, and the ` +
          `runtime binds an object reference as a single value`,
    };
  }
  const key = keys.columns[0];
  if (params.length === 1) {
    return {predicate: `${key} = @${params[0].name}`};
  }
  return {
    predicate: `${key} IN (${params.map(p => `@${p.name}`).join(', ')})`,
  };
}


// The physical column behind `fieldName`, or why there is none. A bare column
// is required: a field bound to an expression (`price * quantity`) would need
// that expression inlined and re-resolved, which this grammar does not do.
function columnFor(entity: Entity, fieldName: string):
    {column: string}|{error: string} {
  const field = entity.fields.find(f => f.name === fieldName);
  if (!field) {
    return {error: `${entity.name} declares no field '${fieldName}'`};
  }
  // No binding is what unbound means: the profile in force bound nothing to
  // this field, so there is no column to read the rule against.
  const binding = (fieldBinding(field) ?? '').trim();
  if (!binding) {
    return {
      error: `${entity.name}.${fieldName} is unbound under this profile, so ` +
          `there is nothing to read it from`,
    };
  }
  if (!/^[A-Za-z_]\w*$/.test(binding)) {
    return {
      error: `${entity.name}.${fieldName} is bound to an expression (${
          binding}) rather than to a column`,
    };
  }
  return {column: quoteIfReserved(binding)};
}


// The entity's key columns, resolved through its fields.
function keyColumns(entity: Entity): {columns: string[]}|{error: string} {
  if (!entity.keys?.length) {
    return {
      error: `${entity.name} declares no key, so a violation could not be ` +
          `attributed to a row`,
    };
  }
  const columns: string[] = [];
  for (const key of entity.keys) {
    const column = columnFor(entity, key);
    if ('error' in column) return {error: `its key ${column.error}`};
    columns.push(column.column);
  }
  return {columns};
}


// An operand of a comparison: a field of an entity, an action parameter, or a
// literal already in SQL form.
type Operand = {
  kind: 'field'; entity: string; field: string;
}|{
  kind: 'parameter'; name: string;
}|{
  kind: 'literal'; text: string;
};


interface Comparison {
  left: Operand;
  right: Operand;
  operator: string;
}


// Comparisons and the logical operators between them: `joiners[i]` sits
// between `comparisons[i]` and `comparisons[i + 1]`.
interface ParsedExpression {
  comparisons: Comparison[];
  joiners: string[];
}


// Parses a constraint expression.
//
// The grammar:
//
//   expression := comparison (('AND' | 'OR') comparison)*
//   comparison := operand <op> operand
//   operand    := <Entity>.<field> | <parameter> | literal
//   op         := >= | <= | != | <> | = | > | <
//   literal    := a number, a single-quoted string, TRUE, FALSE or NULL
//
// `= NULL` and `!= NULL` read as null tests and lower to IS NULL / IS NOT NULL.
// Parentheses, function calls, aggregates, IN, BETWEEN, LIKE and metric
// references are all outside the grammar, on purpose. Each is a real thing a
// constraint might want and each needs a decision this module does not make --
// how an aggregate is evaluated inside a row-level probe, for one -- so each is
// refused with a reason rather than half-handled.
function parseExpression(
    expression: string,
    parameters: Map<string, {name: string}>): ParsedExpression|{error: string} {
  const text = expression.trim();
  if (!text) return {error: 'it declares no expression'};
  if (text.includes('==')) {
    return {
      error: `it writes '==' (${text}); equality in the expression language ` +
          `is a single '='`,
    };
  }
  if (/[()]/.test(text)) {
    return {
      error: `it uses parentheses or a function call (${
          text}), which the grammar does not parse`,
    };
  }

  const split = splitOnLogicalOperators(text);
  const comparisons: Comparison[] = [];
  for (const segment of split.parts) {
    const comparison = parseComparison(segment, parameters);
    if ('error' in comparison) return comparison;
    comparisons.push(comparison);
  }
  return {comparisons, joiners: split.joiners};
}


// Splits on top-level AND/OR, matched as whole words so a field named `brand`
// survives. There are no parentheses to nest -- parseExpression refuses them --
// so every operator found is top level.
function splitOnLogicalOperators(expression: string):
    {parts: string[]; joiners: string[]} {
  const parts: string[] = [];
  const joiners: string[] = [];
  // Scan a copy with the literals masked, so `Account.status = 'ON HOLD OR
  // CLOSED'` does not come apart inside the quotes. The mask is the same length
  // as what it replaces, so every index still points into the original.
  //
  // `blankStringLiterals` fills with spaces, which is wrong here: a blanked
  // literal would join the whitespace on either side of it, and `\s+AND\s+`
  // would then match across the space the literal used to occupy. The filler
  // has to be something `\s` does not match.
  const masked = expression.replace(STRING_LITERAL, m => '.'.repeat(m.length));
  const pattern = /\s+(AND|OR)\s+/gi;
  let last = 0;
  let match: RegExpExecArray|null;
  while ((match = pattern.exec(masked)) !== null) {
    parts.push(expression.slice(last, match.index));
    joiners.push(match[1].toUpperCase());
    last = match.index + match[0].length;
  }
  parts.push(expression.slice(last));
  return {parts, joiners};
}


function parseComparison(
    segment: string,
    parameters: Map<string, {name: string}>): Comparison|{error: string} {
  const text = segment.trim();
  const found = findOperator(text);
  if (!found) {
    return {
      error: `'${text}' is not a comparison (expected one of ${
          OPERATORS.join(', ')})`,
    };
  }
  const leftText = text.slice(0, found.index).trim();
  const rightText = text.slice(found.index + found.operator.length).trim();
  if (!leftText) return {error: `'${text}' has nothing left of the operator`};
  if (!rightText) return {error: `'${text}' has nothing right of the operator`};

  const left = parseOperand(leftText, parameters);
  if ('error' in left) return {error: `in '${text}', ${left.error}`};
  const right = parseOperand(rightText, parameters);
  if ('error' in right) return {error: `in '${text}', ${right.error}`};

  const operator = found.operator === '<>' ? '!=' : found.operator;

  // GoogleSQL refuses `col = NULL` outright rather than evaluating it to
  // unknown, so lowering it verbatim would emit a probe that cannot run. An
  // author writing `Order.closedOn != NULL` means the column must be
  // populated, which SQL spells IS NOT NULL -- so the two operators with a
  // null-test reading are translated and the four without one are refused, an
  // ordering comparison against NULL having no meaning to preserve.
  const isNull = (operand: Operand) =>
      operand.kind === 'literal' && /^NULL$/i.test(operand.text);
  if (isNull(left) || isNull(right)) {
    if (operator !== '=' && operator !== '!=') {
      return {
        error: `'${text}' compares with NULL using '${operator}', which has ` +
            `no meaning; write '= NULL' or '!= NULL' to ask whether the ` +
            `field is set`,
      };
    }
    return {
      left: isNull(left) ? right : left,
      right: {kind: 'literal', text: 'NULL'},
      operator: operator === '=' ? 'IS' : 'IS NOT',
    };
  }

  return {left, right, operator};
}


function parseOperand(
    text: string,
    parameters: Map<string, {name: string}>): Operand|{error: string} {
  const field = text.match(/^([A-Za-z_]\w*)\.([A-Za-z_]\w*)$/);
  if (field) return {kind: 'field', entity: field[1], field: field[2]};
  if (isLiteral(text)) return {kind: 'literal', text};
  if (/^[A-Za-z_]\w*$/.test(text)) {
    if (parameters.has(text)) return {kind: 'parameter', name: text};
    return {
      error: `'${text}' is not a parameter of this action; a field is ` +
          `written <Entity>.<field>`,
    };
  }
  return {error: `'${text}' is not a field, a parameter or a literal`};
}


// The first comparison operator in `text`, longest match first so `>=` is not
// read as `>` with a stray `=` after it. Read with the literals blanked, so an
// operator character inside a string -- `'a>b' = Order.tag` -- is not mistaken
// for the comparison.
function findOperator(text: string): {operator: string; index: number}|null {
  let best: {operator: string; index: number}|null = null;
  const masked = blankStringLiterals(text);
  for (const operator of OPERATORS) {
    const index = masked.indexOf(operator);
    if (index < 0) continue;
    if (!best || index < best.index ||
        (index === best.index && operator.length > best.operator.length)) {
      best = {operator, index};
    }
  }
  return best;
}


// A literal the probe embeds verbatim, restricted to shapes with no quoting
// hazard: a number, a single-quoted string with no embedded quote or
// backslash, or one of the three keywords. Anything else is refused rather
// than escaped, because a constraint expression is model text and a surprising
// escape is harder to notice than a refusal.
function isLiteral(text: string): boolean {
  if (/^[-+]?\d+(\.\d+)?$/.test(text)) return true;
  if (/^'[^'\\]*'$/.test(text)) return true;
  return /^(TRUE|FALSE|NULL)$/i.test(text);
}


// Renders the parsed expression against the physical columns. Each comparison
// is parenthesized, so a mixed AND/OR expression keeps the precedence the SQL
// engine gives it rather than one this module invents.
function renderPredicate(
    parsed: ParsedExpression, columns: Map<string, string>): string {
  const render = (operand: Operand): string => {
    switch (operand.kind) {
      case 'field':
        return columns.get(operand.field)!;
      case 'parameter':
        return `@${operand.name}`;
      case 'literal':
        return operand.text;
    }
  };
  const parts = parsed.comparisons.map(
      c => `(${render(c.left)} ${c.operator} ${render(c.right)})`);
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) {
    out = `${out} ${parsed.joiners[i - 1]} ${parts[i]}`;
  }
  return out;
}
