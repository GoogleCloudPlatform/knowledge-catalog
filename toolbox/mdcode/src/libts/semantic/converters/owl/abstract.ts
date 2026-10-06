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

import {Entity} from '../../ir';

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
      if (c.abstract) e.abstract = true;
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
