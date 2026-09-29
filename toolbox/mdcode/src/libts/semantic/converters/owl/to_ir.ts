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
//   owl:inverseOf                 -> relationship inverse (one edge, read back)
//   rdfs:range xsd:*              -> field datatype (see XSD_DATATYPES)
//   owl:hasKey                    -> dataset primary_key
//   owl:InverseFunctionalProperty -> dataset unique_keys (or primary_key)
//   rdfs:subClassOf               -> dataset extends (entity inheritance)
//   rdfs:subPropertyOf (object)   -> relationship extends; the parent becomes
//                                    abstract (relationship inheritance)
//   rdfs:label                    -> field label / synonym (no label slot)
//   rdfs:comment/skos:definition/dcterms:/dc: -> description
//   skos:example                  -> ai_context.examples
//   owl:Ontology header           -> model description / ai_context
//   owl:Restriction (subClassOf / equivalentClass), owl:FunctionalProperty
//   (object), owl:disjointWith, owl:AllDisjointClasses
//                                 -> model constraints (see constraints.ts)
//   owl:equivalentClass/Property (named) -> ai_context.synonyms
//   owl:deprecated                -> "DEPRECATED:" description + instruction
//   owl:Transitive/SymmetricProperty -> relationship ai_context.instructions
//                                    (see annotations.ts)
//
// The importer is IMPORT-ONLY: it maps the constructs above and DROPS every
// other OWL construct rather than carrying it. Facts with no native OSI home --
// rdfs:subPropertyOf between datatype properties,
// owl:propertyDisjointWith, the remaining
// property characteristics (reflexive, irreflexive, asymmetric, functional on
// a datatype property), owl:oneOf, owl:propertyChainAxiom, the
// owl:AllDisjointProperties / owl:AllDifferent set axioms, rdfs:isDefinedBy,
// and owl:versionInfo on a term -- are NOT imported. An earlier version carried
// them verbatim in a GOOGLE custom extension; that was removed so an imported
// model is a clean OSI model with no opaque carrier. The user guide's table
// documents what maps and what drops.
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

import {applyOwlAnnotations} from './annotations';
import {owlConstraints} from './constraints';
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

// Exported for the SHACL importer, which compares a shape's sh:datatype with a
// field's datatype through this same table (converters/shacl/constraints.ts).
export function datatypeFor(rangeIri: string|undefined): Field['type'] {
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

// The local name of an IRI (after the last `#`, else the last `/`), the form
// every emitted name takes. Cross-references such as rdfs:subPropertyOf are
// kept as full IRIs by the parser.
function iriLocalName(iri: string): string {
  const cut = Math.max(iri.lastIndexOf('#'), iri.lastIndexOf('/'));
  return cut >= 0 ? iri.slice(cut + 1) : iri;
}

// A class followed by its transitive `extends` ancestors, nearest first
// (breadth-first), each once. Unknown names end the walk quietly.
function entityLineage(
    cls: string, entitiesByName: Map<string, Entity>): string[] {
  const out: string[] = [];
  const queue = [cls];
  while (queue.length) {
    const next = queue.shift()!;
    if (out.includes(next)) continue;
    out.push(next);
    queue.push(...(entitiesByName.get(next)?.extends ?? []));
  }
  return out;
}

// The endpoint a superproperty is given when it declares none on that side:
// the NEAREST common superclass of its subproperties' endpoints -- the most
// specific class every subproperty edge is guaranteed to start (or end) at.
// `inRegion: Account -> Region` and `inTerritory: Opportunity -> Territory`
// under a domain-less `belongsToTerritory` give it the nearest class both
// Account and Opportunity extend. "Nearest" follows the first endpoint's
// breadth-first lineage, so a class that is itself one of the endpoints wins
// when the others descend from it. Undefined when the endpoints share no
// ancestor (the superproperty is then skipped, as before).
function inferredEnd(
    ends: string[], lineage: (cls: string) => string[]): string|undefined {
  const [first, ...rest] = ends;
  const others = rest.map(e => new Set(lineage(e)));
  return lineage(first).find(c => others.every(s => s.has(c)));
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
    if (!p.domains.length) {
      warnings.push(
          `datatype property '${p.localName}' has no rdfs:domain; skipped ` +
          `(a field must belong to a class).`);
      continue;
    }
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
        // No expression: the field is logical. A binding profile maps it to a
        // column when a real source is bound.
        type,
        // A temporal field is a time dimension by OSI's own rule; mark it so
        // downstream (BigQuery Graph, BI) treats it as one.
        dimension: TEMPORAL_TYPES.has(type) ? {isTime: true} : undefined,
        label: fieldLabel(p.label, p.localName),
        description: p.comment,
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
  //
  // rdfs:subPropertyOf between two object properties of this ontology maps to
  // relationship inheritance (Relationship.extends). A superproperty commonly
  // omits an endpoint its subproperties all pin down (e.g. a transitive
  // `belongsToTerritory` with a range but no domain, specialized by
  // `inRegion: Account -> Region`); rather than drop such a superproperty --
  // and lose the label every subproperty would carry -- the missing end is
  // INFERRED from its subproperties (see inferredEnd).
  const propByName = new Map(owl.objectProperties.map(p => [p.localName, p]));
  const superOf = (p: typeof owl.objectProperties[number]): string[] =>
      dedupe(p.subPropertyOf.map(iriLocalName))
          .filter(n => n !== p.localName && propByName.has(n));
  const subsOf = new Map<string, string[]>();
  for (const p of owl.objectProperties) {
    for (const s of superOf(p)) {
      subsOf.set(s, [...(subsOf.get(s) ?? []), p.localName]);
    }
  }
  const lineage = (cls: string): string[] =>
      entityLineage(cls, entitiesByName);
  // The declared-or-inferred endpoint of property `name` on one side
  // ('domains' = source, 'ranges' = destination), memoized; `visiting` breaks
  // a subPropertyOf cycle.
  const endMemo = new Map<string, string|undefined>();
  const visiting = new Set<string>();
  const endOf = (name: string, side: 'domains'|'ranges'): string|undefined => {
    const key = `${side}:${name}`;
    if (endMemo.has(key)) return endMemo.get(key);
    const p = propByName.get(name)!;
    let end: string|undefined = p[side][0];
    if (!end && !visiting.has(name)) {
      visiting.add(name);
      const childEnds = (subsOf.get(name) ?? []).map(c => endOf(c, side));
      visiting.delete(name);
      if (childEnds.length && childEnds.every(e => e !== undefined)) {
        end = inferredEnd(childEnds as string[], lineage);
      }
    }
    endMemo.set(key, end);
    return end;
  };

  // owl:inverseOf pairs are folded first (see planInverseFolds): the side that
  // only names the other edge read backwards becomes that edge's `inverse:`
  // instead of a second relationship, so it is skipped here and attached after.
  const {folded, inverseFor} = planInverseFolds(owl, warnings);
  const relationships: Relationship[] = [];
  for (const p of owl.objectProperties) {
    if (folded.has(p.localName)) continue;
    const declaredDomain = p.domains[0];
    const declaredRange = p.ranges[0];
    const domain = endOf(p.localName, 'domains');
    const range = endOf(p.localName, 'ranges');
    if (!domain || !range) {
      const hasSubs = (subsOf.get(p.localName) ?? []).length > 0;
      warnings.push(
          `object property '${p.localName}' is missing an rdfs:domain or ` +
          `rdfs:range; skipped (a relationship needs both endpoints` +
          (hasSubs ? `, and its subproperties' endpoints share no common ` +
                   `superclass to infer the missing one from` :
                     '') +
          `).`);
      continue;
    }
    for (const [side, declared, inferred] of [
             ['rdfs:domain', declaredDomain, domain],
             ['rdfs:range', declaredRange, range],
    ] as const) {
      if (!declared) {
        warnings.push(
            `object property '${p.localName}' declares no ${side}; inferred ` +
            `'${inferred}' (the nearest common superclass of its ` +
            `subproperties' endpoints).`);
      }
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
    const relationship: Relationship = {
      name: p.localName,
      // A logical edge: direction only, no join columns. The source
      // foreign-key and destination key columns are added to the model (logical
      // grain, not a binding) before a graph deploy.
      source: {entity: domain, columns: []},
      destination: {entity: range, columns: []},
      // No `description`: the OSI relationship has no such slot, so the comment
      // rides in ai_context.instructions (see relationshipAiContext).
      aiContext: relationshipAiContext(
          p.label, p.localName, p.synonyms, p.comment, p.examples),
    };
    relationships.push(relationship);
  }

  // Relationship inheritance, once the emitted set is known. `extends` keeps
  // only superproperties that became relationships (one skipped above cannot
  // be referenced; the loader would flag a dangling parent), dropping the
  // rest with a warning -- the rdfs:subClassOf policy for entities. A
  // superproperty that some emitted relationship extends is marked ABSTRACT:
  // in OWL it is the umbrella over its subproperties (every `hasBuyer` edge is
  // a `hasCounterparty` edge), so in a graph it is the shared LABEL on their
  // edge tables rather than an edge table of its own. Delete `abstract: true`
  // from the model to bind it as a separate edge as well.
  const emitted = new Set(relationships.map(r => r.name));
  for (const r of relationships) {
    const parents = superOf(propByName.get(r.name)!);
    const known = parents.filter(n => emitted.has(n));
    const unknown = parents.filter(n => !emitted.has(n));
    if (known.length) r.extends = known;
    if (unknown.length) {
      warnings.push(
          `object property '${r.name}' declares rdfs:subPropertyOf ${
              unknown.map(u => `'${u}'`).join(', ')}, which did not become a ` +
          `relationship; dropped from its 'extends'.`);
    }
  }
  const extended = new Set(relationships.flatMap(r => r.extends ?? []));
  for (const r of relationships) {
    if (extended.has(r.name)) r.abstract = true;
  }

  // Attach each folded inverse to its (now emitted) forward edge. The inverse
  // name shares the graph's label namespace with every entity and relationship
  // (it becomes a second edge table's alias on a graph deploy), so a clash
  // drops the inverse -- with a warning -- rather than failing the import.
  // Done before annotations and constraints, which may read `inverse`: a
  // restriction phrased through the inverse name (`≤1 governedBy.X`) resolves
  // to the forward edge read backwards (see constraints.ts).
  let inversesAttached = 0;
  const taken = new Set([
    ...entities.map(e => e.name.toLowerCase()),
    ...relationships.map(r => r.name.toLowerCase()),
  ]);
  for (const [forward, inverse] of inverseFor) {
    const rel = relationships.find(r => r.name === forward);
    if (!rel) {
      warnings.push(
          `object property '${inverse}' is owl:inverseOf '${forward}', which ` +
          `was not imported as a relationship; '${inverse}' is dropped too ` +
          `(an inverse only reads an existing edge backwards).`);
      continue;
    }
    if (taken.has(inverse.toLowerCase())) {
      warnings.push(
          `object property '${inverse}' (owl:inverseOf '${forward}') ` +
          `collides with an existing entity or relationship name; the ` +
          `inverse is dropped (graph labels must be unique).`);
      continue;
    }
    taken.add(inverse.toLowerCase());
    rel.inverse = inverse;
    inversesAttached++;
  }

  // Equivalences, deprecation, and the transitive / symmetric characteristics
  // land in native ai_context / description slots (see annotations.ts).
  applyOwlAnnotations(owl, entities, relationships);

  // Axioms that state a rule -- property restrictions, functional object
  // properties, class disjointness -- become native model-level constraints
  // (see constraints.ts). Omitted entirely when there are none, so an ontology
  // with no such axioms imports exactly as before.
  const constraints =
      owlConstraints(owl, {entitiesByName, relationships}, warnings);

  const model: SemanticModel = {
    name: modelName,
    description: modelDescription(owl),
    aiContext: ontologyAiContext(owl.ontology, modelName),
    entities,
    relationships,
    metrics: [],
  };
  if (constraints.length) model.constraints = constraints;
  return {
    model,
    warnings,
    stats: {
      classes: entities.length,
      datatypeProperties: datatypePropertiesConverted,
      // A folded inverse is converted too (as `inverse:` on its forward edge).
      objectProperties: relationships.length + inversesAttached,
    },
  };
}

// --- owl:inverseOf folding. --------------------------------------------------

// Plans how owl:inverseOf pairs map onto the native `inverse:` relationship
// key. `X owl:inverseOf Y` states that X is Y read backwards: the SAME links,
// traversed from the other end. A semantic-model relationship is directed, and
// its `inverse:` names exactly that reverse reading (a graph deploy emits a
// second edge table over the same backing table with SOURCE/DESTINATION
// swapped), so the pair becomes ONE relationship Y with `inverse: X` -- never
// two relationships that a deploy would materialize as two unrelated edges.
//
// Which side folds (X) into which (Y):
//   * A side that declares no rdfs:domain / rdfs:range of its own folds into
//     the side that does -- ontologies commonly declare only `X owl:inverseOf
//     Y` and let the ends follow from Y.
//   * When both declare ends, they must be CONSISTENT (X's domain is Y's range
//     and X's range is Y's domain, for whichever ends X declares); then the
//     side stating owl:inverseOf folds into its referent (the first in
//     document order when both state it).
//   * Contradictory ends are not an inverse pair the model can represent: both
//     are kept as separate relationships and a warning says why.
// A property names at most one inverse and a relationship carries at most one
// `inverse:`; extra owl:inverseOf statements are warned and ignored (first
// wins). A referent this ontology never declares as a property but that lies
// in its namespace (`ex:placedBy owl:inverseOf ex:places`, with no
// `ex:places` declaration) is still the name of the reverse reading, so it
// becomes the declaring edge's `inverse:` as-is; an external referent is
// warned and ignored.
//
// Returns the folded (not emitted) property names and, per forward edge, the
// inverse name to attach once the forward relationship has been emitted.
function planInverseFolds(owl: OwlModel, warnings: string[]):
    {folded: Set<string>; inverseFor: Map<string, string>} {
  const byName = new Map(owl.objectProperties.map(p => [p.localName, p]));
  const order = new Map(owl.objectProperties.map((p, i) => [p.localName, i]));
  const folded = new Set<string>();
  const inverseFor = new Map<string, string>();
  // Each unordered pair is decided once, whichever side states it.
  const seen = new Set<string>();

  for (const p of owl.objectProperties) {
    const referents = [...new Set(p.inverseOf.map(iriLocalName))].filter(
        r => r !== p.localName);
    if (!referents.length) continue;
    if (referents.length > 1) {
      warnings.push(
          `object property '${p.localName}' is owl:inverseOf more than one ` +
          `property (${referents.map(r => `'${r}'`).join(', ')}); a ` +
          `relationship has one inverse, so only '${referents[0]}' is used.`);
    }
    const q = byName.get(referents[0]);
    if (!q) {
      // The referent is not declared as a property here. Within this
      // ontology's namespace that is still a name for "p read backwards" (the
      // ontology coined the term without re-declaring it), so it becomes p's
      // inverse directly. An external IRI is someone else's term: ignored.
      const iri = p.inverseOf.find(i => iriLocalName(i) === referents[0]) ?? '';
      const inNamespace = !owl.baseIri || iri.startsWith(owl.baseIri);
      if (!inNamespace) {
        warnings.push(
            `object property '${p.localName}' is owl:inverseOf '${
                iri}', which is outside this ontology's namespace; the ` +
            `inverse is ignored.`);
      } else if (!folded.has(p.localName) && !inverseFor.has(p.localName)) {
        inverseFor.set(p.localName, referents[0]);
      }
      continue;
    }
    const pairKey = [p.localName, q.localName].sort().join('\u0000');
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);

    const hasEnds = (x: typeof p) => x.domains.length > 0 || x.ranges.length > 0;
    // X's declared ends agree with Y's ends swapped.
    const consistent = (x: typeof p, y: typeof p) =>
        (!x.domains.length || x.domains[0] === y.ranges[0]) &&
        (!x.ranges.length || x.ranges[0] === y.domains[0]);

    let x: typeof p;
    let y: typeof p;
    if (!hasEnds(p) && hasEnds(q)) {
      [x, y] = [p, q];
    } else if (!hasEnds(q) && hasEnds(p)) {
      [x, y] = [q, p];
    } else if (!hasEnds(p) && !hasEnds(q)) {
      // Neither side has ends; the relationship loop warns about both.
      continue;
    } else if (consistent(p, q) && consistent(q, p)) {
      // Both declare consistent ends: the stating side folds into its
      // referent; when both state it, the later one folds into the earlier.
      const qStates = q.inverseOf.map(iriLocalName).includes(p.localName);
      const pFirst = (order.get(p.localName) ?? 0) < (order.get(q.localName) ?? 0);
      [x, y] = qStates && pFirst ? [q, p] : [p, q];
    } else {
      warnings.push(
          `object properties '${p.localName}' and '${q.localName}' are ` +
          `declared owl:inverseOf each other but their rdfs:domain / ` +
          `rdfs:range do not mirror; both are kept as separate relationships ` +
          `(an inverse reads the same edge backwards, so its ends must be ` +
          `the forward edge's ends swapped).`);
      continue;
    }
    if (inverseFor.has(y.localName)) {
      warnings.push(
          `object property '${x.localName}' is another owl:inverseOf '${
              y.localName}', which already has the inverse '${
              inverseFor.get(y.localName)}'; a relationship carries one ` +
          `inverse, so '${x.localName}' is imported on its own ends, if any.`);
      continue;
    }
    if (folded.has(y.localName) || inverseFor.has(x.localName)) {
      // Chained pairs (X inverse of Y, Y inverse of Z): keep the first fold.
      warnings.push(
          `object property '${x.localName}' takes part in more than one ` +
          `owl:inverseOf pair; only the first pair is folded.`);
      continue;
    }
    folded.add(x.localName);
    inverseFor.set(y.localName, x.localName);
  }
  return {folded, inverseFor};
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
