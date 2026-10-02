/**
 * The read side of a generated Agent Skill: how to QUERY a semantic model.
 *
 * `skills.ts` writes the write side -- a router over the model's actions. This
 * module writes what an agent needs to answer a business question over the
 * same model: where the compiled BigQuery property graph is, how to navigate
 * it, and an index of what it holds. It is reached through `generateSkill`
 * with `mode: 'query'` (or `'both'`), which owns the frontmatter and the name.
 *
 * The shape is progressive disclosure, for the same budget reason the act
 * router has one (SKILL.md body under 500 lines / ~5,000 tokens):
 *
 *   SKILL.md                     coordinates, a short model-agnostic guide to
 *                                answering questions, GQL basics, and an index
 *                                with ONE LINE per graph label and per metric.
 *   references/entities/<E>.md   one page per label, read on demand: labels it
 *                                carries, properties (with physical columns),
 *                                relationships as `(A)-[:rel]->(B)` with
 *                                cardinality and inverse, subsets, metrics,
 *                                constraints, and the source table for SQL.
 *   references/metrics.md        every metric: expression, anchor, and a ready
 *                                GRAPH_EXPAND query -- or an SQL equivalent
 *                                when the metric is not a graph MEASURE.
 *   references/patterns.md       example GQL/SQL queries GENERATED from the
 *                                model, naming only labels and edges it has.
 *
 * What the graph holds is read from the model the way the BigQuery generator
 * builds it (bigquery.ts): a concrete keyed entity is a node table; an abstract
 * entity is a LABEL only when some node table descends from it; an abstract
 * entity with no concrete descendant forms no graph element at all. Which
 * metrics became MEASUREs, and on which node table, is learned by running that
 * generator read-only and reading its DDL, so the skill can never promise a
 * measure the graph does not have.
 *
 * Everything is sorted, so a regeneration over an unchanged model is
 * byte-identical.
 */

import {generatePropertyGraph} from './bigquery';
import {bigQueryGraphTargets} from './deployment_target';
import {entityGlossaryLines, glossaryGuideLine, glossaryId, glossarySkillSection} from './glossary';
import {Constraint, Entity, EntityDefinition, Field, fieldBinding, inverseEdgeNames, isTimeDimension, Metric, Relationship, relationshipAncestors, SemanticModel} from './ir';
import {MetricComponent} from './metric_composition';
import {GRAPH_EXPAND_MAX_NODE_TABLES, graphExpandExpression, MetricGraphPlan, MetricPlacement, MetricSlice, MetricView, planMetricGraphs} from './metric_slices';
import {pruneUnavailable} from './resolve_profiles';
import {SemanticRuntime} from './runtime/runtime';
import {cell, collapse, finish, firstLine, paragraph, sentenceEnd, SkillFile, truncate} from './skills_text';
import {quoteIfReserved} from './sql_identifiers';
import {stripQualifier} from './sql_expr_utils';
import {grainHistoryLines, unitNote} from './units_history';
import {bindVocabularies, isVocabulary, vocabularyColumnIsText, vocabularySkillLines} from './vocabulary';
import {derivedSkillLine} from './derived_relationships';

/**
 * Slugs under `references/` the query pages occupy. `mode: 'both'` reserves
 * them so an action called `metrics` cannot overwrite the metrics page.
 */
export const RESERVED_REFERENCE_SLUGS: readonly string[] = ['metrics', 'patterns'];

export interface QuerySkillOptions {
  /**
   * Further models whose BigQuery graphs the skill should also point at --
   * typically a metrics slice compiled from the same ontology into a smaller
   * graph that GRAPH_EXPAND accepts. Their MEASUREs are offered alongside the
   * primary graph's.
   */
  extraModels?: SemanticModel[];
  /** The BigQuery location to run queries in. Not recorded in the model. */
  location?: string;
  /**
   * Read metrics on the GRAPH_EXPAND metric graphs and fallback views that
   * `kcmd push` deploys next to the primary graph (metric_slices.ts, K6). On
   * unless false; set it false for a graph pushed with --no-metric-graphs.
   */
  metricGraphs?: boolean;
}

/** The read side, in pieces `skills.ts` assembles into a skill. */
export interface QueryParts {
  /** The frontmatter description, built to fit `budget` characters. */
  description: (budget: number) => string;
  /** SKILL.md body lines after the title and the model's description. */
  body: string[];
  /** The reference pages, sorted by path. */
  files: SkillFile[];
  warnings: string[];
}

// GRAPH_EXPAND accepts at most GRAPH_EXPAND_MAX_NODE_TABLES node tables
// (BigQuery limit); the metric-slice planner (metric_slices.ts) owns the number.
// Index cells are truncated to this many characters: the index is for
// choosing a page, and the page has the rest.
const INDEX_DESCRIPTION = 90;


// ---------------------------------------------------------------------------
// What the graph holds.
// ---------------------------------------------------------------------------

// K1 defined entities (`Entity.definition`, ir.ts). Read through one accessor
// so the rest of this module does not care how the IR spells it.
function definitionOf(entity: Entity): EntityDefinition|undefined {
  return entity.definition;
}

/** Every ancestor of an entity, transitively, nearest first. */
function ancestorsOf(byName: Map<string, Entity>, name: string): string[] {
  const out: string[] = [];
  const seen = new Set([name]);
  const queue = [...(byName.get(name)?.extends ?? [])];
  while (queue.length) {
    const next = queue.shift()!;
    if (seen.has(next) || !byName.has(next)) continue;
    seen.add(next);
    out.push(next);
    queue.push(...(byName.get(next)!.extends ?? []));
  }
  return out;
}

/** A narrower concept listed on its parent's page rather than as a label. */
interface Subset {
  name: string;
  /**
   * `defined`: a K1 defined entity, queryable as the `flag` property.
   * `conceptual`: an abstract entity no node table descends from, so the graph
   * has neither a label nor a flag for it -- only its description.
   */
  kind: 'defined'|'conceptual';
  flag?: string;
  expression?: string;
  description?: string;
}

interface Analysis {
  model: SemanticModel;
  byName: Map<string, Entity>;
  /** Entities that form a node table: concrete, keyed, not defined. */
  nodeTables: Set<string>;
  /** Every node label: node tables plus abstract ancestors some carry. */
  labels: Set<string>;
  /** Label -> the node tables that carry it (itself included). */
  carriers: Map<string, string[]>;
  /** Parent label -> its subsets. */
  subsets: Map<string, Subset[]>;
  /** Concepts with no label and no parent label to list them under. */
  orphans: Entity[];
  /** Concrete relationships whose endpoints are both node tables. */
  rendered: Relationship[];
  /** Every edge label: rendered relationships plus their ancestors. */
  relLabels: Set<string>;
  /** Relationships whose declared inverse is emitted as an edge. */
  inverses: Set<string>;
  /** Label -> number of relationships it is an endpoint of. */
  degree: Map<string, number>;
  /** Labels, most connected first, then by name. */
  order: string[];
}

function byNameOrder<T extends {name: string}>(a: T, b: T): number {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function analyse(model: SemanticModel): Analysis {
  const entities = [...(model.entities ?? [])].sort(byNameOrder);
  const relationships = [...(model.relationships ?? [])].sort(byNameOrder);
  const byName = new Map(entities.map(e => [e.name, e]));

  const nodeTables = new Set(
      entities
          .filter(
              e => !e.abstract && !definitionOf(e) && (e.keys ?? []).length > 0)
          .map(e => e.name));
  const carriers = new Map<string, string[]>();
  for (const name of [...nodeTables].sort()) {
    for (const label of [name, ...ancestorsOf(byName, name)]) {
      const list = carriers.get(label) ?? [];
      if (!list.includes(name)) list.push(name);
      carriers.set(label, list);
    }
  }
  // A concrete ancestor that formed no node table (no key) is not a label
  // either: the generator drops its LABEL from the subtypes.
  const labels = new Set(
      [...carriers.keys()].filter(l => nodeTables.has(l) || byName.get(l)?.abstract));

  // Subsets: K1 defined entities, and abstract entities nothing concrete
  // descends from. Each is listed under its most specific node-table ancestor
  // (falling back to label ancestors), never as a label of its own. For a
  // defined entity that is the "base" its `is<Name>` flag is compiled onto.
  const subsets = new Map<string, Subset[]>();
  const orphans: Entity[] = [];
  for (const e of entities) {
    const def = definitionOf(e);
    const conceptual = e.abstract && !labels.has(e.name);
    if (!def && !conceptual) continue;
    const ancestors = ancestorsOf(byName, e.name);
    let candidates = ancestors.filter(a => nodeTables.has(a));
    if (!candidates.length) candidates = ancestors.filter(a => labels.has(a));
    // Most specific only: drop a candidate that another candidate extends.
    const parents = candidates.filter(
        c => !candidates.some(
            o => o !== c && ancestorsOf(byName, o).includes(c)));
    if (!parents.length) {
      orphans.push(e);
      continue;
    }
    // A defined entity narrowing another defined one: membership is the
    // conjunction up the chain, so say which flag it already implies.
    const within = def ?
        ancestors.find(x => definitionOf(byName.get(x)!) !== undefined) :
        undefined;
    const subset: Subset = def ?
        {
          name: e.name,
          kind: 'defined',
          flag: `is${e.name}`,
          expression: def.expression,
          description: [def.description ?? e.description,
                        within ? `Implies is${within}.` : '']
                           .filter(x => x).join(' ') || undefined,
        } :
        {name: e.name, kind: 'conceptual', description: e.description};
    for (const p of parents.sort()) {
      const list = subsets.get(p) ?? [];
      list.push(subset);
      subsets.set(p, list);
    }
  }

  const rendered = relationships.filter(
      r => !r.abstract && nodeTables.has(r.source.entity) &&
          nodeTables.has(r.destination.entity));
  const relLabels = new Set<string>(rendered.map(r => r.name));
  for (const r of rendered) {
    for (const a of relationshipAncestors(relationships, r.name)) {
      relLabels.add(a);
    }
  }
  const inverses =
      inverseEdgeNames(rendered, model.entities ?? [], relationships, []);

  const degree = new Map<string, number>();
  for (const r of relationships.filter(r => relLabels.has(r.name))) {
    for (const end of new Set([r.source.entity, r.destination.entity])) {
      degree.set(end, (degree.get(end) ?? 0) + 1);
    }
  }
  const order = [...labels].sort(
      (a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) ||
          (a < b ? -1 : a > b ? 1 : 0));

  return {
    model,
    byName,
    nodeTables,
    labels,
    carriers,
    subsets,
    orphans,
    rendered,
    relLabels,
    inverses,
    degree,
    order,
  };
}


// ---------------------------------------------------------------------------
// The graphs: coordinates and which metrics are MEASUREs on them.
// ---------------------------------------------------------------------------

interface GraphInfo {
  /** `project.dataset.graph`, or undefined when no BigQuery target is bound. */
  ref?: string;
  /** `project.dataset`. */
  dataset?: string;
  modelName: string;
  primary: boolean;
  model: SemanticModel;
  /** Node table aliases, in DDL order. */
  nodeTables: string[];
  /** Metric name -> the node table its MEASURE is declared on. */
  measures: Map<string, string>;
  /** Metric name -> why the generator did not make it a MEASURE. */
  skipped: Map<string, string>;
  /** Why the graph could not be generated at all, if it could not. */
  error?: string;
}

function graphInfo(model: SemanticModel, primary: boolean): GraphInfo {
  const info: GraphInfo = {
    modelName: model.name,
    primary,
    model,
    nodeTables: [],
    measures: new Map(),
    skipped: new Map(),
  };
  let target;
  try {
    target = bigQueryGraphTargets(model).targets[0];
  } catch (e) {
    info.error = e instanceof Error ? e.message : String(e);
  }
  if (target) {
    info.ref = `${target.project}.${target.dataset}.${target.graphName}`;
    info.dataset = `${target.project}.${target.dataset}`;
  }
  let ddl = '';
  let warnings: string[] = [];
  try {
    ({ddl, warnings} = generatePropertyGraph(
         model,
         target ? {
           project: target.project,
           dataset: target.dataset,
           graphName: target.graphName
         } :
                  {}));
  } catch (e) {
    info.error = e instanceof Error ? e.message : String(e);
    return info;
  }
  // The generator writes one element table per block: its header at one
  // indent (`  <table> AS <alias>`), clauses and properties deeper. A MEASURE
  // belongs to the node table whose header precedes it.
  let section = '';
  let current = '';
  for (const raw of ddl.split('\n')) {
    if (raw.startsWith('NODE TABLES')) {
      section = 'node';
      continue;
    }
    if (raw.startsWith('EDGE TABLES')) {
      section = 'edge';
      continue;
    }
    if (section !== 'node') continue;
    const head = /^  (?! ).* AS `?([^`\s]+)`?$/.exec(raw);
    if (head) {
      current = head[1];
      info.nodeTables.push(current);
      continue;
    }
    const measure = /MEASURE\(.*\) AS `?([A-Za-z_][A-Za-z0-9_]*)`?/.exec(raw);
    if (measure && current) info.measures.set(measure[1], current);
  }
  for (const w of warnings) {
    const m = /^metric '([^']+)'/.exec(w);
    if (m && !info.measures.has(m[1]) && !info.skipped.has(m[1])) {
      info.skipped.set(m[1], w);
    }
  }
  return info;
}

function expandable(g: GraphInfo): boolean {
  return g.nodeTables.length <= GRAPH_EXPAND_MAX_NODE_TABLES;
}

/** Where to read a metric with GRAPH_EXPAND: prefer a graph within limits. */
function measureHome(graphs: GraphInfo[], metric: string):
    {graph: GraphInfo; nodeTable: string}|undefined {
  const homes = graphs.filter(g => g.measures.has(metric));
  const g = homes.find(expandable) ?? homes[0];
  return g ? {graph: g, nodeTable: g.measures.get(metric)!} : undefined;
}

// The metric graphs and fallback views `kcmd push` deploys next to the
// primary graph (metric_slices.ts), planned the way the push plans them: over
// the model pruned to the profile's bindings.
function metricGraphPlan(model: SemanticModel, profile: string):
    MetricGraphPlan|undefined {
  let target;
  try {
    target = bigQueryGraphTargets(model).targets[0];
  } catch {
    return undefined;
  }
  if (!target) return undefined;
  return planMetricGraphs(pruneUnavailable(model, profile).model, {
    project: target.project,
    dataset: target.dataset,
    graphName: target.graphName,
  });
}

function sliceInfo(s: MetricSlice): GraphInfo {
  return {
    ref: s.ref,
    dataset: s.ref.split('.').slice(0, 2).join('.'),
    modelName: s.graphName,
    primary: false,
    model: s.model,
    nodeTables: s.nodeTables,
    measures: s.measures,
    skipped: new Map(),
  };
}

/** Where, and with what expression, the skill tells an agent to read a metric. */
type Reading = {
  kind: 'graph';
  graph: GraphInfo;
  /** The node table a query slices from: the measure's, or the fact. */
  anchor: string;
  /** What to SELECT: `AGG(<NodeTable>_<measure>)`, or a composition. */
  expression: string;
  /** The planner's placement, when a metric graph (or the primary) holds it. */
  placement?: Extract<MetricPlacement, {kind: 'graph'}>;
}|{
  kind: 'view';
  view: MetricView;
  /** The metric's expression over the view's columns. */
  expression: string;
  reason: string;
}|{
  kind: 'sql';
  /** Why the metric is not a MEASURE, when known. */
  reason?: string;
};

// A graph named with --extra-scope that holds the metric as a MEASURE within
// the node-table limit is an explicit choice, so it wins; then the planner's
// verdict (a metric graph, a fallback view, or SQL); for a metric the planner
// did not see (no plan, or declared only in an extra model), a MEASURE the
// graphs already have; else SQL.
function readingOf(
    graphs: GraphInfo[], primary: GraphInfo, plan: MetricGraphPlan|undefined,
    slices: GraphInfo[], name: string): Reading {
  const extra = graphs.find(g => !g.primary && g.measures.has(name) && expandable(g));
  if (extra) {
    const anchor = extra.measures.get(name)!;
    return {kind: 'graph', graph: extra, anchor, expression: `AGG(${anchor}_${name})`};
  }
  const p = plan?.placements.get(name);
  if (p?.kind === 'graph') {
    const graph = p.slice ? slices.find(s => s.ref === p.ref) : primary;
    if (graph) {
      return {kind: 'graph', graph, anchor: p.fact, expression: graphExpandExpression(p), placement: p};
    }
  }
  if (p?.kind === 'view') {
    const view = plan!.views.find(v => v.ref === p.ref);
    if (view) return {kind: 'view', view, expression: p.expression, reason: p.reason};
  }
  if (p?.kind === 'none') return {kind: 'sql', reason: p.reason};
  const home = measureHome(graphs, name);
  if (home) {
    return {
      kind: 'graph',
      graph: home.graph,
      anchor: home.nodeTable,
      expression: `AGG(${home.nodeTable}_${name})`,
    };
  }
  const skipped = graphs.map(g => g.skipped.get(name)).find(x => x);
  const reason = skipped?.replace(/^metric '[^']+'\s*/, '');
  return reason ? {kind: 'sql', reason} : {kind: 'sql'};
}

/** A metric split into several MEASUREs, or one rewritten (a COUNTIF). */
function composed(r: Reading): boolean {
  if (r.kind !== 'graph' || !r.placement) return false;
  const d = r.placement.decomposition;
  return !d.simple || !!d.components[0].countIf;
}


// ---------------------------------------------------------------------------
// Small renderers.
// ---------------------------------------------------------------------------

function q(name: string): string {
  return quoteIfReserved(name);
}

function tick(text: string): string {
  return `\`${text.replace(/`/g, '')}\``;
}

function tableRef(dataSource: string): string {
  return `\`${dataSource.replace(/`/g, '')}\``;
}

function graphRefOrPlaceholder(g: GraphInfo|undefined): string {
  return g?.ref ?? '<project>.<dataset>.<graph>';
}

/** A field's physical column (or SQL) on its entity's table. */
function physicalColumn(entity: Entity, field: Field): string|undefined {
  const expr = fieldBinding(field);
  return expr === undefined ? undefined : stripQualifier(expr, entity.name);
}

function fieldNamed(entity: Entity|undefined, name: string): Field|undefined {
  return entity?.fields.find(f => f.name === name);
}

function columnOf(entity: Entity|undefined, name: string): string {
  const f = fieldNamed(entity, name);
  return (entity && f && physicalColumn(entity, f)) ?? name;
}

function cardinality(rel: Relationship, model: Analysis): string {
  if (rel.association || rel.via?.length) return 'M:N';
  if (rel.abstract) return 'label';
  const src = model.byName.get(rel.source.entity);
  const keys = [...(src?.keys ?? [])].sort().join(',');
  const cols = [...rel.source.columns].sort().join(',');
  return keys && keys === cols ? '1:1' : 'N:1';
}

function edge(rel: string, from: string, to: string): string {
  return `(${from})-[:${rel}]->(${to})`;
}

/** The property a RETURN shows for a label: its key, or its first field. */
function displayProperty(a: Analysis, label: string): string|undefined {
  const e = a.byName.get(label);
  if (!e) return undefined;
  if (!e.abstract && e.keys?.length) return e.keys[0];
  return e.fields[0]?.name;
}

// The foreign-key columns an entity holds, by field name. A dimension column
// is a better GROUP BY than a key someone else's table already names.
function foreignKeys(a: Analysis, entity: string): Set<string> {
  const out = new Set<string>();
  for (const r of a.model.relationships ?? []) {
    if (r.source.entity === entity && !r.association) {
      for (const c of r.source.columns) out.add(c);
    }
  }
  return out;
}

/** A readable String dimension on an entity: a name/label first. */
function dimensionField(a: Analysis, entity: string): Field|undefined {
  const e = a.byName.get(entity);
  if (!e) return undefined;
  const fks = foreignKeys(a, entity);
  const candidates = e.fields.filter(
      f => (f.type === undefined || f.type === 'String') &&
          !(e.keys ?? []).includes(f.name) && !fks.has(f.name) &&
          fieldBinding(f) !== undefined);
  return candidates.find(f => /(name|label)$/i.test(f.name)) ??
      candidates.find(f => /(type|tier|stage|status|category|vertical|segment|region)$/i.test(f.name)) ??
      candidates[0];
}

function aiNotes(ai: {instructions?: string; synonyms?: string[]; examples?: string[]}|undefined):
    string[] {
  const out: string[] = [];
  if (ai?.synonyms?.length) out.push(`Synonyms: ${ai.synonyms.join(', ')}.`);
  if (ai?.instructions?.trim()) out.push(sentenceEnd(collapse(ai.instructions)));
  if (ai?.examples?.length) {
    out.push(`Examples: ${ai.examples.map(collapse).join('; ')}.`);
  }
  return out;
}

// Field keys rendered by name below, or not metadata at all. Anything else a
// field carries is rendered generically as `key: value`, so new metadata
// reaches the page without a change here.
const KNOWN_FIELD_KEYS = new Set([
  'name', 'expression', 'importedExpression', 'importedDialect', 'dimension',
  'label', 'description', 'type', 'aiContext', 'customExtensions', 'unit',
  'scale',
]);

function fieldNotes(field: Field): string {
  const parts: string[] = [];
  if (field.label) parts.push(`"${collapse(field.label)}".`);
  if (field.description) parts.push(sentenceEnd(collapse(field.description)));
  if (isTimeDimension(field)) parts.push('Time dimension.');
  // K7 unit / scale (units_history.ts).
  const unit = unitNote(field);
  if (unit) parts.push(unit);
  for (const [key, value] of Object.entries(field).sort(([x], [y]) => x < y ? -1 : 1)) {
    if (KNOWN_FIELD_KEYS.has(key) || value === undefined || value === null) continue;
    if (['string', 'number', 'boolean'].includes(typeof value)) {
      parts.push(`${key}: ${collapse(String(value))}.`);
    }
  }
  parts.push(...aiNotes(field.aiContext));
  return parts.join(' ');
}


// ---------------------------------------------------------------------------
// The entry point.
// ---------------------------------------------------------------------------

export function queryParts(
    runtime: SemanticRuntime, opts: QuerySkillOptions): QueryParts {
  const model = vocabulariesBound(runtime.model);
  const a = analyse(model);
  const warnings: string[] = [];

  const primary = graphInfo(model, true);
  if (!primary.ref) {
    warnings.push(
        `Model '${model.name}' declares no BigQuery graph deployment target ` +
        `under profile '${runtime.profile}'; the query skill names the graph ` +
        `as a placeholder. Generate it with the profile that binds BigQuery.`);
  }
  if (primary.error) {
    warnings.push(`Could not compile the property graph to learn which ` +
        `metrics are MEASUREs: ${firstLine(primary.error)}`);
  }
  const extras = (opts.extraModels ?? [])
                     .map(m => graphInfo(m, false))
                     .sort((x, y) => (x.ref ?? x.modelName) < (y.ref ?? y.modelName) ? -1 : 1);
  for (const g of extras) {
    if (!g.ref) {
      warnings.push(`Extra model '${g.modelName}' declares no BigQuery graph ` +
          `deployment target; it is ignored.`);
    }
  }
  const graphs = [primary, ...extras.filter(g => g.ref)];

  // The metric graphs and fallback views a push deploys next to the primary
  // graph (K6, metric_slices.ts): the graph each metric is read on.
  let plan: MetricGraphPlan|undefined;
  if (primary.ref && !primary.error && opts.metricGraphs !== false) {
    try {
      plan = metricGraphPlan(model, runtime.profile);
    } catch (e) {
      warnings.push(`Could not plan the metric graphs: ${
          firstLine(e instanceof Error ? e.message : String(e))}`);
    }
  }
  const slices = (plan?.slices ?? []).map(sliceInfo);

  // Metrics: the primary model's, then any an extra model adds, by name.
  const metrics = new Map<string, {metric: Metric; from: string}>();
  for (const g of graphs) {
    for (const m of g.model.metrics ?? []) {
      if (!metrics.has(m.name)) metrics.set(m.name, {metric: m, from: g.modelName});
    }
  }
  const metricList = [...metrics.values()].sort((x, y) => byNameOrder(x.metric, y.metric));
  const readings = new Map(metricList.map(
      ({metric}) => [metric.name, readingOf(graphs, primary, plan, slices, metric.name)]));

  const paths = entityPaths(a);
  const ctx: Ctx = {runtime, a, graphs, primary, metricList, paths, opts, plan, slices, readings};

  const files: SkillFile[] = [];
  for (const label of [...a.labels].sort()) {
    files.push({path: paths.get(label)!, text: entityPage(ctx, label)});
  }
  files.push({path: 'references/metrics.md', text: metricsPage(ctx)});
  files.push({path: 'references/patterns.md', text: patternsPage(ctx)});
  files.sort((x, y) => x.path < y.path ? -1 : x.path > y.path ? 1 : 0);

  const notMeasures = metricList.filter(m => reading(ctx, m.metric.name).kind === 'sql');
  if (notMeasures.length) {
    warnings.push(`${notMeasures.length} metric(s) are not a MEASURE on any ` +
        `graph (${notMeasures.map(m => m.metric.name).join(', ')}); the ` +
        `skill gives an SQL equivalent for each instead.`);
  }

  return {
    description: budget => descriptionFor(ctx, budget),
    body: skillBody(ctx),
    files,
    warnings,
  };
}

// K3 (vocabulary.ts): the model with each vocabulary whose view the BigQuery
// leg generates bound to that view, next to the primary graph -- the node
// table the deployed graph has. A model without a vocabulary is returned as-is.
function vocabulariesBound(model: SemanticModel): SemanticModel {
  if (!(model.entities ?? []).some(isVocabulary)) return model;
  let target: {project?: string; dataset?: string} = {};
  try {
    const t = bigQueryGraphTargets(model).targets[0];
    if (t) target = {project: t.project, dataset: t.dataset};
  } catch {
    // graphInfo reports a malformed target.
  }
  return {
    ...model,
    entities: bindVocabularies(model.entities ?? [], target, []).entities,
  };
}

interface Ctx {
  runtime: SemanticRuntime;
  a: Analysis;
  graphs: GraphInfo[];
  primary: GraphInfo;
  metricList: Array<{metric: Metric; from: string}>;
  paths: Map<string, string>;
  opts: QuerySkillOptions;
  /** The metric graphs and fallback views next to the primary graph. */
  plan?: MetricGraphPlan;
  /** The plan's metric graphs, as graphs a query can name. */
  slices: GraphInfo[];
  /** Metric name -> where the skill reads it. */
  readings: Map<string, Reading>;
}

function reading(ctx: Ctx, name: string): Reading {
  return ctx.readings.get(name) ?? {kind: 'sql'};
}

// One page per label. Entity names are free strings, so they are reduced to a
// safe alphabet; two that collide -- including by case alone, which a
// case-insensitive filesystem would merge -- are numbered.
function entityPaths(a: Analysis): Map<string, string> {
  const paths = new Map<string, string>();
  const taken = new Set<string>();
  for (const label of [...a.labels].sort()) {
    const base = label.replace(/[^A-Za-z0-9_-]+/g, '_') || 'entity';
    let slug = base;
    for (let n = 2; taken.has(slug.toLowerCase()); n++) slug = `${base}-${n}`;
    taken.add(slug.toLowerCase());
    paths.set(label, `references/entities/${slug}.md`);
  }
  return paths;
}


// ---------------------------------------------------------------------------
// SKILL.md: frontmatter description and body.
// ---------------------------------------------------------------------------

function descriptionFor(ctx: Ctx, budget: number): string {
  const {a, metricList, primary, runtime} = ctx;
  const concrete = a.order.filter(l => a.nodeTables.has(l));
  const metricNames = metricList.map(m => m.metric.name);
  const graph = primary.ref ? ` ${primary.ref}` : '';
  const build = (shown: number, metricsShown: number): string => {
    const names = concrete.slice(0, shown);
    const more = concrete.length > shown ? ` and ${concrete.length - shown} more entities` : '';
    const mx = metricNames.length ?
        `, plus ${metricNames.length} governed metric${metricNames.length === 1 ? '' : 's'}${
            metricsShown ? ` (${metricNames.slice(0, metricsShown).join(', ')}${
                metricNames.length > metricsShown ? ', …' : ''})` : ''}` :
        '';
    return `Business data on ${names.join(', ')}${more}${mx}. Activate for ` +
        `any question that reads or analyses this data -- counts, totals, ` +
        `rankings, trends, comparisons, relationships between records, or a ` +
        `metric -- answered with GQL on the BigQuery property graph${graph} ` +
        `and SQL.`;
  };
  let fixed = build(Math.min(12, concrete.length), Math.min(5, metricNames.length));
  for (let shown = Math.min(12, concrete.length); fixed.length > budget && shown > 1; shown--) {
    fixed = build(shown, shown > 6 ? Math.min(5, metricNames.length) : 0);
  }
  if (fixed.length > budget) return truncate(fixed, budget);
  const prose = runtime.model.description?.trim() || `The ${runtime.model.name} model.`;
  const subject = sentenceEnd(collapse(prose));
  const room = budget - fixed.length - 1;
  if (subject.length <= room) return `${subject} ${fixed}`;
  if (room < 8) return fixed;
  return `${truncate(subject, room)} ${fixed}`;
}

/**
 * How to answer a question, the same for every model. Written once, here,
 * and kept under 300 words: it is read on every activation, and each rule
 * answers a failure seen when agents were benchmarked over an ontology --
 * closed-world refusals, filters the question never asked for, hedged lists
 * of answers, silently rescaled units.
 */
export const NAVIGATION_GUIDE: readonly string[] = [
  '## How to answer',
  '',
  '1. Find the concept in the index below and open its entity page for ' +
      'properties, relationships, metrics and the source table.',
  '2. Relationships, paths, hierarchies and questions about a parent type: ' +
      'use GQL. A label of an abstract or parent type matches every subtype.',
  '3. Governed metrics: use `GRAPH_EXPAND` on the graph `references/metrics.md` ' +
      'names, selecting the expression it gives (`AGG(<NodeTable>_<measure>)`, ' +
      'or several combined), so each record counts once.',
  '4. Anything else: SQL over the source tables.',
  '5. The model is the preferred source, not the boundary. If a term is not ' +
      'in the model, look in the physical tables and columns before ' +
      'concluding the data does not contain it.',
  '6. Read the question literally. Do not add filters, defined subsets or ' +
      'status conditions it did not ask for.',
  '7. Give one final answer, not a list of alternatives, and state the ' +
      'definition and tables you used. When a question allows several ' +
      'readings, answer the most direct one; never answer "it depends". ' +
      'A caveat never carries a second number: if two readings differ, pick ' +
      'one, give that number only, and name the reading in one sentence.',
  '8. Units and scale are per property on entity pages. State them; never ' +
      'rescale values unless the page says to.',
  '9. Mention a constraint only when it is relevant to the answer and ' +
      'reports violations.',
  '',
];

function gqlBasics(graph: string): string[] {
  return [
    '## GQL in BigQuery',
    '',
    `- A graph query starts with the graph: \`GRAPH \\\`${graph}\\\`\`, then ` +
        '`MATCH ... RETURN ...`. There is no FROM.',
    '- Nodes `(o:Label)`, edges `-[e:rel]->`; filter with `WHERE` after ' +
        'MATCH. `(n:A|B)` matches either label.',
    '- Read properties by their model name (`o.propertyName`), not the ' +
        'physical column; entity pages list both.',
    '- Variable-length paths are quantified: `-[:rel]->{1,5}` (give an upper ' +
        'bound).',
    '- Aggregate in RETURN with `GROUP BY`, or wrap the pattern in SQL: ' +
        '`SELECT ... FROM GRAPH_TABLE(\\`graph\\` MATCH ... COLUMNS (o.x AS x))`.',
    '- `OPTIONAL MATCH` keeps rows with no match; add `LIMIT` while exploring.',
    '',
  ];
}

function skillBody(ctx: Ctx): string[] {
  const {a, graphs, primary, runtime, opts, paths, metricList, plan} = ctx;
  const out: string[] = [];
  out.push('## Where the data is');
  out.push('');
  out.push(`- Property graph: \`${graphRefOrPlaceholder(primary)}\` (BigQuery, ` +
      `profile \`${runtime.profile}\`, ${primary.nodeTables.length} node tables).`);
  for (const g of graphs.filter(g => !g.primary)) {
    const use = expandable(g) && g.measures.size ? ' Use it for `GRAPH_EXPAND`.' : '';
    out.push(`- Also: \`${g.ref}\` (model \`${g.modelName}\`, ${
        g.nodeTables.length} node tables, ${g.measures.size} measures).${use}`);
  }
  if (plan?.slices.length) {
    out.push('- Metric graphs for `GRAPH_EXPAND`, one per fact entity (a tree ' +
        'rooted at the fact); `references/metrics.md` names the one for each metric:');
    for (const s of plan.slices) {
      out.push(`  - \`${s.ref}\`: root \`${s.fact}\`, node tables ${
          s.nodeTables.map(n => `\`${n}\``).join(', ')}.`);
    }
  }
  if (plan?.views.length) {
    out.push(`- Metric views, for metrics no graph can hold: ${
        plan.views.map(v => `\`${v.ref}\` (one row per \`${v.fact}\`)`).join(', ')}.`);
  }
  if (primary.dataset) {
    out.push(`- Semantic dataset: \`${primary.dataset}\`. Each entity page names its source table.`);
  }
  out.push(opts.location ?
               `- Location: \`${opts.location}\`.` :
               '- Location: not recorded in the model; run in the dataset\'s location.');
  out.push(`- Discovery: Knowledge Catalog entry group \`${runtime.entryGroup}\` ` +
      'holds the same entities with their metadata and glossary.');
  out.push('');

  out.push(...navigationGuide(a.model));
  out.push(...gqlBasics(graphRefOrPlaceholder(primary)));

  out.push('## Entities');
  out.push('');
  out.push('One line per graph label, most connected first. Open the page ' +
      'before you query an entity.');
  out.push('');
  const anySubsets = a.order.some(l => (a.subsets.get(l) ?? []).length);
  out.push(`| Label | Kind | Description | Key | Rels |${anySubsets ? ' Subsets |' : ''}`);
  out.push(`| --- | --- | --- | --- | --- |${anySubsets ? ' --- |' : ''}`);
  for (const label of a.order) {
    const e = a.byName.get(label)!;
    const kind = a.nodeTables.has(label) ?
        'node' :
        `abstract (${(a.carriers.get(label) ?? []).length} subtypes)`;
    const desc = truncateCell(firstLine(e.description ?? ''), INDEX_DESCRIPTION);
    const key = a.nodeTables.has(label) ? (e.keys ?? []).map(k => `\`${k}\``).join(', ') : '';
    const subs = (a.subsets.get(label) ?? []).map(s => s.kind === 'defined' ? `\`${s.flag}\`` : s.name);
    out.push(`| [${cell(label)}](${paths.get(label)}) | ${kind} | ${desc} | ${key} | ${
        a.degree.get(label) ?? 0} |${anySubsets ? ` ${cell(subs.join(', '))} |` : ''}`);
  }
  out.push('');
  if (anySubsets) {
    out.push('Subsets are narrower concepts listed on the parent\'s page, ' +
        'not labels. Apply one only when the question uses that concept.');
    out.push('');
  }
  if (a.orphans.length) {
    out.push(`Concepts with no graph label: ${a.orphans.map(o => o.name).join(', ')}.`);
    out.push('');
  }

  if (metricList.length) {
    out.push('## Metrics');
    out.push('');
    out.push('Expressions and ready queries: `references/metrics.md`.');
    out.push('');
    out.push('| Metric | Description | Read on |');
    out.push('| --- | --- | --- |');
    for (const {metric} of metricList) {
      const where = readOn(reading(ctx, metric.name));
      out.push(`| \`${cell(metric.name)}\` | ${
          truncateCell(firstLine(metric.description ?? ''), INDEX_DESCRIPTION)} | ${where} |`);
    }
    out.push('');
  }

  // K9 business glossary (glossary.ts): one line per term, capped.
  const terms = glossarySkillSection(a.model);
  if (terms) {
    out.push('## Business terms');
    out.push('');
    out.push('Business name (synonyms) -> the model element or formula it ' +
        'names.');
    out.push('');
    out.push(...terms);
    out.push('');
  }

  out.push('## More');
  out.push('');
  out.push('- `references/entities/<Label>.md`: one page per label above.');
  out.push('- `references/metrics.md`: every metric, with a query.');
  out.push('- `references/patterns.md`: example GQL and SQL over this graph.');
  out.push('');
  return out;
}

// NAVIGATION_GUIDE, plus the one glossary rule when the model has a
// glossary (numbered after the last rule, before the closing blank line).
function navigationGuide(model: SemanticModel): readonly string[] {
  if (!model.glossary?.terms.length) return NAVIGATION_GUIDE;
  const rules = NAVIGATION_GUIDE.filter(l => /^\d+\. /.test(l)).length;
  const out = [...NAVIGATION_GUIDE];
  out.splice(out.length - 1, 0,
      `${rules + 1}. ${glossaryGuideLine(glossaryId(model))}`);
  return out;
}

function truncateCell(text: string, max: number): string {
  const t = collapse(text);
  return cell(t.length > max ? truncate(t, max) : t);
}

function shortGraph(g: GraphInfo): string {
  return g.ref ? g.ref.split('.').pop()! : g.modelName;
}

/** The index's "Read on" cell for a metric. */
function readOn(r: Reading): string {
  if (r.kind === 'graph') return `\`${r.anchor}\` in \`${shortGraph(r.graph)}\``;
  if (r.kind === 'view') return `view \`${r.view.viewName}\``;
  return 'SQL';
}


// ---------------------------------------------------------------------------
// references/entities/<Label>.md
// ---------------------------------------------------------------------------

function entityPage(ctx: Ctx, label: string): string {
  const {a, primary, metricList, paths} = ctx;
  const e = a.byName.get(label)!;
  const isNode = a.nodeTables.has(label);
  const ancestors = ancestorsOf(a.byName, label).filter(x => a.labels.has(x));
  const out: string[] = [];
  out.push(`# ${label}`);
  out.push('');
  out.push(isNode ?
               `Node label \`${label}\` in \`${graphRefOrPlaceholder(primary)}\`.` :
               `Abstract label \`${label}\` in \`${graphRefOrPlaceholder(primary)}\`: ` +
                   'no table of its own. `MATCH (x:' + label + ')` returns ' +
                   'every node table that carries it.');
  if (ancestors.length) {
    out.push('');
    out.push(`Labels it carries: ${[label, ...ancestors].map(tick).join(', ')}. ` +
        `A MATCH on any of them also returns ${label}.`);
  }
  out.push('');
  if (e.description) {
    out.push(paragraph(e.description));
    out.push('');
  }
  const notes = aiNotes(e.aiContext);
  if (notes.length) {
    out.push(notes.join(' '));
    out.push('');
  }
  if (isNode) {
    out.push(`Key: ${(e.keys ?? []).map(tick).join(', ')}. Source table: ${tableRef(e.dataSource)}.`);
    out.push('');
  }
  // K7 grain / history (units_history.ts).
  const grainHistory = grainHistoryLines(e, name => columnOf(e, name));
  if (grainHistory.length) {
    out.push(...grainHistory.flatMap(l => [l, '']));
  }
  // K3 vocabulary members (vocabulary.ts).
  const memberLines = vocabularySkillLines(e);
  if (memberLines.length) {
    out.push('## Members');
    out.push('');
    out.push(...memberLines);
    out.push('');
  }

  // Properties.
  out.push('## Properties');
  out.push('');
  const fields = e.fields.filter(f => !isNode || fieldBinding(f) !== undefined);
  if (fields.length) {
    out.push(isNode ? '| Property | Type | Column | Notes |' : '| Property | Type | Notes |');
    out.push(isNode ? '| --- | --- | --- | --- |' : '| --- | --- | --- |');
    for (const f of fields) {
      const col = isNode ? ` ${tick(physicalColumn(e, f) ?? f.name)} |` : '';
      out.push(`| \`${cell(f.name)}\` | ${f.type ?? ''} |${col} ${cell(fieldNotes(f))} |`);
    }
  } else {
    out.push('None declared.');
  }
  out.push('');
  const unbound = isNode ? e.fields.filter(f => fieldBinding(f) === undefined) : [];
  if (unbound.length) {
    out.push(`Declared but unbound here (not in the graph): ${unbound.map(f => tick(f.name)).join(', ')}.`);
    out.push('');
  }

  // Relationships.
  out.push(...relationshipSection(ctx, label, ancestors));

  // Hierarchy.
  const subtypes = [...a.labels]
                       .filter(l => l !== label && ancestorsOf(a.byName, l).includes(label))
                       .sort();
  if (ancestors.length || subtypes.length) {
    out.push('## Hierarchy');
    out.push('');
    if (ancestors.length) out.push(`- Supertypes: ${ancestors.map(x => link(paths, x)).join(', ')}`);
    if (subtypes.length) out.push(`- Subtypes: ${subtypes.map(x => link(paths, x)).join(', ')}`);
    out.push('');
  }

  // Subsets.
  const subsets = a.subsets.get(label) ?? [];
  const defined = subsets.filter(s => s.kind === 'defined');
  const conceptual = subsets.filter(s => s.kind === 'conceptual');
  if (defined.length) {
    out.push('## Defined subsets');
    out.push('');
    out.push('Each is a BOOLEAN property on this node. Use one only when the ' +
        'question uses this concept.');
    out.push('');
    for (const s of defined) {
      const what = [s.expression ? `\`${collapse(s.expression)}\`` : '',
                    s.description ? sentenceEnd(collapse(s.description)) : '']
                       .filter(x => x).join(' -- ');
      out.push(`- \`${s.flag}\` (${s.name})${what ? ` -- ${what}` : ''}`);
    }
    out.push('');
  }
  if (conceptual.length) {
    out.push('## Narrower concepts (no label in the graph)');
    out.push('');
    out.push('The model names these but the graph has no label or flag for ' +
        'them. Only when the question uses one, express it as a filter on ' +
        `${label} following its description, and say which filter you used.`);
    out.push('');
    for (const s of conceptual) {
      out.push(`- ${s.name}${s.description ? ` -- ${sentenceEnd(collapse(s.description))}` : ''}`);
    }
    out.push('');
  }

  // Metrics anchored here.
  const anchored = metricList.filter(({metric}) => {
    const r = reading(ctx, metric.name);
    const anchor = r.kind === 'graph' ? r.anchor : r.kind === 'view' ? r.view.fact : undefined;
    return metric.entity === label || anchor === label ||
        new RegExp(`\\b${escapeRe(label)}\\.`).test(metric.expression ?? '');
  });
  if (anchored.length) {
    out.push('## Metrics');
    out.push('');
    for (const {metric} of anchored) {
      const r = reading(ctx, metric.name);
      const how = r.kind === 'graph' ?
          (composed(r) ? `composed from MEASUREs in \`${shortGraph(r.graph)}\`` :
                         `MEASURE \`${r.anchor}_${metric.name}\` in \`${shortGraph(r.graph)}\``) :
          r.kind === 'view' ? `view \`${r.view.viewName}\`` :
                              'SQL only';
      out.push(`- \`${metric.name}\`: \`${collapse(metric.expression ?? metric.importedExpression ?? '')}\` (${how}). See \`references/metrics.md\`.`);
    }
    out.push('');
  }

  // K9 business terms naming this entity or its fields (glossary.ts).
  const termLines = entityGlossaryLines(a.model, label);
  if (termLines.length) {
    out.push('## Business terms');
    out.push('');
    out.push(...termLines);
    out.push('');
  }

  // Constraints touching it or its subsets.
  const touched = new Set([label, ...subsets.map(s => s.name)]);
  const constraints = [...(a.model.constraints ?? [])]
                          .sort(byNameOrder)
                          .filter(c => constraintTokens(c).some(t => touched.has(t)));
  if (constraints.length) {
    out.push('## Constraints');
    out.push('');
    out.push('What the model says should hold. Mention one only when it is ' +
        'relevant to the answer and the data violates it.');
    out.push('');
    for (const c of constraints) out.push(constraintLine(c));
    out.push('');
  }

  // Fallback SQL.
  out.push('## SQL');
  out.push('');
  if (isNode) {
    const cols = fields.slice(0, 4).map(f => {
      const col = physicalColumn(e, f) ?? f.name;
      return col === f.name ? q(col) : `${q(col)} AS ${q(f.name)}`;
    });
    out.push('```sql');
    out.push(`SELECT ${cols.join(', ') || '*'}`);
    out.push(`FROM ${tableRef(e.dataSource)}`);
    out.push('LIMIT 10');
    out.push('```');
  } else {
    const tables = (a.carriers.get(label) ?? []).filter(t => t !== label)
                       .map(t => `${t} ${tableRef(a.byName.get(t)!.dataSource)}`);
    out.push(`No table of its own. Its node tables: ${tables.join('; ')}. ` +
        'In SQL, UNION ALL the shared columns.');
  }
  out.push('');
  return finish(out);
}

function link(paths: Map<string, string>, label: string): string {
  const p = paths.get(label);
  // Pages are siblings under references/entities/.
  return p ? `[${label}](${p.split('/').pop()})` : label;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function constraintTokens(c: Constraint): string[] {
  const text = [c.name, c.judgment ?? '', c.description ?? '',
                String((c as {expression?: unknown}).expression ?? '')].join(' ');
  return text.match(/[A-Za-z0-9]+/g) ?? [];
}

function constraintLine(c: Constraint): string {
  const meta = [c.onViolation ? `on violation: ${c.onViolation}` : '',
                c.severity ? `severity: ${c.severity}` : '']
                   .filter(x => x).join(', ');
  const expr = (c as {expression?: unknown}).expression;
  const rule = typeof expr === 'string' && expr.trim() ?
      `\`${collapse(expr)}\`` :
      sentenceEnd(collapse(c.judgment ?? ''));
  const desc = c.description ? ` ${sentenceEnd(collapse(c.description))}` : '';
  return `- **${c.name}**${meta ? ` (${meta})` : ''}: ${rule}${desc}`;
}

function relationshipSection(ctx: Ctx, label: string, ancestors: string[]): string[] {
  const {a, paths} = ctx;
  const all = [...(a.model.relationships ?? [])].sort(byNameOrder);
  const inGraph = (r: Relationship) => a.relLabels.has(r.name);
  const own = all.filter(r => r.source.entity === label || r.destination.entity === label);
  const inherited = all.filter(
      r => !own.includes(r) && inGraph(r) &&
          (ancestors.includes(r.source.entity) || ancestors.includes(r.destination.entity)));
  const out: string[] = [];
  if (!own.length && !inherited.length) return out;
  out.push('## Relationships');
  out.push('');
  for (const r of own.filter(inGraph)) out.push(...relationshipLines(ctx, r, label));
  for (const r of inherited) out.push(...relationshipLines(ctx, r, label, true));
  const absent = own.filter(r => !inGraph(r));
  if (absent.length) {
    out.push(`- Not in the graph (an endpoint has no node table, or nothing ` +
        `concrete specializes it): ${absent.map(r => tick(r.name)).join(', ')}.`);
  }
  out.push('');
  void paths;
  return out;
}

function relationshipLines(
    ctx: Ctx, r: Relationship, label: string, inherited = false): string[] {
  const {a} = ctx;
  const all = a.model.relationships ?? [];
  const src = r.source.entity;
  const dst = r.destination.entity;
  const card = cardinality(r, a);
  const bits: string[] = [];
  if (r.abstract) {
    const subs = a.rendered.filter(x => relationshipAncestors(all, x.name).includes(r.name))
                     .map(x => tick(x.name));
    bits.push(`label only, carried by ${subs.join(', ')}`);
  } else {
    bits.push(card);
  }
  if (!r.abstract && r.inverse && a.inverses.has(r.name)) {
    bits.push(`inverse \`${edge(r.inverse, dst, src)}\``);
  }
  const parents = relationshipAncestors(all, r.name).filter(x => a.relLabels.has(x));
  if (parents.length) bits.push(`also labelled ${parents.map(tick).join(', ')}`);
  if (inherited) {
    bits.push(`inherited from ${tick(r.source.entity === label ? label :
                                     [src, dst].find(x => x !== label) ?? src)}`);
  }
  if (!r.abstract) bits.push(r.via?.length ? 'derived' : joinText(a, r));
  const head = `- \`${edge(r.name, src, dst)}\` -- ${bits.join('; ')}.`;
  const lines = [head];
  // K2: what a derived edge is computed from (derived_relationships.ts).
  const derived = derivedSkillLine(r, all);
  if (derived) lines.push(`  ${derived}`);
  const text = [r.description ? sentenceEnd(collapse(r.description)) : '',
                ...aiNotes(r.aiContext)].filter(x => x).join(' ');
  if (text) lines.push(`  ${text}`);
  return lines;
}

// The join a relationship stands for, in physical columns, for SQL fallback.
// A join into a vocabulary (K3, vocabulary.ts) compares text codes
// case-insensitively, as the graph's edge does (vocabularyJoinCondition): a
// non-text foreign key is cast to STRING first.
function joinText(a: Analysis, r: Relationship): string {
  const src = a.byName.get(r.source.entity);
  const dst = a.byName.get(r.destination.entity);
  if (r.association) {
    const as = r.association;
    const sk = src?.keys ?? [];
    const dk = dst?.keys ?? [];
    const left = as.sourceColumns.map((c, i) => `j.${c} = ${r.source.entity}.${columnOf(src, sk[i] ?? c)}`);
    const right = as.destinationColumns.map((c, i) => `j.${c} = ${r.destination.entity}.${columnOf(dst, dk[i] ?? c)}`);
    return `SQL via junction ${tableRef(as.dataSource)} AS j: ${[...left, ...right].join(' AND ')}`;
  }
  const vocabulary = dst && isVocabulary(dst) ? dst : undefined;
  const text = (e: Entity|undefined, name: string) => {
    const type = fieldNamed(e, name)?.type;
    return type === undefined || type === 'String';
  };
  const pairs = r.source.columns.map((c, i) => {
    const to = r.destination.columns[i] ?? c;
    const left = `${r.source.entity}.${columnOf(src, c)}`;
    const right = `${r.destination.entity}.${columnOf(dst, to)}`;
    if (!vocabulary || !vocabularyColumnIsText(vocabulary, to)) {
      return `${left} = ${right}`;
    }
    return text(src, c) ? `LOWER(${left}) = LOWER(${right})` :
                          `LOWER(CAST(${left} AS STRING)) = LOWER(${right})`;
  });
  return `SQL join ${pairs.join(' AND ')}`;
}


// ---------------------------------------------------------------------------
// references/metrics.md
// ---------------------------------------------------------------------------

function metricsPage(ctx: Ctx): string {
  const {metricList, plan} = ctx;
  const out: string[] = [];
  out.push('# Metrics');
  out.push('');
  out.push('A governed metric is a graph MEASURE: read it with ' +
      '`GRAPH_EXPAND(\'<graph>\')`, which flattens the graph into columns named ' +
      '`<NodeTable>_<property>`, and wrap the measure in `AGG()`. A measure ' +
      'aggregates each record once however the graph is traversed, so it ' +
      'cannot double-count. `GRAPH_EXPAND` accepts at most ' +
      `${GRAPH_EXPAND_MAX_NODE_TABLES} node tables; each metric below names ` +
      'a graph to read it on. List a graph\'s columns with ' +
      '`DECLARE s STRING; CALL BQ.SHOW_GRAPH_EXPAND_SCHEMA("<graph>", s); SELECT s;`.');
  out.push('');
  if (!metricList.length) {
    out.push('This model declares no metrics.');
    return finish(out);
  }
  const readings = metricList.map(m => reading(ctx, m.metric.name));
  const intro: string[] = [];
  if (plan?.slices.length) {
    intro.push('`GRAPH_EXPAND` also needs a tree: one root node table, every ' +
        'other reached by exactly one path. So each fact entity has a metric ' +
        'graph -- a tree rooted at the fact, with its many-to-one dimensions -- ' +
        'and a metric names the one to use.');
  }
  if (readings.some(composed)) {
    intro.push('A metric made of several aggregates is several MEASUREs: ' +
        'select its composition as given, e.g. `SAFE_DIVIDE(AGG(n), AGG(d))`, ' +
        'which divides the aggregates of each group (NULL when the ' +
        'denominator is 0), never row by row.');
  }
  if (readings.some(r => r.kind === 'view')) {
    intro.push('A metric no graph can hold is read from a generated view with ' +
        'one row per fact record and columns named `<Entity>_<field>`.');
  }
  if (intro.length) {
    out.push(intro.join(' '));
    out.push('');
  }
  metricList.forEach(({metric, from}, i) => {
    const r = readings[i];
    out.push(`## ${metric.name}`);
    out.push('');
    if (metric.description) {
      out.push(paragraph(metric.description));
      out.push('');
    }
    const expr = metric.expression ?? metric.importedExpression;
    if (expr) out.push(`- Expression: \`${collapse(expr)}\``);
    const anchor = r.kind === 'graph' ? r.anchor : r.kind === 'view' ? r.view.fact : metric.entity;
    if (anchor) out.push(`- Anchor: \`${anchor}\``);
    if (from !== ctx.runtime.model.name) out.push(`- Declared in model \`${from}\``);
    if (metric.type) out.push(`- Type: ${metric.type}`);
    const notes = aiNotes(metric.aiContext);
    if (notes.length) out.push(`- ${notes.join(' ')}`);
    out.push(...readingFacts(ctx, metric.name, r));
    out.push('');
    out.push(...readingQuery(ctx, metric, r));
  });
  return finish(out);
}

// The bullets saying where a metric is read: the metric graph, the MEASUREs
// and, for a composite, how they recombine.
function readingFacts(ctx: Ctx, name: string, r: Reading): string[] {
  const out: string[] = [];
  if (r.kind === 'graph' && r.placement?.slice) {
    out.push(`- Graph: \`${r.graph.ref}\`, the metric graph for \`${r.anchor}\` (${
        r.graph.nodeTables.length} node tables: ${r.graph.nodeTables.map(tick).join(', ')})`);
  }
  if (r.kind === 'graph' && r.placement && composed(r)) {
    const p = r.placement;
    const parts = p.decomposition.components.map(
        (c, i) => `\`${p.homes[i]}_${c.name}\` = \`${collapse(c.expression)}\`${countIfNote(c)}`);
    out.push(`- MEASUREs: ${parts.join('; ')}`);
    out.push(`- Composition: \`${r.expression}\``);
  }
  const seen = new Set<string>();
  const homes = [...ctx.graphs, ...ctx.slices].filter(g => {
    if (!g.measures.has(name) || seen.has(g.ref ?? g.modelName)) return false;
    seen.add(g.ref ?? g.modelName);
    return true;
  });
  if (homes.length) {
    out.push(`- MEASURE in: ${homes.map(g => `\`${g.ref}\` (on \`${g.measures.get(name)}\`)`).join(', ')}`);
  }
  return out;
}

// How a COUNTIF component was rewritten into a MEASURE aggregate.
function countIfNote(c: MetricComponent): string {
  if (!c.countIf) return '';
  const how = c.countIf.via === 'membership' ?
      `the membership property \`${c.countIf.flag}\`` :
      'a CASE';
  return ` (\`COUNTIF(${collapse(c.countIf.condition)})\` as ${how})`;
}

// The ready query for a metric: GRAPH_EXPAND on its graph, its fallback
// view, or SQL over the source tables.
function readingQuery(ctx: Ctx, metric: Metric, r: Reading): string[] {
  const out: string[] = [];
  if (r.kind === 'graph') {
    if (expandable(r.graph)) return expandExample(r.graph, r.anchor, r.expression, metric.name);
    // BigQuery refuses GRAPH_EXPAND over a graph with more node tables than
    // the limit ("Property graph has N node tables, which exceeds the
    // maximum of 10"), so a GRAPH_EXPAND example would only mislead.
    out.push(`\`${r.graph.ref}\` has ${r.graph.nodeTables.length} node ` +
        `tables, over the ${GRAPH_EXPAND_MAX_NODE_TABLES} GRAPH_EXPAND ` +
        'accepts, so query this metric in SQL:');
    out.push('');
    out.push(...sqlEquivalent(ctx, metric));
    return out;
  }
  if (r.kind === 'view') {
    out.push(`Not a graph MEASURE (${collapse(r.reason)}). Read it on the ` +
        `generated view \`${r.view.ref}\`, one row per \`${r.view.fact}\` record:`);
    out.push('');
    out.push(...viewExample(ctx, r, metric.name));
    return out;
  }
  out.push(`Not a graph MEASURE${r.reason ? ` (${collapse(r.reason)})` : ''}. ` +
      'Compute it in SQL:');
  out.push('');
  out.push(...sqlEquivalent(ctx, metric));
  return out;
}

// GRAPH_EXPAND over `g`, selecting `expression` -- `AGG(<NodeTable>_<measure>)`
// or a composition of several -- by a dimension of the anchor when it has one.
function expandExample(
    g: GraphInfo, anchor: string, expression: string, metric: string): string[] {
  const dim = expandDimension(g, anchor);
  const lines = ['```sql'];
  if (dim) {
    lines.push(`SELECT ${dim.column} AS ${q(dim.alias)},`);
    lines.push(`       ${expression} AS ${q(metric)}`);
  } else {
    lines.push(`SELECT ${expression} AS ${q(metric)}`);
  }
  lines.push(`FROM GRAPH_EXPAND("${graphRefOrPlaceholder(g)}")`);
  if (dim) {
    lines.push(`GROUP BY ${q(dim.alias)}`);
    lines.push(`ORDER BY ${q(metric)} DESC`);
  }
  lines.push('```');
  lines.push('');
  return lines;
}

// The metric's expression over its fallback view's columns, by a dimension
// of the view when it has one.
function viewExample(
    ctx: Ctx, r: Extract<Reading, {kind: 'view'}>, metric: string): string[] {
  const dim = viewDimension(ctx.a, r.view);
  const expression = collapse(r.expression);
  const lines = ['```sql'];
  if (dim) {
    lines.push(`SELECT ${q(dim.column)} AS ${q(dim.alias)},`);
    lines.push(`       ${expression} AS ${q(metric)}`);
  } else {
    lines.push(`SELECT ${expression} AS ${q(metric)}`);
  }
  lines.push(`FROM ${tick(r.view.ref)}`);
  if (dim) {
    lines.push(`GROUP BY ${q(dim.alias)}`);
    lines.push(`ORDER BY ${q(metric)} DESC`);
  }
  lines.push('```');
  lines.push('');
  return lines;
}

// A dimension of a fallback view: a readable column of an entity the fact
// joins directly, else of the fact itself.
function viewDimension(a: Analysis, v: MetricView):
    {column: string; alias: string}|undefined {
  const near = v.edges.filter(e => e.from === v.fact).map(e => e.to);
  for (const entity of [...near, v.fact]) {
    const f = dimensionField(a, entity);
    const column = f ? v.columnFor.get(`${entity}.${f.name}`) : undefined;
    if (f && column) return {column, alias: f.name};
  }
  return undefined;
}

// A dimension to slice a measure by, chosen from the graph the measure lives
// in: a readable column of a to-one neighbour, else of the anchor itself.
function expandDimension(g: GraphInfo, anchor: string):
    {column: string; alias: string}|undefined {
  const a = analyse(g.model);
  const present = new Set(g.nodeTables);
  const rels = (g.model.relationships ?? [])
                   .filter(r => !r.abstract && !r.association && r.source.entity === anchor &&
                       present.has(r.destination.entity))
                   .sort(byNameOrder);
  for (const r of rels) {
    const f = dimensionField(a, r.destination.entity);
    if (f) return {column: `${r.destination.entity}_${f.name}`, alias: f.name};
  }
  const own = dimensionField(a, anchor);
  return own ? {column: `${anchor}_${own.name}`, alias: own.name} : undefined;
}

// A metric's expression rewritten over the physical tables: each
// `Entity.field` becomes `Entity.<column>`, with the entity's table aliased
// by its name and joined along the model's relationships.
function sqlEquivalent(ctx: Ctx, metric: Metric): string[] {
  const {a} = ctx;
  const expr = metric.expression ?? metric.importedExpression;
  if (!expr) return ['The metric declares no expression.', ''];
  const used = [...new Set(
      [...expr.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g)]
          .map(m => m[1])
          .filter(n => a.byName.has(n)))].sort();
  const rewritten = expr.replace(
      /\b([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)/g,
      (whole, ent: string, field: string) =>
          a.byName.has(ent) ? `${ent}.${q(columnOf(a.byName.get(ent), field))}` : whole);
  const tables = used.filter(n => a.nodeTables.has(n));
  if (!tables.length) {
    return [`Expression: \`${collapse(expr)}\`. No bound table resolves it.`, ''];
  }
  const lines = ['```sql', `SELECT ${collapse(rewritten)} AS ${q(metric.name)}`];
  lines.push(`FROM ${tableRef(a.byName.get(tables[0])!.dataSource)} AS ${tables[0]}`);
  const joined = new Set([tables[0]]);
  for (const t of tables.slice(1)) {
    const r = a.rendered.find(
        x => !x.association &&
            ((x.source.entity === t && joined.has(x.destination.entity)) ||
             (x.destination.entity === t && joined.has(x.source.entity))));
    const on = r ? joinText(a, r).replace(/^SQL join /, '') : 'TRUE /* no direct relationship: choose the join */';
    lines.push(`JOIN ${tableRef(a.byName.get(t)!.dataSource)} AS ${t} ON ${on}`);
    joined.add(t);
  }
  lines.push('```', '');
  return lines;
}


// ---------------------------------------------------------------------------
// references/patterns.md: example queries generated from the model.
// ---------------------------------------------------------------------------

interface Pattern {
  title: string;
  note?: string;
  sql: string[];
}

/** The example queries; tests check every name in them via patterns.md. */
function generatedPatterns(ctx: Ctx): Pattern[] {
  const {a, primary, metricList} = ctx;
  const graph = graphRefOrPlaceholder(primary);
  const G = `GRAPH \`${graph}\``;
  const out: Pattern[] = [];
  const top = a.order.find(l => a.nodeTables.has(l));
  const prop = (label: string, v: string) => {
    const p = displayProperty(a, label);
    return p ? `${v}.${q(p)}` : undefined;
  };

  // Polymorphic MATCH on the most used abstract label.
  const abstract = [...a.labels]
                       .filter(l => !a.nodeTables.has(l))
                       .sort((x, y) => (a.carriers.get(y)?.length ?? 0) - (a.carriers.get(x)?.length ?? 0) ||
                           (x < y ? -1 : 1))[0];
  if (abstract) {
    const p = prop(abstract, 'n');
    out.push({
      title: `Polymorphic match: every ${abstract}`,
      note: `\`${abstract}\` is abstract; the match returns all ${
          (a.carriers.get(abstract) ?? []).length} node tables that carry it (${
          (a.carriers.get(abstract) ?? []).join(', ')}).`,
      sql: [G, `MATCH (n:${q(abstract)})`, p ? `RETURN ${p} AS ${q(p.split('.')[1])}` : 'RETURN COUNT(*) AS n', p ? 'LIMIT 20' : ''],
    });
  }

  // One hop along a real relationship from the most connected entity.
  const relsByPreference = [...a.rendered].sort(
      (x, y) => rank(a, y, top) - rank(a, x, top) || byNameOrder(x, y));
  const one = relsByPreference[0];
  if (one) {
    const s = one.source.entity;
    const d = one.destination.entity;
    out.push({
      title: `One hop: ${edge(one.name, s, d)}`,
      sql: [G, `MATCH (a:${q(s)})-[:${q(one.name)}]->(b:${q(d)})`,
            `RETURN ${[prop(s, 'a'), prop(d, 'b')].filter(x => x).map((x, i) => `${x} AS ${['a_', 'b_'][i]}${x!.split('.')[1].replace(/`/g, '')}`).join(', ') || 'COUNT(*) AS n'}`,
            'LIMIT 10'],
    });

    // Aggregate over the traversal.
    const dim = dimensionField(a, d);
    const by = dim ? dim.name : displayProperty(a, d);
    if (by) {
      out.push({
        title: `Aggregate over a traversal: ${s} per ${d}.${by}`,
        sql: [G, `MATCH (a:${q(s)})-[:${q(one.name)}]->(b:${q(d)})`,
              `RETURN b.${q(by)} AS ${q(by)}, COUNT(a) AS ${q(lowerFirst(s) + '_count')}`,
              `GROUP BY ${q(by)}`, `ORDER BY ${q(lowerFirst(s) + '_count')} DESC`, 'LIMIT 10'],
      });
    }
  }

  // Two hops.
  let two: {r1: Relationship; r2: Relationship; converge: boolean}|undefined;
  for (const r1 of relsByPreference) {
    const next = a.rendered.find(
        r2 => r2 !== r1 && r2.source.entity === r1.destination.entity &&
            r2.destination.entity !== r1.source.entity);
    if (next) {
      two = {r1, r2: next, converge: false};
      break;
    }
  }
  if (!two) {
    for (const r1 of relsByPreference) {
      const next = a.rendered.find(
          r2 => r2 !== r1 && r2.destination.entity === r1.destination.entity &&
              r2.source.entity !== r1.source.entity);
      if (next) {
        two = {r1, r2: next, converge: true};
        break;
      }
    }
  }
  if (two) {
    const {r1, r2, converge} = two;
    const A = r1.source.entity, B = r1.destination.entity;
    const C = converge ? r2.source.entity : r2.destination.entity;
    const hop2 = converge ? `<-[:${q(r2.name)}]-(c:${q(C)})` : `-[:${q(r2.name)}]->(c:${q(C)})`;
    const ret = [prop(A, 'a'), prop(C, 'c')].filter(x => x);
    out.push({
      title: `Two hops: ${A} -> ${B} ${converge ? '<-' : '->'} ${C}`,
      sql: [G, `MATCH (a:${q(A)})-[:${q(r1.name)}]->(b:${q(B)})${hop2}`,
            `RETURN ${ret.map((x, i) => `${x} AS ${['a_', 'c_'][i]}${x!.split('.')[1].replace(/`/g, '')}`).join(', ') || 'COUNT(*) AS n'}`,
            'LIMIT 10'],
    });

    // The same pattern inside SQL.
    const cols = [prop(A, 'a'), prop(C, 'c')].filter(x => x)
                     .map((x, i) => ({expr: x!, alias: `${['a_', 'c_'][i]}${x!.split('.')[1].replace(/`/g, '')}`}));
    if (cols.length === 2) {
      out.push({
        title: 'GRAPH_TABLE inside SQL',
        note: 'Use this when the rest of the query is easier in SQL: joins to tables outside the graph, window functions, CTEs.',
        sql: [`SELECT ${cols[1].alias}, COUNT(DISTINCT ${cols[0].alias}) AS n`,
              'FROM GRAPH_TABLE(',
              `  \`${graph}\``,
              `  MATCH (a:${q(A)})-[:${q(r1.name)}]->(b:${q(B)})${hop2}`,
              `  COLUMNS (${cols.map(c => `${c.expr} AS ${c.alias}`).join(', ')})`,
              ')',
              `GROUP BY ${cols[1].alias}`,
              'ORDER BY n DESC',
              'LIMIT 10'],
      });
    }
  }

  // Quantified path on a relationship the model says is transitive.
  const transitive = [...(a.model.relationships ?? [])]
                         .sort(byNameOrder)
                         .find(r => a.relLabels.has(r.name) &&
                             /\btransitive\b/i.test(r.aiContext?.instructions ?? ''));
  if (transitive) {
    const s = transitive.source.entity;
    const d = transitive.destination.entity;
    const sl = a.labels.has(s) ? `:${q(s)}` : '';
    const dl = a.labels.has(d) ? `:${q(d)}` : '';
    const ret = ([[prop(s, 'a'), 'a_'], [prop(d, 'b'), 'b_']] as const)
                    .filter(([x]) => x)
                    .map(([x, pre]) => `${x} AS ${pre}${x!.split('.')[1].replace(/`/g, '')}`);
    out.push({
      title: `Quantified path: ${transitive.name} is transitive`,
      note: 'Only direct edges are stored; the quantifier follows the chain. Raise the upper bound for deeper chains.',
      sql: [G, `MATCH (a${sl})-[:${q(transitive.name)}]->{1,5}(b${dl})`,
            `RETURN ${ret.join(', ') || 'COUNT(*) AS n'}`,
            'LIMIT 20'],
    });
  }

  // Inverse edge.
  const inv = relsByPreference.find(r => r.inverse && a.inverses.has(r.name));
  if (inv && inv.inverse) {
    const s = inv.source.entity, d = inv.destination.entity;
    out.push({
      title: `Inverse edge: ${inv.inverse} reads ${inv.name} backwards`,
      sql: [G, `MATCH (b:${q(d)})-[:${q(inv.inverse)}]->(a:${q(s)})`,
            `RETURN ${prop(d, 'b') ?? 'b'} AS key, COUNT(a) AS n`, 'GROUP BY key', 'ORDER BY n DESC', 'LIMIT 10'],
    });
  }

  // A metric by a dimension -- on a graph GRAPH_EXPAND accepts, when there is
  // one -- and a composite metric's recombination, when the model has one.
  type OnGraph = {name: string; r: Extract<Reading, {kind: 'graph'}>};
  const onGraph = metricList.map(m => ({name: m.metric.name, r: reading(ctx, m.metric.name)}))
                      .filter((x): x is OnGraph => x.r.kind === 'graph');
  const firstMeasure = onGraph.find(x => expandable(x.r.graph) && !composed(x.r)) ??
      onGraph.find(x => expandable(x.r.graph)) ?? onGraph[0];
  if (firstMeasure) {
    const {name, r} = firstMeasure;
    out.push({
      title: `Governed metric by a dimension: ${name}`,
      sql: sqlOnly(expandExample(r.graph, r.anchor, r.expression, name)),
    });
  }
  const composite = onGraph.find(
      x => x !== firstMeasure && expandable(x.r.graph) && composed(x.r));
  if (composite) {
    const {name, r} = composite;
    out.push({
      title: `Composite metric: ${name}`,
      note: 'Several MEASUREs recombined after aggregating, exactly as ' +
          '`references/metrics.md` gives the composition; SAFE_DIVIDE gives ' +
          'NULL for a group whose denominator is 0.',
      sql: sqlOnly(expandExample(r.graph, r.anchor, r.expression, name)),
    });
  }

  // Plain SQL over the source tables.
  if (one && !one.association) {
    const s = a.byName.get(one.source.entity)!;
    const d = a.byName.get(one.destination.entity)!;
    const dim = dimensionField(a, d.name);
    const dcol = dim ? columnOf(d, dim.name) : columnOf(d, d.keys[0]);
    out.push({
      title: 'Plain SQL over the source tables',
      note: 'For questions the graph does not shape: filters, counts, columns the model does not declare.',
      sql: [`SELECT ${d.name}.${q(dcol)}, COUNT(*) AS n`,
            `FROM ${tableRef(s.dataSource)} AS ${s.name}`,
            `JOIN ${tableRef(d.dataSource)} AS ${d.name} ON ${joinText(a, one).replace(/^SQL join /, '')}`,
            `GROUP BY ${d.name}.${q(dcol)}`, 'ORDER BY n DESC', 'LIMIT 10'],
    });
  }
  return out.map(p => ({...p, sql: p.sql.filter(l => l !== '')}));
}

function rank(a: Analysis, r: Relationship, top: string|undefined): number {
  const touchesTop = r.source.entity === top ? 2 : r.destination.entity === top ? 1 : 0;
  return touchesTop * 1000 + (a.degree.get(r.source.entity) ?? 0) + (a.degree.get(r.destination.entity) ?? 0);
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** A fenced example's SQL lines, without the fence and blank lines. */
function sqlOnly(lines: string[]): string[] {
  return lines.filter(l => l !== '```sql' && l !== '```' && l !== '');
}

function patternsPage(ctx: Ctx): string {
  const out: string[] = [];
  out.push('# Query patterns');
  out.push('');
  out.push('Generated from the model: every label, edge and property below ' +
      'exists in the graph. Adapt them; do not copy filters the question does ' +
      'not ask for.');
  out.push('');
  for (const p of generatedPatterns(ctx)) {
    out.push(`## ${p.title}`);
    out.push('');
    if (p.note) {
      out.push(p.note);
      out.push('');
    }
    out.push('```sql');
    out.push(...p.sql);
    out.push('```');
    out.push('');
  }
  return finish(out);
}

/** Exposed for tests: the analysis of a model, as the skill reads it. */
export function graphLabels(model: SemanticModel):
    {nodeLabels: string[]; edgeLabels: string[]} {
  const a = analyse(model);
  const edges = new Set(a.relLabels);
  for (const r of a.rendered) if (r.inverse && a.inverses.has(r.name)) edges.add(r.inverse);
  return {nodeLabels: [...a.labels].sort(), edgeLabels: [...edges].sort()};
}
