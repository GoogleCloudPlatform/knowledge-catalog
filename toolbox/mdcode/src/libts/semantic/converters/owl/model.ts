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
// (owl:oneOf), property chains (owl:propertyChainAxiom), and the set-level
// axioms that hang off an anonymous node rather than a named term
// (owl:AllDisjointClasses, owl:AllDisjointProperties, owl:AllDifferent -> the
// model). A carried cross-reference keeps the FULL referent IRI; the mapper
// shortens it to a local name only when it lives in this ontology's own
// namespace (see to_ir.refValue). Property restrictions (owl:Restriction
// reached through rdfs:subClassOf / owl:equivalentClass) are staged as
// OwlRestriction for the mapper's constraint derivation (constraints.ts).
// Richer OWL still absent (SHACL, class expressions, individuals); see the
// "What is not covered yet" note in the guide.

/**
 * Per-term annotations parsed from any class or property -- links to
 * related/defining resources and lifecycle metadata. None has a native OSI
 * home, and the importer is import-only, so none is carried into the model:
 * they are dropped (the earlier custom-extension carriage was removed). Shared
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
  // The kcmd constraint-policy annotations (kcmd:severity / kcmd:onViolation)
  // asserted on this term, if any. They set the severity and violation handling
  // of the constraints the mapper derives from axioms about the term (see
  // OwlConstraintPolicy). Undefined when the term carries neither.
  constraintPolicy?: OwlConstraintPolicy;
}

/**
 * How a constraint derived from an OWL axiom is enforced, read from the kcmd
 * annotation vocabulary (`kcmd:severity`, `kcmd:onViolation`; namespace
 * KCMD_NS in parse.ts). OWL states WHAT must hold but has no notion of how
 * much a violation matters or what to do about it, so these optional
 * annotations supply the two facets a semantic-model constraint needs. Values
 * are kept as written; the mapper validates them against the constraint
 * vocabulary (severity: critical|high|medium|low; onViolation:
 * reject|escalate|warn) and warns on anything else.
 */
export interface OwlConstraintPolicy {
  severity?: string;
  onViolation?: string;
}

/**
 * One OWL property restriction a class is declared to satisfy -- an anonymous
 * `owl:Restriction` node (a blank node with `owl:onProperty`) that is the
 * object of the class's `rdfs:subClassOf` (every member satisfies it) or its
 * `owl:equivalentClass` (membership is defined by it), either bare or as a
 * conjunct of an `owl:intersectionOf` there: `C ≡ D ⊓ ∃p.X` entails
 * `C ⊑ ∃p.X`, so every member of C still satisfies the restriction. The
 * mapper turns each into a model-level constraint.
 */
export interface OwlRestriction {
  // Which axiom attached it to the class.
  via: 'subClassOf'|'equivalentClass';
  // Full IRI of the restricted property (owl:onProperty).
  property: string;
  // The restriction kind:
  //   some  -- owl:someValuesFrom   (at least one value, of the filler)
  //   all   -- owl:allValuesFrom    (every value is of the filler)
  //   value -- owl:hasValue         (has this specific value)
  //   exact -- owl:cardinality / owl:qualifiedCardinality
  //   min   -- owl:minCardinality / owl:minQualifiedCardinality
  //   max   -- owl:maxCardinality / owl:maxQualifiedCardinality
  kind: 'some'|'all'|'value'|'exact'|'min'|'max';
  // The count, for exact/min/max.
  cardinality?: number;
  // Full IRI of the filler class or datatype: someValuesFrom / allValuesFrom,
  // or owl:onClass / owl:onDataRange for a qualified cardinality. Undefined for
  // an unqualified cardinality or hasValue.
  filler?: string;
  // True when the filler is an anonymous class expression (a blank node) --
  // not a named class, so the mapper cannot name it and skips the restriction
  // with a warning.
  anonymousFiller?: boolean;
  // The owl:hasValue value: a literal's lexical form, or an IRI's local name.
  value?: string;
  // True for the qualified cardinality forms (owl:onClass / owl:onDataRange).
  qualified: boolean;
  // rdfs:comment on the restriction node, if any -> the constraint's
  // description.
  comment?: string;
  // kcmd policy annotations on the restriction node itself (highest
  // precedence; see to_ir).
  policy?: OwlConstraintPolicy;
  // Local names of the NAMED classes conjoined with this restriction when it
  // sits inside an `owl:intersectionOf` (e.g. `Engagement` in
  // `Engagement ⊓ ∃hasHealthCheck.QAHealthCheck`). Provenance only -- the
  // constraint text quotes the whole axiom; the named conjuncts themselves
  // also feed the class's `subClassOf` (C ≡ D ⊓ … entails C ⊑ D).
  intersectedWith?: string[];
}

/**
 * One `owl:AllDisjointClasses` axiom with what the mapper needs to turn it into
 * a constraint: the member class IRIs plus any rdfs:comment / kcmd policy
 * annotations asserted on the axiom node.
 */
export interface OwlDisjointClassesAxiom {
  members: string[];
  comment?: string;
  policy?: OwlConstraintPolicy;
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
  // The property restrictions the class is declared to satisfy (blank-node
  // `owl:Restriction` objects of rdfs:subClassOf, or a bare restriction as the
  // object of owl:equivalentClass), in document order. The mapper turns each
  // into a model-level constraint. Empty when none.
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
  // Referent IRIs of `rdfs:subPropertyOf` superproperties, if any. Mapped to
  // the relationship's native `extends` (relationship inheritance) when the
  // superproperty is itself an object property of the ontology; see
  // to_ir.ts. Full IRIs. Empty when none.
  subPropertyOf: string[];
  // Referent IRIs of `owl:inverseOf` properties (the edge read the other way),
  // in document order. The mapper folds an inverse pair into ONE relationship
  // carrying `inverse:` (see planInverseFolds in to_ir.ts). Usually one; more
  // than one is reconciled by the mapper (first wins, rest warned). Full IRIs
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
  // The same owl:AllDisjointClasses axioms, each with the rdfs:comment and kcmd
  // policy annotations on its axiom node, for the mapper's constraint
  // derivation. Parallel to allDisjointClasses (same axioms, same order).
  allDisjointClassesAxioms: OwlDisjointClassesAxiom[];
  // owl:AllDisjointProperties -- the listed properties are pairwise disjoint.
  allDisjointProperties: string[][];
  // owl:AllDifferent -- the listed individuals are pairwise distinct. Members
  // are individuals (which the converter does not model), so only the names are
  // kept, exactly like owl:oneOf. Both the OWL 2 `owl:members` and the legacy
  // OWL 1 `owl:distinctMembers` spelling of the list are accepted.
  allDifferent: string[][];
}
