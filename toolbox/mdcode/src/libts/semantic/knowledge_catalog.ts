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
// alongside the built-in `schema` aspect. This emitter references them; it never
// provisions them. Each entry type declares `required_aspects`, so the emitted aspect set
// per entry is a hard contract:
//   * semantic-model entry -> { semantic-model }
//   * semantic-entity entry -> { semantic-entity, schema }
//   * semantic-metric entry -> { semantic-metric }
//
// Aspect data shapes mirror the aspect types' CLOSED metadataTemplates exactly
// (a server aspect type rejects an undeclared data field):
//   * semantic-model  = { deploymentTargets: string[] }
//   * semantic-entity = { source: { resources: string[], importedSystem?,
//                                    importedResource? } }
//   * semantic-metric = { entity?, dataType (required) }
//   * schema          = { fields: [{ name, dataType, metadataType,
//                                    description? }] }
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
// still lives in the BigQuery property graph, see bigquery.ts).
//

import type {Aspect, Entry, EntryLink} from '../gcp/dataplex';

import {bigQueryGraphTargets} from './deploy_bigquery';
import {DataType, Entity, Field, Metric, Relationship, SemanticModel} from './ir';
import {referencedEntityNames} from './sql_expr_utils';

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
}

export interface KcResources {
  entries: Entry[];
  entryLinks: EntryLink[];
  warnings: string[];
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
    aspects: aspectMap(names, {
      'semantic-model': modelAspectData(model),
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
    if (!entity.keys || !entity.keys.length) {
      warnings.push(
          `entity '${entity.name}': no keys declared in the source model`);
    }
    entries.push({
      name: names.entry(entityId),
      entryType: names.typeName('entry', 'semantic-entity'),
      parentEntry: modelEntryName,
      entrySource: source(entity.name, entity.description),
      // required_aspects: semantic-entity AND the built-in schema.
      aspects: aspectMap(names, {
        'semantic-entity': entityAspectData(entity),
        'schema': schemaAspectData(entity, emitExpr),
      }),
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
      aspects: aspectMap(names, {
        'semantic-metric': metricAspectData(metric, warnings, emitExpr),
      }),
    });
  }

  // Relationships map to schema-join entry links between their endpoint entries.
  const entryLinks: EntryLink[] = [];
  const seenLinks = new Set<string>();
  for (const rel of relationships) {
    const link = relationshipLink(
        names, model, rel, entityEntryName, seenLinks, warnings);
    if (link) entryLinks.push(link);
  }

  return {entries, entryLinks, warnings: [...new Set(warnings)]};
}


// Builds the schema-join entry link for one relationship, or undefined when it
// cannot be published. A many-to-many (association) edge is skipped -- a junction
// is two joins, which the single source/target schema-join does not model -- and
// so is an edge whose endpoint entity was not emitted (e.g. skipped for a
// duplicate id). Both cases warn; the BigQuery property graph still carries the
// edge.
function relationshipLink(
    names: Namer, model: SemanticModel, rel: Relationship,
    entityEntryName: Map<string, string>, seenLinks: Set<string>,
    warnings: string[]): EntryLink|undefined {
  if (rel.association) {
    warnings.push(
        `relationship '${rel.name}': many-to-many (association) edges are not ` +
        `published to Knowledge Catalog yet; the edge lives in the BigQuery ` +
        `property graph.`);
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
  const linkId = names.linkId(model, rel);
  if (!claim(
          seenLinks, linkId, 'entry link', `relationship '${rel.name}'`,
          warnings))
    return undefined;

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
function schemaJoinAspectData(
    model: SemanticModel, rel: Relationship): Record<string, any> {
  const srcEntity = entityByName(model, rel.source.entity);
  const dstEntity = entityByName(model, rel.destination.entity);
  return {
    joins: [compact({
      source: {
        name: srcEntity ? srcEntity.dataSource : rel.source.entity,
        fields: rel.source.columns,
      },
      target: {
        name: dstEntity ? dstEntity.dataSource : rel.destination.entity,
        fields: rel.destination.columns,
      },
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


// ---------------------------------------------------------------------------
// Aspect-data mappers. Field names/nesting mirror the server aspect types'
// CLOSED metadataTemplates exactly (see file header); the golden tests pin
// these shapes so any schema-driven change is a visible, reviewable diff.
// ---------------------------------------------------------------------------

// semantic-model: the BigQuery Graph deployment target URIs this model deploys
// to (the same targets the BigQuery leg executes against). Empty data is valid;
// the aspect is still attached to satisfy the entry type's required_aspects.
function modelAspectData(model: SemanticModel): Record<string, any> {
  const {targets} = bigQueryGraphTargets(model);
  return compact({
    deploymentTargets: targets.length ? targets.map(t => t.uri) : undefined,
  });
}

// semantic-entity: the base table(s) backing the entity. `source` and its
// `resources` array are required by the aspect type. importedSystem/
// importedResource have no IR source today and are left unset.
function entityAspectData(entity: Entity): Record<string, any> {
  return {
    source: compact({
      resources: [resourcePath(entity.dataSource)],
    }),
  };
}

// The built-in schema aspect, carrying each field's column type plus the new
// per-field `semantics` block (expression / role). name,
// dataType, and metadataType are required per column.
function schemaAspectData(
    entity: Entity, emitExpressions: boolean): Record<string, any> {
  return {
    fields: (entity.fields ??
             []).map(f => compact({
                       name: f.name,
                       dataType: columnDataType(f.type),
                       metadataType: columnMetadataType(f.type),
                       description: f.description,
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
  };
}

// semantic-metric: the model-level aggregate. `dataType` is required by the
// aspect type; when the model does not declare one, fall back to NUMERIC
// (decimal) and warn (metrics are aggregates, so an exact numeric is the
// sensible default; dimensions, in schemaAspectData, default to STRING) rather
// than emit an invalid aspect.
function metricAspectData(
    metric: Metric, warnings: string[],
    emitExpressions: boolean): Record<string, any> {
  let dataType = metric.type ? columnDataType(metric.type) : undefined;
  if (!dataType) {
    warnings.push(
        `metric '${
            metric.name}': no datatype in the source model; defaulting the ` +
        `required semantic-metric.dataType to 'NUMERIC'`);
    dataType = 'NUMERIC';
  }
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
function linkSlug(s: string): string {
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


// ---------------------------------------------------------------------------
// Reader: Knowledge Catalog entries -> Semantic Model IR.
//
// The inverse of generateCatalogResources: it reconstructs the IR from the
// entries a pull hydrated (see deploy_knowledge_catalog.pullKnowledgeCatalog).
// `semantic-entity` / `semantic-metric` entries are grouped under their
// `semantic-model` anchor via `parentEntry`; entries of other types are
// ignored. Resources are matched by type-name SUFFIX, so a reader need not know
// which system-type project/location the emitter used.
//
// Fidelity is bounded by what the emitter persisted, so this read is the
// inverse of the WRITE, not of the authored document. It recovers names,
// descriptions, data sources, field datatypes (via the schema aspect) and
// DIMENSION roles, field/metric expressions, and each
// metric's attach entity (re-derived from its expression, as the loader does).
// It cannot recover what the emitter does not write: entity keys/unique keys,
// `ai_context`, field labels, `importedDialect`, `custom_extensions`, and
// relationships (the graph edges live in the BigQuery property graph, not the
// catalog).
// ---------------------------------------------------------------------------

export interface ReadResult {
  models: SemanticModel[];
  warnings: string[];
}

/**
 * Reconstructs the Semantic Model IR from Knowledge Catalog entries.
 *
 * Returns one model per `semantic-model` anchor plus any warnings (no anchor,
 * an orphaned child, an entry missing its aspect data). Entries must already be
 * hydrated with their `semantic-*` (and, for entities, `schema`) aspect data; a
 * BASIC list omits aspect data, so the puller re-fetches each entry first.
 */
export function modelsFromCatalogResources(entries: Entry[]): ReadResult {
  const warnings: string[] = [];

  const anchors = entries.filter(e => semanticType(e) === 'semantic-model');
  const entityEntries =
      entries.filter(e => semanticType(e) === 'semantic-entity');
  const metricEntries =
      entries.filter(e => semanticType(e) === 'semantic-metric');

  if (!anchors.length) {
    warnings.push('no semantic-model entry found; nothing to reconstruct');
    return {models: [], warnings: [...new Set(warnings)]};
  }

  // A child belongs to its anchor by parentEntry. When there is exactly one
  // anchor, children whose parentEntry does not resolve (e.g. a project-id
  // normalization mismatch) are still attached to it rather than dropped.
  const anchorNames = new Set(anchors.map(a => a.name));
  const soleAnchor = anchors.length === 1 ? anchors[0].name : undefined;
  const childrenOf = (anchorName: string, pool: Entry[]) => pool.filter(
      e => e.parentEntry === anchorName ||
          (soleAnchor === anchorName && !anchorNames.has(e.parentEntry ?? '')));

  const models = anchors.map(anchor => {
    const name = anchor.entrySource?.displayName ?? idOf(anchor.name);

    const entities = childrenOf(anchor.name, entityEntries)
                         .map(e => readEntity(e, warnings));
    const entityNames = entities.map(e => e.name);
    const metrics = childrenOf(anchor.name, metricEntries)
                        .map(e => readMetric(e, entityNames, warnings));

    // Relationships are not published to the catalog (see the file header), so
    // a reconstructed model always has an empty edge set.
    const model: SemanticModel = {name, entities, relationships: [], metrics};
    const description = anchor.entrySource?.description;
    if (description !== undefined) model.description = description;
    return model;
  });

  // Flag children that resolved to no anchor at all (only possible with
  // multiple anchors, where the sole-anchor fallback does not apply).
  if (!soleAnchor) {
    for (const child of [...entityEntries, ...metricEntries]) {
      if (!child.parentEntry || !anchorNames.has(child.parentEntry)) {
        warnings.push(`entry '${
            child.name}' has no resolvable parent semantic-model; omitted`);
      }
    }
  }

  return {models, warnings: [...new Set(warnings)]};
}


// Reconstructs an entity from its `semantic-entity` aspect (the backing source)
// and the built-in `schema` aspect (its fields). Keys are not persisted by the
// emitter and so come back empty.
function readEntity(entry: Entry, warnings: string[]): Entity {
  const name = entry.entrySource?.displayName ?? idOf(entry.name);
  const semantic = aspectData(entry, 'semantic-entity');
  const schema = aspectData(entry, 'schema');
  if (!Object.keys(semantic).length) {
    warnings.push(`entity '${
        name}': no semantic-entity aspect data (fetch with the aspect type)`);
  }

  const dataSource = dataSourceFromResource(semantic?.source?.resources?.[0]);
  if (!dataSource) {
    warnings.push(
        `entity '${name}': no backing data source in the semantic-entity ` +
        `aspect; 'source' will be empty and the entity may not load`);
  }
  const entity: Entity = {
    name,
    dataSource,
    keys: [],  // not persisted by the emitter; unrecoverable on read
    fields: asArray(schema.fields).map(fd => readField(fd, name, warnings)),
  };
  const description = entry.entrySource?.description;
  if (description !== undefined) entity.description = description;
  return entity;
}


// Reconstructs a field from one `schema` aspect field record, inverting
// schemaAspectData: the datatype from dataType/metadataType, expressions from
// the nested `semantics` block, and the DIMENSION role back to a dimension
// marker.
function readField(fd: any, entityName: string, warnings: string[]): Field {
  const name = fd?.name;
  if (name === undefined || name === '') {
    warnings.push(
        `entity '${entityName}': a schema field is missing its name; the ` +
        `field may not load`);
  }
  const field: Field = {name};
  const sem = fd?.semantics ?? {};
  if (sem.expression !== undefined) field.expression = sem.expression;
  const type = irDataType(fd?.dataType, fd?.metadataType);
  if (type !== undefined) field.type = type;
  if (sem.role === 'DIMENSION') field.dimension = {};
  if (fd?.description !== undefined) field.description = fd.description;
  return field;
}


// Reconstructs a metric from its `semantic-metric` aspect. The attach `entity`
// is re-derived from the expression (as the loader does) rather than read from
// the aspect, so it stays consistent with the reconstructed entity set.
function readMetric(
    entry: Entry, entityNames: string[], warnings: string[]): Metric {
  const name = entry.entrySource?.displayName ?? idOf(entry.name);
  const data = aspectData(entry, 'semantic-metric');
  if (data.expression === undefined) {
    warnings.push(`metric '${name}': no expression in semantic-metric aspect`);
  }

  const metric: Metric = {name};
  if (data.expression !== undefined) metric.expression = data.expression;
  const exprForRefs = data.expression ?? '';
  const referenced = referencedEntityNames(exprForRefs, entityNames);
  if (referenced.length === 1) {
    metric.entity = referenced[0];
  } else if (exprForRefs && !referenced.length) {
    // Parity with the loader's convertMetric: an expression that qualifies no
    // known entity is flagged as potentially unplaceable downstream.
    warnings.push(
        `metric '${name}': expression references no known entity; it may not ` +
        `be placeable downstream`);
  }
  // The emitter writes a required dataType, defaulting a typeless metric to
  // NUMERIC (see metricAspectData); NUMERIC maps back to Decimal, so a metric
  // authored without a datatype round-trips as an explicit Decimal rather than
  // un-typed. (Dimensions differ: their STRING default reads back as un-typed.)
  const type = irDataType(data.dataType, undefined);
  if (type !== undefined) metric.type = type;
  const description = entry.entrySource?.description;
  if (description !== undefined) metric.description = description;
  return metric;
}


// The inverse of columnDataType/columnMetadataType: maps the schema aspect's
// dataType (disambiguated by metadataType only for the STRING family) back to
// the IR's logical DataType. STRING + OTHER is Opaque; a plain STRING is read
// as un-typed (undefined) -- the loader's default -- since the emitter cannot
// distinguish an authored `String` from an un-typed field (both emit STRING).
function irDataType(dataType: string|undefined, metadataType: string|undefined):
    DataType|undefined {
  switch (dataType) {
    case 'INT64':
      return 'Integer';
    case 'NUMERIC':
      return 'Decimal';
    case 'FLOAT64':
      return 'Float';
    case 'BOOL':
      return 'Boolean';
    case 'DATE':
      return 'Date';
    case 'TIME':
      return 'Time';
    case 'DATETIME':
      return 'DateTime';
    case 'TIMESTAMP':
      return 'DateTimeTz';
    case 'STRING':
      return metadataType === 'OTHER' ? 'Opaque' : undefined;
    default:
      return undefined;
  }
}


// The inverse of resourcePath: a BigQuery linked-resource URI becomes the
// canonical `project.dataset.table` string; anything else (a verbatim query or
// a passthrough reference) is returned unchanged.
function dataSourceFromResource(resource: string|undefined): string {
  const value = (resource ?? '').trim();
  const m = value.match(
      /^\/\/bigquery\.googleapis\.com\/projects\/([^/]+)\/datasets\/([^/]+)\/tables\/([^/]+)$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : value;
}


// The bare `semantic-*` type of an entry, matched by entryType suffix so the
// system-type project/location need not be known. Returns undefined for entries
// that are not part of a semantic model.
function semanticType(entry: Entry): 'semantic-model'|'semantic-entity'|
    'semantic-metric'|undefined {
  for (const t of ['semantic-model', 'semantic-entity', 'semantic-metric'] as
       const) {
    if (entry.entryType?.endsWith(`/entryTypes/${t}`)) return t;
  }
  return undefined;
}


// The `data` payload of an entry's aspect of the given bare type, matched by
// the aspect key's `.<type>` suffix or the aspectType's `/aspectTypes/<type>`
// suffix (robust to whichever system-type project/location the emitter used).
// Returns an empty object when the aspect is absent.
function aspectData(entry: Entry, type: string): Record<string, any> {
  const aspects = entry.aspects ?? {};
  for (const [key, aspect] of Object.entries(aspects)) {
    if (key.endsWith(`.${type}`) ||
        aspect.aspectType?.endsWith(`/aspectTypes/${type}`)) {
      return aspect.data ?? {};
    }
  }
  return {};
}


// The id segment of a full entry resource name (after the last '/').
export function idOf(name: string): string {
  return name.split('/').pop() ?? name;
}


function asArray(value: any): any[] {
  return Array.isArray(value) ? value : [];
}
