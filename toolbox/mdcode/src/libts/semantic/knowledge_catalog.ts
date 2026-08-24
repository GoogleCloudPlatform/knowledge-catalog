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
// still lives in the BigQuery property graph, see bigquery.ts).
//

import type {Aspect, Entry, EntryLink} from '../gcp/dataplex';

import {bigQueryGraphTargets} from './deploy_bigquery';
import {AiContext, DataType, Entity, Metric, Relationship, SemanticModel} from './ir';

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
            'schema': schemaAspectData(entity, emitExpr),
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

  // Relationships map to schema-join entry links between their endpoint entries.
  const entryLinks: EntryLink[] = [];
  const seenLinks = new Set<string>();
  for (const rel of relationships) {
    const link = relationshipLink(
        names, model, rel, entityEntryName, seenLinks, warnings);
    if (link) entryLinks.push(link);
  }

  return {
    entries,
    entryLinks,
    warnings: [...new Set(warnings)],
    // Ossie ids are dotted: `<model>.entities.<name>` / `<model>.metrics.<name>`.
    ownedPrefixes: [`${modelId}.entities.`, `${modelId}.metrics.`],
  };
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

  // The name lives only in the link id (schema-join's aspect has no name
  // field), and link ids are normalized -- lowercase, hyphens only. When the
  // authored name is not already in that form, a later pull recovers it
  // lowercased and hyphenated, not verbatim; warn so the round-trip change is
  // not a surprise.
  const normalizedName = linkSlug(rel.name);
  if (normalizedName !== rel.name) {
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
