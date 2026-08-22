// Turtle (.ttl) -> OwlModel parser.
//
// A mechanical triples-to-structs step: it reads RDF with `n3`, recognizes the
// OWL/RDFS/SKOS/Dublin-Core terms the converter supports, and fills the staging
// OwlModel (model.ts). All OWL -> OSI mapping policy lives in to_ir.ts, not
// here; this file only decides "which triples matter and where do their values
// go".
//
// Declaration order is preserved: classes and properties appear in the order
// their `rdf:type` triple is first seen in the document, so the generated OSI
// is stable across runs (and matches its golden).

import {Parser} from 'n3';

import {OwlClass, OwlDatatypeProperty, OwlModel, OwlObjectProperty, OwlOntology,} from './model';

// RDF/RDFS/OWL/SKOS/Dublin-Core term IRIs we recognize. Only these; anything
// else is carried by neither the parser nor the model (see the user guide's
// "not covered yet").
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const DCTERMS = 'http://purl.org/dc/terms/';
const DC = 'http://purl.org/dc/elements/1.1/';

const RDF_TYPE = `${RDF}type`;
// RDF collection (list) terms, used to walk an owl:hasKey list.
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const RDF_NIL = `${RDF}nil`;

const OWL_CLASS = `${OWL}Class`;
const OWL_DATATYPE_PROPERTY = `${OWL}DatatypeProperty`;
const OWL_OBJECT_PROPERTY = `${OWL}ObjectProperty`;
const OWL_INVERSE_FUNCTIONAL_PROPERTY = `${OWL}InverseFunctionalProperty`;
const OWL_ONTOLOGY = `${OWL}Ontology`;
const OWL_HAS_KEY = `${OWL}hasKey`;
const OWL_VERSION_INFO = `${OWL}versionInfo`;
const OWL_THING = `${OWL}Thing`;

const RDFS_LABEL = `${RDFS}label`;
const RDFS_COMMENT = `${RDFS}comment`;
const RDFS_DOMAIN = `${RDFS}domain`;
const RDFS_RANGE = `${RDFS}range`;
const RDFS_SUBCLASS_OF = `${RDFS}subClassOf`;
const RDFS_SUBPROPERTY_OF = `${RDFS}subPropertyOf`;
const RDFS_RESOURCE = `${RDFS}Resource`;
// The implicit universal superclasses: every class is trivially a subclass of
// owl:Thing / rdfs:Resource, so an explicit `rdfs:subClassOf` naming one
// carries no inheritance information and is not recorded as `extends` (nor
// warned about).
const TOP_CLASS_IRIS = new Set([OWL_THING, RDFS_RESOURCE]);

const SKOS_ALT_LABEL = `${SKOS}altLabel`;
const SKOS_PREF_LABEL = `${SKOS}prefLabel`;
const SKOS_HIDDEN_LABEL = `${SKOS}hiddenLabel`;
const SKOS_DEFINITION = `${SKOS}definition`;
const SKOS_EXAMPLE = `${SKOS}example`;

const DCTERMS_DESCRIPTION = `${DCTERMS}description`;
const DC_DESCRIPTION = `${DC}description`;

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
  const cut = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
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
// synonyms. Descriptions are kept per source predicate so a fixed precedence
// (rdfs:comment > skos:definition > dcterms: > dc:) can be applied at build
// time regardless of the order the triples appear in the document.
interface Annotations {
  label?: string;
  synonyms: string[];
  examples: string[];
  rdfsComment?: string;
  skosDefinition?: string;
  dctermsDescription?: string;
  dcDescription?: string;
  domains: string[];
  ranges: string[];  // raw range IRIs; the mapper maps xsd:* -> datatype
  versionInfo?: string;
  keyListHeads: string[];  // owl:hasKey list heads (blank nodes)
  subClassOf: string[];
  subPropertyOf: string[];
}

function emptyAnnotations(): Annotations {
  return {
    synonyms: [],
    examples: [],
    domains: [],
    ranges: [],
    keyListHeads: [],
    subClassOf: [],
    subPropertyOf: []
  };
}

// The effective description: the first present of rdfs:comment,
// skos:definition, dcterms:description, dc:description -- a fixed precedence so
// a term with more than one carries the most specific.
function descriptionOf(a: Annotations): string|undefined {
  return a.rdfsComment ?? a.skosDefinition ?? a.dctermsDescription ??
      a.dcDescription;
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

  // Pass 1: types. An ordered list of typed subjects (first `rdf:type`
  // occurrence wins the position) plus a kind index; the set of
  // inverse-functional subjects and the ontology-header subject, which are
  // recognized by their type but are not themselves classes/properties.
  // Scanning `quads` directly (not the Store) keeps document order.
  const order: string[] = [];
  const kind = new Map<string, OwlKind>();
  const inverseFunctional = new Set<string>();
  let ontologyIri: string|undefined;
  for (const q of quads) {
    if (q.predicate.value !== RDF_TYPE) continue;
    const type = q.object.value;
    const subject = q.subject.value;
    if (type === OWL_INVERSE_FUNCTIONAL_PROPERTY) {
      inverseFunctional.add(subject);
      continue;
    }
    if (type === OWL_ONTOLOGY) {
      if (ontologyIri === undefined) ontologyIri = subject;
      continue;
    }
    const k = KIND_BY_TYPE[type];
    if (!k) continue;
    if (!kind.has(subject)) {
      kind.set(subject, k);
      order.push(subject);
    }
  }

  // Pass 2: RDF list structure (rdf:first / rdf:rest), so an owl:hasKey list
  // can be resolved to its member properties. List nodes are blank nodes
  // unrelated to the typed subjects, so they are collected separately.
  const listFirst = new Map<string, string>();
  const listRest = new Map<string, string>();
  for (const q of quads) {
    if (q.predicate.value === RDF_FIRST)
      listFirst.set(q.subject.value, q.object.value);
    else if (q.predicate.value === RDF_REST)
      listRest.set(q.subject.value, q.object.value);
  }
  // Resolves an RDF collection to its member IRIs, following rdf:rest to nil.
  // Defensive against a cycle or a missing link (stops at the first gap).
  const resolveList = (head: string): string[] => {
    const out: string[] = [];
    const seen = new Set<string>();
    let node: string|undefined = head;
    while (node && node !== RDF_NIL && !seen.has(node)) {
      seen.add(node);
      const value = listFirst.get(node);
      if (value === undefined) break;
      out.push(value);
      node = listRest.get(node);
    }
    return out;
  };

  // Pass 3: accumulate annotations for each typed subject (and the ontology
  // header) in document order, so the first label is the primary and the rest
  // are synonyms.
  const annotations = new Map<string, Annotations>();
  const annotationsFor = (iri: string): Annotations => {
    let a = annotations.get(iri);
    if (!a) {
      a = emptyAnnotations();
      annotations.set(iri, a);
    }
    return a;
  };
  const annotated = (iri: string): boolean =>
      kind.has(iri) || iri === ontologyIri;
  for (const q of quads) {
    const subject = q.subject.value;
    if (!annotated(subject)) continue;
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
      case SKOS_HIDDEN_LABEL:
        a.synonyms.push(q.object.value);
        break;
      case SKOS_EXAMPLE:
        a.examples.push(q.object.value);
        break;
      case RDFS_COMMENT:
        a.rdfsComment = q.object.value;
        break;
      case SKOS_DEFINITION:
        a.skosDefinition = q.object.value;
        break;
      case DCTERMS_DESCRIPTION:
        a.dctermsDescription = q.object.value;
        break;
      case DC_DESCRIPTION:
        a.dcDescription = q.object.value;
        break;
      case RDFS_DOMAIN:
        a.domains.push(localName(q.object.value));
        break;
      case RDFS_RANGE:
        a.ranges.push(q.object.value);  // kept as IRI; mapper maps xsd:*
        break;
      case OWL_VERSION_INFO:
        a.versionInfo = q.object.value;
        break;
      case OWL_HAS_KEY:
        a.keyListHeads.push(q.object.value);
        break;
      case RDFS_SUBCLASS_OF:
        // Class hierarchy -> the entity's `extends`. Named superclasses only:
        // a blank-node object (an owl:Restriction and similar axioms) is not a
        // named class, so it is ignored here (out of scope). The implicit
        // universal superclasses (owl:Thing / rdfs:Resource) are ignored too --
        // every class subclasses them, so they carry no inheritance
        // information.
        if (q.object.termType === 'NamedNode' &&
            !TOP_CLASS_IRIS.has(q.object.value))
          a.subClassOf.push(localName(q.object.value));
        break;
      case RDFS_SUBPROPERTY_OF:
        // Property hierarchy -> NOT supported (entity-level inheritance only).
        // Recorded so the mapper can warn and drop it; named superproperties
        // only.
        if (q.object.termType === 'NamedNode')
          a.subPropertyOf.push(localName(q.object.value));
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
          comment: descriptionOf(a),
          synonyms: a.synonyms,
          examples: a.examples,
          keys: a.keyListHeads.flatMap(resolveList).map(localName),
          subClassOf: a.subClassOf,
        });
        break;
      case 'datatypeProperty':
        datatypeProperties.push({
          localName: localName(iri),
          domains: a.domains,
          rangeIri: a.ranges[0],
          label: a.label,
          comment: descriptionOf(a),
          synonyms: a.synonyms,
          examples: a.examples,
          inverseFunctional: inverseFunctional.has(iri),
          subPropertyOf: a.subPropertyOf,
        });
        break;
      case 'objectProperty':
        objectProperties.push({
          localName: localName(iri),
          // a.domains are already local names; a.ranges are raw IRIs. Carry all
          // of each so the mapper can warn about (and drop) the extras rather
          // than silently keeping only the first.
          domains: a.domains,
          ranges: a.ranges.map(localName),
          label: a.label,
          comment: descriptionOf(a),
          synonyms: a.synonyms,
          examples: a.examples,
          subPropertyOf: a.subPropertyOf,
        });
        break;
      default:
        break;
    }
  }

  // The ontology header, if present, becomes model-level metadata. The base IRI
  // is best derived from an actual term's namespace (exact, delimiter and all);
  // the ontology IRI is only a heuristic fallback (its own IRI often omits the
  // trailing `#`/`/`), so use it only when no term supplied a namespace.
  let ontology: OwlOntology|undefined;
  if (ontologyIri !== undefined) {
    const a = annotations.get(ontologyIri) ?? emptyAnnotations();
    const labels =
        a.label !== undefined ? [a.label, ...a.synonyms] : a.synonyms;
    ontology = {
      comment: descriptionOf(a),
      synonyms: labels,
      examples: a.examples,
      version: a.versionInfo,
    };
    baseIri = baseIri ?? ontologyBaseIri(ontologyIri);
  }

  return {baseIri, ontology, classes, datatypeProperties, objectProperties};
}

// The base namespace an ontology IRI stands for. An owl:Ontology is commonly
// named by the namespace root without the trailing `#`/`/` (e.g.
// `http://example.com/sales`), so append `#` when the IRI has no delimiter of
// its own; otherwise keep it as given.
function ontologyBaseIri(iri: string): string|undefined {
  if (!iri) return undefined;
  const last = iri[iri.length - 1];
  if (last === '#' || last === '/') return iri;
  return `${iri}#`;
}
