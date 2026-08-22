// Resolves entity-level inheritance (`extends`) into self-contained entities.
//
// The IR records inheritance AS DECLARED: an entity's `extends` names its
// direct supertypes, and its `fields` are only the ones it declares itself (see
// ir.Entity.extends). That is faithful but not directly consumable -- an
// emitter that wants to publish a subclass as a first-class node needs the
// supertype's fields present on the child, and the full ancestor set (not just
// the direct parents) to label it. This pass performs that resolution,
// mirroring the shape of ./transpile: it `structuredClone`s the model and NEVER
// mutates its input, returning a resolved clone plus warnings.
//
// What it does, per entity:
//   - Fields FLOW DOWN (flattening). The entity's own fields come first
//   (declared
//     order), then each ancestor's own fields whose name is not already
//     present, walking ancestors nearest-first. So the NEAREST definition of a
//     name wins (child overrides parent overrides grandparent), and every
//     transitive ancestor's own fields are included.
//   - `extends` is expanded from the direct parents to the full, de-duplicated
//     TRANSITIVE ancestor set, ordered nearest-first (a diamond lists each
//     ancestor once). An emitter reads labels straight off this list.
//
// What it deliberately does NOT do:
//   - Keys are NOT inherited: each entity keeps its own KEY (a node table is
//     identified by its own grain, not its supertype's).
//   - Relationships (edges) are NOT inherited: a subclass does not gain its
//     supertype's edges. Only node properties flow down.
//   - It does not classify abstract vs concrete or drop anything -- that is the
//     consuming leg's concern (see bigquery.ts). This pass is leg-agnostic.
//
// Robustness: a cycle in `extends` is broken (warned, no infinite loop); a
// parent that is not an entity in the model is warned and excluded from the
// resolved ancestor list (so the emitter never references a label with no
// signature).

import {Entity, Field, SemanticModel} from './ir';
import {stripQualifier} from './sql_expr_utils';

export interface ResolveResult {
  model: SemanticModel;
  warnings: string[];
}

/**
 * Returns a clone of `model` with every entity's `extends` expanded to its full
 * transitive ancestor set and its `fields` flattened to include inherited
 * fields. The input is never mutated. An entity with no `extends` is returned
 * byte-for-byte unchanged (same fields, no `extends`), so a model with no
 * inheritance resolves to an equivalent model.
 */
export function resolveInheritance(model: SemanticModel): ResolveResult {
  const clone: SemanticModel = structuredClone(model);
  const warnings: string[] = [];
  const entities = clone.entities ?? [];
  const byName = new Map(entities.map(e => [e.name, e]));

  // Snapshot the AS-DECLARED direct parents and own fields BEFORE mutating any
  // entity, so resolution reads a stable view regardless of iteration order
  // (each entity is flattened from originals, not from an already-flattened
  // ancestor).
  const directParents = new Map<string, string[]>();
  const ownFields = new Map<string, Field[]>();
  for (const e of entities) {
    directParents.set(e.name, [...(e.extends ?? [])]);
    ownFields.set(e.name, [...e.fields]);
  }

  for (const entity of entities) {
    const ancestors =
        transitiveAncestors(entity.name, byName, directParents, warnings);

    // Flatten: own fields first, then each ancestor's own fields by name unless
    // already present (nearest definition wins).
    const seenField = new Set<string>();
    const flattened: Field[] = [];
    for (const f of ownFields.get(entity.name) ?? []) {
      if (seenField.has(f.name)) continue;  // a self-duplicate; keep the first
      seenField.add(f.name);
      flattened.push(f);
    }
    for (const anc of ancestors) {
      for (const f of ownFields.get(anc) ?? []) {
        if (seenField.has(f.name)) continue;
        seenField.add(f.name);
        flattened.push(localizeInheritedField(f, anc));
      }
    }
    entity.fields = flattened;

    // Expand `extends` to the resolved ancestor list (existing entities only).
    // Drop the key when it resolves to nothing (no parents, or every parent
    // unknown/cyclic), so a consumer reads `extends` as the exact label set.
    if (ancestors.length) {
      entity.extends = ancestors;
    } else {
      delete entity.extends;
    }
  }

  return {model: clone, warnings: [...new Set(warnings)]};
}

// Clones an ancestor's field for a descendant, rewriting its expression to be
// TABLE-LOCAL. A field expression written on the ancestor as `<Ancestor>.col`
// means "the `col` column of the ancestor's own table"; inherited onto a
// descendant -- whose backing table carries the same column, since inherited
// fields must physically exist on the child -- it must reference the
// DESCENDANT's column, so the ancestor's own-name qualifier is stripped.
// Without this the descendant would render `<Ancestor>.col AS col` while the
// ancestor renders `col`, and an emitter that reuses one label across both
// tables (e.g. BigQuery's shared labels) would see two different definitions of
// the same property and reject the graph.
//
// This composes with (does not duplicate) the emitter's own qualifier
// stripping: this pass normalizes an inherited expression INTO the child's
// frame once here, and the emitter's table-local renderer then strips the
// child's own qualifier uniformly for every field (see
// bigquery.renderFieldPropertyCore). Both route through the same `stripQualifier`
// primitive; they differ only in which qualifier they remove.
function localizeInheritedField(field: Field, ancestor: string): Field {
  const clone = structuredClone(field);
  if (clone.expression !== undefined) {
    clone.expression = stripQualifier(clone.expression, ancestor);
  }
  if (clone.importedExpression !== undefined) {
    clone.importedExpression =
        stripQualifier(clone.importedExpression, ancestor);
  }
  return clone;
}

// Computes the de-duplicated transitive ancestor set for `start`, ORDERED
// NEAREST-FIRST (breadth-first by distance): direct parents in declared order,
// then grandparents, and so on. Nearest-first is what makes field flattening's
// "nearest definition wins" correct -- a field defined by both a direct parent
// and a grandparent must resolve to the direct parent's. Direct parents are
// read from the pre-mutation snapshot so resolution is order-independent.
//
// A parent edge that points back to `start` is a cycle (warned, skipped so the
// walk terminates); a parent that is not an entity in the model is warned and
// excluded (an emitter cannot label with a signature it does not have). A node
// re-reached through a second path (a diamond) is simply skipped -- it is
// already included at its nearest distance.
function transitiveAncestors(
    start: string, byName: Map<string, Entity>,
    directParents: Map<string, string[]>, warnings: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>([start]);
  const missingWarned = new Set<string>();

  // Queue of (child that declared the edge, parent) so a cycle warning can name
  // the offending child. Seeded with `start`'s direct parents in declared
  // order.
  const queue: Array<{from: string; name: string}> =
      (directParents.get(start) ?? []).map(name => ({from: start, name}));

  while (queue.length) {
    const {from, name} = queue.shift()!;
    if (name === start) {
      warnings.push(
          `entity '${from}' extends '${name}', which is already a supertype ` +
          `on this chain (cycle); breaking the cycle`);
      continue;
    }
    if (!byName.has(name)) {
      if (!missingWarned.has(name)) {
        missingWarned.add(name);
        warnings.push(
            `entity '${from}' extends unknown entity '${name}'; it is not ` +
            `defined in the model, so it is ignored`);
      }
      continue;
    }
    if (seen.has(name)) continue;  // diamond: already included at its nearest
    seen.add(name);
    result.push(name);
    for (const gp of directParents.get(name) ?? []) {
      queue.push({from: name, name: gp});
    }
  }

  return result;
}
