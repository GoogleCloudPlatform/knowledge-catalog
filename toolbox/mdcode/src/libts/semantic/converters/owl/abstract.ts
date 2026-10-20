// Abstract classes by structure, with an explicit override.
//
// An OWL class that declares no key and groups subclasses is a category, not
// a table: `core:Party` over `com:ClientAccount` and `com:Person`. Its
// instances are exactly its subclasses' instances, so in a graph it is the
// shared LABEL on their node tables rather than a node table of its own --
// the semantic model's `abstract: true` (see ir.Entity.abstract). The rule:
//
//   no owl:hasKey (own or inherited) + at least one subclass -> abstract
//   no owl:hasKey (own or inherited) + no subclass           -> kept concrete,
//                                                              listed in the
//                                                              coverage report
//   kcmd:abstract true | false                               -> wins
//
// A keyless LEAF class stays a concrete entity with an empty primary key: it
// may still be bound once a key is declared, so making it abstract would
// silently drop a node someone forgot to key. Vocabularies (keyed by their
// code) and defined entities (a filter over their parent) are never made
// abstract by structure; `kcmd:abstract true` on one is warned and ignored.
//
// The relationship counterpart: an object property whose domain or range is
// an abstract class is ABSTRACT BY STRUCTURE (see ir.Relationship.abstract).
// Its edges join rows, and an abstract class has none: they are the edges
// between the class's concrete subtypes, so the relationship is the shared
// label on those edges, with no edge table and no join columns of its own.
// A derived relationship (owl:propertyChainAxiom, `via`) cannot keep its
// chain there -- its pairs need a key on each end, and the loader rejects
// `via` on an abstract relationship -- so it is imported abstract too, with
// the chain written into its ai_context.instructions.

import {formatChain} from '../../derived_relationships';
import {Entity, Relationship} from '../../ir';

import {OwlModel} from './model';

/**
 * Marks the abstract entities (see the header), in place. Runs after
 * vocabularies and defined entities are known.
 */
export function applyOwlAbstract(
    owl: OwlModel, entitiesByName: ReadonlyMap<string, Entity>,
    warnings: string[]): void {
  const lineage = (name: string): string[] => {
    const out: string[] = [];
    const queue = [name];
    while (queue.length) {
      const next = queue.shift()!;
      if (out.includes(next)) continue;
      out.push(next);
      queue.push(...(entitiesByName.get(next)?.extends ?? []));
    }
    return out;
  };
  // Only subclasses with rows of their own count: a defined entity is a filter
  // over its parent's rows, so a keyless class whose only subclasses are
  // defined (`Opportunity` over `WonOpportunity`) is still the table.
  const hasSubclass = new Set([...entitiesByName.values()]
                                  .filter(e => !e.definition)
                                  .flatMap(e => e.extends ?? []));
  const done = new Set<string>();
  for (const c of owl.classes) {
    if (done.has(c.localName)) continue;  // the first declaration is the entity
    done.add(c.localName);
    const e = entitiesByName.get(c.localName);
    if (!e) continue;
    const ctx = `class '${c.localName}'`;
    if (e.definition || e.members) {
      if (c.abstract === true) {
        warnings.push(`${ctx} is annotated kcmd:abstract true but is ${
            e.definition ? 'a defined entity' : 'a vocabulary'}; the ` +
                      `annotation is ignored.`);
      }
      continue;
    }
    if (c.abstract !== undefined) {
      // Explicit either way, including over the uncompiled-definition
      // fallback (definitions.ts), which marks a class abstract before this.
      if (c.abstract) {
        e.abstract = true;
      } else {
        delete e.abstract;
      }
      continue;
    }
    if (isKeyed(c.localName)) continue;
    // A keyless leaf stays concrete; the coverage report lists it.
    if (hasSubclass.has(c.localName)) e.abstract = true;
  }

  function isKeyed(name: string): boolean {
    return lineage(name).some(n => entitiesByName.get(n)?.keys.length);
  }
}

/**
 * Marks each relationship with an abstract endpoint abstract, in place (see
 * the header), and returns the names it changed. Runs after applyOwlAbstract,
 * once every entity's abstractness is settled. Like an abstract class by
 * structure, this is by design, so the coverage report records it and only a
 * loss is warned: the join columns an encodedBy annotation gave the edge, or a
 * derived relationship's chain, which is kept as text.
 */
export function applyAbstractEndpoints(
    relationships: readonly Relationship[],
    entitiesByName: ReadonlyMap<string, Entity>,
    warnings: string[]): Set<string> {
  const changed = new Set<string>();
  const isAbstract = (name: string) =>
      entitiesByName.get(name)?.abstract === true;
  for (const r of relationships) {
    const ends = [...new Set([r.source.entity, r.destination.entity])].filter(
        isAbstract);
    if (!ends.length) continue;
    const named = ends.map(n => `'${n}'`).join(' and ');
    const are = ends.length > 1 ? 'are' : 'is';
    const ctx = `object property '${r.name}' connects ${named}, which ${are} ` +
        `abstract`;
    if (r.via?.length) {
      const chain = formatChain(r.via);
      const note = `Derived, not stored: ${r.name} follows the chain ${
          chain} (owl:propertyChainAxiom). ${named} ${are} abstract (no ` +
          `table), so the chain has no pairs to store; follow it between the ` +
          `concrete subtypes.`;
      r.aiContext = {
        ...(r.aiContext ?? {}),
        instructions: r.aiContext?.instructions ?
            `${r.aiContext.instructions}\n\n${note}` :
            note,
      };
      delete r.via;
      delete r.filter;
      warnings.push(
          `${ctx}, so it is imported as an abstract relationship and its ` +
          `owl:propertyChainAxiom [${chain}] is kept as text in ` +
          `ai_context.instructions (a derived relationship's pairs need a key ` +
          `on each end, which an abstract class does not have).`);
    }
    if (r.source.columns.length || r.destination.columns.length) {
      warnings.push(
          `${ctx}, so it is imported as an abstract relationship and the ` +
          `join columns its encodedBy annotation gave it are dropped (an ` +
          `abstract relationship binds no join).`);
      r.source.columns = [];
      r.destination.columns = [];
    }
    if (!r.abstract) changed.add(r.name);
    r.abstract = true;
  }
  return changed;
}
