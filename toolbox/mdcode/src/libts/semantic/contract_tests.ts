// Model-derived contract tests (`kcmd test --target bigquery`). Proposed.
//
// A contract test states something the model promises about what the BigQuery
// leg built from it, and checks the promise against the deployed property
// graph and the bound tables -- read-only, queries only:
//
//   - defined-membership (K1): the graph property `is<Class>` holds for exactly
//     the rows the defined class's expression selects over its base's bound
//     table(s);
//   - transitive-closure: a quantified path `-[:p]->{1,k}` over a relationship
//     the model marks transitive returns exactly the pairs a recursive SQL CTE
//     over the bound join columns of every edge labelled p returns -- its own
//     and its sub-relationships', so an abstract one is tested too;
//   - validation-query (K4): every query `kcmd validate` generates executes.
//
// Every test is generated from the model alone; nothing is written per model.
// The families are pluggable: a generator reads the model and returns tests,
// and CONTRACT_TEST_GENERATORS lists the generators `kcmd test` runs (see the
// extension points there, and "Contract tests" in docs/semantic-model/
// validation.md).
//
// A test is either a row-set comparison (`sameRows`: one statement that counts
// the rows each side returns and the rows only one side returns) or a statement
// that must execute (`executes`). A statement that queries the graph with
// GRAPH_TABLE is flagged `graphQuery`: BigQuery may refuse graph queries
// without an Enterprise reservation, and such a refusal reports the test as
// skipped ("needs Enterprise reservation"), not failed.
//
// Layering mirrors validate_bigquery.ts: everything above `runContractTests` is
// pure (planning, SQL, manifest, report) and unit-tested without a network; the
// runner is the only function that calls an API, through an injectable query
// function.

import {BigQueryClient} from '../gcp/bigquery';
import * as context from '../gcp/context';

import {isDefinedEntity, membershipPropertyName, resolveDefinedEntities} from './defined_entities';
import {bigQueryGraphTargets} from './deployment_target';
import {Entity, Relationship, relationshipAncestors, SemanticModel} from './ir';
import {pruneUnavailable} from './resolve_profiles';
import {Binder, planBigQueryValidation, runQuery, sqlString, table as boundTable, Unsupported} from './validate_bigquery';


// ---------------------------------------------------------------------------
// The plan.
// ---------------------------------------------------------------------------

/** How the runner decides a test's outcome. */
export type ContractComparison =
    // `sql` returns one row: actual_rows, expected_rows, missing, extra,
    // missing_examples, extra_examples (see sameRowsSql). Passes when missing
    // and extra are both 0.
    'sameRows'|
    // `sql` runs without an error. Passes when it does.
    'executes';

export interface ContractTest {
  /** `<kind>:<subject>`, unique within a plan. */
  id: string;
  /** The generator that made it (ContractTestGenerator.kind). */
  kind: string;
  /** The model element under test: an entity, a relationship, a check. */
  subject: string;
  /** What holds when the test passes, as one clause. */
  description: string;
  comparison: ContractComparison;
  /**
   * `sql` queries the property graph with GRAPH_TABLE. A failure because the
   * project has no Enterprise reservation reports the test as skipped.
   */
  graphQuery: boolean;
  /** The one statement the runner executes. Always a query. */
  sql: string;
  /** Statements that must compile too (dry run only). */
  compileOnly?: string[];
  /** sameRows: the two sides on their own, for reading and debugging. */
  actualSql?: string;
  expectedSql?: string;
  /** executes: names for the cells of the first result row, for the report. */
  resultColumns?: string[];
}

/** What a generator returns for one test: the planner adds `id` and `kind`. */
export type ContractTestDraft = Omit<ContractTest, 'id'|'kind'>;

/** A model element a generator could not test, and why. */
export interface ContractSkip {
  kind: string;
  subject: string;
  reason: string;
}

export interface ContractPlan {
  model: string;
  /** The graph the graph-side queries read: `project.dataset.graph`. */
  graph?: string;
  tests: ContractTest[];
  /** Elements a generator recognised but could not test (never silent). */
  skipped: ContractSkip[];
  warnings: string[];
}

/**
 * The element tables the BigQuery graph leg builds for the model as push
 * deploys it: what the binding leaves unbound is pruned first.
 */
export interface GraphShape {
  /** Entities that form a node table: concrete and keyed. */
  nodeTables: Set<string>;
  /** Concrete relationships between two node tables: one edge table each. */
  edges: Relationship[];
  /**
   * Each edge table's labels: its own name, then every ancestor relationship
   * it also carries. A path over a label follows every edge table listing it.
   */
  edgeLabels: Map<string, string[]>;
  /** Relationship names some edge table carries as an extra (ancestor) label. */
  sharedEdgeLabels: Set<string>;
}

/** What a generator reads. Built once per plan. */
export interface ContractContext {
  /** The authored model, merged with the selected binding profile. */
  model: SemanticModel;
  /** `project.dataset.graph`, when the model declares a BigQuery graph target. */
  graph?: string;
  /**
   * Resolves a class to its bound rows -- the same resolution `kcmd validate`
   * and the graph leg use (defined entities lowered, inheritance flattened).
   */
  binder: Binder;
  shape: GraphShape;
  /** The k of quantified paths `{1,k}`. */
  pathBound: number;
}

export interface GeneratedTests {
  tests: ContractTestDraft[];
  skipped: Array<{subject: string; reason: string}>;
  warnings?: string[];
}

/**
 * One family of contract tests. `generate` is pure (no network) and derives
 * everything from the context: a generator never names a model element.
 */
export interface ContractTestGenerator {
  /** Stable id: the test id prefix and the report's grouping. */
  kind: string;
  /** One sentence for the docs: what a passing test of this kind shows. */
  summary: string;
  generate(ctx: ContractContext): GeneratedTests;
}

/** The k of `{1,k}` when none is given; the OWL importer's hint uses it too. */
export const DEFAULT_PATH_BOUND = 10;

/** Rows of each kind of difference a sameRows test reports. */
export const EXAMPLE_LIMIT = 5;

/** The status of a graph test BigQuery refused for want of a reservation. */
export const ENTERPRISE_RESERVATION = 'needs Enterprise reservation';

const NO_GRAPH = 'the model declares no BigQuery graph deployment target';


// ---------------------------------------------------------------------------
// SQL building blocks, exported for generators added elsewhere.
// ---------------------------------------------------------------------------

/** A backticked identifier: a label, a property, a column or a graph. */
export function q(name: string): string {
  return `\`${name}\``;
}

function indent(sql: string): string {
  return sql.split('\n').map(l => `  ${l}`).join('\n');
}

/** `name AS (sql)`, for a WITH list. */
export function cte(name: string, sql: string): string {
  return `${name} AS (\n${indent(sql)}\n)`;
}

/**
 * One comparable STRING per row: the column itself, or a JSON array when there
 * are several, so composite keys compare as one value.
 */
export function rowKey(columns: string[], alias = ''): string {
  const cast = (c: string) => `CAST(${alias}${q(c)} AS STRING)`;
  return columns.length === 1 ?
      cast(columns[0]) :
      `TO_JSON_STRING([${columns.map(cast).join(', ')}])`;
}

/**
 * A GRAPH_TABLE query over `graph` (`project.dataset.graph`). `match` is the
 * MATCH clause after the keyword (pattern, then an optional WHERE); `columns`
 * is the COLUMNS list.
 */
export function graphTableSql(
    graph: string, match: string, columns: string[]): string {
  return `SELECT *\nFROM GRAPH_TABLE(\n  ${q(graph)}\n  MATCH ${
      match}\n  COLUMNS (${columns.join(', ')})\n)`;
}

/** The two sides of a row-set comparison. */
export interface SameRows {
  /** What the construct under test returns (the graph, a derived edge...). */
  actual: string;
  /** The reference: plain SQL over the bound tables. */
  expected: string;
  /** The columns both sides project; rows compare on them, as sets. */
  columns: string[];
  /** CTEs either side reads, listed first. */
  ctes?: string[];
  /** One of `ctes` is recursive. */
  recursive?: boolean;
}

/**
 * One statement comparing two row sets: the distinct rows on each side, the
 * rows `actual` misses, the rows only `actual` has, and a few of each. Both
 * sides are reduced to distinct rows: the contract is about which rows, not
 * how many times a query returns them.
 */
export function sameRowsSql(spec: SameRows): string {
  const key = rowKey(spec.columns);
  const ctes = [
    ...(spec.ctes ?? []),
    cte('actual', spec.actual),
    cte('expected', spec.expected),
    cte('actual_keys', `SELECT DISTINCT ${key} AS k\nFROM actual`),
    cte('expected_keys', `SELECT DISTINCT ${key} AS k\nFROM expected`),
    cte('missing',
        'SELECT k FROM expected_keys\nEXCEPT DISTINCT\nSELECT k FROM actual_keys'),
    cte('extra',
        'SELECT k FROM actual_keys\nEXCEPT DISTINCT\nSELECT k FROM expected_keys'),
  ];
  const examples = (from: string) =>
      `ARRAY_TO_STRING(ARRAY(SELECT IFNULL(k, 'NULL') FROM ${from} ORDER BY k ` +
      `LIMIT ${EXAMPLE_LIMIT}), ' | ')`;
  return [
    `WITH ${spec.recursive ? 'RECURSIVE ' : ''}${ctes.join(',\n')}`,
    'SELECT',
    '  (SELECT COUNT(*) FROM actual_keys) AS actual_rows,',
    '  (SELECT COUNT(*) FROM expected_keys) AS expected_rows,',
    '  (SELECT COUNT(*) FROM missing) AS missing,',
    '  (SELECT COUNT(*) FROM extra) AS extra,',
    `  ${examples('missing')} AS missing_examples,`,
    `  ${examples('extra')} AS extra_examples`,
  ].join('\n');
}


// ---------------------------------------------------------------------------
// The generators.
// ---------------------------------------------------------------------------

// The element tables generatePropertyGraph emits, read off the same lowered,
// inheritance-resolved model the Binder holds: a node table per concrete keyed
// entity, an edge table per concrete relationship between two of them, each
// edge labelled with its name and its ancestors' (bigquery.ts). `deployed` is
// the model as push deploys it -- pruned of what the binding leaves unbound
// (pruneUnavailable) -- and limits both to the entities and relationships it
// keeps.
export function graphShape(binder: Binder, deployed?: SemanticModel): GraphShape {
  const keptEntities = deployed && new Set((deployed.entities ?? []).map(e => e.name));
  const keptRelationships =
      deployed && new Set((deployed.relationships ?? []).map(r => r.name));
  const nodeTables = new Set<string>();
  for (const e of binder.tables.values()) {
    if (!e.abstract && e.keys?.length && (!keptEntities || keptEntities.has(e.name))) {
      nodeTables.add(e.name);
    }
  }
  const present = binder.loweredRelationships.filter(
      r => !keptRelationships || keptRelationships.has(r.name));
  const edges = present.filter(
      r => !r.abstract && nodeTables.has(r.source.entity) &&
          nodeTables.has(r.destination.entity));
  const edgeLabels = new Map(edges.map(
      (r): [string, string[]] =>
          [r.name, [r.name, ...relationshipAncestors(present, r.name)]]));
  const sharedEdgeLabels =
      new Set([...edgeLabels.values()].flatMap(labels => labels.slice(1)));
  return {nodeTables, edges, edgeLabels, sharedEdgeLabels};
}

function unsupportedReason(err: unknown): string {
  if (err instanceof Unsupported) return err.message;
  throw err;
}

/** K1: a defined class's graph property selects the rows its expression does. */
export const definedMembershipTests: ContractTestGenerator = {
  kind: 'defined-membership',
  summary: 'The graph property `is<Class>` holds for exactly the rows the ' +
      'defined class\'s expression selects over its base\'s bound table(s).',
  generate(ctx: ContractContext): GeneratedTests {
    const out: GeneratedTests = {tests: [], skipped: []};
    const {infos, problems} = resolveDefinedEntities(ctx.model);
    for (const e of ctx.model.entities ?? []) {
      if (!isDefinedEntity(e)) continue;
      const skip = (reason: string) =>
          out.skipped.push({subject: e.name, reason});
      const info = infos.get(e.name);
      if (!info) {
        skip(problems.get(e.name) ?? 'its parent chain does not resolve');
        continue;
      }
      if (!ctx.graph) {
        skip(NO_GRAPH);
        continue;
      }
      let keys: string[];
      let expected: string;
      try {
        keys = ctx.binder.keys(e.name);
        expected = ctx.binder.rows(e.name, keys);
      } catch (err) {
        skip(unsupportedReason(err));
        continue;
      }
      const prop = membershipPropertyName(e.name);
      const actual = graphTableSql(
          ctx.graph, `(n:${q(info.base)})\n  WHERE n.${q(prop)}`,
          keys.map(k => `n.${q(k)} AS ${q(k)}`));
      out.tests.push({
        subject: e.name,
        description: `the graph property ${info.base}.${prop} holds for ` +
            `exactly the ${info.base} rows that satisfy ${e.name} (${
                         info.membership})`,
        comparison: 'sameRows',
        graphQuery: true,
        sql: sameRowsSql({actual, expected, columns: keys}),
        actualSql: actual,
        expectedSql: expected,
      });
    }
    return out;
  },
};

// The model's transitivity marker: agent instructions that call the
// relationship transitive. The OWL importer writes one for an
// owl:TransitiveProperty, and the query skill reads the same marker.
function isTransitive(r: Relationship): boolean {
  return /\btransitive\b/i.test(r.aiContext?.instructions ?? '');
}

/**
 * A bounded quantified path returns the pairs a recursive CTE returns.
 *
 * A path over label p follows every edge table that carries p: the
 * relationship's own, when the graph has one, and each sub-relationship's,
 * which carries p as an ancestor label. So a relationship that is abstract, or
 * whose sub-relationships join other node tables, is tested over the union of
 * those edges. Nodes compare as `<node table>:<key>`, since a path may cross
 * node tables whose keys collide.
 */
export const transitiveClosureTests: ContractTestGenerator = {
  kind: 'transitive-closure',
  summary: 'A quantified path `-[:p]->{1,k}` over a relationship the model ' +
      'marks transitive returns exactly the pairs a recursive SQL CTE over ' +
      'the bound join columns of every edge labelled p (its own and its ' +
      'sub-relationships\') returns.',
  generate(ctx: ContractContext): GeneratedTests {
    const out: GeneratedTests = {tests: [], skipped: []};
    for (const r of ctx.binder.loweredRelationships) {
      if (!isTransitive(r)) continue;
      const skip = (reason: string) =>
          out.skipped.push({subject: r.name, reason});
      const members = ctx.shape.edges.filter(
          e => ctx.shape.edgeLabels.get(e.name)?.includes(r.name));
      const chains = members.some(
          m => members.some(n => n.source.entity === m.destination.entity));
      if (!ctx.graph) {
        skip(NO_GRAPH);
      } else if (!members.length) {
        skip(r.abstract ?
                 'it is abstract and no edge table in the graph carries its label' :
                 `the graph has no edge table labelled '${r.name}': an endpoint ` +
                     'is not a node table, or the binding leaves it unbound');
      } else if (!chains) {
        skip(members.length === 1 && members[0] === r ?
                 `its endpoints differ ('${r.source.entity}' -> '${
                     r.destination.entity}'), so a path of '${
                     r.name}' edges cannot continue past one hop` :
                 `no edge labelled '${r.name}' starts at a node table where ` +
                     'another one ends, so a path cannot continue past one hop');
      } else {
        try {
          out.tests.push(closureTest(ctx, r, members));
        } catch (err) {
          skip(unsupportedReason(err));
        }
      }
    }
    return out;
  },
};

function closureTest(
    ctx: ContractContext, r: Relationship,
    members: Relationship[]): ContractTestDraft {
  const k = ctx.pathBound;
  const own = members.length === 1 && members[0] === r;
  const parts = members.map(
      m => edgeRowsSql(ctx, m, m === r ? 'it' : `sub-relationship '${m.name}'`));
  // Two edge tables can hold the same pair; the closure walks distinct edges.
  const edges = parts.length === 1 ?
      parts[0] :
      `SELECT DISTINCT src, dst\nFROM (\n${indent(parts.join('\nUNION ALL\n'))}\n)`;
  const closure = [
    'SELECT src, dst, 1 AS hops',
    'FROM edges',
    'UNION ALL',
    'SELECT c.src, e.dst, c.hops + 1',
    'FROM closure AS c',
    'JOIN edges AS e ON e.src = c.dst',
    `WHERE c.hops < ${k}`,
  ].join('\n');
  const expected = 'SELECT DISTINCT src, dst\nFROM closure';
  const endpoints =
      new Set(members.flatMap(m => [m.source.entity, m.destination.entity]));
  const pairs = reachablePairs(members, k);
  const actual = pairs.map(([from, to]) => pathRowsSql(ctx, r.name, from, to, endpoints))
                     .join('\nUNION ALL\n');
  const path = pairs.length === 1 ?
      `(a:${pairs[0][0]})-[:${r.name}]->{1,${k}}(b:${pairs[0][1]})` :
      `(a)-[:${r.name}]->{1,${k}}(b)`;
  return {
    subject: r.name,
    description: `the path ${path} returns exactly the pairs of the ` +
        `transitive closure of '${r.name}'${
                     own ? '' :
                           ` over the edge tables ${
                               members.map(m => m.name).join(', ')}`} up to ${
                     k} hops`,
    comparison: 'sameRows',
    graphQuery: true,
    sql: sameRowsSql({
      actual,
      expected,
      columns: ['src', 'dst'],
      ctes: [cte('edges', edges), cte('closure', closure)],
      recursive: true,
    }),
    actualSql: actual,
    expectedSql: `WITH RECURSIVE ${cte('edges', edges)},\n${
        cte('closure', closure)}\n${expected}`,
  };
}

// The edges of one edge table, as node ids `src` and `dst`. A foreign-key edge
// table is its source entity's own table: each row is an edge to the
// destination row(s) whose referenced columns equal its join columns. Inner
// joins, as a MATCH returns no edge whose endpoint node is missing.
function edgeRowsSql(ctx: ContractContext, m: Relationship, who: string): string {
  if (m.association) {
    throw new Unsupported(`${who} is backed by an association table`);
  }
  const F = m.source.columns;
  const D = m.destination.columns;
  if (!F.length || F.length !== D.length) {
    throw new Unsupported(`${who} declares no matching join columns`);
  }
  const S = m.source.entity;
  const T = m.destination.entity;
  const sk = nodeTable(ctx, S).keys;
  const tk = nodeTable(ctx, T).keys;
  return `SELECT ${nodeId(S, sk, 's.')} AS src, ${nodeId(T, tk, 'd.')} AS dst\n` +
      `FROM (\n${indent(ownRows(ctx, S, [...sk, ...F]))}\n) AS s\n` +
      `JOIN (\n${indent(ownRows(ctx, T, [...tk, ...D]))}\n) AS d ON ${
             F.map((c, i) => `s.${q(c)} = d.${q(D[i])}`).join(' AND ')}`;
}

// The graph side for one (source node table, destination node table) pair:
// the bounded quantified path between them, as node ids.
function pathRowsSql(
    ctx: ContractContext, label: string, from: string, to: string,
    endpoints: Set<string>): string {
  const fk = nodeTable(ctx, from).keys;
  const tk = nodeTable(ctx, to).keys;
  const src = fk.map(c => `src_${c}`);
  const dst = tk.map(c => `dst_${c}`);
  const path = graphTableSql(
      ctx.graph!,
      `(a:${nodeLabel(ctx, from, endpoints)})-[:${q(label)}]->{1,${
          ctx.pathBound}}(b:${nodeLabel(ctx, to, endpoints)})`,
      [
        ...fk.map((c, i) => `a.${q(c)} AS ${q(src[i])}`),
        ...tk.map((c, i) => `b.${q(c)} AS ${q(dst[i])}`),
      ]);
  return `SELECT ${nodeId(from, src)} AS src, ${nodeId(to, dst)} AS dst\nFROM (\n${
      indent(path)}\n)`;
}

// A label expression matching one node table. An entity's label is also on
// its subtypes' node tables; the subtypes among the path's endpoints are
// excluded (`&!Sub`), so each node is read under its own table.
function nodeLabel(
    ctx: ContractContext, name: string, endpoints: Set<string>): string {
  const subtypes = [...endpoints].filter(
      x => x !== name && (ctx.binder.tables.get(x)?.extends ?? []).includes(name));
  return [q(name), ...subtypes.map(x => `!${q(x)}`)].join('&');
}

// The (source, destination) node-table pairs some path of 1..k edges joins,
// in a stable order: sources as the edges first name them, then breadth-first.
function reachablePairs(
    members: Relationship[], k: number): Array<[string, string]> {
  const next = new Map<string, string[]>();
  for (const m of members) {
    const targets = next.get(m.source.entity) ?? [];
    if (!targets.includes(m.destination.entity)) {
      targets.push(m.destination.entity);
    }
    next.set(m.source.entity, targets);
  }
  const pairs: Array<[string, string]> = [];
  for (const from of next.keys()) {
    const seen = new Set<string>();
    let frontier = [from];
    for (let hop = 1; hop <= k && frontier.length; hop++) {
      const reached: string[] = [];
      for (const node of frontier) {
        for (const to of next.get(node) ?? []) {
          if (seen.has(to)) continue;
          seen.add(to);
          reached.push(to);
          pairs.push([from, to]);
        }
      }
      frontier = reached;
    }
  }
  return pairs;
}

// A node table's entity: one with a bound table and key.
function nodeTable(ctx: ContractContext, name: string): Entity {
  const e = ctx.binder.tables.get(name);
  if (!e || !ctx.binder.isTableBacked(e)) {
    throw new Unsupported(
        `entity '${name}' has no bound table and key under this binding`);
  }
  return e;
}

// The rows of one node table: the entity's own table. A subtype with a table
// of its own is a node table of its own, so -- unlike Binder.rows -- its rows
// are not included.
function ownRows(ctx: ContractContext, name: string, fields: string[]): string {
  const e = nodeTable(ctx, name);
  const columns =
      [...new Set(fields)].map(f => `${ctx.binder.column(e, f)} AS ${q(f)}`);
  return `SELECT ${columns.join(', ')}\nFROM ${boundTable(e)}`;
}

// A node's id across node tables: `<node table>:<key>`.
function nodeId(table: string, keys: string[], alias = ''): string {
  return `CONCAT(${sqlString(`${table}:`)}, ${rowKey(keys, alias)})`;
}

/** K4: every query `kcmd validate` generates for the model executes. */
export const validationQueryTests: ContractTestGenerator = {
  kind: 'validation-query',
  summary: 'Every query `kcmd validate` generates for the model executes ' +
      '(the count query runs; the examples query compiles).',
  generate(ctx: ContractContext): GeneratedTests {
    const plan = planBigQueryValidation(ctx.model, {examples: EXAMPLE_LIMIT});
    return {
      tests: plan.checks.map(c => ({
                               subject: c.id,
                               description: `the ${c.kind} check of '${
                                   c.constraint}' on ${c.entity}${
                                   c.field ? `.${c.field}` : ''} executes`,
                               comparison: 'executes',
                               graphQuery: false,
                               sql: c.sql,
                               compileOnly: [c.examplesSql],
                               resultColumns: ['violations', 'total'],
                             })),
      skipped: plan.unsupported.map(
          u => ({subject: u.constraint, reason: `no query: ${u.reason}`})),
      warnings: plan.warnings,
    };
  },
};

/**
 * Every generator `kcmd test` runs, in report order.
 *
 * Adding a family is adding a generator here: the planner assigns ids, and the
 * runner, the report, the manifest and the CLI need no change. A generator
 * reads only the ContractContext, builds its SQL with the exported helpers
 * (graphTableSql, sameRowsSql, rowKey, cte, q) and the context's Binder, and
 * returns a skip with a reason for every element it recognises but cannot
 * test. See "Contract tests" in docs/semantic-model/validation.md.
 */
export const CONTRACT_TEST_GENERATORS: readonly ContractTestGenerator[] = [
  definedMembershipTests,
  transitiveClosureTests,
  validationQueryTests,

  // Extension point (K2, derived edges): a generator of kind `derived-edge`
  // whose actual side reads the derived edge label and whose expected side
  // follows its explicit multi-hop path (sameRows over source/destination
  // keys).

  // Extension point (K6, metric slices): a generator of kind `metric-slice`
  // whose actual side is GRAPH_EXPAND + AGG and whose expected side is the
  // reference SQL aggregate (sameRows over the dimension columns and the
  // rounded measure; graphQuery false, as GRAPH_EXPAND runs on demand).
];

export interface ContractPlanOptions {
  /** The k of quantified paths. Default DEFAULT_PATH_BOUND. */
  pathBound?: number;
  /** Run only these generator kinds. */
  kinds?: string[];
  /** Replaces CONTRACT_TEST_GENERATORS. */
  generators?: readonly ContractTestGenerator[];
}

/**
 * Generates the contract tests for `model`: the AUTHORED model merged with the
 * selected binding profile (not inheritance-resolved), as `kcmd validate`
 * plans it.
 */
export function planContractTests(
    model: SemanticModel, options: ContractPlanOptions = {}): ContractPlan {
  const warnings: string[] = [];
  let graph: string|undefined;
  try {
    const target = bigQueryGraphTargets(model).targets[0];
    if (target) graph = `${target.project}.${target.dataset}.${target.graphName}`;
  } catch (e) {
    warnings.push(e instanceof Error ? e.message : String(e));
  }
  const binder = new Binder(model);
  const ctx: ContractContext = {
    model,
    graph,
    binder,
    // What push deploys: the same model pruned of what the binding leaves
    // unbound (the profile name only labels pruneUnavailable's report).
    shape: graphShape(binder, pruneUnavailable(model, '').model),
    pathBound: options.pathBound ?? DEFAULT_PATH_BOUND,
  };
  const tests: ContractTest[] = [];
  const skipped: ContractSkip[] = [];
  const ids = new Set<string>();
  for (const g of options.generators ?? CONTRACT_TEST_GENERATORS) {
    if (options.kinds && !options.kinds.includes(g.kind)) continue;
    const out = g.generate(ctx);
    for (const t of out.tests) {
      const base = `${g.kind}:${t.subject}`;
      let id = base;
      for (let i = 2; ids.has(id); i++) id = `${base}_${i}`;
      ids.add(id);
      tests.push({id, kind: g.kind, ...t});
    }
    for (const s of out.skipped) skipped.push({kind: g.kind, ...s});
    warnings.push(...(out.warnings ?? []));
  }
  warnings.push(...binder.warnings);
  return {
    model: model.name,
    ...(graph ? {graph} : {}),
    tests,
    skipped,
    warnings: [...new Set(warnings)],
  };
}


// ---------------------------------------------------------------------------
// Artifacts: the .sql file and the JSON manifest.
// ---------------------------------------------------------------------------

export interface ContractMeta {
  profile: string;
  generatedAt?: string;
}

/** Every test's statement, each under a comment naming it. */
export function renderContractSql(plan: ContractPlan, meta: ContractMeta): string {
  const lines = [
    `-- kcmd contract tests for model '${plan.model}' (profile '${
        meta.profile}')${meta.generatedAt ? `, generated ${meta.generatedAt}` : ''}.`,
    `-- Graph: ${plan.graph ? q(plan.graph) : 'none declared'}. ${
        plan.tests.length} test(s); ${plan.skipped.length} element(s) not tested.`,
    '-- Every statement is a query: running this file writes nothing.',
  ];
  for (const t of plan.tests) {
    lines.push('', `-- [${t.id}] ${t.description}`, `${t.sql};`);
  }
  if (plan.skipped.length) {
    lines.push('', '-- Not tested:');
    for (const s of plan.skipped) {
      lines.push(`--   ${s.kind}:${s.subject}: ${s.reason}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** The machine-readable plan. */
export function contractManifest(plan: ContractPlan, meta: ContractMeta) {
  return {
    model: plan.model,
    profile: meta.profile,
    ...(meta.generatedAt ? {generatedAt: meta.generatedAt} : {}),
    graph: plan.graph ?? null,
    tests: plan.tests,
    skipped: plan.skipped,
    warnings: plan.warnings,
  };
}


// ---------------------------------------------------------------------------
// Results.
// ---------------------------------------------------------------------------

export type ContractStatus = 'pass'|'fail'|'error'|'skipped';

export interface ContractResult {
  id: string;
  kind: string;
  subject: string;
  status: ContractStatus;
  /** Why the test errored or was skipped. */
  reason?: string;
  /** The error BigQuery returned, when a test was skipped because of one. */
  error?: string;
  /** sameRows: distinct rows on each side and the differences. */
  actualRows?: number;
  expectedRows?: number;
  missing?: number;
  extra?: number;
  missingExamples?: string[];
  extraExamples?: string[];
  /** executes: the first result row, by resultColumns. */
  values?: Record<string, string|null>;
  checkedAt: string;
}

/** What one statement returned: rows (cells as strings or null), or an error. */
export interface QueryOutcome {
  rows?: (string|null)[][];
  error?: string;
}

/** BigQuery refused a graph query because the project lacks a reservation. */
export function isReservationError(message: string): boolean {
  return /enterprise/i.test(message) && /reservation|edition/i.test(message);
}

/** A test's result from what its statement returned. */
export function contractResult(
    test: ContractTest, outcome: QueryOutcome, checkedAt: string): ContractResult {
  const base = {id: test.id, kind: test.kind, subject: test.subject};
  if (outcome.error !== undefined) {
    if (test.graphQuery && isReservationError(outcome.error)) {
      return {
        ...base,
        status: 'skipped',
        reason: ENTERPRISE_RESERVATION,
        error: outcome.error,
        checkedAt,
      };
    }
    return {...base, status: 'error', reason: outcome.error, checkedAt};
  }
  const row = outcome.rows?.[0];
  if (test.comparison === 'executes') {
    const values = row && test.resultColumns ?
        Object.fromEntries(test.resultColumns.map((c, i) => [c, row[i] ?? null])) :
        undefined;
    return {...base, status: 'pass', ...(values ? {values} : {}), checkedAt};
  }
  if (!row) return {...base, status: 'error', reason: 'no result row', checkedAt};
  const count = (i: number) => Number(row[i] ?? 0);
  const list = (i: number) => (row[i] ?? '').split(' | ').filter(Boolean);
  const missing = count(2);
  const extra = count(3);
  return {
    ...base,
    status: missing === 0 && extra === 0 ? 'pass' : 'fail',
    actualRows: count(0),
    expectedRows: count(1),
    missing,
    extra,
    ...(missing ? {missingExamples: list(4)} : {}),
    ...(extra ? {extraExamples: list(5)} : {}),
    checkedAt,
  };
}

function firstLine(s: string): string {
  return s.split('\n')[0];
}

function detail(r: ContractResult): string {
  if (r.status === 'error') return firstLine(r.reason ?? '');
  if (r.status === 'skipped') return r.reason ?? '';
  if (r.values) {
    return Object.entries(r.values)
        .map(([k, v]) => `${k}=${v ?? 'NULL'}`)
        .join(', ');
  }
  if (r.missing === undefined) return '';
  if (r.status === 'pass') return `${r.actualRows} row(s) on both sides`;
  const parts = [`${r.missing} missing, ${r.extra} extra (actual ${
      r.actualRows}, expected ${r.expectedRows})`];
  if (r.missingExamples?.length) {
    parts.push(`missing: ${r.missingExamples.join(', ')}`);
  }
  if (r.extraExamples?.length) parts.push(`extra: ${r.extraExamples.join(', ')}`);
  return parts.join('; ');
}

/** The console report: one line per test, the totals, then what was not tested. */
export function formatContractResults(
    results: ContractResult[], skipped: ContractSkip[] = []): string {
  const rows = results.map(r => [r.id, r.status, detail(r)]);
  const head = ['TEST', 'STATUS', 'DETAIL'];
  const width = [0, 1].map(
      i => Math.max(head[i].length, ...rows.map(r => r[i].length)));
  const line = (r: string[]) =>
      `${r[0].padEnd(width[0])}  ${r[1].padEnd(width[1])}  ${r[2]}`.trimEnd();
  const n = (s: ContractStatus) => results.filter(r => r.status === s).length;
  const lines = [
    line(head), ...rows.map(line), '',
    `${results.length} test(s): ${n('pass')} pass, ${n('fail')} fail, ${
        n('error')} error, ${n('skipped')} skipped`,
  ];
  if (skipped.length) {
    lines.push(`${skipped.length} element(s) not tested:`);
    for (const s of skipped) lines.push(`  ${s.kind}:${s.subject}: ${s.reason}`);
  }
  return lines.join('\n');
}


// ---------------------------------------------------------------------------
// Running (network).
// ---------------------------------------------------------------------------

/** Runs one statement (or only compiles it, `dryRun`). */
export type QueryFn = (sql: string, dryRun: boolean) => Promise<QueryOutcome>;

export interface ContractRunOptions {
  /** Project the query jobs run (and bill) in. Defaults to ctx.project. */
  project?: string;
  /** BigQuery processing location (e.g. US). Inferred when unset. */
  location?: string;
  concurrency?: number;
  maxPolls?: number;
  now?: () => Date;
  /** Runs the statements instead of BigQuery (tests). */
  query?: QueryFn;
}

/**
 * Runs every test: each statement is dry-run first (names, access, syntax),
 * then the test's statement runs. Queries only.
 */
export async function runContractTests(
    plan: ContractPlan, ctx: context.ApiContext,
    options: ContractRunOptions = {}): Promise<ContractResult[]> {
  let query = options.query;
  if (!query) {
    const client = new BigQueryClient(ctx);
    const project = options.project ?? ctx.project;
    const maxPolls = options.maxPolls ?? 60;
    query = (sql, dryRun) =>
        runQuery(client, project, sql, options.location, dryRun, maxPolls);
  }
  const run = query;
  const now = options.now ?? (() => new Date());
  const runOne = async (test: ContractTest): Promise<ContractResult> => {
    for (const sql of [...(test.compileOnly ?? []), test.sql]) {
      const dry = await run(sql, true);
      if (dry.error !== undefined) {
        return contractResult(test, {error: dry.error}, now().toISOString());
      }
    }
    return contractResult(test, await run(test.sql, false), now().toISOString());
  };

  const results: ContractResult[] = new Array(plan.tests.length);
  let next = 0;
  const worker = async () => {
    while (next < plan.tests.length) {
      const i = next++;
      results[i] = await runOne(plan.tests[i]);
    }
  };
  await Promise.all(Array.from(
      {length: Math.max(1, Math.min(options.concurrency ?? 4, plan.tests.length))},
      worker));
  return results;
}
