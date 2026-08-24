// Semantic Model IR -> OwlModel mapping: the inverse of to_ir.ts.
//
// This is the whole OSI -> OWL policy layer, the mirror of to_ir.ts. It takes a
// semantic model (as produced by the loader, or by `kcmd owl import`) and
// rebuilds the staging OwlModel (model.ts) that serialize.ts renders back to
// Turtle. Keeping it a pure IR -> OwlModel step (no string building) mirrors
// the import split -- parse.ts is mechanical, to_ir.ts holds the policy; here
// from_ir.ts holds the policy and serialize.ts is mechanical.
//
// Scope: ROUND-TRIP. The exporter reconstructs exactly what the importer can
// produce, so a model that ORIGINATED as OWL round-trips
// (OWL -> OSI -> OWL -> OSI is stable at the IR level). It reverses:
//   dataset (entity)        -> owl:Class + unbound source is dropped
//   (regenerated) field                   -> owl:DatatypeProperty on each
//   domain class relationship            -> owl:ObjectProperty, from -> to
//   field datatype          -> rdfs:range xsd:* (see XSD_FOR_TYPE)
//   primary_key             -> owl:hasKey
//   single-col unique_key   -> owl:InverseFunctionalProperty
//   extends                 -> rdfs:subClassOf
//   label / synonyms        -> rdfs:label / skos:altLabel
//   description             -> rdfs:comment
//   ai_context.examples     -> skos:example
//   model description / ai_context -> owl:Ontology header
// and re-expands the carried GOOGLE `owl:`/`rdfs:` extensions verbatim
// (rdfs:subPropertyOf, owl:inverseOf, owl:equivalentClass, the property
// characteristics, per-term annotations, ...), rebuilding a shortened
// in-namespace local name back to a full IRI via the carried `owl:baseIri`.
//
// Anything the semantic model can express that OWL cannot -- a metric, a field
// whose expression is not a bare column, an imported vendor expression, a
// bound (non-`unbound:`) source, a many-to-many association, a composite unique
// key -- has no OWL shape, so it is DROPPED with a warning rather than
// misrepresented. A model authored natively (not imported from OWL) therefore
// exports lossily; a model that came from OWL does not, because it never holds
// any of those constructs. This is the deliberate boundary of the round-trip
// scope (see the user guide's "Limitations").

import {CustomExtension, DataType, Entity, Field, Relationship, SemanticModel,} from '../../ir';

import {OwlClass, OwlCommonAnnotations, OwlDatatypeProperty, OwlModel, OwlObjectProperty, OwlOntology,} from './model';

export interface FromIrResult {
  owl: OwlModel;
  // Human-readable notes about IR content with no OWL representation (a metric,
  // a bound source, a non-column expression, ...). The caller prints these;
  // they do not fail the export.
  warnings: string[];
  // Counts of what was actually converted, mirroring to_ir.ToIrResult.stats so
  // the CLI's summary line reads the same in both directions.
  stats:
      {classes: number; datatypeProperties: number; objectProperties: number};
}

// The GOOGLE custom-extensions vendor name (see to_ir.googleOntologyExtension).
const GOOGLE_VENDOR = 'GOOGLE';

const XSD = 'http://www.w3.org/2001/XMLSchema#';

// The inverse of to_ir.XSD_DATATYPES: one CANONICAL xsd range IRI per OSI
// datatype. The import direction is many-to-one (every integer width collapses
// to Integer, float and double to Float), so this picks a single representative
// that maps back to the same OSI type -- the logical type round-trips, the
// original physical xsd width does not (it belongs to the bound source, not the
// ontology; see to_ir.XSD_DATATYPES). Opaque has no xsd range: the property is
// emitted with no rdfs:range, which the importer reads back as Opaque.
const XSD_FOR_TYPE: Partial<Record<DataType, string>> = {
  String: `${XSD}string`,
  Integer: `${XSD}integer`,
  Decimal: `${XSD}decimal`,
  Float: `${XSD}double`,
  Boolean: `${XSD}boolean`,
  Date: `${XSD}date`,
  Time: `${XSD}time`,
  DateTime: `${XSD}dateTime`,
  DateTimeTz: `${XSD}dateTimeStamp`,
};

// The `unbound:<Name>` source placeholder the importer stamps on every entity
// (see to_ir.unboundSource). An entity carrying it has no real table -- exactly
// what an ontology class is -- so it is dropped on export; the importer
// regenerates it. A DIFFERENT source means the model was bound to real tables,
// which OWL cannot express: warned, and the source is dropped.
function isUnboundSource(entity: Entity): boolean {
  return entity.dataSource === `unbound:${entity.name}`;
}

// The placeholder join column the importer stamps on an unbound relationship
// endpoint (see to_ir.TODO_BIND). Real bound columns cannot be represented in
// OWL (an object property has no join columns), so they are warned and dropped;
// the importer regenerates the placeholders from the destination's key.
const TODO_BIND = 'TODO_BIND';

// The carried-ontology facts on an IR object: the merged payloads of its GOOGLE
// custom-extension block(s), split into the OWL/RDFS facts this exporter
// re-emits (any key with a `:` -- see to_ir.googleOntologyExtension) and the
// keys it does not (e.g. `deploymentTargets`), so the caller can warn about the
// latter rather than silently dropping them.
interface CarriedTerms {
  owl: Record<string, unknown>;
  other:
      string[];  // non-ontology GOOGLE keys (unprefixed), reported not emitted
}

function carriedTerms(exts: CustomExtension[]|undefined): CarriedTerms {
  const owl: Record<string, unknown> = {};
  const other: string[] = [];
  for (const ext of exts ?? []) {
    if (ext.vendorName !== GOOGLE_VENDOR) {
      // A non-GOOGLE vendor block is not something the OWL importer produces;
      // report it so its loss is visible.
      other.push(`${ext.vendorName} (vendor extension)`);
      continue;
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(ext.data) as Record<string, unknown>;
    } catch {
      other.push('GOOGLE (unparseable data)');
      continue;
    }
    for (const [key, value] of Object.entries(payload)) {
      // A prefixed key (`owl:`/`rdfs:`) is a carried ontology fact; an
      // unprefixed one (e.g. `deploymentTargets`) belongs to another consumer.
      if (key.includes(':')) {
        owl[key] = value;
      } else {
        other.push(key);
      }
    }
  }
  return {owl, other};
}

// Re-expands a carried cross-reference (the inverse of to_ir.refValue): a bare
// local name was shortened because it lived in this ontology's own namespace,
// so rebuild the full IRI as `<baseIri><localName>`; a value that already
// carries a scheme is a full (cross-namespace) IRI and is kept verbatim.
// Serialize renders the result; the importer then re-shortens the in-namespace
// one back to the same local name.
function expandRef(value: string, baseIri: string|undefined): string {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return value;  // already an IRI
  return baseIri !== undefined ? `${baseIri}${value}` : value;
}

// Re-expands every value of a carried cross-reference list. Returns [] when the
// key is absent or not an array (a malformed carried block is treated as empty
// rather than throwing on a hand-edited model).
function expandRefs(value: unknown, baseIri: string|undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(v => expandRef(String(v), baseIri));
}

// A carried single-value cross-reference (owl:inverseOf carries one IRI, not a
// list; see to_ir). Returns [] when absent.
function expandRefSingle(value: unknown, baseIri: string|undefined): string[] {
  return typeof value === 'string' ? [expandRef(value, baseIri)] : [];
}

// The per-term carried annotations (rdfs:seeAlso / isDefinedBy, owl:deprecated
// / owl:versionInfo) shared by classes and both property kinds -- the inverse
// of to_ir.commonTerms. seeAlso values are kept in the N-Triples object form
// the importer stored them in (an IRI as `<iri>`, a literal as `"text"...`),
// which is already a valid Turtle object; isDefinedBy values are bare IRIs.
function commonAnnotations(terms: Record<string, unknown>):
    OwlCommonAnnotations {
  return {
    seeAlso: asStringArray(terms['rdfs:seeAlso']),
    isDefinedBy: asStringArray(terms['rdfs:isDefinedBy']),
    deprecated: terms['owl:deprecated'] === true,
    versionInfo: typeof terms['owl:versionInfo'] === 'string' ?
        terms['owl:versionInfo'] as string :
        undefined,
  };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

// Orders the distinct field names into one global sequence that respects every
// entity's field order, so that re-importing (which appends each datatype
// property to its domains in this one order) reproduces each entity's field
// order exactly. `mustFollow` holds the consecutive-field constraints (each
// entity's order as a chain); this is a stable topological sort (Kahn's
// algorithm) that breaks ties by first appearance, so a single-domain model
// keeps its natural order and a multi-domain field lands after all its
// predecessors on every entity. If the constraints contain a cycle -- entities
// disagree on a shared field's relative order, which an OWL-imported model
// never does -- the unresolved names are appended in first-appearance order and
// a warning is emitted.
function orderFields(
    firstSeen: string[], mustFollow: Map<string, Set<string>>,
    warnings: string[]): string[] {
  const rank = new Map(firstSeen.map((name, i) => [name, i]));
  const indegree = new Map<string, number>(firstSeen.map(name => [name, 0]));
  for (const succs of mustFollow.values()) {
    for (const after of succs) {
      indegree.set(after, (indegree.get(after) ?? 0) + 1);
    }
  }
  const ready = firstSeen.filter(name => indegree.get(name) === 0);
  const ordered: string[] = [];
  const placed = new Set<string>();
  while (ready.length) {
    // Among the currently unblocked fields, take the earliest-seen one, so the
    // output is deterministic and matches the natural order when unconstrained.
    ready.sort((a, b) => rank.get(a)! - rank.get(b)!);
    const name = ready.shift()!;
    ordered.push(name);
    placed.add(name);
    for (const after of mustFollow.get(name) ?? []) {
      const remaining = indegree.get(after)! - 1;
      indegree.set(after, remaining);
      if (remaining === 0) ready.push(after);
    }
  }
  if (ordered.length !== firstSeen.length) {
    const stuck = firstSeen.filter(name => !placed.has(name));
    warnings.push(
        `fields ${
            stuck.map(s => `'${s}'`)
                .join(', ')} appear in a different relative ` +
        `order on different entities; OWL uses a single property-declaration ` +
        `order, so their cross-entity ordering may shift on re-import.`);
    ordered.push(...stuck);
  }
  return ordered;
}

/**
 * Maps a Semantic Model IR back to an OwlModel (see ../../ir.ts and model.ts).
 *
 * The result serializes, via serialize.ts, to a Turtle ontology that the OWL
 * importer reads back into an equivalent IR. Constructs OWL cannot express are
 * dropped with a warning (see the file header).
 */
export function irToOwl(model: SemanticModel): FromIrResult {
  const warnings: string[] = [];

  // Model-level carriage: the base IRI (used to rebuild shortened in-namespace
  // references) and any non-ontology GOOGLE keys (e.g. deployment targets),
  // which have no OWL home.
  const modelTerms = carriedTerms(model.customExtensions);
  const baseIri = typeof modelTerms.owl['owl:baseIri'] === 'string' ?
      modelTerms.owl['owl:baseIri'] as string :
      undefined;
  for (const key of modelTerms.other) {
    warnings.push(
        `model '${model.name}' carries a GOOGLE '${
            key}' extension, which has ` +
        `no OWL representation; it is not exported.`);
  }
  if (model.metrics?.length) {
    warnings.push(
        `model '${model.name}' has ${
            model.metrics.length} metric(s); OWL has ` +
        `no metric concept, so they are not exported.`);
  }

  const entityNames = new Set(model.entities.map(e => e.name));

  // Classes, one per entity, in entity order (mirrors the importer, which keeps
  // class-declaration order). Also collect, per entity, the single-column
  // unique keys so a datatype property can be typed
  // owl:InverseFunctionalProperty.
  const classes: OwlClass[] = [];
  const singleColUniqueByEntity = new Map<string, Set<string>>();
  for (const entity of model.entities) {
    if (!isUnboundSource(entity) && !entity.abstract) {
      warnings.push(
          `entity '${entity.name}' is bound to source '${
              entity.dataSource}'; ` +
          `OWL has no source concept, so the binding is not exported (the class ` +
          `itself is).`);
    }
    if (entity.abstract) {
      warnings.push(
          `entity '${entity.name}' is abstract; OWL has no abstract-class ` +
          `marker, so it is exported as a plain owl:Class.`);
    }

    const uniqueCols = new Set<string>();
    for (const uk of entity.uniqueKeys ?? []) {
      if (uk.length === 1) {
        uniqueCols.add(uk[0]);
      } else {
        warnings.push(
            `entity '${entity.name}' has a composite unique key (${
                uk.join(', ')}); OWL owl:InverseFunctionalProperty is ` +
            `single-column, so it is not exported.`);
      }
    }
    singleColUniqueByEntity.set(entity.name, uniqueCols);

    const terms = carriedTerms(entity.customExtensions);
    for (const key of terms.other) {
      warnings.push(`entity '${entity.name}' carries an unrecognized GOOGLE '${
          key}' extension; it is not exported.`);
    }

    classes.push({
      localName: entity.name,
      // The label slot is consumed into synonyms on import (a class has no OSI
      // label), so emit all alternate names as synonyms and leave label unset.
      label: undefined,
      comment: entity.description,
      synonyms: entity.aiContext?.synonyms ?? [],
      examples: entity.aiContext?.examples ?? [],
      keys: entity.keys ?? [],
      subClassOf: entity.extends ?? [],
                                 equivalentClass: expandRefs(
                                     terms.owl['owl:equivalentClass'], baseIri),
                                 disjointWith: expandRefs(
                                     terms.owl['owl:disjointWith'], baseIri),
                                 ...commonAnnotations(terms.owl),
    });
  }

  // Datatype properties, one per distinct field name across all entities. A
  // field that appears on several entities (same name, same definition) is one
  // multi-domain property, mirroring the importer, which adds the same property
  // to each domain. The properties are emitted in a single global order that is
  // a linear extension of every entity's field order (a topological merge over
  // the consecutive-field constraints), so re-importing -- which appends each
  // property to its domains in that one order -- reproduces each entity's field
  // order exactly. A model whose entities disagree on the relative order of a
  // shared field has no single OWL order; those fields are appended with a
  // warning (see orderFields).
  const datatypeByName = new Map<string, OwlDatatypeProperty>();
  const firstSeen: string[] = [];  // field names, by first appearance
  const mustFollow = new Map<string, Set<string>>();  // name -> names after it
  const addEdge = (before: string, after: string) => {
    if (before === after) return;
    let succs = mustFollow.get(before);
    if (!succs) {
      succs = new Set<string>();
      mustFollow.set(before, succs);
    }
    succs.add(after);
  };
  for (const entity of model.entities) {
    const fields = entity.fields ?? [];
    fields.forEach((field, i) => {
      if (i > 0) addEdge(fields[i - 1].name, field.name);
      const existing = datatypeByName.get(field.name);
      if (existing) {
        // Multi-domain: extend the domain list (entity order preserved). The
        // importer builds one property and attaches it to each domain, so the
        // definitions are assumed identical.
        existing.domains.push(entity.name);
        return;
      }
      checkFieldRepresentable(field, entity.name, warnings);
      const terms = carriedTerms(field.customExtensions);
      for (const key of terms.other) {
        warnings.push(
            `field '${entity.name}.${field.name}' carries an unrecognized ` +
            `GOOGLE '${key}' extension; it is not exported.`);
      }
      datatypeByName.set(field.name, {
        localName: field.name,
        domains: [entity.name],
        rangeIri: field.type ? XSD_FOR_TYPE[field.type] : undefined,
        // The datatype property owns the OSI label slot, so emit it as the
        // primary rdfs:label; synonyms follow as skos:altLabel.
        label: field.label,
        comment: field.description,
        synonyms: field.aiContext?.synonyms ?? [],
        examples: field.aiContext?.examples ?? [],
        inverseFunctional:
            singleColUniqueByEntity.get(entity.name)?.has(field.name) ?? false,
        functional: terms.owl['owl:FunctionalProperty'] === true,
        subPropertyOf: expandRefs(terms.owl['rdfs:subPropertyOf'], baseIri),
        equivalentProperty:
            expandRefs(terms.owl['owl:equivalentProperty'], baseIri),
        propertyDisjointWith:
            expandRefs(terms.owl['owl:propertyDisjointWith'], baseIri),
        ...commonAnnotations(terms.owl),
      });
      firstSeen.push(field.name);
    });
  }
  const datatypeProperties = orderFields(firstSeen, mustFollow, warnings)
                                 .map(name => datatypeByName.get(name)!);

  // Object properties, one per relationship, in relationship order.
  const objectProperties: OwlObjectProperty[] = [];
  for (const rel of model.relationships ?? []) {
    checkRelationshipRepresentable(rel, entityNames, warnings);
    const terms = carriedTerms(rel.customExtensions);
    for (const key of terms.other) {
      warnings.push(
          `relationship '${rel.name}' carries an unrecognized GOOGLE '${
              key}' extension; it is not exported.`);
    }
    objectProperties.push({
      localName: rel.name,
      domains: [rel.source.entity],
      ranges: [rel.destination.entity],
      // A relationship has no OSI label; its comment rides in
      // ai_context.instructions (see to_ir.relationshipAiContext).
      label: undefined,
      comment: rel.aiContext?.instructions ?? rel.description,
      synonyms: rel.aiContext?.synonyms ?? [],
      examples: rel.aiContext?.examples ?? [],
      subPropertyOf: expandRefs(terms.owl['rdfs:subPropertyOf'], baseIri),
      inverseOf: expandRefSingle(terms.owl['owl:inverseOf'], baseIri),
      equivalentProperty:
          expandRefs(terms.owl['owl:equivalentProperty'], baseIri),
      propertyDisjointWith:
          expandRefs(terms.owl['owl:propertyDisjointWith'], baseIri),
      symmetric: terms.owl['owl:SymmetricProperty'] === true,
      transitive: terms.owl['owl:TransitiveProperty'] === true,
      functional: terms.owl['owl:FunctionalProperty'] === true,
      reflexive: terms.owl['owl:ReflexiveProperty'] === true,
      irreflexive: terms.owl['owl:IrreflexiveProperty'] === true,
      asymmetric: terms.owl['owl:AsymmetricProperty'] === true,
      ...commonAnnotations(terms.owl),
    });
  }

  const owl: OwlModel = {
    baseIri,
    ontology: ontologyHeader(model),
    classes,
    datatypeProperties,
    objectProperties,
  };

  return {
    owl,
    warnings,
    stats: {
      classes: classes.length,
      datatypeProperties: datatypeProperties.length,
      objectProperties: objectProperties.length,
    },
  };
}

// The ontology header, rebuilt from the model's description and ai_context. The
// importer folds the header's description (and any version suffix) into the
// model `description` and its labels/examples into the model `ai_context`, so
// we route them straight back: description -> rdfs:comment, synonyms -> labels,
// examples -> skos:example. The version is left inside the description prose
// (the importer appended it there as `(ontology version X)`), not re-split into
// owl:versionInfo -- re-importing the prose reproduces the same description.
// Returns undefined when the model carries none of these, so no empty header is
// emitted.
function ontologyHeader(model: SemanticModel): OwlOntology|undefined {
  const synonyms = model.aiContext?.synonyms ?? [];
  const examples = model.aiContext?.examples ?? [];
  if (!model.description && !synonyms.length && !examples.length) {
    return undefined;
  }
  return {
    comment: model.description,
    synonyms,
    examples,
    version: undefined,
  };
}

// Warns about a field whose semantics OWL cannot carry. A datatype property is
// just a name + range in OWL, so a real SQL expression, an imported vendor
// expression, or a non-temporal / negative dimension flag is dropped (the
// property name and datatype are still exported).
function checkFieldRepresentable(
    field: Field, entityName: string, warnings: string[]): void {
  const where = `field '${entityName}.${field.name}'`;
  if (field.expression !== undefined && field.expression !== field.name) {
    warnings.push(
        `${where} has expression '${field.expression}', which is not a plain ` +
        `column; OWL has no expression concept, so only the property name is ` +
        `exported.`);
  }
  if (field.importedExpression !== undefined) {
    warnings.push(
        `${where} has an imported vendor expression, which OWL cannot carry; ` +
        `it is not exported.`);
  }
}

// Warns about a relationship whose semantics OWL cannot carry. An object
// property is just domain -> range in OWL, so a junction-table association, an
// endpoint outside the model, or real (bound) join columns are dropped; the
// importer regenerates the placeholder columns from the destination key.
function checkRelationshipRepresentable(
    rel: Relationship, entityNames: Set<string>, warnings: string[]): void {
  if (rel.association) {
    warnings.push(
        `relationship '${rel.name}' is a many-to-many association (junction ` +
        `table '${
            rel.association.dataSource}'); OWL has no junction concept, ` +
        `so only its domain -> range direction is exported.`);
  }
  if (!entityNames.has(rel.source.entity) ||
      !entityNames.has(rel.destination.entity)) {
    warnings.push(
        `relationship '${rel.name}' references an endpoint that is not an ` +
        `entity in this model; the object property is exported but its ` +
        `domain/range will dangle.`);
  }
  const bound = [...rel.source.columns, ...rel.destination.columns].some(
      c => c !== TODO_BIND && !isDestKeyColumn(c, rel, entityNames));
  if (bound) {
    warnings.push(
        `relationship '${rel.name}' has bound join columns; OWL object ` +
        `properties carry no join columns, so they are not exported.`);
  }
}

// True when a column is one the importer would regenerate on its own (the
// destination entity's key), so it is not a "bound" column worth warning about.
function isDestKeyColumn(
    column: string, rel: Relationship, entityNames: Set<string>): boolean {
  // The importer sets the destination columns to the destination entity's key
  // and pads the source with TODO_BIND; a column equal to a destination key is
  // therefore regenerated, not authored. We accept it without the model's
  // entity list to keep this local; a false negative only produces an extra
  // warning.
  return rel.destination.columns.includes(column);
}
