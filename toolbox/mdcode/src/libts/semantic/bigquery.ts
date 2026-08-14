// Generates BigQuery property-graph DDL (with inline measures) from the
// Semantic Model IR.
//
// The IR (./ir) is pure semantics. This module is one of its consumers: it
// emits a single `CREATE OR REPLACE PROPERTY GRAPH` statement over the
// entities' existing base tables, with model-level metrics rendered as inline
// `MEASURE(...)` properties.
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

import {AiContext, Association, Entity, Field, isTimeDimension, Metric, Relationship, SemanticModel,} from './ir';
import {referencedEntityNames, stripQualifier} from './sql_expr_utils';

export interface GenerateOptions {
  project?: string;    // fills the project for the graph name + under-qualified
                       // table refs
  dataset?: string;    // fills the dataset for the graph name + under-qualified
                       // table refs
  graphName?: string;  // default: model.name
}

export interface GenerateResult {
  ddl: string;         // CREATE OR REPLACE PROPERTY GRAPH ...
  warnings: string[];  // skipped metrics, unresolved table refs, etc.
}

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
  const warnings: string[] = [];

  // The IR requires entities/relationships/metrics, but be defensive against a
  // hand-built or partially-deserialized model rather than throwing on `.map`.
  const entities = model.entities ?? [];
  const relationships = model.relationships ?? [];
  const metrics = model.metrics ?? [];

  // A graph node table requires a non-empty KEY. An entity whose primary key is
  // empty cannot form a valid node, so skip it (and, below, any edge that
  // references it) rather than emit `KEY()` — invalid DDL. The loader already
  // warns about the missing key; this records the resulting structural drop.
  const skipped = new Set<string>();
  const validEntities = entities.filter(entity => {
    if (entity.keys && entity.keys.length) return true;
    warnings.push(
        `entity '${
            entity.name}': empty KEY (no primary key); node table skipped, ` +
        `as a graph node requires a KEY`);
    skipped.add(entity.name);
    return false;
  });

  // A property graph must have at least one NODE TABLE; an empty `NODE TABLES
  // ()` block is invalid DDL under any circumstance. When no entity can form a
  // node — the model declares none, or every one was skipped for an empty KEY —
  // fail loudly rather than emit a graph BigQuery would reject. The collected
  // skip reasons ride along in the error so the caller sees why each entity
  // dropped.
  if (!validEntities.length) {
    const reason = entities.length ?
        'every entity was skipped because it has no primary key (a graph node requires a KEY)' :
        'the model declares no entities';
    throw new Error(
        `cannot generate a property graph: ${reason}; a graph requires at ` +
        `least one NODE TABLE` +
        (warnings.length ? `\n${warnings.join('\n')}` : ''));
  }

  // Metrics are model-level; place each on the single entity its aggregate
  // references, lowering it to a MEASURE over an exposed property. Both maps
  // are keyed by entity name; entries on a skipped entity simply never render.
  const entityByName = new Map(entities.map(e => [e.name, e]));
  const metricsByEntity = new Map<string, string[]>();
  const loweringByEntity = new Map<string, MeasureLowering>();
  for (const metric of metrics) {
    placeMetric(
        metric, model, entityByName, skipped, metricsByEntity, loweringByEntity,
        warnings);
  }

  const nodeTables = validEntities.map(
      entity => renderNodeTable(
          entity, loweringByEntity.get(entity.name)?.derivedProperties ?? [],
          metricsByEntity.get(entity.name) ?? [], opts, warnings));

  const entitiesByName = new Map(validEntities.map(e => [e.name, e]));
  const edgeTables =
      relationships
          .filter(rel => {
            // An edge REFERENCES both endpoint nodes; if either was skipped the
            // edge cannot resolve, so drop it too.
            const dangling = [rel.source.entity, rel.destination.entity].filter(
                n => skipped.has(n));
            if (!dangling.length) return true;
            warnings.push(
                `relationship '${rel.name}': references skipped entity ` +
                `${dangling.map(n => `'${n}'`).join(', ')}; edge omitted`);
            return false;
          })
          .map(rel => renderEdgeTable(rel, entitiesByName, opts, warnings));

  const graphName = qualifyGraph(model, opts);

  const blocks: string[] = [
    `CREATE OR REPLACE PROPERTY GRAPH ${graphName}`,
    `NODE TABLES (\n${nodeTables.join(',\n')}\n)`,
  ];
  if (edgeTables.length) {
    blocks.push(`EDGE TABLES (\n${edgeTables.join(',\n')}\n)`);
  }

  // Model-level description / ai_context has no home in the BigQuery graph:
  // statement-level `OPTIONS` after EDGE TABLES parses but BigQuery silently
  // drops it (verified live; create_property_graph_options is off for
  // BigQuery), so we do not emit it. The model's description is carried into
  // Knowledge Catalog's model entry instead (see knowledge_catalog.ts);
  // element-level metadata rides on labels, properties, and measures here.

  return {ddl: blocks.join('\n') + ';\n', warnings: dedupe(warnings)};
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
  taken: Set<string>;           // property names already in use on the node
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
  const byLocalExpr = new Map<string, string>();
  for (const f of entity.fields) {
    taken.add(f.name);
    const expr = fieldExpression(f);
    if (expr === undefined) continue;
    const local = stripQualifier(expr, entity.name);
    if (!byLocalExpr.has(local)) byLocalExpr.set(local, f.name);
  }
  return {derivedProperties: [], taken, byLocalExpr, operandToName: new Map()};
}

// Assigns a metric to the node table of the single entity its aggregate
// references, lowering it to a MEASURE over an exposed property. Records a
// warning (and skips) when it references zero/multiple entities or is not a
// single supported aggregate over one operand.
function placeMetric(
    metric: Metric, model: SemanticModel, entityByName: Map<string, Entity>,
    skipped: Set<string>, metricsByEntity: Map<string, string[]>,
    loweringByEntity: Map<string, MeasureLowering>, warnings: string[]): void {
  // The IR keeps at most two expression forms; a measure is emitted from the
  // target/canonical `expression`, falling back to the imported vendor SQL when
  // that is all the model carries (a transpile pass may fill `expression`
  // later).
  const expression = metricExpression(metric);
  if (expression === undefined) {
    warnings.push(`metric '${
        metric
            .name}' has no expression; skipped (nothing to emit as a MEASURE)`);
    return;
  }

  let referenced = referencedEntities(expression, model);

  // A qualifier-free aggregate (e.g. COUNT(*)) names no entity in its
  // expression; fall back to the declared attach entity when the IR provides
  // one, so it can still be placed rather than dropped as "references no
  // entity". The loader DERIVES metric.entity from the expression's qualifiers,
  // so from a loaded model this never fires (no qualifier => no entity). It is
  // the hand-built-IR path: an author sets metric.entity for a COUNT(*) to
  // attach it (see the COUNT(*)-lowering tests).
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
  // A metric can only become a MEASURE on a node table, but an entity that was
  // skipped upstream (empty KEY) has no node table to carry it. Check the skip
  // set already computed, and report the drop directly, instead of letting it
  // fail later with a misleading "aggregate not supported" message.
  if (skipped.has(entityName)) {
    warnings.push(`metric '${metric.name}' targets entity '${
        entityName}', which has no KEY and was skipped; metric dropped`);
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
  const aggregate = `${agg.fn}(${agg.distinct ? 'DISTINCT ' : ''}${propName})`;

  const opts = optionsClause(
      elementDescription(metric.description, metric.aiContext),
      metric.aiContext?.synonyms);
  const measure = `MEASURE(${aggregate}) AS ${metric.name}`;
  const lines = metricsByEntity.get(entityName) ?? [];
  lines.push(opts ? `${measure} ${opts}` : measure);
  metricsByEntity.set(entityName, lines);
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

  let name: string;
  if (isSimpleIdentifier(operandExpr) && !lowering.taken.has(operandExpr)) {
    // A bare column not already declared: expose it under its own name.
    name = operandExpr;
    lowering.derivedProperties.push(name);
  } else {
    name = uniqueName(`${metricName}_input`, lowering.taken);
    lowering.derivedProperties.push(`${operandExpr} AS ${name}`);
  }
  lowering.taken.add(name);
  lowering.operandToName.set(operandExpr, name);
  return name;
}

// Extracts the function name and operand from a single-aggregate expression, or
// returns null when the body is not exactly one supported aggregate wrapping
// one operand (a non-aggregate, a compound like `SUM(x)/SUM(y)`, or a
// multi-argument call). `COUNT(DISTINCT x)` is recognized, yielding operand `x`
// with distinct.
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
  const dm = operand.match(/^DISTINCT\s+(.*)$/is);
  if (dm) {
    distinct = true;
    operand = dm[1].trim();
  }

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

function isSimpleIdentifier(s: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
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

// Returns the model entity names whose `<name>.` qualifier appears in an
// expression. String literals are ignored so a value like 'orders.x' is not
// mistaken for a reference to the `orders` entity.
function referencedEntities(
    expression: string, model: SemanticModel): string[] {
  return referencedEntityNames(
      expression, (model.entities ?? []).map(e => e.name));
}


function renderNodeTable(
    entity: Entity, derivedProperties: string[], measures: string[],
    opts: GenerateOptions, warnings: string[]): string {
  const table = qualifyTable(
      entity.dataSource, opts, warnings, `entity '${entity.name}'`);
  // Order: declared fields, then any operand properties synthesized for
  // measures, then the measures themselves (which reference those operand
  // properties).
  const properties = [
    ...entity.fields.map(f => renderFieldProperty(f, entity.name)),
    ...derivedProperties,
    ...measures,
  ];

  const lines = [
    line(1, `${table} AS ${entity.name}`),
    line(2, `KEY(${entity.keys.join(', ')})`),
  ];
  // Element-table description and synonyms attach to the DEFAULT LABEL: after
  // the key clause, before PROPERTIES (grammar: element_table_definition).
  const labelOpts = optionsClause(
      elementDescription(entity.description, entity.aiContext),
      entity.aiContext?.synonyms);
  if (labelOpts) lines.push(line(2, labelOpts));
  // Omit the PROPERTIES block when there is nothing to list, rather than emit
  // an empty `PROPERTIES()` (a node table may declare just its KEY).
  if (properties.length) lines.push(propertiesBlock(properties));
  return lines.join('\n');
}

// Renders a field as a graph property: a bare column when the expression is
// just the column, else `<expr> AS <name>`. Attaches metadata (label, temporal
// role, description, AI-first annotations) as trailing OPTIONS per the
// `derived_property` rule. A field with no expression is exposed as a bare
// column under its name.
function renderFieldProperty(field: Field, entity: string): string {
  const expr = fieldExpression(field);
  const local = expr !== undefined ? stripQualifier(expr, entity) : field.name;
  const prop = local === field.name ? field.name : `${local} AS ${field.name}`;
  const opts =
      optionsClause(fieldDescription(field), field.aiContext?.synonyms);
  return opts ? `${prop} ${opts}` : prop;
}


function renderEdgeTable(
    rel: Relationship, entitiesByName: Map<string, Entity>,
    opts: GenerateOptions, warnings: string[]): string {
  // A many-to-many relationship is backed by its own association table rather
  // than a source entity's foreign key; render it from that block.
  if (rel.association) {
    return renderAssociationEdge(
        rel, rel.association, entitiesByName, opts, warnings);
  }
  // A relationship is a direct foreign key: the SOURCE entity's own base table
  // backs the edge (one edge row per source row). Its FK columns
  // (`rel.source.columns`) reference the destination's key columns
  // (`rel.destination.columns`); the edge is keyed by, and references its
  // source node through, the source entity's own key (looked up here rather
  // than duplicated onto the relationship).
  const sourceEntity = entitiesByName.get(rel.source.entity);
  let backing: string;
  let sourceKey: string[];
  if (!sourceEntity) {
    warnings.push(`relationship '${rel.name}': unknown source entity '${
        rel.source.entity}'`);
    backing = `\`${rel.source.entity}\``;
    sourceKey = rel.source.columns;
  } else {
    backing = qualifyTable(
        sourceEntity.dataSource, opts, warnings, `relationship '${rel.name}'`);
    sourceKey = sourceEntity.keys;
  }

  const key = sourceKey.join(', ');
  const lines = [
    line(1, `${backing} AS ${rel.name}`),
    line(2, `KEY(${key})`),
    line(2, `SOURCE KEY(${key}) REFERENCES ${rel.source.entity}(${key})`),
    line(
        2,
        `DESTINATION KEY(${rel.source.columns.join(', ')}) REFERENCES ${
            rel.destination.entity}(${rel.destination.columns.join(', ')})`),
  ];

  // Edge description and synonyms attach to the DEFAULT LABEL: after the
  // SOURCE/DESTINATION clauses (grammar: element_table_definition).
  const labelOpts = optionsClause(
      elementDescription(rel.description, rel.aiContext),
      rel.aiContext?.synonyms);
  if (labelOpts) lines.push(line(2, labelOpts));

  return lines.join('\n');
}


// Renders a many-to-many edge backed by an association (junction) table. Unlike
// a direct FK, the edge has its OWN backing table and KEY, each endpoint's
// SOURCE/DESTINATION KEY names the junction columns referencing that entity's
// declared key, and the junction's own `fields` become edge PROPERTIES.
function renderAssociationEdge(
    rel: Relationship, assoc: Association, entitiesByName: Map<string, Entity>,
    opts: GenerateOptions, warnings: string[]): string {
  const backing = qualifyTable(
      assoc.dataSource, opts, warnings, `relationship '${rel.name}'`);
  if (!assoc.keys?.length) {
    warnings.push(
        `relationship '${rel.name}': association table has no KEY; the edge ` +
        `table will be invalid (an edge requires a KEY)`);
  }

  // The REFERENCES target is each endpoint entity's declared key; fall back to
  // the endpoint's own columns (and warn) when the entity cannot be resolved.
  const refColumns = (end: {entity: string; columns: string[]}): string => {
    const entity = entitiesByName.get(end.entity);
    if (!entity) {
      warnings.push(
          `relationship '${rel.name}': unknown entity '${end.entity}'`);
      return end.columns.join(', ');
    }
    return entity.keys.join(', ');
  };

  const lines = [
    line(1, `${backing} AS ${rel.name}`),
    line(2, `KEY(${assoc.keys.join(', ')})`),
    line(
        2,
        `SOURCE KEY(${assoc.sourceColumns.join(', ')}) REFERENCES ${
            rel.source.entity}(${refColumns(rel.source)})`),
    line(
        2,
        `DESTINATION KEY(${assoc.destinationColumns.join(', ')}) REFERENCES ${
            rel.destination.entity}(${refColumns(rel.destination)})`),
  ];

  // Edge description and synonyms attach to the DEFAULT LABEL: after the
  // SOURCE/DESTINATION clauses, before PROPERTIES (grammar:
  // element_table_definition).
  const labelOpts = optionsClause(
      elementDescription(rel.description, rel.aiContext),
      rel.aiContext?.synonyms);
  if (labelOpts) lines.push(line(2, labelOpts));

  // The junction's own non-key fields are the edge's properties.
  const properties =
      (assoc.fields ?? []).map(f => renderFieldProperty(f, rel.name));
  if (properties.length) lines.push(propertiesBlock(properties));

  return lines.join('\n');
}


// The target/canonical expression, falling back to the imported vendor SQL when
// that is all the IR carries (see the Field/Metric expression-fidelity
// contract).
function fieldExpression(f: Field): string|undefined {
  return f.expression ?? f.importedExpression;
}
function metricExpression(m: Metric): string|undefined {
  return m.expression ?? m.importedExpression;
}


// Builds a backtick-quoted table reference from the IR's `dataSource` string.
// The IR contract guarantees `dataSource` is already canonical and
// fully-qualified: the producer (loader) normalizes a bare name into a dotted
// `project.dataset.table` (or a longer Lakehouse catalog name). For BigQuery
// that canonical form IS the target addressing scheme, so this emits it
// verbatim and NEVER prepends the graph's own project/dataset -- those name
// where the graph is CREATED, not where a source table lives, and the two can
// differ (e.g. a graph in `proj.demo` over source tables in `samples.tpch`).
// Qualifying a source table is the producer's job, not the emitter's. A
// verbatim query (contains whitespace) cannot back a graph element table, so it
// is passed through parenthesized with a warning.
function qualifyTable(
    dataSource: string, _opts: GenerateOptions, warnings: string[],
    context: string): string {
  const trimmed = (dataSource ?? '').trim();
  if (!trimmed) {
    warnings.push(
        `${context}: empty data source; the table reference will be invalid`);
    return '``';
  }
  if (/\s/.test(trimmed)) {
    warnings.push(
        `${context}: data source '${
            trimmed}' looks like a query, not a table reference; ` +
        `emitting it verbatim (a graph element table requires a table)`);
    return `(${trimmed})`;
  }
  return `\`${trimmed}\``;
}

// Builds the dataset-qualified graph name, filling a missing project/dataset
// from opts and then from the first entity's qualified dataSource.
function qualifyGraph(model: SemanticModel, opts: GenerateOptions): string {
  const name = opts.graphName ?? model.name;
  let project = opts.project;
  let dataset = opts.dataset;

  const first = (model.entities ?? [])[0];
  if ((!project || !dataset) && first?.dataSource &&
      !/\s/.test(first.dataSource)) {
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


// All generated indentation flows through this single mechanism: one nesting
// level == one INDENT. `line` indents one line to a depth; `list` indents a set
// of lines and joins them comma-separated; `propertiesBlock` is the shared
// `PROPERTIES( ... )` shape used by both node and edge tables. Keeping every
// indent derived from `depth` (rather than hardcoded spaces) makes the output
// indentation consistent by construction.
const INDENT = '  ';
const pad = (depth: number): string => INDENT.repeat(depth);
const line = (depth: number, text: string): string => `${pad(depth)}${text}`;
const list = (depth: number, lines: string[]): string =>
    lines.map(l => line(depth, l)).join(',\n');

function propertiesBlock(properties: string[]): string {
  return `${line(2, 'PROPERTIES(')}\n${list(3, properties)}\n${line(2, ')')}`;
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

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
