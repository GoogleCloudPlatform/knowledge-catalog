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

import {generateGraphDdl, GenerateResult, GraphEngine, MetricPlacementInput, nodeKey, physicalColumn} from './graph_ddl';
import {AiContext, Entity, expressionForDialect, Field, isTimeDimension, Metric, SemanticModel,} from './ir';
import {measureEntities, singleAggregate, sqlWithoutComments, SUPPORTED_AGGREGATES, withoutQualifier} from './sql_expr_utils';
import {isSimpleIdentifier, quoteIfReserved} from './sql_identifiers';
import {soleColumn} from './sql_parser';

export interface GenerateOptions {
  project?: string;    // fills the graph name's project
  dataset?: string;    // fills the graph name's dataset
  graphName?: string;  // default: model.name
}

export type {GenerateResult};

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
  const metricNames = new Set(metrics.map(m => m.name));
  for (const metric of metrics) {
    placeMetric(metric, input, metricNames, loweringByEntity, warnings);
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
  // Every metric's name. Each metric placed here becomes a property named so,
  // so no operand property takes one, whatever order the metrics come in.
  metricNames: ReadonlySet<string>;
  byLocalExpr: Map<string, string>;  // a field's SQL on the node -> the field
  operandToName: Map<string, string>;  // an operand's SQL on the node -> the
                                       // property exposing it
}

// Builds the lowering state for an entity, seeded with its declared fields so
// an operand with the same SQL as a field reuses that property instead of
// duplicating it. A field the node table leaves out has no property to reuse.
function newLowering(
    entity: Entity, input: MetricPlacementInput,
    metricNames: ReadonlySet<string>): MeasureLowering {
  const taken = new Set<string>();
  const byLocalExpr = new Map<string, string>();
  for (const f of entity.fields) {
    taken.add(f.name);
    const read = input.fieldSql(entity, f);
    if (!('sql' in read)) continue;
    if (!byLocalExpr.has(read.sql)) byLocalExpr.set(read.sql, f.name);
  }
  return {
    derivedProperties: [],
    measures: [],
    taken,
    metricNames,
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
    metricNames: ReadonlySet<string>,
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

  // The entities whose qualifier the expression writes before a column, as
  // the SQL parser reads it (see measureEntities), so neither a value like
  // 'orders.x' nor a function namespace such as `NET.` in `NET.HOST(...)`
  // references an entity. A qualifier-free aggregate (e.g. COUNT(*)) names no
  // entity in its expression; it falls back to `metric.entity` when the IR
  // provides one (an authored `entity` in `0.2.0.dev0/google`, an entity
  // inferred from another dialect entry, or hand-built IR), so it can still be
  // placed rather than dropped as "references no entity".
  const referenced =
      measureEntities(expression, [...entityByName.keys()], metric.entity);

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

  const body = withoutQualifier(expression, entityName);

  // A graph measure must be one supported aggregate wrapping a single operand;
  // anything else (a non-aggregate, or a compound of aggregates like a ratio)
  // cannot be a single MEASURE. Flag it rather than emit DDL BigQuery rejects.
  // The SQL parser finds the aggregate and its operand in the expression as
  // written, and in `body` when it cannot read that, as with a qualifier it
  // reserves (`SUM(Date.days)`).
  const written = singleAggregate(expression, 'BIGQUERY');
  const agg = written ?
      {...written, operand: withoutQualifier(written.operand, entityName)} :
      singleAggregate(body, 'BIGQUERY');
  if (!agg) {
    warnings.push(
        `metric '${metric.name}' expression '${
            body}' is not a single supported aggregate ` +
        `(${
            SUPPORTED_AGGREGATES.join(
                ', ')}) over one operand; skipped (cannot be a single MEASURE)`);
    return;
  }

  const lowering = loweringByEntity.get(entityName) ??
      newLowering(entity, input, metricNames);
  loweringByEntity.set(entityName, lowering);

  // Resolve the aggregate's operand to an exposed property. It is read as
  // written, qualifiers kept, so readOperand can tell the entity's fields from
  // its columns. COUNT(*) has no operand column, so it counts the first column
  // of the node's key instead: the primary key, else the first unique key
  // (nodeKey).
  const operand = written?.operand ?? agg.operand;
  let read: OperandRead;
  if (operand === '*') {
    // The entity is already known to have a key (checked above), so only the
    // aggregate itself can disqualify a `*` operand: BigQuery lowers `COUNT(*)`
    // to a count over the key, but no other aggregate has a `*` form.
    if (agg.fn.toUpperCase() !== 'COUNT') {
      warnings.push(
          `metric '${metric.name}': '${agg.fn}(*)' is not supported; skipped ` +
          `(only COUNT(*) over a keyed node can be lowered)`);
      return;
    }
    // A key names a column, never a field, so a field of the same name does
    // not stand in for it. A simple name is quoted, if reserved, where it is
    // exposed (exposeOperand).
    const key = nodeKey(entity)[0];
    read = {
      sql: isSimpleIdentifier(key) ? key : physicalColumn(key),
      column: true
    };
  } else {
    // A field the node table leaves out declares no property, so neither a
    // measure over it nor a property derived from SQL that names it can read
    // it.
    read = readOperand(entity, operand, input);
  }

  if ('skip' in read) {
    warnings.push(
        `metric '${metric.name}' ${read.skip}; skipped (nothing to emit as a ` +
        `MEASURE)`);
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

  const propName = exposeOperand(lowering, read, metric.name);
  const aggregate =
      `${agg.fn}(${agg.distinct ? 'DISTINCT ' : ''}${quoteIfReserved(propName)})`;

  const opts = optionsClause(
      elementDescription(metric.description, metric.aiContext),
      metric.aiContext?.synonyms);
  const measure = `MEASURE(${aggregate}) AS ${quoteIfReserved(metric.name)}`;
  lowering.measures.push(opts ? `${measure} ${opts}` : measure);
}

// What a metric's aggregate operand reads on `entity`'s node table:
//
//   - `field`: a field of `entity`, written as `<entity>.<field>` or bare,
//     which is a property already;
//   - `sql`: any other SQL, local to the table, with each field it names as
//     `<entity>.<field>` read through that field's own SQL (see
//     MetricPlacementInput.localSql). `column` marks a column of the table
//     that no field names, written as `<entity>.<column>` or bare.
//
// `skip` is set instead when the operand reads a field the node table leaves
// out, and says which.
type OperandRead =
    {field: string}|{sql: string; column: boolean}|{skip: string};
function readOperand(
    entity: Entity, operand: string,
    input: MetricPlacementInput): OperandRead {
  // Checked before any column: a field is read through its own SQL, which may
  // name another column, while a column of the same name may hold something
  // else.
  const column = soleColumn(operand, 'BIGQUERY');
  const own = column !== undefined &&
      (column.qualifier === undefined || column.qualifier === entity.name);
  const field =
      own ? entity.fields.find(f => f.name === column.name) : undefined;
  if (field) {
    const read = input.fieldSql(entity, field);
    return 'sql' in read ? {field: field.name} :
                           {skip: `aggregates ${read.reads}`};
  }
  const read = input.localSql(entity, operand);
  return 'sql' in read ? {sql: read.sql, column: own} :
                         {skip: `reads ${read.reads}`};
}

// Ensures the operand `read` is exposed as a node property and returns its
// property name. A field is one already. Other SQL reuses a field (or a
// previously derived property) with the same SQL; a column no field names is
// exposed under its own name; any other SQL gets a synthesized, unique name
// derived from the metric.
function exposeOperand(
    lowering: MeasureLowering, read: Exclude<OperandRead, {skip: string}>,
    metricName: string): string {
  // A MEASURE may aggregate a field directly by name -- even when a profile
  // bound that field to a differently named physical column (the property is
  // `<column> AS <field>`, and a MEASURE may reference a sibling alias).
  // Synthesizing an input property here would emit `<field> AS ..._input`, and
  // an alias is illegal inside a property expression -- BigQuery rejects it with
  // "Unrecognized name".
  if ('field' in read) return read.field;

  const {sql} = read;
  const existing =
      lowering.byLocalExpr.get(sql) ?? lowering.operandToName.get(sql);
  if (existing) return existing;

  const isFree = (name: string) =>
      !lowering.taken.has(name) && !lowering.metricNames.has(name);
  let name: string;
  if (read.column && isSimpleIdentifier(sql) && isFree(sql)) {
    // A column not already declared: expose it under its own name.
    name = sql;
    lowering.derivedProperties.push(quoteIfReserved(name));
  } else {
    name = uniqueName(`${metricName}_input`, isFree);
    // Only a column is quoted: a keyword such as TRUE stays a keyword.
    lowering.derivedProperties.push(
        `${read.column ? quoteIfReserved(sql) : sql} AS ${name}`);
  }
  lowering.taken.add(name);
  lowering.operandToName.set(sql, name);
  return name;
}

// Returns `base` if free, else the first of `base_2`, `base_3`, ... that is.
function uniqueName(base: string, isFree: (name: string) => boolean): string {
  if (isFree(base)) return base;
  for (let i = 2;; i++) {
    const candidate = `${base}_${i}`;
    if (isFree(candidate)) return candidate;
  }
}


// The SQL BigQuery runs for a field or metric: its `BIGQUERY` dialect entry,
// else its `ANSI_SQL` one (see expressionForDialect), read as BigQuery with its
// comments removed. Another engine's vendor SQL is never returned. The DDL puts
// ` AS <name>` and a comma after the expression on the same line, and a line
// comment left in would swallow them.
function fieldExpression(f: Field): string|undefined {
  return bigQuerySql(f);
}
function metricExpression(m: Metric): string|undefined {
  return bigQuerySql(m);
}
function bigQuerySql(item: Field|Metric): string|undefined {
  const text = expressionForDialect(item, 'BIGQUERY');
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
