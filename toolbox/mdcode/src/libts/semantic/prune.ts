// Pruning a model down to what is physically bound (proposed: `kcmd owl import
// --prune-unbound`).
//
// A large ontology declares far more classes than any one deployment binds to
// tables: upper-ontology concepts, classes another team owns, vocabulary the
// model only refers to. Importing all of them yields a model whose entities
// mostly have no table, which bloats Knowledge Catalog, skills and every
// review. Pruning keeps exactly what a deployment can use:
//
//   * the BOUND entities -- those a binding profile (or inline bindings) gives
//     a `source`;
//   * their ANCESTORS (transitive `extends`) -- they survive as labels on the
//     bound subtypes, and their fields flatten down;
//   * the DEFINED entities over them -- an entity with a `definition` whose
//     base (the nearest non-defined ancestor) is kept: it is a membership
//     filter over a kept table, not a table of its own.
//
// Everything else is removed, together with what refers to it: relationships
// with a removed endpoint, abstract relationships left with no sub-relationship,
// `extends` references to a removed relationship, constraints whose rule names
// a removed entity or relationship, and glossary `defines` links to a removed
// entity (the term itself stays: it is vocabulary). Pure: the input model is not
// modified.

import * as YAML from 'yaml';

import {Constraint, Entity, GlossaryTerm, Relationship, SemanticModel} from './ir';
import {isProfileFileForm} from './resolve_profiles';

/** What pruneUnbound kept and removed. */
export interface PruneResult {
  model: SemanticModel;
  kept: {bound: string[]; ancestors: string[]; defined: string[]};
  pruned: {
    entities: string[];
    relationships: string[];
    constraints: string[];
    // Glossary `defines` links removed because they named a pruned entity.
    glossaryLinks: string[];
  };
  // Bound names that are not entities of the model (a typo, a class folded
  // away, a profile for another model).
  warnings: string[];
}

/**
 * Prunes `model` to the entities in `bound`, their ancestors and the defined
 * entities over them (see the file comment). `bound` names entities; names not
 * in the model are reported in `warnings` and otherwise ignored.
 */
export function pruneUnbound(
    model: SemanticModel, bound: Iterable<string>): PruneResult {
  const warnings: string[] = [];
  const byName = new Map(model.entities.map(e => [e.name, e]));

  const boundSet = new Set<string>();
  for (const name of bound) {
    if (byName.has(name)) {
      boundSet.add(name);
    } else {
      warnings.push(
          `the binding binds '${name}', which is not an entity of model '${
              model.name}'; ignored.`);
    }
  }

  // Bound entities and their ancestors, breadth-first.
  const keep = new Set<string>(boundSet);
  const ancestors: string[] = [];
  const queue = [...boundSet];
  while (queue.length) {
    const next = byName.get(queue.shift()!);
    for (const parent of next?.extends ?? []) {
      if (keep.has(parent) || !byName.has(parent)) continue;
      keep.add(parent);
      ancestors.push(parent);
      queue.push(parent);
    }
  }

  // Defined entities whose base is kept. A defined entity's chain of defined
  // parents shares its base, so those are kept by the same test.
  const defined: string[] = [];
  for (const e of model.entities) {
    if (!e.definition || keep.has(e.name)) continue;
    const base = definedBase(e, byName);
    if (base !== undefined && keep.has(base)) defined.push(e.name);
  }
  for (const d of defined) keep.add(d);

  const entities = model.entities.filter(e => keep.has(e.name));
  const prunedEntities =
      model.entities.filter(e => !keep.has(e.name)).map(e => e.name);

  // Relationships: both ends kept. Then abstract ones whose sub-relationships
  // were all pruned go too (they only labelled those), until nothing changes
  // (an abstract parent of an abstract parent).
  const hadChildren =
      new Set(model.relationships.flatMap(r => r.extends ?? []));
  let relationships =
      model.relationships.filter(
          r => keep.has(r.source.entity) && keep.has(r.destination.entity));
  for (let changed = true; changed;) {
    changed = false;
    const parents = new Set(relationships.flatMap(r => r.extends ?? []));
    const next = relationships.filter(
        r => !r.abstract || !hadChildren.has(r.name) || parents.has(r.name));
    if (next.length !== relationships.length) {
      relationships = next;
      changed = true;
    }
  }
  const keptRels = new Set(relationships.map(r => r.name));
  relationships = relationships.map(r => withoutDanglingExtends(r, keptRels));
  const prunedRelationships = model.relationships.filter(r => !keptRels.has(r.name));

  // Constraints that name a pruned entity or relationship (or a pruned
  // relationship's inverse) in their rule or description.
  const goneNames = [
    ...prunedEntities,
    ...prunedRelationships.flatMap(r => r.inverse ? [r.name, r.inverse] : [r.name]),
  ];
  const mentionsGone = mentionsAny(goneNames);
  const constraints: Constraint[] = [];
  const prunedConstraints: string[] = [];
  for (const c of model.constraints ?? []) {
    if (mentionsGone(`${c.judgment ?? ''}\n${c.description ?? ''}`)) {
      prunedConstraints.push(c.name);
    } else {
      constraints.push(c);
    }
  }

  const out: SemanticModel = {
    ...model,
    entities: entities.map(e => withoutDanglingEntityExtends(e, keep)),
    relationships,
  };
  if (model.constraints !== undefined) {
    if (constraints.length) {
      out.constraints = constraints;
    } else {
      delete out.constraints;
    }
  }

  const glossaryLinks: string[] = [];
  if (model.glossary) {
    const gone = new Set(prunedEntities);
    out.glossary = {
      ...model.glossary,
      terms: model.glossary.terms.map(t => {
        if (!t.defines?.length) return t;
        const defines = t.defines.filter(d => {
          const entity = d.kind === 'metric' ? undefined : d.ref.split('.')[0];
          const drop = entity !== undefined && gone.has(entity);
          if (drop) glossaryLinks.push(`${t.id} -> ${d.ref}`);
          return !drop;
        });
        if (defines.length === t.defines.length) return t;
        const term: GlossaryTerm = {...t, defines};
        if (!defines.length) delete term.defines;
        return term;
      }),
    };
  }

  return {
    model: out,
    kept: {bound: [...boundSet], ancestors, defined},
    pruned: {
      entities: prunedEntities,
      relationships: prunedRelationships.map(r => r.name),
      constraints: prunedConstraints,
      glossaryLinks,
    },
    warnings,
  };
}

// The nearest non-defined entity up a defined entity's parent chain, or
// undefined when the chain breaks (unknown parent, cycle).
function definedBase(e: Entity, byName: Map<string, Entity>): string|undefined {
  const seen = new Set<string>([e.name]);
  let current: Entity|undefined = e;
  while (current?.definition) {
    const parent: string|undefined = current.extends?.[0];
    if (parent === undefined || seen.has(parent)) return undefined;
    seen.add(parent);
    current = byName.get(parent);
  }
  return current?.name;
}

function withoutDanglingExtends(
    r: Relationship, kept: Set<string>): Relationship {
  if (!r.extends?.some(p => !kept.has(p))) return r;
  const parents = r.extends.filter(p => kept.has(p));
  const copy: Relationship = {...r, extends: parents};
  if (!parents.length) delete copy.extends;
  return copy;
}

function withoutDanglingEntityExtends(e: Entity, kept: Set<string>): Entity {
  if (!e.extends?.some(p => !kept.has(p))) return e;
  const parents = e.extends.filter(p => kept.has(p));
  const copy: Entity = {...e, extends: parents};
  if (!parents.length) delete copy.extends;
  return copy;
}

// A test for whether a text names any of `names` as a whole identifier (so
// `Order` matches "each Order" and "Order.total" but not "hasOrder" or
// "OrderLine").
function mentionsAny(names: string[]): (text: string) => boolean {
  if (!names.length) return () => false;
  const escaped = [...new Set(names)]
                      .sort((a, b) => b.length - a.length)
                      .map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const re = new RegExp(
      `(?<![A-Za-z0-9_])(?:${escaped.join('|')})(?![A-Za-z0-9_])`);
  return text => re.test(text);
}

/**
 * What the CLI prints after pruning: one line of counts, then one indented
 * line per non-empty list of removed names.
 */
export function formatPruneSummary(
    result: Pick<PruneResult, 'kept'|'pruned'>): string {
  const {kept, pruned} = result;
  const keptCount =
      kept.bound.length + kept.ancestors.length + kept.defined.length;
  const lines = [
    `pruned to the bound entities: kept ${
        count(keptCount, 'entity', 'entities')} (${kept.bound.length} bound, ${
        count(kept.ancestors.length, 'ancestor', 'ancestors')}, ${
        kept.defined.length} defined); removed ${
        count(pruned.entities.length, 'entity', 'entities')}, ${
        count(pruned.relationships.length, 'relationship', 'relationships')}, ${
        count(pruned.constraints.length, 'constraint', 'constraints')}`,
  ];
  const lists: [string, string[]][] = [
    ['entities', pruned.entities],
    ['relationships', pruned.relationships],
    ['constraints', pruned.constraints],
    ['glossary links', pruned.glossaryLinks],
  ];
  for (const [label, names] of lists) {
    if (names.length) lines.push(`  removed ${label}: ${names.join(', ')}`);
  }
  return lines.join('\n');
}

// `n` with the singular or plural noun.
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The entity names a binding document binds: every entity (`entities` or
 * `datasets`) with a non-empty `source`. The document is a binding profile --
 * a profile file (`<model>.profile.<name>.yaml`, one top-level profile object
 * that binds the model it sits beside) or a legacy `semantic_model:` wrapper --
 * or any model document with inline bindings. When `model` is given and a
 * `semantic_model:` document declares a model of that name, only that model is
 * read; otherwise every model in the document is.
 */
export function boundEntityNames(text: string, model?: string): string[] {
  const doc = YAML.parse(text) as unknown;
  if (isProfileFileForm(text)) return sourcedEntities([doc]);
  const models = (doc as {semantic_model?: unknown})?.semantic_model;
  if (!Array.isArray(models)) {
    throw new Error(
        'the binding document is neither a profile file nor a document with ' +
        'a semantic_model list.');
  }
  const named = models.filter(
      m => model !== undefined && (m as {name?: unknown})?.name === model);
  return sourcedEntities(named.length ? named : models);
}

// The names of the entities with a non-empty `source` across `models` (each a
// model or a profile object), in order and without repeats.
function sourcedEntities(models: unknown[]): string[] {
  const out: string[] = [];
  for (const m of models) {
    const items = (m as {entities?: unknown; datasets?: unknown})?.entities ??
        (m as {datasets?: unknown})?.datasets;
    if (!Array.isArray(items)) continue;
    for (const e of items) {
      const name = (e as {name?: unknown})?.name;
      const source = (e as {source?: unknown})?.source;
      if (typeof name === 'string' && typeof source === 'string' &&
          source.trim() !== '' && !out.includes(name)) {
        out.push(name);
      }
    }
  }
  return out;
}
