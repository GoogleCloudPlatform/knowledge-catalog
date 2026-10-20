// Behavior specification for model-derived contract tests
// (`kcmd test --target bigquery`, src/libts/semantic/contract_tests.ts).
//
// The claims under test:
//
//   - Generation is a pure function of the model: K1 membership, transitive
//     closure and K4 validation-query tests, with golden SQL, and a reason for
//     every element that cannot be tested (no silent drops).
//   - The registry is open: a generator added to the list (or passed in) gets
//     ids, filtering and reporting for free.
//   - The runner's decisions: pass / fail from the row-set comparison, error,
//     and `needs Enterprise reservation` as a skip for graph queries only.
//   - The TPC-H codelab model (docs/semantic-model/codelab.md) generates its
//     tests locally; running them needs its tables and graph deployed, so
//     generation is what is checked here.
//   - The CLI seam: `--sql-only` writes the .sql file and the manifest.
//
// Nothing here opens a network connection.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiContext} from '../../../src/libts/gcp/context';
import {CONTRACT_TEST_GENERATORS, ContractPlan, contractResult, ContractResult, ContractTest, ContractTestGenerator, ENTERPRISE_RESERVATION, formatContractResults, planContractTests, q, QueryOutcome, renderContractSql, runContractTests,} from '../../../src/libts/semantic/contract_tests';
import {Constraint, Field, SemanticModel} from '../../../src/libts/semantic/ir';
import {loadSemanticModels} from '../../../src/libts/semantic/loader';
import {mergeProfileOntoDoc} from '../../../src/libts/semantic/resolve_profiles';
import {contractTest} from '../../../src/tool/commands';

function target(graph: string): {vendorName: string; data: string} {
  return {
    vendorName: 'GOOGLE',
    data: JSON.stringify({
      deploymentTargets:
          [`//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/${graph}`],
    }),
  };
}

function f(name: string, expression: string, extra: Partial<Field> = {}): Field {
  return {name, expression, type: 'String', ...extra};
}

// Customers place orders; a large order is a defined subset of orders; a
// department is part of a parent department (transitive self-edge); one
// relationship is marked transitive but joins two different entities; one
// defined entity has no parent; one constraint is a hand-written judgment.
function fixture(withGraph = true): SemanticModel {
  return {
    name: 'shop',
    entities: [
      {
        name: 'Customer',
        dataSource: 'p.d.customer',
        keys: ['customerId'],
        fields: [f('customerId', 'customer_id'), f('tier', 'tier')],
      },
      {
        name: 'Order',
        dataSource: 'p.d.orders',
        keys: ['orderId'],
        fields: [
          f('orderId', 'order_id'), f('customerId', 'customer_id'),
          f('amount', 'amount_usd', {type: 'Decimal'}), f('status', 'status'),
        ],
      },
      {
        name: 'LargeOrder',
        extends: ['Order'],
        dataSource: '',
        keys: [],
        fields: [],
        definition: {expression: 'amount >= 1000'},
      },
      {
        name: 'Department',
        dataSource: 'p.d.department',
        keys: ['departmentId'],
        fields: [f('departmentId', 'dept_id'), f('parentId', 'parent_dept_id')],
      },
      {
        name: 'Unanchored',
        dataSource: '',
        keys: [],
        fields: [],
        definition: {expression: 'tier = \'gold\''},
      },
    ],
    relationships: [
      {
        name: 'placedBy',
        source: {entity: 'Order', columns: ['customerId']},
        destination: {entity: 'Customer', columns: ['customerId']},
      },
      {
        name: 'partOf',
        source: {entity: 'Department', columns: ['parentId']},
        destination: {entity: 'Department', columns: ['departmentId']},
        aiContext: {
          instructions: 'partOf is transitive: only direct edges are stored.',
        },
      },
      {
        name: 'servedBy',
        source: {entity: 'Order', columns: ['customerId']},
        destination: {entity: 'Customer', columns: ['customerId']},
        aiContext: {instructions: 'servedBy is transitive.'},
      },
    ],
    metrics: [],
    constraints: [
      {
        name: 'Order_status_required',
        judgment: 'Every order has a status.',
        description: 'Generated. (From SHACL: OrderShape, status sh:minCount 1.)',
      } as Constraint,
      {
        name: 'Order_reviewed',
        judgment: 'Every order is reviewed by a person.',
      } as Constraint,
    ],
    ...(withGraph ? {customExtensions: [target('g')]} : {}),
  };
}

const LARGE_ORDER_SQL = `WITH actual AS (
  SELECT *
  FROM GRAPH_TABLE(
    \`p.d.g\`
    MATCH (n:\`Order\`)
    WHERE n.\`isLargeOrder\`
    COLUMNS (n.\`orderId\` AS \`orderId\`)
  )
),
expected AS (
  SELECT order_id AS \`orderId\`
  FROM \`p.d.orders\`
  WHERE (COALESCE(amount_usd >= 1000, FALSE))
),
actual_keys AS (
  SELECT DISTINCT CAST(\`orderId\` AS STRING) AS k
  FROM actual
),
expected_keys AS (
  SELECT DISTINCT CAST(\`orderId\` AS STRING) AS k
  FROM expected
),
missing AS (
  SELECT k FROM expected_keys
  EXCEPT DISTINCT
  SELECT k FROM actual_keys
),
extra AS (
  SELECT k FROM actual_keys
  EXCEPT DISTINCT
  SELECT k FROM expected_keys
)
SELECT
  (SELECT COUNT(*) FROM actual_keys) AS actual_rows,
  (SELECT COUNT(*) FROM expected_keys) AS expected_rows,
  (SELECT COUNT(*) FROM missing) AS missing,
  (SELECT COUNT(*) FROM extra) AS extra,
  ARRAY_TO_STRING(ARRAY(SELECT IFNULL(k, 'NULL') FROM missing ORDER BY k LIMIT 5), ' | ') AS missing_examples,
  ARRAY_TO_STRING(ARRAY(SELECT IFNULL(k, 'NULL') FROM extra ORDER BY k LIMIT 5), ' | ') AS extra_examples`;

const PART_OF_SQL = `WITH RECURSIVE edges AS (
  SELECT CONCAT('Department:', CAST(s.\`departmentId\` AS STRING)) AS src, CONCAT('Department:', CAST(d.\`departmentId\` AS STRING)) AS dst
  FROM (
    SELECT dept_id AS \`departmentId\`, parent_dept_id AS \`parentId\`
    FROM \`p.d.department\`
  ) AS s
  JOIN (
    SELECT dept_id AS \`departmentId\`
    FROM \`p.d.department\`
  ) AS d ON s.\`parentId\` = d.\`departmentId\`
),
closure AS (
  SELECT src, dst, 1 AS hops
  FROM edges
  UNION ALL
  SELECT c.src, e.dst, c.hops + 1
  FROM closure AS c
  JOIN edges AS e ON e.src = c.dst
  WHERE c.hops < 10
),
actual AS (
  SELECT CONCAT('Department:', CAST(\`src_departmentId\` AS STRING)) AS src, CONCAT('Department:', CAST(\`dst_departmentId\` AS STRING)) AS dst
  FROM (
    SELECT *
    FROM GRAPH_TABLE(
      \`p.d.g\`
      MATCH (a:\`Department\`)-[:\`partOf\`]->{1,10}(b:\`Department\`)
      COLUMNS (a.\`departmentId\` AS \`src_departmentId\`, b.\`departmentId\` AS \`dst_departmentId\`)
    )
  )
),
expected AS (
  SELECT DISTINCT src, dst
  FROM closure
),
actual_keys AS (
  SELECT DISTINCT TO_JSON_STRING([CAST(\`src\` AS STRING), CAST(\`dst\` AS STRING)]) AS k
  FROM actual
),
expected_keys AS (
  SELECT DISTINCT TO_JSON_STRING([CAST(\`src\` AS STRING), CAST(\`dst\` AS STRING)]) AS k
  FROM expected
),
missing AS (
  SELECT k FROM expected_keys
  EXCEPT DISTINCT
  SELECT k FROM actual_keys
),
extra AS (
  SELECT k FROM actual_keys
  EXCEPT DISTINCT
  SELECT k FROM expected_keys
)
SELECT
  (SELECT COUNT(*) FROM actual_keys) AS actual_rows,
  (SELECT COUNT(*) FROM expected_keys) AS expected_rows,
  (SELECT COUNT(*) FROM missing) AS missing,
  (SELECT COUNT(*) FROM extra) AS extra,
  ARRAY_TO_STRING(ARRAY(SELECT IFNULL(k, 'NULL') FROM missing ORDER BY k LIMIT 5), ' | ') AS missing_examples,
  ARRAY_TO_STRING(ARRAY(SELECT IFNULL(k, 'NULL') FROM extra ORDER BY k LIMIT 5), ' | ') AS extra_examples`;

function byId(plan: ContractPlan, id: string): ContractTest {
  const t = plan.tests.find(x => x.id === id);
  if (!t) throw new Error(`no test ${id} in ${plan.tests.map(x => x.id)}`);
  return t;
}

describe('contract tests: generation from the model', () => {
  test('one test per testable element, in registry order', () => {
    const plan = planContractTests(fixture());
    expect(plan.graph).toBe('p.d.g');
    expect(plan.tests.map(t => t.id)).toEqual([
      'defined-membership:LargeOrder',
      'transitive-closure:partOf',
      'validation-query:Order_status_required',
      'validation-query:Customer_primary_key',
      'validation-query:Order_primary_key',
      'validation-query:Department_primary_key',
      'validation-query:placedBy_references',
      'validation-query:partOf_references',
      'validation-query:servedBy_references',
    ]);
  });

  test('every element it recognises but cannot test is listed with a reason', () => {
    const plan = planContractTests(fixture());
    expect(plan.skipped.map(s => `${s.kind}:${s.subject}`)).toEqual([
      'defined-membership:Unanchored',
      'transitive-closure:servedBy',
      'validation-query:Order_reviewed',
    ]);
    expect(plan.skipped[0].reason)
        .toBe('a defined entity must extend exactly one parent entity, and none is declared');
    expect(plan.skipped[1].reason)
        .toBe('its endpoints differ (\'Order\' -> \'Customer\'), so a path of ' +
              '\'servedBy\' edges cannot continue past one hop');
    expect(plan.skipped[2].reason).toStartWith('no query: ');
  });

  test('K1: graph membership vs the definition over the base table (golden)', () => {
    const t = byId(planContractTests(fixture()), 'defined-membership:LargeOrder');
    expect(t.comparison).toBe('sameRows');
    expect(t.graphQuery).toBe(true);
    expect(t.description)
        .toBe('the graph property Order.isLargeOrder holds for exactly the ' +
              'Order rows that satisfy LargeOrder (amount >= 1000)');
    expect(t.sql).toBe(LARGE_ORDER_SQL);
    expect(t.expectedSql)
        .toBe('SELECT order_id AS `orderId`\nFROM `p.d.orders`\n' +
              'WHERE (COALESCE(amount_usd >= 1000, FALSE))');
  });

  test('transitive: bounded quantified path vs a recursive CTE (golden)', () => {
    const t = byId(planContractTests(fixture()), 'transitive-closure:partOf');
    expect(t.graphQuery).toBe(true);
    expect(t.sql).toBe(PART_OF_SQL);
    expect(t.expectedSql).toStartWith('WITH RECURSIVE edges AS (');
    expect(t.expectedSql).toEndWith('SELECT DISTINCT src, dst\nFROM closure');
  });

  test('the path bound is the k of {1,k} and of the CTE depth', () => {
    const t = byId(planContractTests(fixture(), {pathBound: 3}),
                   'transitive-closure:partOf');
    expect(t.sql).toContain('-[:`partOf`]->{1,3}(b:`Department`)');
    expect(t.sql).toContain('WHERE c.hops < 3');
  });

  test('K4: each validation check executes; its examples query compiles', () => {
    const t = byId(planContractTests(fixture()), 'validation-query:Order_primary_key');
    expect(t.comparison).toBe('executes');
    expect(t.graphQuery).toBe(false);
    expect(t.sql).toStartWith('WITH focus AS (');
    expect(t.compileOnly?.length).toBe(1);
    expect(t.compileOnly![0]).toContain('LIMIT 5');
    expect(t.resultColumns).toEqual(['violations', 'total']);
  });

  test('without a graph target, graph tests are skipped and K4 still runs', () => {
    const plan = planContractTests(fixture(false));
    expect(plan.graph).toBeUndefined();
    expect(plan.tests.every(t => t.kind === 'validation-query')).toBe(true);
    const reasons = plan.skipped.filter(s => s.kind !== 'validation-query')
                        .map(s => `${s.subject}: ${s.reason}`);
    expect(reasons).toEqual([
      'LargeOrder: the model declares no BigQuery graph deployment target',
      'Unanchored: a defined entity must extend exactly one parent entity, and none is declared',
      'partOf: the model declares no BigQuery graph deployment target',
      'servedBy: the model declares no BigQuery graph deployment target',
    ]);
  });

  test('sub-relationships that carry the label are part of the closure', () => {
    const model = fixture();
    model.relationships.push({
      name: 'subUnitOf',
      extends: ['partOf'],
      source: {entity: 'Department', columns: ['parentId']},
      destination: {entity: 'Department', columns: ['departmentId']},
    });
    const plan = planContractTests(model, {kinds: ['transitive-closure']});
    const t = byId(plan, 'transitive-closure:partOf');
    expect(t.description)
        .toBe('the path (a:Department)-[:partOf]->{1,10}(b:Department) returns ' +
              'exactly the pairs of the transitive closure of \'partOf\' over ' +
              'the edge tables partOf, subUnitOf up to 10 hops');
    // Both edge tables feed the closure, de-duplicated before the walk.
    expect(t.expectedSql)
        .toStartWith('WITH RECURSIVE edges AS (\n  SELECT DISTINCT src, dst\n  FROM (\n');
    expect(t.expectedSql!.split('\n    UNION ALL\n').length).toBe(2);
  });

  test('generation is deterministic and does not mutate the model', () => {
    const model = fixture();
    const before = JSON.stringify(model);
    const a = planContractTests(model);
    const b = planContractTests(model);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(model)).toBe(before);
  });
});

// An org chart: an employee is in a team, a team in a division, a division in
// a parent division. `within` is abstract and marked transitive; each of its
// three sub-relationships joins two of three node tables and carries the
// `within` label.
function orgFixture(): SemanticModel {
  return {
    name: 'org',
    entities: [
      {name: 'OrgMember', abstract: true, dataSource: '', keys: [], fields: []},
      {name: 'OrgUnit', abstract: true, dataSource: '', keys: [], fields: []},
      {
        name: 'Employee',
        extends: ['OrgMember'],
        dataSource: 'p.d.employee',
        keys: ['employeeId'],
        fields: [f('employeeId', 'employee_id'), f('teamId', 'team_id')],
      },
      {
        name: 'Team',
        extends: ['OrgMember', 'OrgUnit'],
        dataSource: 'p.d.team',
        keys: ['teamId'],
        fields: [f('teamId', 'team_id'), f('divisionId', 'division_id')],
      },
      {
        name: 'Division',
        extends: ['OrgMember', 'OrgUnit'],
        dataSource: 'p.d.division',
        keys: ['divisionId'],
        fields: [f('divisionId', 'division_id'), f('parentId', 'parent_division_id')],
      },
    ],
    relationships: [
      {
        name: 'within',
        abstract: true,
        source: {entity: 'OrgMember', columns: []},
        destination: {entity: 'OrgUnit', columns: []},
        aiContext: {instructions: 'within is transitive.'},
      },
      {
        name: 'inTeam',
        extends: ['within'],
        source: {entity: 'Employee', columns: ['teamId']},
        destination: {entity: 'Team', columns: ['teamId']},
      },
      {
        name: 'teamOf',
        extends: ['within'],
        source: {entity: 'Team', columns: ['divisionId']},
        destination: {entity: 'Division', columns: ['divisionId']},
      },
      {
        name: 'subDivisionOf',
        extends: ['within'],
        source: {entity: 'Division', columns: ['parentId']},
        destination: {entity: 'Division', columns: ['divisionId']},
      },
    ],
    metrics: [],
    customExtensions: [target('g')],
  };
}

// The comparison every closure statement ends with (see PART_OF_SQL).
const CLOSURE_TAIL = PART_OF_SQL.slice(PART_OF_SQL.indexOf('\nexpected AS ('));

const WITHIN_SQL = `WITH RECURSIVE edges AS (
  SELECT DISTINCT src, dst
  FROM (
    SELECT CONCAT('Employee:', CAST(s.\`employeeId\` AS STRING)) AS src, CONCAT('Team:', CAST(d.\`teamId\` AS STRING)) AS dst
    FROM (
      SELECT employee_id AS \`employeeId\`, team_id AS \`teamId\`
      FROM \`p.d.employee\`
    ) AS s
    JOIN (
      SELECT team_id AS \`teamId\`
      FROM \`p.d.team\`
    ) AS d ON s.\`teamId\` = d.\`teamId\`
    UNION ALL
    SELECT CONCAT('Team:', CAST(s.\`teamId\` AS STRING)) AS src, CONCAT('Division:', CAST(d.\`divisionId\` AS STRING)) AS dst
    FROM (
      SELECT team_id AS \`teamId\`, division_id AS \`divisionId\`
      FROM \`p.d.team\`
    ) AS s
    JOIN (
      SELECT division_id AS \`divisionId\`
      FROM \`p.d.division\`
    ) AS d ON s.\`divisionId\` = d.\`divisionId\`
    UNION ALL
    SELECT CONCAT('Division:', CAST(s.\`divisionId\` AS STRING)) AS src, CONCAT('Division:', CAST(d.\`divisionId\` AS STRING)) AS dst
    FROM (
      SELECT division_id AS \`divisionId\`, parent_division_id AS \`parentId\`
      FROM \`p.d.division\`
    ) AS s
    JOIN (
      SELECT division_id AS \`divisionId\`
      FROM \`p.d.division\`
    ) AS d ON s.\`parentId\` = d.\`divisionId\`
  )
),
closure AS (
  SELECT src, dst, 1 AS hops
  FROM edges
  UNION ALL
  SELECT c.src, e.dst, c.hops + 1
  FROM closure AS c
  JOIN edges AS e ON e.src = c.dst
  WHERE c.hops < 10
),
actual AS (
  SELECT CONCAT('Employee:', CAST(\`src_employeeId\` AS STRING)) AS src, CONCAT('Team:', CAST(\`dst_teamId\` AS STRING)) AS dst
  FROM (
    SELECT *
    FROM GRAPH_TABLE(
      \`p.d.g\`
      MATCH (a:\`Employee\`)-[:\`within\`]->{1,10}(b:\`Team\`)
      COLUMNS (a.\`employeeId\` AS \`src_employeeId\`, b.\`teamId\` AS \`dst_teamId\`)
    )
  )
  UNION ALL
  SELECT CONCAT('Employee:', CAST(\`src_employeeId\` AS STRING)) AS src, CONCAT('Division:', CAST(\`dst_divisionId\` AS STRING)) AS dst
  FROM (
    SELECT *
    FROM GRAPH_TABLE(
      \`p.d.g\`
      MATCH (a:\`Employee\`)-[:\`within\`]->{1,10}(b:\`Division\`)
      COLUMNS (a.\`employeeId\` AS \`src_employeeId\`, b.\`divisionId\` AS \`dst_divisionId\`)
    )
  )
  UNION ALL
  SELECT CONCAT('Team:', CAST(\`src_teamId\` AS STRING)) AS src, CONCAT('Division:', CAST(\`dst_divisionId\` AS STRING)) AS dst
  FROM (
    SELECT *
    FROM GRAPH_TABLE(
      \`p.d.g\`
      MATCH (a:\`Team\`)-[:\`within\`]->{1,10}(b:\`Division\`)
      COLUMNS (a.\`teamId\` AS \`src_teamId\`, b.\`divisionId\` AS \`dst_divisionId\`)
    )
  )
  UNION ALL
  SELECT CONCAT('Division:', CAST(\`src_divisionId\` AS STRING)) AS src, CONCAT('Division:', CAST(\`dst_divisionId\` AS STRING)) AS dst
  FROM (
    SELECT *
    FROM GRAPH_TABLE(
      \`p.d.g\`
      MATCH (a:\`Division\`)-[:\`within\`]->{1,10}(b:\`Division\`)
      COLUMNS (a.\`divisionId\` AS \`src_divisionId\`, b.\`divisionId\` AS \`dst_divisionId\`)
    )
  )
),${CLOSURE_TAIL}`;

function matches(sql: string|undefined): string[] {
  return [...(sql ?? '').matchAll(/MATCH (.*)/g)].map(m => m[1]);
}

describe('contract tests: transitive closure over a relationship hierarchy', () => {
  test('an abstract relationship is tested over its sub-relationships\' edges (golden)', () => {
    const plan = planContractTests(orgFixture(), {kinds: ['transitive-closure']});
    expect(plan.skipped).toEqual([]);
    const t = byId(plan, 'transitive-closure:within');
    expect(t.graphQuery).toBe(true);
    expect(t.description)
        .toBe('the path (a)-[:within]->{1,10}(b) returns exactly the pairs of ' +
              'the transitive closure of \'within\' over the edge tables inTeam, ' +
              'teamOf, subDivisionOf up to 10 hops');
    expect(t.sql).toBe(WITHIN_SQL);
  });

  test('one quantified path per pair of node tables a path can join', () => {
    const t = byId(planContractTests(orgFixture(), {pathBound: 1}),
                   'transitive-closure:within');
    // With k = 1 no path goes past one edge: Employee no longer reaches Division.
    expect(matches(t.actualSql)).toEqual([
      '(a:`Employee`)-[:`within`]->{1,1}(b:`Team`)',
      '(a:`Team`)-[:`within`]->{1,1}(b:`Division`)',
      '(a:`Division`)-[:`within`]->{1,1}(b:`Division`)',
    ]);
  });

  test('a subtype\'s node table is read under its own label only', () => {
    const model = orgFixture();
    model.entities.push({
      name: 'Subsidiary',
      extends: ['Division'],
      dataSource: 'p.d.subsidiary',
      keys: ['divisionId'],
      fields: [f('divisionId', 'division_id'), f('parentId', 'parent_division_id')],
    });
    model.relationships.push({
      name: 'subsidiaryOf',
      extends: ['within'],
      source: {entity: 'Subsidiary', columns: ['parentId']},
      destination: {entity: 'Division', columns: ['divisionId']},
    });
    const t = byId(planContractTests(model), 'transitive-closure:within');
    expect(matches(t.actualSql)).toEqual([
      '(a:`Employee`)-[:`within`]->{1,10}(b:`Team`)',
      '(a:`Employee`)-[:`within`]->{1,10}(b:`Division`&!`Subsidiary`)',
      '(a:`Team`)-[:`within`]->{1,10}(b:`Division`&!`Subsidiary`)',
      '(a:`Division`&!`Subsidiary`)-[:`within`]->{1,10}(b:`Division`&!`Subsidiary`)',
      '(a:`Subsidiary`)-[:`within`]->{1,10}(b:`Division`&!`Subsidiary`)',
    ]);
    // A Division row is read from the division table alone, not unioned with
    // the subsidiary table: only the subsidiaryOf edges read that one.
    expect(t.expectedSql!.split('FROM `p.d.subsidiary`').length - 1).toBe(1);
  });

  test('an edge whose join field the binding leaves unbound reads the column ' +
           'it names, as the deployed edge table does',
       () => {
         const model = orgFixture();
         model.entities.find(e => e.name === 'Team')!.fields =
             [f('teamId', 'team_id'), {name: 'divisionId', type: 'String'}];
         const t = byId(planContractTests(model), 'transitive-closure:within');
         expect(t.description)
             .toContain('over the edge tables inTeam, teamOf, subDivisionOf up to');
         expect(t.expectedSql)
             .toContain('SELECT team_id AS `teamId`, divisionId AS `divisionId`\n');
         expect(matches(t.actualSql)).toEqual([
           '(a:`Employee`)-[:`within`]->{1,10}(b:`Team`)',
           '(a:`Employee`)-[:`within`]->{1,10}(b:`Division`)',
           '(a:`Team`)-[:`within`]->{1,10}(b:`Division`)',
           '(a:`Division`)-[:`within`]->{1,10}(b:`Division`)',
         ]);
       });

  test('what cannot be tested says why', () => {
    const reasons = (model: SemanticModel) =>
        planContractTests(model, {kinds: ['transitive-closure']})
            .skipped.map(s => s.reason);
    const bare = orgFixture();
    bare.relationships = bare.relationships.filter(r => r.name === 'within');
    expect(reasons(bare))
        .toEqual(['it is abstract and no edge table in the graph carries its label']);
    const flat = orgFixture();
    flat.relationships =
        flat.relationships.filter(r => r.name === 'within' || r.name === 'inTeam');
    expect(reasons(flat)).toEqual([
      'no edge labelled \'within\' starts at a node table where another one ' +
          'ends, so a path cannot continue past one hop',
    ]);
    const junction = orgFixture();
    junction.relationships.find(r => r.name === 'inTeam')!.association = {
      dataSource: 'p.d.team_member',
      keys: ['employee_id', 'team_id'],
      sourceColumns: ['employee_id'],
      destinationColumns: ['team_id'],
    };
    expect(reasons(junction))
        .toEqual(['sub-relationship \'inTeam\' is backed by an association table']);
  });
});

describe('contract tests: the registry is open', () => {
  // A family another branch could add: one row count per node table.
  const rowCounts: ContractTestGenerator = {
    kind: 'row-count',
    summary: 'Every node table can be counted.',
    generate: ctx => ({
      tests: [...ctx.shape.nodeTables].map(name => ({
                                            subject: name,
                                            description: `${name} can be counted`,
                                            comparison: 'executes',
                                            graphQuery: false,
                                            sql: `SELECT COUNT(*) FROM ${q(name)}`,
                                          })),
      skipped: [],
    }),
  };

  test('built-in kinds, in report order', () => {
    expect(CONTRACT_TEST_GENERATORS.map(g => g.kind)).toEqual([
      'defined-membership', 'transitive-closure', 'validation-query',
    ]);
  });

  test('an added generator gets ids and kind filtering for free', () => {
    const plan = planContractTests(fixture(), {
      generators: [...CONTRACT_TEST_GENERATORS, rowCounts],
      kinds: ['row-count'],
    });
    expect(plan.tests.map(t => t.id)).toEqual([
      'row-count:Customer', 'row-count:Order', 'row-count:Department',
    ]);
    expect(plan.tests.every(t => t.kind === 'row-count')).toBe(true);
  });

  test('repeated subjects get distinct ids', () => {
    const twice: ContractTestGenerator = {
      ...rowCounts,
      kind: 'twice',
      generate: ctx => {
        const one = rowCounts.generate(ctx).tests[0];
        return {tests: [one, one], skipped: []};
      },
    };
    const plan = planContractTests(fixture(), {generators: [twice]});
    expect(plan.tests.map(t => t.id)).toEqual(['twice:Customer', 'twice:Customer_2']);
  });
});

describe('contract tests: outcomes', () => {
  const plan = planContractTests(fixture());
  const k1 = byId(plan, 'defined-membership:LargeOrder');
  const k4 = byId(plan, 'validation-query:Order_primary_key');
  const at = '2026-01-01T00:00:00.000Z';
  const RESERVATION =
      'Graph queries require a reservation with Enterprise or Enterprise Plus edition.';

  test('equal row sets pass', () => {
    expect(contractResult(k1, {rows: [['3', '3', '0', '0', '', '']]}, at)).toEqual({
      id: 'defined-membership:LargeOrder',
      kind: 'defined-membership',
      subject: 'LargeOrder',
      status: 'pass',
      actualRows: 3,
      expectedRows: 3,
      missing: 0,
      extra: 0,
      checkedAt: at,
    });
  });

  test('a difference fails and carries examples', () => {
    const r = contractResult(k1, {rows: [['2', '4', '2', '0', '17 | 21', '']]}, at);
    expect(r.status).toBe('fail');
    expect(r.missing).toBe(2);
    expect(r.missingExamples).toEqual(['17', '21']);
    expect(r.extraExamples).toBeUndefined();
  });

  test('a reservation refusal skips a graph test ...', () => {
    const r = contractResult(k1, {error: RESERVATION}, at);
    expect(r.status).toBe('skipped');
    expect(r.reason).toBe(ENTERPRISE_RESERVATION);
    expect(r.error).toBe(RESERVATION);
  });

  test('... but is an error for a test that does not query the graph', () => {
    expect(contractResult(k4, {error: RESERVATION}, at).status).toBe('error');
  });

  test('an executed statement passes and reports its first row', () => {
    expect(contractResult(k4, {rows: [['0', '10']]}, at).values)
        .toEqual({violations: '0', total: '10'});
  });

  test('a comparison that returns no row is an error', () => {
    expect(contractResult(k1, {rows: []}, at).status).toBe('error');
  });
});

describe('contract tests: the runner', () => {
  test('dry-runs every statement, then runs the test statement', async () => {
    const plan = planContractTests(fixture(), {kinds: ['validation-query']});
    plan.tests = plan.tests.slice(0, 1);
    const calls: string[] = [];
    const query = async (sql: string, dryRun: boolean): Promise<QueryOutcome> => {
      calls.push(`${dryRun ? 'dry' : 'run'}:${sql.includes('LIMIT') ? 'examples' : 'count'}`);
      return {rows: dryRun ? [] : [['0', '4']]};
    };
    const [r] = await runContractTests(
        plan, new ApiContext('p', 'us', 'token'), {query, now: () => new Date(0)});
    expect(calls).toEqual(['dry:examples', 'dry:count', 'run:count']);
    expect(r.status).toBe('pass');
    expect(r.values).toEqual({violations: '0', total: '4'});
  });

  test('a failing dry run stops the test before it runs', async () => {
    const plan = planContractTests(fixture(), {kinds: ['defined-membership']});
    let runs = 0;
    const query = async (_sql: string, dryRun: boolean): Promise<QueryOutcome> => {
      if (!dryRun) runs++;
      return dryRun ? {error: 'Graph queries need an Enterprise edition reservation'} :
                      {rows: []};
    };
    const results = await runContractTests(
        plan, new ApiContext('p', 'us', 'token'), {query});
    expect(runs).toBe(0);
    expect(results.map(r => `${r.id} ${r.status} ${r.reason}`)).toEqual([
      `defined-membership:LargeOrder skipped ${ENTERPRISE_RESERVATION}`,
    ]);
  });
});

describe('contract tests: report and artifacts', () => {
  test('the console table, totals and what was not tested (golden)', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const results: ContractResult[] = [
      {id: 'defined-membership:LargeOrder', kind: 'defined-membership', subject: 'LargeOrder',
       status: 'pass', actualRows: 3, expectedRows: 3, missing: 0, extra: 0, checkedAt: at},
      {id: 'transitive-closure:partOf', kind: 'transitive-closure', subject: 'partOf',
       status: 'skipped', reason: ENTERPRISE_RESERVATION, checkedAt: at},
      {id: 'validation-query:Order_primary_key', kind: 'validation-query',
       subject: 'Order_primary_key', status: 'pass', values: {violations: '0', total: '10'},
       checkedAt: at},
      {id: 'validation-query:placedBy_references', kind: 'validation-query',
       subject: 'placedBy_references', status: 'error', reason: 'Not found: Table p:d.orders\nmore',
       checkedAt: at},
      {id: 'defined-membership:VipCustomer', kind: 'defined-membership', subject: 'VipCustomer',
       status: 'fail', actualRows: 2, expectedRows: 3, missing: 1, extra: 0,
       missingExamples: ['c9'], checkedAt: at},
    ];
    const skipped = [{kind: 'transitive-closure', subject: 'servedBy', reason: 'its endpoints differ'}];
    expect(formatContractResults(results, skipped)).toBe([
      'TEST                                  STATUS   DETAIL',
      'defined-membership:LargeOrder         pass     3 row(s) on both sides',
      'transitive-closure:partOf             skipped  needs Enterprise reservation',
      'validation-query:Order_primary_key    pass     violations=0, total=10',
      'validation-query:placedBy_references  error    Not found: Table p:d.orders',
      'defined-membership:VipCustomer        fail     1 missing, 0 extra (actual 2, expected 3); missing: c9',
      '',
      '5 test(s): 2 pass, 1 fail, 1 error, 1 skipped',
      '1 element(s) not tested:',
      '  transitive-closure:servedBy: its endpoints differ',
    ].join('\n'));
  });

  test('the .sql file names every test and every element not tested', () => {
    const plan = planContractTests(fixture());
    const sql = renderContractSql(plan, {profile: 'bigquery'});
    expect(sql.split('\n').slice(0, 3)).toEqual([
      '-- kcmd contract tests for model \'shop\' (profile \'bigquery\').',
      '-- Graph: `p.d.g`. 9 test(s); 3 element(s) not tested.',
      '-- Every statement is a query: running this file writes nothing.',
    ]);
    expect(sql).toContain(`-- [defined-membership:LargeOrder] ${
        byId(plan, 'defined-membership:LargeOrder').description}\n${LARGE_ORDER_SQL};`);
    expect(sql).toContain('--   transitive-closure:servedBy: its endpoints differ');
    // Read-only: no statement writes.
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|CREATE|DROP|TRUNCATE)\b/);
  });
});

// The TPC-H codelab model and its analytical binding profile, as written in
// docs/semantic-model/codelab.md (steps 1 and 3). The codelab creates its
// tables and deploys its graph before querying; neither is done here, so this
// checks generation only.
const CODELAB_MODEL = `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    description: Orders, line items, and customers for the codelab
    entities:
      - name: orders
        primary_key: [order_id]
        fields:
          - { name: order_id,    datatype: Integer }
          - { name: customer_id, datatype: Integer }
          - { name: net_amount,  datatype: Decimal }
      - name: customer
        primary_key: [customer_id]
        fields:
          - { name: customer_id, datatype: Integer }
          - { name: name,        datatype: String }
      - name: lineitem
        primary_key: [line_id]
        fields:
          - { name: line_id,  datatype: Integer }
          - { name: order_id, datatype: Integer }
    relationships:
      - name: placed_by
        from: orders
        to: customer
        from_columns: [customer_id]
        to_columns: [customer_id]
      - name: part_of
        from: lineitem
        to: orders
        from_columns: [order_id]
        to_columns: [order_id]
    metrics:
      - name: revenue
        datatype: Decimal
        expression:
          dialects: [{ dialect: BIGQUERY, expression: SUM(orders.net_amount) }]
`;

const CODELAB_PROFILE = `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    deployment_target: //bigquery.googleapis.com/projects/codelab-project/datasets/codelab_ds/propertyGraphs/sales
    entities:
      - name: orders
        source: codelab-project.codelab_ds.orders
        fields:
          - { name: order_id,    expression: o_orderkey }
          - { name: customer_id, expression: o_custkey }
          - { name: net_amount,  expression: net_amount }
      - name: customer
        source: codelab-project.codelab_ds.customer
        fields:
          - { name: customer_id, expression: c_custkey }
          - { name: name,        expression: c_name }
      - name: lineitem
        source: codelab-project.codelab_ds.lineitem
        fields:
          - { name: line_id,  expression: l_linekey }
          - { name: order_id, expression: l_orderkey }
`;

describe('contract tests: the TPC-H codelab model (generation only)', () => {
  test('generates its validation-query tests; it has nothing for K1 or paths', () => {
    const merged = mergeProfileOntoDoc(CODELAB_MODEL, CODELAB_PROFILE, 'analytical');
    if ('error' in merged) throw new Error(merged.error);
    // Loaded as push loads a `semantic_model:` wrapper profile: the codelab's
    // names its graph with `deployment_target` and its tables by bare name.
    const loaded = loadSemanticModels(
        [{
          name: 'sales',
          text: merged.text,
          allowLegacyBareSource: true,
          excluded: merged.excluded,
        }],
        {bindingOptional: true});
    expect(loaded.error).toBeUndefined();
    const plan = planContractTests(loaded.models[0].model);
    expect(plan.graph).toBe('codelab-project.codelab_ds.sales');
    expect(plan.tests.map(t => t.id)).toEqual([
      'validation-query:orders_primary_key',
      'validation-query:customer_primary_key',
      'validation-query:lineitem_primary_key',
      'validation-query:placed_by_references',
      'validation-query:part_of_references',
    ]);
    expect(plan.skipped).toEqual([]);
    expect(byId(plan, 'validation-query:part_of_references').sql)
        .toContain('`codelab-project.codelab_ds.lineitem`');
  });
});

describe('kcmd test (CLI seam)', () => {
  const CTX = new ApiContext('test-project', 'us', 'test-token');
  let dir = '';
  let logs: string[] = [];

  const MODEL = `version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    entities:
      - name: Order
        primary_key: [orderId]
        fields:
          - { name: orderId, datatype: String }
          - { name: amount,  datatype: Decimal }
      - name: LargeOrder
        extends: [Order]
        defined: "amount >= 1000"
      - name: Department
        primary_key: [departmentId]
        fields:
          - { name: departmentId, datatype: String }
          - { name: parentId,     datatype: String }
    relationships:
      - name: partOf
        from: Department
        to: Department
        from_columns: [parentId]
        to_columns: [departmentId]
        ai_context:
          instructions: partOf is transitive; only direct edges are stored.
`;
  const PROFILE = `version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    deployment_target: //bigquery.googleapis.com/projects/test-project/datasets/shop/propertyGraphs/shop_graph
    entities:
      - name: Order
        source: test-project.shop.orders
        fields:
          - { name: orderId, expression: order_id }
          - { name: amount,  expression: amount_usd }
      - name: Department
        source: test-project.shop.departments
        fields:
          - { name: departmentId, expression: dept_id }
          - { name: parentId,     expression: parent_dept_id }
`;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-contract-'));
    fs.writeFileSync(path.join(dir, 'catalog.yaml'),
                     'scope: semantic-model.test-project.us.shop_eg\ndefault_profile: bigquery\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'shop_eg');
    fs.mkdirSync(path.join(eg, 'shop.profiles'), {recursive: true});
    fs.writeFileSync(path.join(eg, 'shop.yaml'), MODEL);
    fs.writeFileSync(path.join(eg, 'shop.profiles', 'bigquery.yaml'), PROFILE);
    logs = [];
    spyOn(ApiContext, 'default').mockReturnValue(CTX);
    for (const channel of ['log', 'warn', 'error'] as const) {
      spyOn(console, channel).mockImplementation((...a: unknown[]) => {
        logs.push(a.join(' '));
      });
    }
  });

  afterEach(() => {
    if (dir) fs.rmSync(dir, {recursive: true, force: true});
    dir = '';
    mock.restore();
  });

  test('--sql-only writes the tests and the manifest, and runs nothing', async () => {
    expect(await contractTest({target: 'bigquery', sqlOnly: true, cwd: dir, out: 'ct'}))
        .toBe(0);
    const sql = fs.readFileSync(path.join(dir, 'ct', 'shop.contract.sql'), 'utf8');
    const manifest = JSON.parse(
        fs.readFileSync(path.join(dir, 'ct', 'shop.contract.json'), 'utf8'));
    expect(manifest.graph).toBe('test-project.shop.shop_graph');
    expect(manifest.profile).toBe('bigquery');
    expect(manifest.tests.map((t: ContractTest) => t.id)).toEqual([
      'defined-membership:LargeOrder',
      'transitive-closure:partOf',
      'validation-query:Order_primary_key',
      'validation-query:Department_primary_key',
      'validation-query:partOf_references',
    ]);
    expect(sql).toContain('FROM `test-project.shop.orders`');
    expect(sql).toContain('MATCH (a:`Department`)-[:`partOf`]->{1,10}(b:`Department`)');
    expect(fs.existsSync(path.join(dir, 'ct', 'shop.contract-results.json'))).toBe(false);
  });

  test('usage errors exit 1 and write nothing', async () => {
    expect(await contractTest({sqlOnly: true, cwd: dir})).toBe(1);
    expect(await contractTest({target: 'bigquery', sqlOnly: true, cwd: dir, pathBound: '0'}))
        .toBe(1);
    expect(await contractTest({target: 'bigquery', sqlOnly: true, cwd: dir, profile: 'nope'}))
        .toBe(1);
    expect(logs.join('\n')).toContain('--target must be \'bigquery\'');
    expect(logs.join('\n')).toContain('--path-bound must be a whole number >= 1');
    expect(logs.join('\n')).toContain('unknown binding profile \'nope\'');
    expect(fs.existsSync(path.join(dir, 'contract-tests'))).toBe(false);
  });
});
