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
import {Entity, SemanticModel} from './ir';
import {EntityPhysical} from './kc_annotations';
import {renderComposition} from './metric_composition';
import {MetricPlacement, planMetricGraphs} from './metric_slices';
import {lowerNodeViews} from './node_views';

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
