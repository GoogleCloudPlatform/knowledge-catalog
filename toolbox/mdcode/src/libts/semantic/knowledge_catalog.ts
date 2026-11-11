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
// The `semantic-model`, `semantic-entity`, `semantic-metric` and
// `semantic-relationship` entry and aspect types, the `semantic-link` entry
// link and aspect types, and the other types this emitter references (the
// `schema`, `guidelines`, `semantic-extensions`, `overview` and
// `sql-expressions` aspect types and the `reference` entry link type) are
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
// custom `ai_context` members. Extended Google-profile constructs that have no
// slot in the closed built-in templates ride a synthesized `GOOGLE` entry in
// `semantic-extensions` (see kc_annotations.ts) alongside human- and
// agent-readable description trailers.
//
// Each relationship is an entry, `<model>/relationships/<name>`, that carries
// semantic-relationship. A `semantic-link` entry link joins each distinct
// pair of related entities and lists their relationships in declaration order
// (self-referential edges skip `semantic-link`, since Dataplex rejects a link
// from an entry to itself). A `reference` link runs from each relationship
// entry to each of its distinct endpoint entities, and from each entity entry
// to the entry of each parent it extends.

import type {Aspect, Entry, EntryLink} from '../gcp/dataplex';
import type {OverviewSidecar} from '../layouts/semantic-model';

import {ConstraintRates, constraintsTrailer, PlannedEnforcement} from './constraint_enforcement';
import {derivedTrailers} from './derived_relationships';
import {snakeCase, viewRef} from './generated_views';
import {resolveRelationship} from './hydration';
import {hydrationTrailer} from './hydration_kc';
import {AiContext, CustomExtension, DataType, DeploymentSpec, Entity, Field, Metric, ProfileSpec, Relationship, SemanticModel} from './ir';
import {actionEntries} from './kc_actions';
import {BigQueryEntryLocator, entityGoogleExt, EntityPhysical, firstBigQueryTarget, GOOGLE_EXTENSION_VENDOR, modelGoogleExt, relationshipGoogleExt} from './kc_annotations';
import {constraintEntries} from './kc_constraints';
import {bindingLinkId, Namer, ownedEntryIdPrefixes, semanticLinkId} from './kc_ids';
import {asResourceName, GOOGLE_VERSION} from './loader';
import {lowerNodeViews} from './node_views';
import {nonEmpty} from './osi_converter';
import {DESCRIPTION_MAX, metricQueries, readThroughTrailer, relationshipItems, relationshipsTrailer, withContentsTrailer, withQueryTrailer} from './read_trailers';
import {DEFAULT_PROFILE, inheritedNamesOf, statesKey, withoutExclusions} from './resolve_profiles';
import {entityTrailers, withUnitTrailer} from './units_history';
import {generatesVocabularyView, membersTrailer, vocabularyViewName} from './vocabulary';

export type {BigQueryEntryLocator, EntityPhysical} from './kc_annotations';
export {bindingLinkPrefix} from './kc_ids';

export interface KcGenerateOptions {
  project: string;     // project the entries are created in (destination)
  location: string;    // destination location
  entryGroup: string;  // destination entry group
  systemTypeProject?: string;   // default 'dataplex-types'
  systemTypeLocation?: string;  // default 'global'
  // The overview sidecar of each entry, by entry id, which fills its overview
  // beside the examples.
  overviews?: ReadonlyMap<string, OverviewSidecar>;
  // Where the BigQuery entries of the model's physical assets live, resolved by
  // the caller. Absent = no `@bigquery` binding links.
  bigQueryEntries?: BigQueryEntryLocator;
  // Per model name, how often each constraint breaks in the node views that
  // enforce constraints (measured after the BigQuery leg).
  constraintRates?: ReadonlyMap<string, ConstraintRates>;
  // Append derived runtime grounding paragraphs (`Contents:`, `Read through:`,
  // `Relationships:`, `Query:`) to entry descriptions for `lookup_context`
  // agents. Automatically enabled when `bigQueryEntries` or `constraintRates`
  // is supplied; off on bare offline calls so emitter goldens stay minimal.
  groundingTrailers?: boolean;
}

export interface KcResources {
  entries: Entry[];
  entryLinks: EntryLink[];
  // Cross-entry-group `schema-join` links from entity entries to their
  // `@bigquery` view/table and property-graph node entries (present when
  // `opts.bigQueryEntries` is passed).
  bindingLinks?: EntryLink[];
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

// Trailing paragraph markers shared with `kc_converter.ts`.
export const SPECIALIZES_PREFIX = 'Specializes: ';
export const INVERSE_PREFIX = 'Inverse: ';
export const ABSTRACT_MARKER = 'Abstract: no table of its own.';
export const RELATIONSHIP_ABSTRACT_MARKER =
    'Abstract: no edge table of its own.';
export const DEFINED_AS_PREFIX = 'Defined as: ';
export const DEFINITION_NOTE_PREFIX = 'Definition note: ';

// The most an entity's `Constraints:` paragraph may take, so the
// relationships paragraph keeps room on an entity with many rules.
const CONSTRAINTS_MAX = 800;

/** Folds line breaks (and the indentation around them) to one space. */
export function oneParagraph(text: string): string {
  return text.trim().replace(/\s*\n\s*/g, ' ');
}

/**
 * Generates the Knowledge Catalog resources for a semantic model.
 *
 * Returns the entries (model anchor first, then entities, metrics,
 * relationships, actions and constraints), the entry links of the
 * relationships and of each entity's parents, optional `@bigquery`
 * `bindingLinks`, and any warnings collected while mapping the IR. The
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

  const readable = Boolean(
      opts.groundingTrailers || opts.bigQueryEntries || opts.constraintRates);
  const physical = physicalBindings(model);
  const enforcement = readable ? nodeViewEnforcement(model) : new Map();
  const modelRates = opts.constraintRates?.get(model.name);
  const queries = readable ? metricQueries(model) : new Map<string, string>();

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
  claim(seen, modelId, `model '${model.name}'`, warnings);

  const entries: Entry[] = [{
    name: modelEntryName,
    entryType: names.typeName('entry', 'semantic-model'),
    entrySource: source(
        model.name, readable ? withContentsTrailer(model) : model.description),
    aspects: aspectMap(names, {
      'semantic-model': modelAspectData(model),
      ...objectAspects(model, '', modelGoogleExt(model)),
    }),
  }];

  // Maps an entity's model name to its published entry name, so a relationship
  // can resolve its endpoints to the entries the link references. Only entities
  // actually emitted (not skipped for a duplicate id) are recorded.
  const entityEntryName = new Map<string, string>();
  for (const entity of entities) {
    const entityId = names.entityId(model, entity);
    if (!claim(seen, entityId, `entity '${entity.name}'`, warnings))
      continue;
    entityEntryName.set(entity.name, names.entry(entityId));
    if (lacksKeys(model, entity)) {
      warnings.push(
          `entity '${entity.name}': no keys declared in the source model; ` +
          `declare primary_key or unique_keys in the model file or in a ` +
          `profile to record a key in Knowledge Catalog`);
    }
    const entityRates = modelRates?.get(entity.name);
    const description = entityDescription(
        entity, model, readable ? physical.get(entity.name) : undefined,
        readable ? relationshipItems(entity, model, physical) : [],
        enforcement.get(entity.name), entityRates);
    entries.push({
      name: names.entry(entityId),
      entryType: names.typeName('entry', 'semantic-entity'),
      parentEntry: modelEntryName,
      entrySource: source(entity.name, description),
      // semantic-entity and schema are required. The file header lists the
      // optional aspects.
      aspects: aspectMap(names, entityAspects(model, entity)),
    });
  }

  for (const metric of metrics) {
    const metricId = names.metricId(model, metric);
    if (!claim(seen, metricId, `metric '${metric.name}'`, warnings))
      continue;
    const metricDesc = readable ?
        withQueryTrailer(metric.description, queries.get(metric.name)) :
        metric.description;
    entries.push({
      name: names.entry(metricId),
      entryType: names.typeName('entry', 'semantic-metric'),
      parentEntry: modelEntryName,
      entrySource: source(metric.name, metricDesc),
      aspects: aspectMap(names, metricAspects(model, metric)),
    });
  }

  const relationships = relationshipResources(
      names, model, modelEntryName, entityEntryName, seen, warnings);
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
    claim: (id: string, label: string) => claim(seen, id, label, warnings),
  }, warnings));

  // One entry per constraint, on the same footing as an action: no built-in
  // system type, so the custom pair declared in `kc_custom_types.ts`, filled by
  // `kc_constraints.ts`. Nothing when the model declares no constraints.
  entries.push(...constraintEntries(model, modelId, {
    project: opts.project,
    entry: (id: string) => names.entry(id),
    anchor: modelEntryName,
    claim: (id: string, label: string) => claim(seen, id, label, warnings),
  }, warnings));

  const bindingLinks = opts.bigQueryEntries ?
      bindingLinksFor(
          names, model, physical, entityEntryName, opts.bigQueryEntries,
          opts.location, warnings) :
      undefined;

  return {
    entries,
    entryLinks: [
      ...relationships.links,
      ...extendsLinks(names, model, entityEntryName),
    ],
    ...(bindingLinks ? {bindingLinks} : {}),
    warnings: [...new Set(warnings)],
    ownedPrefixes: ownedEntryIdPrefixes(model.name),
  };
}


// The relationship entries and their links: an entry per relationship
// (including abstract, derived, many-to-many, and self-referential edges), a
// semantic-link per distinct non-self entity pair listing its relationships in
// declaration order, and a reference link from each relationship entry to each
// of its distinct endpoint entities.
function relationshipResources(
    names: Namer, model: SemanticModel, modelEntryName: string,
    entityEntryName: ReadonlyMap<string, string>, seen: Set<string>,
    warnings: string[]): {entries: Entry[]; links: EntryLink[]} {
  const entries: Entry[] = [];
  const references: EntryLink[] = [];
  // The relationships of each ordered entity pair, by link ID.
  const pairs =
      new Map<string, {from: string; to: string; relationships: string[]}>();
  // Dataplex allows at most one `semantic-link` between any unordered pair of
  // entity entries. Track the first direction that claimed each unordered pair.
  const pairDirection =
      new Map<string, {from: string; to: string; firstRel: string}>();

  for (const rel of model.relationships ?? []) {
    const id = names.relationshipId(model, rel);
    if (!claim(seen, id, `relationship '${rel.name}'`, warnings)) continue;
    entries.push({
      name: names.entry(id),
      entryType: names.typeName('entry', 'semantic-relationship'),
      parentEntry: modelEntryName,
      entrySource: source(rel.name, joinDescription(rel)),
      aspects: aspectMap(names, {
        'semantic-relationship': relationshipAspectData(model, rel),
        ...objectAspects(rel, '', relationshipGoogleExt(rel)),
      }),
    });
    const from = rel.source.entity;
    const to = rel.destination.entity;
    const fromEntry = entityEntryName.get(from);
    const toEntry = entityEntryName.get(to);
    // When `from === to` (a self-referential edge, e.g. `parentAccount` or
    // `reportsTo`), emit only one `reference` link between the relationship
    // entry and the entity entry, and skip `semantic-link` (Dataplex rejects
    // both duplicate-pair `reference` links and self-referencing links).
    const ends: Array<[string, string|undefined]> = from === to ?
        [['source', fromEntry]] :
        [['source', fromEntry], ['target', toEntry]];
    for (const [end, targetEntry] of ends) {
      if (!targetEntry) continue;
      references.push(directedLink(
          names, 'reference',
          semanticLinkId('relationship', model.name, rel.name, end),
          names.entry(id), targetEntry));
    }
    if (!fromEntry || !toEntry || from === to) continue;

    const unordered = [from, to].sort().join('\0');
    const claimed = pairDirection.get(unordered);
    if (claimed && (claimed.from !== from || claimed.to !== to)) {
      warnings.push(
          `relationship '${rel.name}': runs from '${from}' to '${to}', ` +
          `opposite to '${claimed.firstRel}' ('${claimed.from}' -> '${
              claimed.to}'); its semantic-relationship entry is published, ` +
          `and the reverse semantic-link is skipped because Knowledge ` +
          `Catalog allows one semantic-link per entity pair.`);
      continue;
    }
    if (!claimed) {
      pairDirection.set(unordered, {from, to, firstRel: rel.name});
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
  return (model.entities ?? []).flatMap(e => {
    const childEntry = entityEntryName.get(e.name);
    if (!childEntry) return [];
    return [...new Set(e.extends ?? [])].flatMap(parent => {
      const parentEntry = entityEntryName.get(parent);
      if (!parentEntry || parent === e.name) return [];
      return [directedLink(
          names, 'reference',
          semanticLinkId('extends', model.name, e.name, parent),
          childEntry, parentEntry)];
    });
  });
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

// Relationship description with trailing Specializes, Abstract, Inverse and
// Derived paragraphs, in fixed order so pull peels them off in reverse.
function joinDescription(rel: Relationship): string|undefined {
  const parts = [
    rel.description,
    rel.extends?.length ?
        `${SPECIALIZES_PREFIX}${rel.extends.join(', ')}.` :
        undefined,
    rel.abstract ? RELATIONSHIP_ABSTRACT_MARKER : undefined,
    rel.inverse ? `${INVERSE_PREFIX}${rel.inverse}.` : undefined,
    ...derivedTrailers(rel),
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join('\n\n') : undefined;
}

// Entity description with fixed-order semantic and grounding trailers, peeled
// in reverse on pull (`kc_converter.readEntityV2`).
function entityDescription(
    entity: Entity, model?: SemanticModel, physical?: EntityPhysical,
    relItems: string[] = [], enforcement?: PlannedEnforcement,
    rates?: ReadonlyMap<string, {violations: number; total: number}>):
    string|undefined {
  const head = [
    entity.description,
    entity.extends?.length ?
        `${SPECIALIZES_PREFIX}${entity.extends.join(', ')}.` :
        undefined,
    entity.abstract ? ABSTRACT_MARKER : undefined,
    entity.definition?.description?.trim() ?
        `${DEFINITION_NOTE_PREFIX}${
            oneParagraph(entity.definition.description)}` :
        undefined,
    entity.definition ?
        `${DEFINED_AS_PREFIX}${oneParagraph(entity.definition.expression)}` :
        undefined,
    ...entityTrailers(entity),
    membersTrailer(entity),
    readThroughTrailer(entity, physical),
  ].filter((p): p is string => !!p);

  const hydration = hydrationTrailer(
      entity,
      model ? field => resolveRelationship(model, entity, field)
                           ?.destination.entity :
              undefined);
  const fixed = [...head, hydration].filter(p => !!p).join('\n\n').length;
  const constraints = constraintsTrailer(
      enforcement?.plan, rates ? new Map(rates) : undefined,
      Math.min(CONSTRAINTS_MAX, DESCRIPTION_MAX - fixed - 2));
  const used =
      [...head, constraints, hydration].filter(p => !!p).join('\n\n').length;
  const relationships =
      relationshipsTrailer(relItems, DESCRIPTION_MAX - used - 2);
  const parts = [...head, relationships, constraints, hydration].filter(
      (p): p is string => !!p);
  return parts.length ? parts.join('\n\n') : undefined;
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

// True when `entity` is a table-backed concrete entity and states no primary
// key and no unique key, in its own bindings or in any named profile.
// Abstract, defined, vocabulary and relationship-derived entities need no
// table key by design.
function lacksKeys(model: SemanticModel, entity: Entity): boolean {
  if (entity.abstract || entity.definition || entity.members !== undefined ||
      entity.hydration?.deriveFrom) {
    return false;
  }
  const bindings = namedProfiles(model).flatMap(
      p => p.entities.filter(b => b.name === entity.name));
  if (bindings.some(b => b.hydration?.deriveFrom)) return false;
  return !statesKey(entity.keys, entity.uniqueKeys) &&
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
function objectAspects(
    object: {aiContext?: AiContext; customExtensions?: CustomExtension[]},
    at = '', googleData?: Record<string, any>): Record<string, any> {
  const examples = object.aiContext?.examples ?? [];
  return compact({
    [`guidelines${at}`]: guidelinesAspectData(object.aiContext),
    [`semantic-extensions${at}`]:
        extensionsAspectData(object.customExtensions, googleData),
    [`overview${at}`]: examples.length ?
        {examples: examples.map(content => ({content}))} :
        undefined,
  });
}

// The guidelines aspect: the object's instructions, and in `data` its custom
// ai_context members by name, leaving out those `unstorableValue` names.
// Undefined when the object has neither.
function guidelinesAspectData(ai: AiContext|undefined): Record<string, any>|
    undefined {
  const members = Object.entries(ai?.additionalProperties ?? {})
                      .filter(([, value]) => !unstorableValue(value));
  const data = members.length ? Object.fromEntries(members) : undefined;
  const instructions = ai?.instructions || undefined;
  if (!instructions && !data) return undefined;
  return compact({instructions, data, userManaged: true});
}

// semantic-extensions: every extension block from a vendor other than GOOGLE,
// as written and in order, plus a synthesized GOOGLE block when the object
// carries extended Google-profile IR constructs (`googleData`). Undefined when
// there is neither.
function extensionsAspectData(
    extensions: CustomExtension[]|undefined,
    googleData?: Record<string, any>): Record<string, any>|undefined {
  const blocks = (extensions ?? [])
                     .filter(x => x.vendorName !== GOOGLE_EXTENSION_VENDOR);
  if (googleData && Object.keys(googleData).length > 0) {
    blocks.push({
      vendorName: GOOGLE_EXTENSION_VENDOR,
      data: JSON.stringify(googleData),
    });
  }
  return blocks.length ? {customExtensions: blocks} : undefined;
}

// The semantic-model aspect.
function modelAspectData(model: SemanticModel): Record<string, any> {
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

// The aspects of an entity entry. Its schema lists the fields it declares, each
// with its own aspects at its path.
function entityAspects(
    model: SemanticModel, entity: Entity): Record<string, Record<string, any>> {
  const fields = declaredFields(model, entity);
  const profiles = namedProfiles(model);
  return compact({
    'semantic-entity': entityAspectData(model, entity),
    'schema': schemaAspectData(fields),
    ...objectAspects(entity, '', entityGoogleExt(entity, profiles)),
    ...Object.assign(
        {},
        ...fields.map(
            f => objectAspects(f, `@Schema.${f.name}`))),
    'sql-expressions': fieldExpressionsData(model, entity),
  });
}

// The built-in schema aspect, one record per field. `is_time` is written only
// when the document declares it. `withUnitTrailer` appends any K7 unit / scale
// paragraph to `description`.
function schemaAspectData(fields: Field[]): Record<string, any> {
  return {
    fields: fields.map(f => {
      const type = f.type ?? 'Opaque';
      const annotations = compact({
        label: f.label || undefined,
        is_time: f.dimension?.isTime?.toString(),
      });
      return compact({
        name: f.name,
        description: withUnitTrailer(f.description, f),
        dataType: type,
        metadataType: columnMetadataType(type),
        semantic: f.dimension ? 'DIMENSION' : undefined,
        synonyms: nonEmpty(f.aiContext?.synonyms),
        annotations: Object.keys(annotations).length ? annotations : undefined,
      });
    }),
  };
}

// Resolves the resource string to store in `semantic-entity.source.resource`:
// `entity.authoredSource` when present, falling back to a GCP resource name
// synthesized from `entity.dataSource` for in-memory IR models.
function entitySourceResource(entity: Entity): string|undefined {
  if (entity.authoredSource) return entity.authoredSource;
  const trimmed = (entity.dataSource ?? '').trim();
  if (!trimmed || trimmed.startsWith('unbound:')) return undefined;
  if (trimmed.includes('/') || trimmed.includes(':') || /\s/.test(trimmed)) {
    return asResourceName(trimmed);
  }
  const parts = trimmed.split('.').map(unquote);
  if (parts.length === 3 && parts.every(p => p.length > 0)) {
    return `bigquery.googleapis.com/projects/${parts[0]}/datasets/${
        parts[1]}/tables/${parts[2]}`;
  }
  return trimmed;
}

// The semantic-entity aspect: the entity's source and keys as written, its
// direct parents, whether it is abstract, its synonyms, and one record per
// named profile that lists it, holding what that profile states. Anything
// empty is left out.
function entityAspectData(
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
  const resource = entitySourceResource(entity);
  return compact({
    source: resource ? {resource} : undefined,
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
      (fields: ReadonlyArray<Pick<
           Field,
           'name'|'dialects'|'stringForm'|'expression'|'importedExpression'|
           'importedDialect'>>,
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

// The aspects of a metric entry.
function metricAspects(
    model: SemanticModel, metric: Metric): Record<string, any> {
  const expressions = expressionRecords(metric);
  return compact({
    'semantic-metric': metricAspectData(model, metric),
    ...objectAspects(metric, ''),
    'sql-expressions': expressions.length ? {expressions} : undefined,
  });
}

// The semantic-metric aspect. `entity` is the metric's entity, declared or
// derived.
function metricAspectData(
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
// Falls back to `expression` / `importedExpression` when `dialects` is absent
// (IR constructed directly in memory without `loader.ts`).
function expressionRecords(x: Pick<
    Field,
    'dialects'|'stringForm'|'expression'|'importedExpression'|
    'importedDialect'>): Array<{dialect?: string; sql: string}> {
  if (x.dialects?.length) {
    return x.stringForm ?
        [{sql: x.dialects[0].expression}] :
        x.dialects.map(d => ({dialect: d.dialect, sql: d.expression}));
  }
  const out: Array<{dialect?: string; sql: string}> = [];
  if (x.expression !== undefined) {
    out.push(
        x.stringForm ? {sql: x.expression} :
                       {dialect: 'BIGQUERY', sql: x.expression});
  }
  if (x.importedExpression !== undefined && x.importedDialect) {
    out.push({dialect: x.importedDialect, sql: x.importedExpression});
  }
  return out;
}

// The model's named profiles, in declaration order. The default profile has no
// record of its own.
function namedProfiles(model: SemanticModel): ProfileSpec[] {
  return (model.profiles ?? []).filter(p => p.name !== DEFAULT_PROFILE);
}


// Maps the IR's logical DataType to the schema aspect's required `metadataType`
// enum (BOOLEAN/NUMBER/STRING/BYTES/DATETIME/TIMESTAMP/GEOSPATIAL/STRUCT/RANGE/
// OTHER). Numeric types collapse to NUMBER. Callers pass `Opaque` for an
// untyped field or metric, which maps to OTHER.
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
// Physical bindings & `@bigquery` binding links (K3).
// ---------------------------------------------------------------------------

function entityByName(model: SemanticModel, name: string): Entity|undefined {
  return (model.entities ?? []).find(e => e.name === name);
}

/**
 * Per entity, the physical assets the BigQuery leg reads it through: its node
 * view (or its generated vocabulary view), the graph and its node label. Uses
 * the model's first BigQuery graph target and the same pure node-view
 * lowering the graph push runs, so the names match what `kcmd push` deploys.
 * An entity with no table behind it (abstract, defined, unbound) gets none;
 * `mode: direct` gets the graph node but no node view.
 */
export function physicalBindings(model: SemanticModel):
    Map<string, EntityPhysical> {
  const out = new Map<string, EntityPhysical>();
  const target = firstBigQueryTarget(model);
  if (!target) return out;
  const viewTarget = {project: target.project, dataset: target.dataset};
  const nodeViews = new Map<string, string>();
  try {
    for (const v of lowerNodeViews(model, viewTarget, []).views) {
      if (v.kind === 'node' && v.element) nodeViews.set(v.element, v.ref);
    }
  } catch {
    // A model the lowering cannot plan binds directly; the graph push warns.
  }
  const graph = `${target.project}.${target.dataset}.${target.graphName}`;
  for (const e of model.entities ?? []) {
    if (e.abstract || e.definition) continue;
    const vocab = generatesVocabularyView(e);
    const nodeView = nodeViews.get(e.name) ??
        (vocab ? viewRef(vocabularyViewName(e.name), viewTarget) : undefined);
    const bound = !!nodeView ||
        (!!(e.dataSource ?? '').trim() &&
         !(e.dataSource ?? '').trim().startsWith('unbound:'));
    if (!bound) continue;
    out.set(e.name, {
      ...(nodeView ? {nodeView} : {}),
      graph,
      graphNode: e.name,
    });
  }
  return out;
}

/**
 * Per entity whose binding sets `hydration.constraints: enforce`, the rules its
 * node view applies and reports, from the same lowering the graph push runs
 * (on the model's first BigQuery graph target). Empty without one.
 */
export function nodeViewEnforcement(model: SemanticModel):
    Map<string, PlannedEnforcement> {
  const target = firstBigQueryTarget(model);
  if (!target) return new Map();
  try {
    return lowerNodeViews(
               model, {project: target.project, dataset: target.dataset}, [])
        .enforcement;
  } catch {
    return new Map();
  }
}

// The `@bigquery` entry of a `project.dataset.table` reference, or undefined
// when the reference is not three plain parts or its dataset was not located.
function bigQueryEntryName(
    ref: string, locator: BigQueryEntryLocator, suffix = ''): string|undefined {
  const parts = ref.trim().split('.').map(unquote);
  if (parts.length !== 3 || !parts.every(p => p && !/\s/.test(p)))
    return undefined;
  const [project, dataset, table] = parts;
  const location = locator.datasetLocations.get(`${project}.${dataset}`);
  if (!location) return undefined;
  const number = locator.projectNumbers?.get(project) ?? project;
  return `projects/${number}/locations/${location.toLowerCase()}/entryGroups/` +
      `@bigquery/entries/bigquery.googleapis.com/projects/${project}/` +
      `datasets/${dataset}/${suffix || `tables/${table}`}`;
}

/**
 * The `@bigquery` entry of a property graph's node label. Dataplex indexes each
 * node table of a graph as a `bigquery-graph-node` entry under the graph's own
 * entry, named by its label.
 */
export function graphNodeEntryName(
    graph: string, label: string, locator: BigQueryEntryLocator): string|
    undefined {
  const [project, dataset, name] = graph.split('.');
  return bigQueryEntryName(
      `${project}.${dataset}.${name}`, locator,
      `propertyGraphs/${name}/nodes/${label}`);
}

/**
 * K3: per bound entity, a schema-join from its V2 entity entry to the
 * `@bigquery` entry it is read through (the node view; the table itself under
 * `mode: direct` or when no view is generated) and one to its graph node
 * entry. A target whose dataset the locator does not know, or that lives in
 * another region than the model's entry group (`location`), is skipped with a
 * warning.
 */
function bindingLinksFor(
    names: Namer, model: SemanticModel, physical: Map<string, EntityPhysical>,
    entityEntryName: Map<string, string>, locator: BigQueryEntryLocator,
    location: string, warnings: string[]): EntryLink[] {
  const links: EntryLink[] = [];
  const seenIds = new Set<string>();
  const elsewhere = new Map<string, number>();  // region -> links skipped
  for (const [entityName, phys] of physical) {
    const entity = entityByName(model, entityName);
    const from = entityEntryName.get(entityName);
    if (!entity || !from) continue;
    const keys = entity.keys ?? [];
    const viewCols = keys.map(snakeCase);
    const tableRef = phys.nodeView ?? entity.dataSource;
    const join = (target: string, targetCols: string[], what: string) =>
        aspectMap(names, {
          'schema-join': {
            joins: [compact({
              source: {name: entity.dataSource || entityName, fields: keys},
              target: {name: target, fields: targetCols},
              description: `Binding: ${entityName} is read through ${what}.`,
              type: 'JOIN',
              inferenceSource: 'USER',
            })],
            userManaged: true,
          },
        });
    const push = (kind: 'view'|'node', to: string|undefined, target: string,
                  cols: string[], what: string) => {
      if (!to) {
        warnings.push(
            `entity '${entityName}': the BigQuery location of '${target}' is ` +
            `unknown, so its binding link to ${what} is skipped.`);
        return;
      }
      const id = bindingLinkId(model.name, kind, entityName);
      if (seenIds.has(id)) return;
      seenIds.add(id);
      const region = to.match(/\/locations\/([^/]+)\//)?.[1] ?? '';
      if (region !== location.toLowerCase()) {
        elsewhere.set(region, (elsewhere.get(region) ?? 0) + 1);
        return;
      }
      links.push({
        name: names.entryLink(id),
        entryLinkType: names.typeName('entryLink', 'schema-join'),
        entryReferences: [
          {name: from, type: 'UNSPECIFIED'},
          {name: to, type: 'UNSPECIFIED'},
        ],
        aspects: join(target, cols, what),
      });
    };
    if (tableRef && !/\s/.test(tableRef.trim())) {
      const isView = !!phys.nodeView;
      push('view', bigQueryEntryName(tableRef, locator), tableRef,
           isView ? viewCols : keys,
           isView ? `node view ${tableRef}` : `table ${tableRef}`);
    }
    if (phys.graph && phys.graphNode) {
      push('node', graphNodeEntryName(phys.graph, phys.graphNode, locator),
           phys.graph, phys.nodeView ? viewCols : keys,
           `graph node ${phys.graph}/${phys.graphNode}`);
    }
  }
  for (const [region, n] of elsewhere) {
    warnings.push(
        `${n} binding link${n === 1 ? '' : 's'} skipped: the entry group is ` +
        `in '${location}' and the BigQuery assets are in '${region}', and an ` +
        `entry link can reference only entries of its own region. Publish the ` +
        `model to an entry group in '${region}' to link its entities to their ` +
        `views and graph nodes.`);
  }
  return links;
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
    seen: Set<string>, id: string, label: string,
    warnings: string[]): boolean {
  if (seen.has(id)) {
    warnings.push(
        `${label}: generated entry id '${id}' duplicates an earlier one; ` +
        `skipped (rename to avoid overwriting it on publish)`);
    return false;
  }
  seen.add(id);
  return true;
}

function unquote(part: string): string {
  return part.replace(/^[`"]/, '').replace(/[`"]$/, '');
}
