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

import {OwlClass, OwlCommonAnnotations, OwlDatatypeProperty, OwlModel, OwlObjectProperty, OwlOntology,} from './model';

// RDF/RDFS/OWL/SKOS/Dublin-Core term IRIs we recognize. Only these; anything
// else is carried by neither the parser nor the model (see the user guide's
// "not covered yet").
const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const OWL = 'http://www.w3.org/2002/07/owl#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const DCTERMS = 'http://purl.org/dc/terms/';
const DC = 'http://purl.org/dc/elements/1.1/';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const XSD_BOOLEAN = `${XSD}boolean`;
const XSD_STRING = `${XSD}string`;
// The two lexical forms of xsd:boolean `true` (XSD admits both `true` and `1`);
// `false`/`0` restate the default and are not carried (see the OWL_DEPRECATED
// case).
const XSD_BOOLEAN_TRUE = new Set(['true', '1']);

const RDF_TYPE = `${RDF}type`;
// RDF collection (list) terms, used to walk an owl:hasKey list.
const RDF_FIRST = `${RDF}first`;
const RDF_REST = `${RDF}rest`;
const RDF_NIL = `${RDF}nil`;

const OWL_CLASS = `${OWL}Class`;
const OWL_DATATYPE_PROPERTY = `${OWL}DatatypeProperty`;
const OWL_OBJECT_PROPERTY = `${OWL}ObjectProperty`;
const OWL_INVERSE_FUNCTIONAL_PROPERTY = `${OWL}InverseFunctionalProperty`;
// Property characteristics carried verbatim (no native OSI home). Recognized by
// their rdf:type, like owl:InverseFunctionalProperty, and collected as
// typed-subject sets.
const OWL_SYMMETRIC_PROPERTY = `${OWL}SymmetricProperty`;
const OWL_TRANSITIVE_PROPERTY = `${OWL}TransitiveProperty`;
const OWL_FUNCTIONAL_PROPERTY = `${OWL}FunctionalProperty`;
const OWL_REFLEXIVE_PROPERTY = `${OWL}ReflexiveProperty`;
const OWL_IRREFLEXIVE_PROPERTY = `${OWL}IrreflexiveProperty`;
const OWL_ASYMMETRIC_PROPERTY = `${OWL}AsymmetricProperty`;
const OWL_ONTOLOGY = `${OWL}Ontology`;
const OWL_HAS_KEY = `${OWL}hasKey`;
const OWL_INVERSE_OF = `${OWL}inverseOf`;
const OWL_EQUIVALENT_PROPERTY = `${OWL}equivalentProperty`;
const OWL_PROPERTY_DISJOINT_WITH = `${OWL}propertyDisjointWith`;
const OWL_DISJOINT_WITH = `${OWL}disjointWith`;
const OWL_DEPRECATED = `${OWL}deprecated`;
const OWL_VERSION_INFO = `${OWL}versionInfo`;
const OWL_THING = `${OWL}Thing`;

const RDFS_LABEL = `${RDFS}label`;
const RDFS_COMMENT = `${RDFS}comment`;
const RDFS_DOMAIN = `${RDFS}domain`;
const RDFS_RANGE = `${RDFS}range`;
const RDFS_SUBCLASS_OF = `${RDFS}subClassOf`;
const RDFS_SUBPROPERTY_OF = `${RDFS}subPropertyOf`;
const RDFS_SEE_ALSO = `${RDFS}seeAlso`;
const RDFS_IS_DEFINED_BY = `${RDFS}isDefinedBy`;
const OWL_EQUIVALENT_CLASS = `${OWL}equivalentClass`;
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
// or `/`. This is the OSI-facing identity of an in-namespace term (e.g. an
// entity/field name); the mapper also uses it to shorten a carried in-namespace
// cross-reference (see to_ir.refValue). Exported for that mapper use.
export function localName(iri: string): string {
  const cut = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
  return cut >= 0 ? iri.slice(cut + 1) : iri;
}

// The namespace portion of a term IRI (everything up to and including the last
// `#`/`/`); the ontology's base IRI for provenance, and the key the mapper
// compares against to decide whether a cross-reference is in-namespace (see
// to_ir.refValue). Exported for that mapper use.
export function namespace(iri: string): string|undefined {
  const cut = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
  return cut >= 0 ? iri.slice(0, cut + 1) : undefined;
}

// Renders a literal term in the N-Triples form used to carry an rdfs:seeAlso
// literal (see the RDFS_SEE_ALSO case): the lexical value wrapped in double
// quotes, followed by an optional `@lang` language tag or `^^<datatype>` type
// IRI so a language-tagged or typed literal round-trips rather than collapsing
// to a bare string. A plain xsd:string carries no suffix (it is the implicit
// default). Backslash and double quote in the value are escaped, the two
// characters that would otherwise break the wrapping. Reversed by parsing the
// N-Triples literal grammar.
function ntriplesLiteral(
    value: string, language: string, datatype: string): string {
  const quoted = `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  if (language) return `${quoted}@${language}`;
  if (datatype && datatype !== XSD_STRING) return `${quoted}^^<${datatype}>`;
  return quoted;
}

// The most common namespace among a set of term IRIs -- the ontology's own
// namespace. A tie (or a single term) resolves to the first in document order,
// since `best` is only replaced on a STRICTLY greater count. Returns undefined
// for an empty set (a document with no typed terms). Delimiter-exact, unlike
// deriving the base from the ontology IRI (which often omits the trailing
// `#`/`/`).
function dominantNamespace(iris: string[]): string|undefined {
  const counts = new Map<string, number>();
  let best: string|undefined;
  let bestCount = 0;
  for (const iri of iris) {
    const ns = namespace(iri);
    if (ns === undefined) continue;
    const n = (counts.get(ns) ?? 0) + 1;
    counts.set(ns, n);
    if (n > bestCount) {
      bestCount = n;
      best = ns;
    }
  }
  return best;
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
  keyListHeads: string[];          // owl:hasKey list heads (blank nodes)
  subClassOf: string[];            // local names (feed native `extends`)
  subPropertyOf: string[];         // full IRIs (named superproperties)
  equivalentClass: string[];       // full IRIs (named classes only)
  inverseOf: string[];             // full IRIs (named object properties only)
  disjointWith: string[];          // full IRIs (named classes only)
  equivalentProperty: string[];    // full IRIs (named properties only)
  propertyDisjointWith: string[];  // full IRIs (named properties only)
  seeAlso: string[];               // rdfs:seeAlso (IRIs or literals, verbatim)
  isDefinedBy: string[];           // rdfs:isDefinedBy (IRIs, verbatim)
  deprecated: boolean;             // owl:deprecated
}

function emptyAnnotations(): Annotations {
  return {
    synonyms: [],
    examples: [],
    domains: [],
    ranges: [],
    keyListHeads: [],
    subClassOf: [],
    subPropertyOf: [],
    equivalentClass: [],
    inverseOf: [],
    disjointWith: [],
    equivalentProperty: [],
    propertyDisjointWith: [],
    seeAlso: [],
    isDefinedBy: [],
    deprecated: false
  };
}

// The effective description: the first present of rdfs:comment,
// skos:definition, dcterms:description, dc:description -- a fixed precedence so
// a term with more than one carries the most specific.
function descriptionOf(a: Annotations): string|undefined {
  return a.rdfsComment ?? a.skosDefinition ?? a.dctermsDescription ??
      a.dcDescription;
}

// The per-term carried annotations (rdfs:seeAlso / isDefinedBy, owl:deprecated
// / versionInfo), shared by classes and both property kinds, projected from the
// accumulator into the model's common-annotation shape.
function commonAnnotations(a: Annotations): OwlCommonAnnotations {
  return {
    seeAlso: a.seeAlso,
    isDefinedBy: a.isDefinedBy,
    deprecated: a.deprecated,
    versionInfo: a.versionInfo,
  };
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
  // Property characteristics carried verbatim, each a set of the subjects typed
  // with it. A property is commonly typed with several types (e.g.
  // `a owl:ObjectProperty, owl:SymmetricProperty`), so a characteristic type is
  // recorded here and does not compete with the kind that routes it to a
  // class/property.
  const symmetric = new Set<string>();
  const transitive = new Set<string>();
  const functional = new Set<string>();
  const reflexive = new Set<string>();
  const irreflexive = new Set<string>();
  const asymmetric = new Set<string>();
  let ontologyIri: string|undefined;
  for (const q of quads) {
    if (q.predicate.value !== RDF_TYPE) continue;
    const type = q.object.value;
    const subject = q.subject.value;
    if (type === OWL_INVERSE_FUNCTIONAL_PROPERTY) {
      inverseFunctional.add(subject);
      continue;
    }
    if (type === OWL_SYMMETRIC_PROPERTY) {
      symmetric.add(subject);
      continue;
    }
    if (type === OWL_TRANSITIVE_PROPERTY) {
      transitive.add(subject);
      continue;
    }
    if (type === OWL_FUNCTIONAL_PROPERTY) {
      functional.add(subject);
      continue;
    }
    if (type === OWL_REFLEXIVE_PROPERTY) {
      reflexive.add(subject);
      continue;
    }
    if (type === OWL_IRREFLEXIVE_PROPERTY) {
      irreflexive.add(subject);
      continue;
    }
    if (type === OWL_ASYMMETRIC_PROPERTY) {
      asymmetric.add(subject);
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
        // Property hierarchy -> no native OSI home; carried verbatim by the
        // mapper as a custom extension. Named superproperties only (a
        // blank-node property expression is out of scope). The full IRI is
        // kept; the mapper shortens an in-namespace one (see to_ir.refValue).
        if (q.object.termType === 'NamedNode')
          a.subPropertyOf.push(q.object.value);
        break;
      case OWL_EQUIVALENT_CLASS:
        // Class equivalence -> no native OSI home; carried verbatim. Named
        // classes only; a blank-node class expression (owl:intersectionOf, ...)
        // is a class definition, not a plain cross-reference, so it is ignored
        // (out of scope, like a blank-node subClassOf).
        if (q.object.termType === 'NamedNode')
          a.equivalentClass.push(q.object.value);
        break;
      case OWL_DISJOINT_WITH:
        // Class disjointness -> no native OSI home; carried verbatim. Named
        // classes only (a blank-node class expression is out of scope).
        if (q.object.termType === 'NamedNode')
          a.disjointWith.push(q.object.value);
        break;
      case OWL_INVERSE_OF:
        // Inverse edge -> no native OSI home; carried verbatim. Named object
        // properties only.
        if (q.object.termType === 'NamedNode') a.inverseOf.push(q.object.value);
        break;
      case OWL_EQUIVALENT_PROPERTY:
        // Property equivalence -> no native OSI home; carried verbatim. Named
        // properties only.
        if (q.object.termType === 'NamedNode')
          a.equivalentProperty.push(q.object.value);
        break;
      case OWL_PROPERTY_DISJOINT_WITH:
        // Property disjointness -> no native OSI home; carried verbatim. Named
        // properties only.
        if (q.object.termType === 'NamedNode')
          a.propertyDisjointWith.push(q.object.value);
        break;
      case RDFS_SEE_ALSO:
        // A pointer to further information -> carried verbatim as an N-Triples
        // object term, so an IRI stays distinguishable from a literal on
        // round-trip: an IRI as `<iri>`, a literal as `"text"` with any
        // language tag (`@en`) or datatype (`^^<iri>`) preserved (see
        // ntriplesLiteral). seeAlso is the only carried slot that admits either
        // kind; every other carries a bare IRI or local name. A blank node has
        // no stable identity to carry, so it is skipped.
        if (q.object.termType === 'NamedNode')
          a.seeAlso.push(`<${q.object.value}>`);
        else if (q.object.termType === 'Literal')
          a.seeAlso.push(ntriplesLiteral(
              q.object.value, q.object.language,
              q.object.datatype?.value ?? ''));
        break;
      case RDFS_IS_DEFINED_BY:
        // The resource (usually the defining ontology) that defines this term
        // -> carried verbatim. Named resources only.
        if (q.object.termType === 'NamedNode')
          a.isDefinedBy.push(q.object.value);
        break;
      case OWL_DEPRECATED:
        // Lifecycle flag -> carried only for an xsd:boolean literal that is
        // `true`. That is the one meaningful assertion; an explicit `false`/`0`
        // restates the default, and a non-boolean value (e.g. the string
        // "true") is malformed -- neither is carried. Both XSD lexical forms of
        // true (`true` and `1`) are accepted.
        if (q.object.termType === 'Literal' &&
            q.object.datatype?.value === XSD_BOOLEAN &&
            XSD_BOOLEAN_TRUE.has(q.object.value))
          a.deprecated = true;
        break;
      default:
        break;
    }
  }

  const classes: OwlClass[] = [];
  const datatypeProperties: OwlDatatypeProperty[] = [];
  const objectProperties: OwlObjectProperty[] = [];
  // The ontology's own namespace: the one shared by MOST of its typed terms.
  // Taking the most common namespace (not merely the first typed term's) is
  // robust to a document that also types a handful of foreign-namespace terms
  // -- e.g. an imported class it annotates -- which would otherwise hijack the
  // base if one happened to appear first and silently invert the mapper's
  // in-namespace/cross-namespace shortening (see to_ir.refValue).
  let baseIri = dominantNamespace(order);

  for (const iri of order) {
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
          equivalentClass: a.equivalentClass,
          disjointWith: a.disjointWith,
          ...commonAnnotations(a),
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
          functional: functional.has(iri),
          subPropertyOf: a.subPropertyOf,
          equivalentProperty: a.equivalentProperty,
          propertyDisjointWith: a.propertyDisjointWith,
          ...commonAnnotations(a),
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
          inverseOf: a.inverseOf,
          equivalentProperty: a.equivalentProperty,
          propertyDisjointWith: a.propertyDisjointWith,
          symmetric: symmetric.has(iri),
          transitive: transitive.has(iri),
          functional: functional.has(iri),
          reflexive: reflexive.has(iri),
          irreflexive: irreflexive.has(iri),
          asymmetric: asymmetric.has(iri),
          ...commonAnnotations(a),
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
