// The OWL intermediate model: a thin, parser-facing view of an ontology.
//
// This is deliberately NOT the semantic-model IR (see ../../ir.ts). It is a
// small staging shape that the Turtle parser (parse.ts) fills from RDF triples
// and the mapper (to_ir.ts) reads to produce the IR. Keeping the two apart lets
// the parser stay a mechanical triples-to-structs step while all of the OWL ->
// OSI mapping policy lives in one place (to_ir.ts).
//
// Scope: the OWL constructs the converter maps to native OSI today -- classes,
// datatype/object properties, their human annotations (rdfs:label / comment,
// skos labels / definition / example, dcterms/dc description), datatype ranges,
// keys (owl:hasKey, owl:InverseFunctionalProperty), class hierarchy
// (rdfs:subClassOf -> extends), and ontology-header metadata -- PLUS the
// constructs with no native home that ride along verbatim as custom extensions
// (rdfs:subPropertyOf, owl:inverseOf, owl:equivalentClass, and the
// symmetric/transitive/functional property characteristics). Richer OWL still
// absent (SHACL, cardinality restrictions, owl:oneOf, individuals); see the
// "What is not covered yet" note in the guide.

/** An `owl:Class` -- becomes an OSI dataset (entity). */
export interface OwlClass {
  // The term's local name (the part after the namespace `#`/`/`), used as the
  // OSI entity name, e.g. `Customer`.
  localName: string;
  // rdfs:label, if present. A display name; carried to the entity only when it
  // adds information over `localName` (see to_ir.ts).
  label?: string;
  // A description (rdfs:comment, or skos:definition / dcterms:/dc:description
  // when there is no rdfs:comment) -> entity description.
  comment?: string;
  // Additional human names (extra rdfs:label / skos:altLabel|prefLabel|
  // hiddenLabel) -> ai_context.synonyms.
  synonyms: string[];
  // skos:example values -> ai_context.examples.
  examples: string[];
  // Local names of the properties named by owl:hasKey -> the entity's
  // primary_key (grain). Empty when the class declares no key.
  keys: string[];
  // Local names of `rdfs:subClassOf` superclasses, in document order -> the
  // entity's `extends` (entity-level inheritance). Named superclasses only;
  // blank-node axioms (owl:Restriction, ...) are not recorded. Empty when none.
  subClassOf: string[];
  // Local names of `owl:equivalentClass` classes, in document order. No native
  // OSI home (a class is one entity; equivalence is a fact ABOUT it, not a
  // structural link), so it is carried verbatim as a custom extension. Named
  // classes only; a blank-node class expression (owl:intersectionOf, ...) is
  // not recorded (out of scope, Tier 3). Empty when none.
  equivalentClass: string[];
}

/**
 * An `owl:DatatypeProperty` -- becomes a field on its domain class's dataset.
 */
export interface OwlDatatypeProperty {
  localName: string;
  // Local names of every rdfs:domain class this property hangs off; the field
  // is added to each. A property may declare more than one domain (it then
  // appears on each entity). Empty when no domain is declared (skipped with a
  // warning -- an unattached field has nowhere to live).
  domains: string[];
  // The rdfs:range IRI (e.g. the xsd:string IRI), mapped to an OSI datatype by
  // the mapper. Undefined when no range is declared (-> Opaque).
  rangeIri?: string;
  label?: string;
  comment?: string;
  synonyms: string[];
  examples: string[];
  // True when the property is also an owl:InverseFunctionalProperty -- it
  // uniquely identifies its subject, so it maps to a unique_keys constraint on
  // each domain entity.
  inverseFunctional: boolean;
  // True when the property is also an owl:FunctionalProperty -- it has at most
  // one value per subject. No native OSI home (OSI has no single-valued flag),
  // so it is carried verbatim as a field custom extension.
  functional: boolean;
  // Local names of `rdfs:subPropertyOf` superproperties, if any. Property
  // inheritance has no native OSI home (only entity-level `rdfs:subClassOf` ->
  // `extends`); it is carried verbatim as a field custom extension. Empty when
  // none.
  subPropertyOf: string[];
}

/**
 * An `owl:ObjectProperty` -- becomes a relationship (edge) between two
 * classes.
 */
export interface OwlObjectProperty {
  localName: string;
  // Local names of the rdfs:domain (edge source) and rdfs:range (edge
  // destination) classes. A relationship maps a single source to a single
  // destination, so the mapper uses the first of each and warns when more are
  // declared (multiple domains/ranges mean an intersection in OWL, which has no
  // clean single-edge shape). Empty when none is declared (skipped with a
  // warning: an edge needs both endpoints).
  domains: string[];
  ranges: string[];
  label?: string;
  comment?: string;
  synonyms: string[];
  examples: string[];
  // Local names of `rdfs:subPropertyOf` superproperties, if any. Relationship
  // inheritance has no native OSI home (only entity-level `rdfs:subClassOf` ->
  // `extends`); it is carried verbatim as a relationship custom extension.
  // Empty when none.
  subPropertyOf: string[];
  // Local names of `owl:inverseOf` properties (the edge read the other way),
  // in document order. No native OSI home (an edge is directed; the inverse is
  // a separate fact), so it is carried verbatim. Usually one; more than one is
  // kept here and reconciled by the mapper (first wins, rest warned). Empty
  // when none.
  inverseOf: string[];
  // owl:SymmetricProperty -- the edge holds both ways (`a rel b` implies
  // `b rel a`). Carried verbatim; no native OSI home.
  symmetric: boolean;
  // owl:TransitiveProperty -- the edge chains (`a rel b` and `b rel c` imply
  // `a rel c`). Carried verbatim; no native OSI home.
  transitive: boolean;
  // owl:FunctionalProperty -- at most one destination per source. Carried
  // verbatim; no native OSI home.
  functional: boolean;
}

/**
 * The ontology header (an `owl:Ontology` node) -- becomes model-level metadata.
 *
 * A description (rdfs:comment / skos:definition / dcterms:/dc:description) ->
 * the model `description`; labels -> `ai_context.synonyms`; skos:example ->
 * `ai_context.examples`; owl:versionInfo -> appended to the description as
 * provenance.
 */
export interface OwlOntology {
  comment?: string;
  synonyms: string[];
  examples: string[];
  version?: string;
}

/**
 * A parsed OWL ontology, in declaration order.
 *
 * Order is preserved from the source document so the generated OSI (and its
 * golden) is stable: entities appear in class-declaration order and each
 * entity's fields in datatype-property-declaration order.
 */
export interface OwlModel {
  // The ontology's base namespace IRI (from the default `@prefix` or the first
  // term's namespace), kept only as provenance for the model description. Term
  // IRIs themselves are dropped -- see the user guide.
  baseIri?: string;
  // The ontology-header metadata (owl:Ontology node), if the document has one.
  ontology?: OwlOntology;
  classes: OwlClass[];
  datatypeProperties: OwlDatatypeProperty[];
  objectProperties: OwlObjectProperty[];
}
