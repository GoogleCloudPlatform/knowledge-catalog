// SHACL shapes (Turtle) -> a small, closed shape model.
//
// Mechanical, like the OWL parser (converters/owl/parse.ts): it reads the
// SHACL Core terms the importer maps onto semantic-model constraints and
// records, per shape, everything else it saw so the mapper can WARN about it
// rather than silently ignore it. It decides nothing about the model; the
// mapping (constraints.ts) resolves each shape against the semantic model.
//
// What is read:
//   node shapes      -- subjects typed sh:NodeShape, or carrying sh:targetClass
//                       / sh:property without an sh:path (SHACL shapes may be
//                       untyped). Targets: sh:targetClass, plus the implicit
//                       class target of a shape that is itself an owl:Class /
//                       rdfs:Class. Other target kinds are recorded as
//                       unsupported.
//   property shapes  -- each sh:property of a node shape, plus a standalone
//                       shape with an sh:path and its own targets. Only a
//                       simple IRI sh:path is resolvable; any other path
//                       (inverse, sequence, alternative, ...) is recorded as a
//                       problem.
//   constraint terms -- sh:minCount / maxCount, sh:datatype, sh:pattern (+
//                       sh:flags), sh:in, sh:min/maxInclusive, sh:min/
//                       maxExclusive, sh:min/maxLength, sh:class, sh:node,
//                       sh:qualifiedValueShape + sh:qualifiedMin/MaxCount,
//                       and the property-pair terms sh:equals, sh:disjoint,
//                       sh:lessThan, sh:lessThanOrEquals (each value is one
//                       pair; a value that is not a property IRI is recorded
//                       as a problem).
//   metadata         -- sh:severity, sh:message, sh:name, sh:description,
//                       sh:deactivated.
//
// Several files are one shapes graph: they are parsed into one quad list, each
// with its own blank-node prefix so anonymous shapes from different files never
// collide. Document order is kept (first appearance wins) so the output is
// deterministic.

import {Parser, Quad, Term} from 'n3';

import {localName} from '../owl/parse';

const SH = 'http://www.w3.org/ns/shacl#';
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';

const RDF_TYPE = `${RDF}type`;
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const RDF_NIL = `${RDF}nil`;
const CLASS_TYPES = new Set([`${OWL}Class`, `${RDFS}Class`]);

// SHACL's property-pair components, in the order their rules are emitted. Each
// compares the values of the shape's sh:path with those of ANOTHER property of
// the same focus node.
export type ShaclPairTerm = 'equals'|'disjoint'|'lessThan'|'lessThanOrEquals';
const PAIR_TERMS: readonly ShaclPairTerm[] =
    ['equals', 'disjoint', 'lessThan', 'lessThanOrEquals'];

// The SHACL terms read off a property shape. Any other sh: predicate on one is
// reported as unsupported (see PROPERTY_IGNORED for the purely presentational
// ones that are dropped without a warning).
const PROPERTY_TERMS = new Set<string>([
  'path', 'minCount', 'maxCount', 'datatype', 'pattern', 'flags', 'in',
  'minInclusive', 'maxInclusive', 'minExclusive', 'maxExclusive', 'minLength',
  'maxLength', 'class', 'node', 'qualifiedValueShape', 'qualifiedMinCount',
  'qualifiedMaxCount', 'severity', 'message', 'name', 'description',
  'deactivated', ...PAIR_TERMS,
]);
// Presentational SHACL terms (form layout and defaults): no rule, no warning.
const PROPERTY_IGNORED = new Set(['order', 'group', 'defaultValue']);

// The terms read off a node shape; anything else sh: on it (sh:closed, sh:or,
// sh:not, a node-level sh:class, ...) is reported as unsupported.
const NODE_TERMS = new Set([
  'targetClass', 'property', 'severity', 'message', 'name', 'description',
  'deactivated',
]);
const NODE_IGNORED = new Set(['order', 'group']);
const OTHER_TARGETS = new Set(['targetNode', 'targetSubjectsOf', 'targetObjectsOf']);

/** A literal or IRI value as read: `iri` true for an IRI. */
export interface ShaclValue {
  value: string;
  iri: boolean;
}

/** A qualified value shape bound: `sh:qualifiedValueShape [ sh:class X ]`. */
export interface ShaclQualified {
  class?: string;  // full IRI of the qualifying class
  min?: number;
  max?: number;
  problem?: string;  // why it cannot be resolved (no sh:class, extra terms)
}

/**
 * One property-pair comparison: `sh:lessThan ex:targetPrice` on the shape of
 * `ex:floorPrice` reads as {term: 'lessThan', other: '<...#targetPrice>'}.
 */
export interface ShaclPair {
  term: ShaclPairTerm;
  other?: string;    // full IRI of the other property
  problem?: string;  // why it cannot be resolved (the value is not an IRI)
}

export interface ShaclPropertyShape {
  // Local name of a named property shape; undefined for a blank node.
  name?: string;
  path?: string;         // full IRI of a simple sh:path
  pathProblem?: string;  // why the sh:path is not a simple IRI
  minCount?: number;
  maxCount?: number;
  datatype?: string;  // full IRI
  pattern?: string;
  flags?: string;
  in?: ShaclValue[];
  minInclusive?: string;
  maxInclusive?: string;
  minExclusive?: string;
  maxExclusive?: string;
  minLength?: number;
  maxLength?: number;
  classes: string[];  // full IRIs of sh:class
  node?: string;      // sh:node (not mapped; warned)
  qualified?: ShaclQualified;
  pairs: ShaclPair[];  // property-pair comparisons, in PAIR_TERMS order
  severity?: string;  // full IRI
  message?: string;
  label?: string;        // sh:name
  description?: string;  // sh:description
  deactivated: boolean;
  unsupported: string[];  // sh: local names seen but not mapped
  // Targets of a STANDALONE property shape (one not reached through
  // sh:property); empty otherwise.
  targetClasses: string[];
}

export interface ShaclNodeShape {
  name?: string;              // local name; undefined for a blank node
  targetClasses: string[];    // full IRIs (explicit + implicit class target)
  otherTargets: string[];     // unsupported target kinds seen (local names)
  properties: ShaclPropertyShape[];
  deactivated: boolean;
  unsupported: string[];      // node-level sh: terms seen but not mapped
}

export interface ShaclShapes {
  nodeShapes: ShaclNodeShape[];
  // Property shapes with an sh:path and targets of their own, not reached
  // through any node shape's sh:property.
  standaloneProperties: ShaclPropertyShape[];
}

/** Parses one or more Turtle documents (one shapes graph) into shapes. */
export function parseShacl(turtle: string|string[]): ShaclShapes {
  const docs = Array.isArray(turtle) ? turtle : [turtle];
  const quads: Quad[] = [];
  docs.forEach((text, i) => {
    quads.push(...new Parser({blankNodePrefix: `s${i}_`}).parse(text));
  });

  // Subject -> predicate -> objects, in document order; plus subject order.
  const bySubject = new Map<string, Map<string, Term[]>>();
  const order: string[] = [];
  for (const q of quads) {
    const s = q.subject.value;
    let preds = bySubject.get(s);
    if (!preds) {
      preds = new Map();
      bySubject.set(s, preds);
      order.push(s);
    }
    const list = preds.get(q.predicate.value) ?? [];
    list.push(q.object);
    preds.set(q.predicate.value, list);
  }
  const all = (s: string, p: string): Term[] => bySubject.get(s)?.get(p) ?? [];
  const first = (s: string, p: string): Term|undefined => all(s, p)[0];
  const sh = (s: string, term: string) => first(s, `${SH}${term}`);
  const types = (s: string) => new Set(all(s, RDF_TYPE).map(t => t.value));

  const listItems = (head: Term): Term[]|undefined => {
    const out: Term[] = [];
    let node = head;
    const seen = new Set<string>();
    while (node.value !== RDF_NIL) {
      if (seen.has(node.value)) return undefined;  // cyclic list
      seen.add(node.value);
      const f = first(node.value, RDF_FIRST);
      const r = first(node.value, RDF_REST);
      if (!f || !r) return undefined;  // not a well-formed list
      out.push(f);
      node = r;
    }
    return out;
  };
  const int = (t: Term|undefined): number|undefined => {
    if (!t) return undefined;
    const n = Number(t.value);
    return Number.isInteger(n) && n >= 0 ? n : undefined;
  };
  const text = (s: string, term: string): string|undefined => {
    // Prefer an untagged or English value when a term is repeated per language.
    const values = all(s, `${SH}${term}`);
    const pick = values.find(v => v.termType === 'Literal' &&
                                 ['', 'en'].includes((v as any).language ?? '')) ??
        values[0];
    return pick?.value;
  };
  const shTermsOf = (s: string): string[] => [
    ...new Set([...(bySubject.get(s)?.keys() ?? [])]
                   .filter(p => p.startsWith(SH))
                   .map(p => p.slice(SH.length))),
  ];
  // The term each subject first appears as, to tell a blank-node shape (no
  // name of its own) from a named one.
  const subjectTerm = new Map<string, Term>();
  for (const q of quads) {
    if (!subjectTerm.has(q.subject.value)) {
      subjectTerm.set(q.subject.value, q.subject);
    }
  }
  const nameOf = (s: string, t?: Term): string|undefined =>
      (t ?? subjectTerm.get(s))?.termType === 'BlankNode' ? undefined :
                                                            localName(s);

  const readProperty = (s: string, term?: Term): ShaclPropertyShape => {
    const ps: ShaclPropertyShape = {
      name: nameOf(s, term),
      classes: all(s, `${SH}class`).map(t => t.value),
      deactivated: sh(s, 'deactivated')?.value === 'true',
      unsupported: [],
      targetClasses: all(s, `${SH}targetClass`).map(t => t.value),
      pairs: [],
    };
    // Each value of a pair term is its own comparison (SHACL allows several).
    for (const term of PAIR_TERMS) {
      for (const o of all(s, `${SH}${term}`)) {
        ps.pairs.push(
            o.termType === 'NamedNode' ?
                {term, other: o.value} :
                {term, problem: `its sh:${term} value is not a property IRI`});
      }
    }
    const path = sh(s, 'path');
    if (!path) {
      ps.pathProblem = 'it has no sh:path';
    } else if (path.termType === 'NamedNode') {
      ps.path = path.value;
    } else if (first(path.value, `${SH}inversePath`)) {
      ps.pathProblem = `its sh:path is an inverse path (^${
          localName(first(path.value, `${SH}inversePath`)!.value)})`;
    } else {
      ps.pathProblem = 'its sh:path is not a single property IRI (a ' +
          'sequence, alternative, or zero-or-more path)';
    }
    ps.minCount = int(sh(s, 'minCount'));
    ps.maxCount = int(sh(s, 'maxCount'));
    ps.datatype = sh(s, 'datatype')?.value;
    ps.pattern = sh(s, 'pattern')?.value;
    ps.flags = sh(s, 'flags')?.value;
    const inHead = sh(s, 'in');
    if (inHead) {
      const items = listItems(inHead);
      if (items) {
        ps.in = items.map(t => ({value: t.value, iri: t.termType === 'NamedNode'}));
      } else {
        ps.unsupported.push('in (not a well-formed list)');
      }
    }
    ps.minInclusive = sh(s, 'minInclusive')?.value;
    ps.maxInclusive = sh(s, 'maxInclusive')?.value;
    ps.minExclusive = sh(s, 'minExclusive')?.value;
    ps.maxExclusive = sh(s, 'maxExclusive')?.value;
    ps.minLength = int(sh(s, 'minLength'));
    ps.maxLength = int(sh(s, 'maxLength'));
    ps.node = sh(s, 'node')?.value;
    const qvs = sh(s, 'qualifiedValueShape');
    const qmin = int(sh(s, 'qualifiedMinCount'));
    const qmax = int(sh(s, 'qualifiedMaxCount'));
    if (qvs || qmin !== undefined || qmax !== undefined) {
      const q: ShaclQualified = {min: qmin, max: qmax};
      if (!qvs) {
        q.problem = 'a qualified count has no sh:qualifiedValueShape';
      } else {
        const cls = all(qvs.value, `${SH}class`);
        const extra = shTermsOf(qvs.value).filter(t => t !== 'class');
        if (cls.length !== 1) {
          q.problem = 'its sh:qualifiedValueShape does not name exactly one ' +
              'sh:class';
        } else if (extra.length) {
          q.problem = `its sh:qualifiedValueShape also uses ${
              extra.map(t => `sh:${t}`).join(', ')}, which is not supported`;
        } else {
          q.class = cls[0].value;
        }
      }
      ps.qualified = q;
    }
    ps.severity = sh(s, 'severity')?.value;
    ps.message = text(s, 'message');
    ps.label = text(s, 'name');
    ps.description = text(s, 'description');
    for (const t of shTermsOf(s)) {
      if (PROPERTY_TERMS.has(t) || PROPERTY_IGNORED.has(t) ||
          t === 'targetClass') {
        continue;
      }
      ps.unsupported.push(t);
    }
    return ps;
  };

  // Node shapes: typed sh:NodeShape, or untyped with node-shape terms and no
  // sh:path (a subject with an sh:path is a property shape).
  const reachedAsProperty = new Set<string>();
  for (const s of order) {
    for (const t of all(s, `${SH}property`)) reachedAsProperty.add(t.value);
  }

  const nodeShapes: ShaclNodeShape[] = [];
  const standaloneProperties: ShaclPropertyShape[] = [];
  for (const s of order) {
    const t = types(s);
    const hasPath = !!sh(s, 'path');
    const isNode = t.has(`${SH}NodeShape`) ||
        (!hasPath && (!!sh(s, 'targetClass') || !!sh(s, 'property')));
    if (isNode) {
      const targetClasses = all(s, `${SH}targetClass`).map(x => x.value);
      // A shape that is also a class targets its own instances (SHACL's
      // "implicit class target").
      if ([...t].some(x => CLASS_TYPES.has(x)) && !targetClasses.includes(s)) {
        targetClasses.push(s);
      }
      nodeShapes.push({
        name: nameOf(s, subjectTerm.get(s)),
        targetClasses,
        otherTargets: shTermsOf(s).filter(x => OTHER_TARGETS.has(x)),
        properties:
            all(s, `${SH}property`).map(p => readProperty(p.value, p)),
        deactivated: sh(s, 'deactivated')?.value === 'true',
        unsupported: shTermsOf(s).filter(
            x => !NODE_TERMS.has(x) && !NODE_IGNORED.has(x) &&
                !OTHER_TARGETS.has(x)),
      });
      continue;
    }
    if (hasPath && !reachedAsProperty.has(s) && sh(s, 'targetClass')) {
      standaloneProperties.push(readProperty(s, subjectTerm.get(s)));
    }
  }
  return {nodeShapes, standaloneProperties};
}
