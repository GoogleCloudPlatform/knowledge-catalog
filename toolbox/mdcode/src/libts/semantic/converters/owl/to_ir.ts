// OwlModel -> Semantic Model IR mapping.
//
// This is the whole OWL -> OSI policy layer. The parser (parse.ts) is
// mechanical; every decision about how an ontology becomes a semantic model
// lives here, in one place, so the mapping is easy to read and to evolve.
//
// The mapping (see the user guide's table). Each line is one construct, kept
// short so a comment reflow cannot run the columns together:
//   owl:Class                     -> dataset (entity), no source (logical)
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
// The importer is IMPORT-ONLY: it maps the constructs above and DROPS every
// other OWL construct rather than carrying it. Facts with no native OSI home --
// rdfs:subPropertyOf, owl:inverseOf, owl:equivalentClass / owl:disjointWith /
// owl:equivalentProperty / owl:propertyDisjointWith, the property
// characteristics (symmetric, transitive, ...), owl:oneOf,
// owl:propertyChainAxiom, the owl:AllDisjoint* / owl:AllDifferent set axioms,
// rdfs:seeAlso / isDefinedBy, and owl:deprecated / versionInfo -- are NOT
// imported. An earlier version carried them verbatim in a GOOGLE custom
// extension; that was removed so an imported model is a clean OSI model with no
// opaque carrier. The user guide's table documents what maps and what drops.
//
// The result is a purely LOGICAL model: an ontology declares meaning, not
// physical tables, so entities carry no source, fields no expression, and
// relationships no join columns -- only the logical shape (entities, fields,
// keys, and edges by direction). `kcmd push` publishes it as-is.
// A BigQuery or Spanner Graph deploy needs each edge's join columns added to
// the model (logical grain the model owns) plus a physical binding (sources,
// field columns) and a deployment target; that binding is a separate step (a
// binding profile, see the user guide, "Going from ontology to a running
// graph").

import {AiContext, Entity, Field, Relationship, SemanticModel,} from '../../ir';

import {OwlModel, OwlOntology} from './model';

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

// Pairs each of a property's domains with the description written beside it.
//
// RDF records no link between a domain and a description: a property IRI
// declared once per class contributes all of its domains and all of its
// comments to the same subject, as two independent bags. The only evidence of
// the author's pairing is document order, which the parser preserves and which
// generators (emitting each declaration as one contiguous block) get right.
//
// So zip by position when the counts line up, and otherwise give every domain
// every description. That fallback is noisier but it never attributes a
// sentence to the wrong edge, which is the failure that matters -- a wrong
// description reaches an agent as fact.
function perDomainDescription(
    descriptions: string[], domains: string[], term: string,
    warnings: string[]): (i: number) => string|undefined {
  if (descriptions.length === domains.length) return i => descriptions[i];
  if (descriptions.length <= 1) return () => descriptions[0];
  // More than one description but not one per domain: the positions cannot be
  // trusted, so every domain gets the lot. Say so -- a reader who sees four
  // sentences on one field should know why.
  const all = descriptions.join(' ');
  warnings.push(
      `property '${term}' carries ${descriptions.length} descriptions for ` +
      `${domains.length} domain(s), so they cannot be matched up one to one; ` +
      `each gets all of them.`);
  return () => all;
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
      // No source: a class is a logical entity. A binding profile supplies the
      // backing table before a graph deploy; KC push needs none.
      dataSource: '',
      keys: dedupe(c.keys),  // owl:hasKey -> primary_key (grain)
      description: c.comment,
      aiContext: synonymAiContext(c.label, c.localName, c.synonyms, c.examples),
      fields: [],
    };
    // rdfs:subClassOf -> entity-level `extends`. Kept AS DECLARED (parent
    // local names, deduped); parents are not flattened here -- a later
    // resolution pass expands inherited fields (see ir.ts Entity.extends). Only
    // parents defined as an owl:Class in this ontology are kept: an unknown
    // parent (a typo, or a superclass imported from another ontology) cannot be
    // resolved, and the loader hard-fails on an unknown supertype, so it is
    // DROPPED here with a warning rather than emitted into a model that could
    // not be pushed.
    if (c.subClassOf.length) {
      const parents = dedupe(c.subClassOf);
      const known = parents.filter(name => classNames.has(name));
      const unknown = parents.filter(name => !classNames.has(name));
      if (known.length) entity.extends = known;
      if (unknown.length) {
        warnings.push(
            `class '${c.localName}' declares rdfs:subClassOf a non-class ` +
            `superclass (${
                unknown.join(', ')}); dropped, as it is not an owl:Class in ` +
            `this ontology and cannot be resolved.`);
      }
    }
    entitiesByName.set(c.localName, entity);
    entities.push(entity);
  }

  // Datatype properties -> fields on each domain's entity. A property with more
  // than one domain appears on each; one with none has nowhere to live.
  let datatypePropertiesConverted = 0;
  for (const p of owl.datatypeProperties) {
    // RDF is a set of triples: a declaration repeated verbatim asserts the
    // same fact twice and must not be counted twice (see the note on the
    // object-property loop below).
    const domains = dedupe(p.domains);
    const comments = dedupe(p.comments);
    if (!domains.length) {
      warnings.push(
          `datatype property '${p.localName}' has no rdfs:domain; skipped ` +
          `(a field must belong to a class).`);
      continue;
    }
    // A property counts as converted once if it produces at least one field,
    // regardless of how many domains it lands on.
    let produced = false;
    const describe =
        perDomainDescription(comments, domains, p.localName, warnings);
    for (const [i, domain] of domains.entries()) {
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
        // No expression: the field is logical. A binding profile maps it to a
        // column when a real source is bound.
        type,
        // A temporal field is a time dimension by OSI's own rule; mark it so
        // downstream (BigQuery Graph, BI) treats it as one.
        dimension: TEMPORAL_TYPES.has(type) ? {isTime: true} : undefined,
        label: fieldLabel(p.label, p.localName),
        description: describe(i),
        aiContext: fieldAiContext(p.synonyms, p.localName, p.examples),
      };
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
  // classes. The edge is logical: it carries only its direction (source entity
  // -> destination entity), no join columns. The foreign-key / key columns are
  // added to the model (logical grain, not a binding) before a graph deploy.
  const relationships: Relationship[] = [];
  let objectPropertiesConverted = 0;
  for (const p of owl.objectProperties) {
    // RDF is a set of triples, but the parser hands us an array, so a property
    // re-declared once per class arrives with its shared range repeated once
    // per declaration. Those repeats assert one fact, not several: collapse
    // them before deciding anything, or an identical range looks like a
    // conflict and a repeated domain produces a duplicate edge.
    const domains = dedupe(p.domains);
    const ranges = dedupe(p.ranges);
    const comments = dedupe(p.comments);
    const range = ranges[0];
    if (!domains.length || !range) {
      warnings.push(
          `object property '${p.localName}' is missing an rdfs:domain or ` +
          `rdfs:range; skipped (a relationship needs both endpoints).`);
      continue;
    }
    // An edge has ONE destination, and genuinely DIFFERENT ranges mean an
    // intersection in OWL, which has no clean single-edge shape -- keep the
    // first and say what was dropped rather than losing it silently.
    if (ranges.length > 1) {
      warnings.push(
          `object property '${p.localName}' declares more than one ` +
          `rdfs:range (${ranges.join(', ')}); an edge has one destination, ` +
          `so only '${range}' is kept.`);
    }
    // Multiple DOMAINS are not an intersection to resolve, they are one verb
    // re-declared once per class that uses it -- the shape every class-by-class
    // ontology generator emits. Each domain is its own edge.
    const fanOut = domains.length > 1;
    const describe =
        perDomainDescription(comments, domains, p.localName, warnings);
    let produced = false;
    for (const [i, domain] of domains.entries()) {
      // Edge names must be unique within a model (the loader rejects a
      // duplicate outright), so a re-declared verb is qualified by the class it
      // runs from. A single-domain property keeps its bare name, so the common
      // case is untouched. The OWL verb is not lost: its rdfs:label survives in
      // ai_context, where the suffixed name no longer makes it redundant.
      const name = fanOut ? `${p.localName}_${domain}` : p.localName;
      if (!classNames.has(domain) || !classNames.has(range)) {
        warnings.push(
            `object property '${p.localName}' references a non-class ` +
            `endpoint (domain '${domain}', range '${range}'); skipped.`);
        continue;
      }
      if (relationships.some(r => r.name === name)) {
        warnings.push(
            `object property '${p.localName}' would produce relationship ` +
            `'${name}', which already exists; skipped (relationship names ` +
            `must be unique).`);
        continue;
      }
      relationships.push({
        name,
        // A logical edge: direction only, no join columns. The source
        // foreign-key and destination key columns are added to the model
        // (logical grain, not a binding) before a graph deploy.
        source: {entity: domain, columns: []},
        destination: {entity: range, columns: []},
        // No `description`: the OSI relationship has no such slot, so the
        // comment rides in ai_context.instructions (relationshipAiContext).
        aiContext: relationshipAiContext(
            p.label, name, p.synonyms, describe(i), p.examples),
      });
      produced = true;
    }
    // One property counts once however many edges it produced, matching the
    // datatype-property stat above.
    if (produced) objectPropertiesConverted++;
  }

  const model: SemanticModel = {
    name: modelName,
    description: modelDescription(owl),
    aiContext: ontologyAiContext(owl.ontology, modelName),
    entities,
    relationships,
    metrics: [],
  };
  return {
    model,
    warnings,
    stats: {
      classes: entities.length,
      datatypeProperties: datatypePropertiesConverted,
      objectProperties: objectPropertiesConverted,
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
