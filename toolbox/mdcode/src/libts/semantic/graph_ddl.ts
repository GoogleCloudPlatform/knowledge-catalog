// Generates GoogleSQL property-graph DDL from the Semantic Model IR, for any
// engine that takes the GoogleSQL `CREATE PROPERTY GRAPH` statement.
//
// The IR (./ir) is pure semantics. This module emits a single `CREATE OR
// REPLACE PROPERTY GRAPH` statement over the entities' existing base tables:
// node tables, edge tables, labels, properties, and key and join columns. Both
// BigQuery and Spanner take that same statement. A `GraphEngine` carries what
// differs between the engines:
//
//   1. Names. How a table and the graph itself are named (BigQuery writes
//      `project.dataset.table` and qualifies the graph name; a Spanner graph
//      lives in one database and names both bare).
//   2. Measures. Which metrics become properties (BigQuery lowers each to a
//      `MEASURE(...)`; Spanner Graph has none).
//   3. Element metadata. The per-element `OPTIONS` clause carrying
//      descriptions and synonyms (BigQuery has one; Spanner has none).
//   4. SQL text. Which SQL a field binds to: the engine's own dialect entry
//      (`BIGQUERY` or `SPANNER`), falling back to the `ANSI_SQL` one.
//
// ./bigquery supplies the BigQuery engine, and ./spanner the Spanner engine.
//

import {AiContext, Association, Entity, Field, isFieldBound, Metric, Relationship, SemanticModel, SqlDialect,} from './ir';
import {resolveInheritance} from './resolve_inheritance';
import {isColumnName, stripQualifier} from './sql_expr_utils';
import {quoteIdentifier, quoteIfReserved} from './sql_identifiers';

export interface GenerateResult {
  ddl: string;         // CREATE OR REPLACE PROPERTY GRAPH ...
  warnings: string[];  // skipped metrics, unresolved table refs, etc.
}

// What the generator knows about the graph when it hands the model's metrics
// to an engine's measure placement.
export interface MetricPlacementInput {
  // Every entity of the inheritance-resolved model, abstract and skipped too.
  entityByName: ReadonlyMap<string, Entity>;
  // Entities that form no node table (abstract, extended by another entity,
  // or no KEY).
  skipped: ReadonlySet<string>;
  // Entities another entity extends. None of them forms a node table.
  ancestorsUsed: ReadonlySet<string>;
}

// The engine's name, and the four ways the engines differ (see the header).
// Everything else about the graph is shared.
export interface GraphEngine {
  // The engine's name as warnings write it ("the BigQuery push ...").
  name: string;

  // 1. Names. `table` names an element table from its `dataSource`, or from
  // the entity's name when an edge's source entity is unknown; `graphName`
  // names the graph.
  table(dataSource: string, warnings: string[], context: string): string;
  graphName(model: SemanticModel): string;

  // 2. Measures. Places the model's metrics on node tables, keyed by entity
  // name, warning for each metric it skips. Each entry is the properties the
  // entity's node table lists after its fields: the operand properties the
  // measures aggregate, then the measures. An entity absent from the result
  // carries no measures.
  placeMetrics(
      metrics: Metric[], input: MetricPlacementInput,
      warnings: string[]): Map<string, string[]>;

  // 3. Element metadata. The trailing metadata clause for a label (from an
  // entity's or relationship's description and AI context) and for a field
  // property, or undefined when there is none to emit.
  elementOptions(description: string|undefined, ai: AiContext|undefined):
      string|undefined;
  fieldOptions(field: Field): string|undefined;

  // 4. SQL text. The engine's dialect, as warnings name it, and the SQL a field
  // binds to on this engine, or undefined when the engine has none for it.
  dialect: SqlDialect;
  fieldExpression(field: Field): string|undefined;
}

/**
 * Generates the property-graph DDL for a semantic model on one engine.
 *
 * The generated statement references the entities' existing base tables; it
 * does not create them. Returns the DDL plus any warnings collected while
 * mapping the IR (e.g. metrics that could not be placed on a single table).
 *
 * Only a concrete leaf, an entity that is not abstract and that no other entity
 * extends, forms a node table. Throws when the model yields no valid node table
 * -- it declares no entities, every entity is abstract or extended by another,
 * or every leaf lacks a KEY -- since a property graph with an empty NODE TABLES
 * block is invalid DDL that the engine would reject.
 */
export function generateGraphDdl(
    model: SemanticModel, engine: GraphEngine): GenerateResult {
  const warnings: string[] = [];

  // Resolve entity-level inheritance (`extends`) before generating: this
  // flattens each subclass's inherited fields down and expands `extends` to the
  // full transitive ancestor set, so labels and property signatures can be read
  // straight off the resolved model. Only the graph legs run this; the KC push
  // consumes the raw model, so its output is unaffected.
  const resolved = resolveInheritance(model);
  warnings.push(...resolved.warnings);

  // The IR requires entities/relationships/metrics, but be defensive against a
  // hand-built or partially-deserialized model rather than throwing on `.map`.
  const entities = resolved.model.entities ?? [];
  const relationships = resolved.model.relationships ?? [];
  const metrics = resolved.model.metrics ?? [];

  // Knowledge Catalog is the only system an action or a constraint reaches
  // (kc_actions.ts, kc_constraints.ts), so this leg emits nothing for either.
  // Warn once each, so an author who declared them learns where they go. A push
  // that leaves Knowledge Catalog out warns separately that they reach nothing
  // at all (see commands.ts).
  const actions = resolved.model.actions ?? [];
  if (actions.length) {
    warnings.push(
        `${actions.length} action(s) reach Knowledge Catalog only; the ` +
        `${engine.name} push deploys none of them.`);
  }
  const constraints = resolved.model.constraints ?? [];
  if (constraints.length) {
    warnings.push(
        `${constraints.length} constraint(s) reach Knowledge Catalog only; ` +
        `the ${engine.name} push deploys none of them.`);
  }

  // Only a concrete leaf forms a node table: an entity that is not abstract
  // and that no other entity extends. An abstract entity has no table. A
  // parent's label already reaches every row of its descendants' tables, so a
  // node table of its own would add its rows to that label as well. Either
  // kind survives only as a LABEL on its descendants' node tables, which carry
  // its flattened fields. resolveInheritance expanded each `extends` to the
  // full ancestor set, so the parents are exactly the names some `extends`
  // lists.
  const abstractNames =
      new Set(entities.filter(e => e.abstract).map(e => e.name));
  const parentNames = new Set(entities.flatMap(e => e.extends ?? []));

  // A graph node table requires a non-empty KEY: the entity's primary key, else
  // its first unique key (nodeKey). An entity with neither cannot form a valid
  // node, so skip it (and, below, any edge that references it) rather than emit
  // `KEY()` — invalid DDL. The loader already warns about the missing key; this
  // records the resulting structural drop.
  const skipped = new Set<string>();
  const validEntities = entities.filter(entity => {
    // An abstract entity or a parent has no node table by design, not for a
    // defect, so skip it without a warning. A parent needs no KEY.
    if (abstractNames.has(entity.name) || parentNames.has(entity.name)) {
      skipped.add(entity.name);
      return false;
    }
    if (nodeKey(entity).length) return true;
    warnings.push(
        `entity '${
            entity.name}': empty KEY (no primary key); node table skipped, ` +
        `as a graph node requires a KEY`);
    skipped.add(entity.name);
    return false;
  });

  // The ancestors some node table carries as labels. An abstract entity or a
  // parent that none of them carries produces no graph element at all, so warn
  // rather than let it vanish silently: its only descendants are abstract or
  // were skipped for an empty KEY.
  const labelled = new Set(validEntities.flatMap(e => e.extends ?? []));
  for (const {name} of entities) {
    if (labelled.has(name)) continue;
    if (abstractNames.has(name)) {
      warnings.push(
          `abstract entity '${name}' is not a supertype of any concrete ` +
          `entity; it has no table and no descendant to label, so it produces ` +
          `no graph element`);
    } else if (parentNames.has(name)) {
      warnings.push(
          `entity '${name}' is extended by another entity, so it has no node ` +
          `table, and no entity with a node table extends it, so it produces ` +
          `no graph element`);
    }
  }

  // A property graph must have at least one NODE TABLE; an empty `NODE TABLES
  // ()` block is invalid DDL under any circumstance. When no entity can form a
  // node — the model declares none, every one is abstract or extended by
  // another (neither forms a node), or every leaf was skipped for an empty KEY
  // — fail loudly rather than emit a graph the engine would reject. The
  // collected skip reasons ride along in the error so the caller sees why each
  // entity dropped.
  if (!validEntities.length) {
    let reason: string;
    if (!entities.length) {
      reason = 'the model declares no entities';
    } else if (entities.every(e => e.abstract)) {
      reason =
          'every entity is abstract (a table-less supertype forms no node table)';
    } else if (entities.every(
                   e => abstractNames.has(e.name) || parentNames.has(e.name))) {
      reason = 'every entity is abstract or extended by another entity (only ' +
          'a concrete leaf forms a node table)';
    } else {
      reason = `every ${parentNames.size ? 'concrete leaf ' : ''}entity was ` +
          'skipped because it has no primary key (a graph node requires a KEY)';
    }
    throw new Error(
        `cannot generate a property graph: ${reason}; a graph requires at ` +
        `least one NODE TABLE` +
        (warnings.length ? `\n${warnings.join('\n')}` : ''));
  }

  // Metrics are model-level; the engine places each on a node table (or skips
  // it). The result is keyed by entity name; entries on a skipped entity simply
  // never render.
  const entityByName = new Map(entities.map(e => [e.name, e]));
  const measurePropertiesByEntity = engine.placeMetrics(
      metrics, {entityByName, skipped, ancestorsUsed: parentNames}, warnings);

  // The properties under each ancestor's label: of the fields the ancestor
  // declares or inherits, those that every node table below it binds with SQL
  // for this engine. Every table that carries a label must declare the same
  // properties under it, by name and type, so a field that one leaf leaves out
  // (its profile excludes it, or this engine has no SQL for it) is left out of
  // that label on every leaf, while each leaf's DEFAULT LABEL keeps all it
  // binds. Each leaf reads the properties from its own binding: the engines
  // match a shared label by property name and type, not by column. The type
  // comes from the field's datatype, which the ancestor defines, so the leaves
  // agree on it.
  const ancestorProperties = new Map<string, string[]>();
  for (const name of labelled) {
    const leaves = validEntities.filter(e => e.extends?.includes(name));
    ancestorProperties.set(
        name,
        declaredOrInherited(name, model, entityByName)
            .filter(
                field => leaves.every(
                    leaf => leaf.fields.some(
                        f => f.name === field &&
                            engine.fieldExpression(f) !== undefined))));
  }

  const nodeTables = validEntities.map(
      entity => renderNodeTable(
          entity, measurePropertiesByEntity.get(entity.name) ?? [],
          ancestorProperties, engine, warnings));

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
          .map(rel => renderEdgeTable(rel, entitiesByName, engine, warnings));

  const graphName = engine.graphName(resolved.model);

  const blocks: string[] = [
    `CREATE OR REPLACE PROPERTY GRAPH ${graphName}`,
    `NODE TABLES (\n${nodeTables.join(',\n')}\n)`,
  ];
  if (edgeTables.length) {
    blocks.push(`EDGE TABLES (\n${edgeTables.join(',\n')}\n)`);
  }

  // The model's own description and AI context go to Knowledge Catalog's model
  // entry (see knowledge_catalog.ts), not the graph; bigquery.ts's
  // optionsClause says why.

  return {ddl: blocks.join('\n') + ';\n', warnings: dedupe(warnings)};
}

// The names of the fields entity `name` declares or inherits: its own, then
// each ancestor's, nearest first, as resolveInheritance orders them. They are
// read from the model as declared, before resolution, because resolution
// leaves off the fields a profile excludes on the entity itself, and an
// exclusion on an entity with no node table excludes nothing from the graph.
function declaredOrInherited(
    name: string, declared: SemanticModel,
    resolvedByName: ReadonlyMap<string, Entity>): string[] {
  const own = new Map((declared.entities ?? []).map(e => [e.name, e.fields]));
  const names = new Set<string>();
  for (const e of [name, ...(resolvedByName.get(name)?.extends ?? [])]) {
    for (const f of own.get(e) ?? []) names.add(f.name);
  }
  return [...names];
}


function renderNodeTable(
    entity: Entity, measureProperties: string[],
    ancestorProperties: Map<string, string[]>, engine: GraphEngine,
    warnings: string[]): string {
  const table =
      engine.table(entity.dataSource, warnings, `entity '${entity.name}'`);

  // Order: declared fields, then the engine's measure properties (any operand
  // properties synthesized for measures, then the measures themselves, which
  // reference those operand properties).
  // A field is kept when the engine has SQL for it. That is narrower than
  // isFieldBound, which availability pruning tests: a field bound only by
  // another engine's SQL is bound, yet this engine has nothing to emit for it.
  // Skip such a field with a warning naming the engine's dialect rather than
  // emit that other engine's SQL. A field with no SQL at all is unbound;
  // pruning normally strips it before generation, but a caller that generates
  // DDL straight from a bindingOptional load without pruning could still reach
  // here with one, such as a purely logical field. Skip it too rather than emit
  // `<name>` as a phantom bare column the source table does not have.
  const boundFields = entity.fields.filter(f => {
    if (engine.fieldExpression(f) !== undefined) return true;
    warnings.push(
        isFieldBound(f) ?
            `entity '${entity.name}': field '${f.name}' has no '${
                engine.dialect}' or 'ANSI_SQL' expression; omitted from the ` +
                `node table` :
            `entity '${entity.name}': field '${f.name}' has no column under ` +
                `this binding; omitted from the node table (bind it, or ` +
                `govern the logical model in Knowledge Catalog instead)`);
    return false;
  });
  // Each field renders from this entity's own binding, keyed by name, and the
  // DEFAULT LABEL and every `LABEL <ancestor>` block read that one rendering. A
  // field this entity restates reads its own column; one it does not restate
  // carries the binding of the nearest ancestor that gives one, which
  // resolveInheritance localized to this table.
  const rendered = new Map(
      boundFields.map(f => [f.name, renderFieldProperty(f, entity.name, engine)]));
  const properties = [...rendered.values(), ...measureProperties];

  const lines = [
    line(1, `${table} AS ${quoteIfReserved(entity.name)}`),
    line(
        2,
        `KEY(${
            physicalColumns(
                nodeKey(entity), engine, warnings, `entity '${entity.name}'`)
                .join(', ')})`),
  ];
  // A node that declares ancestor LABELs must use an EXPLICIT `DEFAULT LABEL`:
  // BigQuery rejects a bare (implicit default) PROPERTIES clause immediately
  // followed by explicit LABEL clauses (verified live -- "Expected \")\" ...
  // but got keyword LABEL"), and the validated shared-label shape is `DEFAULT
  // LABEL PROPERTIES(...)`. A node outside any hierarchy keeps the implicit
  // form. Only a leaf has a node table, so no other table shares this node's
  // own label, and its description and synonyms stay on it.
  if (entity.extends?.length) lines.push(line(2, 'DEFAULT LABEL'));
  const labelOpts = engine.elementOptions(entity.description, entity.aiContext);
  if (labelOpts) lines.push(line(2, labelOpts));
  lines.push(...propertiesClause(
      properties, entity.fields.some(f => hasOnlyOtherEnginesSql(f, engine))));

  // Inheritance: declare one LABEL per transitive ancestor (resolveInheritance
  // expanded `extends` to the full ancestor set), so `MATCH (:Ancestor)` also
  // matches this node. Each lists the properties every leaf under that
  // ancestor binds (see generateGraphDdl), read from this table's renderings.
  // When the leaves share none, the label lists NO PROPERTIES, since a label
  // with no properties clause exposes every column of its table.
  for (const ancestorName of entity.extends ?? []) {
    lines.push(line(2, `LABEL ${quoteIfReserved(ancestorName)}`));
    const signature = (ancestorProperties.get(ancestorName) ?? [])
                          .map(name => rendered.get(name)!);
    lines.push(...propertiesClause(signature, true));
  }
  return lines.join('\n');
}

// The properties clause of a table or label. When `anyLeftOut` is set, an
// empty list gives NO PROPERTIES, since a missing clause exposes every column.
function propertiesClause(
    properties: string[], anyLeftOut: boolean): string[] {
  if (properties.length) return [propertiesBlock(properties)];
  return anyLeftOut ? [line(2, 'NO PROPERTIES')] : [];
}

// Whether a field has SQL, but none the engine reads.
function hasOnlyOtherEnginesSql(field: Field, engine: GraphEngine): boolean {
  return isFieldBound(field) && engine.fieldExpression(field) === undefined;
}

// Renders a field as a graph property: a bare column when the expression is
// just the column, else `<expr> AS <name>`. Attaches the engine's metadata
// clause (label, temporal role, description, AI-first annotations) after it
// per the `derived_property` rule. A field with no expression is exposed as a
// bare column under its name.
function renderFieldProperty(
    field: Field, entity: string, engine: GraphEngine): string {
  const core = renderFieldPropertyCore(field, entity, engine);
  const opts = engine.fieldOptions(field);
  return opts ? `${core} ${opts}` : core;
}

// Renders just the STRUCTURAL core of a field property -- the bare column, or
// `<expr> AS <name>` when the field maps a non-trivial expression -- with no
// trailing OPTIONS. This is the single place a field expression is lowered to
// its table-local form: the resolve-inheritance pass first rewrites an
// inherited field's expression into the child's frame (localizeInheritedField),
// then this strips the entity's own qualifier -- one normalization, in one
// place, applied to own and inherited fields alike.
function renderFieldPropertyCore(
    field: Field, entity: string, engine: GraphEngine): string {
  const expr = engine.fieldExpression(field);
  const local = expr !== undefined ? stripQualifier(expr, entity) : field.name;
  const alias = quoteIfReserved(field.name);
  return local === field.name ? alias :
                                `${quoteIfReserved(local)} AS ${alias}`;
}


// The key an entity's node is keyed by: its primary key, else its first
// non-empty unique key. Empty when the entity states neither, and then it gets
// no node table.
export function nodeKey(entity: Pick<Entity, 'keys'|'uniqueKeys'>): string[] {
  if (entity.keys?.length) return entity.keys;
  return entity.uniqueKeys?.find(k => k.length > 0) ?? [];
}

// Writes a key or join column as the column it names. An unquoted name is
// backtick-quoted when it is reserved or is not a simple identifier, and a
// backtick-quoted name is written as it is.
export function physicalColumn(column: string): string {
  return /^`[^`]+`$/.test(column) ? column : quoteIdentifier(column);
}

// Writes each key or join column with physicalColumn. A value isColumnName
// rejects is an expression rather than a column; push rejects it, and a caller
// that generates without validating gets it as written, with a warning naming
// it, rather than opaque DDL the engine rejects at deploy.
function physicalColumns(
    columns: string[], engine: GraphEngine, warnings: string[],
    context: string): string[] {
  return columns.map(c => {
    if (isColumnName(c)) return physicalColumn(c);
    warnings.push(
        `${context}: key or join column '${c}' is not a physical column ` +
        `name; a KEY/REFERENCES site requires a column, so ${
            engine.name} will reject the generated DDL`);
    return c;
  });
}


function renderEdgeTable(
    rel: Relationship, entitiesByName: Map<string, Entity>,
    engine: GraphEngine, warnings: string[]): string {
  // A many-to-many relationship is backed by its own association table rather
  // than a source entity's foreign key; render it from that block.
  if (rel.association) {
    return renderAssociationEdge(
        rel, rel.association, entitiesByName, engine, warnings);
  }
  // A relationship is a direct foreign key: the SOURCE entity's own base table
  // backs the edge (one edge row per source row). Its FK columns
  // (`rel.source.columns`) reference the destination's key columns
  // (`rel.destination.columns`); the edge is keyed by, and references its
  // source node through, the key of the source entity's node (nodeKey, looked up
  // here rather than duplicated onto the relationship).
  const sourceEntity = entitiesByName.get(rel.source.entity);
  const relCtx = `relationship '${rel.name}'`;
  let backing: string;
  let sourceKey: string[];
  if (!sourceEntity) {
    // Only hand-built IR gets here: the loader rejects a relationship whose
    // endpoint is not one of the model's entities. Name the table after the
    // entity.
    warnings.push(`relationship '${rel.name}': unknown source entity '${
        rel.source.entity}'`);
    backing = engine.table(rel.source.entity, warnings, relCtx);
    sourceKey = rel.source.columns;
  } else {
    backing = engine.table(sourceEntity.dataSource, warnings, relCtx);
    sourceKey = nodeKey(sourceEntity);
  }

  // Every key clause names physical columns: the edge is the source entity's own
  // table, so its KEY and SOURCE KEY are the source node's key, and its
  // DESTINATION KEY is the FK, the relationship's `from_columns`, referencing
  // the destination's `to_columns`.
  const key = physicalColumns(sourceKey, engine, warnings, relCtx).join(', ');
  const destFk =
      physicalColumns(rel.source.columns, engine, warnings, relCtx).join(', ');
  const destRef =
      physicalColumns(rel.destination.columns, engine, warnings, relCtx)
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
  const labelOpts = engine.elementOptions(rel.description, rel.aiContext);
  if (labelOpts) lines.push(line(2, labelOpts));

  return lines.join('\n');
}


// Renders a many-to-many edge backed by an association (junction) table. Unlike
// a direct FK, the edge has its OWN backing table and KEY, each endpoint's
// SOURCE/DESTINATION KEY names the junction columns referencing the key of
// that entity's node, and the junction's own `fields` become edge PROPERTIES.
function renderAssociationEdge(
    rel: Relationship, assoc: Association, entitiesByName: Map<string, Entity>,
    engine: GraphEngine, warnings: string[]): string {
  const relCtx = `relationship '${rel.name}'`;
  const backing = engine.table(assoc.dataSource, warnings, relCtx);
  if (!assoc.keys?.length) {
    warnings.push(
        `relationship '${rel.name}': association table has no KEY; the edge ` +
        `table will be invalid (an edge requires a KEY)`);
  }

  // The REFERENCES target is the key of each endpoint's node; fall back to
  // the endpoint's own columns (and warn) when the entity cannot be resolved.
  const refColumns = (end: {entity: string; columns: string[]}): string => {
    const entity = entitiesByName.get(end.entity);
    if (!entity) {
      warnings.push(
          `relationship '${rel.name}': unknown entity '${end.entity}'`);
    }
    return physicalColumns(
               entity ? nodeKey(entity) : end.columns, engine, warnings, relCtx)
        .join(', ');
  };
  // The junction table's own key and join columns.
  const columns = (names: string[]): string =>
      physicalColumns(names, engine, warnings, relCtx).join(', ');

  const lines = [
    line(1, `${backing} AS ${quoteIfReserved(rel.name)}`),
    line(2, `KEY(${columns(assoc.keys)})`),
    line(
        2,
        `SOURCE KEY(${columns(assoc.sourceColumns)}) ` +
            `REFERENCES ${quoteIfReserved(rel.source.entity)}(${
                refColumns(rel.source)})`),
    line(
        2,
        `DESTINATION KEY(${columns(assoc.destinationColumns)}) ` +
            `REFERENCES ${quoteIfReserved(rel.destination.entity)}(${
                refColumns(rel.destination)})`),
  ];

  // Edge description and synonyms attach to the DEFAULT LABEL: after the
  // SOURCE/DESTINATION clauses, before PROPERTIES (grammar:
  // element_table_definition).
  const labelOpts = engine.elementOptions(rel.description, rel.aiContext);
  if (labelOpts) lines.push(line(2, labelOpts));

  // The junction's own non-key fields are the edge's properties.
  const properties =
      (assoc.fields ?? [])
          .filter(f => {
            if (engine.fieldExpression(f) !== undefined || !isFieldBound(f)) {
              return true;
            }
            warnings.push(
                `relationship '${rel.name}': field '${f.name}' has no '${
                    engine.dialect}' or 'ANSI_SQL' expression; omitted from ` +
                `the edge table`);
            return false;
          })
          .map(f => renderFieldProperty(f, rel.name, engine));
  lines.push(...propertiesClause(
      properties,
      (assoc.fields ?? []).some(f => hasOnlyOtherEnginesSql(f, engine))));

  return lines.join('\n');
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

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
