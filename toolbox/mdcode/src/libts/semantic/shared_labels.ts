// The properties an ABSTRACT supertype's label can carry in a property graph.
//
// BigQuery and Spanner both require that "labels with the same name expose the
// same set of properties": every element table that binds a label must declare
// the same property names under it (BigQuery rejects the graph otherwise --
// "The label 'Organization' is defined with different properties", seen live).
//
// A CONCRETE supertype's label is rendered from its own table, so each subtype
// repeats that one signature. An ABSTRACT supertype has no table: every
// concrete descendant renders the label from its own binding of the inherited
// fields. When descendants bind different subsets of those fields -- a node
// derived from a relationship carries only its key, a profile leaves an
// inherited field unbound on one subtype -- the per-table signatures differ.
//
// So a shared abstract label carries only the inherited fields that EVERY
// descendant table binds. A field bound on some descendants but not others is
// still a property of those descendants (under their DEFAULT LABEL); it is just
// not part of the shared label. Each such omission is warned, naming the
// descendants that leave the field unbound. Both graph legs (bigquery.ts,
// spanner.ts) read this one computation, so they never disagree.

import {Entity, fieldBinding} from './ir';

/**
 * For each abstract label carried by at least one of `nodes`, the names of the
 * label's fields that every carrying node binds. `nodes` are the entities that
 * form node tables, with inheritance resolved (`extends` is the full ancestor
 * set and inherited fields are flattened onto each node). `labelByName` maps
 * every label carrier by name; only its abstract entries are considered.
 */
export function sharedAbstractLabelFields(
    nodes: Entity[], labelByName: Map<string, Entity>,
    warnings: string[]): Map<string, Set<string>> {
  const carriers = new Map<string, Entity[]>();
  for (const node of nodes) {
    for (const name of node.extends ?? []) {
      if (!labelByName.get(name)?.abstract) continue;
      const tables = carriers.get(name) ?? [];
      tables.push(node);
      carriers.set(name, tables);
    }
  }

  const shared = new Map<string, Set<string>>();
  for (const [name, tables] of carriers) {
    const fields = new Set<string>();
    for (const field of labelByName.get(name)!.fields) {
      const unbound = tables.filter(
          t => !t.fields.some(
              f => f.name === field.name && fieldBinding(f) !== undefined));
      if (!unbound.length) {
        fields.add(field.name);
        continue;
      }
      // Unbound everywhere: no table exposes it, so there is nothing to omit.
      if (unbound.length === tables.length) continue;
      warnings.push(
          `label '${name}': inherited field '${field.name}' is unbound on ${
              unbound.map(t => `'${t.name}'`).join(', ')}; every table that ` +
          `carries a label must expose the same properties under it, so ` +
          `'${field.name}' is left out of the shared '${name}' label and ` +
          `stays a property of the subtypes that bind it`);
    }
    shared.set(name, fields);
  }
  return shared;
}
