// Generates BigQuery property-graph DDL (with inline measures) from the
// Semantic Model IR.
//
// The shared GoogleSQL generator (./graph_ddl) writes the graph structure: node
// tables, edge tables, labels, properties, and key and join columns. This
// module supplies its BigQuery engine: qualified names, measures, the
// per-element OPTIONS clause, and the SQL text a field binds to.
//
// BigQuery graph measures bind an aggregate to exactly one table's KEY; the
// cross-entity rollup happens at query time via GRAPH_EXPAND(...) + AGG(...).
// A metric therefore lands on whichever single table its aggregate columns
// reference; a metric whose aggregate genuinely spans multiple tables cannot be
// expressed as one MEASURE and is skipped (reported in `warnings`).
//
// A measure can only aggregate an EXPOSED PROPERTY of its node (not a raw
// column or an inline expression), so each metric is lowered into a derived
// operand property plus a MEASURE over it (see placeMetric / exposeOperand).
//
// See: https://docs.cloud.google.com/bigquery/docs/graph-measures
//

import {generateGraphDdl, GenerateResult, GraphEngine, MetricPlacementInput} from './graph_ddl';
import {AiContext, Entity, expressionForDialect, Field, isFieldBound, isTimeDimension, Metric, SemanticModel,} from './ir';
import {referencedEntityNames, sqlWithoutComments, stripQualifier} from './sql_expr_utils';
import {isSimpleIdentifier, quoteIfReserved} from './sql_identifiers';

export interface GenerateOptions {
  project?: string;    // fills the graph name's project
  dataset?: string;    // fills the graph name's dataset
  graphName?: string;  // default: model.name
}

export type {GenerateResult};

// Aggregate functions BigQuery accepts inside MEASURE(...). This is the
// COMPLETE allowed set, not a convenience subset: BigQuery rejects any other
// aggregate in a measure expression with "Aggregate function <name> is not
// allowed in a measure expression in BigQuery" (verified live — STDDEV,
// VARIANCE, COUNTIF, APPROX_COUNT_DISTINCT, ANY_VALUE, LOGICAL_AND/OR,
// BIT_AND/OR/XOR all rejected). A metric using an aggregate outside this set
// therefore cannot be a MEASURE and is skipped + warned rather than emitted as
// DDL BigQuery would reject.
const SUPPORTED_AGGREGATES = ['SUM', 'AVG', 'COUNT', 'MIN', 'MAX'];

/**
 * Generates the BigQuery property-graph DDL for a semantic model.
 *
 * The generated statement references the entities' existing base tables; it
 * does not create them. Returns the DDL plus any warnings collected while
 * mapping the IR (e.g. metrics that could not be placed on a single table).
 *
 * Throws when the model yields no valid node table -- it declares no entities,
 * or every entity lacks a KEY -- since a property graph with an empty NODE
 * TABLES block is invalid DDL that BigQuery would reject.
 */
export function generatePropertyGraph(
    model: SemanticModel, opts: GenerateOptions = {}): GenerateResult {
  return generateGraphDdl(model, bigQueryEngine(opts));
}

// The BigQuery engine for the shared generator.
function bigQueryEngine(opts: GenerateOptions): GraphEngine {
  return {
    name: 'BigQuery',
    table: qualifyTable,
    graphName: model => qualifyGraph(model, opts),
    placeMetrics,
    elementOptions: (description, ai) =>
        optionsClause(elementDescription(description, ai), ai?.synonyms),
    fieldOptions: field =>
        optionsClause(fieldDescription(field), field.aiContext?.synonyms),
    dialect: 'BIGQUERY',
    fieldExpression,
  };
}

// Places each metric on the single entity its aggregate references, lowering
// it to a MEASURE over an exposed property (see placeMetric).
function placeMetrics(
    metrics: Metric[], input: MetricPlacementInput,
    warnings: string[]): Map<string, string[]> {
  const loweringByEntity = new Map<string, MeasureLowering>();
  for (const metric of metrics) {
    placeMetric(metric, input, loweringByEntity, warnings);
  }
  // The operand properties come first: the measures aggregate them.
  const placed = new Map<string, string[]>();
  for (const [name, lowering] of loweringByEntity) {
    placed.set(name, [...lowering.derivedProperties, ...lowering.measures]);
  }
  return placed;
}


// Per-entity state for lowering metrics into measures. A BigQuery graph measure
// can only aggregate a PROPERTY of the node, so a metric's aggregate operand
// (which may be a bare column or an arbitrary expression) has to be exposed as
// a property first; the measure then aggregates that property. This tracks the
// derived properties synthesized for one entity, plus the bookkeeping to reuse
// an existing/derived property for an identical operand and keep property names
// unique.
interface MeasureLowering {
  derivedProperties: string[];  // extra property lines to emit on the node
  measures: string[];           // the MEASURE properties placed on the node
  taken: Set<string>;           // property names already in use on the node
  fieldNames: Set<string>;      // declared field names (each an exposed property)
  byLocalExpr: Map<string, string>;  // existing field local-expression -> its
                                     // property name
  operandToName:
      Map<string, string>;  // operand expression -> the property exposing it
}

// Builds the lowering state for an entity, seeded with its declared fields so
// an operand equal to an existing field reuses that property instead of
// duplicating.
function newLowering(entity: Entity): MeasureLowering {
  const taken = new Set<string>();
  const fieldNames = new Set<string>();
  const byLocalExpr = new Map<string, string>();
  for (const f of entity.fields) {
    taken.add(f.name);
    fieldNames.add(f.name);
    const expr = fieldExpression(f);
    if (expr === undefined) continue;
    const local = stripQualifier(expr, entity.name);
    if (!byLocalExpr.has(local)) byLocalExpr.set(local, f.name);
  }
  return {
    derivedProperties: [],
    measures: [],
    taken,
    fieldNames,
    byLocalExpr,
    operandToName: new Map()
  };
}

// Assigns a metric to the node table of the single entity its aggregate
// references, lowering it to a MEASURE over an exposed property. Records a
// warning (and skips) when it references zero/multiple entities or is not a
// single supported aggregate over one operand.
function placeMetric(
    metric: Metric, input: MetricPlacementInput,
    loweringByEntity: Map<string, MeasureLowering>, warnings: string[]): void {
  const {entityByName, skipped, ancestorsUsed} = input;
  // A measure is emitted from the metric's BigQuery SQL (see
  // metricExpression). A metric with SQL only for other engines is skipped
  // with a warning naming the dialects it lacks, rather than emitting that
  // other engine's SQL into a BigQuery graph.
  const expression = metricExpression(metric);
  if (expression === undefined) {
    warnings.push(
        metric.dialects?.length || metric.importedExpression !== undefined ?
            `metric '${metric.name}' has no 'BIGQUERY' or 'ANSI_SQL' ` +
                `expression; skipped (nothing to emit as a MEASURE)` :
            `metric '${metric.name}' has no expression; skipped (nothing ` +
                `to emit as a MEASURE)`);
    return;
  }

  // The entities whose `<name>.` qualifier the expression uses. String literals
  // are ignored, so a value like 'orders.x' does not reference `orders`.
  let referenced = referencedEntityNames(expression, [...entityByName.keys()]);

  // A qualifier-free aggregate (e.g. COUNT(*)) names no entity in its
  // expression; fall back to `metric.entity` when the IR provides one (an
  // authored `entity` in `0.2.0.dev0/google`, an entity inferred from another
  // dialect entry, or hand-built IR), so it can still be placed rather than
  // dropped as "references no entity".
  if (referenced.length === 0 && metric.entity) {
    referenced = [metric.entity];
  }

  if (referenced.length !== 1) {
    const detail = referenced.length === 0 ?
        'references no known entity' :
        `spans multiple tables (${referenced.join(', ')})`;
    warnings.push(`metric '${metric.name}' ${
        detail}; skipped (cannot be a single MEASURE)`);
    return;
  }

  const entityName = referenced[0];

  // The IR also declares a single attach entity (metric.entity). Placement is
  // driven by the qualifiers actually present in the expression (that is what
  // we strip and attach), but a disagreement with the declared entity signals
  // an inconsistent model, so surface it. Emit this only now that we know the
  // metric will actually be placed, so a metric that is subsequently dropped
  // does not carry a contradictory "placing per the expression" note.
  if (metric.entity && entityName !== metric.entity) {
    warnings.push(
        `metric '${metric.name}' declares entity '${metric.entity}' but its ` +
        `expression references '${entityName}'; placing per the expression`);
  }

  const entity = entityByName.get(entityName);
  if (!entity) {
    warnings.push(`metric '${metric.name}' references unknown entity '${
        entityName}'; skipped (cannot be a single MEASURE)`);
    return;
  }
  // An abstract entity is a table-less supertype with no node table, so it can
  // carry no MEASURE. Report that specifically -- it is also in `skipped`, so
  // this must precede the generic no-KEY message below to stay accurate.
  if (entity.abstract) {
    warnings.push(
        `metric '${metric.name}' targets entity '${entityName}', which is ` +
        `abstract (a table-less supertype with no node table to carry a ` +
        `MEASURE); metric dropped`);
    return;
  }
  // A metric can only become a MEASURE on a node table, but an entity that was
  // skipped upstream (empty KEY) has no node table to carry it. Check the skip
  // set already computed, and report the drop directly, instead of letting it
  // fail later with a misleading "aggregate not supported" message.
  if (skipped.has(entityName)) {
    warnings.push(`metric '${metric.name}' targets entity '${
        entityName}', which has no KEY and was skipped; metric dropped`);
    return;
  }
  // A measure is allowed only on a LEAF type -- one that no table-emitting
  // entity extends. A metric lowers to a MEASURE on the target's DEFAULT LABEL;
  // when that entity is a supertype its label is shared with every subtype
  // table, and BigQuery forbids a MEASURE on a label carried by more than one
  // element table (verified live: "defined as MEASURE, but there are other
  // declarations with the same name"). Drop it with a warning rather than emit
  // DDL BigQuery rejects. Push validation rejects such a metric before
  // generation; this guard covers a caller that generates DDL without
  // validating first.
  if (ancestorsUsed.has(entityName)) {
    warnings.push(
        `metric '${metric.name}' targets entity '${entityName}', which is not ` +
        `a leaf type (another entity extends it); a measure is allowed only on ` +
        `a leaf type, because a supertype's label is shared across its ` +
        `subtype tables; skipped`);
    return;
  }

  const body = stripQualifier(expression, entityName);

  // A graph measure must be one supported aggregate wrapping a single operand;
  // anything else (a non-aggregate, or a compound of aggregates like a ratio)
  // cannot be a single MEASURE. Flag it rather than emit DDL BigQuery rejects.
  const agg = extractAggregate(body);
  if (!agg) {
    warnings.push(
        `metric '${metric.name}' expression '${
            body}' is not a single supported aggregate ` +
        `(${
            SUPPORTED_AGGREGATES.join(
                ', ')}) over one operand; skipped (cannot be a single MEASURE)`);
    return;
  }

  const lowering = loweringByEntity.get(entityName) ?? newLowering(entity);
  loweringByEntity.set(entityName, lowering);

  // Resolve the aggregate's operand to an exposed property. COUNT(*) has no
  // operand column, so it counts the (non-null) key property instead.
  let operandExpr = agg.operand;
  if (operandExpr === '*') {
    // The entity is already known to have a key (checked above), so only the
    // aggregate itself can disqualify a `*` operand: BigQuery lowers `COUNT(*)`
    // to a count over the key, but no other aggregate has a `*` form.
    if (agg.fn.toUpperCase() !== 'COUNT') {
      warnings.push(
          `metric '${metric.name}': '${agg.fn}(*)' is not supported; skipped ` +
          `(only COUNT(*) over a keyed node can be lowered)`);
      return;
    }
    operandExpr = entity.keys[0];
  }

  // A field with no BigQuery SQL is left out of the node table, so a measure
  // over it would aggregate a property the table does not declare.
  if (entity.fields.some(
          f => f.name === operandExpr && isFieldBound(f) &&
              fieldExpression(f) === undefined)) {
    warnings.push(
        `metric '${metric.name}' aggregates field '${operandExpr}', which ` +
        `has no 'BIGQUERY' or 'ANSI_SQL' expression; skipped (nothing to ` +
        `emit as a MEASURE)`);
    return;
  }

  // The measure is itself exposed as a node property named `metric.name`, so it
  // must not collide with a field, a prior measure, or a synthesized operand
  // property — a duplicate property makes BigQuery reject the whole node table.
  // A clash with an already-taken name is a model error we cannot paper over by
  // renaming (the measure name is exactly what a reader selects via
  // GRAPH_EXPAND + AGG(<label>_<name>)), so skip + warn. Reserve it up front so
  // the operand lowering below never synthesizes a property with the same name.
  if (lowering.taken.has(metric.name)) {
    warnings.push(
        `metric '${
            metric.name}' collides with an existing property of entity ` +
        `'${entityName}'; skipped (rename the metric to avoid a duplicate graph property)`);
    return;
  }
  lowering.taken.add(metric.name);

  const propName = exposeOperand(lowering, operandExpr, metric.name);
  const aggregate =
      `${agg.fn}(${agg.distinct ? 'DISTINCT ' : ''}${quoteIfReserved(propName)})`;

  const opts = optionsClause(
      elementDescription(metric.description, metric.aiContext),
      metric.aiContext?.synonyms);
  const measure = `MEASURE(${aggregate}) AS ${quoteIfReserved(metric.name)}`;
  lowering.measures.push(opts ? `${measure} ${opts}` : measure);
}

// Ensures `operandExpr` is exposed as a node property and returns its property
// name. Reuses an existing field (or a previously derived property) with the
// same expression; a bare column is exposed under its own name; any other
// expression gets a synthesized, unique name derived from the metric.
function exposeOperand(
    lowering: MeasureLowering, operandExpr: string,
    metricName: string): string {
  const existing = lowering.byLocalExpr.get(operandExpr) ??
      lowering.operandToName.get(operandExpr);
  if (existing) return existing;

  // An operand that names a declared field is already an exposed property, so a
  // MEASURE may aggregate it directly by name -- even when a profile bound that
  // field to a differently named physical column (the property is
  // `<column> AS <field>`, and a MEASURE may reference a sibling alias).
  // Synthesizing an input property here would emit `<field> AS ..._input`, and
  // an alias is illegal inside a property expression -- BigQuery rejects it with
  // "Unrecognized name". (A raw column that is not a field still falls through
  // to be exposed under its own name, which BigQuery requires.)
  if (lowering.fieldNames.has(operandExpr)) return operandExpr;

  let name: string;
  if (isSimpleIdentifier(operandExpr) && !lowering.taken.has(operandExpr)) {
    // A bare column not already declared: expose it under its own name.
    name = operandExpr;
    lowering.derivedProperties.push(quoteIfReserved(name));
  } else {
    name = uniqueName(`${metricName}_input`, lowering.taken);
    lowering.derivedProperties.push(`${quoteIfReserved(operandExpr)} AS ${name}`);
  }
  lowering.taken.add(name);
  lowering.operandToName.set(operandExpr, name);
  return name;
}

// Extracts the function name and operand from a single-aggregate expression, or
// returns null when the body is not exactly one supported aggregate wrapping
// one operand (a non-aggregate, a compound like `SUM(x)/SUM(y)`, a call with no
// operand, or a multi-argument call). `COUNT(DISTINCT x)` is recognized,
// yielding operand `x` with distinct.
function extractAggregate(body: string):
    {fn: string; operand: string; distinct: boolean}|null {
  const s = body.trim();
  const head = s.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\(/);
  if (!head) return null;
  const fn = head[1];
  if (!SUPPORTED_AGGREGATES.includes(fn.toUpperCase())) return null;

  // Find the operand bounded by the aggregate's outer parentheses, tracking
  // string literals and backtick-quoted identifiers and nesting so inner
  // parens/quotes/backticks don't end it early.
  let depth = 0, inStr = false, inTick = false, start = -1, end = -1;
  for (let i = head[0].length - 1; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === '\'') inStr = false;
      continue;
    }
    if (inTick) {
      if (c === '`') inTick = false;
      continue;
    }
    if (c === '\'') {
      inStr = true;
      continue;
    }
    if (c === '`') {
      inTick = true;
      continue;
    }
    if (c === '(') {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (c === ')') {
      if (--depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (start < 0 || end < 0) return null;
  if (s.slice(end + 1).trim() !== '')
    return null;  // trailing ops => not a single aggregate

  let operand = s.slice(start, end).trim();
  let distinct = false;
  const dm = operand.match(/^DISTINCT(?:\s+(.*))?$/is);
  if (dm) {
    distinct = true;
    operand = (dm[1] ?? '').trim();
  }

  if (operand === '') return null;  // no operand, as in SUM() or SUM(DISTINCT)
  if (operand !== '*' && hasTopLevelComma(operand))
    return null;  // multi-arg aggregate
  return {fn, operand, distinct};
}

// True if `expr` contains a comma outside any nested parentheses, string
// literal, or backtick-quoted identifier (i.e. it is really several arguments,
// not one operand). A backtick-quoted column like `` `weird,name` `` must not
// be mistaken for a multi-argument aggregate.
function hasTopLevelComma(expr: string): boolean {
  let depth = 0, inStr = false, inTick = false;
  for (const c of expr) {
    if (inStr) {
      if (c === '\'') inStr = false;
      continue;
    }
    if (inTick) {
      if (c === '`') inTick = false;
      continue;
    }
    if (c === '\'')
      inStr = true;
    else if (c === '`')
      inTick = true;
    else if (c === '(')
      depth++;
    else if (c === ')')
      depth--;
    else if (c === ',' && depth === 0)
      return true;
  }
  return false;
}


// Returns `base` if free, else the first `base_2`, `base_3`, ... not in
// `taken`.
function uniqueName(base: string, taken: Set<string>): string {
  if (!taken.has(base)) return base;
  for (let i = 2;; i++) {
    const candidate = `${base}_${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}


// The SQL BigQuery runs for a field or metric: its `BIGQUERY` dialect entry,
// else its `ANSI_SQL` one (see expressionForDialect), read as BigQuery with its
// comments removed. Another engine's vendor SQL is never returned. The DDL puts
// ` AS <name>` and a comma after the expression on the same line, and a line
// comment left in would swallow them. The `?? expression` fallback is for the
// `--transpile` push option, whose pass (./transpile) writes translated
// BigQuery SQL into `expression` for an item that only had vendor text. Every
// command loads with the default dialect, BIGQUERY, under which the loader
// fills `expression` only from a `BIGQUERY` or `ANSI_SQL` entry, so when the
// list has neither, `expression` can only have come from that pass.
// Once push drops `--transpile`, the fallback changes nothing.
function fieldExpression(f: Field): string|undefined {
  return bigQuerySql(f);
}
function metricExpression(m: Metric): string|undefined {
  return bigQuerySql(m);
}
function bigQuerySql(item: Field|Metric): string|undefined {
  const text = expressionForDialect(item, 'BIGQUERY') ?? item.expression;
  return text === undefined ? undefined : sqlWithoutComments(text);
}


// Builds a backtick-quoted table reference from the IR's `dataSource` string.
// The IR contract guarantees `dataSource` is already canonical and
// fully-qualified: the producer (loader) normalizes a BigQuery or BigLake
// source into a dotted `project.dataset.table` (or four-part BigLake catalog
// name). For BigQuery that canonical form IS the target addressing scheme, so
// this emits it verbatim and NEVER prepends the graph's own project/dataset --
// those name where the graph is CREATED, not where a source table lives, and
// the two can differ (e.g. a graph in `proj.demo` over source tables in
// `samples.tpch`). Qualifying a source table is the producer's job, not the
// emitter's.
function qualifyTable(
    dataSource: string, warnings: string[], context: string): string {
  const trimmed = (dataSource ?? '').trim();
  if (!trimmed) {
    warnings.push(
        `${context}: empty data source; the table reference will be invalid`);
    return '``';
  }
  return `\`${trimmed}\``;
}

// Builds the dataset-qualified graph name, filling a missing project/dataset
// from opts and then from the first entity's qualified dataSource.
function qualifyGraph(model: SemanticModel, opts: GenerateOptions): string {
  const name = opts.graphName ?? model.name;
  let project = opts.project;
  let dataset = opts.dataset;

  // Pick the first entity with a non-empty `dataSource` to derive the graph's
  // location; skip abstract entities (empty source).
  const first = (model.entities ?? []).find(e => e.dataSource);
  if ((!project || !dataset) && first) {
    const p = first.dataSource.trim().split('.');
    if (p.length >= 3) {
      project = project ?? p[0];
      dataset = dataset ?? p[1];
    } else if (p.length === 2) {
      dataset = dataset ?? p[0];
    }
  }

  // A graph name is `name`, `dataset.name`, or `project.dataset.name`; a
  // project with no dataset cannot be expressed (`project.name` would be read
  // as `dataset.name`), so drop a lone project rather than emit a malformed
  // reference.
  if (project && !dataset) project = undefined;

  const parts = [project, dataset, name].filter((p): p is string => !!p);
  return `\`${parts.join('.')}\``;
}


// Composes the folded `description` text for a graph element from its base
// description and the AI-first annotations that have no dedicated BigQuery
// option: instructions and examples. Synonyms are NOT folded in here --
// BigQuery's PropertyGraph{Label,Property}Options carry a structured `synonyms`
// array, so they are emitted as their own option (see optionsClause and the
// call sites).
function elementDescription(description?: string, ai?: AiContext): string|
    undefined {
  return composeText([
    description,
    ai?.instructions,
    examplesLine(ai?.examples),
  ]);
}

// A field additionally carries a human `label` and a temporal-dimension role,
// which lead the composed text (matching the authored order) ahead of its
// description and instructions/examples. Synonyms are emitted structurally, as
// for elementDescription.
function fieldDescription(field: Field): string|undefined {
  return composeText([
    field.label,
    isTimeDimension(field) ? 'Time dimension.' : undefined,
    field.description,
    field.aiContext?.instructions,
    examplesLine(field.aiContext?.examples),
  ]);
}

function examplesLine(examples?: string[]): string|undefined {
  return examples && examples.length ? `Examples: ${examples.join('; ')}` :
                                       undefined;
}

// Joins the non-empty parts into one description, separated by blank lines so
// each reads as its own paragraph in the emitted metadata.
function composeText(parts: (string|undefined)[]): string|undefined {
  const kept = parts.map(p => (p === undefined ? undefined : p.trim()))
                   .filter((p): p is string => !!p);
  return kept.length ? kept.join('\n\n') : undefined;
}

// Renders the trailing `OPTIONS(...)` clause for a graph element -- a folded
// `description` string and/or a structured `synonyms` array -- or undefined
// when there is nothing to emit. Both map to BigQuery's
// PropertyGraph{Label,Property}Options (`description` singular, `synonyms`
// repeated), honored on element-table labels (DEFAULT LABEL, before PROPERTIES)
// and on derived properties and measures (after the alias). Statement-level
// graph OPTIONS is intentionally not emitted: it parses but BigQuery silently
// drops it (verified live; create_property_graph_options is off for BigQuery).
function optionsClause(description?: string, synonyms?: string[]): string|
    undefined {
  const parts: string[] = [];
  if (description) parts.push(`description=${quote(description)}`);
  if (synonyms && synonyms.length) {
    parts.push(`synonyms=[${synonyms.map(quote).join(', ')}]`);
  }
  return parts.length ? `OPTIONS(${parts.join(', ')})` : undefined;
}

// Renders a value as a BigQuery double-quoted string literal. Backslash and the
// quote are escaped, and control characters that cannot appear raw inside a
// quoted literal (newline, carriage return, tab) are escaped too, so a
// multi-line description does not produce a broken literal.
function quote(s: string): string {
  const escaped = s.replace(/\\/g, '\\\\')
                      .replace(/"/g, '\\"')
                      .replace(/\n/g, '\\n')
                      .replace(/\r/g, '\\r')
                      .replace(/\t/g, '\\t');
  return `"${escaped}"`;
}
