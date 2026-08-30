// Generates Spanner Graph DDL from the Semantic Model IR.
//
// The IR (./ir) is pure semantics. This module is one of its consumers, a
// sibling to ./bigquery: it emits a single `CREATE OR REPLACE PROPERTY GRAPH`
// statement over the entities' existing Spanner input tables. It shares the IR,
// the inheritance-resolution pass, and the edge/association shapes with the
// BigQuery generator, but differs from it in three ways that follow from
// Spanner Graph's DDL:
//
//   1. Input tables are referenced by BARE name -- a property graph lives
//   inside
//      one Spanner database and names tables in that same database, so there is
//      no `project.dataset` qualifier. The graph name is likewise bare.
//   2. There are NO measures. Spanner Graph has no `MEASURE(...)`; model-level
//      metrics have no home in it, so each is skipped with a warning (the graph
//      structure -- nodes, edges, labels, properties -- still deploys).
//   3. There is NO per-element `OPTIONS` clause. Spanner Graph carries no
//      description/synonyms on labels or properties, so element metadata is not
//      emitted here (it rides into Knowledge Catalog instead, as with
//      BigQuery's graph-level options).
//
// See:
// https://docs.cloud.google.com/spanner/docs/reference/standard-sql/graph-schema-statements
//

import {Association, Entity, Field, Relationship, SemanticModel} from './ir';
import {resolveInheritance} from './resolve_inheritance';
import {stripQualifier} from './sql_expr_utils';

export interface GenerateOptions {
  graphName?: string;  // default: model.name
}

export interface GenerateResult {
  ddl: string;         // CREATE OR REPLACE PROPERTY GRAPH ...
  warnings: string[];  // skipped metrics, unresolved table refs, etc.
}

/**
 * Generates the Spanner Graph DDL for a semantic model.
 *
 * The generated statement references the entities' existing Spanner tables; it
 * does not create them. Returns the DDL plus any warnings collected while
 * mapping the IR (e.g. metrics dropped because Spanner Graph has no measure).
 *
 * Throws when the model yields no valid node table -- it declares no entities,
 * or every entity lacks a KEY -- since a property graph with an empty NODE
 * TABLES block is invalid DDL that Spanner would reject.
 */
export function generateSpannerPropertyGraph(
    model: SemanticModel, opts: GenerateOptions = {}): GenerateResult {
  const warnings: string[] = [];

  // Resolve entity-level inheritance (`extends`) before generating, exactly as
  // the BigQuery leg does: this flattens each subclass's inherited fields down
  // and expands `extends` to the full transitive ancestor set, so labels and
  // property signatures can be read straight off the resolved model.
  const resolved = resolveInheritance(model);
  warnings.push(...resolved.warnings);

  const entities = resolved.model.entities ?? [];
  const relationships = resolved.model.relationships ?? [];
  const metrics = resolved.model.metrics ?? [];

  // Spanner Graph has no MEASURE, so a model-level metric cannot be expressed
  // in the graph. Drop each with a warning rather than silently omit it, so an
  // author who expects a metric in the graph learns it lives elsewhere (a
  // BigQuery graph, or Knowledge Catalog).
  for (const metric of metrics) {
    warnings.push(
        `metric '${metric.name}' is not emitted: Spanner Graph has no ` +
        `MEASURE, so model-level metrics have no home in it`);
  }

  // An abstract entity is conceptual: it has no physical table and produces no
  // NODE TABLE, surviving only as a LABEL on its concrete descendants.
  const abstractNames =
      new Set(entities.filter(e => e.abstract).map(e => e.name));

  // A graph node table requires a non-empty KEY. Skip an entity whose primary
  // key is empty (and, below, any edge that references it) rather than emit
  // `KEY()` -- invalid DDL.
  const skipped = new Set<string>();
  const validEntities = entities.filter(entity => {
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

  // An abstract class that is no concrete entity's ancestor produces no graph
  // element at all; warn and drop it rather than let it vanish silently.
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
  // ()` block is invalid DDL. Fail loudly (matching the BigQuery leg) rather
  // than emit a graph Spanner would reject.
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

  // A subclass's `LABEL <ancestor>` block re-lists that ancestor's (flattened)
  // signature, so the label renderer must reach every label carrier by name:
  // node-forming entities plus abstract (table-less) supertypes. A concrete
  // entity dropped for an empty KEY is deliberately excluded.
  const labelByName =
      new Map(entities.filter(e => e.abstract || !skipped.has(e.name))
                  .map(e => [e.name, e]));

  const nodeTables = validEntities.map(
      entity => renderNodeTable(
          entity, labelByName, ancestorsUsed.has(entity.name), warnings));

  const entitiesByName = new Map(validEntities.map(e => [e.name, e]));
  const edgeTables =
      relationships
          .filter(rel => {
            const dangling = [rel.source.entity, rel.destination.entity].filter(
                n => skipped.has(n));
            if (!dangling.length) return true;
            warnings.push(
                `relationship '${rel.name}': references skipped entity ` +
                `${dangling.map(n => `'${n}'`).join(', ')}; edge omitted`);
            return false;
          })
          .map(rel => renderEdgeTable(rel, entitiesByName, warnings));

  const graphName = qualifyGraph(resolved.model, opts);

  const blocks: string[] = [
    `CREATE OR REPLACE PROPERTY GRAPH ${graphName}`,
    `NODE TABLES (\n${nodeTables.join(',\n')}\n)`,
  ];
  if (edgeTables.length) {
    blocks.push(`EDGE TABLES (\n${edgeTables.join(',\n')}\n)`);
  }

  return {ddl: blocks.join('\n') + ';\n', warnings: dedupe(warnings)};
}


function renderNodeTable(
    entity: Entity, labelByName: Map<string, Entity>, isSupertype: boolean,
    warnings: string[]): string {
  const table =
      spannerTable(entity.dataSource, warnings, `entity '${entity.name}'`);

  const properties =
      entity.fields.map(f => renderFieldProperty(f, entity.name));

  const lines = [
    line(1, `${table} AS ${entity.name}`),
    line(2, `KEY(${entity.keys.join(', ')})`),
  ];

  // A node participating in the hierarchy -- as a subclass (it declares
  // ancestor LABELs) or as a shared supertype (a subclass binds its label) --
  // uses an EXPLICIT `DEFAULT LABEL`, mirroring the BigQuery leg's validated
  // shape; a node outside any hierarchy keeps the implicit form.
  const hasAncestors = !!(entity.extends && entity.extends.length);
  if (hasAncestors || isSupertype) lines.push(line(2, 'DEFAULT LABEL'));
  if (properties.length) lines.push(propertiesBlock(properties));

  // Inheritance: declare one LABEL per transitive ancestor (resolveInheritance
  // expanded `extends` to the full ancestor set), each re-listing that
  // ancestor's own properties so `MATCH (:Ancestor)` also matches this
  // subclass.
  for (const ancestorName of entity.extends ?? []) {
    const ancestor = labelByName.get(ancestorName);
    if (!ancestor) {
      warnings.push(
          `entity '${entity.name}' extends '${ancestorName}', which has no ` +
          `node table and is not abstract (it was dropped, e.g. for an empty ` +
          `KEY); the '${ancestorName}' label is omitted from '${entity.name}'`);
      continue;
    }
    lines.push(line(2, `LABEL ${ancestorName}`));
    const signature =
        ancestor.fields.map(f => renderFieldProperty(f, ancestor.name));
    if (signature.length) lines.push(propertiesBlock(signature));
  }
  return lines.join('\n');
}


function renderEdgeTable(
    rel: Relationship, entitiesByName: Map<string, Entity>,
    warnings: string[]): string {
  if (rel.association) {
    return renderAssociationEdge(
        rel, rel.association, entitiesByName, warnings);
  }
  // A direct foreign key: the SOURCE entity's own table backs the edge (one
  // edge row per source row). Its FK columns reference the destination's key
  // columns; the edge is keyed by, and references its source node through, the
  // source entity's own key.
  const sourceEntity = entitiesByName.get(rel.source.entity);
  let backing: string;
  let sourceKey: string[];
  if (!sourceEntity) {
    warnings.push(`relationship '${rel.name}': unknown source entity '${
        rel.source.entity}'`);
    backing = quoteIdent(rel.source.entity);
    sourceKey = rel.source.columns;
  } else {
    backing = spannerTable(
        sourceEntity.dataSource, warnings, `relationship '${rel.name}'`);
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
  return lines.join('\n');
}


// Renders a many-to-many edge backed by an association (junction) table. The
// edge has its OWN backing table and KEY, each endpoint's SOURCE/DESTINATION
// KEY names the junction columns referencing that entity's declared key, and
// the junction's own `fields` become edge PROPERTIES.
function renderAssociationEdge(
    rel: Relationship, assoc: Association, entitiesByName: Map<string, Entity>,
    warnings: string[]): string {
  const backing =
      spannerTable(assoc.dataSource, warnings, `relationship '${rel.name}'`);
  if (!assoc.keys?.length) {
    warnings.push(
        `relationship '${rel.name}': association table has no KEY; the edge ` +
        `table will be invalid (an edge requires a KEY)`);
  }

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

  const properties =
      (assoc.fields ?? []).map(f => renderFieldProperty(f, rel.name));
  if (properties.length) lines.push(propertiesBlock(properties));

  return lines.join('\n');
}


// Renders a field as a graph property: a bare column when the expression is
// just the column, else `<expr> AS <name>`. Spanner Graph carries no
// per-property OPTIONS, so no metadata is attached (unlike the BigQuery leg).
function renderFieldProperty(field: Field, entity: string): string {
  const expr = fieldExpression(field);
  const local = expr !== undefined ? stripQualifier(expr, entity) : field.name;
  return local === field.name ? field.name : `${local} AS ${field.name}`;
}


// The target/canonical expression, falling back to the imported vendor SQL when
// that is all the IR carries (see the Field expression-fidelity contract).
function fieldExpression(f: Field): string|undefined {
  return f.expression ?? f.importedExpression;
}


// Maps the IR's `dataSource` to the BARE Spanner table name the graph
// references. A property graph names input tables within its own database, so
// only the final segment of a qualified `project.dataset.table` (or any dotted
// source) is meaningful; the leading qualifiers name where a BigQuery copy
// lives and have no bearing on the Spanner table. A verbatim query (contains
// whitespace) cannot back a graph element table, so it is passed through
// parenthesized with a warning.
function spannerTable(
    dataSource: string, warnings: string[], context: string): string {
  const trimmed = (dataSource ?? '').trim();
  if (!trimmed) {
    warnings.push(
        `${context}: empty data source; the table reference will be invalid`);
    return quoteIdent('');
  }
  if (/\s/.test(trimmed)) {
    warnings.push(
        `${context}: data source '${
            trimmed}' looks like a query, not a table reference; ` +
        `emitting it verbatim (a graph element table requires a table)`);
    return `(${trimmed})`;
  }
  const last = splitDotted(trimmed).map(unquote).pop() ?? trimmed;
  return quoteIdent(last);
}


// Splits a dotted source into its segments, treating a backtick- or
// double-quote-delimited segment as opaque so a dot INSIDE quotes does not
// split an identifier: `proj.ds.`weird.name`` yields ['proj', 'ds',
// '`weird.name`'], not a spurious break inside the quoted table name.
function splitDotted(source: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string|null = null;
  for (const ch of source) {
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
    } else if (ch === '`' || ch === '"') {
      quote = ch;
      cur += ch;
    } else if (ch === '.') {
      parts.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  parts.push(cur);
  return parts;
}


// Builds the bare graph name from opts/model. Unlike BigQuery -- where the
// graph name is `project.dataset.name` -- a Spanner graph lives in one database
// and is named by a single identifier.
function qualifyGraph(model: SemanticModel, opts: GenerateOptions): string {
  return quoteIdent(opts.graphName ?? model.name);
}


// Renders a Spanner GoogleSQL identifier: bare when it is a simple identifier,
// else backtick-quoted (with any backtick escaped). Graph names, table names,
// and the like flow through here so a hyphenated or otherwise non-simple name
// does not produce invalid DDL.
function quoteIdent(name: string): string {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return name;
  return `\`${name.replace(/`/g, '\\`')}\``;
}

function unquote(part: string): string {
  return part.replace(/^[`"]/, '').replace(/[`"]$/, '');
}


// Indentation: one nesting level == one INDENT, matching the BigQuery leg so
// the two generators' output reads consistently.
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
