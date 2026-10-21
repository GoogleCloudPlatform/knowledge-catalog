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
// ./bigquery supplies the BigQuery engine; spanner.ts still writes its own
// graph.
//

import {AiContext, Association, Entity, Field, isFieldBound, Metric, Relationship, SemanticModel, SqlDialect,} from './ir';
import {resolveInheritance} from './resolve_inheritance';
import {fieldBindingWithoutComments, stripQualifier} from './sql_expr_utils';
import {isSimpleIdentifier, quoteIfReserved} from './sql_identifiers';

export interface GenerateResult {
  ddl: string;         // CREATE OR REPLACE PROPERTY GRAPH ...
  warnings: string[];  // skipped metrics, unresolved table refs, etc.
}

// What the generator knows about the graph when it hands the model's metrics
// to an engine's measure placement.
export interface MetricPlacementInput {
  // Every entity of the inheritance-resolved model, abstract and skipped too.
  entityByName: ReadonlyMap<string, Entity>;
  // Entities that form no node table (abstract, no KEY).
  skipped: ReadonlySet<string>;
  // Entities some node-forming entity extends.
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
 * Throws when the model yields no valid node table -- it declares no entities,
 * or every entity lacks a KEY -- since a property graph with an empty NODE
 * TABLES block is invalid DDL that the engine would reject.
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

  // The ancestors carried by a table-emitting entity. Two uses. First, measure
  // placement: an engine's measure may be allowed only on a LEAF type -- one
  // that no *table-emitting* entity extends (see the BigQuery engine).
  // Building this from validEntities (not all entities) is deliberate: an
  // abstract or empty-KEY subtype emits no table, so it does not duplicate its
  // parent's label and must not mark the parent non-leaf. Second, the orphan
  // check below: an abstract class that is no concrete entity's ancestor
  // produces no graph element at all, so warn and drop it rather than let it
  // vanish silently.
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
  // loudly rather than emit a graph the engine would reject. The collected skip
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

  // Metrics are model-level; the engine places each on a node table (or skips
  // it). The result is keyed by entity name; entries on a skipped entity simply
  // never render.
  const entityByName = new Map(entities.map(e => [e.name, e]));
  const measurePropertiesByEntity = engine.placeMetrics(
      metrics, {entityByName, skipped, ancestorsUsed}, warnings);

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

  // A field one node table leaves out because this engine has no SQL for it
  // is left out of each abstract ancestor's label on every table too, so the
  // label lists the same properties everywhere it appears.
  const leftOutUnder = new Map<string, Set<string>>();
  for (const e of validEntities) {
    for (const f of e.fields) {
      if (!isFieldBound(f) || engine.fieldExpression(f) !== undefined) continue;
      for (const a of e.extends ?? []) {
        leftOutUnder.set(a, (leftOutUnder.get(a) ?? new Set()).add(f.name));
      }
    }
  }

  const nodeTables = validEntities.map(
      entity => renderNodeTable(
          entity, measurePropertiesByEntity.get(entity.name) ?? [],
          labelByName, leftOutUnder, ancestorsUsed.has(entity.name), engine,
          warnings));

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


function renderNodeTable(
    entity: Entity, measureProperties: string[],
    labelByName: Map<string, Entity>,
    leftOutUnder: Map<string, Set<string>>, isSupertype: boolean,
    engine: GraphEngine, warnings: string[]): string {
  const table =
      engine.table(entity.dataSource, warnings, `entity '${entity.name}'`);

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
    // Skip an ABSTRACT ancestor: it has no table and no binding of its own, so
    // it cannot be authoritative for an inherited property's rendering. This
    // subtype's own binding is the canonical one (e.g. `c_name AS name`), so we
    // leave the inherited names out of this map and let `renderOwn` render them
    // straight from this table. A concrete ancestor keeps its authority.
    if (!ancestor || ancestor.abstract) continue;
    for (const f of ancestor.fields) {
      // The ancestor's node table leaves out a field this engine has no SQL
      // for, so there is no rendering to defer to.
      if (engine.fieldExpression(f) === undefined) continue;
      if (!inheritedRender.has(f.name)) {
        inheritedRender.set(
            f.name, renderFieldProperty(f, ancestor.name, engine));
        inheritedCore.set(
            f.name, renderFieldPropertyCore(f, ancestor.name, engine));
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
    const own = renderFieldProperty(f, entity.name, engine);
    const canonical = inheritedRender.get(f.name);
    if (canonical === undefined) return own;  // not inherited: render as-is
    if (canonical === own) return canonical;  // identical: nothing to warn
    if (renderFieldPropertyCore(f, entity.name, engine) !==
        inheritedCore.get(f.name)) {
      warnings.push(
          `entity '${entity.name}' remaps inherited property '${
              f.name}' to a different column/expression than its supertype; ` +
          `${engine.name} allows only one definition per property under a ` +
          `shared label, so the supertype's is used and the subclass's ` +
          `remapping is dropped`);
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
                (inheritedRender.has(f.name) ?
                     `node table's own label, and the supertype's label keeps ` +
                         `the supertype's definition` :
                     `node table`) :
            `entity '${entity.name}': field '${f.name}' has no column under ` +
                `this binding; omitted from the node table (bind it, or ` +
                `govern the logical model in Knowledge Catalog instead)`);
    return false;
  });
  const properties = [...boundFields.map(renderOwn), ...measureProperties];

  const lines = [
    line(1, `${table} AS ${quoteIfReserved(entity.name)}`),
    line(
        2,
        `KEY(${
            physicalColumns(
                entity, entity.keys, engine, warnings,
                `entity '${entity.name}'`)
                .join(', ')})`),
  ];
  // Element-table description and synonyms attach to the node's DEFAULT LABEL
  // -- UNLESS this entity is a supertype whose label is shared by subclass
  // tables. BigQuery forbids a label that carries an OPTIONS clause from being
  // bound to more than one element table (verified live -- "the label ... is
  // defined with OPTIONS clause in one of the element tables and cannot be
  // bound to another element table"), so a shared supertype label must be
  // options-free; its description/synonyms are dropped (with a warning). The
  // rule is BigQuery's, but it applies to any engine whose elementOptions
  // returns a clause.
  let labelOpts = engine.elementOptions(entity.description, entity.aiContext);
  if (isSupertype && labelOpts) {
    warnings.push(
        `entity '${entity.name}' is a supertype in a class hierarchy; its ` +
        `description/synonyms are dropped from the shared '${entity.name}' ` +
        `label (${
            engine.name} forbids OPTIONS on a label bound by multiple tables)`);
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
      // The ancestor exists in the model (an unknown parent hard-fails in
      // resolveInheritance, so it never reaches here) but is not a label
      // carrier -- it was dropped for an
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
    let signature: string[];
    if (ancestor.abstract) {
      // Render each inherited field from THIS subtype's own binding, keyed by
      // the abstract ancestor's field names. Skip any the subtype leaves
      // unbound so the block matches the DEFAULT LABEL (which lists only bound
      // fields); a profile that binds the subtype but not an inherited field
      // simply does not expose that property under the shared label.
      signature = [];
      let leftOut = false;
      for (const af of ancestor.fields) {
        if (leftOutUnder.get(ancestorName)?.has(af.name)) {
          leftOut = true;
          continue;
        }
        const child = boundFields.find(cf => cf.name === af.name);
        if (child) {
          signature.push(renderFieldProperty(child, entity.name, engine));
        }
      }
      // A bare LABEL exposes every column of its table, so a label that a
      // left-out field empties lists no properties instead.
      if (!signature.length && leftOut) {
        lines.push(line(2, 'NO PROPERTIES'));
        continue;
      }
    } else {
      // Only the fields the ancestor's own node table lists.
      signature =
          ancestor.fields.filter(f => engine.fieldExpression(f) !== undefined)
              .map(f => renderFieldProperty(f, ancestor.name, engine));
    }
    if (signature.length) lines.push(propertiesBlock(signature));
  }
  return lines.join('\n');
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
// trailing OPTIONS. This is the part BigQuery requires to be byte-for-byte
// identical across every element table binding a shared label; metadata
// (OPTIONS) is compared separately so a subclass's metadata-only refinement is
// reported distinctly from a structural remap (see renderNodeTable's
// renderOwn). This is also the single place a field expression is lowered to
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


// Resolves a logical field name to the physical column it binds to on
// `entity`'s table. A structural key reference -- node KEY, edge KEY, SOURCE
// KEY, DESTINATION KEY, and each REFERENCES target -- must name a real column,
// never the property alias exposed under the field's name: BigQuery rejects an
// alias there ("Column '<alias>' not found"). A profile that binds a field to a
// differently named column makes name != column common. Falls back to the name
// itself when it is not a declared field (already a raw column) or the entity is
// unknown.
function physicalColumn(
    entity: Entity|undefined, fieldName: string, engine: GraphEngine): string {
  const field = entity?.fields.find(f => f.name === fieldName);
  if (entity === undefined || field === undefined) return fieldName;
  // A key or join column names a column, and a bare column name reads the same
  // in every dialect, so a field with no SQL for this engine still gives it.
  const expr =
      engine.fieldExpression(field) ?? fieldBindingWithoutComments(field);
  return expr !== undefined ? stripQualifier(expr, entity.name) : fieldName;
}

function physicalColumns(
    entity: Entity|undefined, fieldNames: string[], engine: GraphEngine,
    warnings: string[], context: string): string[] {
  return fieldNames.map(n => {
    const col = physicalColumn(entity, n, engine);
    // A structural site (KEY / SOURCE KEY / DESTINATION KEY / REFERENCES) must
    // name a bare column. A field bound to a computed expression resolves to
    // SQL, not a column, which the engine rejects at deploy; warn here so the
    // problem is named statically rather than surfacing as opaque DDL.
    if (!isSimpleIdentifier(col)) {
      warnings.push(
          `${context}: field '${n}' is bound to a non-column expression (${
              col}); a KEY/REFERENCES site requires a bare column, so ${
              engine.name} will reject the generated DDL`);
    }
    return quoteIfReserved(col);
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
  // source node through, the source entity's own key (looked up here rather
  // than duplicated onto the relationship).
  const sourceEntity = entitiesByName.get(rel.source.entity);
  const destEntity = entitiesByName.get(rel.destination.entity);
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
    sourceKey = sourceEntity.keys;
  }

  // Every key clause names physical columns: the edge is the source entity's own
  // table, so its KEY / SOURCE KEY / the FK in DESTINATION KEY all resolve
  // against the source entity, while the destination REFERENCES resolves against
  // the destination entity's key.
  const key = physicalColumns(sourceEntity, sourceKey, engine, warnings, relCtx)
                  .join(', ');
  const destFk = physicalColumns(
                     sourceEntity, rel.source.columns, engine, warnings, relCtx)
                     .join(', ');
  const destRef =
      physicalColumns(
          destEntity, rel.destination.columns, engine, warnings, relCtx)
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
// SOURCE/DESTINATION KEY names the junction columns referencing that entity's
// declared key, and the junction's own `fields` become edge PROPERTIES.
function renderAssociationEdge(
    rel: Relationship, assoc: Association, entitiesByName: Map<string, Entity>,
    engine: GraphEngine, warnings: string[]): string {
  const backing = engine.table(
      assoc.dataSource, warnings, `relationship '${rel.name}'`);
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
    return physicalColumns(
               entity, entity.keys, engine, warnings,
               `relationship '${rel.name}'`)
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
  if (properties.length) lines.push(propertiesBlock(properties));

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
