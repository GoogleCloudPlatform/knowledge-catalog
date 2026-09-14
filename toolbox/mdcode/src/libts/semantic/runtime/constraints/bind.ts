// Logical names to physical ones.
//
// `Order.total` is what the model says; column `Total` of table `Orders` is
// what the store holds. Which one it resolves to depends on the profile in
// force and on nothing about the query language, which is why this sits apart
// from the dialect: GoogleSQL and GQL read the same column of the same table
// and write the reference differently.
//
// Everything here returns bare physical names. How a name is quoted belongs to
// the language reading it, so the dialect does that at the moment it writes
// the reference. The one exception is the table, which arrives from the shared
// binding layer already in the form the store addresses it by.

import {spannerTable} from '../../binding';
import {Action, Entity, fieldBinding} from '../../ir';


/** The physical column behind each of `fields`, or why one has none. */
export function columnsFor(entity: Entity, fields: readonly string[]):
    {columns: Map<string, string>}|{error: string} {
  const columns = new Map<string, string>();
  for (const field of fields) {
    if (columns.has(field)) continue;
    const column = columnFor(entity, field);
    if ('error' in column) return column;
    columns.set(field, column.column);
  }
  return {columns};
}


/** The entity's key columns, in declared key order, resolved through fields. */
export function keyColumns(entity: Entity): {columns: string[]}|{error: string} {
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


/** The physical table `entity` is bound to, or why it has no usable one. */
export function tableFor(entity: Entity): {table: string}|{error: string} {
  const warnings: string[] = [];
  const table =
      spannerTable(entity.dataSource, warnings, `entity '${entity.name}'`);
  if (warnings.length) {
    return {
      error: `'${entity.name}' has no usable table (${warnings.join('; ')})`,
    };
  }
  return {table};
}


/**
 * The rows of `entity` this call touches: one key column and the parameters
 * that name values in it.
 *
 * An action names the rows it acts on through its entity-typed parameters, and
 * that reference is what makes a probe cheap and its answer relevant. Without
 * one, `amount <= Order.total` would be asked of every order in the table and
 * fail on the first unrelated one, so a constraint over an entity the action
 * does not take as a parameter is refused rather than widened into a table
 * scan. Checking stored state at large is a different binding point -- a
 * conformance sweep over the data rather than a gate on one call -- and it
 * needs its own reference instead of this one silently standing in for it.
 *
 * EVERY parameter of that entity is in scope, not the first one found.
 * `TransferFunds(source: Account, target: Account, amount)` writes both
 * accounts, so a rule over `Account` that asked only about `source` would let
 * the write that breaks `target` through while reporting the rule as checked.
 * A gate that answers about some of the rows it was asked about is worse than
 * one that refuses, because its answer is believed.
 */
export function rowsTouchedBy(action: Action, entity: Entity):
    {key: string; parameters: string[]}|{error: string} {
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
  return {key: keys.columns[0], parameters: params.map(p => p.name)};
}


// The physical column behind `fieldName`, or why there is none. A bare column
// is required: a field bound to an expression (`price * quantity`) would need
// that expression inlined and re-resolved, which this grammar does not do.
function columnFor(entity: Entity, fieldName: string): {column: string}|
    {error: string} {
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
  return {column: binding};
}
