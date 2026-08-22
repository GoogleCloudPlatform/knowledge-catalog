// Behavior specification for the BigQuery property-graph generator
// (src/libts/semantic/bigquery.ts).
//
// The readable "big picture" tests live in `bigquery.e2e.test.ts`: a corpus of
// `<fixture>.yaml` inputs, each with a committed
// `<fixture>.bigquery.golden.sql` showing the exact generated DDL and warnings.
// Open a `.yaml` next to its golden to see a full translation. Prefer adding a
// fixture + golden there.
//
// This file holds only what a loader fixture CANNOT express, because the open
// AI-first format the loader reads is a subset of the IR:
//   - an M:N association edge (its own backing junction table, KEY, and edge
//     properties) — the open format has no association-table syntax, so its IR
//     is hand-built here and checked against a committed golden file.
//   - IR-contract cases the loader never produces: a COUNT(*) metric with a
//     declared attach entity, and a metric whose declared entity disagrees with
//     its expression (the loader always derives the entity FROM the
//     expression).
//   - degenerate inputs the format forbids (a model with no datasets) and pure
//     GenerateOptions behavior (graph naming; a source `dataSource` is emitted
//     verbatim, never re-qualified from options).
// Plus a structural invariant guard that parses generated DDL and asserts the
// shape BigQuery enforces for measures, run over the loaded fixtures.
//

import {describe, expect, test} from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import {GenerateOptions, generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';

const FIXTURES = path.join(__dirname, 'fixtures');

// Loads a corpus fixture to its IR (same defaults the e2e golden suite uses),
// so the invariant guard below can run over the exact models the goldens
// capture.
function loadFixture(fixture: string): SemanticModel {
  const text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
  const {models} = loadModels(
      text, {defaultProject: 'sqlgen-testing', defaultDataset: 'demo'});
  return models[0];
}
const GEN_OPTS: GenerateOptions = {
  project: 'sqlgen-testing',
  dataset: 'demo'
};


describe(
    'M:N association edge (no association-table syntax in the open format yet)',
    () => {
      // Hand-built because the loader's relationship schema is direct-FK only
      // (from/to/columns) — it cannot express an edge backed by its own
      // association table with its own KEY and edge properties. The expected
      // DDL is a committed golden file
      // (`school_manytomany.bigquery.golden.sql`) so the output stays
      // reviewable as text; these exact strings were run against a live
      // BigQuery instance and traversed with a GQL MATCH.
      const SCHOOL: SemanticModel = {
        name: 'school_graph',
        entities: [
          {
            name: 'students',
            dataSource: 'sqlgen-testing.bei_semantic_ir_verify.students',
            keys: ['student_id'],
            fields: [
              {name: 'student_id', expression: 'students.student_id'},
              {name: 'name', expression: 'students.name'}
            ]
          },
          {
            name: 'courses',
            dataSource: 'sqlgen-testing.bei_semantic_ir_verify.courses',
            keys: ['course_id'],
            fields: [
              {name: 'course_id', expression: 'courses.course_id'},
              {name: 'title', expression: 'courses.title'}
            ]
          },
        ],
        relationships: [
          {
            name: 'enrollment',
            source: {entity: 'students', columns: ['student_id']},
            destination: {entity: 'courses', columns: ['course_id']},
            association: {
              dataSource: 'sqlgen-testing.bei_semantic_ir_verify.enrollment',
              keys: ['enrollment_id'],
              sourceColumns: ['student_id'],
              destinationColumns: ['course_id'],
              fields: [{
                name: 'grade',
                expression: 'enrollment.grade',
                description: 'Letter grade'
              }]
            }
          },
        ],
        metrics: [],
      };
      const SCHOOL_OPTS: GenerateOptions = {
        project: 'sqlgen-testing',
        dataset: 'bei_semantic_ir_verify'
      };

      test('the association graph matches its committed golden DDL', () => {
        const {ddl} = generatePropertyGraph(SCHOOL, SCHOOL_OPTS);
        const golden = fs.readFileSync(
            path.join(FIXTURES, 'school_manytomany.bigquery.golden.sql'),
            'utf8');
        expect(ddl).toBe(golden);
      });
    });


describe('IR-contract metric cases the loader cannot produce', () => {
  // A minimal one-entity model shared by the cases below. Metrics are supplied
  // per test with an explicit `entities`, which is exactly what the loader
  // never does independently of the expression.
  const orders = (): SemanticModel => ({
    name: 'm',
    relationships: [],
    metrics: [],
    entities: [{
      name: 'orders',
      dataSource: 'orders',
      keys: ['o_orderkey'],
      fields: [{name: 'o_orderkey', expression: 'orders.o_orderkey'}]
    }],
  });

  test(
      'COUNT(*) with a declared attach entity lowers to COUNT over the key property',
      () => {
        // COUNT(*) names no column, so it relies on the metric's declared
        // attach entity. The loader always derives the entity from the
        // expression, so a qualifier-free COUNT(*) gets entity:undefined there
        // and is skipped; a producer that declares the attach entity (or
        // hand-built IR) reaches this lowering.
        const model = orders();
        model.metrics =
            [{name: 'order_count', expression: 'COUNT(*)', entity: 'orders'}];
        const {ddl} = generatePropertyGraph(model, GEN_OPTS);
        expect(ddl).toContain('MEASURE(COUNT(o_orderkey)) AS order_count');
      });

  test(
      'a metric whose declared entity disagrees with its expression is reported',
      () => {
        // Declared entity:'orders' but the expression aggregates a different
        // known entity (order_items); the generator places per the expression
        // and surfaces the discrepancy rather than resolving it silently. The
        // loader cannot create this state (it sets entity FROM the expression).
        const model = orders();
        model.entities.push({
          name: 'order_items',
          dataSource: 'order_items',
          keys: ['order_item_id'],
          fields: [
            {name: 'order_item_id', expression: 'order_items.order_item_id'}
          ],
        });
        model.metrics = [{
          name: 'mislabeled',
          expression: 'SUM(order_items.amount)',
          entity: 'orders'
        }];
        const {warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(warnings.some(
                   w => w.includes('metric \'mislabeled\'') &&
                       w.includes('declares entity')))
            .toBe(true);
      });

  test(
      'a metric that spans tables is skipped without a contradictory "placing" note',
      () => {
        // A declared entity that ALSO spans multiple tables must not first be
        // announced as "placing per the expression" and then skipped: the
        // disagreement note is only meaningful when the metric is actually
        // placed on a single table.
        const model = orders();
        model.entities.push({
          name: 'order_items',
          dataSource: 'order_items',
          keys: ['order_item_id'],
          fields: [
            {name: 'order_item_id', expression: 'order_items.order_item_id'}
          ],
        });
        model.metrics = [{
          name: 'cross',
          expression: 'SUM(orders.amount) + SUM(order_items.amount)',
          entity: 'orders',
        }];
        const {warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(warnings.some(w => w.includes('spans multiple tables')))
            .toBe(true);
        expect(warnings.some(w => w.includes('placing per the expression')))
            .toBe(false);
      });

  test(
      'a metric on a keyless (skipped) entity is dropped with a KEY-specific reason',
      () => {
        // The entity has no primary key, so it has no node table to carry a
        // MEASURE. The skip reason must name the missing KEY, not a misleading
        // "aggregate not supported".
        const model = orders();
        model.entities.push(
            {name: 'dim', dataSource: 'dim', keys: [], fields: []});
        model.metrics = [{name: 'dim_total', expression: 'SUM(dim.amount)'}];
        const {warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(warnings.some(
                   w => w.includes('metric \'dim_total\'') &&
                       w.includes('has no KEY')))
            .toBe(true);
        expect(warnings.some(
                   w => w.includes('metric \'dim_total\'') &&
                       w.includes('not a single supported aggregate')))
            .toBe(false);
      });

  test(
      'a backtick-quoted operand with an embedded comma is one operand, not a multi-arg call',
      () => {
        // The operand scanner tracks backticks, so a column like `weird,name`
        // is not mistaken for two aggregate arguments and dropped.
        const model = orders();
        model.metrics = [{
          name: 'weird_sum',
          expression: 'SUM(orders.`weird,name`)',
          entity: 'orders'
        }];
        const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(warnings.some(
                   w => w.includes('metric \'weird_sum\'') &&
                       w.includes('not a single supported aggregate')))
            .toBe(false);
        expect(ddl).toContain('AS weird_sum');
      });
});


describe('degenerate inputs and GenerateOptions behavior', () => {
  test(
      'a model with no entities throws, rather than emit an empty (invalid) graph',
      () => {
        // The open format requires datasets.min(1), so this state is only
        // reachable as hand-built IR. A graph with an empty NODE TABLES block
        // is invalid DDL, so generation fails loudly instead of returning it.
        expect(
            () => generatePropertyGraph(
                {name: 'm', entities: [], relationships: [], metrics: []},
                GEN_OPTS))
            .toThrow(
                /no valid node table|declares no entities|at least one NODE TABLE/);
      });

  test(
      'a model whose every entity lacks a KEY throws, naming the skipped entities',
      () => {
        // Every entity is keyless, so all are skipped and no node table
        // remains; the emitted graph would be empty and invalid. The error
        // carries the per-entity skip reasons so the caller sees why each
        // dropped out.
        expect(
            () => generatePropertyGraph(
                {
                  name: 'm',
                  relationships: [],
                  metrics: [],
                  entities: [
                    {name: 'a', dataSource: 'a', keys: [], fields: []},
                    {name: 'b', dataSource: 'b', keys: [], fields: []},
                  ],
                },
                GEN_OPTS))
            .toThrow(
                /every entity was skipped[\s\S]*entity 'a'[\s\S]*entity 'b'/);
      });

  test(
      'graph name falls back to options, but a dataSource is emitted as-is',
      () => {
        // opts.project/dataset name where the graph is CREATED (the graph
        // name), NOT where a source table lives: the entity's `dataSource` is
        // emitted verbatim, never re-prefixed from opts.
        const model: SemanticModel = {
          name: 'm',
          relationships: [],
          metrics: [],
          entities: [{
            name: 'e',
            dataSource: 't',
            keys: ['id'],
            fields: [{name: 'id', expression: 'e.id'}]
          }],
        };
        const {ddl} = generatePropertyGraph(
            model, {project: 'p', dataset: 'd', graphName: 'g'});
        expect(ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH `p.d.g`');
        expect(ddl).toContain('`t` AS e');  // as-is, NOT `p.d.t`
      });

  test(
      'a fully-qualified dataSource is never overridden by the graph\'s options',
      () => {
        // Source location and graph location are independent: a graph created
        // in one project/dataset may reference tables that live elsewhere. The
        // emitter must not rewrite the source table's own qualification.
        const model: SemanticModel = {
          name: 'm',
          relationships: [],
          metrics: [],
          entities: [
            {name: 'e', dataSource: 'samples.tpch.t', keys: ['id'], fields: []}
          ],
        };
        const {ddl} =
            generatePropertyGraph(model, {project: 'p', dataset: 'd'});
        expect(ddl).toContain('`samples.tpch.t` AS e');
      });

  test(
      'a project without a dataset does not produce a malformed `project.name`',
      () => {
        // A graph name is `name`, `dataset.name`, or `project.dataset.name`.
        // When only a project is known (no dataset in opts, and the first
        // entity's dataSource is bare so none can be derived), the lone project
        // is dropped rather than emitted as `p.g`, which BigQuery would read as
        // `dataset.name`.
        const model: SemanticModel = {
          name: 'm',
          relationships: [],
          metrics: [],
          entities: [{
            name: 'e',
            dataSource: 't',
            keys: ['id'],
            fields: [{name: 'id', expression: 'e.id'}]
          }],
        };
        const {ddl} =
            generatePropertyGraph(model, {project: 'p', graphName: 'g'});
        expect(ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH `g`');
        expect(ddl).not.toContain('`p.g`');
      });
});


describe('descriptive metadata: structured synonyms vs folded description', () => {
  // A two-entity model with an FK edge, exercising ai_context on every element
  // kind (entity label, field property, measure, edge label) plus the model.
  // BigQuery's PropertyGraph{Label,Property}Options carry a structured
  // `synonyms` array (verified live), so synonyms are emitted as their own
  // option; instructions and examples (which have no dedicated option) still
  // fold into `description`.
  const model = (): SemanticModel => ({
    name: 'm',
    description: 'MODEL_LEVEL_DESC',
    aiContext: {instructions: 'model help', synonyms: ['modelsyn']},
    entities: [
      {
        name: 'orders',
        dataSource: 'orders',
        keys: ['o_orderkey'],
        description: 'the orders',
        aiContext: {
          instructions: 'one row per order',
          synonyms: ['ord', 'purchase'],
          examples: ['how many orders?'],
        },
        fields: [
          {name: 'o_orderkey', expression: 'orders.o_orderkey'},
          {
            name: 'amount',
            expression: 'orders.amount',
            label: 'Order amount',
            aiContext: {synonyms: ['total', 'value']},
          },
        ],
      },
      {
        name: 'customers',
        dataSource: 'customers',
        keys: ['c_custkey'],
        fields: [{name: 'c_custkey', expression: 'customers.c_custkey'}],
      },
    ],
    relationships: [{
      name: 'placed_by',
      source: {entity: 'orders', columns: ['o_custkey']},
      destination: {entity: 'customers', columns: ['c_custkey']},
      aiContext: {synonyms: ['belongs to']},
    }],
    metrics: [{
      name: 'total_amount',
      expression: 'SUM(orders.amount)',
      entity: 'orders',
      aiContext: {synonyms: ['revenue', 'sales']},
    }],
  });

  test(
      'synonyms are a structured array on every element, not folded into description',
      () => {
        const {ddl} = generatePropertyGraph(model(), GEN_OPTS);
        // Entity label, field property, measure, and edge label each carry a
        // structured `synonyms=[...]` array.
        expect(ddl).toContain('synonyms=["ord", "purchase"]');
        expect(ddl).toContain('synonyms=["total", "value"]');
        expect(ddl).toContain('synonyms=["revenue", "sales"]');
        expect(ddl).toContain('synonyms=["belongs to"]');
        // The legacy folded "Synonyms: ..." text is gone entirely.
        expect(ddl).not.toContain('Synonyms:');
      });

  test(
      'instructions and examples still fold into the description option',
      () => {
        const {ddl} = generatePropertyGraph(model(), GEN_OPTS);
        expect(ddl).toContain('one row per order');  // entity instructions
        expect(ddl).toContain('Examples: how many orders?');
        expect(ddl).toContain('Order amount');  // field label leads
      });

  test(
      'model-level metadata is not emitted (BigQuery drops statement-level graph OPTIONS)',
      () => {
        const {ddl} = generatePropertyGraph(model(), GEN_OPTS);
        expect(ddl).not.toContain('MODEL_LEVEL_DESC');
        expect(ddl).not.toContain('modelsyn');
      });
});


// The BigQuery restrictions recorded at
// go/x20 -> bei/bigquery-property-graph-limits.html (section A): a graph
// MEASURE may only aggregate a SINGLE EXPOSED PROPERTY of its node — never a
// raw column (A1), an inline expression (A2), or `*` (A3). Rather than
// enumerate inputs one by one, this guard parses the emitted DDL and asserts
// the invariant BigQuery itself enforces, so ANY future emitter change that
// reintroduces a rejected shape fails here — even for inputs no explicit test
// covers.
describe(
    'emitter never produces a MEASURE shape BigQuery rejects (x20 record §A)',
    () => {
      // For each NODE block: the names it exposes as (non-measure) properties,
      // and the aggregate operand of each MEASURE it declares.
      function parseNodeMeasures(ddl: string): Record < string, {
        exposed: Set<string>;
        operands: string[]
      }
      > {
        const nodes: Record < string, {
          exposed: Set<string>;
          operands: string[]
        }
        > = {};
        let inNodeSection = false, inProps = false;
        let cur: string|null = null;
        for (const raw of ddl.split('\n')) {
          const t = raw.trim();
          if (t.startsWith('NODE TABLES')) {
            inNodeSection = true;
            continue;
          }
          if (t.startsWith('EDGE TABLES')) {
            inNodeSection = false;
            continue;
          }
          if (!inNodeSection) continue;
          const alias = t.match(/^`[^`]+`\s+AS\s+(\w+)$/);
          if (alias) {
            cur = alias[1];
            nodes[cur] = {exposed: new Set(), operands: []};
            inProps = false;
            continue;
          }
          if (t.endsWith('PROPERTIES(')) {
            inProps = true;
            continue;
          }
          if (inProps && (t === ')' || t === '),')) {
            inProps = false;
            continue;
          }
          if (!inProps || !cur) continue;
          const meas = t.match(
              /^MEASURE\(\s*\w+\(\s*(?:DISTINCT\s+)?(.*?)\)\s*\)\s+AS\s+\w+,?$/);
          if (meas) {
            nodes[cur].operands.push(meas[1].trim());
            continue;
          }
          // A non-measure property line: record the name it exposes (after AS,
          // or the bare identifier), ignoring any trailing comma or
          // OPTIONS(...) suffix.
          const noOpts =
              t.replace(/,\s*$/, '').replace(/\s+OPTIONS\(.*\)$/, '');
          const asIdx = noOpts.lastIndexOf(' AS ');
          nodes[cur].exposed.add(
              (asIdx >= 0 ? noOpts.slice(asIdx + 4) : noOpts).trim());
        }
        return nodes;
      }

      function assertLegalMeasures(ddl: string): void {
        expect(ddl).not.toContain(
            'MEASURE(COUNT(*))');  // §A3 star must never survive
        for (const {exposed, operands} of Object.values(
                 parseNodeMeasures(ddl))) {
          for (const op of operands) {
            // §A1/§A2: a bare identifier only — no parentheses, operators, or
            // `*`.
            expect(op).toMatch(/^[A-Za-z_]\w*$/);
            // ...and it must be an exposed property of the very same node.
            expect(exposed.has(op)).toBe(true);
          }
        }
      }

      // The fixtures whose goldens carry measures — the invariant must hold for
      // each.
      test('the live-verified fan-out chain satisfies the invariant', () => {
        assertLegalMeasures(
            generatePropertyGraph(loadFixture('sales_fanout.yaml'), GEN_OPTS)
                .ddl);
      });

      test('every lowered operand shape stays a legal MEASURE', () => {
        assertLegalMeasures(generatePropertyGraph(
                                loadFixture('measure_lowering.yaml'), GEN_OPTS)
                                .ddl);
      });

      test('a COUNT(*) lowering (star -> key property) stays legal', () => {
        const model: SemanticModel = {
          name: 'm',
          relationships: [],
          entities: [{
            name: 'orders',
            dataSource: 'orders',
            keys: ['o_orderkey'],
            fields: [{name: 'o_orderkey', expression: 'orders.o_orderkey'}]
          }],
          metrics:
              [{name: 'n_orders', expression: 'COUNT(*)', entity: 'orders'}],
        };
        const {ddl} = generatePropertyGraph(model, GEN_OPTS);
        assertLegalMeasures(ddl);
        expect(ddl).toContain('MEASURE(COUNT(o_orderkey)) AS n_orders');
        expect(ddl).not.toContain('MEASURE(COUNT(*))');
      });
    });


describe('abstract (table-less) superclasses are eliminated to labels', () => {
  // An abstract `Party` has no physical table; two concrete subtypes, `Person`
  // and `Organization`, bind it. resolveInheritance flattens Party's `name`
  // onto each subtype and expands their `extends` to [Party], so each concrete
  // node table declares `LABEL Party` with Party's own signature. Party itself
  // must produce NO node table -- it survives only as that shared label.
  function partyModel(): SemanticModel {
    return {
      name: 'party_graph',
      entities: [
        {
          name: 'Party',
          dataSource: '',
          keys: [],
          abstract: true,
          fields: [{name: 'id'}, {name: 'name'}],
        },
        {
          name: 'Person',
          dataSource: 'sqlgen-testing.demo.person',
          keys: ['id'],
          extends: ['Party'],
          fields: [{name: 'id'}, {name: 'ssn'}],
        },
        {
          name: 'Organization',
          dataSource: 'sqlgen-testing.demo.organization',
          keys: ['id'],
          extends: ['Party'],
          fields: [{name: 'id'}, {name: 'taxId'}],
        },
      ],
      relationships: [],
      metrics: [],
    };
  }

  test('the abstract class produces no node table but survives as a label', () => {
    const {ddl} = generatePropertyGraph(partyModel(), GEN_OPTS);
    // No `AS Party` node table (it has no source/KEY to materialize)...
    expect(ddl).not.toContain('AS Party');
    // ...but its label is present on the concrete descendants.
    expect(ddl).toContain('LABEL Party');
  });

  test('concrete subclasses share the abstract label and its flattened fields', () => {
    const {ddl} = generatePropertyGraph(partyModel(), GEN_OPTS);
    // Both Person and Organization declare the shared Party label.
    expect(ddl.match(/LABEL Party/g)?.length).toBe(2);
    // Party's `name` field flattened down so the shared signature is present.
    expect(ddl).toContain('name');
  });

  test('both concrete node tables are still emitted', () => {
    const {ddl} = generatePropertyGraph(partyModel(), GEN_OPTS);
    expect(ddl).toContain('AS Person');
    expect(ddl).toContain('AS Organization');
  });

  test('an abstract class that is nobody\'s supertype is warned and dropped', () => {
    const model = partyModel();
    model.entities!.push({
      name: 'Ghost',
      dataSource: '',
      keys: [],
      abstract: true,
      fields: [{name: 'id'}],
    });
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(warnings.some(
               w => w.includes(`abstract entity 'Ghost'`) &&
                   w.includes('no graph element')))
        .toBe(true);
    expect(ddl).not.toContain('Ghost');
  });
});


describe('supertype shared-label constraints (inheritance)', () => {
  // Person is a supertype (Customer extends it), so its label is shared across
  // both element tables. BigQuery forbids OPTIONS on a shared label and forbids
  // a MEASURE bound to more than one element table, so the generator must (a)
  // drop Person's label OPTIONS with a warning and (b) skip a metric that
  // targets a supertype with a warning -- while a metric on a leaf still emits.
  function hierModel(): SemanticModel {
    return {
      name: 'hier',
      entities: [
        {
          name: 'Person',
          dataSource: 'proj.ds.person',
          keys: ['id'],
          description: 'A human being',
          fields: [{name: 'id'}, {name: 'name'}],
        },
        {
          name: 'Customer',
          dataSource: 'proj.ds.customer',
          keys: ['id'],
          extends: ['Person'],
          fields: [{name: 'id'}, {name: 'tier'}],
        },
      ],
      relationships: [],
      metrics: [{name: 'total_people', expression: 'COUNT(Person.id)'}],
    };
  }

  test('a shared supertype label drops its OPTIONS (with a warning)', () => {
    const {ddl, warnings} = generatePropertyGraph(hierModel(), GEN_OPTS);
    // Person's description would normally ride its DEFAULT LABEL OPTIONS; because
    // the label is shared with Customer it must be options-free.
    expect(ddl).not.toContain('A human being');
    expect(warnings.some(
               w => w.includes(`entity 'Person' is a supertype`) &&
                   w.includes('dropped from the shared')))
        .toBe(true);
    // The shared supertype still uses an explicit DEFAULT LABEL.
    expect(ddl).toContain('DEFAULT LABEL');
  });

  test('a metric targeting a supertype is skipped (with a warning)', () => {
    const {ddl, warnings} = generatePropertyGraph(hierModel(), GEN_OPTS);
    expect(ddl).not.toContain('total_people');
    expect(warnings.some(
               w => w.includes(`metric 'total_people'`) &&
                   w.includes('shared label')))
        .toBe(true);
  });

  test('a metric on a leaf (non-supertype) entity is still emitted', () => {
    const model = hierModel();
    // Retarget to the leaf Customer -- nobody extends it, so its label is not
    // shared and a MEASURE binds cleanly.
    model.metrics = [{name: 'total_customers', expression: 'COUNT(Customer.id)'}];
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain('AS total_customers');
    expect(warnings.some(w => w.includes('total_customers'))).toBe(false);
  });
});
