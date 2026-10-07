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
// Target schema: the `semantic-model`, `semantic-entity`, and `semantic-metric`
// entry/aspect types are built-in system types under `dataplex-types/global`,
// alongside the built-in `schema` and `guidelines` aspects. This emitter
// references them; it never provisions them. Each entry type declares
// `required_aspects`; the emitted aspect set per entry is those plus the
// optional `guidelines` aspect (attached only when the object carries
// `ai_context.instructions`):
//   * semantic-model entry -> { semantic-model, guidelines? }
//   * semantic-entity entry -> { semantic-entity, schema, guidelines? }
//   * semantic-metric entry -> { semantic-metric, guidelines? }
//
// An action (a write operation the model defines) and a constraint (an
// invariant the model states) are published the same way: one entry each,
// parented to the anchor. Their entry and aspect types are CUSTOM, because
// Dataplex has no built-in type for either yet, so `kcmd init` provisions the
// pairs in the destination project. `kc_custom_types.ts` declares those types
// and `kc_actions.ts` and `kc_constraints.ts` encode the aspects they carry.
// This module only appends the entries those two return.
//
// Aspect data shapes mirror the aspect types' CLOSED metadataTemplates exactly
// (a server aspect type rejects an undeclared data field):
//   * semantic-model  = { deploymentTargets: string[] }
//   * semantic-entity = { source: { resources: string[], importedSystem?,
//                                    importedResource? } }
//   * semantic-metric = { entity?, dataType (required) }
//   * schema          = { fields: [{ name, dataType, metadataType,
//                                    description?, annotations? }],
//                         primaryKey?: { fields }, uniqueConstraints?: [...] }
//   * guidelines      = { instructions, userManaged (required) }
//
// The SQL-expression fields -- `semantic-metric.expression` and the per-field
// `schema.semantics` { expression, role } block -- are NOT in the published
// system-type templates yet, so they are gated behind
// KcGenerateOptions.emitExpressions (off by default) and omitted above. The
// `semantic-expressions` annotation aspect below carries them losslessly
// instead, whenever it is provisioned.
//
// Annotation aspects (K1). What the closed templates above cannot hold -- the
// whole ai_context (synonyms, examples, field-level), expressions and logical
// types, binding mode, hydration, vocabulary members, verbatim relationship
// names -- rides three aspect-only CUSTOM types `kcmd init` provisions
// (`semantic-ai-context`, `semantic-expressions`, `semantic-binding`; see
// kc_annotations.ts). The caller passes the provisioned ids in
// KcGenerateOptions.customAspects; none provisioned = the pre-K1 output.
//
// Relationships become `schema-join` entry links between the two entity entries.
// schema-join is a built-in, undirected entry link type in `dataplex-types/global`
// whose required `schema-join` aspect carries the join detail (the paired join
// columns, JOIN vs FOREIGN_KEY, USER inference). The join's direction -- which
// side holds the foreign key -- is preserved inside that aspect, not by the link.
// A many-to-many (association) edge is published through its junction table:
// one `semantic-entity` entry for the junction (id `<model>.associations.<rel>`)
// and two schema-join links, junction -> source (`-src`) and junction ->
// destination (`-dst`). The junction's `semantic-binding` aspect names the
// relationship, so a pull folds the three back into one relationship.
//
// Binding links (K3). When the caller resolves where the BigQuery entries live
// (KcGenerateOptions.bigQueryEntries), each bound entity also gets schema-join
// links to the `@bigquery` entry of the table or node view it is read through
// and to its graph node entry, so a reader can walk from the concept to the
// physical asset. They are returned apart (KcResources.bindingLinks) because
// they cross into an entry group kcmd does not own.
//

import type {Aspect, Entry, EntryLink} from '../gcp/dataplex';

import {googleDeploymentTargets} from './deployment_target';
import {snakeCase, viewRef} from './generated_views';
import {resolveRelationship} from './hydration';
import {hydrationTrailer} from './hydration_kc';
import {AiContext, DataType, Entity, Metric, Relationship, SemanticModel} from './ir';
import {actionEntries, actionOwnedPrefix} from './kc_actions';
import {AnnotationTarget, EntityPhysical, entityAnnotationAspects, junctionAnnotationAspects, metricAnnotationAspects, modelAnnotationAspects, RelationshipIndexRow} from './kc_annotations';
import {constraintEntries, constraintOwnedPrefix} from './kc_constraints';
import {AI_CONTEXT_TYPE_ID, BINDING_TYPE_ID} from './kc_custom_types';
import {lowerNodeViews} from './node_views';
import {entityTrailers, withUnitTrailer} from './units_history';
import {derivedTrailers} from './derived_relationships';
import {generatesVocabularyView, membersTrailer, vocabularyViewName} from './vocabulary';

// Where the `semantic-*` and `schema` system types live: built-in types in
// project `dataplex-types`, location `global`. Callers may override to reference
// them from a staging project.
const DEFAULT_TYPE_PROJECT = 'dataplex-types';
const DEFAULT_TYPE_LOCATION = 'global';

export interface KcGenerateOptions {
  project: string;     // project the entries are created in (destination)
  location: string;    // destination location
  entryGroup: string;  // destination entry group
  systemTypeProject?: string;   // default 'dataplex-types'
  systemTypeLocation?: string;  // default 'global'
  // Emit the SQL-expression fields the published Dataplex system-type templates
  // do not carry yet: the per-field `schema.semantics` block (expression +
  // role) and `semantic-metric.expression`. Off by default so a push matches
  // the live types; flip on once the templates gain these fields. Enabling it
  // against today's types fails the push with an ASPECT_*_PARSING_FAILURE on
  // the unknown property.
  emitExpressions?: boolean;
  // The annotation aspect types provisioned in the destination (see
  // kc_custom_types.provisionedCustomAspects; ids from ANNOTATION_ASPECT_IDS).
  // Only these are attached. When `semantic-expressions` is among them every
  // expression is published through it by default, without emitExpressions
  // (which targets fields the built-in templates still lack).
  customAspects?: readonly string[];
  // Where the BigQuery entries of the model's physical assets live, resolved by
  // the caller (a dataset's location and a project's number are API lookups,
  // and this module is pure). Absent = no binding links.
  bigQueryEntries?: BigQueryEntryLocator;
}

/** Resolved names for `@bigquery` entries (see bindingLinksFor). */
export interface BigQueryEntryLocator {
  // `project.dataset` -> the dataset's location (`US`, `europe-west1`, ...),
  // lowercased as Dataplex names it. A dataset missing here gets no links.
  datasetLocations: ReadonlyMap<string, string>;
  // project id -> project number. Optional: Dataplex accepts either form in
  // an entry reference, but echoes the number back on read.
  projectNumbers?: ReadonlyMap<string, string>;
}

export interface KcResources {
  entries: Entry[];
  entryLinks: EntryLink[];
  // K3: links from entity entries to the `@bigquery` table / node view entry
  // and the graph node entry. Written after entryLinks, non-fatally: their
  // targets live outside the entry group and may not exist yet. Absent when
  // the caller supplied no BigQueryEntryLocator (and on the LookML path).
  bindingLinks?: EntryLink[];
  warnings: string[];
  // Entry-id prefixes this model owns, used by delete reconciliation to decide
  // which existing entries a push is allowed to remove. Supplied by the emitter
  // rather than derived by the publisher: the id scheme is the emitter's
  // concern, and origins differ (Ossie uses dotted ids, LookML the KC path
  // form), so the publisher must not assume either.
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
 * Returns the entries (model anchor first, then entities and metrics), the
 * schema-join entry links for the model's relationships, and any warnings
 * collected while mapping the IR (missing keys, un-typed metrics, skipped M:N
 * relationships). The resources reference the built-in system types; they do not
 * create them.
 */
export function generateCatalogResources(
    model: SemanticModel, opts: KcGenerateOptions): KcResources {
  const warnings: string[] = [];
  const entities = model.entities ?? [];
  const metrics = model.metrics ?? [];
  const relationships = model.relationships ?? [];

  if (!entities.length) {
    warnings.push(
        'model has no entities; only the semantic-model entry will be generated');
  }

  const names = new Namer(opts);
  const emitExpr = opts.emitExpressions ?? false;
  const annotations: AnnotationTarget = {
    aspects: new Set(opts.customAspects ?? []),
    dest: {project: opts.project},
  };
  const physical = annotations.aspects.has(BINDING_TYPE_ID) ||
          opts.bigQueryEntries ?
      physicalBindings(model) :
      new Map<string, EntityPhysical>();

  // Entry ids must be unique within the entry group. Two source names that
  // normalize to the same id (see slug), or exact duplicates the loader did not
  // reject, would otherwise emit two entries with the same name and have the
  // later write silently overwrite the earlier. Track ids and skip a collision.
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
    aspects: aspectsFor(
        names, {'semantic-model': modelAspectData(model)}, model.aiContext),
  }];

  // Maps an entity's model name to its published entry name, so a relationship
  // can resolve its endpoints to the entries the link references. Only entities
  // actually emitted (not skipped for a duplicate id) are recorded.
  const entityEntryName = new Map<string, string>();
  // Abstract entities that were published: an edge naming one as an endpoint
  // has no table behind that end, so relationshipLink skips it.
  const abstractEntities = new Set<string>();
  for (const entity of entities) {
    // An abstract entity is a conceptual (table-less) supertype. It is
    // published like any logical-only entity -- the same built-in
    // semantic-entity + schema pair, with an empty `source.resources` and no
    // primaryKey -- so the supertype (Party, CommercialDocument) is a
    // discoverable catalog entry carrying its description, its own fields and
    // its guidelines, and actions / constraints naming it resolve to a
    // published concept. What the closed templates cannot say -- that it is
    // abstract, and which entities it specializes -- rides in the entry
    // description as fixed trailing paragraphs (see entityDescription).
    const entityId = names.entityId(model, entity);
    if (!claim(seen, entityId, 'entry', `entity '${entity.name}'`, warnings))
      continue;
    entityEntryName.set(entity.name, names.entry(entityId));
    if (entity.abstract) abstractEntities.add(entity.name);
    // An abstract entity has no key by design (no table, no rows to identify);
    // a defined one shares its parent's.
    if (!entity.abstract && !entity.definition &&
        (!entity.keys || !entity.keys.length)) {
      warnings.push(
          `entity '${entity.name}': no keys declared in the source model`);
    }
    entries.push({
      name: names.entry(entityId),
      entryType: names.typeName('entry', 'semantic-entity'),
      parentEntry: modelEntryName,
      entrySource: source(entity.name, entityDescription(entity, model)),
      // required_aspects: semantic-entity AND the built-in schema; plus the
      // built-in guidelines aspect when the entity carries ai_context
      // instructions.
      aspects: {
        ...aspectsFor(
            names, {
              'semantic-entity': entityAspectData(entity),
              'schema': schemaAspectData(entity, emitExpr),
            },
            entity.aiContext),
        ...entityAnnotationAspects(
            entity, physical.get(entity.name), annotations),
      },
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
      aspects: {
        ...aspectsFor(
            names, {'semantic-metric': metricAspectData(metric, emitExpr)},
            metric.aiContext),
        ...metricAnnotationAspects(metric, annotations),
      },
    });
  }

  // One entry per action, alongside the entities and metrics. Actions have no
  // built-in system type, so they reference the custom pair declared in
  // `kc_custom_types.ts`, and `kc_actions.ts` fills the aspect; it returns
  // nothing when the model declares no actions.
  entries.push(...actionEntries(model, modelId, {
    project: opts.project,
    entry: (id: string) => names.entry(id),
    anchor: modelEntryName,
    claim: (id: string, label: string) =>
        claim(seen, id, 'entry', label, warnings),
    // Populated by the entity loop above, so it includes abstract entities
    // (published as table-less entries) and excludes only those skipped for
    // a duplicate id.
    publishedEntities: new Set(entityEntryName.keys()),
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

  // Relationships map to schema-join entry links between their endpoint
  // entries; a many-to-many one to a junction entry plus two links.
  const entryLinks: EntryLink[] = [];
  const seenLinks = new Set<string>();
  // With the ai-context aspect provisioned, each relationship's authored name
  // (and ai_context) rides the anchor, so the normalized link id stops being
  // the only record of the name.
  const namesIndexed = annotations.aspects.has(AI_CONTEXT_TYPE_ID);
  const index: RelationshipIndexRow[] = [];
  for (const rel of relationships) {
    if (rel.association) {
      const junction = junctionResources(
          names, model, rel, entityEntryName, abstractEntities, modelEntryName,
          annotations, seen, seenLinks, warnings);
      if (!junction) continue;
      entries.push(junction.entry);
      entryLinks.push(...junction.links);
      index.push(compact({
        name: rel.name,
        link: linkIdOf(junction.links[0]),
        aiContext: rel.aiContext,
      }));
      continue;
    }
    const link = relationshipLink(
        names, model, rel, entityEntryName, abstractEntities, seenLinks,
        warnings, namesIndexed);
    if (!link) {
      // No link to carry it (abstract, or an abstract / column-less
      // endpoint): with the index available the relationship rides there
      // whole, so pull rebuilds it. An endpoint that is not a published
      // entity at all would dangle on read, so that one stays out.
      if (namesIndexed && entityEntryName.has(rel.source.entity) &&
          entityEntryName.has(rel.destination.entity)) {
        const {name, aiContext, ...unpublished} = rel;
        index.push(compact({name, aiContext, unpublished}));
      }
      continue;
    }
    entryLinks.push(link);
    index.push(compact({
      name: rel.name,
      link: linkIdOf(link),
      aiContext: rel.aiContext,
    }));
  }
  Object.assign(
      entries[0].aspects ?? (entries[0].aspects = {}),
      modelAnnotationAspects(model, index, annotations));

  const bindingLinks = opts.bigQueryEntries ?
      bindingLinksFor(
          names, model, physical, entityEntryName, opts.bigQueryEntries,
          warnings) :
      undefined;

  return {
    entries,
    entryLinks,
    ...(bindingLinks ? {bindingLinks} : {}),
    warnings: [...new Set(warnings)],
    // Ossie ids are dotted: `<model>.entities.<name>` / `<model>.metrics.<name>`
    // / `<model>.associations.<name>` / `<model>.actions.<name>` /
    // `<model>.constraints.<name>`.
    ownedPrefixes: [
      `${modelId}.entities.`,
      `${modelId}.metrics.`,
      `${modelId}.associations.`,
      actionOwnedPrefix(modelId),
      constraintOwnedPrefix(modelId),
    ],
  };
}

// The last path segment of an entry link name: its id.
function linkIdOf(link: EntryLink): string {
  const name = link.name ?? '';
  return name.slice(name.lastIndexOf('/') + 1);
}

// The fixed description of a junction entry. Pull recognizes a junction by its
// id (`.associations.`) or its binding aspect, never by this text.
export const JUNCTION_DESCRIPTION_PREFIX = 'Junction table of the many-to-many ' +
    'relationship ';

// A many-to-many relationship as catalog resources: an entry for its junction
// table and two schema-join links, junction -> source (`-src`, which also
// carries the relationship's join description: Specializes / Inverse) and
// junction -> destination (`-dst`). Each link pairs the junction's columns
// for that side with the endpoint's columns (its declared key when the
// relationship names none). Skipped, with a warning, when an endpoint is
// unpublished or abstract.
function junctionResources(
    names: Namer, model: SemanticModel, rel: Relationship,
    entityEntryName: Map<string, string>, abstractEntities: Set<string>,
    modelEntryName: string, annotations: AnnotationTarget, seen: Set<string>,
    seenLinks: Set<string>, warnings: string[]):
    {entry: Entry; links: EntryLink[]}|undefined {
  const assoc = rel.association!;
  const src = entityEntryName.get(rel.source.entity);
  const dst = entityEntryName.get(rel.destination.entity);
  if (!src || !dst) {
    const missing = !src ? rel.source.entity : rel.destination.entity;
    warnings.push(
        `relationship '${rel.name}': endpoint entity '${missing}' is not a ` +
        `published entity; the many-to-many relationship is skipped.`);
    return undefined;
  }
  const abstractEnd = [rel.source.entity, rel.destination.entity].find(
      e => abstractEntities.has(e));
  if (abstractEnd !== undefined) {
    warnings.push(
        `relationship '${rel.name}': endpoint entity '${abstractEnd}' is ` +
        `abstract (no table), so the many-to-many relationship is skipped.`);
    return undefined;
  }
  const entryId = `${slug(model.name)}.associations.${slug(rel.name)}`;
  if (!claim(seen, entryId, 'entry', `relationship '${rel.name}'`, warnings))
    return undefined;
  const base = names.linkId(model, rel).slice(0, 59).replace(/-+$/, '');
  const srcId = `${base}-src`;
  const dstId = `${base}-dst`;
  if (!claim(seenLinks, srcId, 'entry link', `relationship '${rel.name}'`,
             warnings) ||
      !claim(seenLinks, dstId, 'entry link', `relationship '${rel.name}'`,
             warnings))
    return undefined;

  const junction: Entity = {
    name: rel.name,
    dataSource: assoc.dataSource,
    keys: assoc.keys,
    fields: assoc.fields ?? [],
  };
  const entry: Entry = {
    name: names.entry(entryId),
    entryType: names.typeName('entry', 'semantic-entity'),
    parentEntry: modelEntryName,
    entrySource: source(
        rel.name,
        `${JUNCTION_DESCRIPTION_PREFIX}${rel.name} (${rel.source.entity} to ${
            rel.destination.entity}).`),
    aspects: {
      ...aspectMap(names, {
        'semantic-entity': entityAspectData(junction),
        'schema': schemaAspectData(junction, false),
      }),
      // The junction's own fields (edge properties) keep their ai_context and
      // expressions like any entity's; its binding aspect names the
      // relationship instead of a binding mode.
      ...entityAnnotationAspects(junction, undefined, {
        ...annotations,
        aspects: new Set(
            [...annotations.aspects].filter(a => a !== BINDING_TYPE_ID)),
      }),
      ...junctionAnnotationAspects(
          rel.name, rel.source.entity, rel.destination.entity, annotations),
    },
  };

  const endFields = (end: Relationship['source']): string[] => end.columns
      .length ? end.columns : entityByName(model, end.entity)?.keys ?? [];
  const sideLink =
      (id: string, end: Relationship['source'], endEntry: string,
       junctionCols: string[], description?: string): EntryLink => {
        const endEntity = entityByName(model, end.entity);
        return {
          name: names.entryLink(id),
          entryLinkType: names.typeName('entryLink', 'schema-join'),
          entryReferences: [
            {name: entry.name, type: 'UNSPECIFIED'},
            {name: endEntry, type: 'UNSPECIFIED'},
          ],
          aspects: aspectMap(names, {
            'schema-join': {
              joins: [compact({
                source: {name: assoc.dataSource, fields: junctionCols},
                target: {
                  name: endEntity?.dataSource || end.entity,
                  fields: endFields(end),
                },
                description,
                type: 'FOREIGN_KEY',
                inferenceSource: 'USER',
              })],
              userManaged: true,
            },
          }),
        };
      };
  return {
    entry,
    links: [
      sideLink(srcId, rel.source, src, assoc.sourceColumns,
               joinDescription(rel)),
      sideLink(dstId, rel.destination, dst, assoc.destinationColumns),
    ],
  };
}


// Builds the schema-join entry link for one direct relationship, or undefined
// when it cannot be published. (A many-to-many one goes through
// junctionResources instead.) Skipped, each with a warning: an edge whose
// endpoint entity was not emitted (e.g. skipped for a duplicate id) or is
// abstract (no table behind that end); and a column-less (purely logical)
// edge, whose join columns must be added to the model before it can publish.
// The BigQuery property graph still carries the (once bound) direct edges.
// `namesIndexed`: the authored name rides the anchor's ai-context aspect, so
// the link id's normalization loses nothing and is not warned about.
function relationshipLink(
    names: Namer, model: SemanticModel, rel: Relationship,
    entityEntryName: Map<string, string>, abstractEntities: Set<string>,
    seenLinks: Set<string>, warnings: string[],
    namesIndexed = false): EntryLink|undefined {
  // An abstract relationship (relationship inheritance) binds no join by
  // design -- it is a label over its sub-relationships, not an edge -- so it
  // has no schema-join to publish. Its name still reaches Knowledge Catalog on
  // each concrete descendant's join description (see specializesLine). Checked
  // before the endpoints: an abstract relationship typically spans abstract
  // entities (which publish no entry), and "abstract" is the real reason.
  if (rel.abstract) {
    warnings.push(
        `relationship '${rel.name}' is abstract (a super-relationship with no ` +
        `join of its own), so it publishes no schema-join link; its ` +
        `sub-relationships name it in their join descriptions.`);
    return undefined;
  }
  const src = entityEntryName.get(rel.source.entity);
  const dst = entityEntryName.get(rel.destination.entity);
  if (!src || !dst) {
    const missing = !src ? rel.source.entity : rel.destination.entity;
    warnings.push(
        `relationship '${rel.name}': endpoint entity '${missing}' is not a ` +
        `published entity; the relationship link is skipped.`);
    return undefined;
  }
  // An abstract endpoint is published, but as a table-less entry: a join has
  // no columns to pair on that side, so there is no schema-join to write.
  const abstractEnd = [rel.source.entity, rel.destination.entity].find(
      e => abstractEntities.has(e));
  if (abstractEnd !== undefined) {
    warnings.push(
        `relationship '${rel.name}': endpoint entity '${abstractEnd}' is ` +
        `abstract (no table), so the relationship link is skipped.`);
    return undefined;
  }
  // A purely logical edge (an OWL import) carries no join columns. schema-join
  // is a server-defined CLOSED metadataTemplate whose `fields` requirement we
  // cannot depend on, so rather than risk a rejected aspect on a KC push we skip
  // the link until the edge is bound. Add the relationship's from_columns /
  // to_columns to the model and it publishes; the edge still lives in the model
  // (and, once bound, the BigQuery/Spanner graph).
  //
  // K2: a derived relationship (`via`) binds no join columns by design; its
  // schema-join pairs the two endpoints' keys instead (see
  // schemaJoinAspectData), so it needs both endpoints keyed.
  const derived = !!rel.via?.length;
  if (derived) {
    const unkeyed = [rel.source.entity, rel.destination.entity].find(
        n => !(entityByName(model, n)?.keys ?? []).length);
    if (unkeyed !== undefined) {
      warnings.push(
          `relationship '${rel.name}': derived, and endpoint entity '${
              unkeyed}' has no primary key to pair, so it is not published ` +
          `to Knowledge Catalog yet.`);
      return undefined;
    }
  } else if (!rel.source.columns.length || !rel.destination.columns.length) {
    warnings.push(
        `relationship '${rel.name}': no join columns, so it is not published ` +
        `to Knowledge Catalog yet; add its from_columns and to_columns to the ` +
        `relationship in the model to publish the link.`);
    return undefined;
  }
  const linkId = names.linkId(model, rel);
  if (!claim(
          seenLinks, linkId, 'entry link', `relationship '${rel.name}'`,
          warnings))
    return undefined;

  // The name lives only in the link id (schema-join's aspect has no name
  // field), and link ids are normalized -- lowercase, hyphens only. When the
  // authored name is not already in that form and the anchor does not index
  // it (no ai-context aspect), a later pull recovers it lowercased and
  // hyphenated, not verbatim; warn so the round-trip change is not a surprise.
  const normalizedName = linkSlug(rel.name);
  if (normalizedName !== rel.name && !namesIndexed) {
    warnings.push(
        `relationship '${rel.name}': Knowledge Catalog stores the name only ` +
        `in the normalized link id, so a pull returns it lowercased/hyphenated ` +
        `(e.g. '${normalizedName}'), not '${rel.name}'.`);
  }

  return {
    name: names.entryLink(linkId),
    entryLinkType: names.typeName('entryLink', 'schema-join'),
    // schema-join is undirected: both endpoints are UNSPECIFIED references. The
    // join direction lives in the aspect (source is the foreign-key side).
    entryReferences: [
      {name: src, type: 'UNSPECIFIED'},
      {name: dst, type: 'UNSPECIFIED'},
    ],
    aspects: aspectMap(names, {
      'schema-join': schemaJoinAspectData(model, rel),
    }),
  };
}

// The schema-join aspect for a direct foreign key: a single join pairing the
// source (FK) columns to the destination (key) columns positionally. Each side's
// `name` is the entity's SQL table representation (its dataSource). `type` is
// FOREIGN_KEY (only direct FKs are emitted today); `inferenceSource` is USER
// because the join is author-declared, and `userManaged` stops Dataplex from
// overwriting it. Field names/nesting mirror the schema-join aspect type's
// metadataTemplate.
//
// Only bound edges reach here -- relationshipLink skips a column-less (logical)
// edge -- so `fields` is always present. The `name` still falls back to the
// entity name when the model is logical-only for KC (columns set but no
// dataSource binding), matching the entity-not-found fallback.
//
// K2: a derived relationship (`via`) has no foreign key; its join pairs the two
// endpoints' primary keys, is typed JOIN, and its description carries the
// chain it is derived through (see derived_relationships.derivedTrailers), so
// a reader does not mistake it for a direct column equality.
function schemaJoinAspectData(
    model: SemanticModel, rel: Relationship): Record<string, any> {
  const srcEntity = entityByName(model, rel.source.entity);
  const dstEntity = entityByName(model, rel.destination.entity);
  const derived = !!rel.via?.length;
  return {
    joins: [compact({
      source: compact({
        name: srcEntity && srcEntity.dataSource ?
            srcEntity.dataSource :
            rel.source.entity,
        fields: derived ? srcEntity?.keys ?? [] : rel.source.columns,
      }),
      target: compact({
        name: dstEntity && dstEntity.dataSource ?
            dstEntity.dataSource :
            rel.destination.entity,
        fields: derived ? dstEntity?.keys ?? [] : rel.destination.columns,
      }),
      description: joinDescription(rel),
      type: derived ? 'JOIN' : 'FOREIGN_KEY',
      inferenceSource: 'USER',
    })],
    userManaged: true,
  };
}

// The line that records relationship inheritance on a schema-join. The
// closed schema-join template has no slot for a super-relationship, and its
// `description` is the only free-text field, so a relationship that
// `extends` others publishes `Specializes: <parent>[, <parent>...].` as a
// trailing paragraph of the description. That keeps the hierarchy visible to a
// human or an agent reading the catalog ("hasBuyer specializes
// hasCounterparty"), and gives pull a fixed, parseable shape to restore
// `extends` from (see kc_converter.splitSpecializes). Parent names are written
// verbatim, not link-slugged, so pull recovers them exactly.
export const SPECIALIZES_PREFIX = 'Specializes: ';

function specializesLine(rel: Relationship): string|undefined {
  if (!rel.extends?.length) return undefined;
  return `${SPECIALIZES_PREFIX}${rel.extends.join(', ')}.`;
}

// The line a relationship's declared inverse adds to its join description, for
// the same reason: no slot for a second name in the closed template, so the
// inverse rides as a trailing `Inverse: <name>.` paragraph -- readable by a
// person browsing the catalog, and parsed back into `inverse` on pull (see
// kc_converter splitInverse). One schema-join link still stands for the one
// edge; the inverse is a name, not a second link.
export const INVERSE_PREFIX = 'Inverse: ';

function inverseLine(rel: Relationship): string|undefined {
  return rel.inverse ? `${INVERSE_PREFIX}${rel.inverse}.` : undefined;
}

// The description, then the Specializes paragraph, then the Inverse paragraph,
// then (K2) the Derived paragraphs -- a fixed order, so pull peels them off
// from the end in reverse (Derived first, then Inverse, then Specializes).
function joinDescription(rel: Relationship): string|undefined {
  const parts = [
    rel.description, specializesLine(rel), inverseLine(rel),
    ...derivedTrailers(rel),
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join('\n\n') : undefined;
}

// Entity inheritance and abstractness on the entity entry. Neither the
// semantic-entity nor the schema template (both CLOSED) has a slot for a
// supertype or for "no table of its own", and the entry description is the one
// free-text field, so both ride there as fixed trailing paragraphs -- the same
// convention a relationship uses on its join (SPECIALIZES_PREFIX above):
//
//   <authored description>
//
//   Specializes: Party, Auditable.
//
//   Abstract: no table of its own.
//
// That keeps the hierarchy readable to a person or an agent browsing the
// catalog ("Customer specializes Party"; "Party is abstract"), and gives pull a
// fixed, parseable shape to restore `extends` and `abstract` from (see
// kc_converter.splitEntityTrailers). `abstract` cannot be inferred from an
// empty `source.resources` alone: an unbound logical entity (an OWL import)
// publishes the same empty list. Restoring `abstract` is what lets a strict
// load of the pulled model accept a source-less abstract entity (a non-abstract
// one without a source is rejected). Parent names are written verbatim so pull
// recovers them exactly.
export const ABSTRACT_MARKER = 'Abstract: no table of its own.';

// A defined (virtual) entity's membership predicate (Entity.definition) has no
// slot either: semantic-entity carries only `source.resources`, schema only
// columns and keys, and the model's custom aspect types (semantic-action /
// semantic-constraint) belong to entries of their own kind. So it rides the
// same trailer convention, after the Abstract marker (the two never co-occur):
//
//   <authored description>
//
//   Specializes: Opportunity.
//
//   Definition note: Stage 5 per the CRM vocabulary.     (optional)
//
//   Defined as: salesStage = '5_won'
//
// Each trailer is one paragraph: line breaks inside the expression or note are
// folded to single spaces (SQL whitespace is insignificant) so the blank-line
// paragraph split on pull cannot cut one in two. The expression is written
// verbatim otherwise -- no trailing period, which would change its meaning.
export const DEFINED_AS_PREFIX = 'Defined as: ';
export const DEFINITION_NOTE_PREFIX = 'Definition note: ';

// Folds line breaks (and the indentation around them) to one space.
export function oneParagraph(text: string): string {
  return text.trim().replace(/\s*\n\s*/g, ' ');
}

// The description, then the Specializes paragraph, then the Abstract marker or
// the definition trailers -- a fixed order, so pull peels them off from the end
// in reverse.
function entityDescription(entity: Entity, model?: SemanticModel): string|undefined {
  const parts = [
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
    // K7: `Grain: …` then `History: …`, so pull peels them right after the
    // K3 members (see units_history.splitGrainHistoryTrailers).
    ...entityTrailers(entity),
    // K3: a vocabulary's `Members: …` paragraph, so pull peels it right
    // after the hydration paragraph (see vocabulary.splitMembersTrailer).
    membersTrailer(entity),
    // Hydration: how the binding reshapes the source (and `mode: direct`),
    // last of all, so pull peels it first (see hydration_kc.ts).
    hydrationTrailer(
        entity,
        model ? field => resolveRelationship(model, entity, field)
                             ?.destination.entity :
                undefined),
  ].filter((p): p is string => !!p);
  return parts.length ? parts.join('\n\n') : undefined;
}

function entityByName(model: SemanticModel, name: string): Entity|undefined {
  return (model.entities ?? []).find(e => e.name === name);
}


// ---------------------------------------------------------------------------
// Physical bindings (K3): what each entity is read through in BigQuery.
// ---------------------------------------------------------------------------

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
  let target: ReturnType<typeof googleDeploymentTargets>['bigQuery'][number]|
      undefined;
  try {
    target = googleDeploymentTargets(model).bigQuery[0];
  } catch {
    return out;  // malformed extension JSON: validation reports it
  }
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
    const bound = !!nodeView || !!(e.dataSource ?? '').trim() &&
        !(e.dataSource ?? '').trim().startsWith('unbound:');
    if (!bound) continue;
    out.set(e.name, {
      ...(nodeView ? {nodeView} : {}),
      graph,
      graphNode: e.name,
    });
  }
  return out;
}

/** Entry-link id prefix of a model's binding links (for reconciliation). */
export function bindingLinkPrefix(modelName: string): string {
  return linkSlug(`${modelName}-bind`);
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
 * The `@bigquery` entry of a property graph's node label.
 *
 * TODO(Phase E): this `propertyGraphs/<g>/nodes/<Label>` naming is unverified;
 * confirm it live against kc-demo-349204. Until then a link to it that the API
 * refuses is a push warning, never an error.
 */
export function graphNodeEntryName(
    graph: string, label: string, locator: BigQueryEntryLocator): string|
    undefined {
  const [project, dataset, name] = graph.split('.');
  return bigQueryEntryName(
      `${project}.${dataset}.${name}`, locator,
      `propertyGraphs/${name}/nodes/${label}`);
}

// A binding link id: `<model>-bind-<kind>-<entity>`, link-slugged; a long one
// is cut and given a short hash of the full form so two entities sharing a
// long prefix still get distinct ids.
function bindingLinkId(modelName: string, kind: string, entity: string):
    string {
  const full = `${bindingLinkPrefix(modelName)}-${kind}-${entity}`;
  const id = linkSlug(full);
  if (id.length < 63) return id;
  return `${id.slice(0, 54).replace(/-+$/, '')}-${fnv(full)}`;
}

function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36).padStart(7, '0').slice(0, 7);
}

/**
 * K3: per bound entity, a schema-join from its entry to the `@bigquery` entry
 * it is read through (the node view; the table itself under `mode: direct`
 * or when no view is generated) and one to its graph node entry. Each is a
 * JOIN on the entity's key against the physical key columns. A target whose
 * dataset the locator does not know is skipped with a warning.
 */
function bindingLinksFor(
    names: Namer, model: SemanticModel, physical: Map<string, EntityPhysical>,
    entityEntryName: Map<string, string>, locator: BigQueryEntryLocator,
    warnings: string[]): EntryLink[] {
  const links: EntryLink[] = [];
  const seenIds = new Set<string>();
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
    const push = (kind: string, to: string|undefined, target: string,
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
           phys.graph, isViewCols(phys) ? viewCols : keys,
           `graph node ${phys.graph}/${phys.graphNode}`);
    }
  }
  return links;
}

// A graph node's key properties are the node view's snake_case columns when
// it reads one, else the table's own key columns.
function isViewCols(phys: EntityPhysical): boolean {
  return !!phys.nodeView;
}


// ---------------------------------------------------------------------------
// Aspect-data mappers. Field names/nesting mirror the server aspect types'
// CLOSED metadataTemplates exactly (see file header); the golden tests pin
// these shapes so any schema-driven change is a visible, reviewable diff.
// ---------------------------------------------------------------------------

// semantic-model: every recognized graph deployment target URI this model
// deploys to -- BigQuery Graph and/or Spanner Graph, the same targets the graph
// legs execute against. Recording both backends keeps the entry faithful for a
// Spanner-targeted model (so a later `kcmd pull` reconstructs a bound model).
// Empty data is valid; the aspect is still attached to satisfy required_aspects.
function modelAspectData(model: SemanticModel): Record<string, any> {
  const {bigQuery, spanner} = googleDeploymentTargets(model);
  const uris = [...bigQuery, ...spanner].map(t => t.uri);
  return compact({
    deploymentTargets: uris.length ? uris : undefined,
  });
}

// semantic-entity: the base table(s) backing the entity. importedSystem/
// importedResource have no IR source today and are left unset.
function entityAspectData(entity: Entity): Record<string, any> {
  // A logical-only entity has no physical table (empty dataSource). Still emit
  // the `source` block with an empty `resources` array rather than a bogus
  // ['']: the semantic-entity template requires `source` (with its `resources`
  // list), so omitting it is rejected server-side. An empty list is the honest
  // "no binding yet"; the reader treats it the same as an absent source
  // (dataSource becomes '').
  const path = resourcePath(entity.dataSource);
  return compact({
    source: {resources: path ? [path] : []},
  });
}

// The built-in schema aspect, carrying each field's column type and display
// label, the entity's primary/unique keys, plus the gated per-field `semantics`
// block (expression / role). name, dataType, and metadataType are required per
// column.
function schemaAspectData(
    entity: Entity, emitExpressions: boolean): Record<string, any> {
  // Key column lists ride the schema aspect verbatim -- they need NOT be
  // declared fields (the closed template accepts and round-trips columns absent
  // from fields[], live-verified). Keep only non-empty strings, matching the
  // reader's stringList, so a degenerate '' member does not round-trip
  // asymmetrically; a set that is empty after filtering is then dropped.
  const keyFields = (cols: readonly string[]|undefined): string[] =>
      (cols ?? []).filter(c => typeof c === 'string' && c !== '');
  const primaryKey = keyFields(entity.keys);
  const uniqueConstraints =
      (entity.uniqueKeys ?? []).map(keyFields).filter(set => set.length);
  return compact({
    fields: (entity.fields ??
             []).map(f => compact({
                       name: f.name,
                       // An untyped field is published as Opaque (STRING +
                       // metadataType OTHER), the explicit "type unknown"
                       // marker, so a pull recovers it as Opaque rather than
                       // dropping the type. Authored `String` maps to STRING.
                       dataType: columnDataType(f.type ?? 'Opaque'),
                       metadataType: columnMetadataType(f.type ?? 'Opaque'),
                       // K7: unit / scale ride as a trailing `Unit: …`
                       // paragraph (kc_converter peels it back off).
                       description: withUnitTrailer(f.description, f),
                       // A field's display label rides in the schema field's
                       // `annotations` map (the template's free-form
                       // string->string map) -- the one slot for metadata the
                       // template has no dedicated column for. Omitted when the
                       // field has no label.
                       annotations: f.label ? {label: f.label} : undefined,
                       // The per-field `semantics` block (expression + role) is
                       // not in the published `schema` aspect template yet, so
                       // it is gated off by default (see
                       // KcGenerateOptions.emitExpressions); compact() then
                       // drops the undefined key.
                       semantics: emitExpressions ? compact({
                         expression: f.expression,
                         // A field with any dimension metadata is a dimension;
                         // otherwise DEFAULT.
                         role: f.dimension ? 'DIMENSION' : 'DEFAULT',
                       }) : undefined,
                     })),
    // The entity's grain / primary key -> the schema aspect's primaryKey.fields
    // (ordered, so a composite key's ordinal positions round-trip). Omitted
    // when the entity declares no (non-empty) keys.
    primaryKey: primaryKey.length ? {fields: primaryKey} : undefined,
    // Additional uniqueness constraints beyond the primary key -> one
    // uniqueConstraints entry per non-empty unique column set. Omitted when
    // there are none.
    uniqueConstraints: uniqueConstraints.length ?
        uniqueConstraints.map(fields => ({fields})) :
        undefined,
  });
}

// The built-in guidelines aspect: routes an object's `ai_context.instructions`
// -- free-form guidance for AI consumers -- to the aspect's `instructions`
// richText field. `userManaged` is required and always true: these guidelines
// are author-declared, so Dataplex must not overwrite them. Only `instructions`
// is routed here; `ai_context.synonyms`/`examples` have no home in this aspect.
// Returns undefined (attach no aspect) when there are no instructions.
function guidelinesAspectData(ai: AiContext|undefined): Record<string, any>|
    undefined {
  const instructions = ai?.instructions;
  if (instructions === undefined || instructions === '') return undefined;
  return {instructions, userManaged: true};
}

// semantic-metric: the model-level aggregate. `dataType` is required by the
// aspect type; a metric the author left untyped is published as Opaque -- the
// explicit "type unknown" marker -- rather than guessing a numeric type. (The
// metric aspect template carries only `dataType`, not a metadataType, so Opaque
// serializes as STRING and a pull recovers the metric untyped; once the
// template gains a metadataType it can round-trip as an explicit Opaque.)
function metricAspectData(
    metric: Metric, emitExpressions: boolean): Record<string, any> {
  const dataType = columnDataType(metric.type ?? 'Opaque');
  return compact({
    entity: metric.entity,
    dataType,
    // `expression` is not in the published semantic-metric aspect template yet;
    // gated off by default (see KcGenerateOptions.emitExpressions).
    expression: emitExpressions ? metric.expression : undefined,
  });
}


// Maps the IR's logical DataType to a column data-type string for the schema
// aspect's required `dataType`. A conventional GoogleSQL type name; the field
// is a free string server-side. Unknown/undefined falls back to STRING.
function columnDataType(type: DataType|undefined): string {
  switch (type) {
    case 'Integer':
      return 'INT64';
    case 'Decimal':
      return 'NUMERIC';
    case 'Float':
      return 'FLOAT64';
    case 'Boolean':
      return 'BOOL';
    case 'Date':
      return 'DATE';
    case 'Time':
      return 'TIME';
    case 'DateTime':
      return 'DATETIME';
    case 'DateTimeTz':
      return 'TIMESTAMP';
    case 'String':
    case 'Opaque':
    default:
      return 'STRING';
  }
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

// Maps the IR's opaque, canonical `dataSource` to a catalog resource string. A
// clean three-part `project.dataset.table` becomes the BigQuery linked-resource
// URI; anything else (a query, an under/over-qualified ref) is passed through
// verbatim so nothing is lost.
// TODO: settle the linked-resource form for Iceberg / BigLake tables, which may
// need a different URI shape than the BigQuery managed-table one below.
function resourcePath(dataSource: string): string {
  const trimmed = (dataSource ?? '').trim();
  if (!trimmed || /\s/.test(trimmed)) return trimmed;
  const parts = trimmed.split('.').map(unquote);
  if (parts.length === 3 && parts.every(p => p.length)) {
    return `//bigquery.googleapis.com/projects/${parts[0]}/datasets/${
        parts[1]}/tables/${parts[2]}`;
  }
  return trimmed;
}


// ---------------------------------------------------------------------------
// Naming and small helpers.
// ---------------------------------------------------------------------------

// Builds the fully-qualified resource names for a destination. Kept in one
// place so entry/type name construction is consistent and the emitter body
// reads as pure mapping.
class Namer {
  private readonly typeProj: string;
  private readonly typeLoc: string;
  constructor(private readonly opts: KcGenerateOptions) {
    this.typeProj = opts.systemTypeProject ?? DEFAULT_TYPE_PROJECT;
    this.typeLoc = opts.systemTypeLocation ?? DEFAULT_TYPE_LOCATION;
  }

  // Full resource name of a system type. `kind` selects the collection.
  typeName(kind: 'entry'|'aspect'|'entryLink', name: string): string {
    return `projects/${this.typeProj}/locations/${this.typeLoc}/${kind}Types/${
        name}`;
  }

  // Aspect-map key: the `project.location.type` reference form the client keys
  // an entry's aspects by (see dataplex._nameToTypeRef / _fixEntry).
  aspectRef(name: string): string {
    return `${this.typeProj}.${this.typeLoc}.${name}`;
  }

  entry(entryId: string): string {
    return `${this.container()}/entries/${entryId}`;
  }

  entryLink(linkId: string): string {
    return `${this.container()}/entryLinks/${linkId}`;
  }

  private container(): string {
    return `projects/${this.opts.project}/locations/${
        this.opts.location}/entryGroups/${this.opts.entryGroup}`;
  }

  modelId(model: SemanticModel): string {
    return slug(model.name);
  }
  entityId(model: SemanticModel, entity: Entity): string {
    return `${slug(model.name)}.entities.${slug(entity.name)}`;
  }
  metricId(model: SemanticModel, metric: Metric): string {
    return `${slug(model.name)}.metrics.${slug(metric.name)}`;
  }
  // Entry link ids are more restricted than entry ids: lowercase letters,
  // numbers and hyphens only, starting with a letter (see linkSlug).
  linkId(model: SemanticModel, rel: Relationship): string {
    return linkSlug(`${model.name}-${rel.name}`);
  }
}


// Wraps aspect data (keyed by bare type id) as the client's aspect map: each
// key is the `project.location.type` reference form, each value the
// fully-qualified aspectType plus its data.
function aspectMap(names: Namer, byType: Record<string, Record<string, any>>):
    Record<string, Aspect> {
  const out: Record<string, Aspect> = {};
  for (const [type, data] of Object.entries(byType)) {
    out[names.aspectRef(type)] = {
      aspectType: names.typeName('aspect', type),
      data
    };
  }
  return out;
}

// An entry's aspect map: its required `base` aspects, plus the optional
// built-in `guidelines` aspect when the object carries
// `ai_context.instructions`. Kept in one place so every entry kind
// (model/entity/metric) routes instructions the same way and an object without
// instructions carries no empty guidelines aspect.
function aspectsFor(
    names: Namer, base: Record<string, Record<string, any>>,
    ai: AiContext|undefined): Record<string, Aspect> {
  const guidelines = guidelinesAspectData(ai);
  return aspectMap(names, guidelines ? {...base, guidelines} : base);
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

// Entry IDs allow letters, numbers, underscores, hyphens, and periods; map
// anything else to an underscore so a model/entity name with spaces or other
// characters still yields a valid, stable ID.
function slug(s: string): string {
  return s.replace(/[^A-Za-z0-9_.-]/g, '_');
}

// Entry link ids allow only lowercase letters, numbers and hyphens, must start
// with a letter, must end with a letter or number, and are capped at 63 chars.
// Lowercase, map any other character to a hyphen, collapse runs, then trim
// leading non-letters and edge hyphens so the id satisfies the API contract.
export function linkSlug(s: string): string {
  let out = s.toLowerCase()
                .replace(/[^a-z0-9-]+/g, '-')
                .replace(/-+/g, '-')
                .replace(/^[^a-z]+/, '')
                .replace(/^-+|-+$/g, '')
                .slice(0, 63)
                .replace(/-+$/, '');
  return out || 'link';
}

function unquote(part: string): string {
  return part.replace(/^[`"]/, '').replace(/[`"]$/, '');
}
