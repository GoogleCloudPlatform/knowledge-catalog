// Generates Knowledge Catalog resources from the Semantic Model IR.
//
// The IR (./ir) is pure semantics. This module is its Knowledge Catalog
// emitter, the counterpart to `bigquery.ts`: it maps the model to catalog
// Entries, each carrying the `semantic-*` Aspect(s) that describe it. Like
// `bigquery.ts` it is a PURE function of the IR: no GCP calls, no I/O. The
// orchestration layer (`deploy_knowledge_catalog.ts`, the counterpart to
// `deploy.ts`) drives this emitter and writes the resulting resources via the
// Knowledge Catalog client.
//
// Target schema (go/semantic-model-kc-v2): the `semantic-model`,
// `semantic-entity`, and `semantic-metric` entry/aspect types are built-in
// system types under `dataplex-types/global` (nonprod for now), alongside the
// built-in `schema` aspect. This emitter references them; it never provisions
// them. Each entry type declares `required_aspects`, so the emitted aspect set
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
//   * semantic-metric = { entity?, dataType (required), expression?,
//                         importedExpression? }
//   * schema          = { fields: [{ name, dataType, metadataType,
//                                    description?, semantics: { expression?,
//                                    importedExpression?, role } }] }
//
// Relationships are NOT emitted: there is no user-writable, directed entry link
// type valid over `semantic-entity` endpoints, and no relationship aspect. The
// graph edges are carried by the BigQuery property graph (see bigquery.ts);
// this emitter warns that they are not published to the catalog.
//

import type {Aspect, Entry} from '../gcp/dataplex';

import {bigQueryGraphTargets} from './deploy';
import {DataType, Entity, Metric, SemanticModel} from './ir';

// Where the `semantic-*` and `schema` system types live. The v2 design lands
// them as built-in types in project `dataplex-types`, location `global`;
// callers may override for a staging project during the nonprod-only window.
const DEFAULT_TYPE_PROJECT = 'dataplex-types';
const DEFAULT_TYPE_LOCATION = 'global';

export interface KcGenerateOptions {
  project: string;     // project the entries are created in (destination)
  location: string;    // destination location
  entryGroup: string;  // destination entry group
  systemTypeProject?: string;   // default 'dataplex-types'
  systemTypeLocation?: string;  // default 'global'
}

export interface KcResources {
  entries: Entry[];
  warnings: string[];
}

/**
 * Generates the Knowledge Catalog resources for a semantic model.
 *
 * Returns the entries (model anchor first, then entities and metrics) and any
 * warnings collected while mapping the IR (missing keys, un-typed metrics,
 * deferred relationships). The resources reference the built-in system types;
 * they do not create them.
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

  for (const entity of entities) {
    const entityId = names.entityId(model, entity);
    if (!claim(seen, entityId, 'entry', `entity '${entity.name}'`, warnings))
      continue;
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
        'schema': schemaAspectData(entity),
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
        'semantic-metric': metricAspectData(metric, warnings),
      }),
    });
  }

  if (relationships.length) {
    warnings.push(
        `${relationships.length} relationship${
            relationships.length === 1 ? '' : 's'} not ` +
        `published to Knowledge Catalog: no user-writable entry link type is valid over ` +
        `semantic-entity endpoints; the graph edges live in the BigQuery property graph.`);
  }

  return {entries, warnings: [...new Set(warnings)]};
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
// per-field `semantics` block (expression / importedExpression / role). name,
// dataType, and metadataType are required per column.
function schemaAspectData(entity: Entity): Record<string, any> {
  return {
    fields: (entity.fields ??
             []).map(f => compact({
                       name: f.name,
                       dataType: columnDataType(f.type),
                       metadataType: columnMetadataType(f.type),
                       description: f.description,
                       semantics: compact({
                         expression: f.expression,
                         importedExpression: f.importedExpression,
                         // A field with any dimension metadata is a dimension;
                         // otherwise DEFAULT.
                         role: f.dimension ? 'DIMENSION' : 'DEFAULT',
                       }),
                     })),
  };
}

// semantic-metric: the model-level aggregate. `dataType` is required by the
// aspect type; when the model does not declare one, fall back to STRING and
// warn rather than emit an invalid aspect.
function metricAspectData(
    metric: Metric, warnings: string[]): Record<string, any> {
  let dataType = metric.type ? columnDataType(metric.type) : undefined;
  if (!dataType) {
    warnings.push(
        `metric '${
            metric.name}': no datatype in the source model; defaulting the ` +
        `required semantic-metric.dataType to 'STRING'`);
    dataType = 'STRING';
  }
  return compact({
    entity: metric.entity,
    dataType,
    expression: metric.expression,
    importedExpression: metric.importedExpression,
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
  typeName(kind: 'entry'|'aspect', name: string): string {
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

function unquote(part: string): string {
  return part.replace(/^[`"]/, '').replace(/[`"]$/, '');
}
