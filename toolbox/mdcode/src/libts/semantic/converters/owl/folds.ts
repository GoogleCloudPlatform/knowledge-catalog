// Folding unkeyed equivalent classes into their keyed counterpart.
//
// Two modules of one ontology often name the same concept twice -- finance's
// `fin:Counterparty owl:equivalentClass com:ClientAccount` -- and only one of
// them declares how instances are identified. The keyed class is the one a
// table backs; the unkeyed one is another name for it. Importing both would
// leave a keyless entity that no table can back, and split the relationships
// between the two. So, before mapping:
//
//   C owl:equivalentClass D, C has no key (own or inherited), D has one
//     -> C is folded into D:
//        - C is not imported as an entity;
//        - every reference to C (rdfs:domain / rdfs:range of properties, so
//          relationships and fields; rdfs:subClassOf of other classes, so
//          `extends`; restriction fillers, class expressions, disjointness,
//          individuals' types) is rewritten to D;
//        - C's local name, labels and synonyms become synonyms of D, and C's
//          examples D's examples; its rdfs:subClassOf restrictions become D's;
//        - a warning names the fold.
//
// Two keyed equivalent classes are two tables of the same concept and stay
// separate (the equivalence is an ai_context synonym, see annotations.ts), as
// do two unkeyed ones. An unkeyed class that is a vocabulary or carries its
// own class definition is never folded. The fold is a rewrite of the parsed
// OwlModel, so every later mapping step sees one class and needs no special
// case.

import {OwlClass, OwlClassExpr, OwlDataRange, OwlModel} from './model';
import {localName} from './parse';

/** One fold: `folded` (unkeyed) was merged into `into` (keyed). */
export interface EquivalentFold {
  folded: string;
  into: string;
}

/**
 * Folds every unkeyed class declared owl:equivalentClass to a keyed class
 * into it (see the header). Returns the rewritten model and the folds made;
 * the input is not modified.
 */
export function foldEquivalentClasses(owl: OwlModel, warnings: string[]):
    {owl: OwlModel; folds: EquivalentFold[]} {
  const byName = new Map<string, OwlClass>();
  for (const c of owl.classes) {
    if (!byName.has(c.localName)) byName.set(c.localName, c);
  }
  const byIri = new Map<string, OwlClass>();
  for (const c of byName.values()) if (c.iri) byIri.set(c.iri, c);

  // A key of its own: owl:hasKey, or the single inverse-functional property
  // the mapper promotes to a primary key.
  const ownKeyed = (c: OwlClass): boolean => c.keys.length > 0 ||
      owl.datatypeProperties
              .filter(p => p.inverseFunctional && p.domains.includes(c.localName))
              .length === 1;
  const keyed = (c: OwlClass): boolean => {
    const seen = new Set<string>();
    const queue = [c.localName];
    while (queue.length) {
      const n = queue.shift()!;
      if (seen.has(n)) continue;
      seen.add(n);
      const k = byName.get(n);
      if (!k) continue;
      if (ownKeyed(k)) return true;
      queue.push(...k.subClassOf);
    }
    return false;
  };
  const foldable = (c: OwlClass): boolean => !c.oneOf.length &&
      !c.definitions?.length && c.vocabulary !== true;

  // Decide the folds: drop name -> keep name.
  const into = new Map<string, string>();
  for (const a of byName.values()) {
    for (const iri of a.equivalentClass) {
      const b = byIri.get(iri) ?? byName.get(localName(iri));
      if (!b || b === a) continue;
      const aKeyed = keyed(a);
      const bKeyed = keyed(b);
      if (aKeyed === bKeyed) continue;
      const [keep, drop] = aKeyed ? [a, b] : [b, a];
      if (!foldable(drop) || into.has(drop.localName)) continue;
      // Never fold into a class that is itself folded away.
      if (into.has(keep.localName)) continue;
      into.set(drop.localName, keep.localName);
    }
  }
  if (!into.size) return {owl, folds: []};

  const iriInto = new Map<string, string>();
  for (const [drop, keep] of into) {
    const d = byName.get(drop)!;
    const k = byName.get(keep)!;
    if (d.iri && k.iri) iriInto.set(d.iri, k.iri);
  }
  const name = (n: string) => into.get(n) ?? n;
  const iri = (i: string) => iriInto.get(i) ?? i;
  const dedupe = (xs: string[]) => [...new Set(xs)];
  const renameExpr = (e: OwlClassExpr): OwlClassExpr => {
    switch (e.kind) {
      case 'named':
        return {kind: 'named', iri: iri(e.iri)};
      case 'and':
      case 'or':
        return {kind: e.kind, operands: e.operands.map(renameExpr)};
      case 'not':
        return {kind: 'not', operand: renameExpr(e.operand)};
      case 'restriction':
        return e.filler && isClassExpr(e.filler) ?
            {...e, filler: renameExpr(e.filler)} :
            e;
      default:
        return e;
    }
  };

  const folds: EquivalentFold[] = [];
  const classes: OwlClass[] = [];
  const firsts = new Set(byName.values());
  for (const c of owl.classes) {
    if (into.has(c.localName)) continue;
    const isSelf = (i: string) => i === c.iri || localName(i) === c.localName;
    const next: OwlClass = {
      ...c,
      subClassOf: dedupe(c.subClassOf.map(name)).filter(n => n !== c.localName),
      equivalentClass: dedupe(c.equivalentClass.map(iri)).filter(i => !isSelf(i)),
      disjointWith: dedupe(c.disjointWith.map(iri)),
      restrictions: c.restrictions.map(
          r => r.filler ? {...r, filler: iri(r.filler)} : r),
    };
    if (c.definitions) next.definitions = c.definitions.map(renameExpr);
    if (firsts.has(c)) {
      for (const [drop, keep] of into) {
        if (keep !== c.localName) continue;
        const d = byName.get(drop)!;
        next.synonyms = dedupe([
          ...next.synonyms, d.localName, ...(d.label ? [d.label] : []),
          ...d.synonyms,
        ]);
        next.examples = dedupe([...next.examples, ...d.examples]);
        next.restrictions = [
          ...next.restrictions,
          ...d.restrictions.filter(r => r.via === 'subClassOf')
              .map(r => r.filler ? {...r, filler: iri(r.filler)} : r),
        ];
        folds.push({folded: drop, into: keep});
        warnings.push(
            `class '${drop}' is owl:equivalentClass '${keep}' and has no key ` +
            `of its own, so it is folded into '${keep}': its relationships ` +
            `and fields move there and its name and labels become synonyms ` +
            `of '${keep}'.`);
      }
    }
    classes.push(next);
  }

  return {
    owl: {
      ...owl,
      classes,
      datatypeProperties: owl.datatypeProperties.map(
          p => ({...p, domains: dedupe(p.domains.map(name))})),
      objectProperties: owl.objectProperties.map(
          p => ({...p, domains: p.domains.map(name), ranges: p.ranges.map(name)})),
      allDisjointClasses: owl.allDisjointClasses.map(m => dedupe(m.map(iri))),
      allDisjointClassesAxioms: owl.allDisjointClassesAxioms.map(
          ax => ({...ax, members: dedupe(ax.members.map(iri))})),
      ...(owl.individuals ? {
        individuals: owl.individuals.map(
            i => ({...i, types: dedupe(i.types.map(iri))})),
      } :
                            {}),
    },
    folds,
  };
}

function isClassExpr(x: OwlClassExpr|OwlDataRange): x is OwlClassExpr {
  return x.kind !== 'datatype' && x.kind !== 'facets' && x.kind !== 'dataOneOf';
}
