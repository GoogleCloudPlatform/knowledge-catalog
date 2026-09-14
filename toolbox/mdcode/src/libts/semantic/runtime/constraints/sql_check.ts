// Checking a constraint by asking the store.
//
// Given a rule the analysis accepted, this builds the query returning the rows
// that BREAK it -- a probe. No rows means the rule holds. Which table and
// columns it reads comes from bind.ts, how the query is written comes from the
// dialect, and what the rule is allowed to say was settled in analysis.ts.
// What is left here is the wiring between them, and the refusals that arise
// only once a real table is involved.
//
// Two properties shape everything below:
//
//   * The probe needs no argument VALUES. It is a query with the action's own
//     parameters left unbound, so the call that decides whether an action is
//     runnable at all -- asked before any argument arrives, to decide whether
//     to offer an agent the tool -- produces the very query that later runs.
//     One answer, so the advertised verdict and the real one cannot drift.
//   * The probe is SCOPED to the rows the call touches. An action writes a
//     handful of rows, and a gate whose cost grows with the table is a gate
//     that gets switched off.

import {analyze} from './analysis';
import {columnsFor, keyColumns, rowsTouchedBy, tableFor} from './bind';
import {cannotCheck, CheckPlan, ConstraintChecker} from './check';
import {SqlDialect} from './dialect';
import {Operand, ParsedExpression} from './expression';


// How many violating rows a probe returns. A gate needs enough to explain
// itself, not the whole violation set.
const PROBE_LIMIT = 5;


/**
 * The checker for a constraint stated as an expression.
 *
 * Every refusal it gives names something about this model, this action or this
 * store; nothing here refuses on the grammar, which `analyze` has already
 * passed on.
 */
export const sqlCheck: ConstraintChecker =
    ({model, action, constraint, dialect}): CheckPlan => {
      const fail = (reason: string) => cannotCheck(constraint, reason);

      const rule = analyze(action, constraint);
      if ('error' in rule) return fail(rule.error);

      // A probe reads one table, so a rule naming two entities has no shape in
      // this dialect. A dialect that traverses a relationship rather than
      // scanning a table can answer it, and would lift this.
      if (rule.entities.length > 1) {
        return fail(
            `it spans ${rule.entities.join(' and ')}; a probe reads ` +
            `one entity's table, so write one constraint per entity and list ` +
            `them together in 'guards'`);
      }

      if (!rule.entities.length) {
        // No table to read: the rule is entirely about the call's arguments.
        const predicate = renderPredicate(rule.parsed, new Map(), dialect);
        return {
          ok: true,
          check: {
            constraint,
            timing: rule.timing,
            query: {
              text: dialect.argumentProbe(predicate),
              parameters: rule.parameters,
            },
            columns: ['violated'],
          },
        };
      }

      const entityName = rule.entities[0];
      const entity = (model.entities ?? []).find(e => e.name === entityName);
      if (!entity) return fail(`'${entityName}' is not an entity of this model`);
      if (entity.abstract) {
        return fail(`'${entityName}' is abstract, so it has no table to read`);
      }

      const bound = columnsFor(entity, rule.fields);
      if ('error' in bound) return fail(bound.error);

      const touched = rowsTouchedBy(action, entity);
      if ('error' in touched) return fail(touched.error);

      const keys = keyColumns(entity);
      if ('error' in keys) return fail(keys.error);

      const table = tableFor(entity);
      if ('error' in table) return fail(table.error);

      const predicate = renderPredicate(rule.parsed, bound.columns, dialect);
      return {
        ok: true,
        check: {
          constraint,
          timing: rule.timing,
          entity: entityName,
          query: {
            text: dialect.entityProbe({
              table: table.table,
              keys: keys.columns,
              scope: renderScope(touched, dialect),
              predicate,
              limit: PROBE_LIMIT,
            }),
            // The scope reads the entity-typed parameters whether or not the
            // rule mentions them, so both sets are named.
            parameters: [...new Set([...rule.parameters, ...touched.parameters])],
          },
          columns: keys.columns,
        },
      };
    };


// Restricts the probe to the rows this call touches. See rowsTouchedBy.
function renderScope(
    touched: {key: string; parameters: string[]}, dialect: SqlDialect): string {
  const key = dialect.columnRef(touched.key);
  const refs = touched.parameters.map(p => dialect.parameterRef(p));
  return refs.length === 1 ? `${key} = ${refs[0]}` :
                             `${key} IN (${refs.join(', ')})`;
}


// Renders the parsed expression against the physical columns. Each comparison
// is parenthesized, so a mixed AND/OR expression keeps the precedence the
// engine gives it rather than one this module invents.
function renderPredicate(
    parsed: ParsedExpression, columns: Map<string, string>,
    dialect: SqlDialect): string {
  const render = (operand: Operand): string => {
    switch (operand.kind) {
      case 'field':
        return dialect.columnRef(columns.get(operand.field)!);
      case 'parameter':
        return dialect.parameterRef(operand.name);
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
