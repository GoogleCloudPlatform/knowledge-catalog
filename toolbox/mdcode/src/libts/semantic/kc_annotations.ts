// The annotation aspects: what a push writes so that a pull gets the whole
// model back (K1, lossless push/pull).
//
// The built-in `semantic-*`, `schema` and `guidelines` templates are CLOSED,
// and each lacks slots kcmd needs: `guidelines` holds only an element's
// instructions, `schema` collapses an authored String and an untyped field and
// has no expression (outside the gated `semantics` block), and nothing holds
// an entity's binding mode, hydration rules or vocabulary members. Those used
// to ride as trailing paragraphs of the entry description (they still do, for
// a human or an agent reading it), which a pull parsed back -- lossily.
//
// kcmd owns three aspect-only types for them (kc_custom_types.ts):
//
//   semantic-ai-context   model / entity / metric entry: the element's whole
//                         ai_context, its fields' ai_context, and (on the model
//                         entry) each relationship's authored name + ai_context
//                         -- an entry link carries no custom aspect -- and,
//                         whole, each relationship that publishes no link
//                         (abstract, or an abstract / column-less endpoint).
//   semantic-expressions  entity / metric entry: the metric's expression, and
//                         per field its expression, imported vendor SQL,
//                         dimension role and logical type.
//   semantic-binding      entity entry: binding mode, hydration rules,
//                         vocabulary members, and the physical assets it is
//                         read through (node view, graph, node label); on a
//                         junction entry, the many-to-many relationship.
//
// Each is attached only when `kcmd init` provisioned it (see
// provisionedCustomAspects) and only when the element has content for it, so
// a model that uses none of these constructs publishes exactly what it did
// before. When an aspect is present the reader treats it as authoritative for
// what it covers; the trailers and the built-in aspects are the fallback for
// catalogs pushed before it existed.
//
// Pure: no I/O. knowledge_catalog.ts calls the writers, kc_converter.ts the
// readers.

import type {Aspect, Entry} from '../gcp/dataplex';

import {AiContext, DATA_TYPES, DataType, Entity, EntityBindingMode, EntityHydration, Field, Metric, NormalizeRule, Relationship, ResolveRule, SemanticModel, VocabularyMember} from './ir';
import {AI_CONTEXT_TYPE_ID, aiContextAspectValue, aiContextFromAspect, BINDING_TYPE_ID, customAspectKey, customAspectTypeName, EXPRESSIONS_TYPE_ID} from './kc_custom_types';

/** Which annotation aspects a push may attach, and where their types live. */
export interface AnnotationTarget {
  // Ids of the provisioned annotation aspect types (a subset of
  // ANNOTATION_ASPECT_IDS).
  aspects: ReadonlySet<string>;
  // The destination project (custom types live there, at `global`).
  dest: {project: string};
}

/** The physical assets an entity is read through, as the BigQuery leg builds them. */
export interface EntityPhysical {
  nodeView?: string;   // project.dataset.view
  graph?: string;      // project.dataset.graph
  graphNode?: string;  // node label
}

/** A relationship's index row on the model entry. */
export interface RelationshipIndexRow {
  name: string;
  link?: string;
  aiContext?: AiContext;
  // A relationship that publishes no schema-join link (abstract, or an
  // endpoint that is abstract or has no join columns): the row is its only
  // record, so it carries the whole relationship (minus name and ai_context,
  // which the row holds anyway). Absent when `link` is set.
  unpublished?: UnpublishedRelationship;
}

export type UnpublishedRelationship = Omit<Relationship, 'name'|'aiContext'>;

// The index-row fields of an unpublished relationship (see
// kc_custom_types.UNPUBLISHED_RELATIONSHIP_FIELDS).
function unpublishedData(rel: UnpublishedRelationship|undefined):
    Record<string, any> {
  if (!rel) return {};
  return compact({
    source: rel.source.entity,
    destination: rel.destination.entity,
    sourceColumns: rel.source.columns.length ? [...rel.source.columns] :
                                               undefined,
    destinationColumns: rel.destination.columns.length ?
        [...rel.destination.columns] :
        undefined,
    abstract: rel.abstract ? true : undefined,
    extends: rel.extends?.length ? [...rel.extends] : undefined,
    description: rel.description,
    inverse: rel.inverse,
    via: rel.via?.length ?
        rel.via.map(s => `${s.inverse ? '~' : ''}${s.relationship}`) :
        undefined,
    filter: rel.filter,
  });
}

function readUnpublished(row: any): UnpublishedRelationship|undefined {
  const source = str(row?.source);
  const destination = str(row?.destination);
  if (!source || !destination) return undefined;
  const rel: UnpublishedRelationship = {
    source: {entity: source, columns: strings(row?.sourceColumns) ?? []},
    destination:
        {entity: destination, columns: strings(row?.destinationColumns) ?? []},
  };
  const parents = strings(row?.extends);
  if (parents) rel.extends = parents;
  if (row?.abstract === true) rel.abstract = true;
  const description = str(row?.description);
  if (description) rel.description = description;
  const inverse = str(row?.inverse);
  if (inverse) rel.inverse = inverse;
  const via = strings(row?.via);
  if (via) {
    rel.via = via.map(
        s => s.startsWith('~') ? {relationship: s.slice(1), inverse: true} :
                                 {relationship: s});
  }
  const filter = str(row?.filter);
  if (filter) rel.filter = filter;
  return rel;
}

function wrap(target: AnnotationTarget, id: string,
              data: Record<string, any>|undefined): Record<string, Aspect> {
  if (!data || !target.aspects.has(id)) return {};
  return {
    [customAspectKey(id, target.dest)]:
        {aspectType: customAspectTypeName(id, target.dest), data},
  };
}

function compact<T extends Record<string, any>>(obj: T): T {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}

function nonEmpty(obj: Record<string, any>): Record<string, any>|undefined {
  return Object.keys(obj).length ? obj : undefined;
}

// ---------------------------------------------------------------------------
// Writers.
// ---------------------------------------------------------------------------

function aiContextData(
    own: AiContext|undefined, fields: Field[] = [],
    relationships?: RelationshipIndexRow[]): Record<string, any>|undefined {
  const fieldRows = fields.flatMap(f => {
    const ai = aiContextAspectValue(f.aiContext);
    return ai ? [{name: f.name, aiContext: ai}] : [];
  });
  return nonEmpty(compact({
    aiContext: aiContextAspectValue(own),
    fields: fieldRows.length ? fieldRows : undefined,
    relationships: relationships?.length ?
        relationships.map(r => compact({
          name: r.name,
          link: r.link,
          aiContext: aiContextAspectValue(r.aiContext),
          ...unpublishedData(r.unpublished),
        })) :
        undefined,
  }));
}

function expressionParts(x: Field|Metric): Record<string, any> {
  return compact({
    expression: x.expression,
    importedExpression: x.importedExpression,
    importedDialect: x.importedDialect,
    type: x.type,
  });
}

function expressionsData(entity: Entity): Record<string, any>|undefined {
  // One row per field, even a bare `{name}`: the aspect is authoritative on
  // read, and a row with no `type` is what says "untyped" (the schema aspect
  // publishes that as Opaque).
  const rows = entity.fields.map(f => {
    const row: Record<string, any> = expressionParts(f);
    if (f.dimension) {
      row.dimension = true;
      if (f.dimension.isTime !== undefined) row.isTime = f.dimension.isTime;
    }
    return {name: f.name, ...row};
  });
  return rows.length ? {fields: rows} : undefined;
}

function hydrationData(h: EntityHydration|undefined): Record<string, any>|
    undefined {
  if (!h) return undefined;
  return nonEmpty(compact({
    grain: h.grain ? compact({
      latestBy: h.grain.latestBy,
      deterministic: h.grain.deterministic,
    }) :
                     undefined,
    normalize: h.normalize?.length ?
        h.normalize.map(r => compact({
          field: r.field,
          before: r.before,
          after: r.after,
          divideBy: r.divideBy,
          multiplyBy: r.multiplyBy,
          on: r.on,
        })) :
        undefined,
    resolve: h.resolve?.length ?
        h.resolve.map(r => ({field: r.field, match: [...r.match]})) :
        undefined,
    deriveFrom: h.deriveFrom?.relationship,
  }));
}

function membersData(members: VocabularyMember[]|undefined):
    Record<string, any>[]|undefined {
  if (!members) return undefined;
  return members.map(m => compact({
    code: m.code,
    label: m.label,
    synonyms: m.synonyms?.length ? [...m.synonyms] : undefined,
    definition: m.definition,
    order: m.order,
    iri: m.iri,
  }));
}

function bindingData(entity: Entity, physical: EntityPhysical|undefined):
    Record<string, any>|undefined {
  return nonEmpty(compact({
    mode: entity.mode,
    hydration: hydrationData(entity.hydration),
    // An empty vocabulary still says "a vocabulary with no members": keep [].
    members: membersData(entity.members),
    nodeView: physical?.nodeView,
    graph: physical?.graph,
    graphNode: physical?.graphNode,
  }));
}

/** The annotation aspects of an entity entry. */
export function entityAnnotationAspects(
    entity: Entity, physical: EntityPhysical|undefined,
    target: AnnotationTarget): Record<string, Aspect> {
  return {
    ...wrap(target, AI_CONTEXT_TYPE_ID,
            aiContextData(entity.aiContext, entity.fields)),
    ...wrap(target, EXPRESSIONS_TYPE_ID, expressionsData(entity)),
    ...wrap(target, BINDING_TYPE_ID, bindingData(entity, physical)),
  };
}

/** The annotation aspects of a metric entry. */
export function metricAnnotationAspects(
    metric: Metric, target: AnnotationTarget): Record<string, Aspect> {
  return {
    ...wrap(target, AI_CONTEXT_TYPE_ID, aiContextData(metric.aiContext)),
    // Always attached (possibly empty): the semantic-metric aspect cannot tell
    // an authored String or Opaque metric from an untyped one.
    ...wrap(target, EXPRESSIONS_TYPE_ID, expressionParts(metric)),
  };
}

/** The annotation aspects of the model (anchor) entry. */
export function modelAnnotationAspects(
    model: SemanticModel, relationships: RelationshipIndexRow[],
    target: AnnotationTarget): Record<string, Aspect> {
  return wrap(target, AI_CONTEXT_TYPE_ID,
              aiContextData(model.aiContext, [], relationships));
}

/** The annotation aspect of a many-to-many relationship's junction entry. */
export function junctionAnnotationAspects(
    relationship: string, source: string, destination: string,
    target: AnnotationTarget): Record<string, Aspect> {
  return wrap(target, BINDING_TYPE_ID,
              {association: {relationship, source, destination}});
}

// ---------------------------------------------------------------------------
// Readers. Every value is checked rather than trusted: an aspect can be
// hand-edited in the catalog into a shape the writer never produces.
// ---------------------------------------------------------------------------

/** The data of an entry's annotation aspect, or undefined when absent. */
export function annotationData(entry: Pick<Entry, 'aspects'>, id: string):
    Record<string, any>|undefined {
  for (const [key, aspect] of Object.entries(entry.aspects ?? {})) {
    if (key.endsWith(`.${id}`) ||
        aspect?.aspectType?.endsWith(`/aspectTypes/${id}`)) {
      const data = aspect?.data;
      return data && typeof data === 'object' ? data : {};
    }
  }
  return undefined;
}

const str = (v: unknown): string|undefined =>
    typeof v === 'string' && v !== '' ? v : undefined;

const strings = (v: unknown): string[]|undefined => {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((s): s is string => typeof s === 'string' && s !== '');
  return out.length ? out : undefined;
};

const num = (v: unknown): number|undefined => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
};

const asArray = (v: unknown): any[] => Array.isArray(v) ? v : [];

function dataType(v: unknown): DataType|undefined {
  return (DATA_TYPES as readonly string[]).includes(v as string) ?
      v as DataType :
      undefined;
}

export interface AiContextAnnotation {
  aiContext?: AiContext;
  fields: Map<string, AiContext>;
  relationships: RelationshipIndexRow[];
}

export function readAiContextAnnotation(entry: Pick<Entry, 'aspects'>):
    AiContextAnnotation|undefined {
  const data = annotationData(entry, AI_CONTEXT_TYPE_ID);
  if (!data) return undefined;
  const fields = new Map<string, AiContext>();
  for (const row of asArray(data.fields)) {
    const name = str(row?.name);
    const ai = aiContextFromAspect(row?.aiContext);
    if (name && ai) fields.set(name, ai);
  }
  const relationships: RelationshipIndexRow[] = [];
  for (const row of asArray(data.relationships)) {
    const name = str(row?.name);
    if (!name) continue;
    const link = str(row?.link);
    relationships.push(compact({
      name,
      link,
      aiContext: aiContextFromAspect(row?.aiContext),
      unpublished: link ? undefined : readUnpublished(row),
    }));
  }
  return compact(
      {aiContext: aiContextFromAspect(data.aiContext), fields, relationships});
}

export interface ExpressionParts {
  expression?: string;
  importedExpression?: string;
  importedDialect?: string;
  type?: DataType;
}

export interface FieldExpressionParts extends ExpressionParts {
  dimension?: boolean;
  isTime?: boolean;
}

function readParts(row: any): ExpressionParts {
  return compact({
    expression: str(row?.expression),
    importedExpression: str(row?.importedExpression),
    importedDialect: str(row?.importedDialect),
    type: dataType(row?.type),
  });
}

export interface ExpressionsAnnotation extends ExpressionParts {
  fields: Map<string, FieldExpressionParts>;
}

export function readExpressionsAnnotation(entry: Pick<Entry, 'aspects'>):
    ExpressionsAnnotation|undefined {
  const data = annotationData(entry, EXPRESSIONS_TYPE_ID);
  if (!data) return undefined;
  const fields = new Map<string, FieldExpressionParts>();
  for (const row of asArray(data.fields)) {
    const name = str(row?.name);
    if (!name) continue;
    const parts: FieldExpressionParts = readParts(row);
    if (row?.dimension === true) parts.dimension = true;
    if (typeof row?.isTime === 'boolean') parts.isTime = row.isTime;
    fields.set(name, parts);
  }
  return {...readParts(data), fields};
}

/** Applies an entity's expressions annotation to the fields a pull read. */
export function applyFieldExpressions(
    fields: Field[], annotation: ExpressionsAnnotation): void {
  // Authoritative for what it covers: the schema aspect's dataType cannot
  // tell an authored String from an untyped field (and reads the latter back
  // as Opaque), and the gated `semantics` block may be stale or absent.
  for (const field of fields) {
    const parts = annotation.fields.get(field.name) ?? {};
    for (const key of ['expression', 'importedExpression', 'importedDialect',
                       'type'] as const) {
      if (parts[key] !== undefined) {
        (field as any)[key] = parts[key];
      } else {
        delete field[key];
      }
    }
    if (parts.dimension) {
      field.dimension = parts.isTime !== undefined ? {isTime: parts.isTime} : {};
    } else {
      delete field.dimension;
    }
  }
}

export interface BindingAnnotation {
  mode?: EntityBindingMode;
  hydration?: EntityHydration;
  members?: VocabularyMember[];
  physical: EntityPhysical;
  association?: {relationship: string; source?: string; destination?: string};
}

function readHydration(v: any): EntityHydration|undefined {
  if (!v || typeof v !== 'object') return undefined;
  const h: EntityHydration = {};
  if (v.grain && typeof v.grain === 'object') {
    const grain = compact({
      latestBy: str(v.grain.latestBy),
      deterministic:
          typeof v.grain.deterministic === 'boolean' ? v.grain.deterministic :
                                                       undefined,
    });
    if (Object.keys(grain).length) h.grain = grain;
  }
  const normalize = asArray(v.normalize).flatMap((r: any): NormalizeRule[] => {
    const field = str(r?.field);
    return field ? [compact({
      field,
      before: str(r.before),
      after: str(r.after),
      divideBy: num(r.divideBy),
      multiplyBy: num(r.multiplyBy),
      on: str(r.on),
    })] :
                   [];
  });
  if (normalize.length) h.normalize = normalize;
  const resolve = asArray(v.resolve).flatMap((r: any): ResolveRule[] => {
    const field = str(r?.field);
    const match = strings(r?.match);
    return field && match ? [{field, match}] : [];
  });
  if (resolve.length) h.resolve = resolve;
  const derive = str(v.deriveFrom);
  if (derive) h.deriveFrom = {relationship: derive};
  return Object.keys(h).length ? h : undefined;
}

function readMembers(v: unknown): VocabularyMember[]|undefined {
  if (!Array.isArray(v)) return undefined;
  return v.flatMap((m: any): VocabularyMember[] => {
    const code = typeof m?.code === 'string' ? m.code : undefined;
    if (code === undefined) return [];
    const order = num(m.order);
    return [compact({
      code,
      label: typeof m.label === 'string' ? m.label : undefined,
      synonyms: strings(m.synonyms),
      definition: typeof m.definition === 'string' ? m.definition : undefined,
      order: order !== undefined && Number.isInteger(order) ? order : undefined,
      iri: str(m.iri),
    })];
  });
}

export function readBindingAnnotation(entry: Pick<Entry, 'aspects'>):
    BindingAnnotation|undefined {
  const data = annotationData(entry, BINDING_TYPE_ID);
  if (!data) return undefined;
  const mode = data.mode === 'view' || data.mode === 'direct' ?
      data.mode as EntityBindingMode :
      undefined;
  const assoc = data.association;
  const relationship = str(assoc?.relationship);
  return compact({
    mode,
    hydration: readHydration(data.hydration),
    members: readMembers(data.members),
    physical: compact({
      nodeView: str(data.nodeView),
      graph: str(data.graph),
      graphNode: str(data.graphNode),
    }),
    association: relationship ? compact({
      relationship,
      source: str(assoc.source),
      destination: str(assoc.destination),
    }) :
                                undefined,
  });
}
