// OwlModel -> Semantic Model IR mapping.
//
// This is the whole OWL -> OSI policy layer. The parser (parse.ts) is
// mechanical; every decision about how an ontology becomes a semantic model
// lives here, in one place, so the mapping is easy to read and to evolve.
//
// The mapping (see the user guide's table):
//   owl:Class            -> dataset (entity), unbound source placeholder
//   owl:DatatypeProperty -> field on its domain class's dataset
//   owl:ObjectProperty   -> relationship (edge) between domain and range
//   rdfs:range xsd:*      -> field datatype (string/date/decimal; else Opaque)
//   rdfs:label           -> field label, or a synonym where there is no label
//                           slot (classes/relationships)
//   rdfs:comment         -> description
//
// The result is UNBOUND: entities carry an `unbound:<Name>` source placeholder
// and relationships carry `TODO_BIND` join columns, because an ontology has no
// physical tables. The model still loads and pushes to Knowledge Catalog as-is;
// binding real sources/columns is a manual follow-up before a BigQuery push
// (see the user guide, "Going from ontology to a running graph").

import {AiContext, CustomExtension, Entity, Field, Relationship, SemanticModel,} from '../../ir';

import {OwlModel} from './model';

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
 * changing only this function and its callers). The minimal first cut maps
 * everything to native OSI, so nothing calls this yet -- it is defined, tested
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

// The xsd:* ranges the first cut maps to an OSI datatype. Everything else falls
// back to Opaque (a valid, lossless "unknown logical type" per the IR). Kept as
// a table so adding ranges later is a one-line change; the user guide documents
// exactly this set.
const XSD_DATATYPES: Record<string, Field['type']> = {
  [`${XSD}string`]: 'String',
  [`${XSD}date`]: 'Date',
  [`${XSD}decimal`]: 'Decimal',
};

function datatypeFor(rangeIri: string|undefined): Field['type'] {
  if (rangeIri && XSD_DATATYPES[rangeIri]) return XSD_DATATYPES[rangeIri];
  return 'Opaque';
}

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

// The display label for a FIELD: the OSI `label` slot exists only on fields, so
// a datatype property's rdfs:label lands here -- unless it is redundant with
// the field name, in which case it is dropped.
function fieldLabel(label: string|undefined, name: string): string|undefined {
  if (label && !isRedundantLabel(label, name)) return label;
  return undefined;
}

// The ai_context for a term that has NO label slot (classes, relationships): a
// non-redundant rdfs:label becomes an alternate name, joined with any explicit
// synonyms (extra labels / skos alt labels). Returns undefined when there are
// none, so no empty ai_context is emitted.
function synonymAiContext(
    label: string|undefined, name: string, synonyms: string[]): AiContext|
    undefined {
  const all: string[] = [];
  if (label && !isRedundantLabel(label, name)) all.push(label);
  all.push(...synonyms);
  return all.length ? {synonyms: dedupe(all)} : undefined;
}

// The ai_context for a FIELD (which already consumed its primary label into the
// `label` slot): only the explicit synonyms remain. Undefined when empty.
function fieldAiContext(synonyms: string[]): AiContext|undefined {
  return synonyms.length ? {synonyms: dedupe(synonyms)} : undefined;
}

// The ai_context for a RELATIONSHIP. Unlike datasets/fields, the OSI
// relationship has no `description` slot (see the Apache OSI schema), so an
// object property's rdfs:comment is carried as ai_context `instructions`, and
// its non-redundant label/synonyms as `synonyms`. Undefined when both are
// empty.
function relationshipAiContext(
    label: string|undefined, name: string, synonyms: string[],
    comment: string|undefined): AiContext|undefined {
  const names: string[] = [];
  if (label && !isRedundantLabel(label, name)) names.push(label);
  names.push(...synonyms);
  const ai: AiContext = {};
  if (comment) ai.instructions = comment;
  if (names.length) ai.synonyms = dedupe(names);
  return ai.instructions || ai.synonyms ? ai : undefined;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
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
  // datatype-property-declaration order below.
  const entitiesByName = new Map<string, Entity>();
  const entities: Entity[] = owl.classes.map(c => {
    const entity: Entity = {
      name: c.localName,
      dataSource: unboundSource(c.localName),
      keys: [],
      description: c.comment,
      aiContext: synonymAiContext(c.label, c.localName, c.synonyms),
      fields: [],
    };
    entitiesByName.set(c.localName, entity);
    return entity;
  });

  // Datatype properties -> fields on their domain's entity.
  for (const p of owl.datatypeProperties) {
    if (!p.domain) {
      warnings.push(
          `datatype property '${p.localName}' has no rdfs:domain; skipped ` +
          `(a field must belong to a class).`);
      continue;
    }
    const entity = entitiesByName.get(p.domain);
    if (!entity) {
      warnings.push(
          `datatype property '${p.localName}' has domain '${p.domain}', ` +
          `which is not an owl:Class in this ontology; skipped.`);
      continue;
    }
    const field: Field = {
      name: p.localName,
      // The property's local name is a valid column reference once the entity
      // is bound to a real table; it is the default binding target.
      expression: p.localName,
      type: datatypeFor(p.rangeIri),
      label: fieldLabel(p.label, p.localName),
      description: p.comment,
      aiContext: fieldAiContext(p.synonyms),
    };
    entity.fields.push(field);
  }

  // Object properties -> relationships (edges). Both endpoints must be known
  // classes; the join columns are unbound placeholders.
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
    relationships.push({
      name: p.localName,
      source: {entity: p.domain, columns: [TODO_BIND]},
      destination: {entity: p.range, columns: [TODO_BIND]},
      // No `description`: the OSI relationship has no such slot, so the comment
      // rides in ai_context.instructions (see relationshipAiContext).
      aiContext:
          relationshipAiContext(p.label, p.localName, p.synonyms, p.comment),
    });
  }

  const description = owl.baseIri ?
      `Imported from OWL ontology ${owl.baseIri}` :
      'Imported from OWL ontology';

  const model: SemanticModel = {
    name: modelName,
    description,
    entities,
    relationships,
    metrics: [],
  };

  return {model, warnings};
}
