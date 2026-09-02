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

import {AiContext, Association, Entity, Field, fieldBinding, isTimeDimension, Metric, Relationship, SemanticModel,} from './ir';
import {resolveInheritance} from './resolve_inheritance';
import {referencedEntityNames, stripQualifier} from './sql_expr_utils';
import {isSimpleIdentifier, quoteIfReserved} from './sql_identifiers';

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

  // Resolve entity-level inheritance (`extends`) before generating: this
  // flattens each subclass's inherited fields down and expands `extends` to the
  // full transitive ancestor set, so labels and property signatures can be read
  // straight off the resolved model. Only the BigQuery leg runs this; the KC
  // push consumes the raw model, so its output is unaffected.
  const resolved = resolveInheritance(model);
  warnings.push(...resolved.warnings);

  // The IR requires entities/relationships/metrics, but be defensive against a
  // hand-built or partially-deserialized model rather than throwing on `.map`.
  const entities = resolved.model.entities ?? [];
  const relationships = resolved.model.relationships ?? [];
  const metrics = resolved.model.metrics ?? [];

  // An abstract entity is conceptual: it has no physical table and produces no
  // NODE TABLE, surviving only as a LABEL on its concrete descendants (whose
  // node tables carry its flattened fields). Collect the abstract names so the
  // node-table filter drops them while label emission still sees them.
  const abstractNames =
      new Set(entities.filter(e => e.abstract).map(e => e.name));

  // A graph node table requires a non-empty KEY. An entity whose primary key is
  // empty cannot form a valid node, so skip it (and, below, any edge that
  // references it) rather than emit `KEY()` — invalid DDL. The loader already
  // warns about the missing key; this records the resulting structural drop.
  const skipped = new Set<string>();
  const validEntities = entities.filter(entity => {
    // An abstract entity is intentionally table-less: skip its node table (it
    // still contributes LABELs to descendants) without warning -- unlike a
    // missing KEY, this is by design, not a defect.
    if (abstractNames.has(entity.name)) {
      skipped.add(entity.name);
      return false;
    }
    if (entity.keys && entity.keys.length) return true;
    warnings.push(
        `entity '${
            entity.name}': empty KEY (no primary key); node table skipped, ` +
        `as a graph node requires a KEY`);
    skipped.add(entity.name);
    return false;
  });

  // An abstract class exists only to be a supertype; one that is no concrete
  // (valid) entity's ancestor produces no graph element at all, so warn and
  // drop it rather than let it vanish silently.
  const ancestorsUsed = new Set<string>();
  for (const entity of validEntities) {
    for (const a of entity.extends ?? []) ancestorsUsed.add(a);
  }
  for (const name of abstractNames) {
    if (!ancestorsUsed.has(name)) {
      warnings.push(
          `abstract entity '${name}' is not a supertype of any concrete ` +
          `entity; it has no table and no descendant to label, so it produces ` +
          `no graph element`);
    }
  }

  // A property graph must have at least one NODE TABLE; an empty `NODE TABLES
  // ()` block is invalid DDL under any circumstance. When no entity can form a
  // node — the model declares none, every one is abstract (a table-less
  // supertype forms no node), or every one was skipped for an empty KEY — fail
  // loudly rather than emit a graph BigQuery would reject. The collected skip
  // reasons ride along in the error so the caller sees why each entity dropped.
  if (!validEntities.length) {
    let reason: string;
    if (!entities.length) {
      reason = 'the model declares no entities';
    } else if (entities.every(e => e.abstract)) {
      reason =
          'every entity is abstract (a table-less supertype forms no node table)';
    } else {
      reason =
          'every entity was skipped because it has no primary key (a graph node requires a KEY)';
    }
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
        metric, resolved.model, entityByName, skipped, ancestorsUsed,
        metricsByEntity, loweringByEntity, warnings);
  }

  // A subclass's `LABEL <ancestor>` block lists that ancestor's own (flattened)
  // signature, so the label renderer must reach every LABEL CARRIER by name:
  // node-forming entities plus abstract (table-less) supertypes, which have no
  // node table but still contribute a label signature. A concrete entity
  // dropped for an empty KEY is deliberately excluded -- it was reported as a
  // structural defect, so it must not silently reappear as a shared label on a
  // subclass (which would contradict the drop and expose a half-defined class);
  // a subclass extending it drops that LABEL with a warning (see
  // renderNodeTable).
  const labelByName =
      new Map(entities.filter(e => e.abstract || !skipped.has(e.name))
                  .map(e => [e.name, e]));

  const nodeTables = validEntities.map(
      entity => renderNodeTable(
          entity, loweringByEntity.get(entity.name)?.derivedProperties ?? [],
          metricsByEntity.get(entity.name) ?? [], labelByName,
          ancestorsUsed.has(entity.name), opts, warnings));

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

  const graphName = qualifyGraph(resolved.model, opts);

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
    metric: Metric, model: SemanticModel, entityByName: Map<string, Entity>,
    skipped: Set<string>, ancestorsUsed: Set<string>,
    metricsByEntity: Map<string, string[]>,
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
  // A metric lowers to a MEASURE on the target entity's DEFAULT LABEL. When
  // that entity is a supertype, its label is shared with every subclass table,
  // and BigQuery forbids binding a MEASURE to a label carried by more than one
  // element table (a measure cannot be replicated across tables -- verified
  // live "defined as MEASURE, but there are other declarations with the same
  // name"). Drop it with a warning rather than emit DDL BigQuery rejects.
  if (ancestorsUsed.has(entityName)) {
    warnings.push(
        `metric '${metric.name}' targets entity '${entityName}', which is a ` +
        `supertype whose label is shared across subclass tables; skipped ` +
        `(BigQuery cannot bind a MEASURE to a shared label)`);
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
  const aggregate =
      `${agg.fn}(${agg.distinct ? 'DISTINCT ' : ''}${quoteIfReserved(propName)})`;

  const opts = optionsClause(
      elementDescription(metric.description, metric.aiContext),
      metric.aiContext?.synonyms);
  const measure = `MEASURE(${aggregate}) AS ${quoteIfReserved(metric.name)}`;
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
    labelByName: Map<string, Entity>, isSupertype: boolean,
    opts: GenerateOptions, warnings: string[]): string {
  const table = qualifyTable(
      entity.dataSource, opts, warnings, `entity '${entity.name}'`);

  // Canonical rendering of every inherited property: its supertype's OWN
  // definition, keyed by property name (nearest ancestor wins, matching field
  // flattening). A property that appears under a label shared across element
  // tables must have one identical definition everywhere it appears, so the
  // supertype is authoritative -- both this node's DEFAULT LABEL and its
  // `LABEL <ancestor>` blocks render an inherited property exactly as the
  // supertype's node table does. resolveInheritance localizes the inherited
  // copies on this entity, so in a well-formed hierarchy `renderOwn` below is a
  // no-op; the map's real job is to catch and neutralize a genuine override.
  const inheritedRender = new Map<string, string>();
  const inheritedCore = new Map<string, string>();
  for (const ancestorName of entity.extends ?? []) {
    const ancestor = labelByName.get(ancestorName);
    if (!ancestor) continue;
    for (const f of ancestor.fields) {
      if (!inheritedRender.has(f.name)) {
        inheritedRender.set(f.name, renderFieldProperty(f, ancestor.name));
        inheritedCore.set(f.name, renderFieldPropertyCore(f, ancestor.name));
      }
    }
  }
  // Renders one of this entity's own fields, deferring to the supertype's
  // canonical definition for any inherited name. A subclass CANNOT give an
  // inherited property a different definition -- BigQuery requires one
  // definition per property under a shared label -- so a divergent override is
  // warned and dropped in favor of the supertype's, keeping the DDL valid. The
  // warning distinguishes a STRUCTURAL remap (a different column/expression --
  // the property is genuinely rebound) from a METADATA-only refinement (same
  // column, different description/synonyms) so it states precisely what the
  // subclass loses, rather than mislabeling an added description as a redefined
  // column.
  const renderOwn = (f: Field): string => {
    const own = renderFieldProperty(f, entity.name);
    const canonical = inheritedRender.get(f.name);
    if (canonical === undefined) return own;  // not inherited: render as-is
    if (canonical === own) return canonical;  // identical: nothing to warn
    if (renderFieldPropertyCore(f, entity.name) !== inheritedCore.get(f.name)) {
      warnings.push(
          `entity '${entity.name}' remaps inherited property '${
              f.name}' to a different column/expression than its supertype; ` +
          `BigQuery allows only one definition per property under a shared ` +
          `label, so the supertype's is used and the subclass's remapping is ` +
          `dropped`);
    } else {
      warnings.push(
          `entity '${entity.name}' overrides the description/synonyms of ` +
          `inherited property '${
              f.name}'; under a shared label every binding ` +
          `must declare it identically, so the supertype's metadata is used ` +
          `and the subclass's is dropped`);
    }
    return canonical;
  };

  // Order: declared fields, then any operand properties synthesized for
  // measures, then the measures themselves (which reference those operand
  // properties).
  // Defense in depth: availability pruning normally strips every unbound field
  // (it has no column) before generation, and fieldBinding is the shared
  // "is bound" oracle both it and this generator consult so the two never
  // disagree. But a caller that generates DDL straight from a bindingOptional
  // load without pruning could still reach here with an unbound (e.g. purely
  // logical) field. Skip it with a warning rather than emit `<name>` as a
  // phantom bare column the source table does not have.
  const boundFields = entity.fields.filter(f => {
    if (fieldBinding(f) !== undefined) return true;
    warnings.push(
        `entity '${entity.name}': field '${f.name}' has no column under this ` +
        `binding; omitted from the node table (bind it, or govern the logical ` +
        `model in Knowledge Catalog instead)`);
    return false;
  });
  const properties = [
    ...boundFields.map(renderOwn),
    ...derivedProperties,
    ...measures,
  ];

  const lines = [
    line(1, `${table} AS ${quoteIfReserved(entity.name)}`),
    line(2, `KEY(${physicalColumns(entity, entity.keys, warnings, `entity '${entity.name}'`).join(', ')})`),
  ];
  // Element-table description and synonyms attach to the node's DEFAULT LABEL
  // -- UNLESS this entity is a supertype whose label is shared by subclass
  // tables. BigQuery forbids a label that carries an OPTIONS clause from being
  // bound to more than one element table (verified live -- "the label ... is
  // defined with OPTIONS clause in one of the element tables and cannot be
  // bound to another element table"), so a shared supertype label must be
  // options-free; its description/synonyms are dropped (with a warning).
  let labelOpts = optionsClause(
      elementDescription(entity.description, entity.aiContext),
      entity.aiContext?.synonyms);
  if (isSupertype && labelOpts) {
    warnings.push(
        `entity '${entity.name}' is a supertype in a class hierarchy; its ` +
        `description/synonyms are dropped from the shared '${entity.name}' ` +
        `label (BigQuery forbids OPTIONS on a label bound by multiple tables)`);
    labelOpts = undefined;
  }
  // A node participating in the hierarchy -- as a subclass (it declares
  // ancestor LABELs) or as a shared supertype (a subclass binds its label) --
  // must use an EXPLICIT `DEFAULT LABEL`: BigQuery rejects a bare (implicit
  // default) PROPERTIES clause immediately followed by explicit LABEL clauses
  // (verified live -- "Expected \")\" ... but got keyword LABEL"), and the
  // validated shared-label shape is `DEFAULT LABEL PROPERTIES(...)`. A node
  // outside any hierarchy keeps the implicit form so existing output is
  // byte-for-byte unchanged.
  const hasAncestors = !!(entity.extends && entity.extends.length);
  if (hasAncestors || isSupertype) lines.push(line(2, 'DEFAULT LABEL'));
  if (labelOpts) lines.push(line(2, labelOpts));
  // Omit the PROPERTIES block when there is nothing to list, rather than emit
  // an empty `PROPERTIES()` (a node table may declare just its KEY).
  if (properties.length) lines.push(propertiesBlock(properties));

  // Inheritance: declare one LABEL per transitive ancestor (resolveInheritance
  // expanded `extends` to the full ancestor set), each re-listing that
  // ancestor's properties so `MATCH (:Ancestor)` also matches this subclass
  // node. The block is rendered straight from the ANCESTOR's own fields with
  // the ancestor as qualifier, so it is byte-for-byte identical to the
  // ancestor's own DEFAULT LABEL -- the exact match BigQuery requires for a
  // property shared across the element tables that bind a label ("same set of
  // property declarations under the same label"). This node's DEFAULT LABEL
  // renders the same inherited names via `renderOwn`, which also defers to the
  // ancestor, so the label is consistent within this table too.
  for (const ancestorName of entity.extends ?? []) {
    const ancestor = labelByName.get(ancestorName);
    if (!ancestor) {
      // The ancestor exists in the model (resolveInheritance already dropped
      // unknown parents) but is not a label carrier -- it was dropped for an
      // empty KEY. Its fields still flattened onto this node (they render as
      // own properties above); it just forms no queryable label, so omit the
      // LABEL and say so rather than reference a class reported as gone.
      warnings.push(
          `entity '${entity.name}' extends '${ancestorName}', which has no ` +
          `node table and is not abstract (it was dropped, e.g. for an empty ` +
          `KEY); the '${ancestorName}' label is omitted from '${entity.name}'`);
      continue;
    }
    lines.push(line(2, `LABEL ${quoteIfReserved(ancestorName)}`));
    const signature =
        ancestor.fields.map(f => renderFieldProperty(f, ancestor.name));
    if (signature.length) lines.push(propertiesBlock(signature));
  }
  return lines.join('\n');
}

// Renders a field as a graph property: a bare column when the expression is
// just the column, else `<expr> AS <name>`. Attaches metadata (label, temporal
// role, description, AI-first annotations) as trailing OPTIONS per the
// `derived_property` rule. A field with no expression is exposed as a bare
// column under its name.
function renderFieldProperty(field: Field, entity: string): string {
  const core = renderFieldPropertyCore(field, entity);
  const opts =
      optionsClause(fieldDescription(field), field.aiContext?.synonyms);
  return opts ? `${core} ${opts}` : core;
}

// Renders just the STRUCTURAL core of a field property -- the bare column, or
// `<expr> AS <name>` when the field maps a non-trivial expression -- with no
// trailing OPTIONS. This is the part BigQuery requires to be byte-for-byte
// identical across every element table binding a shared label; metadata
// (OPTIONS) is compared separately so a subclass's metadata-only refinement is
// reported distinctly from a structural remap (see renderNodeTable's
// renderOwn). This is also the single place a field expression is lowered to
// its table-local form: the resolve-inheritance pass first rewrites an
// inherited field's expression into the child's frame (localizeInheritedField),
// then this strips the entity's own qualifier -- one normalization, in one
// place, applied to own and inherited fields alike.
function renderFieldPropertyCore(field: Field, entity: string): string {
  const expr = fieldExpression(field);
  const local = expr !== undefined ? stripQualifier(expr, entity) : field.name;
  const alias = quoteIfReserved(field.name);
  return local === field.name ? alias :
                                `${quoteIfReserved(local)} AS ${alias}`;
}


// Resolves a logical field name to the physical column it binds to on
// `entity`'s table. A structural key reference -- node KEY, edge KEY, SOURCE
// KEY, DESTINATION KEY, and each REFERENCES target -- must name a real column,
// never the property alias exposed under the field's name: BigQuery rejects an
// alias there ("Column '<alias>' not found"). A profile that binds a field to a
// differently named column makes name != column common. Falls back to the name
// itself when it is not a declared field (already a raw column) or the entity is
// unknown.
function physicalColumn(entity: Entity|undefined, fieldName: string): string {
  const field = entity?.fields.find(f => f.name === fieldName);
  if (entity === undefined || field === undefined) return fieldName;
  const expr = fieldExpression(field);
  return expr !== undefined ? stripQualifier(expr, entity.name) : fieldName;
}

function physicalColumns(
    entity: Entity|undefined, fieldNames: string[], warnings?: string[],
    ctx?: string): string[] {
  return fieldNames.map(n => {
    const col = physicalColumn(entity, n);
    // A structural site (KEY / SOURCE KEY / DESTINATION KEY / REFERENCES) must
    // name a bare column. A field bound to a computed expression resolves to
    // SQL, not a column, which BigQuery rejects at deploy; warn here so the
    // problem is named statically rather than surfacing as opaque DDL.
    if (warnings && !isSimpleIdentifier(col)) {
      warnings.push(
          `${ctx ?? `entity '${entity?.name ?? '?'}'`}: field '${n}' is bound ` +
          `to a non-column expression (${col}); a KEY/REFERENCES site requires ` +
          `a bare column, so BigQuery will reject the generated DDL`);
    }
    return quoteIfReserved(col);
  });
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
  const destEntity = entitiesByName.get(rel.destination.entity);
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

  // Every key clause names physical columns: the edge is the source entity's own
  // table, so its KEY / SOURCE KEY / the FK in DESTINATION KEY all resolve
  // against the source entity, while the destination REFERENCES resolves against
  // the destination entity's key.
  const relCtx = `relationship '${rel.name}'`;
  const key = physicalColumns(sourceEntity, sourceKey, warnings, relCtx).join(', ');
  const destFk =
      physicalColumns(sourceEntity, rel.source.columns, warnings, relCtx)
          .join(', ');
  const destRef =
      physicalColumns(destEntity, rel.destination.columns, warnings, relCtx)
          .join(', ');
  const lines = [
    line(1, `${backing} AS ${quoteIfReserved(rel.name)}`),
    line(2, `KEY(${key})`),
    line(
        2,
        `SOURCE KEY(${key}) REFERENCES ${quoteIfReserved(rel.source.entity)}(${
            key})`),
    line(
        2,
        `DESTINATION KEY(${destFk}) REFERENCES ${
            quoteIfReserved(rel.destination.entity)}(${destRef})`),
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
      return end.columns.map(quoteIfReserved).join(', ');
    }
    return physicalColumns(entity, entity.keys, warnings, `relationship '${rel.name}'`)
        .join(', ');
  };

  const lines = [
    line(1, `${backing} AS ${quoteIfReserved(rel.name)}`),
    line(2, `KEY(${assoc.keys.map(quoteIfReserved).join(', ')})`),
    line(
        2,
        `SOURCE KEY(${assoc.sourceColumns.map(quoteIfReserved).join(', ')}) ` +
            `REFERENCES ${quoteIfReserved(rel.source.entity)}(${
                refColumns(rel.source)})`),
    line(
        2,
        `DESTINATION KEY(${
            assoc.destinationColumns.map(quoteIfReserved).join(', ')}) ` +
            `REFERENCES ${quoteIfReserved(rel.destination.entity)}(${
                refColumns(rel.destination)})`),
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
  // Delegates to the canonical accessor so the generator's notion of "bound"
  // matches availability pruning's (an unbound field yields undefined; a field
  // awaiting transpilation stays bound via its imported expression).
  return fieldBinding(f);
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

  // Pick the first entity with a plain `project.dataset.table` source to derive
  // the graph's location; skip abstract entities (empty source) and query-based
  // sources (whitespace), which carry no usable location.
  const first = (model.entities ??
                 []).find(e => e.dataSource && !/\s/.test(e.dataSource));
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
