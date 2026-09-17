// ToolboxConfig -> Semantic Model IR mapping.
//
// This is the whole Toolbox -> OSI policy layer. parse.ts is mechanical and
// sql.ts only reports what a statement says; every decision about what a
// configuration MEANS as a semantic model is here, in one place.
//
// The shape of the problem, which is what makes this import different from the
// OWL one. An ontology is a list of things that are true, so importing it is a
// rename. A Toolbox configuration is a list of things that are CALLABLE: it has
// verbs and no nouns, and the only place a noun appears is inside the SQL text
// of a tool's `statement`. So the mapping runs the other way round -- the nouns
// are reconstructed from the verbs, and then most of the verbs are discarded,
// because once the nouns exist kcmd derives the read tools back from them
// (runtime/agent_tools.ts).
//
// The mapping. Each line is one construct:
//   table in any statement       -> entity, bound to that table
//   column attributed to a table -> field on that entity, expression = column
//   join equality in a SELECT    -> relationship between the two entities
//   INSERT / UPDATE / DELETE tool-> action with a `sql` executor
//   tool `parameters`            -> action parameters, `@name`-bound
//   DML target + verb + columns  -> the action's `affects` (DERIVED, not taken
//                                   on trust: it is read out of the statement)
//   source coordinates           -> the entity's `source` resource name, and
//                                   the model's `deployment_target` one level
//                                   up at the database
//   SELECT tool                  -> nothing; the entity it revealed is enough
//
// What is NOT imported, and why each one is a statement about the two formats
// rather than an unfinished corner:
//   - A PRIMARY KEY. A configuration never states one. Join columns are
//     reported as candidates in the warnings; nothing is written into the
//     model, because a wrong key is worse than an absent one.
//   - A tool with `templateParameters`. Those interpolate identifiers into the
//     statement at call time, so the statement is not fixed and the tables it
//     touches cannot be declared ahead of the call. That is precisely the
//     property an ontology exists to have, so such a tool is skipped.
//   - A tool with no statement (an API wrapper: `bigquery-execute-sql`, `http`,
//     the 290-odd others). There is no SQL to read a noun out of.
//   - A group / toolset. Toolbox can name a subset of tools and serve it; the
//     ontology has no construct for a named subset of its own surface.
//   - Everything a Toolbox parameter says beyond its name and type: its
//     description, whether it is optional, its allowed values, and whether it
//     is filled from a verified claim rather than by the caller. An OSI action
//     parameter is a name and a type (ActionParameter), and the description is
//     the costly one -- it is the sentence the agent reads to decide what to
//     put in the argument.
//   - Everything a `kind: prompt`, `resource` or `authService` document says.
//
// The result is a PHYSICAL model wherever the source type allows one: an entity
// carries the table it was found in and a field carries its column, so the
// import is bound and not just logical. Whether it is also RUNNABLE is a
// narrower question -- see resourceName below.

import {Action, ActionParameter, AffectedConcept, ConceptOperation, DataType, Entity, Field, Relationship, SemanticModel,} from '../../ir';

import {sourceOf, ToolboxConfig, ToolboxParameter, ToolboxSource, ToolboxTool,} from './model';
import {dialectForSource, ReadFacts, rewriteParameters, statementFacts, TableRef, WriteFacts,} from './sql';

export interface ToIrResult {
  model: SemanticModel;
  /** Notes about configuration content that could not be mapped. Non-fatal. */
  warnings: string[];
  /** What was actually converted, for the CLI's summary line. */
  stats: {
    entities: number; relationships: number; actions: number; toolsRead: number;
    toolsSkipped: number;
  };
}

// A Toolbox parameter type mapped onto the OSI scalar vocabulary. Toolbox
// validates its own set to these six (`internal/util/parameters`), and the two
// composite ones have no OSI scalar, so they land on Opaque -- which is the
// IR's own "a value whose logical type this model does not state", not a
// placeholder for a gap.
const PARAMETER_TYPES: Record<string, DataType> = {
  string: 'String',
  integer: 'Integer',
  float: 'Float',
  boolean: 'Boolean',
  array: 'Opaque',
  map: 'Opaque',
};

// An entity under construction: the IR object plus the indexes needed while
// statements are still arriving.
interface EntityBuild {
  entity: Entity;
  fields: Map<string, Field>;
  /**
   * Columns of this table that some statement joined ON, with how many
   * statements did. A configuration never states a primary key, and these are
   * the closest evidence of one it contains, so they are reported rather than
   * used.
   */
  keyCandidates: Map<string, number>;
}

/**
 * Maps a parsed Toolbox configuration onto a semantic model.
 *
 * `modelName` names the result (the CLI derives it from the source filename).
 * Throws on nothing: a tool that cannot be read costs that tool and adds a
 * warning.
 */
export function toolboxToIr(
    config: ToolboxConfig, modelName: string): ToIrResult {
  const warnings: string[] = [];
  const warn = (message: string) => {
    if (!warnings.includes(message)) warnings.push(message);
  };

  // Keyed by the table reference as a statement spells it, so `public.accounts`
  // and `accounts` from two different sources stay two entities if they are
  // written differently, and one if they are not.
  const builds = new Map<string, EntityBuild>();
  const takenNames = new Map<string, string>();
  const relationships = new Map<string, Relationship>();
  const actions: Action[] = [];
  // The sources the imported tools actually named, in the order first seen. A
  // configuration may define sources no tool uses; the model's store is decided
  // by the ones that produced something.
  const used = new Map<string, ToolboxSource>();
  let toolsRead = 0;
  let toolsSkipped = 0;

  for (const tool of config.tools) {
    const source = sourceOf(config, tool);
    if (tool.source && !source) {
      warn(`tool '${tool.name}' names source '${
          tool.source}', which the configuration does not define; its statement is still read, but the entities it reveals carry no resource name`);
    }

    if (!tool.statement) {
      toolsSkipped++;
      warn(`skipped tool '${tool.name}' (${
          tool.type ||
          'unknown type'}): it runs no statement, so there is no SQL to read an entity out of`);
      continue;
    }
    if (tool.templateParameters.length) {
      toolsSkipped++;
      warn(
          `skipped tool '${tool.name}': it has templateParameters (${
              tool.templateParameters.map((p) => p.name)
                  .join(', ')}), which are` +
          ` interpolated into the statement before it is prepared. The` +
          ` statement is therefore not fixed and what it touches cannot be` +
          ` declared, which is the one thing a semantic model has to be able` +
          ` to say`);
      continue;
    }

    const dialect = dialectForSource(source?.type);
    const facts = statementFacts(tool.statement, dialect);
    if (facts.kind === 'unknown') {
      toolsSkipped++;
      warn(`skipped tool '${tool.name}': ${facts.reason}`);
      continue;
    }
    toolsRead++;
    if (source?.name) used.set(source.name, source);

    if (facts.kind === 'read') {
      ingestRead(facts, source, builds, takenNames, relationships, warn);
    } else {
      const action =
          ingestWrite(facts, tool, source, dialect, builds, takenNames, warn);
      if (action) actions.push(action);
    }
  }

  for (const group of config.groups) {
    warn(
        `dropped group '${group.name ?? '(unnamed)'}' (${
            group.tools
                .length} tools): a semantic model has no construct for a` +
        ` named subset of its own surface. The tools it listed were imported` +
        ` on their own merits`);
  }

  const entities = [...builds.values()].map((b) => {
    b.entity.fields = [...b.fields.values()];
    return b.entity;
  });

  reportKeys(builds, warn);
  if (entities.length) {
    warn(
        `entities and fields are named after the tables and columns the` +
        ` statements reference, because that is all a configuration says.` +
        ` Rename them to the concepts they stand for before publishing`);
  }

  const model: SemanticModel = {
    name: modelName,
    description: 'Imported from an MCP Toolbox configuration.',
    entities,
    relationships: [...relationships.values()],
    metrics: [],
    actions,
  };

  const target = deploymentTarget([...used.values()], warn);
  if (target) {
    model.customExtensions = [{
      vendorName: 'GOOGLE',
      data: JSON.stringify({deploymentTargets: [target]}),
    }];
  }

  return {
    model,
    warnings,
    stats: {
      entities: entities.length,
      relationships: relationships.size,
      actions: actions.length,
      toolsRead,
      toolsSkipped,
    },
  };
}

// --- Reads -------------------------------------------------------------------

function ingestRead(
    facts: ReadFacts, source: ToolboxSource|undefined,
    builds: Map<string, EntityBuild>, takenNames: Map<string, string>,
    relationships: Map<string, Relationship>,
    warn: (message: string) => void): void {
  const byTable = new Map<string, EntityBuild>();
  for (const ref of facts.tables) {
    const build = ensureEntity(ref, source, builds, takenNames, warn);
    // Indexed under every spelling the join facts might use, because sql.ts
    // resolves an alias to the reference as written.
    byTable.set(ref.name, build);
    byTable.set(ref.table, build);
  }
  for (const column of facts.columns) {
    const build = byTable.get(column.table);
    if (build) ensureField(build, column.column);
  }
  for (const join of facts.joins) {
    const left = byTable.get(join.left.table);
    const right = byTable.get(join.right.table);
    if (!left || !right) continue;
    addRelationship(
        relationships, left, join.left.column, right, join.right.column, warn);
  }
}

// --- Writes ------------------------------------------------------------------

function ingestWrite(
    facts: WriteFacts, tool: ToolboxTool, source: ToolboxSource|undefined,
    dialect: string, builds: Map<string, EntityBuild>,
    takenNames: Map<string, string>, warn: (message: string) => void): Action|
    undefined {
  if (!facts.table.name) {
    warn(`skipped tool '${
        tool.name}': its statement writes, but names no table`);
    return undefined;
  }
  const build = ensureEntity(facts.table, source, builds, takenNames, warn);
  for (const field of facts.fields) ensureField(build, field);
  // A predicate column is a real column of the table and belongs on the entity,
  // but it is NOT part of the blast radius: the statement reads it to find the
  // row, it does not change it.
  for (const column of facts.readColumns) ensureField(build, column);

  const parameters: ActionParameter[] =
      tool.parameters.map((p) => toParameter(p, tool, warn));
  const executor = toExecutor(tool, dialect, parameters, warn);

  const affects: AffectedConcept[] = [{
    concept: build.entity.name,
    operation: facts.operation as ConceptOperation,
    // A delete takes the whole row; naming fields alongside one is rejected by
    // validate.ts, and rightly.
    fields: facts.operation === 'delete' || !facts.fields.length ?
        undefined :
        [...facts.fields],
  }];

  return {
    name: tool.name,
    description: tool.description,
    executor,
    parameters,
    affects,
  };
}

// A tool's statement as a kcmd `sql` executor, or nothing when it cannot be
// bound.
function toExecutor(
    tool: ToolboxTool, dialect: string, parameters: ActionParameter[],
    warn: (message: string) => void): Action['executor'] {
  const rewrite = rewriteParameters(
      tool.statement ?? '', dialect, tool.parameters.map((p) => p.name));
  for (const message of rewrite.warnings) {
    warn(`tool '${tool.name}': ${message}`);
  }
  if (rewrite.warnings.length) {
    // An unbindable placeholder means the statement would reach the store with
    // a value interpolated into it or with nothing bound at all. The action is
    // still imported -- it is a real operation the domain has -- but with no
    // executor, which is how OSI says "declared, performed by nothing".
    warn(
        `action '${tool.name}' was imported without an executor: its` +
        ` statement could not be rewritten to named parameters, and a` +
        ` statement kcmd cannot bind is one it must not run`);
    return undefined;
  }
  const declared = new Set(parameters.map((p) => p.name));
  const unbound = rewrite.bound.filter((name) => !declared.has(name));
  if (unbound.length) {
    warn(
        `action '${tool.name}' was imported without an executor: its` +
        ` statement binds ${unbound.map((n) => `@${n}`).join(', ')}, which` +
        ` the tool does not declare as a parameter`);
    return undefined;
  }
  return {kind: 'sql', sql: {statements: [rewrite.sql]}};
}

function toParameter(
    p: ToolboxParameter, tool: ToolboxTool,
    warn: (message: string) => void): ActionParameter {
  const type = PARAMETER_TYPES[p.type?.toLowerCase() ?? ''];
  if (!type) {
    warn(`parameter '${p.name}' of tool '${tool.name}' has type '${
        p.type}', which is not one of Toolbox's own six; imported as Opaque`);
  } else if (p.type === 'array' || p.type === 'map') {
    warn(`parameter '${p.name}' of tool '${tool.name}' is a ${
        p.type}; OSI's scalar vocabulary has no composite, so it is imported as Opaque`);
  }
  if (p.description) {
    warn(
        `parameter descriptions are dropped: an OSI action parameter is a name` +
        ` and a type, so the sentence telling an agent what to put in this` +
        ` argument has nowhere to go`);
  }
  if (p.required === false) {
    warn(
        `parameter '${p.name}' of tool '${
            tool.name}' is optional, which OSI cannot say; it is imported as` +
        ` an ordinary parameter`);
  }
  if (p.allowedValues?.length || p.excludedValues?.length) {
    warn(
        `parameter '${p.name}' of tool '${
            tool.name}' restricts its values, which OSI cannot say on a` +
        ` parameter. Write the restriction as a constraint and guard the` +
        ` action with it`);
  }
  if (p.authServices?.length) {
    warn(
        `parameter '${p.name}' of tool '${
            tool.name}' is filled from a verified claim (${
            p.authServices.map((a) => `${a.name}.${a.field}`).join(', ')});` +
        ` OSI cannot say a parameter is not the caller's to supply, so it is` +
        ` imported as an ordinary parameter the agent fills`);
  }
  return {name: p.name, type: type ?? 'Opaque'};
}

// --- Entities, fields, relationships -----------------------------------------

function ensureEntity(
    ref: TableRef, source: ToolboxSource|undefined,
    builds: Map<string, EntityBuild>, takenNames: Map<string, string>,
    warn: (message: string) => void): EntityBuild {
  const existing = builds.get(ref.name);
  if (existing) return existing;

  // Two different tables whose final segment is the same (`sales.orders` and
  // `ops.orders`) are two entities and need two names.
  let name = ref.table;
  const claimant = takenNames.get(name);
  if (claimant && claimant !== ref.name) {
    name = ref.name.replace(/[^A-Za-z0-9_]/g, '_');
    warn(`entity '${ref.table}' appears under two table references (${
        claimant}, ${ref.name}); the second is named '${name}'`);
  }
  takenNames.set(name, ref.name);

  const build: EntityBuild = {
    entity: {
      name,
      dataSource: resourceName(ref, source, warn),
      keys: [],
      fields: [],
    },
    fields: new Map(),
    keyCandidates: new Map(),
  };
  builds.set(ref.name, build);
  return build;
}

function ensureField(build: EntityBuild, column: string): Field {
  const existing = build.fields.get(column);
  if (existing) return existing;
  // The expression is the column, verbatim: an entity imported this way is
  // bound to the table the statement named, so its fields are bound too.
  const field: Field = {name: column, expression: column};
  build.fields.set(column, field);
  return field;
}

function addRelationship(
    relationships: Map<string, Relationship>, left: EntityBuild,
    leftColumn: string, right: EntityBuild, rightColumn: string,
    warn: (message: string) => void): void {
  const [from, fromColumn, to, toColumn] =
      orient(left, leftColumn, right, rightColumn, warn);
  from.keyCandidates.set(
      fromColumn, (from.keyCandidates.get(fromColumn) ?? 0) + 1);
  to.keyCandidates.set(toColumn, (to.keyCandidates.get(toColumn) ?? 0) + 1);

  const key =
      `${from.entity.name}.${fromColumn}->${to.entity.name}.${toColumn}`;
  if (relationships.has(key)) return;
  let name = `${from.entity.name}_${to.entity.name}`;
  if ([...relationships.values()].some((r) => r.name === name)) {
    name = `${name}_${fromColumn}`;
  }
  relationships.set(key, {
    name,
    source: {entity: from.entity.name, columns: [fromColumn]},
    destination: {entity: to.entity.name, columns: [toColumn]},
  });
}

/**
 * Which end of a join equality holds the foreign key.
 *
 * An ON clause is symmetric and a relationship is not, so the direction has to
 * come from somewhere. Two pieces of evidence are in the statement itself,
 * tried in order:
 *
 *   1. A column that names the other table -- `accounts.customer_id = x` --
 *      is a foreign key pointing at that table, so its side is the source.
 *      This is evidence in the text, not a convention.
 *   2. Failing that, a column named exactly `id` is the key of its own table,
 *      so its side is the destination.
 *
 * When neither applies the order as written stands and the caller is warned,
 * because a reversed edge is a wrong model rather than a missing one.
 */
function orient(
    left: EntityBuild, leftColumn: string, right: EntityBuild,
    rightColumn: string, warn: (message: string) => void):
    [EntityBuild, string, EntityBuild, string] {
  const leftRefs = mentions(leftColumn, right.entity.name);
  const rightRefs = mentions(rightColumn, left.entity.name);
  if (leftRefs && !rightRefs) return [left, leftColumn, right, rightColumn];
  if (rightRefs && !leftRefs) return [right, rightColumn, left, leftColumn];

  const leftIsId = leftColumn.toLowerCase() === 'id';
  const rightIsId = rightColumn.toLowerCase() === 'id';
  if (rightIsId && !leftIsId) return [left, leftColumn, right, rightColumn];
  if (leftIsId && !rightIsId) return [right, rightColumn, left, leftColumn];

  warn(
      `relationship ${left.entity.name}.${leftColumn} = ${right.entity.name}.${
          rightColumn}: neither column names the other` +
      ` table, so the direction follows the order the ON clause was written` +
      ` in. Check it before publishing`);
  return [left, leftColumn, right, rightColumn];
}

// Whether a column name refers to a table: `customer_id` to `customers`,
// `branchId` to `branch`. Compared on the stem so a plural table and a singular
// column still match.
function mentions(column: string, table: string): boolean {
  const stem = (s: string) =>
      s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(ies|es|s)$/, '');
  const c = stem(column.replace(/_?id$/i, ''));
  return c.length > 0 && c === stem(table);
}

// The `source` an entity carries: a resource name when the Toolbox source names
// a backend kcmd can address, and the table reference as written otherwise.
//
// This is where the honest ceiling of the import sits. kcmd derives the store a
// model runs against from its entities' sources (runtime/store.ts), and it
// recognizes three: Spanner, AlloyDB and BigQuery. A `postgres` or `mysql`
// source is a real Toolbox source and produces a model that loads, validates
// and publishes to Knowledge Catalog -- but there is no store behind it, so its
// actions are declarations rather than operations.
function resourceName(
    ref: TableRef, source: ToolboxSource|undefined,
    warn: (message: string) => void): string {
  const table = ref.table;
  const type = (source?.type ?? '').toLowerCase();
  const missing = (what: string) => {
    warn(
        `source '${source?.name}' is a ${type} source but states no ${
            what}, so entity '${
            table}' keeps the table reference as written and` +
        ` binds to no store`);
    return ref.name;
  };

  if (type === 'spanner') {
    if (!source?.project || !source.instance || !source.database) {
      return missing('project, instance and database');
    }
    return `//spanner.googleapis.com/projects/${source.project}/instances/${
        source.instance}/databases/${source.database}/tables/${table}`;
  }
  if (type === 'alloydb-postgres') {
    if (!source?.project || !source.region || !source.cluster ||
        !source.instance || !source.database) {
      return missing('project, region, cluster, instance and database');
    }
    if (ref.name.includes('.') && !/^public\./i.test(ref.name)) {
      warn(
          `entity '${table}' is written as '${
              ref.name}'; an AlloyDB resource name addresses the table alone, so` +
          ` the schema qualifier is not carried and the binding assumes the` +
          ` search path reaches it`);
    }
    return `//alloydb.googleapis.com/projects/${source.project}/locations/${
        source.region}/clusters/${source.cluster}/instances/${
        source.instance}/databases/${source.database}/tables/${table}`;
  }
  if (type === 'bigquery') {
    // A BigQuery source states a project but no dataset -- the dataset is in
    // the statement, which is why a two-part reference completes here and a
    // bare table name cannot.
    const parts = ref.name.split('.');
    if (parts.length >= 3) return parts.slice(-3).join('.');
    if (parts.length === 2 && source?.project) {
      return `${source.project}.${parts[0]}.${parts[1]}`;
    }
    return missing('a dataset the table reference could be completed with');
  }

  if (source) {
    warn(
        `source '${source.name}' is a ${
            type} source; kcmd addresses Spanner, AlloyDB and BigQuery, so entity` +
        ` '${table}' keeps the table reference as written. The model loads` +
        ` and publishes, but nothing runs against it`);
  }
  return ref.name;
}

// The model-level `deployment_target`: the database an action runs against,
// which is the same coordinates resourceName uses stopping one level short of
// the table.
//
// An entity's `source` says where a field lives; a deployment target says where
// a statement executes, and kcmd asks for it before it will offer an agent any
// tool at all. A Toolbox source states it outright -- it exists to hold a
// connection -- so the import that leaves it out produces a model that loads
// and offers nothing.
//
// A model executes against ONE database and a configuration may name several,
// so several is reported rather than guessed at.
function deploymentTarget(
    sources: ToolboxSource[], warn: (message: string) => void): string|
    undefined {
  const targets = new Map<string, string>();  // URI -> source name
  for (const source of sources) {
    const type = (source.type ?? '').toLowerCase();
    if (type === 'spanner' && source.project && source.instance &&
        source.database) {
      targets.set(
          `//spanner.googleapis.com/projects/${source.project}/instances/${
              source.instance}/databases/${source.database}`,
          source.name ?? type);
    } else if (
        type === 'alloydb-postgres' && source.project && source.region &&
        source.cluster && source.instance && source.database) {
      targets.set(
          `//alloydb.googleapis.com/projects/${source.project}/locations/${
              source.region}/clusters/${source.cluster}/instances/${
              source.instance}/databases/${source.database}`,
          source.name ?? type);
    }
  }

  if (targets.size === 1) return [...targets.keys()][0];
  if (targets.size > 1) {
    warn(
        `sources ${
                [...targets.values()].map((n) => `'${n}'`).join(', ')} name ${
            targets.size} different databases, and a model runs against one,` +
        ` so no deployment_target was written. Split the configuration, or` +
        ` add the target for the database this model is about`);
  }
  return undefined;
}

// Reports what the configuration hints at as a primary key without writing it
// into the model. A key is the one thing an import genuinely cannot recover: a
// tool states what it queries, never what identifies a row.
function reportKeys(
    builds: Map<string, EntityBuild>, warn: (message: string) => void): void {
  for (const build of builds.values()) {
    const candidates = [...build.keyCandidates.entries()]
                           .sort((a, b) => b[1] - a[1])
                           .map(([column]) => column);
    const hint = candidates.length ?
        ` Joined on ${
            candidates.map((c) => `'${c}'`).join(', ')}, which is where a key` +
            ` usually is.` :
        '';
    warn(
        `entity '${build.entity.name}' has no primary_key: a Toolbox` +
        ` configuration never states one.${hint}`);
  }
}
