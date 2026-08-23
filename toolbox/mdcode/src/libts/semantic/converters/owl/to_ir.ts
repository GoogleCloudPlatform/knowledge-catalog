// OwlModel -> Semantic Model IR mapping.
//
// This is the whole OWL -> OSI policy layer. The parser (parse.ts) is
// mechanical; every decision about how an ontology becomes a semantic model
// lives here, in one place, so the mapping is easy to read and to evolve.
//
// The mapping (see the user guide's table). Each line is one construct, kept
// short so a comment reflow cannot run the columns together:
//   owl:Class                     -> dataset (entity) + unbound source
//   owl:DatatypeProperty          -> field on each domain class's dataset
//   owl:ObjectProperty            -> relationship (edge), domain -> range
//   rdfs:range xsd:*              -> field datatype (see XSD_DATATYPES)
//   owl:hasKey                    -> dataset primary_key
//   owl:InverseFunctionalProperty -> dataset unique_keys (or primary_key)
//   rdfs:subClassOf               -> dataset extends (entity inheritance)
//   rdfs:label                    -> field label / synonym (no label slot)
//   rdfs:comment/skos:definition/dcterms:/dc: -> description
//   skos:example                  -> ai_context.examples
//   owl:Ontology header           -> model description / ai_context
//
// Constructs with no native OSI home ride along verbatim in a GOOGLE custom
// extension (see googleOntologyExtension). It is inert on push (the BigQuery /
// KC legs read none of it) and preserved across the OSI document round-trip
// (loader + osi_converter keep custom_extensions verbatim); it is NOT yet
// persisted to Knowledge Catalog, so a KC pull does not recover it today.
// Each line is kept short so a comment reflow cannot run the columns together:
//   rdfs:subPropertyOf -> field / relationship (property inheritance)
//   owl:inverseOf -> relationship (the edge, reversed)
//   owl:equivalentClass -> entity (class equivalence)
//   owl:disjointWith -> entity (class disjointness)
//   owl:equivalentProperty -> field / relationship
//   owl:propertyDisjointWith -> field / relationship
//   property characteristics -> relationship (symmetric, transitive, ...)
//   rdfs:seeAlso, rdfs:isDefinedBy -> any (external pointers, verbatim)
//   owl:deprecated, owl:versionInfo -> any (lifecycle metadata)
//
// A carried cross-reference keeps the full referent IRI unless it is in this
// ontology's own namespace, when it shortens to a local name (see refValue).
//
// The result is UNBOUND: entities carry an `unbound:<Name>` source placeholder
// and relationships carry `TODO_BIND` join columns, because an ontology has no
// physical tables. A declared key sharpens this -- an edge into a class with a
// key binds its destination columns to that key, leaving only the source
// foreign-key columns to fill. The model loads and pushes to Knowledge Catalog
// as-is; binding real sources/columns is a manual follow-up before a BigQuery
// push (see the user guide, "Going from ontology to a running graph").

import {AiContext, CustomExtension, Entity, Field, Relationship, SemanticModel,} from '../../ir';

import {OwlCommonAnnotations, OwlModel, OwlOntology} from './model';
import {localName, namespace} from './parse';

export interface ToIrResult {
  model: SemanticModel;
  // Human-readable notes about OWL content that could not be mapped (e.g. a
  // property with no domain). The caller prints these; they do not fail the
  // conversion.
  warnings: string[];
  // Counts of what was actually converted (not the source-triple counts): a
  // skipped class/property is excluded, and a multi-domain datatype property
  // still counts once. The CLI reports these, so "converted N ..." is honest
  // even when some elements were warned and skipped.
  stats:
      {classes: number; datatypeProperties: number; objectProperties: number};
}

// --- Seams: the isolated change-points for later work. ----------------------

// The GOOGLE custom-extensions vendor name. OWL constructs OSI can't express
// natively (rdfs:subPropertyOf, owl:inverseOf, owl:equivalentClass, property
// characteristics) ride in this vendor's block -- Google's choice to support
// OWL, so it sits in the GOOGLE block alongside deployment targets, not a new
// "OWL" vendor. See deploy_bigquery.googleDeploymentTargets, which safely
// ignores a GOOGLE block that carries no deploymentTargets.
const GOOGLE_VENDOR = 'GOOGLE';

/**
 * Builds a GOOGLE custom-extension block carrying OWL constructs that have no
 * native OSI home, verbatim.
 *
 * The payload is a FLAT object whose keys ARE the source constructs, prefixed
 * with their vocabulary (`owl:inverseOf`, `rdfs:subPropertyOf`, ...): the
 * prefix carries the namespace, so the same short name from a different
 * standard can't collide and the reader always knows which vocabulary a fact
 * came from. This is the deliberate mirror of the deployment-target block,
 * whose own keys are Google's (`deploymentTargets`, unprefixed) -- the two
 * kinds of key coexist in one GOOGLE block without clashing, and a consumer
 * reads "any key with a `:`" as a carried ontology fact.
 *
 * The values mirror the construct faithfully rather than inventing a shape:
 * `owl:SymmetricProperty: true` (not a synthesized `characteristics` list), the
 * raw superproperty names for `rdfs:subPropertyOf`, and so on. Carriage is
 * inert on push (the BigQuery / KC legs read none of it) and survives the OSI
 * document round-trip verbatim (loader + osi_converter preserve
 * custom_extensions); it is NOT yet persisted to / recovered from Knowledge
 * Catalog. Promoting a construct to a native OSI concept later means changing
 * this seam and its callers, nothing downstream.
 *
 * Returns undefined when `terms` is empty, so a caller can attach the result
 * unconditionally without emitting an empty block.
 */
export function googleOntologyExtension(terms: Record<string, unknown>):
    CustomExtension|undefined {
  if (!Object.keys(terms).length) return undefined;
  return {
    vendorName: GOOGLE_VENDOR,
    // Pretty-printed (2-space) so the carried block reads as a legible JSON
    // object in the serialized YAML -- the `yaml` serializer renders a
    // newline-bearing string as a block scalar -- instead of one long quoted
    // line. `data` is opaque and every consumer JSON.parses it, so the added
    // whitespace is insignificant on the wire.
    data: JSON.stringify(terms, null, 2),
  };
}

// Appends a carried-ontology GOOGLE block to an IR object (entity / field /
// relationship), leaving any existing custom extensions in place. A no-op when
// there is nothing to carry, so callers can attach unconditionally.
function attachOntology(
    target: {customExtensions?: CustomExtension[]},
    terms: Record<string, unknown>): void {
  const ext = googleOntologyExtension(terms);
  if (!ext) return;
  (target.customExtensions ??= []).push(ext);
}

// How a carried CROSS-REFERENCE IRI is rendered: shortened to its local name
// when it lives in this ontology's own namespace (an in-model reference a
// consumer resolves by name), kept as the full IRI otherwise (a cross-ontology
// reference that points outside the model). Shortening is lossless because the
// base IRI is carried as structured metadata (`owl:baseIri`) on the model
// whenever any reference is shortened, so an in-namespace localName is
// reconstructable as `<baseIri><localName>`; "when in doubt, keep the full IRI"
// falls out for free.
function refValue(iri: string, baseIri: string|undefined): string {
  return baseIri !== undefined && namespace(iri) === baseIri ? localName(iri) :
                                                               iri;
}

// The per-term carried annotations shared by entities, fields, and
// relationships (rdfs:seeAlso / isDefinedBy, owl:deprecated / versionInfo), in
// a fixed key order. seeAlso/isDefinedBy are external pointers, so they are
// kept verbatim (never shortened). Returns the entries to merge into a term's
// carried block; empty when the term has none.
function commonTerms(a: OwlCommonAnnotations): Record<string, unknown> {
  const terms: Record<string, unknown> = {};
  if (a.seeAlso.length) terms['rdfs:seeAlso'] = dedupe(a.seeAlso);
  if (a.isDefinedBy.length) terms['rdfs:isDefinedBy'] = dedupe(a.isDefinedBy);
  if (a.deprecated) terms['owl:deprecated'] = true;
  if (a.versionInfo) terms['owl:versionInfo'] = a.versionInfo;
  return terms;
}

// The placeholder source for an unbound entity: an ontology class has no
// backing table, so the entity is emitted with this sentinel until a real
// source is bound. Chosen so it is obviously not a real table reference.
function unboundSource(name: string): string {
  return `unbound:${name}`;
}

// The placeholder join column for an unbound relationship: the real foreign-key
// / key columns are unknown until sources are bound. The loader requires at
// least one column per endpoint, so a sentinel stands in until binding.
const TODO_BIND = 'TODO_BIND';

// --- Datatype mapping. ------------------------------------------------------

const XSD = 'http://www.w3.org/2001/XMLSchema#';

// The xsd:* ranges we map to an OSI datatype. Everything else falls back to
// Opaque (a valid, lossless "unknown logical type" per the IR). Kept as a table
// so adding ranges is a one-line change; the user guide documents this set.
//
// The OSI DataType vocabulary is closed (String / Integer / Decimal / Float /
// Boolean / Date / Time / DateTime / DateTimeTz / Opaque), so several xsd types
// collapse onto one OSI type (e.g. every bounded/unsigned integer -> Integer,
// float and double -> Float): the logical type is preserved, physical width is
// not (it belongs to the bound source, not the ontology).
const XSD_DATATYPES: Record<string, Field['type']> = {
  // Text.
  [`${XSD}string`]: 'String',
  [`${XSD}normalizedString`]: 'String',
  [`${XSD}token`]: 'String',
  [`${XSD}language`]: 'String',
  [`${XSD}Name`]: 'String',
  [`${XSD}NCName`]: 'String',
  [`${XSD}anyURI`]: 'String',
  // Integers (all widths / signednesses collapse to Integer).
  [`${XSD}integer`]: 'Integer',
  [`${XSD}int`]: 'Integer',
  [`${XSD}long`]: 'Integer',
  [`${XSD}short`]: 'Integer',
  [`${XSD}byte`]: 'Integer',
  [`${XSD}nonNegativeInteger`]: 'Integer',
  [`${XSD}nonPositiveInteger`]: 'Integer',
  [`${XSD}positiveInteger`]: 'Integer',
  [`${XSD}negativeInteger`]: 'Integer',
  [`${XSD}unsignedLong`]: 'Integer',
  [`${XSD}unsignedInt`]: 'Integer',
  [`${XSD}unsignedShort`]: 'Integer',
  [`${XSD}unsignedByte`]: 'Integer',
  // Exact and approximate numerics.
  [`${XSD}decimal`]: 'Decimal',
  [`${XSD}float`]: 'Float',
  [`${XSD}double`]: 'Float',
  // Boolean.
  [`${XSD}boolean`]: 'Boolean',
  // Temporal.
  [`${XSD}date`]: 'Date',
  [`${XSD}time`]: 'Time',
  [`${XSD}dateTime`]: 'DateTime',
  [`${XSD}dateTimeStamp`]: 'DateTimeTz',
};

function datatypeFor(rangeIri: string|undefined): Field['type'] {
  if (rangeIri && XSD_DATATYPES[rangeIri]) return XSD_DATATYPES[rangeIri];
  return 'Opaque';
}

// The temporal OSI datatypes. A field of one of these is a time dimension by
// OSI's own rule (see ir.isTimeDimension), so the mapper marks it with a
// dimension block; OWL itself has no dimension concept.
const TEMPORAL_TYPES: ReadonlySet<Field['type']> =
    new Set<Field['type']>(['Date', 'Time', 'DateTime', 'DateTimeTz']);

// --- Label / synonym policy. ------------------------------------------------

// True when an rdfs:label carries nothing over the term's own name -- e.g. a
// class named `Customer` labeled "Customer", or an object property `placedBy`
// labeled "placed by". Compared case-insensitively with non-alphanumerics
// stripped, so a spaced/cased human rendering of the same name is treated as
// redundant and dropped rather than duplicated as a label or synonym.
function isRedundantLabel(label: string, name: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm(label) === norm(name);
}

// Drops synonyms that merely respace/recase the term's own name -- the same
// redundancy rule the primary label gets -- so an alternate label identical to
// the name is not emitted as a synonym.
function nonRedundant(names: string[], name: string): string[] {
  return names.filter(s => !isRedundantLabel(s, name));
}

// The display label for a FIELD: the OSI `label` slot exists only on fields, so
// a datatype property's rdfs:label lands here -- unless it is redundant with
// the field name, in which case it is dropped.
function fieldLabel(label: string|undefined, name: string): string|undefined {
  if (label && !isRedundantLabel(label, name)) return label;
  return undefined;
}

// The ai_context for a term that has NO label slot (classes, relationships): a
// non-redundant rdfs:label becomes an alternate name, joined with any explicit
// synonyms (extra labels / skos labels) and examples. Returns undefined when
// there is nothing, so no empty ai_context is emitted.
function synonymAiContext(
    label: string|undefined, name: string, synonyms: string[],
    examples: string[]): AiContext|undefined {
  const names: string[] = [];
  if (label && !isRedundantLabel(label, name)) names.push(label);
  names.push(...nonRedundant(synonyms, name));
  return buildAiContext(undefined, names, examples);
}

// The ai_context for a FIELD (which already consumed its primary label into the
// `label` slot): only the explicit synonyms and examples remain. Undefined when
// empty.
function fieldAiContext(
    synonyms: string[], name: string, examples: string[]): AiContext|undefined {
  return buildAiContext(undefined, nonRedundant(synonyms, name), examples);
}

// The ai_context for a RELATIONSHIP. Unlike datasets/fields, the OSI
// relationship has no `description` slot (see the Apache OSI schema), so an
// object property's comment is carried as ai_context `instructions`, and its
// non-redundant label/synonyms/examples as the remaining fields. Undefined when
// all are empty.
function relationshipAiContext(
    label: string|undefined, name: string, synonyms: string[],
    comment: string|undefined, examples: string[]): AiContext|undefined {
  const names: string[] = [];
  if (label && !isRedundantLabel(label, name)) names.push(label);
  names.push(...nonRedundant(synonyms, name));
  return buildAiContext(comment, names, examples);
}

// The ai_context for the MODEL, from the ontology header: labels/synonyms and
// examples (the description rides in the model `description`, not here).
function ontologyAiContext(
    ontology: OwlOntology|undefined, modelName: string): AiContext|undefined {
  if (!ontology) return undefined;
  return buildAiContext(
      undefined, nonRedundant(ontology.synonyms, modelName), ontology.examples);
}

// Assembles an AiContext from its parts, deduping names/examples and dropping
// empties, and returns undefined when nothing is left -- the single place the
// {instructions, synonyms, examples} shape is built.
function buildAiContext(
    instructions: string|undefined, synonyms: string[],
    examples: string[]): AiContext|undefined {
  const ai: AiContext = {};
  if (instructions) ai.instructions = instructions;
  if (synonyms.length) ai.synonyms = dedupe(synonyms);
  if (examples.length) ai.examples = dedupe(examples);
  return ai.instructions || ai.synonyms || ai.examples ? ai : undefined;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// --- Mapping. ---------------------------------------------------------------

/**
 * Maps a parsed OwlModel to a Semantic Model IR (see ../../ir.ts).
 *
 * `modelName` names the resulting semantic model (the CLI derives it from the
 * source filename). The IR it returns serializes, via osi_converter, to the
 * OSI YAML shown in the user guide.
 */
export function owlToIr(owl: OwlModel, modelName: string): ToIrResult {
  const warnings: string[] = [];
  const classNames = new Set(owl.classes.map(c => c.localName));

  // refValue over a list, deduped, recording whether any referent was actually
  // shortened. When one was, the base IRI is carried on the model
  // (`owl:baseIri` below) so the shortened localName is mechanically
  // reconstructable. Mapping before dedupe collapses a referent stated more
  // than once (its shortened form is identical), so a repeated identical triple
  // never looks like a conflict.
  let shortenedRef = false;
  const refs = (iris: string[]): string[] => dedupe(iris.map(iri => {
    const v = refValue(iri, owl.baseIri);
    if (v !== iri) shortenedRef = true;
    return v;
  }));

  // Entities, one per class, in class-declaration order. Fields are attached in
  // datatype-property-declaration order below. Two classes can share a local
  // name (e.g. same name in different namespaces); OSI dataset names must be
  // unique, so the first wins and the rest are warned and skipped rather than
  // silently emitting a duplicate the loader would reject.
  const entitiesByName = new Map<string, Entity>();
  const entities: Entity[] = [];
  for (const c of owl.classes) {
    if (entitiesByName.has(c.localName)) {
      warnings.push(
          `class '${
              c.localName}' is declared more than once (same local name, ` +
          `possibly across namespaces); keeping the first and skipping the rest.`);
      continue;
    }
    const entity: Entity = {
      name: c.localName,
      dataSource: unboundSource(c.localName),
      keys: dedupe(c.keys),  // owl:hasKey -> primary_key (grain)
      description: c.comment,
      aiContext: synonymAiContext(c.label, c.localName, c.synonyms, c.examples),
      fields: [],
    };
    // rdfs:subClassOf -> entity-level `extends`. Recorded AS DECLARED (parent
    // local names, deduped); parents are not flattened here -- a later
    // resolution pass expands inherited fields (see ir.ts Entity.extends). A
    // parent that is not an owl:Class in this ontology (a typo, or a superclass
    // imported from another ontology) is still recorded, but warned about -- as
    // every other cross-reference here is -- so a dangling `extends` is never
    // emitted silently.
    if (c.subClassOf.length) {
      const parents = dedupe(c.subClassOf);
      entity.extends = parents;
      const unknown = parents.filter(name => !classNames.has(name));
      if (unknown.length) {
        warnings.push(
            `class '${c.localName}' declares rdfs:subClassOf a non-class ` +
            `superclass (${
                unknown.join(', ')}); the extends link is recorded ` +
            `as declared but cannot be resolved (not an owl:Class in this ` +
            `ontology).`);
      }
    }
    // OWL facts with no native OSI home, carried verbatim on the entity, in a
    // fixed key order. owl:equivalentClass / owl:disjointWith are class
    // cross-references (a class is one entity, so these are facts ABOUT it, not
    // structural links); blank-node class expressions were dropped in the
    // parser. commonTerms adds any per-term annotations (seeAlso, deprecated,
    // ...).
    const entityTerms: Record<string, unknown> = {};
    if (c.equivalentClass.length)
      entityTerms['owl:equivalentClass'] = refs(c.equivalentClass);
    if (c.disjointWith.length)
      entityTerms['owl:disjointWith'] = refs(c.disjointWith);
    Object.assign(entityTerms, commonTerms(c));
    attachOntology(entity, entityTerms);
    entitiesByName.set(c.localName, entity);
    entities.push(entity);
  }

  // Datatype properties -> fields on each domain's entity. A property with more
  // than one domain appears on each; one with none has nowhere to live.
  let datatypePropertiesConverted = 0;
  for (const p of owl.datatypeProperties) {
    if (!p.domains.length) {
      warnings.push(
          `datatype property '${p.localName}' has no rdfs:domain; skipped ` +
          `(a field must belong to a class).`);
      continue;
    }
    // OWL facts with no native OSI home, carried verbatim on the field, in a
    // fixed key order. Built once and attached to the field on each domain (the
    // facts are the property's, independent of which class it lands on). Each
    // mapping line is kept short so a comment reflow cannot mangle it:
    //   rdfs:subPropertyOf -> property inheritance (kept as a fact, no
    //     entity-style flattening)
    //   owl:equivalentProperty, owl:propertyDisjointWith -> cross-references
    //   owl:FunctionalProperty -> single-valued
    //   commonTerms adds any per-term annotations
    const fieldTerms: Record<string, unknown> = {};
    if (p.subPropertyOf.length)
      fieldTerms['rdfs:subPropertyOf'] = refs(p.subPropertyOf);
    if (p.equivalentProperty.length)
      fieldTerms['owl:equivalentProperty'] = refs(p.equivalentProperty);
    if (p.propertyDisjointWith.length)
      fieldTerms['owl:propertyDisjointWith'] = refs(p.propertyDisjointWith);
    if (p.functional) fieldTerms['owl:FunctionalProperty'] = true;
    Object.assign(fieldTerms, commonTerms(p));
    // A property counts as converted once if it produces at least one field,
    // regardless of how many domains it lands on.
    let produced = false;
    for (const domain of p.domains) {
      const entity = entitiesByName.get(domain);
      if (!entity) {
        warnings.push(
            `datatype property '${p.localName}' has domain '${domain}', ` +
            `which is not an owl:Class in this ontology; skipped.`);
        continue;
      }
      if (entity.fields.some(f => f.name === p.localName)) {
        warnings.push(
            `datatype property '${p.localName}' on '${domain}' duplicates an ` +
            `existing field name; skipped (field names must be unique).`);
        continue;
      }
      const type = datatypeFor(p.rangeIri);
      const field: Field = {
        name: p.localName,
        // The property's local name is a valid column reference once the entity
        // is bound to a real table; it is the default binding target.
        expression: p.localName,
        type,
        // A temporal field is a time dimension by OSI's own rule; mark it so
        // downstream (BigQuery Graph, BI) treats it as one.
        dimension: TEMPORAL_TYPES.has(type) ? {isTime: true} : undefined,
        label: fieldLabel(p.label, p.localName),
        description: p.comment,
        aiContext: fieldAiContext(p.synonyms, p.localName, p.examples),
      };
      attachOntology(field, fieldTerms);
      entity.fields.push(field);
      produced = true;
      // An inverse-functional property uniquely identifies its subject -> a
      // unique_keys constraint, unless it is already the primary key.
      if (p.inverseFunctional && !arraysEqual(entity.keys, [p.localName])) {
        (entity.uniqueKeys ??= []).push([p.localName]);
      }
    }
    if (produced) datatypePropertiesConverted++;
  }

  // Reconcile each entity's keys with the fields that actually exist. Both
  // corrections are fail-soft (warn, never throw), matching the converter's
  // per-element policy:
  //   1. owl:hasKey may name a property that is not a datatype property on the
  //      class (undeclared, or declared only on a different domain). That
  //      column has no field, so it would name a phantom column that only
  //      errors later at graph generation. Drop the ENTIRE primary_key, not
  //      just the phantom member -- keeping the survivors would silently narrow
  //      a composite key to a possibly non-unique one, changing the grain.
  //   2. A class with no usable owl:hasKey but exactly one single-column
  //      inverse-functional property still has a natural identifier; promote
  //      that unique key to the primary_key so the entity is valid for graph
  //      generation rather than keyless. (Ambiguous cases -- several unique
  //      keys, or a composite one -- are left alone.)
  for (const entity of entities) {
    const fieldNames = new Set(entity.fields.map(f => f.name));
    const missing = entity.keys.filter(k => !fieldNames.has(k));
    if (missing.length) {
      warnings.push(
          `class '${entity.name}' owl:hasKey names ${
              missing.map(m => `'${m}'`).join(', ')} which ${
              missing.length > 1 ? 'are' : 'is'} not a datatype property on ` +
          `the class; dropping the entire primary_key (keeping only the ` +
          `remaining columns would change the entity's grain).`);
      entity.keys = [];
    }
    if (!entity.keys.length && entity.uniqueKeys?.length === 1 &&
        entity.uniqueKeys[0].length === 1) {
      entity.keys = [...entity.uniqueKeys[0]];
      entity.uniqueKeys = undefined;
      warnings.push(
          `class '${entity.name}' has no usable owl:hasKey; using the ` +
          `inverse-functional property '${
              entity.keys[0]}' as its primary_key.`);
    }
  }

  // Object properties -> relationships (edges). Both endpoints must be known
  // classes. When the destination class declares a key, the edge's destination
  // columns bind to it and only the source foreign-key columns stay unbound;
  // otherwise both ends are placeholders.
  const relationships: Relationship[] = [];
  for (const p of owl.objectProperties) {
    const domain = p.domains[0];
    const range = p.ranges[0];
    if (!domain || !range) {
      warnings.push(
          `object property '${p.localName}' is missing an rdfs:domain or ` +
          `rdfs:range; skipped (a relationship needs both endpoints).`);
      continue;
    }
    // A relationship maps ONE source to ONE destination. Multiple domains or
    // ranges mean an intersection in OWL, which has no clean single-edge shape,
    // so keep the first of each and say what was dropped rather than losing it
    // silently.
    const ignored = [
      ...p.domains.slice(1).map(d => `domain '${d}'`),
      ...p.ranges.slice(1).map(r => `range '${r}'`),
    ];
    if (ignored.length) {
      warnings.push(
          `object property '${p.localName}' declares more than one endpoint ` +
          `(${ignored.join(', ')}); a relationship maps one source to one ` +
          `destination, so only domain '${domain}' -> range '${
              range}' is kept.`);
    }
    if (!classNames.has(domain) || !classNames.has(range)) {
      warnings.push(
          `object property '${p.localName}' references a non-class endpoint ` +
          `(domain '${domain}', range '${range}'); skipped.`);
      continue;
    }
    if (relationships.some(r => r.name === p.localName)) {
      warnings.push(
          `object property '${
              p.localName}' duplicates an existing relationship ` +
          `name; skipped (relationship names must be unique).`);
      continue;
    }
    // OWL facts with no native OSI home, carried verbatim on the relationship,
    // in a fixed key order so the emitted block is stable. rdfs:subPropertyOf
    // -> relationship inheritance (kept as a fact, no flattening);
    // owl:inverseOf -> the edge read the other way; owl:equivalentProperty /
    // propertyDisjointWith -> property cross-references; then the edge's
    // characteristics (symmetric / transitive / functional / reflexive /
    // irreflexive / asymmetric); commonTerms adds any per-term annotations.
    const relTerms: Record<string, unknown> = {};
    if (p.subPropertyOf.length)
      relTerms['rdfs:subPropertyOf'] = refs(p.subPropertyOf);
    if (p.inverseOf.length) {
      // owl:inverseOf pairs two properties; one DISTINCT statement is the norm.
      // refs() shortens and dedupes first, so a repeated identical triple isn't
      // mistaken for a genuine conflict. If more than one distinct inverse
      // remains, carry the first and say what was dropped rather than emitting
      // an array the reader would have to disambiguate.
      const inverses = refs(p.inverseOf);
      relTerms['owl:inverseOf'] = inverses[0];
      if (inverses.length > 1) {
        warnings.push(
            `object property '${p.localName}' declares owl:inverseOf more ` +
            `than once (${inverses.join(', ')}); a relationship has one ` +
            `inverse, so only '${inverses[0]}' is carried.`);
      }
    }
    if (p.equivalentProperty.length)
      relTerms['owl:equivalentProperty'] = refs(p.equivalentProperty);
    if (p.propertyDisjointWith.length)
      relTerms['owl:propertyDisjointWith'] = refs(p.propertyDisjointWith);
    if (p.symmetric) relTerms['owl:SymmetricProperty'] = true;
    if (p.transitive) relTerms['owl:TransitiveProperty'] = true;
    if (p.functional) relTerms['owl:FunctionalProperty'] = true;
    if (p.reflexive) relTerms['owl:ReflexiveProperty'] = true;
    if (p.irreflexive) relTerms['owl:IrreflexiveProperty'] = true;
    if (p.asymmetric) relTerms['owl:AsymmetricProperty'] = true;
    Object.assign(relTerms, commonTerms(p));

    const destKeys = entitiesByName.get(range)?.keys ?? [];
    const bound = destKeys.length > 0;
    const relationship: Relationship = {
      name: p.localName,
      // Source FK columns are unknown until binding; keep the count aligned
      // with the destination key so the positional join is well-formed.
      source: {
        entity: domain,
        columns: bound ? destKeys.map(() => TODO_BIND) : [TODO_BIND],
      },
      destination: {
        // Copy the key so the destination columns render inline rather than as
        // a YAML alias of the entity's primary_key (same array object).
        entity: range,
        columns: bound ? [...destKeys] : [TODO_BIND],
      },
      // No `description`: the OSI relationship has no such slot, so the comment
      // rides in ai_context.instructions (see relationshipAiContext).
      aiContext: relationshipAiContext(
          p.label, p.localName, p.synonyms, p.comment, p.examples),
    };
    attachOntology(relationship, relTerms);
    relationships.push(relationship);
  }

  const model: SemanticModel = {
    name: modelName,
    description: modelDescription(owl),
    aiContext: ontologyAiContext(owl.ontology, modelName),
    entities,
    relationships,
    metrics: [],
  };
  // Carry the base IRI as structured metadata WHENEVER a cross-reference was
  // shortened to a local name (refValue), so a consumer can rebuild the full
  // IRI as `<baseIri><localName>` mechanically instead of parsing it out of the
  // prose description. Only emitted when it is actually needed for that
  // reconstruction, so a model with no shortened reference stays clean.
  if (shortenedRef && owl.baseIri)
    attachOntology(model, {'owl:baseIri': owl.baseIri});

  return {
    model,
    warnings,
    stats: {
      classes: entities.length,
      datatypeProperties: datatypePropertiesConverted,
      objectProperties: relationships.length,
    },
  };
}

// The model description: the ontology header's own description when it has one,
// otherwise a provenance line naming the source base IRI. An owl:versionInfo is
// appended as provenance in either case.
function modelDescription(owl: OwlModel): string {
  const base = owl.ontology?.comment ??
      (owl.baseIri ? `Imported from OWL ontology ${owl.baseIri}` :
                     'Imported from OWL ontology');
  const version = owl.ontology?.version;
  return version ? `${base} (ontology version ${version})` : base;
}
