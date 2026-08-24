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
// constructs with no native home that ride along verbatim as custom extensions:
// property inheritance (rdfs:subPropertyOf), inverse/equivalence/disjointness
// cross-references (owl:inverseOf, owl:equivalentClass, owl:disjointWith,
// owl:equivalentProperty, owl:propertyDisjointWith), the full set of property
// characteristics (symmetric / transitive / functional / reflexive /
// irreflexive / asymmetric), per-term annotations (rdfs:seeAlso,
// rdfs:isDefinedBy, owl:deprecated, owl:versionInfo), enumerations
// (owl:oneOf), property chains (owl:propertyChainAxiom), the set-level
// axioms that hang off an anonymous node rather than a named term
// (owl:AllDisjointClasses, owl:AllDisjointProperties, owl:AllDifferent -> the
// model), and the UNqualified cardinality restrictions on an anonymous
// owl:Restriction reached through rdfs:subClassOf (owl:cardinality /
// owl:minCardinality / owl:maxCardinality -> the class). A carried
// cross-reference keeps the FULL referent IRI; the mapper shortens it to a
// local name only when it lives in this ontology's own namespace (see
// to_ir.refValue). Richer OWL still absent (SHACL, QUALIFIED cardinality
// restrictions, individuals); see the "What is not covered yet" note in the
// guide.

/**
 * Per-term annotations carried verbatim on any class or property -- links to
 * related/defining resources and lifecycle metadata. None has a native OSI
 * home, so all ride along as custom extensions (see to_ir.commonTerms). Shared
 * by OwlClass, OwlDatatypeProperty, and OwlObjectProperty.
 */
export interface OwlCommonAnnotations {
  // rdfs:seeAlso values, in document order, as N-Triples object terms so an
  // IRI stays distinguishable from a literal on round-trip: an IRI as `<iri>`,
  // a literal as `"text"` with any language tag (`@en`) or datatype (`^^<iri>`)
  // preserved (see parse.ntriplesLiteral). External pointers to further
  // information; never shortened (an IRI points outside the model). Empty when
  // none.
  seeAlso: string[];
  // rdfs:isDefinedBy IRIs, in document order. Points at the resource (usually
  // the defining ontology) that defines this term; kept verbatim. Empty when
  // none.
  isDefinedBy: string[];
  // True when the term is marked owl:deprecated.
  deprecated: boolean;
  // owl:versionInfo on the term itself (not the ontology header), if present.
  versionInfo?: string;
}

/**
 * An UNqualified cardinality restriction on a class -- an anonymous
 * `owl:Restriction` reached through `rdfs:subClassOf`, constraining how many
 * values of one property an instance of the class may have.
 *
 * No native OSI home (OSI has no cardinality concept), so it is carried
 * verbatim as a custom extension on the entity. Only the UNqualified forms are
 * read; the qualified forms (`owl:qualifiedCardinality` and friends, which add
 * `owl:onClass` / `owl:onDataRange`) are a separate blank-node shape, out of
 * scope for now (see the user guide's "not read yet" note). A restriction with
 * no cardinality (e.g. an `owl:someValuesFrom` value restriction) contributes
 * no OwlRestriction -- only the cardinality shape is carried.
 */
export interface OwlRestriction {
  // The restricted property's referent IRI (`owl:onProperty`). Full IRI -- the
  // mapper shortens an in-namespace one to its local name (see to_ir.refValue).
  onProperty: string;
  // `owl:cardinality` -- the exact number of values. Undefined when not stated.
  cardinality?: number;
  // `owl:minCardinality` -- the minimum number of values. Undefined when not
  // stated.
  minCardinality?: number;
  // `owl:maxCardinality` -- the maximum number of values. Undefined when not
  // stated.
  maxCardinality?: number;
}

/** An `owl:Class` -- becomes an OSI dataset (entity). */
export interface OwlClass extends OwlCommonAnnotations {
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
  // Referent IRIs of `owl:equivalentClass` classes, in document order. No
  // native OSI home (a class is one entity; equivalence is a fact ABOUT it, not
  // a structural link), so it is carried verbatim as a custom extension. Named
  // classes only; a blank-node class expression (owl:intersectionOf, ...) is
  // not recorded (out of scope, Tier 3). Full IRIs -- the mapper shortens an
  // in-namespace one to its local name. Empty when none.
  equivalentClass: string[];
  // Referent IRIs of `owl:disjointWith` classes, in document order. No native
  // OSI home; carried verbatim. Named classes only (a blank-node class
  // expression is out of scope). Full IRIs (see equivalentClass). Empty when
  // none.
  disjointWith: string[];
  // Referent IRIs of the members of an `owl:oneOf` enumeration (the class is
  // defined by listing its members). An enumeration is an unordered SET, so the
  // members are deduped and -- in the non-standard case of a class carrying
  // more than one oneOf axiom -- unioned; unlike a property chain, neither
  // order nor repetition is meaningful. No native OSI home -- the members are
  // usually individuals, which the converter does not model -- so the
  // enumeration is carried verbatim as a custom extension, keeping the member
  // names. Full IRIs
  // -- the mapper shortens an in-namespace one to its local name. Empty when
  // the class is not an enumeration.
  oneOf: string[];
  // Unqualified cardinality restrictions on this class, in document order --
  // each an anonymous `owl:Restriction` reached through `rdfs:subClassOf` (see
  // OwlRestriction). No native OSI home; carried verbatim on the entity. Empty
  // when the class declares none.
  restrictions: OwlRestriction[];
}

/**
 * An `owl:DatatypeProperty` -- becomes a field on its domain class's dataset.
 */
export interface OwlDatatypeProperty extends OwlCommonAnnotations {
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
  // Referent IRIs of `rdfs:subPropertyOf` superproperties, if any. Property
  // inheritance has no native OSI home (only entity-level `rdfs:subClassOf` ->
  // `extends`); it is carried verbatim as a field custom extension. Full IRIs
  // -- the mapper shortens an in-namespace one to its local name. Empty when
  // none.
  subPropertyOf: string[];
  // Referent IRIs of `owl:equivalentProperty` properties, in document order. No
  // native OSI home; carried verbatim. Named properties only. Full IRIs (see
  // subPropertyOf). Empty when none.
  equivalentProperty: string[];
  // Referent IRIs of `owl:propertyDisjointWith` properties, in document order.
  // No native OSI home; carried verbatim. Named properties only. Full IRIs.
  // Empty when none.
  propertyDisjointWith: string[];
}

/**
 * An `owl:ObjectProperty` -- becomes a relationship (edge) between two
 * classes.
 */
export interface OwlObjectProperty extends OwlCommonAnnotations {
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
  // Referent IRIs of `rdfs:subPropertyOf` superproperties, if any. Relationship
  // inheritance has no native OSI home (only entity-level `rdfs:subClassOf` ->
  // `extends`); it is carried verbatim as a relationship custom extension. Full
  // IRIs -- the mapper shortens an in-namespace one to its local name. Empty
  // when none.
  subPropertyOf: string[];
  // Referent IRIs of `owl:inverseOf` properties (the edge read the other way),
  // in document order. No native OSI home (an edge is directed; the inverse is
  // a separate fact), so it is carried verbatim. Usually one; more than one is
  // kept here and reconciled by the mapper (first wins, rest warned). Full IRIs
  // (see subPropertyOf). Empty when none.
  inverseOf: string[];
  // Referent IRIs of `owl:equivalentProperty` properties, in document order. No
  // native OSI home; carried verbatim. Named properties only. Full IRIs. Empty
  // when none.
  equivalentProperty: string[];
  // Referent IRIs of `owl:propertyDisjointWith` properties, in document order.
  // No native OSI home; carried verbatim. Named properties only. Full IRIs.
  // Empty when none.
  propertyDisjointWith: string[];
  // One entry per `owl:propertyChainAxiom` on this property, each the ordered
  // list of properties it composes (e.g. hasParent then hasBrother ==
  // hasUncle). OWL 2 allows a property to carry MORE THAN ONE chain axiom (e.g.
  // uncleOf as fatherOf/brotherOf and as motherOf/brotherOf), so the chains are
  // kept separate -- flattening them into one list would fuse the axiom
  // boundaries and be indistinguishable from a single longer chain. No native
  // OSI home, so each is carried verbatim. Within a chain, order is significant
  // AND repetition is meaningful (a chain may name the same property twice,
  // e.g. hasParent/hasParent for a grandparent), so it is neither reordered nor
  // deduped. Full IRIs -- the mapper shortens an in-namespace one to its local
  // name. Empty when the property is not a chain.
  propertyChain: string[][];
  // owl:SymmetricProperty -- the edge holds both ways (`a rel b` implies
  // `b rel a`). Carried verbatim; no native OSI home.
  symmetric: boolean;
  // owl:TransitiveProperty -- the edge chains (`a rel b` and `b rel c` imply
  // `a rel c`). Carried verbatim; no native OSI home.
  transitive: boolean;
  // owl:FunctionalProperty -- at most one destination per source. Carried
  // verbatim; no native OSI home.
  functional: boolean;
  // owl:ReflexiveProperty -- every subject relates to itself (`a rel a`).
  // Carried verbatim; no native OSI home.
  reflexive: boolean;
  // owl:IrreflexiveProperty -- no subject relates to itself. Carried verbatim;
  // no native OSI home.
  irreflexive: boolean;
  // owl:AsymmetricProperty -- `a rel b` rules out `b rel a`. Carried verbatim;
  // no native OSI home.
  asymmetric: boolean;
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
  // The ontology's base namespace IRI: the namespace shared by MOST of its
  // typed terms (see parse.dominantNamespace), falling back to the ontology
  // header IRI. Used two ways: as provenance in the model description, and --
  // when a cross-reference is shortened to an in-namespace local name --
  // carried structurally as `owl:baseIri` on the model so that shortening is
  // reversible (a localName rebuilds as `<baseIri><localName>`; see
  // to_ir.refValue). Term IRIs themselves are otherwise dropped -- see the user
  // guide.
  baseIri?: string;
  // The ontology-header metadata (owl:Ontology node), if the document has one.
  ontology?: OwlOntology;
  classes: OwlClass[];
  datatypeProperties: OwlDatatypeProperty[];
  objectProperties: OwlObjectProperty[];
  // Set-level axioms carried at the MODEL level (unlike every other carried
  // construct, these are asserted on an anonymous node and are ABOUT a set of
  // terms, not any one named class/property, so they have no entity/field/
  // relationship to ride on). Each is a list of axioms, and each axiom is the
  // set of member referent IRIs named by its `owl:members` list -- a set, so
  // the mapper dedupes and order is not significant (contrast propertyChain).
  // Full IRIs; the mapper shortens an in-namespace one. Empty when none.
  //
  // owl:AllDisjointClasses -- the listed classes are pairwise disjoint.
  allDisjointClasses: string[][];
  // owl:AllDisjointProperties -- the listed properties are pairwise disjoint.
  allDisjointProperties: string[][];
  // owl:AllDifferent -- the listed individuals are pairwise distinct. Members
  // are individuals (which the converter does not model), so only the names are
  // kept, exactly like owl:oneOf. Both the OWL 2 `owl:members` and the legacy
  // OWL 1 `owl:distinctMembers` spelling of the list are accepted.
  allDifferent: string[][];
}
