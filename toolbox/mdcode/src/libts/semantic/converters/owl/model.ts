// The OWL intermediate model: a thin, parser-facing view of an ontology.
//
// This is deliberately NOT the semantic-model IR (see ../../ir.ts). It is a
// small staging shape that the Turtle parser (parse.ts) fills from RDF triples
// and the mapper (to_ir.ts) reads to produce the IR. Keeping the two apart lets
// the parser stay a mechanical triples-to-structs step while all of the OWL ->
// OSI mapping policy lives in one place (to_ir.ts).
//
// Scope: only the constructs the first cut converts -- classes, datatype
// properties, object properties, and the handful of annotations on them
// (rdfs:label / rdfs:comment / alternate labels). Richer OWL (subClassOf,
// inverseOf, SHACL, cardinality, individuals) is intentionally absent; see the
// "What is not covered yet" note in the user guide.

/** An `owl:Class` -- becomes an OSI dataset (entity). */
export interface OwlClass {
  // The term's local name (the part after the namespace `#`/`/`), used as the
  // OSI entity name, e.g. `Customer`.
  localName: string;
  // rdfs:label, if present. A display name; carried to the entity only when it
  // adds information over `localName` (see to_ir.ts).
  label?: string;
  // rdfs:comment, if present -> entity description.
  comment?: string;
  // Additional human names (extra rdfs:label / skos:altLabel|prefLabel) ->
  // ai_context.synonyms.
  synonyms: string[];
  // Local names of `rdfs:subClassOf` superclasses, in document order -> the
  // entity's `extends` (entity-level inheritance). Named superclasses only;
  // blank-node axioms (owl:Restriction, ...) are not recorded. Empty when none.
  subClassOf: string[];
}

/**
 * An `owl:DatatypeProperty` -- becomes a field on its domain class's dataset.
 */
export interface OwlDatatypeProperty {
  localName: string;
  // Local name of the rdfs:domain class this property hangs off; the field is
  // added to that entity. Undefined when no domain is declared (skipped with a
  // warning -- an unattached field has nowhere to live).
  domain?: string;
  // The rdfs:range IRI (e.g. the xsd:string IRI), mapped to an OSI datatype by
  // the mapper. Undefined when no range is declared (-> Opaque).
  rangeIri?: string;
  label?: string;
  comment?: string;
  synonyms: string[];
  // Local names of `rdfs:subPropertyOf` superproperties, if any. Property
  // inheritance is NOT supported (only entity-level `rdfs:subClassOf`); this is
  // recorded solely so the mapper can warn and drop it. Empty when none.
  subPropertyOf: string[];
}

/**
 * An `owl:ObjectProperty` -- becomes a relationship (edge) between two
 * classes.
 */
export interface OwlObjectProperty {
  localName: string;
  // Local names of the rdfs:domain (edge source) and rdfs:range (edge
  // destination) classes. Undefined when not declared (skipped with a warning:
  // an edge needs both endpoints).
  domain?: string;
  range?: string;
  label?: string;
  comment?: string;
  synonyms: string[];
  // Local names of `rdfs:subPropertyOf` superproperties, if any. Relationship
  // inheritance is NOT supported (only entity-level `rdfs:subClassOf`); this is
  // recorded solely so the mapper can warn and drop it. Empty when none.
  subPropertyOf: string[];
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
  classes: OwlClass[];
  datatypeProperties: OwlDatatypeProperty[];
  objectProperties: OwlObjectProperty[];
}
