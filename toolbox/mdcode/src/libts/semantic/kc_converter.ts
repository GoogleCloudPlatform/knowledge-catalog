// Knowledge Catalog <-> Semantic Model IR converter.
//
// SCAFFOLD (naming for the end state): this file currently holds only the
// READ direction -- Knowledge Catalog entries -> IR (`modelsFromCatalogResources`
// and its helpers). The WRITE direction (IR -> KC entries,
// `generateCatalogResources`) still lives in `knowledge_catalog.ts` and moves
// here once PR4 (the KC push line) merges, at which point this becomes the full
// two-way converter and `knowledge_catalog.ts` goes away. Until then, "where is
// the KC emit code?" -> `knowledge_catalog.ts`.
//
// TODO(#278): fold the KC WRITE direction in and drop the scaffold. Once
// #278 merges, move `generateCatalogResources` (and the `KcResources` type
// + emit helpers) out of `knowledge_catalog.ts` into this file, delete
// `knowledge_catalog.ts`, and repoint its importers (`deploy_knowledge_catalog.ts`
// and the emitter tests). `idOf` -- shared by both directions and re-exported
// from here only for `pull_kc` today -- becomes a plain local. Then this is
// the sole KC<->IR codec and the SCAFFOLD note above comes out.
//
// The reader is the inverse of `generateCatalogResources`: it reconstructs the
// IR from the entries a pull hydrated (see `pull_kc.pullKnowledgeCatalog`).
// `semantic-entity` / `semantic-metric` entries are grouped under their
// `semantic-model` anchor via `parentEntry`; entries of other types are ignored.
// Resources are matched by type-name SUFFIX, so a reader need not know which
// system-type project/location the emitter used.
//
// Fidelity is bounded by what the emitter persisted, so this read is the inverse
// of the WRITE, not of the authored document. It recovers names, descriptions,
// data sources, field datatypes (via the schema aspect) and DIMENSION roles,
// field/metric expressions, and each metric's attach entity (re-derived from its
// expression, as the loader does). It cannot recover what the emitter does not
// write: entity keys/unique keys, `ai_context`, field labels, `importedDialect`,
// `custom_extensions`, and relationships (the graph edges live in the BigQuery
// property graph, not the catalog).

import type {Entry} from '../gcp/dataplex';
import {DataType, Entity, Field, Metric, SemanticModel} from './ir';
import {referencedEntityNames} from './sql_expr_utils';

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
