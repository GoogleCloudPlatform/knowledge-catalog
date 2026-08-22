// OwlModel -> Semantic Model IR mapping.
//
// This is the whole OWL -> OSI policy layer. The parser (parse.ts) is
// mechanical; every decision about how an ontology becomes a semantic model
// lives here, in one place, so the mapping is easy to read and to evolve.
//
// The mapping (see the user guide's table):
//   owl:Class                     -> dataset (entity), unbound source
//   placeholder owl:DatatypeProperty          -> field on each domain class's
//   dataset owl:ObjectProperty            -> relationship (edge) between domain
//   and range rdfs:range xsd:*              -> field datatype (see
//   XSD_DATATYPES; else Opaque) owl:hasKey                    -> dataset
//   primary_key owl:InverseFunctionalProperty -> dataset unique_keys rdfs:label
//   -> field label, or a synonym where there is no
//                                    label slot (classes/relationships)
//   rdfs:comment / skos:definition / dcterms:/dc:description -> description
//   skos:example                  -> ai_context.examples
//   owl:Ontology header           -> model description / ai_context
//
// The result is UNBOUND: entities carry an `unbound:<Name>` source placeholder
// and relationships carry `TODO_BIND` join columns, because an ontology has no
// physical tables. A declared key sharpens this -- an edge into a class with a
// key binds its destination columns to that key, leaving only the source
// foreign-key columns to fill. The model loads and pushes to Knowledge Catalog
// as-is; binding real sources/columns is a manual follow-up before a BigQuery
// push (see the user guide, "Going from ontology to a running graph").

import {AiContext, CustomExtension, Entity, Field, Relationship, SemanticModel,} from '../../ir';

import {OwlModel, OwlOntology} from './model';

export interface ToIrResult {
  model: SemanticModel;
  // Human-readable notes about OWL content that could not be mapped (e.g. a
  // property with no domain). The caller prints these; they do not fail the
  // conversion.
  warnings: string[];
}

// --- Seams: the isolated change-points for later work. ----------------------

// The GOOGLE custom-extensions vendor name. Ontology data that OSI can't yet
// express natively (subClassOf, inverseOf, base IRI, ...) will ride in this
// vendor's block under a `data.ontology` key -- Google's choice to support OWL,
// so it sits in the GOOGLE block alongside deployment targets, not a new "OWL"
// vendor. See deploy_bigquery.googleDeploymentTargets, which safely ignores a
// GOOGLE block that carries no deploymentTargets.
const GOOGLE_VENDOR = 'GOOGLE';

/**
 * Builds the GOOGLE custom-extension block that carries OWL constructs OSI
 * cannot express natively, under `data.ontology`.
 *
 * This is the promotion seam: when subClassOf / inverseOf / base-IRI carriage
 * lands, it is emitted here (and, later, promoted to native OSI fields by
 * changing only this function and its callers). The current cut maps everything
 * it reads to native OSI, so nothing calls this yet -- it is defined, tested
 * for shape, and left unused until the richer constructs arrive.
 */
export function googleOntologyExtension(ontology: Record<string, unknown>):
    CustomExtension {
  return {
    vendorName: GOOGLE_VENDOR,
    data: JSON.stringify({data: {ontology}}),
  };
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
    entitiesByName.set(c.localName, entity);
    entities.push(entity);
  }

  // Datatype properties -> fields on each domain's entity. A property with more
  // than one domain appears on each; one with none has nowhere to live.
  for (const p of owl.datatypeProperties) {
    if (!p.domains.length) {
      warnings.push(
          `datatype property '${p.localName}' has no rdfs:domain; skipped ` +
          `(a field must belong to a class).`);
      continue;
    }
    if (p.subPropertyOf.length) {
      // Property inheritance is not supported (only entity-level
      // rdfs:subClassOf -> extends). The field is still imported on each
      // domain; only the subPropertyOf link is dropped.
      warnings.push(
          `datatype property '${p.localName}' declares rdfs:subPropertyOf ` +
          `(${p.subPropertyOf.join(', ')}); property inheritance is not ` +
          `supported, so the subPropertyOf link is dropped (the field itself ` +
          `is still imported).`);
    }
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
      entity.fields.push(field);
      // An inverse-functional property uniquely identifies its subject -> a
      // unique_keys constraint, unless it is already the primary key.
      if (p.inverseFunctional && !arraysEqual(entity.keys, [p.localName])) {
        (entity.uniqueKeys ??= []).push([p.localName]);
      }
    }
  }

  // Object properties -> relationships (edges). Both endpoints must be known
  // classes. When the destination class declares a key, the edge's destination
  // columns bind to it and only the source foreign-key columns stay unbound;
  // otherwise both ends are placeholders.
  const relationships: Relationship[] = [];
  for (const p of owl.objectProperties) {
    if (!p.domain || !p.range) {
      warnings.push(
          `object property '${p.localName}' is missing an rdfs:domain or ` +
          `rdfs:range; skipped (a relationship needs both endpoints).`);
      continue;
    }
    if (!classNames.has(p.domain) || !classNames.has(p.range)) {
      warnings.push(
          `object property '${p.localName}' references a non-class endpoint ` +
          `(domain '${p.domain}', range '${p.range}'); skipped.`);
      continue;
    }
    if (relationships.some(r => r.name === p.localName)) {
      warnings.push(
          `object property '${
              p.localName}' duplicates an existing relationship ` +
          `name; skipped (relationship names must be unique).`);
      continue;
    }
    if (p.subPropertyOf.length) {
      // Relationship inheritance is not supported (only entity-level
      // rdfs:subClassOf -> extends). The relationship is still imported; only
      // the subPropertyOf link is dropped.
      warnings.push(
          `object property '${p.localName}' declares rdfs:subPropertyOf ` +
          `(${p.subPropertyOf.join(', ')}); relationship inheritance is not ` +
          `supported, so the subPropertyOf link is dropped (the relationship ` +
          `itself is still imported).`);
    }
    const destKeys = entitiesByName.get(p.range)?.keys ?? [];
    const bound = destKeys.length > 0;
    relationships.push({
      name: p.localName,
      // Source FK columns are unknown until binding; keep the count aligned
      // with the destination key so the positional join is well-formed.
      source: {
        entity: p.domain,
        columns: bound ? destKeys.map(() => TODO_BIND) : [TODO_BIND],
      },
      destination: {
        // Copy the key so the destination columns render inline rather than as
        // a YAML alias of the entity's primary_key (same array object).
        entity: p.range,
        columns: bound ? [...destKeys] : [TODO_BIND],
      },
      // No `description`: the OSI relationship has no such slot, so the comment
      // rides in ai_context.instructions (see relationshipAiContext).
      aiContext: relationshipAiContext(
          p.label, p.localName, p.synonyms, p.comment, p.examples),
    });
  }

  const model: SemanticModel = {
    name: modelName,
    description: modelDescription(owl),
    aiContext: ontologyAiContext(owl.ontology, modelName),
    entities,
    relationships,
    metrics: [],
  };

  return {model, warnings};
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
