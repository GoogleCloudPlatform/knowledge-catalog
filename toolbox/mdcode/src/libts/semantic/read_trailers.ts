// How an agent reads an entity or a metric in BigQuery, written on its
// Knowledge Catalog entry.
//
// An agent grounds on `lookup_context`, which returns each entry's
// description and schema -- not its aspects and not its entry links. The
// names it needs to run a query live in exactly those places: an entity's
// node view and graph node in the `semantic-binding` aspect and the binding
// links, and a metric's measure in no catalog field at all (push derives it
// when it compiles the metric into a graph MEASURE). So push also writes them
// as the last paragraph of the description, the convention the other
// trailers follow (`Hydration:`, `Members:`, `Unit:`):
//
//   <entity description and trailers>
//
//   Read through: node view `p.d.order`; graph `p.d.shop_graph`, node Order.
//
//   <metric description>
//
//   Query: SELECT AGG(Order_revenue) FROM GRAPH_EXPAND("p.d.shop_graph")
//
// The query runs as written; a reader adds WHERE / GROUP BY over the same
// GRAPH_EXPAND's `<NodeTable>_<field>` columns. Both paragraphs are derived
// from the model and its BigQuery target, never authored: pull peels them off
// and drops them, and the next push writes them again.

import {googleDeploymentTargets} from './deployment_target';
import {snakeCase} from './generated_views';
import {Entity, SemanticModel} from './ir';
import {EntityPhysical} from './kc_annotations';
import {renderComposition} from './metric_composition';
import {MetricPlacement, planMetricGraphs} from './metric_slices';
import {lowerNodeViews} from './node_views';

/** The prefix of an entity's relationships paragraph. */
export const RELATIONSHIPS_PREFIX = 'Relationships: ';

/** Dataplex caps an entry's description (entrySource.description). */
export const DESCRIPTION_MAX = 2000;

// The column a reader joins on for one of a relationship's columns. Under a
// node view it is the view column of the field the relationship column names
// (snake_case of the field; the relationship may name the field or the column
// the field is bound to). Without one it is the table column itself.
function joinColumn(entity: Entity, column: string, nodeView: boolean): string {
  const bare = column.trim();
  const field = entity.fields.find(f => f.name === bare) ??
      entity.fields.find(f => (f.expression ?? '').trim() === bare);
  if (nodeView) return field ? snakeCase(field.name) : bare;
  const expr = (field?.expression ?? '').trim();
  return field?.name === bare && /^[A-Za-z_][A-Za-z0-9_]*$/.test(expr) ? expr :
                                                                        bare;
}

/**
 * The entity's relationships, one item per edge: `<edge> → <Entity> (<col> =
 * <col>)` for each edge from it and `<edge> ← <Entity> (…)` for each edge to
 * it, with the join columns of the views (or tables) both ends are read
 * through, this entity's column first. A many-to-many edge names its junction
 * table; a derived edge the relationships it is derived through. Abstract
 * relationships (no join) and edges to an entity with no physical binding are
 * left out. Empty for an entity with no physical binding.
 */
export function relationshipItems(
    entity: Entity, model: SemanticModel,
    physical: Map<string, EntityPhysical>): string[] {
  if (!physical.has(entity.name)) return [];
  const byName = new Map((model.entities ?? []).map(e => [e.name, e]));
  const items: string[] = [];
  for (const rel of model.relationships ?? []) {
    if (rel.abstract) continue;
    const out = rel.source.entity === entity.name;
    const inc = rel.destination.entity === entity.name;
    if (!out && !inc) continue;
    const src = byName.get(rel.source.entity);
    const dst = byName.get(rel.destination.entity);
    if (!src || !dst || !physical.has(src.name) || !physical.has(dst.name)) {
      continue;
    }
    const srcView = !!physical.get(src.name)!.nodeView;
    const dstView = !!physical.get(dst.name)!.nodeView;
    const join = (fromSrc: boolean): string => {
      if (rel.association) {
        return `many-to-many through \`${rel.association.dataSource}\``;
      }
      if (rel.via?.length) return `derived through ${rel.via.join(', ')}`;
      const s = rel.source.columns ?? [];
      const d = rel.destination.columns ?? [];
      return s.map((c, i) => {
                const sc = joinColumn(src, c, srcView);
                const dc = joinColumn(dst, d[i] ?? '', dstView);
                return fromSrc ? `${sc} = ${dc}` : `${dc} = ${sc}`;
              })
          .join(' and ');
    };
    if (out) items.push(`${rel.name} → ${dst.name} (${join(true)})`);
    if (inc) items.push(`${rel.name} ← ${src.name} (${join(false)})`);
  }
  return items;
}

/**
 * The relationships paragraph, at most `budget` characters: as many items as
 * fit, then `… N more`. Undefined when there are none or none fits.
 */
export function relationshipsTrailer(items: string[], budget: number): string|
    undefined {
  if (!items.length) return undefined;
  const all = `${RELATIONSHIPS_PREFIX}${items.join('; ')}.`;
  if (all.length <= budget) return all;
  for (let n = items.length - 1; n > 0; n--) {
    const cut = `${RELATIONSHIPS_PREFIX}${items.slice(0, n).join('; ')}; … ${
        items.length - n} more.`;
    if (cut.length <= budget) return cut;
  }
  return undefined;
}

/** The prefix of an entity's read-through paragraph. */
export const READ_THROUGH_PREFIX = 'Read through: ';

/** The prefix of a metric's query paragraph. */
export const QUERY_PREFIX = 'Query: ';

// Folds line breaks (and the indentation around them) to one space, so a
// trailer stays one paragraph and the blank-line split on pull cannot cut it.
function oneLine(text: string): string {
  return text.trim().replace(/\s*\n\s*/g, ' ');
}

/**
 * The paragraph naming what an entity is read through: its node view (the
 * source table under `mode: direct`), then its graph and node label.
 * Undefined for an entity with no physical binding (abstract, defined,
 * unbound), which `physicalBindings` leaves out.
 */
export function readThroughTrailer(
    entity: Pick<Entity, 'dataSource'>,
    physical: EntityPhysical|undefined): string|undefined {
  if (!physical) return undefined;
  const parts: string[] = [];
  const table = (entity.dataSource ?? '').trim();
  if (physical.nodeView) {
    parts.push(`node view \`${physical.nodeView}\``);
  } else if (table && !table.startsWith('unbound:')) {
    parts.push(`table \`${table}\``);
  }
  if (physical.graph && physical.graphNode) {
    parts.push(`graph \`${physical.graph}\`, node ${physical.graphNode}`);
  }
  return parts.length ? `${READ_THROUGH_PREFIX}${parts.join('; ')}.` :
                        undefined;
}

/**
 * The query that reads one metric where push deploys it: its measures,
 * composed as the metric's expression, over GRAPH_EXPAND of the graph that
 * holds them; or the metric's expression over its fallback view. Undefined
 * when no deployed object holds the metric.
 */
export function placementQuery(placement: MetricPlacement): string|undefined {
  switch (placement.kind) {
    case 'graph': {
      const {decomposition: d, homes, measures} = placement;
      const select = renderComposition(
          d.template, i => `AGG(${homes[i]}_${measures[i]})`);
      return oneLine(
          `SELECT ${select} FROM GRAPH_EXPAND("${placement.ref}")`);
    }
    case 'view':
      return oneLine(
          `SELECT ${placement.expression} FROM \`${placement.ref}\``);
    default:
      return undefined;
  }
}

/**
 * Per metric, its query (see placementQuery) on the model's first BigQuery
 * graph target -- the target `physicalBindings` and the graph push use. Empty
 * for a model with no metrics or no BigQuery target.
 */
export function metricQueries(model: SemanticModel): Map<string, string> {
  const out = new Map<string, string>();
  if (!(model.metrics ?? []).length) return out;
  let target: ReturnType<typeof googleDeploymentTargets>['bigQuery'][number]|
      undefined;
  try {
    target = googleDeploymentTargets(model).bigQuery[0];
  } catch {
    return out;  // malformed extension JSON: validation reports it
  }
  if (!target) return out;
  try {
    // Plan on the model the BigQuery push deploys: node-view lowered
    // (deploy_bigquery.ts), so measure names and placements match.
    let graphModel = model;
    try {
      graphModel = lowerNodeViews(
          model, {project: target.project, dataset: target.dataset}, []).model;
    } catch {
      // A model the lowering cannot plan binds directly; the graph push warns.
    }
    const plan = planMetricGraphs(graphModel, {
      project: target.project,
      dataset: target.dataset,
      graphName: target.graphName,
    });
    for (const [name, placement] of plan.placements) {
      const query = placementQuery(placement);
      if (query) out.set(name, query);
    }
  } catch {
    // A model the planner cannot handle gets no query paragraphs; the graph
    // push reports why.
  }
  return out;
}

/** A metric description with its query paragraph appended. */
export function withQueryTrailer(
    description: string|undefined, query: string|undefined): string|undefined {
  if (!query) return description;
  return [description, `${QUERY_PREFIX}${query}`]
      .filter((p): p is string => !!p)
      .join('\n\n');
}

const READ_THROUGH = new RegExp(
    '^Read through: (?:(?:node view|table) `[^`]+`' +
    '(?:; graph `[^`]+`, node \\S+)?|graph `[^`]+`, node \\S+)\\.$');
const QUERY = /^Query: SELECT .+ FROM (?:GRAPH_EXPAND\("[^"]+"\)|`[^`]+`)$/;

// Removes the last paragraph of `text` when it matches `shape`.
function peel(text: string|undefined, shape: RegExp): {rest: string|undefined} {
  if (text === undefined) return {rest: undefined};
  const paragraphs = text.split('\n\n');
  if (!shape.test(paragraphs[paragraphs.length - 1])) return {rest: text};
  const rest = paragraphs.slice(0, -1).join('\n\n');
  return {rest: rest === '' ? undefined : rest};
}

/**
 * Peels the read-through paragraph (see readThroughTrailer) off a pulled
 * entity description. Text without one is returned untouched.
 */
export function splitReadThroughTrailer(text: string|undefined):
    {rest: string|undefined} {
  return peel(text, READ_THROUGH);
}

/**
 * Peels the query paragraph (see withQueryTrailer) off a pulled metric
 * description. Text without one is returned untouched.
 */
export function splitQueryTrailer(text: string|undefined):
    {rest: string|undefined} {
  return peel(text, QUERY);
}

const RELATIONSHIPS = /^Relationships: .*\S+ [→←] \S+ \(.*\)(?:; … \d+ more)?\.$/;

/**
 * Peels the relationships paragraph (see relationshipsTrailer) off a pulled
 * entity description. Text without one is returned untouched.
 */
export function splitRelationshipsTrailer(text: string|undefined):
    {rest: string|undefined} {
  return peel(text, RELATIONSHIPS);
}
