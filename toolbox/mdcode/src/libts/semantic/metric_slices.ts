// Automatic metric slicing (K6, a proposed kcmd enhancement): small
// GRAPH_EXPAND-ready property graphs cut from a model for its metrics.
//
// GRAPH_EXPAND is how a graph MEASURE is read without an Enterprise
// reservation (GQL needs one; GRAPH_EXPAND runs on-demand). It flattens a
// property graph into one wide table by LEFT JOINing outward from the graph's
// single ROOT node table, and it accepts only:
//   - at most 10 node tables;
//   - exactly one root (a node table no edge points into), with every other
//     node reached by exactly one path -- a tree, no convergent paths;
//   - measures on labels no other element table shares (leaf labels).
// A model's main graph rarely qualifies: it holds every entity, several facts
// (several roots), inverse edges (which point back into the fact) and
// diamonds. So for each FACT entity -- the entity a metric aggregates -- this
// module cuts a slice:
//
//   1. the fact is the root; the entities the metric's aggregates read are
//      reached along many-to-one relationships (shortest path, breadth-first,
//      relationships taken in name order);
//   2. the tree then grows breadth-first with further many-to-one dimensions
//      of the fact, each reached once, never through an inverse or a
//      many-to-many edge, until it has 10 node tables;
//   3. the abstract (and any concrete, table-less here) ancestors of the kept
//      entities become labels only, so `MATCH`-style label reads still work;
//   4. the slice carries only its metrics, as MEASUREs -- a composite metric
//      as its single-aggregate components (metric_composition.ts).
// Each slice is deployed next to the main graph as
// `<main graph>__<fact in snake_case>_metrics`. The main graph is unchanged.
//
// A fact group the main graph already serves -- the slice would be the whole
// main graph, every metric already a MEASURE there -- gets no slice. A metric
// no slice can hold (its aggregates read entities no one of them reaches
// through many-to-one relationships, a convergent path, more than 10 node
// tables, an aggregate a MEASURE cannot be) falls back to a generated SQL VIEW:
// one row per fact record, the dimensions joined along the same many-to-one
// paths, columns named `<Entity>_<field>` like GRAPH_EXPAND output. The view
// is `<main graph>__<fact in snake_case>_metrics_view`; each fallback is a
// warning in the push output.
//
// Everything is deterministic: entities, relationships and metrics are taken
// in name order, so declaration order never changes a slice.

import {generatePropertyGraph} from './bigquery';
import {lowerDefinedEntities, resolveDefinedEntities} from './defined_entities';
import {Entity, fieldBinding, inverseEdgeNames, Metric, Relationship, relationshipAncestors, SemanticModel} from './ir';
import {CompositionContext, decomposeMetric, DUPLICATE_INSENSITIVE, findAggregateCalls, MetricDecomposition, simpleMetricIndex} from './metric_composition';
import {resolveInheritance} from './resolve_inheritance';
import {escapeRegExp, mapOutsideStringLiterals, referencedEntityNames, stripQualifier} from './sql_expr_utils';
import {isSimpleIdentifier, quoteIdentifier, quoteIfReserved} from './sql_identifiers';
import {isVocabulary} from './vocabulary';

/** GRAPH_EXPAND accepts at most this many node tables (BigQuery limit). */
export const GRAPH_EXPAND_MAX_NODE_TABLES = 10;

/** Where the main graph is deployed; slices and views go next to it. */
export interface MetricGraphTarget {
  project: string;
  dataset: string;
  graphName: string;
}

export interface MetricGraphOptions {
  /** Node-table limit per slice. Defaults to GRAPH_EXPAND_MAX_NODE_TABLES. */
  maxNodeTables?: number;
}

/** One kept relationship of a slice or view: `from` -> `to`. */
export interface SliceEdge {
  relationship: string;
  from: string;
  to: string;
}

/** A GRAPH_EXPAND-ready property graph for one fact entity's metrics. */
export interface MetricSlice {
  fact: string;
  graphName: string;
  /** `project.dataset.graph`. */
  ref: string;
  uri: string;
  /** Node tables: the fact first, then breadth-first. */
  nodeTables: string[];
  /** The tree, breadth-first: the relationship that reaches each node. */
  edges: SliceEdge[];
  /** Ancestors kept as labels only, sorted. */
  labels: string[];
  /** Relationships among the node tables left out of the tree, sorted. */
  omitted: string[];
  /** The metrics read on this slice, sorted. */
  metrics: string[];
  /** Measure name -> the node table it is declared on. */
  measures: Map<string, string>;
  /** The slice as a model, as handed to the graph generator. */
  model: SemanticModel;
  ddl: string;
}

/** The SQL view metrics no graph can hold fall back to. */
export interface MetricView {
  fact: string;
  viewName: string;
  ref: string;
  uri: string;
  /** The joined entities: the fact first, then breadth-first. */
  entities: string[];
  edges: SliceEdge[];
  metrics: string[];
  /** Column names, in SELECT order. */
  columns: string[];
  /** `Entity.field` -> the view column that carries it. */
  columnFor: Map<string, string>;
  sql: string;
}

/** Where to read one metric. */
export type MetricPlacement = {
  kind: 'graph';
  /** `project.dataset.graph` of the graph to GRAPH_EXPAND. */
  ref: string;
  graphName: string;
  /** False when the main graph itself serves the metric. */
  slice: boolean;
  fact: string;
  decomposition: MetricDecomposition;
  /** The node table each component's MEASURE is declared on. */
  homes: string[];
  /**
   * Each component's MEASURE name: the component's own name, or
   * `<name>__measure` when that is a column of its node table (see
   * bigquery.ts measureNameFor). A reader selects AGG(<home>_<measure>).
   */
  measures: string[];
}|{
  kind: 'view';
  ref: string;
  viewName: string;
  fact: string;
  /** Why no graph can hold it. */
  reason: string;
  /** The metric's expression over the view's columns. */
  expression: string;
}|{
  kind: 'none';
  reason: string;
};

export interface MetricGraphPlan {
  target: MetricGraphTarget;
  mainRef: string;
  slices: MetricSlice[];
  views: MetricView[];
  /** Metric name -> where to read it. Every metric of the model has one. */
  placements: Map<string, MetricPlacement>;
  warnings: string[];
}

/** `<main>__<fact_snake>_metrics`: the slice graph for a fact entity. */
export function sliceGraphName(mainGraph: string, fact: string): string {
  return `${mainGraph}__${snakeCase(fact)}_metrics`;
}

/** `<main>__<fact_snake>_metrics_view`: the fallback view for a fact entity. */
export function fallbackViewName(mainGraph: string, fact: string): string {
  return `${sliceGraphName(mainGraph, fact)}_view`;
}

/** `OrderLine` -> `order_line`, `HTTPLog` -> `http_log`. */
export function snakeCase(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1_$2')
             .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
             .replace(/[^A-Za-z0-9_]+/g, '_')
             .replace(/_+/g, '_')
             .replace(/^_|_$/g, '')
             .toLowerCase() ||
      'entity';
}


// ---------------------------------------------------------------------------
// The model as a graph of many-to-one edges.
// ---------------------------------------------------------------------------

interface GraphView {
  /** Lowered entities with inheritance resolved (flattened fields). */
  entities: Map<string, Entity>;
  /** Lowered entities as declared, for copying into a slice model. */
  declared: Map<string, Entity>;
  relationships: Map<string, Relationship>;
  /** Entities that form a node table: concrete and keyed. */
  nodes: Set<string>;
  /** Node -> its many-to-one edges to other nodes, in name order. */
  out: Map<string, Relationship[]>;
  /** Edge tables the main graph renders (forward, inverse, many-to-many). */
  mainEdgeTables: number;
}

function byName<T extends {name: string}>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function graphView(lowered: SemanticModel, resolved: SemanticModel): GraphView {
  const entities = new Map((resolved.entities ?? []).map(e => [e.name, e]));
  const declared = new Map((lowered.entities ?? []).map(e => [e.name, e]));
  const rels = [...(lowered.relationships ?? [])].sort(byName);
  const nodes = new Set(
      [...entities.values()]
          .filter(e => !e.abstract && (e.keys ?? []).length > 0)
          .map(e => e.name));
  const out = new Map<string, Relationship[]>();
  const rendered = rels.filter(
      r => !r.abstract && nodes.has(r.source.entity) &&
          nodes.has(r.destination.entity));
  for (const r of rendered) {
    if (r.association || r.source.entity === r.destination.entity) continue;
    // An edge the graph renders over a generated edge VIEW rather than over
    // its source's own table -- a foreign key into a vocabulary (matched
    // case-insensitively, vocabulary.ts) or a derived relationship
    // (derived_relationships.ts) -- is a standalone edge table, which
    // GRAPH_EXPAND ignores as ambiguous. Its destination would then be a
    // second root and every GRAPH_EXPAND on the slice would fail ("multiple
    // root node tables", seen live), so such an edge is not a slice edge.
    if (r.via?.length || isVocabulary(entities.get(r.destination.entity)!)) {
      continue;
    }
    if (!isToOne(r, entities.get(r.destination.entity)!)) continue;
    const list = out.get(r.source.entity) ?? [];
    list.push(r);
    out.set(r.source.entity, list);
  }
  const inverses =
      inverseEdgeNames(rendered, resolved.entities ?? [], rels, []).size;
  return {
    entities,
    declared,
    relationships: new Map(rels.map(r => [r.name, r])),
    nodes,
    out,
    mainEdgeTables: rendered.length + inverses,
  };
}

// A foreign key that references the destination's primary key (or one of its
// unique keys): each source row reaches at most one destination row.
function isToOne(rel: Relationship, destination: Entity): boolean {
  const cols = new Set(rel.destination.columns);
  if (!cols.size || rel.source.columns.length !== rel.destination.columns.length) {
    return false;
  }
  return [destination.keys ?? [], ...(destination.uniqueKeys ?? [])].some(
      key => key.length === cols.size && key.every(c => cols.has(c)));
}

interface Bfs {
  /** Reached nodes, breadth-first, the start first. */
  order: string[];
  /** Node -> the edge that first reached it. */
  parent: Map<string, Relationship>;
}

function bfs(g: GraphView, start: string): Bfs {
  const order = [start];
  const parent = new Map<string, Relationship>();
  for (let i = 0; i < order.length; i++) {
    for (const rel of g.out.get(order[i]) ?? []) {
      const next = rel.destination.entity;
      if (next === start || parent.has(next)) continue;
      parent.set(next, rel);
      order.push(next);
    }
  }
  return {order, parent};
}

/** The edges from the BFS start to `node`, or undefined when unreachable. */
function pathTo(b: Bfs, start: string, node: string): Relationship[]|undefined {
  const path: Relationship[] = [];
  let at = node;
  while (at !== start) {
    const rel = b.parent.get(at);
    if (!rel) return undefined;
    path.unshift(rel);
    at = rel.source.entity;
  }
  return path;
}

// How many distinct many-to-one paths lead from `from` to `to`, counting up to
// `cap`: two means GRAPH_EXPAND would have to pick one (a convergent path).
function pathCount(g: GraphView, from: string, to: string, cap = 2): number {
  // Only nodes that can still reach `to` are worth walking.
  const reaches = new Set([to]);
  for (let grew = true; grew;) {
    grew = false;
    for (const [src, rels] of g.out) {
      if (reaches.has(src)) continue;
      if (rels.some(r => reaches.has(r.destination.entity))) {
        reaches.add(src);
        grew = true;
      }
    }
  }
  let count = 0;
  let budget = 100000;
  const onPath = new Set([from]);
  const walk = (node: string): void => {
    for (const rel of g.out.get(node) ?? []) {
      if (count >= cap || --budget < 0) return;
      const next = rel.destination.entity;
      if (next === to) {
        count++;
        continue;
      }
      if (onPath.has(next) || !reaches.has(next)) continue;
      onPath.add(next);
      walk(next);
      onPath.delete(next);
    }
  };
  walk(from);
  return budget < 0 ? cap : count;
}

// The one entity of `set` from which every other is reachable along
// many-to-one edges: the fact the set is read from.
function rootOf(g: GraphView, set: string[]): string|undefined {
  if (set.length === 1) return set[0];
  const candidates = set.filter(r => {
    const reached = new Set(bfs(g, r).order);
    return set.every(o => reached.has(o));
  });
  return candidates.length === 1 ? candidates[0] : undefined;
}


// ---------------------------------------------------------------------------
// The plan.
// ---------------------------------------------------------------------------

interface Candidate {
  metric: Metric;
  d: MetricDecomposition;
  needed: string[];
}

/**
 * Plans the metric slices and fallback views for one BigQuery graph target.
 * Pure: generates DDL but executes nothing. A model whose main graph cannot
 * be generated yields an empty plan (the main deploy reports why).
 */
export function planMetricGraphs(
    model: SemanticModel, target: MetricGraphTarget,
    opts: MetricGraphOptions = {}): MetricGraphPlan {
  const max = opts.maxNodeTables ?? GRAPH_EXPAND_MAX_NODE_TABLES;
  const mainRef = `${target.project}.${target.dataset}.${target.graphName}`;
  const plan: MetricGraphPlan = {
    target,
    mainRef,
    slices: [],
    views: [],
    placements: new Map(),
    warnings: [],
  };
  if (!(model.metrics ?? []).length) return plan;

  let main: ReturnType<typeof generatePropertyGraph>;
  let lowered: SemanticModel;
  let resolved: SemanticModel;
  try {
    main = generatePropertyGraph(model, target);
    lowered = lowerDefinedEntities(model, []);
    resolved = resolveInheritance(lowered).model;
  } catch {
    return plan;
  }
  const g = graphView(lowered, resolved);
  const mainMeasures = new Map(main.measures.map(m => [m.metric, m.nodeTable]));
  const mainMeasureNames = new Map(main.measures.map(m => [m.metric, m.measure]));
  const mainWarnings = new Set(main.warnings);

  const entityNames = (lowered.entities ?? []).map(e => e.name);
  const definedNames = (model.entities ?? [])
                           .filter(e => e.definition !== undefined)
                           .map(e => e.name);
  const ctx: CompositionContext = {
    entityNames,
    entities: g.entities,
    defined: resolveDefinedEntities(model).infos,
  };
  const metrics = [...(model.metrics ?? [])].sort(byName);
  ctx.simpleMetrics = simpleMetricIndex(metrics, ctx);
  const metricsByName = new Map(metrics.map(m => [m.name, m]));

  const fallbacks: Array<{metric: Metric; reason: string}> = [];
  const groups = new Map<string, Candidate[]>();
  for (const metric of metrics) {
    const expression = metric.expression ?? metric.importedExpression ?? '';
    const defined = referencedEntityNames(expression, definedNames);
    if (defined.length) {
      const reason = `it reads defined entity ${defined.join(', ')}, which has ` +
          `no table (a MEASURE cannot filter rows)`;
      plan.placements.set(metric.name, {kind: 'none', reason});
      plan.warnings.push(
          `metric '${metric.name}' cannot be a graph MEASURE (${reason}); ` +
          `query it with plain SQL over the bound tables`);
      continue;
    }
    const placed = placeInGraph(metric, ctx, g, max);
    if ('reason' in placed) {
      fallbacks.push({metric, reason: placed.reason});
      continue;
    }
    const list = groups.get(placed.fact) ?? [];
    list.push(placed.candidate);
    groups.set(placed.fact, list);
  }

  const taken = new Set<string>([target.graphName.toLowerCase()]);
  for (const fact of [...groups.keys()].sort()) {
    const slice = buildSlice(
        fact, groups.get(fact)!, {g, lowered, target, max, metricsByName,
                                  mainMeasures, mainMeasureNames, mainWarnings,
                                  taken, plan});
    for (const f of slice.rejected) fallbacks.push(f);
  }

  planViews(fallbacks.sort((a, b) => byName(a.metric, b.metric)),
            {g, entityNames, target, max, taken, plan});
  return plan;
}

// Where a metric's aggregates are read from, or why no graph can hold it.
function placeInGraph(
    metric: Metric, ctx: CompositionContext, g: GraphView,
    max: number): {fact: string; candidate: Candidate}|{reason: string} {
  const decomposed = decomposeMetric(metric, ctx);
  if (!decomposed.ok) return {reason: decomposed.reason};
  const d = decomposed.value;
  const tableless = d.entities.filter(e => !g.nodes.has(e));
  if (tableless.length) {
    return {
      reason: `it reads ${tableless.join(', ')}, which forms no node table ` +
          `(abstract, keyless or unbound)`,
    };
  }
  const fact = rootOf(g, d.entities);
  if (!fact) {
    return {
      reason: `its aggregates read ${d.entities.join(', ')}, and no one of ` +
          `them reaches the others through many-to-one relationships`,
    };
  }
  const b = bfs(g, fact);
  const needed = new Set([fact]);
  for (const e of d.entities.filter(x => x !== fact)) {
    if (pathCount(g, fact, e) > 1) {
      return {
        reason: `${fact} reaches ${e} through several relationship paths ` +
            `(convergent paths), so one GRAPH_EXPAND tree cannot say which ` +
            `the metric means`,
      };
    }
    for (const rel of pathTo(b, fact, e)!) needed.add(rel.destination.entity);
  }
  if (needed.size > max) {
    return {
      reason: `it needs ${needed.size} node tables, over the ${max} ` +
          `GRAPH_EXPAND accepts`,
    };
  }
  return {
    fact,
    candidate: {metric, d, needed: b.order.filter(n => needed.has(n))},
  };
}

interface SliceContext {
  g: GraphView;
  lowered: SemanticModel;
  target: MetricGraphTarget;
  max: number;
  metricsByName: Map<string, Metric>;
  mainMeasures: Map<string, string>;
  /** Metric -> its measure's name on the main graph (see measureNameFor). */
  mainMeasureNames: Map<string, string>;
  mainWarnings: Set<string>;
  taken: Set<string>;
  plan: MetricGraphPlan;
}

// Builds (or finds the main graph serving) one fact's slice, and records its
// metrics' placements. Returns the metrics it could not hold after all.
function buildSlice(fact: string, group: Candidate[], sc: SliceContext):
    {rejected: Array<{metric: Metric; reason: string}>} {
  const {g, max, plan, target} = sc;
  const rejected: Array<{metric: Metric; reason: string}> = [];
  const b = bfs(g, fact);
  const tree = new Set([fact]);
  let accepted: Candidate[] = [];
  for (const c of [...group].sort((x, y) => byName(x.metric, y.metric))) {
    const union = new Set([...tree, ...c.needed]);
    if (union.size > max) {
      rejected.push({
        metric: c.metric,
        reason: `the ${fact} slice would need ${union.size} node tables, over ` +
            `the ${max} GRAPH_EXPAND accepts`,
      });
      continue;
    }
    for (const n of c.needed) tree.add(n);
    accepted.push(c);
  }
  for (const n of b.order) {
    if (tree.size >= max) break;
    tree.add(n);
  }
  const nodeTables = b.order.filter(n => tree.has(n));
  const treeRels = nodeTables.slice(1).map(n => b.parent.get(n)!);
  const edges = treeRels.map(
      r => ({relationship: r.name, from: r.source.entity, to: r.destination.entity}));

  // The main graph serves the group when the slice would be all of it and
  // every metric is already one of its MEASUREs.
  const servedByMain = nodeTables.length === g.nodes.size &&
      treeRels.length === g.mainEdgeTables &&
      accepted.every(
          c => c.d.simple &&
              sc.mainMeasures.get(c.d.components[0].name) === c.d.components[0].entity &&
              sameAggregate(c.metric, c.d));
  if (servedByMain) {
    for (const c of accepted) {
      plan.placements.set(c.metric.name, {
        kind: 'graph',
        ref: plan.mainRef,
        graphName: target.graphName,
        slice: false,
        fact,
        decomposition: c.d,
        homes: [c.d.components[0].entity],
        measures: [sc.mainMeasureNames.get(c.d.components[0].name) ??
                   c.d.components[0].name],
      });
    }
    return {rejected};
  }

  const graphName = unique(sliceGraphName(target.graphName, fact), sc.taken);
  // Generate, then check every expected measure landed; a metric whose
  // measure the generator refused (a name collision, a non-leaf entity) is
  // taken out and the slice regenerated without it.
  for (;;) {
    if (!accepted.length) return {rejected};
    const model = sliceModel(sc, nodeTables, treeRels, accepted);
    let gen: ReturnType<typeof generatePropertyGraph>;
    try {
      gen = generatePropertyGraph(model, {...target, graphName});
    } catch (err) {
      const why = err instanceof Error ? err.message.split('\n')[0] : String(err);
      for (const c of accepted) {
        rejected.push({metric: c.metric, reason: `the ${fact} slice does not compile (${why})`});
      }
      return {rejected};
    }
    const placed = new Map(gen.measures.map(m => [m.metric, m]));
    const failed = accepted.filter(
        c => c.d.components.some(comp => placed.get(comp.name)?.nodeTable !== comp.entity));
    if (failed.length) {
      for (const c of failed) {
        const missing = c.d.components.find(
            comp => placed.get(comp.name)?.nodeTable !== comp.entity)!;
        const why = gen.warnings.find(w => w.startsWith(`metric '${missing.name}'`));
        rejected.push({
          metric: c.metric,
          reason: why ? `in the slice, ${why}` :
                        `its measure '${missing.name}' could not be declared on ${missing.entity}`,
        });
      }
      accepted = accepted.filter(c => !failed.includes(c));
      continue;
    }
    for (const w of gen.warnings) {
      if (!sc.mainWarnings.has(w)) plan.warnings.push(`metric graph '${graphName}': ${w}`);
    }
    const ref = `${target.project}.${target.dataset}.${graphName}`;
    const kept = new Set(treeRels.map(r => r.name));
    const omitted = [...g.relationships.values()]
                        .filter(r => !r.abstract && !kept.has(r.name) &&
                                    tree.has(r.source.entity) && tree.has(r.destination.entity))
                        .map(r => r.name);
    for (const r of treeRels) if (r.inverse) omitted.push(`${r.inverse} (inverse of ${r.name})`);
    plan.slices.push({
      fact,
      graphName,
      ref,
      uri: graphUri(target, graphName),
      nodeTables,
      edges,
      labels: labelNames(model, tree),
      omitted: omitted.sort(),
      metrics: accepted.map(c => c.metric.name).sort(),
      measures: new Map(gen.measures.map(m => [m.measure, m.nodeTable])),
      model,
      ddl: gen.ddl,
    });
    for (const c of accepted) {
      plan.placements.set(c.metric.name, {
        kind: 'graph',
        ref,
        graphName,
        slice: true,
        fact,
        decomposition: c.d,
        homes: c.d.components.map(comp => comp.entity),
        measures: c.d.components.map(comp => placed.get(comp.name)!.measure),
      });
    }
    return {rejected};
  }
}

// The decomposition still says what the metric says: a simple metric whose
// aggregate was rewritten (a COUNTIF) is not the measure the main graph has.
function sameAggregate(metric: Metric, d: MetricDecomposition): boolean {
  const expr = (metric.expression ?? metric.importedExpression ?? '').trim();
  return !d.components[0].countIf && /^[A-Za-z_]+\s*\(/.test(expr);
}

function labelNames(model: SemanticModel, tree: Set<string>): string[] {
  return (model.entities ?? []).filter(e => !tree.has(e.name)).map(e => e.name).sort();
}

function unique(name: string, taken: Set<string>): string {
  let out = name;
  for (let i = 2; taken.has(out.toLowerCase()); i++) out = `${name}_${i}`;
  taken.add(out.toLowerCase());
  return out;
}

function graphUri(t: MetricGraphTarget, graph: string): string {
  return `//bigquery.googleapis.com/projects/${t.project}/datasets/${
      t.dataset}/propertyGraphs/${graph}`;
}

function viewUri(t: MetricGraphTarget, view: string): string {
  return `//bigquery.googleapis.com/projects/${t.project}/datasets/${
      t.dataset}/tables/${view}`;
}

// The slice as a model: its node tables, their ancestors as labels, the tree
// relationships (no inverses) and the super-relationships they carry as
// labels, and only the slice's metrics -- composites as their components.
function sliceModel(
    sc: SliceContext, nodeTables: string[], treeRels: Relationship[],
    accepted: Candidate[]): SemanticModel {
  const {g, lowered} = sc;
  const inTree = new Set(nodeTables);
  const labels = new Set<string>();
  for (const n of nodeTables) {
    for (const a of g.entities.get(n)?.extends ?? []) {
      if (!inTree.has(a) && g.declared.has(a)) labels.add(a);
    }
  }
  const entities: Entity[] = [
    ...nodeTables.map(n => structuredClone(g.declared.get(n)!)),
    ...[...labels].sort().map(l => asLabel(structuredClone(g.declared.get(l)!))),
  ];

  const kept = new Set(treeRels.map(r => r.name));
  const superRels = new Set<string>();
  for (const r of treeRels) {
    for (const a of relationshipAncestors(lowered.relationships ?? [], r.name)) {
      if (!kept.has(a)) superRels.add(a);
    }
  }
  const relationships: Relationship[] = [
    ...treeRels.map(r => {
      const copy = structuredClone(r);
      delete copy.inverse;
      return copy;
    }),
    ...[...superRels].sort().map(name => {
      const copy = structuredClone(g.relationships.get(name)!);
      copy.abstract = true;
      delete copy.inverse;
      delete copy.association;
      return copy;
    }),
  ];

  const metrics = new Map<string, Metric>();
  for (const c of accepted) {
    c.d.components.forEach((comp, i) => {
      if (metrics.has(comp.name)) return;
      const own = sc.metricsByName.get(comp.name);
      const base: Metric = own ? structuredClone(own) : {
        name: comp.name,
        description: `Component ${i + 1} of metric ${c.metric.name}: ${
            comp.expression}. Recombined as described on ${c.metric.name}.`,
      };
      delete base.importedExpression;
      delete base.importedDialect;
      metrics.set(comp.name, {...base, expression: comp.expression, entity: comp.entity});
    });
  }

  return {
    name: lowered.name,
    entities,
    relationships,
    metrics: [...metrics.values()].sort(byName),
    actions: [],
    constraints: [],
  };
}

// A kept ancestor with no node table in the slice: a label only. A concrete
// ancestor outside the tree is made abstract here, or it would be a second
// root.
function asLabel(e: Entity): Entity {
  if (e.abstract) return e;
  return {...e, abstract: true, dataSource: '', keys: [], uniqueKeys: undefined};
}


// ---------------------------------------------------------------------------
// Fallback views.
// ---------------------------------------------------------------------------

interface ViewContext {
  g: GraphView;
  entityNames: string[];
  target: MetricGraphTarget;
  max: number;
  taken: Set<string>;
  plan: MetricGraphPlan;
}

function planViews(
    fallbacks: Array<{metric: Metric; reason: string}>, vc: ViewContext): void {
  const {g, plan} = vc;
  const groups = new Map<string, Array<{metric: Metric; reason: string; reads: string[]}>>();
  for (const {metric, reason} of fallbacks) {
    const viewable = viewFact(metric, vc);
    if ('why' in viewable) {
      plan.placements.set(metric.name, {kind: 'none', reason});
      plan.warnings.push(
          `metric '${metric.name}' cannot be a graph MEASURE (${reason}); ` +
          `no fallback view either (${viewable.why}); query it with plain ` +
          `SQL over the bound tables`);
      continue;
    }
    const list = groups.get(viewable.fact) ?? [];
    list.push({metric, reason, reads: viewable.reads});
    groups.set(viewable.fact, list);
  }

  for (const fact of [...groups.keys()].sort()) {
    const members = groups.get(fact)!;
    const b = bfs(g, fact);
    const nodes = new Set([fact]);
    const notes: string[] = [];
    for (const m of members) {
      for (const e of m.reads.filter(x => x !== fact)) {
        const path = pathTo(b, fact, e)!;
        for (const rel of path) nodes.add(rel.destination.entity);
        if (pathCount(g, fact, e) > 1) {
          notes.push(`it joins ${e} along ${path.map(r => r.name).join(' -> ')}`);
        }
      }
    }
    for (const n of b.order) {
      if (nodes.size >= vc.max) break;
      nodes.add(n);
    }
    const order = b.order.filter(n => nodes.has(n));
    const rels = order.slice(1).map(n => b.parent.get(n)!);
    const viewName = unique(fallbackViewName(vc.target.graphName, fact), vc.taken);
    const ref = `${vc.target.project}.${vc.target.dataset}.${viewName}`;
    const metrics = members.map(m => m.metric.name).sort();
    const rendered = renderView(g, ref, order, rels, metrics);
    plan.views.push({
      fact,
      viewName,
      ref,
      uri: viewUri(vc.target, viewName),
      entities: order,
      edges: rels.map(
          r => ({relationship: r.name, from: r.source.entity, to: r.destination.entity})),
      metrics,
      columns: rendered.columns,
      columnFor: rendered.columnFor,
      sql: rendered.sql,
    });
    const note = notes.length ? `; ${[...new Set(notes)].join('; ')}` : '';
    for (const m of members) {
      const expression = m.metric.expression ?? m.metric.importedExpression ?? '';
      plan.placements.set(m.metric.name, {
        kind: 'view',
        ref,
        viewName,
        fact,
        reason: m.reason,
        expression: rewriteToColumns(expression, vc.entityNames, rendered.column),
      });
      plan.warnings.push(
          `metric '${m.metric.name}' cannot be a graph MEASURE (${m.reason}); ` +
          `it falls back to the SQL view ${ref}${note}`);
    }
  }
}

// The fact a fallback view for `metric` is read at, and the entities it
// joins -- or why a flat view would compute it wrong.
function viewFact(metric: Metric, vc: ViewContext):
    {fact: string; reads: string[]}|{why: string} {
  const {g} = vc;
  const expression = metric.expression ?? metric.importedExpression;
  if (!expression) return {why: 'it has no expression'};
  let reads = referencedEntityNames(expression, vc.entityNames);
  if (!reads.length && metric.entity) reads = [metric.entity];
  if (!reads.length) return {why: 'it names no entity'};
  const tableless = reads.filter(e => !g.nodes.has(e));
  if (tableless.length) {
    return {why: `${tableless.join(', ')} forms no table to read`};
  }
  const fact = rootOf(g, reads);
  if (!fact) {
    return {
      why: `no one of ${reads.join(', ')} reaches the others through ` +
          `many-to-one relationships`,
    };
  }
  const found = findAggregateCalls(expression);
  if ('error' in found) return {why: found.error};
  for (const call of found.calls) {
    const ents = referencedEntityNames(call.operand, vc.entityNames);
    if (ents.length && !ents.includes(fact) && !call.distinct &&
        !DUPLICATE_INSENSITIVE.has(call.fn)) {
      return {
        why: `${call.fn}(...) reads only ${ents.join(', ')}, whose rows repeat ` +
            `once per ${fact} record in a flat view`,
      };
    }
  }
  return {fact, reads};
}

// CREATE OR REPLACE VIEW: one subquery per entity projecting its bound fields
// under their names (so a field bound to an expression evaluates on its own
// table), LEFT JOINed along the many-to-one tree from the fact.
function renderView(
    g: GraphView, ref: string, order: string[], rels: Relationship[],
    metrics: string[]): {
  sql: string; columns: string[]; columnFor: Map<string, string>;
  column: (e: string, f: string) => string;
} {
  const joinCols = new Map<string, Set<string>>();
  const need = (entity: string, cols: string[]) => {
    const set = joinCols.get(entity) ?? new Set<string>();
    for (const c of cols) set.add(c);
    joinCols.set(entity, set);
  };
  for (const r of rels) {
    need(r.source.entity, r.source.columns);
    need(r.destination.entity, r.destination.columns);
  }

  const taken = new Set<string>();
  const columnOf = new Map<string, string>();
  const select: string[] = [];
  const blocks = new Map<string, string>();
  for (const name of order) {
    const e = g.entities.get(name)!;
    const bound = e.fields.filter(f => fieldBinding(f) !== undefined);
    const projected = bound.map(f => {
      const local = stripQualifier(fieldBinding(f)!, name);
      return local === f.name ? quoteIfReserved(f.name) :
                                `${local} AS ${quoteIfReserved(f.name)}`;
    });
    for (const c of joinCols.get(name) ?? []) {
      if (!bound.some(f => f.name === c)) projected.push(quoteIfReserved(c));
    }
    blocks.set(name, `(\n    SELECT\n      ${projected.join(',\n      ')}\n    FROM ${
        tableRef(e.dataSource)}\n  ) AS ${alias(name)}`);
    for (const f of bound) {
      let col = `${name}_${f.name}`.replace(/[^A-Za-z0-9_]/g, '_');
      for (let i = 2; taken.has(col.toLowerCase()); i++) col = `${name}_${f.name}_${i}`;
      taken.add(col.toLowerCase());
      columnOf.set(`${name}.${f.name}`, col);
      select.push(`${alias(name)}.${quoteIfReserved(f.name)} AS ${quoteIfReserved(col)}`);
    }
  }

  const lines = [
    `CREATE OR REPLACE VIEW ${quoteRef(ref)}`,
    `OPTIONS(description=${quote(viewDescription(order, metrics))})`,
    'AS',
    'SELECT',
    `  ${select.join(',\n  ')}`,
    `FROM ${blocks.get(order[0])}`,
  ];
  for (const r of rels) {
    const on = r.source.columns.map(
        (c, i) => `${alias(r.source.entity)}.${quoteIfReserved(c)} = ${
            alias(r.destination.entity)}.${quoteIfReserved(r.destination.columns[i])}`);
    lines.push(`LEFT JOIN ${blocks.get(r.destination.entity)}`);
    lines.push(`  ON ${on.join(' AND ')}`);
  }
  return {
    sql: lines.join('\n') + ';\n',
    columns: [...columnOf.values()],
    columnFor: columnOf,
    column: (entity, field) => columnOf.get(`${entity}.${field}`) ??
        `${entity}_${field}`.replace(/[^A-Za-z0-9_]/g, '_'),
  };
}

function viewDescription(order: string[], metrics: string[]): string {
  const joined = order.length > 1 ?
      `, joined along many-to-one relationships to ${order.slice(1).join(', ')}` :
      '';
  return `One row per ${order[0]} record${joined}. Columns are named ` +
      `<Entity>_<field>, as in GRAPH_EXPAND output. Generated by kcmd for the ` +
      `metrics that cannot be graph measures: ${metrics.join(', ')}.`;
}

/**
 * Rewrites `Entity.field` references (outside string literals) into the
 * columns `column(entity, field)` names, e.g. a fallback view's columns.
 */
export function rewriteToColumns(
    expression: string, entityNames: string[],
    column: (entity: string, field: string) => string): string {
  if (!entityNames.length) return expression;
  const names = [...entityNames].sort((a, b) => b.length - a.length).map(escapeRegExp);
  const re = new RegExp(
      `(?<![\\w\`])\`?(${names.join('|')})\`?\\.\`?([A-Za-z_][A-Za-z0-9_]*)\`?`, 'g');
  return mapOutsideStringLiterals(
      expression, seg => seg.replace(re, (_, e: string, f: string) => column(e, f)));
}

function alias(name: string): string {
  return isSimpleIdentifier(name) ? quoteIfReserved(name) : quoteIdentifier(name);
}

function tableRef(dataSource: string): string {
  const s = (dataSource ?? '').trim();
  return /\s/.test(s) ? `(${s})` : `\`${s.replace(/`/g, '')}\``;
}

function quoteRef(ref: string): string {
  return `\`${ref.replace(/`/g, '')}\``;
}

function quote(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}


// ---------------------------------------------------------------------------
// The plan, in words (push output).
// ---------------------------------------------------------------------------

/** One line per slice, view and main-graph group, for the push output. */
export function describeMetricGraphPlan(plan: MetricGraphPlan): string[] {
  const out: string[] = [];
  const onMain = [...plan.placements.entries()]
                     .filter(([, p]) => p.kind === 'graph' && !p.slice)
                     .map(([m]) => m)
                     .sort();
  if (onMain.length) {
    out.push(`${plan.mainRef} serves GRAPH_EXPAND itself for ${onMain.join(', ')}`);
  }
  for (const s of plan.slices) {
    const via = s.edges.map(e => `${e.to} via ${e.relationship}`);
    out.push(
        `metric graph ${s.ref}: root ${s.fact}, ${s.nodeTables.length} node ` +
        `table(s)${via.length ? ` (${via.join(', ')})` : ''}` +
        `${s.labels.length ? `, labels ${s.labels.join(', ')}` : ''}; ` +
        `metrics ${s.metrics.join(', ')}` +
        `${s.omitted.length ? `; left out: ${s.omitted.join(', ')}` : ''}`);
  }
  for (const v of plan.views) {
    out.push(`metric view ${v.ref}: one row per ${v.fact}, ${v.columns.length} ` +
             `column(s); metrics ${v.metrics.join(', ')}`);
  }
  return out;
}
