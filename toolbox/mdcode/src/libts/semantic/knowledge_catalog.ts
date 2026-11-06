// Generates Knowledge Catalog resources from the Semantic Model IR.
//
// The IR (./ir) is pure semantics. This module is its Knowledge Catalog
// emitter, the counterpart to `bigquery.ts`: it maps the model to catalog
// Entries, each carrying the `semantic-*` Aspect(s) that describe it. Like
// `bigquery.ts` it is a PURE function of the IR: no GCP calls, no I/O. The
// orchestration layer (`deploy_knowledge_catalog.ts`, the counterpart to
// `deploy_bigquery.ts`) drives this emitter and writes the resulting resources
// via the Knowledge Catalog client.
//
// The `semantic-*` entry, aspect and entry link types, and the other types this
// emitter references (the `schema`, `guidelines`, `overview` and
// `sql-expressions` aspect types and the `reference` entry link type), are
// built-in system types under `dataplex-types/global`. This emitter references
// them; it never provisions them.
//
// An action (a write operation the model defines) and a constraint (an
// invariant the model states) are published the same way: one entry each,
// parented to the anchor. Their entry and aspect types are CUSTOM, because
// Dataplex has no built-in type for either yet, so `kcmd init` provisions the
// pairs in the destination project. `kc_custom_types.ts` declares those types
// and `kc_actions.ts` and `kc_constraints.ts` encode the aspects they carry.
// This module only appends the entries those two return.
//
// The model entry carries semantic-model, each entity entry carries
// semantic-entity and schema, and each metric entry carries semantic-metric
// and sql-expressions. An entity entry has sql-expressions too when one of its
// fields has an expression. Model, entity, metric and relationship entries
// also carry guidelines, semantic-extensions and overview when the object has
// content for them. A field has no entry, so its guidelines,
// semantic-extensions and overview go on its entity's entry at the field's
// path. `guidelines` holds the object's instructions and, in `data`, its
// custom `ai_context` members.
//
// Each relationship is an entry, `<model>/relationships/<name>`, that carries
// semantic-relationship. A `semantic-link` entry link joins each ordered pair
// of related entities and lists their relationships in declaration order. A
// `reference` link runs from each relationship entry to each of its two
// entities, and from each entity entry to the entry of each parent it extends.
// A many-to-many (association) relationship is not published yet: the emitter
// warns and skips it, and the edge still lives in the BigQuery property graph
// (see graph_ddl.ts).

import type {Aspect, Entry, EntryLink} from '../gcp/dataplex';
import type {OverviewSidecar} from '../layouts/semantic-model';

import {AiContext, CustomExtension, DataType, DeploymentSpec, Entity, Field, Metric, ProfileSpec, Relationship, SemanticModel} from './ir';
import {actionEntries} from './kc_actions';
import {constraintEntries} from './kc_constraints';
import {Namer, ownedEntryIdPrefixes, semanticLinkId} from './kc_ids';
import {GOOGLE_VERSION} from './loader';
import {nonEmpty} from './osi_converter';
import {DEFAULT_PROFILE, inheritedNamesOf, statesKey, withoutExclusions} from './resolve_profiles';

export interface KcGenerateOptions {
  project: string;     // project the entries are created in (destination)
  location: string;    // destination location
  entryGroup: string;  // destination entry group
  systemTypeProject?: string;   // default 'dataplex-types'
  systemTypeLocation?: string;  // default 'global'
  // Not read: the emitter always writes the second-generation types. It goes
  // with KC_V2_ASPECTS (b/575695037).
  v2Aspects?: boolean;
  // The overview sidecar of each entry, by entry id, which fills its overview
  // beside the examples.
  overviews?: ReadonlyMap<string, OverviewSidecar>;
}

export interface KcResources {
  entries: Entry[];
  entryLinks: EntryLink[];
  warnings: string[];
  // Entry-id prefixes this model owns, used by delete reconciliation to decide
  // which existing entries a push is allowed to remove. Supplied by the emitter
  // rather than derived by the publisher: the id scheme is the emitter's
  // concern (this emitter owns dotted and slash ids, and LookML's emitter its
  // own), so the publisher must not assume one.
  //
  // It rides on the emitter's output rather than being passed to the publisher
  // alongside it so that the ids and the prefixes meant to match them are
  // produced by one call and cannot drift apart. A prefix that stops matching
  // fails silently in the dangerous direction: nothing is owned, so nothing is
  // deleted, and orphaned entries accumulate while the push reports success.
  ownedPrefixes: string[];
}

/**
 * Generates the Knowledge Catalog resources for a semantic model.
 *
 * Returns the entries (model anchor first, then entities, metrics,
 * relationships, actions and constraints), the entry links of the
 * relationships and of each entity's parents, and any warnings collected
 * while mapping the IR (missing keys, skipped M:N relationships). The
 * resources reference the built-in system types; they do not create them.
 */
export function generateCatalogResources(
    model: SemanticModel, opts: KcGenerateOptions): KcResources {
  const warnings: string[] = [];
  const entities = model.entities ?? [];
  const metrics = model.metrics ?? [];

  if (!entities.length) {
    warnings.push(
        'model has no entities; only the semantic-model entry will be generated');
  }

  const names = new Namer(opts);
  warnings.push(...unstorableMemberWarnings(model));

  // Entry ids must be unique within the entry group. Two action or constraint
  // names that normalize to the same id (see slug), or exact duplicates the
  // loader did not reject, would otherwise emit two entries with the same name
  // and have the later write silently overwrite the earlier. Track ids and
  // skip a collision.
  const seen = new Set<string>();

  // The model entry is the anchor and the parent of every entity/metric entry,
  // so it is created first: it is entries[0] and the publisher writes in array
  // order. Reserve its id up front so nothing else can claim it.
  const modelId = names.modelId(model);
  const modelEntryName = names.entry(modelId);
  claim(seen, modelId, 'entry', `model '${model.name}'`, warnings);

  const entries: Entry[] = [{
    name: modelEntryName,
    entryType: names.typeName('entry', 'semantic-model'),
    entrySource: source(model.name, model.description),
    aspects: aspectMap(names, {
      'semantic-model': modelAspectDataV2(model),
      ...objectAspectsV2(model),
    }),
  }];

  // Maps an entity's model name to its published entry name, so a relationship
  // can resolve its endpoints to the entries the link references. Only entities
  // actually emitted (not skipped for a duplicate id) are recorded.
  const entityEntryName = new Map<string, string>();
  for (const entity of entities) {
    const entityId = names.entityId(model, entity);
    if (!claim(seen, entityId, 'entry', `entity '${entity.name}'`, warnings))
      continue;
    entityEntryName.set(entity.name, names.entry(entityId));
    if (lacksKeys(model, entity)) {
      warnings.push(
          `entity '${entity.name}': no keys declared in the source model; ` +
          `declare primary_key or unique_keys in the model file or in a ` +
          `profile to record a key in Knowledge Catalog`);
    }
    entries.push({
      name: names.entry(entityId),
      entryType: names.typeName('entry', 'semantic-entity'),
      parentEntry: modelEntryName,
      entrySource: source(entity.name, entity.description),
      // semantic-entity and schema are required. The file header lists the
      // optional aspects.
      aspects: aspectMap(names, entityAspectsV2(model, entity)),
    });
  }

  for (const metric of metrics) {
    const metricId = names.metricId(model, metric);
    if (!claim(seen, metricId, 'entry', `metric '${metric.name}'`, warnings))
      continue;
    entries.push({
      name: names.entry(metricId),
      entryType: names.typeName('entry', 'semantic-metric'),
      parentEntry: modelEntryName,
      entrySource: source(metric.name, metric.description),
      aspects: aspectMap(names, metricAspectsV2(model, metric)),
    });
  }

  const relationships = relationshipResourcesV2(
      names, model, modelEntryName, entityEntryName, warnings);
  entries.push(...relationships.entries);
  // Each entry's sidecar fills the rest of its overview, beside the examples.
  for (const [id, sidecar] of opts.overviews ?? []) {
    const entry = entries.find(e => e.name === names.entry(id));
    if (!entry) {
      warnings.push(
          `sidecar '${id}.overview.md' names no entry of this model; it is ` +
          `not pushed`);
      continue;
    }
    const examples =
        entry.aspects?.[names.aspectRef('overview')]?.data?.examples;
    const overview = compact({...sidecar, examples});
    if (Object.keys(overview).length) {
      entry.aspects = {...entry.aspects, ...aspectMap(names, {overview})};
    }
  }

  // One entry per action, alongside the entities and metrics. Actions have no
  // built-in system type, so they reference the custom pair declared in
  // `kc_custom_types.ts`, and `kc_actions.ts` fills the aspect; it returns
  // nothing when the model declares no actions. The schema keeps a field a
  // profile excludes, so actionEntries reads the model without exclusions.
  entries.push(...actionEntries(withoutExclusions(model), modelId, {
    project: opts.project,
    entry: (id: string) => names.entry(id),
    anchor: modelEntryName,
    claim: (id: string, label: string) =>
        claim(seen, id, 'entry', label, warnings),
  }, warnings));

  // One entry per constraint, on the same footing as an action: no built-in
  // system type, so the custom pair declared in `kc_custom_types.ts`, filled by
  // `kc_constraints.ts`. Nothing when the model declares no constraints.
  entries.push(...constraintEntries(model, modelId, {
    project: opts.project,
    entry: (id: string) => names.entry(id),
    anchor: modelEntryName,
    claim: (id: string, label: string) =>
        claim(seen, id, 'entry', label, warnings),
  }, warnings));

  return {
    entries,
    entryLinks: [
      ...relationships.links,
      ...extendsLinks(names, model, entityEntryName),
    ],
    warnings: [...new Set(warnings)],
    ownedPrefixes: ownedEntryIdPrefixes(model.name),
  };
}


// Why an association relationship is not published.
const ASSOCIATION_REASON =
    `many-to-many (association) edges are not published to ` +
    `Knowledge Catalog yet; the edge lives in the BigQuery property graph.`;

// The relationship entries and their links under the second-generation
// types: an entry per relationship except an association, a semantic-link per
// ordered entity pair listing its relationships in order, and a reference link
// from each relationship entry to each of its two entities.
function relationshipResourcesV2(
    names: Namer, model: SemanticModel, modelEntryName: string,
    entityEntryName: ReadonlyMap<string, string>,
    warnings: string[]): {entries: Entry[]; links: EntryLink[]} {
  const entries: Entry[] = [];
  const references: EntryLink[] = [];
  // The relationships of each ordered entity pair, by link ID.
  const pairs =
      new Map<string, {from: string; to: string; relationships: string[]}>();
  // Push never reaches a name with no entry: validation rejects an unknown
  // entity, and every entity has an entry under these types.
  for (const rel of model.relationships ?? []) {
    if (rel.association) {
      warnings.push(`relationship '${rel.name}': ${ASSOCIATION_REASON}`);
      continue;
    }
    const id = names.relationshipId(model, rel);
    entries.push({
      name: names.entry(id),
      entryType: names.typeName('entry', 'semantic-relationship'),
      parentEntry: modelEntryName,
      entrySource: source(rel.name, rel.description),
      aspects: aspectMap(names, {
        'semantic-relationship': relationshipAspectData(model, rel),
        ...objectAspectsV2(rel),
      }),
    });
    const from = rel.source.entity;
    const to = rel.destination.entity;
    for (const [end, entity] of [['source', from], ['target', to]]) {
      references.push(directedLink(
          names, 'reference',
          semanticLinkId('relationship', model.name, rel.name, end),
          names.entry(id), entityEntryName.get(entity)!));
    }
    const linkId = semanticLinkId('link', model.name, from, to);
    const pair = pairs.get(linkId) ?? {from, to, relationships: []};
    pair.relationships.push(rel.name);
    pairs.set(linkId, pair);
  }
  const links = [...pairs].map(([linkId, {from, to, relationships}]) => ({
    ...directedLink(
        names, 'semantic-link', linkId, entityEntryName.get(from)!,
        entityEntryName.get(to)!),
    aspects: aspectMap(names, {'semantic-link': {relationships}}),
  }));
  return {entries, links: [...links, ...references]};
}

// The reference link from each entity entry to the entry of each parent it
// extends.
function extendsLinks(
    names: Namer, model: SemanticModel,
    entityEntryName: ReadonlyMap<string, string>): EntryLink[] {
  return (model.entities ?? []).flatMap(
      e => (e.extends ?? []).map(
          parent => directedLink(
              names, 'reference',
              semanticLinkId('extends', model.name, e.name, parent),
              entityEntryName.get(e.name)!, entityEntryName.get(parent)!)));
}

// A link of type `type` with ID `id` from the entry `from` to the entry `to`.
function directedLink(
    names: Namer, type: string, id: string, from: string,
    to: string): EntryLink {
  return {
    name: names.entryLink(id),
    entryLinkType: names.typeName('entryLink', type),
    entryReferences: [{name: from, type: 'SOURCE'}, {name: to, type: 'TARGET'}],
  };
}

// The semantic-relationship aspect, with join columns as written.
function relationshipAspectData(
    model: SemanticModel, rel: Relationship): Record<string, any> {
  const endpoint = (end: Relationship['source']) =>
      compact({name: end.entity, fields: nonEmpty(end.columns)});
  const profiles = namedProfiles(model).flatMap(p => {
    const bound = p.relationships?.find(r => r.name === rel.name);
    if (!bound) return [];
    return [compact({
      name: p.name,
      sourceFields: nonEmpty(bound.fromColumns),
      targetFields: nonEmpty(bound.toColumns),
    })];
  });
  return compact({
    source: endpoint(rel.source),
    target: endpoint(rel.destination),
    profiles: nonEmpty(profiles),
    synonyms: nonEmpty(rel.aiContext?.synonyms),
  });
}

// One warning for each custom `ai_context` member that `guidelines` leaves
// out, on the model, an entity, a field, a metric or a relationship.
function unstorableMemberWarnings(model: SemanticModel): string[] {
  const warnings: string[] = [];
  const check = (object: string, ai: AiContext|undefined) => {
    for (const [member, value] of Object.entries(
             ai?.additionalProperties ?? {})) {
      const holds = unstorableValue(value);
      if (holds) {
        warnings.push(
            `${object}: ai_context member '${member}' is not pushed: its ` +
            `value holds ${holds}, which Knowledge Catalog cannot store as ` +
            `written`);
      }
    }
  };
  check(`model '${model.name}'`, model.aiContext);
  for (const entity of model.entities ?? []) {
    check(`entity '${entity.name}'`, entity.aiContext);
    for (const field of entity.fields ?? []) {
      check(`field '${entity.name}.${field.name}'`, field.aiContext);
    }
  }
  for (const metric of model.metrics ?? []) {
    check(`metric '${metric.name}'`, metric.aiContext);
  }
  for (const rel of model.relationships ?? []) {
    check(`relationship '${rel.name}'`, rel.aiContext);
  }
  return warnings;
}

// Names the first number in `value` that JSON cannot hold as the document
// wrote it: .inf, -.inf, .nan, or a number past 2^53, which loses digits when
// the model loads. Undefined when there is none.
function unstorableValue(value: unknown): string|undefined {
  if (typeof value === 'number') {
    if (Number.isNaN(value)) return '.nan';
    if (!Number.isFinite(value)) return value > 0 ? '.inf' : '-.inf';
    return Number.isInteger(value) && !Number.isSafeInteger(value) ?
        'a number past 2^53' :
        undefined;
  }
  if (value === null || typeof value !== 'object') return undefined;
  return Object.values(value).map(unstorableValue).find(Boolean);
}

// The fields `entity` declares, leaving out each line that only rebinds a
// field it inherits.
function declaredFields(model: SemanticModel, entity: Entity): Field[] {
  const inherited = inheritedNamesOf(model, entity.name);
  return entity.fields.filter(f => !inherited.has(f.name));
}

// True when `entity` is concrete and states no primary key and no unique key,
// in its own bindings or in any named profile.
function lacksKeys(model: SemanticModel, entity: Entity): boolean {
  const bindings = namedProfiles(model).flatMap(
      p => p.entities.filter(b => b.name === entity.name));
  return !entity.abstract && !statesKey(entity.keys, entity.uniqueKeys) &&
      !bindings.some(b => statesKey(b.primaryKey, b.uniqueKeys));
}


// ---------------------------------------------------------------------------
// Aspect-data mappers. Field names/nesting mirror the server aspect types'
// CLOSED metadataTemplates exactly; the golden tests pin these shapes so any
// schema-driven change is a visible, reviewable diff.
// ---------------------------------------------------------------------------

// The guidelines, semantic-extensions and overview aspects of an object's
// entry, each left out when the object has nothing for it. For a field's
// aspects, `at` is `@Schema.<field>`, and each key ends in it.
function objectAspectsV2(
    object: {aiContext?: AiContext; customExtensions?: CustomExtension[]},
    at = ''): Record<string, any> {
  const examples = object.aiContext?.examples ?? [];
  return compact({
    [`guidelines${at}`]: guidelinesAspectDataV2(object.aiContext),
    [`semantic-extensions${at}`]: extensionsAspectData(object.customExtensions),
    [`overview${at}`]: examples.length ?
        {examples: examples.map(content => ({content}))} :
        undefined,
  });
}

// The guidelines aspect under the second-generation types: the object's
// instructions, and in `data` its custom ai_context members by name, leaving
// out those `unstorableValue` names. Undefined when the object has neither.
function guidelinesAspectDataV2(ai: AiContext|undefined): Record<string, any>|
    undefined {
  const members = Object.entries(ai?.additionalProperties ?? {})
                      .filter(([, value]) => !unstorableValue(value));
  const data = members.length ? Object.fromEntries(members) : undefined;
  const instructions = ai?.instructions || undefined;
  if (!instructions && !data) return undefined;
  return compact({instructions, data, userManaged: true});
}

// semantic-extensions: every extension block from a vendor other than GOOGLE,
// as written and in order. Undefined when there is none.
function extensionsAspectData(extensions: CustomExtension[]|undefined):
    Record<string, any>|undefined {
  const blocks = (extensions ?? []).filter(x => x.vendorName !== 'GOOGLE');
  return blocks.length ? {customExtensions: blocks} : undefined;
}

// The semantic-model aspect of the second-generation types.
function modelAspectDataV2(model: SemanticModel): Record<string, any> {
  const declared: DeploymentSpec[] = model.deployments ?? [];
  const deployments = declared.map(d => compact({
    name: d.name,
    target: d.target,
    profile: d.profile === DEFAULT_PROFILE ? undefined : d.profile,
  }));
  return compact({
    specVersion: model.version ?? GOOGLE_VERSION,
    synonyms: nonEmpty(model.aiContext?.synonyms),
    profiles: nonEmpty(namedProfiles(model).map(p => ({name: p.name}))),
    deployments: nonEmpty(deployments),
  });
}

// The aspects of an entity entry under the second-generation types. Its schema
// lists the fields it declares, each with its own aspects at its path.
function entityAspectsV2(
    model: SemanticModel, entity: Entity): Record<string, Record<string, any>> {
  const fields = declaredFields(model, entity);
  return compact({
    'semantic-entity': entityAspectDataV2(model, entity),
    'schema': schemaAspectDataV2(fields),
    ...objectAspectsV2(entity),
    ...Object.assign(
        {}, ...fields.map(f => objectAspectsV2(f, `@Schema.${f.name}`))),
    'sql-expressions': fieldExpressionsData(model, entity),
  });
}

// The built-in schema aspect under the second-generation types, one record per
// field. `is_time` is written only when the document declares it.
function schemaAspectDataV2(fields: Field[]): Record<string, any> {
  return {
    fields: fields.map(f => {
      const type = f.type ?? 'Opaque';
      const annotations = compact({
        label: f.label || undefined,
        is_time: f.dimension?.isTime?.toString(),
      });
      return compact({
        name: f.name,
        description: f.description,
        dataType: type,
        metadataType: columnMetadataType(type),
        semantic: f.dimension ? 'DIMENSION' : undefined,
        synonyms: nonEmpty(f.aiContext?.synonyms),
        annotations: Object.keys(annotations).length ? annotations : undefined,
      });
    }),
  };
}

// semantic-entity under the second-generation types: the entity's source and
// keys as written, its direct parents, whether it is abstract, its synonyms,
// and one record per named profile that lists it, holding what that profile
// states. Anything empty is left out.
function entityAspectDataV2(
    model: SemanticModel, entity: Entity): Record<string, any> {
  const profiles = namedProfiles(model).flatMap(p => {
    const bound = p.entities.find(b => b.name === entity.name);
    if (!bound) return [];
    return [compact({
      name: p.name,
      source: bound.source ? {resource: bound.source} : undefined,
      excludedFields: nonEmpty(bound.fieldsExclude),
      ...keysData(bound.primaryKey, bound.uniqueKeys),
    })];
  });
  return compact({
    source: entity.authoredSource ? {resource: entity.authoredSource} :
                                    undefined,
    ...keysData(entity.keys, entity.uniqueKeys),
    profiles: nonEmpty(profiles),
    extends: nonEmpty(entity.extends),
    abstract: entity.abstract || undefined,
    synonyms: nonEmpty(entity.aiContext?.synonyms),
  });
}

// The `primaryKey` and `uniqueConstraints` of semantic-entity or a profile
// record, each undefined when empty. A unique key with no column is left out.
function keysData(
    primaryKey: readonly string[]|undefined,
    uniqueKeys: readonly string[][]|undefined): Record<string, any> {
  return {
    primaryKey: primaryKey?.length ? {fields: [...primaryKey]} : undefined,
    uniqueConstraints: nonEmpty(
        uniqueKeys?.filter(k => k.length).map(k => ({fields: [...k]}))),
  };
}

// The sql-expressions aspect of an entity entry: the records of the entity's
// own fields, then those of each named profile that lists it, with the
// profile's name in `qualifier`. Returns undefined when there is no record.
function fieldExpressionsData(
    model: SemanticModel, entity: Entity): Record<string, any>|undefined {
  const records =
      (fields: ReadonlyArray<Pick<Field, 'name'|'dialects'|'stringForm'>>,
       qualifier?: string) =>
          fields.flatMap(
              f => expressionRecords(f).map(
                  r => compact({name: f.name, qualifier, ...r})));
  const fieldExpressions = [
    ...records(entity.fields),
    ...namedProfiles(model).flatMap(
        p => records(
            p.entities.find(b => b.name === entity.name)?.fields ?? [],
            p.name)),
  ];
  return fieldExpressions.length ? {fieldExpressions} : undefined;
}

// The aspects of a metric entry under the second-generation types.
function metricAspectsV2(
    model: SemanticModel, metric: Metric): Record<string, any> {
  const expressions = expressionRecords(metric);
  return compact({
    'semantic-metric': metricAspectDataV2(model, metric),
    ...objectAspectsV2(metric),
    'sql-expressions': expressions.length ? {expressions} : undefined,
  });
}

// The semantic-metric aspect of the second-generation types. `entity` is the
// metric's entity, declared or derived.
function metricAspectDataV2(
    model: SemanticModel, metric: Metric): Record<string, any> {
  const type = metric.type ?? 'Opaque';
  const excludedIn = namedProfiles(model)
                         .filter(p => p.metricsExclude === '*' ||
                                     p.metricsExclude?.includes(metric.name))
                         .map(p => p.name);
  return compact({
    entity: metric.entity,
    dataType: type,
    metadataType: columnMetadataType(type),
    synonyms: nonEmpty(metric.aiContext?.synonyms),
    excludedInProfiles: nonEmpty(excludedIn),
  });
}

// The records of one expression, in the order written. A plain string gives
// one record with no `dialect`, so a pull can tell it from a dialect list.
function expressionRecords({dialects = [], stringForm}: Pick<
    Field, 'dialects'|'stringForm'>): Array<{dialect?: string; sql: string}> {
  return stringForm ?
      [{sql: dialects[0].expression}] :
      dialects.map(d => ({dialect: d.dialect, sql: d.expression}));
}

// The model's named profiles, in declaration order. The default profile has no
// record of its own.
function namedProfiles(model: SemanticModel): ProfileSpec[] {
  return (model.profiles ?? []).filter(p => p.name !== DEFAULT_PROFILE);
}


// Maps the IR's logical DataType to the schema aspect's required `metadataType`
// enum (BOOLEAN/NUMBER/STRING/BYTES/DATETIME/TIMESTAMP/GEOSPATIAL/STRUCT/RANGE/
// OTHER). Numeric types collapse to NUMBER; unknown/undefined falls back to
// STRING (the loader leaves most fields un-typed).
function columnMetadataType(type: DataType|undefined): string {
  switch (type) {
    case 'Integer':
    case 'Decimal':
    case 'Float':
      return 'NUMBER';
    case 'Boolean':
      return 'BOOLEAN';
    case 'Date':
    case 'Time':
    case 'DateTime':
      return 'DATETIME';
    case 'DateTimeTz':
      return 'TIMESTAMP';
    case 'Opaque':
      return 'OTHER';
    case 'String':
    default:
      return 'STRING';
  }
}


// ---------------------------------------------------------------------------
// Naming and small helpers.
// ---------------------------------------------------------------------------

// Wraps aspect data (keyed by bare type id, with an optional `@<path>`) as the
// client's aspect map: each key is the `project.location.type` reference form
// with the same path, each value the fully-qualified aspectType plus its data.
function aspectMap(names: Namer, byType: Record<string, Record<string, any>>):
    Record<string, Aspect> {
  const out: Record<string, Aspect> = {};
  for (const [key, data] of Object.entries(byType)) {
    const type = key.split('@')[0];
    out[names.aspectRef(type) + key.slice(type.length)] = {
      aspectType: names.typeName('aspect', type),
      data
    };
  }
  return out;
}

// The native catalog entry source (display name + description), separate from
// the semantic-* aspect copy that carries full model fidelity.
function source(
    displayName: string, description?: string): Entry['entrySource'] {
  return compact({displayName, description}) as Entry['entrySource'];
}

// Drops undefined-valued keys so the emitted JSON (and its golden) only shows
// fields the model actually set — matching how the BigQuery emitter omits empty
// OPTIONS rather than rendering blanks.
function compact<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

// Records a generated entry id in `seen`, returning true when it is new. On a
// repeat it warns and returns false so the caller skips that resource: two
// entries sharing one name would otherwise have the later write silently
// overwrite the earlier one on publish.
function claim(
    seen: Set<string>, id: string, kind: string, label: string,
    warnings: string[]): boolean {
  if (seen.has(id)) {
    warnings.push(
        `${label}: generated ${kind} id '${id}' duplicates an earlier one; ` +
        `skipped (rename to avoid overwriting it on publish)`);
    return false;
  }
  seen.add(id);
  return true;
}
