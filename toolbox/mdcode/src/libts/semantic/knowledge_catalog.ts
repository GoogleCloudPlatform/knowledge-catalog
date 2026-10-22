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
// With the first-generation aspects (v2Aspects off), each model and profile
// file the push read is also stored whole as a file copy, one
// `semantic-model-file` entry per file, parented to the anchor. That type is
// custom too. The aspects cannot hold the whole model, so a pull returns
// these copies instead of rebuilding the file from them. The anchor of a
// model with copies carries their push id in the `kcmd-push-id` label on its
// entrySource.
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
// KcGenerateOptions.emitExpressions (off by default) and omitted above.
//
// Relationships become `schema-join` entry links between the two entity entries.
// schema-join is a built-in, undirected entry link type in `dataplex-types/global`
// whose required `schema-join` aspect carries the join detail (the paired join
// columns, JOIN vs FOREIGN_KEY, USER inference). The join's direction -- which
// side holds the foreign key -- is preserved inside that aspect, not by the link.
// Many-to-many (association / junction-table) edges are not emitted yet: a
// junction is two joins through a third table, which schema-join's single
// source/target pair does not model; the emitter warns and skips them (the edge
// still lives in the BigQuery property graph, see graph_ddl.ts).
//

import type {Aspect, Entry, EntryLink} from '../gcp/dataplex';

import {googleDeploymentTargets} from './deployment_target';
import {AiContext, DataType, Entity, Field, Metric, Relationship, SemanticModel} from './ir';
import {actionEntries} from './kc_actions';
import {constraintEntries} from './kc_constraints';
import {customAspectKey, customAspectTypeName, customEntryTypeName, FILE_COPY_TYPE_ID, FileCopy, PUSH_ID_LABEL} from './kc_custom_types';
import {linkSlug, Namer, ownedEntryIdPrefixes} from './kc_ids';
import {asResourceUri, isAcceptedSource} from './loader';
import {InheritanceError, resolveInheritance} from './resolve_inheritance';

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
  // Emit the second-generation built-in aspect fields and entry-id layout
  // (selected via KC_V2_ASPECTS=1). Off by default (absent means false), which
  // emits the first-generation layout.
  v2Aspects?: boolean;
  // The file copies of the model file and its profile files, each stored in
  // an entry of its own when v2Aspects is off. Absent emits none.
  sourceFiles?: FileCopy[];
}

export interface KcResources {
  entries: Entry[];
  entryLinks: EntryLink[];
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
  const v2 = opts.v2Aspects ?? false;

  // The first-generation aspects have no field for a vendor's extension
  // blocks, and the stored copy of the model file keeps them.
  if (!v2 && opts.sourceFiles?.length && hasThirdPartyExtensions(model)) {
    warnings.push(
        'custom_extensions from vendors other than GOOGLE are not indexed ' +
        'by the Knowledge Catalog aspects; the stored copy of the model file ' +
        'preserves them');
  }

  // With the first-generation aspects, a subtype field that only rebinds an
  // inherited field is published with the definition it inherits.
  const inherited = v2 ? undefined : inheritedFields(model);

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
  for (const entity of entities) {
    // An abstract entity is a conceptual (table-less) supertype: it has no
    // physical resource to catalog. The Knowledge Catalog leg does not model
    // inheritance (that is BigQuery-only today, via resolveInheritance), so
    // rather than publish a malformed entry -- an empty linked resource and no
    // key -- skip it with a warning. Its concrete subtypes are published
    // normally, and any edge naming it as an endpoint is dropped downstream
    // (its name never enters `entityEntryName`).
    if (entity.abstract) {
      warnings.push(
          `entity '${entity.name}' is abstract (no physical table); skipped ` +
          `for Knowledge Catalog (KC does not yet model class hierarchies)`);
      continue;
    }
    const entityId = names.entityId(model, entity);
    if (!claim(seen, entityId, 'entry', `entity '${entity.name}'`, warnings))
      continue;
    entityEntryName.set(entity.name, names.entry(entityId));
    if (!entity.keys || !entity.keys.length) {
      warnings.push(
          `entity '${entity.name}': no keys declared in the source model`);
    }
    entries.push({
      name: names.entry(entityId),
      entryType: names.typeName('entry', 'semantic-entity'),
      parentEntry: modelEntryName,
      entrySource: source(entity.name, entity.description),
      // required_aspects: semantic-entity AND the built-in schema; plus the
      // built-in guidelines aspect when the entity carries ai_context
      // instructions.
      aspects: aspectsFor(
          names, {
            'semantic-entity': entityAspectData(entity),
            'schema': schemaAspectData(
                entity, emitExpr, inherited?.get(entity.name)),
          },
          entity.aiContext),
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
      aspects: aspectsFor(
          names, {'semantic-metric': metricAspectData(metric, emitExpr)},
          metric.aiContext),
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
    // Populated by the entity loop above, so it excludes the abstract and
    // unavailable entities that loop skipped.
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

  // One file copy entry per model and profile file, holding its text as
  // read. Only with the first-generation aspects: a push with v2Aspects on
  // emits none, so delete reconciliation removes the copies under the owned
  // `.files.` prefix. Two file names that slug to one id fail the push, since
  // storing only one would lose the other on the next pull.
  if (!v2) {
    const fileById = new Map<string, string>();
    let pushId: string|undefined;
    for (const file of opts.sourceFiles ?? []) {
      const id = names.fileEntryId(model.name, file.fileName);
      const earlier = fileById.get(id);
      if (earlier !== undefined) {
        throw new Error(
            `files '${earlier}' and '${file.fileName}' both map to entry id ` +
            `'${id}'; rename one of them`);
      }
      fileById.set(id, file.fileName);
      if (!claim(seen, id, 'entry', `file '${file.fileName}'`, warnings))
        continue;
      entries.push(fileCopyEntry(names.entry(id), modelEntryName, file, opts));
      pushId ??= file.pushId;
    }
    // The anchor is written before the copies and is labeled with the push id
    // they carry. A pull that finds the label and no copies from that push
    // knows the last push stopped before storing them. A model an older kcmd
    // pushed has no label.
    if (pushId !== undefined) {
      entries[0].entrySource = {
        ...entries[0].entrySource,
        labels: {[PUSH_ID_LABEL]: pushId},
      };
    }
  }

  // Relationships map to schema-join entry links between their endpoint entries.
  const entryLinks: EntryLink[] = [];
  const seenLinks = new Set<string>();
  const seenPairs = new Map<string, string>();
  for (const rel of relationships) {
    // A relationship that cannot be published gets the warning that says why,
    // whatever its place in the model, so this check runs before the pair
    // check below. A second relationship from an entity to itself gets only
    // the self warning.
    const reason = unpublishedReason(rel, entityEntryName, !!opts.v2Aspects);
    if (reason) {
      warnings.push(`relationship '${rel.name}': ${reason}`);
      continue;
    }
    // Dataplex allows one link of a type between two entries. The flag-off
    // path links the first relationship on a pair and warns about the rest.
    // Under v2Aspects every relationship still gets a link, so Dataplex
    // refuses the second link on a pair. The V2 design for that case is not
    // settled.
    const pairKey =
        [rel.source.entity, rel.destination.entity].sort().join('|');
    if (!opts.v2Aspects) {
      const firstRel = seenPairs.get(pairKey);
      if (firstRel !== undefined) {
        warnings.push(
            `relationship '${rel.name}': shares entities '${
                rel.source.entity}' and '${
                rel.destination.entity}' with relationship '${firstRel}'; ` +
            `skipped because the catalog shows one join for those entities.`);
        continue;
      }
    }
    // `unpublishedReason` has checked that both endpoint entities have an
    // entry.
    const ends: [string, string] = [
      entityEntryName.get(rel.source.entity)!,
      entityEntryName.get(rel.destination.entity)!,
    ];
    const link =
        relationshipLink(names, model, rel, ends, seenLinks, warnings);
    if (link) {
      seenPairs.set(pairKey, rel.name);
      entryLinks.push(link);
    }
  }

  return {
    entries,
    entryLinks,
    warnings: [...new Set(warnings)],
    ownedPrefixes: ownedEntryIdPrefixes(model.name),
  };
}


// Returns why `rel` cannot be published as a schema-join entry link, or
// undefined when it can. The reasons, in the order checked: a many-to-many
// (association) edge, since a junction is two joins, which the single
// source/target schema-join does not model; an edge whose endpoint entity was
// not emitted, for example one skipped for a duplicate id; with v2Aspects off,
// an edge from an entity to itself; and a column-less (purely logical) edge,
// whose join columns must be added to the model before it can publish. The
// BigQuery property graph still carries the association and, once bound,
// direct edges.
function unpublishedReason(
    rel: Relationship, entityEntryName: ReadonlyMap<string, string>,
    v2Aspects: boolean): string|undefined {
  if (rel.association) {
    return `many-to-many (association) edges are not published to ` +
        `Knowledge Catalog yet; the edge lives in the BigQuery property graph.`;
  }
  const missing = [rel.source.entity, rel.destination.entity].find(
      entity => !entityEntryName.get(entity));
  if (missing !== undefined) {
    return `endpoint entity '${missing}' is not a published entity; the ` +
        `relationship link is skipped.`;
  }
  // Dataplex refuses a link whose two references name the same entry, so the
  // flag-off path skips a relationship from an entity to itself. This check
  // runs before the join-column check, because adding join columns does not
  // publish such a relationship. The V2 design gives such a relationship its
  // own entry and no link. Until V2 emission does that, v2Aspects still emits
  // the link here, and Dataplex refuses it.
  if (!v2Aspects && rel.source.entity === rel.destination.entity) {
    return `skipped because Knowledge Catalog does not support a ` +
        `relationship from an entity to itself.`;
  }
  // A purely logical edge (an OWL import) carries no join columns. schema-join
  // is a server-defined CLOSED metadataTemplate whose `fields` requirement we
  // cannot depend on, so rather than risk a rejected aspect on a KC push we skip
  // the link until the edge is bound. Add the relationship's from_columns /
  // to_columns to the model and it publishes; the edge still lives in the model
  // (and, once bound, the BigQuery/Spanner graph).
  if (!rel.source.columns.length || !rel.destination.columns.length) {
    return `no join columns, so it is not published to Knowledge Catalog ` +
        `yet; add its from_columns and to_columns to the relationship in the ` +
        `model to publish the link.`;
  }
  return undefined;
}

// Builds the schema-join entry link for a relationship that
// `unpublishedReason` accepts, or undefined when another resource already
// claimed its link id. `ends` holds the entry names of its source and
// destination entities.
function relationshipLink(
    names: Namer, model: SemanticModel, rel: Relationship,
    ends: readonly [string, string], seenLinks: Set<string>,
    warnings: string[]): EntryLink|undefined {
  const [src, dst] = ends;
  const linkId = names.linkId(model, rel);
  if (!claim(
          seenLinks, linkId, 'entry link', `relationship '${rel.name}'`,
          warnings))
    return undefined;

  // The name lives only in the link id (schema-join's aspect has no name
  // field), and link ids are normalized -- lowercase, hyphens only. A pull that
  // rebuilds the model reads each hyphen back as an underscore, so it returns
  // the name lowercased; warn when that differs from the authored name.
  const normalizedName = linkSlug(rel.name).replace(/-/g, '_');
  if (normalizedName !== rel.name) {
    warnings.push(
        `relationship '${rel.name}': Knowledge Catalog stores the name only ` +
        `in the normalized link id, so a pull that rebuilds the model returns ` +
        `it as '${normalizedName}'.`);
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
function schemaJoinAspectData(
    model: SemanticModel, rel: Relationship): Record<string, any> {
  const srcEntity = entityByName(model, rel.source.entity);
  const dstEntity = entityByName(model, rel.destination.entity);
  return {
    joins: [compact({
      source: compact({
        name: srcEntity && srcEntity.dataSource ?
            srcEntity.dataSource :
            rel.source.entity,
        fields: rel.source.columns,
      }),
      target: compact({
        name: dstEntity && dstEntity.dataSource ?
            dstEntity.dataSource :
            rel.destination.entity,
        fields: rel.destination.columns,
      }),
      description: rel.description,
      type: 'FOREIGN_KEY',
      inferenceSource: 'USER',
    })],
    userManaged: true,
  };
}

function entityByName(model: SemanticModel, name: string): Entity|undefined {
  return (model.entities ?? []).find(e => e.name === name);
}

// The entry holding one file copy. Its entry and aspect types are custom, so
// they live in the destination project.
function fileCopyEntry(
    name: string, anchor: string, file: FileCopy,
    dest: {project: string}): Entry {
  return {
    name,
    entryType: customEntryTypeName(FILE_COPY_TYPE_ID, dest),
    parentEntry: anchor,
    aspects: {
      [customAspectKey(FILE_COPY_TYPE_ID, dest)]: {
        aspectType: customAspectTypeName(FILE_COPY_TYPE_ID, dest),
        data: fileCopyData(file),
      },
    },
  };
}

// The aspect data of a file copy: the file's name and text, and the push id
// and copy count when the push set them.
export function fileCopyData(file: FileCopy): Record<string, any> {
  return compact({
    fileName: file.fileName,
    content: file.content,
    pushId: file.pushId,
    pushFileCount: file.pushFileCount,
  });
}

// True when the model, or anything in it, carries a `custom_extensions` block
// from a vendor other than GOOGLE.
function hasThirdPartyExtensions(model: SemanticModel): boolean {
  const thirdParty = (o: {customExtensions?: {vendorName: string}[]}) =>
      (o.customExtensions ?? []).some(x => x.vendorName !== 'GOOGLE');
  const entities = model.entities ?? [];
  return thirdParty(model) || entities.some(thirdParty) ||
      entities.some(e => (e.fields ?? []).some(thirdParty)) ||
      (model.relationships ?? []).some(thirdParty) ||
      (model.metrics ?? []).some(thirdParty) ||
      (model.actions ?? []).some(thirdParty);
}

// Each entity's fields with inheritance resolved, by entity and field name, or
// undefined when no entity extends another or inheritance cannot be resolved.
// A resolved field keeps what the entity's own declaration sets and takes the
// rest from the ancestor that defines it.
function inheritedFields(model: SemanticModel):
    Map<string, Map<string, Field>>|undefined {
  if (!(model.entities ?? []).some(e => e.extends?.length)) return undefined;
  let resolved: SemanticModel;
  try {
    resolved = resolveInheritance(model).model;
  } catch (err) {
    // Push validation reports it. The schema aspect keeps what each entity
    // declares.
    if (err instanceof InheritanceError) return undefined;
    throw err;
  }
  return new Map((resolved.entities ?? []).map(
      e => [e.name, new Map((e.fields ?? []).map(f => [f.name, f]))]));
}


// ---------------------------------------------------------------------------
// Aspect-data mappers. Field names/nesting mirror the server aspect types'
// CLOSED metadataTemplates exactly (see file header); the golden tests pin
// these shapes so any schema-driven change is a visible, reviewable diff.
// ---------------------------------------------------------------------------

// semantic-model: every deployment target this model declares, in declaration
// order. Recording all declared targets keeps the entry faithful so a later
// `kcmd pull` reconstructs `deployments` in the order the author wrote them.
// Empty data is valid; the aspect is still attached to satisfy
// required_aspects.
function modelAspectData(model: SemanticModel): Record<string, any> {
  const {uris} = googleDeploymentTargets(model);
  return compact({
    deploymentTargets: uris.length ? uris : undefined,
  });
}

// semantic-entity: the base table backing the entity. A source is stored as
// written, its GCP resource name, in `resources`.
function entityAspectData(entity: Entity): Record<string, any> {
  // A logical-only entity has no physical table (empty dataSource). Still emit
  // the `source` block with an empty `resources` array rather than a bogus
  // ['']: the semantic-entity template requires `source` (with its `resources`
  // list), so omitting it is rejected server-side. An empty list is the honest
  // "no binding yet"; the reader treats it the same as an absent source
  // (dataSource becomes '').
  const authored = entity.authoredSource?.trim();
  if (authored !== undefined && isAcceptedSource(authored)) {
    // Stored as written, so pull returns it unchanged.
    return {source: {resources: [authored]}};
  }
  // A legacy instance-based AlloyDB URI is stored as written too.
  const legacy = authored !== undefined &&
      asResourceUri(authored) === entity.dataSource &&
      entity.dataSource.startsWith('//');
  const path = resourcePath(legacy ? authored : entity.dataSource);
  return compact({
    source: {resources: path ? [path] : []},
  });
}

// The built-in schema aspect, carrying each field's column type and display
// label, the entity's primary/unique keys, plus the gated per-field `semantics`
// block (expression / role). name, dataType, and metadataType are required per
// column. `inherited` holds the entity's fields with inheritance resolved; a
// field that sets no datatype, description or label of its own takes the one
// it inherits from there.
function schemaAspectData(
    entity: Entity, emitExpressions: boolean,
    inherited?: Map<string, Field>): Record<string, any> {
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
  // A field a binding profile excludes on this entity is not published for it
  // (see Entity.excludedFields).
  const excluded = new Set(entity.excludedFields ?? []);
  // A subtype's redeclaration of an inherited field only rebinds it, so its
  // definition is the inherited one.
  const withDefinition = (f: Field): Field => {
    const from = inherited?.get(f.name);
    return {
      ...f,
      type: f.type ?? from?.type,
      description: f.description ?? from?.description,
      label: f.label ?? from?.label,
    };
  };
  return compact({
    fields: (entity.fields ?? [])
                .filter(f => !excluded.has(f.name))
                .map(withDefinition)
                .map(f => compact({
                       name: f.name,
                       // An untyped field is published as Opaque (STRING +
                       // metadataType OTHER), the explicit "type unknown"
                       // marker, so a pull recovers it as Opaque rather than
                       // dropping the type. Authored `String` maps to STRING.
                       dataType: columnDataType(f.type ?? 'Opaque'),
                       metadataType: columnMetadataType(f.type ?? 'Opaque'),
                       description: f.description,
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
// clean three-part `project.dataset.table` becomes the BigQuery table's GCP
// resource name, the form a source is written as; anything else (a query, an
// under/over-qualified ref) is passed through verbatim so nothing is lost.
// TODO: settle the linked-resource form for Iceberg / BigLake tables, which may
// need a different URI shape than the BigQuery managed-table one below.
function resourcePath(dataSource: string): string {
  const trimmed = (dataSource ?? '').trim();
  if (!trimmed || /\s/.test(trimmed) || trimmed.includes('/') ||
      trimmed.includes(':')) {
    return trimmed;
  }
  const parts = trimmed.split('.').map(unquote);
  if (parts.length === 3 && parts.every(p => p.length)) {
    return `bigquery.googleapis.com/projects/${parts[0]}/datasets/${
        parts[1]}/tables/${parts[2]}`;
  }
  return trimmed;
}


// ---------------------------------------------------------------------------
// Naming and small helpers.
// ---------------------------------------------------------------------------

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

function unquote(part: string): string {
  return part.replace(/^[`"]/, '').replace(/[`"]$/, '');
}
