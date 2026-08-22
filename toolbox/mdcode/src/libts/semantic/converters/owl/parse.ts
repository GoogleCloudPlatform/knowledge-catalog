// Turtle (.ttl) -> OwlModel parser.
//
// A mechanical triples-to-structs step: it reads RDF with `n3`, recognizes the
// handful of OWL/RDFS terms the first cut supports, and fills the staging
// OwlModel (model.ts). All OWL -> OSI mapping policy lives in to_ir.ts, not
// here; this file only decides "which triples matter and where do their values
// go".
//
// Declaration order is preserved: classes and properties appear in the order
// their `rdf:type` triple is first seen in the document, so the generated OSI
// is stable across runs (and matches its golden).

import {Parser} from 'n3';

import {OwlClass, OwlDatatypeProperty, OwlModel, OwlObjectProperty,} from './model';

// RDF/RDFS/OWL/SKOS term IRIs we recognize. Only these; anything else is
// carried by neither the parser nor the model (see the user guide's
// "not covered yet").
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const OWL_CLASS = 'http://www.w3.org/2002/07/owl#Class';
const OWL_DATATYPE_PROPERTY = 'http://www.w3.org/2002/07/owl#DatatypeProperty';
const OWL_OBJECT_PROPERTY = 'http://www.w3.org/2002/07/owl#ObjectProperty';
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';
const RDFS_DOMAIN = 'http://www.w3.org/2000/01/rdf-schema#domain';
const RDFS_RANGE = 'http://www.w3.org/2000/01/rdf-schema#range';
const SKOS_ALT_LABEL = 'http://www.w3.org/2004/02/skos/core#altLabel';
const SKOS_PREF_LABEL = 'http://www.w3.org/2004/02/skos/core#prefLabel';

// One of the three OWL kinds we route a typed subject to.
type OwlKind = 'class'|'datatypeProperty'|'objectProperty';

const KIND_BY_TYPE: Record<string, OwlKind> = {
  [OWL_CLASS]: 'class',
  [OWL_DATATYPE_PROPERTY]: 'datatypeProperty',
  [OWL_OBJECT_PROPERTY]: 'objectProperty',
};

// The namespace-stripped local name of a term IRI: the part after the last `#`
// or `/`. This is the OSI-facing identity (see the user guide -- the full IRI
// is reconstructable as `<base><localName>` and is not carried).
function localName(iri: string): string {
  const hash = iri.lastIndexOf('#');
  const slash = iri.lastIndexOf('/');
  const cut = Math.max(hash, slash);
  return cut >= 0 ? iri.slice(cut + 1) : iri;
}

// The namespace portion of a term IRI (everything up to and including the last
// `#`/`/`); used as the ontology's base IRI for provenance.
function namespace(iri: string): string|undefined {
  const cut = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
  return cut >= 0 ? iri.slice(0, cut + 1) : undefined;
}

// Per-subject accumulator, filled in a single ordered pass so the first
// rdfs:label wins the `label` slot and later labels / SKOS alt labels become
// synonyms.
interface Annotations {
  label?: string;
  comment?: string;
  domain?: string;
  range?: string;
  synonyms: string[];
}

function emptyAnnotations(): Annotations {
  return {synonyms: []};
}

/**
 * Parses a Turtle document into an OwlModel.
 *
 * Synchronous: `n3`'s Parser returns the full quad array when called without a
 * callback, which suits a one-shot file import. Throws on malformed Turtle (the
 * parser's own error), which the CLI surfaces.
 */
export function parseOwl(turtle: string): OwlModel {
  const quads = new Parser().parse(turtle);

  // Pass 1: ordered list of typed subjects (first `rdf:type` occurrence wins
  // the position), plus a kind index. Scanning `quads` directly (not the Store)
  // keeps document order.
  const order: string[] = [];
  const kind = new Map<string, OwlKind>();
  for (const q of quads) {
    if (q.predicate.value !== RDF_TYPE) continue;
    const k = KIND_BY_TYPE[q.object.value];
    if (!k) continue;
    const iri = q.subject.value;
    if (!kind.has(iri)) {
      kind.set(iri, k);
      order.push(iri);
    }
  }

  // Pass 2: accumulate annotations for each typed subject in document order, so
  // the first label is the primary and the rest are synonyms.
  const annotations = new Map<string, Annotations>();
  const annotationsFor = (iri: string): Annotations => {
    let a = annotations.get(iri);
    if (!a) {
      a = emptyAnnotations();
      annotations.set(iri, a);
    }
    return a;
  };
  for (const q of quads) {
    const subject = q.subject.value;
    if (!kind.has(subject)) continue;
    const a = annotationsFor(subject);
    switch (q.predicate.value) {
      case RDFS_LABEL:
        // First label -> the display label; any further label -> a synonym.
        if (a.label === undefined)
          a.label = q.object.value;
        else
          a.synonyms.push(q.object.value);
        break;
      case SKOS_ALT_LABEL:
      case SKOS_PREF_LABEL:
        a.synonyms.push(q.object.value);
        break;
      case RDFS_COMMENT:
        a.comment = q.object.value;
        break;
      case RDFS_DOMAIN:
        a.domain = localName(q.object.value);
        break;
      case RDFS_RANGE:
        a.range = q.object.value;  // kept as IRI; mapper maps xsd:* -> datatype
        break;
      default:
        break;
    }
  }

  const classes: OwlClass[] = [];
  const datatypeProperties: OwlDatatypeProperty[] = [];
  const objectProperties: OwlObjectProperty[] = [];
  let baseIri: string|undefined;

  for (const iri of order) {
    if (baseIri === undefined) baseIri = namespace(iri);
    const a = annotations.get(iri) ?? emptyAnnotations();
    switch (kind.get(iri)) {
      case 'class':
        classes.push({
          localName: localName(iri),
          label: a.label,
          comment: a.comment,
          synonyms: a.synonyms,
        });
        break;
      case 'datatypeProperty':
        datatypeProperties.push({
          localName: localName(iri),
          domain: a.domain,
          rangeIri: a.range,
          label: a.label,
          comment: a.comment,
          synonyms: a.synonyms,
        });
        break;
      case 'objectProperty':
        objectProperties.push({
          localName: localName(iri),
          domain: a.domain,
          range: a.range !== undefined ? localName(a.range) : undefined,
          label: a.label,
          comment: a.comment,
          synonyms: a.synonyms,
        });
        break;
      default:
        break;
    }
  }

  return {baseIri, classes, datatypeProperties, objectProperties};
}
