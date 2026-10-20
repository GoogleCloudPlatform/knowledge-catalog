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
//   4. SQL text. Which of a field's expressions the engine reads.
//
// An engine may also lower the model onto views it generates next to the
// graph, and word its own constraint warning (the optional hooks on
// GraphEngine).
//
// ./bigquery supplies the BigQuery engine; spanner.ts still writes its own
// graph, with the same structure: defined entities, shared abstract labels,
// relationship hierarchies, inverse edges, and a properties clause on every
// label.
//

import {lowerDefinedEntities} from './defined_entities';
import {AiContext, Association, Entity, Field, inverseEdgeNames, Metric, Relationship, relationshipAncestors, SemanticModel,} from './ir';
import {resolveInheritance} from './resolve_inheritance';
import {sharedAbstractLabelFields} from './shared_labels';
import {stripQualifier} from './sql_expr_utils';
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

  // 4. SQL text. The SQL a field binds to on this engine, or undefined when the
  // engine has none for it.
  fieldExpression(field: Field): string|undefined;

  // Optional hooks. An engine without one gets the default each names.

  // Generated views. Lowers the inheritance-resolved model onto views the
  // engine generates next to the graph, and returns the model the graph reads
  // (BigQuery: vocabularies and derived relationships, see bigquery.ts).
  // Default: the graph reads the resolved model as is.
  lowerModel?(model: SemanticModel, warnings: string[]): SemanticModel;

  // The metadata clause for a node's DEFAULT LABEL (BigQuery appends the
  // entity's grain and history). Default: elementOptions(entity.description,
  // entity.aiContext).
  entityOptions?(entity: Entity): string|undefined;

  // The warning for a model's constraints, which no graph element carries
  // (BigQuery's names the node views that apply them). Default: they reach
  // Knowledge Catalog only, and the engine's push deploys none of them.
  constraintWarning?(count: number): string;
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

  // A defined (virtual) entity forms no node table: it becomes the boolean
  // membership property `is<Name>` on its base (see defined_entities.ts), as
  // spanner.ts lowers it too. A model without one is returned as-is, so its
  // output is unchanged.
  model = lowerDefinedEntities(model, warnings);

  // Resolve entity-level inheritance (`extends`) before generating: this
  // flattens each subclass's inherited fields down and expands `extends` to the
  // full transitive ancestor set, so labels and property signatures can be read
  // straight off the resolved model. Only the graph legs run this; the KC push
  // consumes the raw model, so its output is unaffected.
  const resolved = resolveInheritance(model);
  warnings.push(...resolved.warnings);

  // The engine may lower the resolved model onto views it generates next to
  // the graph (see GraphEngine.lowerModel); the graph reads the lowered model.
  const lowered = engine.lowerModel ?
      engine.lowerModel(resolved.model, warnings) :
      resolved.model;

  // The IR requires entities/relationships/metrics, but be defensive against a
  // hand-built or partially-deserialized model rather than throwing on `.map`.
  const entities = lowered.entities ?? [];
  const relationships = lowered.relationships ?? [];
  const metrics = lowered.metrics ?? [];

  // A property graph has no construct for an action or a constraint
  // (kc_actions.ts and kc_constraints.ts publish them to Knowledge Catalog),
  // so this leg emits nothing for either. Warn once each, so an author who
  // declared them learns where they go. Constraints are the one exception on
  // the read side: on BigQuery, a node view whose binding sets
  // `hydration.constraints: enforce` applies them to the rows it serves
  // (constraint_enforcement.ts), so an engine may word their warning itself
  // (GraphEngine.constraintWarning). A push that leaves Knowledge Catalog out
  // warns separately that they are published nowhere (see commands.ts).
  const actions = resolved.model.actions ?? [];
  if (actions.length) {
    warnings.push(
        `${actions.length} action(s) reach Knowledge Catalog only; the ` +
        `${engine.name} push deploys none of them.`);
  }
  const constraints = resolved.model.constraints ?? [];
  if (constraints.length) {
    warnings.push(
        engine.constraintWarning ?
            engine.constraintWarning(constraints.length) :
            `${constraints.length} constraint(s) reach Knowledge Catalog ` +
                `only; the ${engine.name} push deploys none of them.`);
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
  // An abstract label is rendered from each descendant's own binding, so it can
  // carry only the inherited fields every descendant binds (see
  // shared_labels.ts).
  const abstractLabelFields =
      sharedAbstractLabelFields(validEntities, labelByName, warnings);

  const nodeTables = validEntities.map(
      entity => renderNodeTable(
          entity, measurePropertiesByEntity.get(entity.name) ?? [],
          labelByName, abstractLabelFields, ancestorsUsed.has(entity.name),
          engine, warnings));

  const entitiesByName = new Map(validEntities.map(e => [e.name, e]));
  // Relationship inheritance: an ABSTRACT relationship forms no edge table (it
  // binds no join) -- it survives only as a LABEL on its concrete descendants'
  // edge tables, exactly as an abstract entity survives as a node label. It is
  // dropped silently here, before the dangling-endpoint check, because its
  // endpoints are often abstract entities (which are also node-less by design).
  const concreteRels = relationships.filter(rel => !rel.abstract);
  const renderedRels = concreteRels.filter(rel => {
    // An edge REFERENCES both endpoint nodes; if either was skipped the
    // edge cannot resolve, so drop it too.
    const dangling = [rel.source.entity, rel.destination.entity].filter(
        n => skipped.has(n));
    if (!dangling.length) return true;
    warnings.push(
        `relationship '${rel.name}': references skipped entity ` +
        `${dangling.map(n => `'${n}'`).join(', ')}; edge omitted`);
    return false;
  });
  // Each rendered edge's transitive super-relationships, and the set of names
  // that some rendered edge carries as an ancestor LABEL (a concrete
  // relationship in that set is a "shared" label, see edgeLabelLines).
  const relAncestors = new Map(renderedRels.map(
      rel => [rel.name, relationshipAncestors(relationships, rel.name)]));
  const sharedRelLabels = new Set([...relAncestors.values()].flat());
  // Mirror of the abstract-entity orphan check: an abstract relationship no
  // rendered edge descends from produces no graph element at all.
  for (const rel of relationships) {
    if (rel.abstract && !sharedRelLabels.has(rel.name)) {
      warnings.push(
          `abstract relationship '${rel.name}' is not extended by any ` +
          `concrete relationship; it has no edge table and no descendant to ` +
          `label, so it produces no graph element`);
    }
    // An abstract relationship has no edge table to read backwards, so its
    // inverse has nothing to reverse.
    if (rel.abstract && rel.inverse) {
      warnings.push(
          `abstract relationship '${rel.name}': inverse '${rel.inverse}' is ` +
          `not emitted (an abstract relationship has no edge table to ` +
          `reverse)`);
    }
  }
  // A relationship's declared inverse is a second edge table over the same
  // backing table, SOURCE/DESTINATION swapped (see renderEdgeTable). The
  // reversed edge carries NO ancestor labels: a super-relationship names the
  // forward direction (hasCounterparty: document -> party), and the reversed
  // edge points the other way, so labeling it hasCounterparty would be wrong.
  const usableInverses =
      inverseEdgeNames(renderedRels, entities, relationships, warnings);
  const edgeTables = renderedRels.flatMap(rel => {
    const forward = renderEdgeTable(
        rel, entitiesByName,
        {
          ancestors: relAncestors.get(rel.name) ?? [],
          isSupertype: sharedRelLabels.has(rel.name),
        },
        engine, warnings);
    if (!usableInverses.has(rel.name)) return [forward];
    return [
      forward,
      renderEdgeTable(
          rel, entitiesByName, {ancestors: [], isSupertype: false}, engine,
          warnings, true),
    ];
  });

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
    abstractLabelFields: Map<string, Set<string>>, isSupertype: boolean,
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
  // Defense in depth: availability pruning normally strips every unbound field
  // (it has no column) before generation. Pruning tests isFieldBound. The
  // BigQuery engine's fieldExpression returns undefined exactly when
  // fieldBinding does, so the two agree on which fields are bound. The text it
  // returns is fieldBinding's with the comments removed. But a caller that
  // generates DDL straight from a bindingOptional load without pruning could
  // still reach here with an unbound field, such as a purely logical one. Skip
  // it with a warning rather than emit `<name>` as a phantom bare column the
  // source table does not have.
  const boundFields = entity.fields.filter(f => {
    if (engine.fieldExpression(f) !== undefined) return true;
    warnings.push(
        `entity '${entity.name}': field '${f.name}' has no column under this ` +
        `binding; omitted from the node table (bind it, or govern the logical ` +
        `model in Knowledge Catalog instead)`);
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
  // rule is BigQuery's, but it applies to any engine whose metadata hooks
  // return a clause.
  let labelOpts = engine.entityOptions ?
      engine.entityOptions(entity) :
      engine.elementOptions(entity.description, entity.aiContext);
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
  // Never omit the properties clause: with nothing to list, a label with no
  // clause defaults to PROPERTIES ARE ALL COLUMNS, which leaks every column of
  // the source table -- modeled or not -- onto the node as a bare property (see
  // propertiesClause). Inside a hierarchy that bare property also collides
  // with the explicit definition of the same name under an ancestor LABEL on
  // this table (verified live -- "Property 'disposition' has more than one
  // definition in the element table") and makes a shared label's property set
  // differ from table to table. An empty `PROPERTIES()` is not valid either,
  // so a node that declares just its KEY says `NO PROPERTIES`.
  lines.push(propertiesClause(properties));

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
      // the abstract ancestor's field names, limited to the fields EVERY
      // descendant carrying this label binds: a label must expose the same
      // properties on every table that binds it. A field this subtype binds
      // but a sibling does not stays on this node's DEFAULT LABEL only.
      const shared = abstractLabelFields.get(ancestorName);
      signature = [];
      for (const af of ancestor.fields) {
        if (!shared?.has(af.name)) continue;
        const child = boundFields.find(cf => cf.name === af.name);
        if (child) {
          signature.push(renderFieldProperty(child, entity.name, engine));
        }
      }
    } else {
      signature = ancestor.fields.map(
          f => renderFieldProperty(f, ancestor.name, engine));
    }
    // An ancestor with nothing to list -- an abstract root with no fields, or
    // one whose fields this subtype's binding leaves all unbound -- gets an
    // explicit `NO PROPERTIES`. Omitting the clause would default the LABEL to
    // ALL COLUMNS: every column of this table re-exposed under the ancestor,
    // colliding with its explicitly rendered properties and differing from the
    // same label on every sibling table (see the DEFAULT LABEL note above).
    lines.push(
        signature.length ? propertiesBlock(signature) :
                           line(2, 'NO PROPERTIES'));
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
  const expr = engine.fieldExpression(field);
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


// Renders a relationship's edge table. With `reversed`, renders its declared
// INVERSE instead: the same backing table and KEY -- one edge row per forward
// edge row, so the two can never disagree -- with SOURCE and DESTINATION
// swapped and the inverse name as the alias (and so the label). `MATCH
// (c)-[:hasOpportunity]->(o)` then reads the hasBuyer foreign key backwards
// without a second physical edge. The forward edge's description/synonyms
// describe the forward reading, so the inverse carries no OPTIONS.
function renderEdgeTable(
    rel: Relationship, entitiesByName: Map<string, Entity>,
    hierarchy: EdgeHierarchy, engine: GraphEngine, warnings: string[],
    reversed = false): string {
  // A many-to-many relationship is backed by its own association table rather
  // than a source entity's foreign key; render it from that block.
  if (rel.association) {
    return renderAssociationEdge(
        rel, rel.association, entitiesByName, hierarchy, engine, warnings,
        reversed);
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
  // The two endpoint clauses, as (edge columns, node, node columns).
  const fromEnd = `KEY(${key}) REFERENCES ${
      quoteIfReserved(rel.source.entity)}(${key})`;
  const toEnd = `KEY(${destFk}) REFERENCES ${
      quoteIfReserved(rel.destination.entity)}(${destRef})`;
  const alias = reversed ? rel.inverse! : rel.name;
  const lines = [
    line(1, `${backing} AS ${quoteIfReserved(alias)}`),
    line(2, `KEY(${key})`),
    line(2, `SOURCE ${reversed ? toEnd : fromEnd}`),
    line(2, `DESTINATION ${reversed ? fromEnd : toEnd}`),
  ];

  // Edge description and synonyms attach to the DEFAULT LABEL: after the
  // SOURCE/DESTINATION clauses (grammar: element_table_definition); ancestor
  // LABELs follow it (see edgeLabelLines).
  //
  // A foreign-key edge exposes no properties of its own: its backing table is
  // the SOURCE entity's, whose columns are that node's properties, not the
  // edge's. edgeLabelLines still SAYS so (`NO PROPERTIES`). Omitting the clause
  // defaults the edge's label to PROPERTIES ARE ALL COLUMNS, re-exposing every
  // column of the source table on the edge, and a bare column property
  // collides with any MEASURE of the same name on a node (verified live --
  // "Property 'won_amount' is defined as MEASURE, but there are other
  // declarations with the same name").
  lines.push(
      ...edgeLabelLines(rel, [], hierarchy, engine, warnings, reversed));

  return lines.join('\n');
}


// Renders a many-to-many edge backed by an association (junction) table. Unlike
// a direct FK, the edge has its OWN backing table and KEY, each endpoint's
// SOURCE/DESTINATION KEY names the junction columns referencing that entity's
// declared key, and the junction's own `fields` become edge PROPERTIES. With
// `reversed`, the inverse edge over the same junction (see renderEdgeTable).
function renderAssociationEdge(
    rel: Relationship, assoc: Association, entitiesByName: Map<string, Entity>,
    hierarchy: EdgeHierarchy, engine: GraphEngine, warnings: string[],
    reversed = false): string {
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

  const fromEnd =
      `KEY(${assoc.sourceColumns.map(quoteIfReserved).join(', ')}) ` +
      `REFERENCES ${quoteIfReserved(rel.source.entity)}(${
          refColumns(rel.source)})`;
  const toEnd =
      `KEY(${assoc.destinationColumns.map(quoteIfReserved).join(', ')}) ` +
      `REFERENCES ${quoteIfReserved(rel.destination.entity)}(${
          refColumns(rel.destination)})`;
  const alias = reversed ? rel.inverse! : rel.name;
  const lines = [
    line(1, `${backing} AS ${quoteIfReserved(alias)}`),
    line(2, `KEY(${assoc.keys.map(quoteIfReserved).join(', ')})`),
    line(2, `SOURCE ${reversed ? toEnd : fromEnd}`),
    line(2, `DESTINATION ${reversed ? fromEnd : toEnd}`),
  ];

  // Edge description and synonyms attach to the DEFAULT LABEL: after the
  // SOURCE/DESTINATION clauses, before PROPERTIES (grammar:
  // element_table_definition); see edgeLabelLines.

  // The junction's own non-key fields are the edge's properties (the same on
  // both readings: they describe the pairing, not a direction). A junction
  // with none says `NO PROPERTIES` rather than default to ALL COLUMNS, which
  // would expose its key columns as bare edge properties (see edgeLabelLines
  // and propertiesClause).
  const properties = (assoc.fields ?? [])
                         .map(f => renderFieldProperty(f, rel.name, engine));
  lines.push(...edgeLabelLines(
      rel, properties, hierarchy, engine, warnings, reversed));

  return lines.join('\n');
}

// Where a rendered edge sits in the relationship hierarchy (see
// Relationship.extends): its transitive super-relationships, and whether some
// OTHER rendered edge carries this edge's own name as an ancestor LABEL.
interface EdgeHierarchy {
  ancestors: string[];
  isSupertype: boolean;
}

// Renders an edge table's label clauses -- everything after SOURCE/DESTINATION.
//
// Outside any relationship hierarchy this is an implicit default label with
// the engine's metadata clause and the edge's properties clause -- its
// PROPERTIES, or `NO PROPERTIES` when there are none (a direct FK edge), never
// an omitted clause that would default to all columns (see propertiesClause).
//
// Inside one, the edge is labelled once per transitive ancestor, so a query on
// the super-relationship (`MATCH ()-[e:hasCounterparty]->()`) matches the
// edges of every descendant table. Three rules shape it, mirroring the
// node-label rules in renderNodeTable:
//   - an explicit `DEFAULT LABEL` is required once LABEL clauses follow (a
//     bare implicit default followed by LABEL does not parse);
//   - a label bound by more than one element table must carry no OPTIONS, so
//     an ancestor LABEL never has any, and a concrete super-relationship whose
//     own name is shared drops its description/synonyms (with a warning);
//   - every element table binding a shared label must declare the same
//     property set. Descendant edge tables have unrelated backing columns, so
//     the only set they can all agree on is the empty one: an ancestor LABEL
//     is `NO PROPERTIES`, and a shared concrete super-relationship's own
//     default label is too. The super-relationship label is therefore a pure
//     traversal type; its edges' properties stay on their own DEFAULT LABELs.
//
// A `reversed` edge (a relationship's inverse, see renderEdgeTable) is always
// rendered outside the hierarchy and carries no OPTIONS: the description and
// synonyms describe the forward reading.
function edgeLabelLines(
    rel: Relationship, properties: string[], hierarchy: EdgeHierarchy,
    engine: GraphEngine, warnings: string[], reversed = false): string[] {
  let labelOpts = reversed ?
      undefined :
      engine.elementOptions(rel.description, rel.aiContext);
  const inHierarchy = hierarchy.ancestors.length > 0 || hierarchy.isSupertype;
  if (!inHierarchy) {
    const out: string[] = [];
    if (labelOpts) out.push(line(2, labelOpts));
    out.push(propertiesClause(properties));
    return out;
  }
  const out = [line(2, 'DEFAULT LABEL')];
  if (hierarchy.isSupertype) {
    if (labelOpts) {
      warnings.push(
          `relationship '${rel.name}' is a super-relationship in a ` +
          `relationship hierarchy; its description/synonyms are dropped from ` +
          `the shared '${rel.name}' label (${engine.name} forbids OPTIONS on ` +
          `a label bound by multiple tables)`);
      labelOpts = undefined;
    }
    // Shared with descendants, whose property sets differ: agree on none.
    out.push(line(2, 'NO PROPERTIES'));
  } else {
    if (labelOpts) out.push(line(2, labelOpts));
    out.push(propertiesClause(properties));
  }
  for (const ancestor of hierarchy.ancestors) {
    out.push(line(2, `LABEL ${quoteIfReserved(ancestor)} NO PROPERTIES`));
  }
  return out;
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

// The properties clause of an element table's (default) label: the listed
// properties, or `NO PROPERTIES` when there are none. The clause is never
// omitted. A label with no properties clause defaults to PROPERTIES ARE ALL
// COLUMNS, exposing every column of the backing table as a bare property the
// model never declared -- and such a leaked column collides with any declared
// property or MEASURE of the same name elsewhere in the graph (verified live
// on BigQuery: "Property 'won_amount' is defined as MEASURE, but there are
// other declarations with the same name"). An empty `PROPERTIES()` is not
// valid, so nothing-to-list is spelled `NO PROPERTIES`.
function propertiesClause(properties: string[]): string {
  return properties.length ? propertiesBlock(properties) :
                             line(2, 'NO PROPERTIES');
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}
