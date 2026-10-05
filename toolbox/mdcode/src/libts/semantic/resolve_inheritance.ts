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
//     (declared order), then every field it inherits. An inherited field is
//     MERGED down the chain that declares it: the farthest declaration supplies
//     the definition (type, label, description, ai_context, ...), and each
//     nearer redeclaration, the entity's own included, supplies only its
//     binding. A subtype that rebinds a field to another column therefore keeps
//     everything its parent said about it.
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
// Errors, all thrown: a cycle in `extends`; a parent that is not an entity in
// the model; and a field inherited from two ancestors that each declare it
// with neither extending the other, since nothing says which definition wins.
// A diamond is not that case: two paths reaching ONE declaration resolve to it.

import {Entity, Field, FIELD_BINDING_KEYS, FIELD_DEFINITION_KEYS, isFieldBound, SemanticModel} from './ir';
import {stripQualifier} from './sql_expr_utils';

/**
 * Why inheritance cannot be resolved. `unknown-parent` can be a pruning
 * artefact, since a profile can drop a supertype whole; a cycle or an
 * ambiguously inherited field cannot, because pruning only removes things.
 */
export class InheritanceError extends Error {
  constructor(
      readonly kind: 'unknown-parent'|'cycle'|'ambiguous-field',
      message: string) {
    super(message);
  }
}

export interface ResolveResult {
  model: SemanticModel;
  // Nothing produces a warning today: every problem resolution can find is an
  // error, and throws. Kept so callers that print warnings need not change.
  warnings: string[];
}

/**
 * What a `concept` name may refer to, and the fields it declares.
 *
 * One lookup serves every construct that names a concept -- an action's
 * `affects`, and a derived action parameter's `concept`/`field` pair -- so the
 * two can never disagree about what `Order` is or which fields it has.
 *
 * Entities are indexed FIRST, so a name that is both an entity and a
 * relationship resolves to the entity. `kind` exists to say `entity 'X'` or
 * `relationship 'X'` in a message, and to pick which fields count.
 *
 * Only a many-to-many relationship has fields of its own: they live on the
 * junction table backing it (see Association), and an enrollment's grade is as
 * ordinary a field as an order's total. A plain foreign-key edge declares none.
 *
 * Inheritance is resolved, because a subtype's own `fields` omit everything it
 * inherits. Resolution THROWS on an `extends` naming an entity the model does
 * not declare, on a cycle, and on a field inherited ambiguously; a caller that
 * cannot report that -- the loader, which is lenient by design -- catches it
 * and works from the unresolved model instead.
 */
export interface DeclaredConcept {
  kind: 'entity'|'relationship';
  // Keyed by field name, and carrying the field itself: a derived parameter
  // projects the field's type and its wording, so the definition has to be
  // here rather than looked up a second time against a list of names.
  fields: Map<string, Field>;
}

export function declaredConceptFields(model: SemanticModel):
    Map<string, DeclaredConcept> {
  const inherits = (model.entities ?? []).some(e => e.extends?.length);
  const entities =
      (inherits ? resolveInheritance(model).model : model).entities ?? [];
  const concepts = new Map<string, DeclaredConcept>();
  for (const e of entities) {
    concepts.set(e.name, {
      kind: 'entity',
      fields: new Map((e.fields ?? []).map(f => [f.name, f])),
    });
  }
  for (const r of model.relationships ?? []) {
    if (concepts.has(r.name)) continue;
    concepts.set(r.name, {
      kind: 'relationship',
      fields: new Map((r.association?.fields ?? []).map(f => [f.name, f])),
    });
  }
  return concepts;
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

  // Every entity's ancestors, nearest-first, computed once: the merge below
  // needs to know whether one declaring ancestor descends from another.
  const ancestorsOf = new Map<string, string[]>();
  for (const e of entities) {
    ancestorsOf.set(e.name, transitiveAncestors(e.name, byName, directParents));
  }

  for (const entity of entities) {
    const ancestors = ancestorsOf.get(entity.name) ?? [];

    // Which ancestors declare each inherited field name, nearest-first. An
    // ancestor that redeclares a field it inherits and sets nothing on it
    // changes nothing, so it is not a declarer. Counting it would make a
    // diamond ambiguous over a line that has no effect.
    const declarers = new Map<string, string[]>();
    for (const anc of ancestors) {
      for (const f of ownFields.get(anc) ?? []) {
        if (setsNothing(f) &&
            (ancestorsOf.get(anc) ?? [])
                .some(a => ownFields.get(a)?.some(g => g.name === f.name))) {
          continue;
        }
        const list = declarers.get(f.name) ?? [];
        if (!list.includes(anc)) list.push(anc);
        declarers.set(f.name, list);
      }
    }
    for (const [name, list] of declarers) {
      requireOneChain(entity.name, name, list, ancestorsOf);
    }

    // Own fields first, then every inherited field, each merged down its
    // declaring chain. A subtype's redeclaration of an inherited field merges
    // over that chain too, contributing only its binding.
    const seenField = new Set<string>();
    const flattened: Field[] = [];
    for (const f of ownFields.get(entity.name) ?? []) {
      if (seenField.has(f.name)) continue;  // a self-duplicate; keep the first
      seenField.add(f.name);
      const chain = declarers.get(f.name);
      flattened.push(
          chain ? mergeBinding(
                      mergeChain(f.name, chain, ownFields, ancestorsOf), f) :
                  f);
    }
    for (const [name, chain] of declarers) {
      if (seenField.has(name)) continue;
      seenField.add(name);
      flattened.push(mergeChain(name, chain, ownFields, ancestorsOf));
    }
    // A field the binding profile excludes on this entity is left off it.
    // Descendants read the snapshot of declared fields, so they still inherit
    // it (Model Spec §3.1.3: a binding is a fact about one table).
    const excluded = new Set(entity.excludedFields ?? []);
    entity.fields = excluded.size ?
        flattened.filter(f => !excluded.has(f.name)) :
        flattened;

    // Expand `extends` to the resolved ancestor list. Drop the key when the
    // entity has no parents, so a consumer reads `extends` as the exact label
    // set.
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
  if (clone.dialects) {
    clone.dialects = clone.dialects.map(
        d => ({...d, expression: stripQualifier(d.expression, ancestor)}));
  }
  return clone;
}

// `over` laid onto `base`: every property `over` sets wins, and every one it
// leaves unset comes from `base`. When `over` carries SQL, `base`'s binding is
// dropped whole, so an expression and a dialect list from two different
// declarations never end up on one field. When it carries none, its binding
// properties (a lone `stringForm` or `importedDialect`) are ignored and
// `base`'s binding stands.
function mergeBinding(base: Field, over: Field): Field {
  const merged: Field = structuredClone(base);
  const bound = isFieldBound(over);
  if (bound) {
    for (const k of FIELD_BINDING_KEYS) delete merged[k];
  }
  const binding = new Set<string>(FIELD_BINDING_KEYS);
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined || (!bound && binding.has(k))) continue;
    (merged as any)[k] = structuredClone(v);
  }
  return merged;
}

// The field `name` as inherited down `chain`, the ancestors that declare it.
// The chain is folded in order of descent, root first: the root's declaration
// is the definition, and each descendant's lays its binding over it.
// Breadth-first
// distance is not that order when two paths to the entity differ in length, so
// the chain is sorted by how many ancestors each member has; requireOneChain
// has already checked that every member descends from the next. Every
// expression is localized to the declaring ancestor's frame first.
function mergeChain(
    name: string, chain: string[], ownFields: Map<string, Field[]>,
    ancestorsOf: Map<string, string[]>): Field {
  const depth = (n: string) => (ancestorsOf.get(n) ?? []).length;
  let merged: Field|undefined;
  for (const anc of [...chain].sort((a, b) => depth(a) - depth(b))) {
    const own = (ownFields.get(anc) ?? []).find(f => f.name === name)!;
    const local = localizeInheritedField(own, anc);
    merged = merged ? mergeBinding(merged, local) : local;
  }
  return merged!;
}

// Whether a field declaration carries neither a binding nor any part of a
// definition. Redeclaring an inherited field this way is a no-op.
function setsNothing(field: Field): boolean {
  return !isFieldBound(field) &&
      FIELD_DEFINITION_KEYS.every(k => field[k] === undefined);
}

// Throws unless every ancestor in `declaring` lies on one line of descent, so
// that one declaration plainly overrides another. Two ancestors that each
// declare the field, with neither extending the other, leave its definition
// ambiguous.
function requireOneChain(
    entity: string, field: string, declaring: string[],
    ancestorsOf: Map<string, string[]>): void {
  for (let i = 0; i < declaring.length; i++) {
    for (let j = i + 1; j < declaring.length; j++) {
      const a = declaring[i], b = declaring[j];
      const related = (ancestorsOf.get(a) ?? []).includes(b) ||
          (ancestorsOf.get(b) ?? []).includes(a);
      if (!related) {
        throw new InheritanceError(
            'ambiguous-field',
            `entity '${entity}' inherits field '${field}' from '${a}' and ` +
                `from '${b}', and neither extends the other, so nothing says ` +
                `which wins; declare or rebind '${field}' on only one of them`);
      }
    }
  }
}

// Computes the de-duplicated transitive ancestor set for `start`, ORDERED
// NEAREST-FIRST (breadth-first by distance): direct parents in declared order,
// then grandparents, and so on. Nearest-first is what makes field flattening's
// "nearest definition wins" correct -- a field defined by both a direct parent
// and a grandparent must resolve to the direct parent's. Direct parents are
// read from the pre-mutation snapshot so resolution is order-independent.
//
// A parent edge that points back to `start` is a cycle, and a parent that is
// not an entity in the model is a typo; both are hard errors. A cycle that does
// not pass through `start` is caught when an entity on it is resolved, and
// every entity is. A node re-reached through a second path (a diamond) is
// simply skipped -- it is already included at its nearest distance.
function transitiveAncestors(
    start: string, byName: Map<string, Entity>,
    directParents: Map<string, string[]>): string[] {
  const result: string[] = [];
  const seen = new Set<string>([start]);

  // Queue of (child that declared the edge, parent) so a cycle error can name
  // the offending child. Seeded with `start`'s direct parents in declared
  // order.
  const queue: Array<{from: string; name: string}> =
      (directParents.get(start) ?? []).map(name => ({from: start, name}));

  while (queue.length) {
    const {from, name} = queue.shift()!;
    if (name === start) {
      throw new InheritanceError(
          'cycle',
          `entity '${from}' extends '${name}', which is already a supertype ` +
              `on this chain; 'extends' must not form a cycle`);
    }
    if (!byName.has(name)) {
      throw new InheritanceError(
          'unknown-parent',
          `entity '${from}' extends unknown entity '${name}'; it is not ` +
              `defined in the model`);
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
