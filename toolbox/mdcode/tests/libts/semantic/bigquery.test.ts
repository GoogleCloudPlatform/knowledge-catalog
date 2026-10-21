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
//   - which SQL each field and metric emits, case by case: a dialect list with
//     no `expression` beside it, and an `expression` the transpile pass wrote
//     next to vendor-only SQL.
// Plus a structural invariant guard that parses generated DDL and asserts the
// shape BigQuery enforces for measures, run over the loaded fixtures.
//

import {describe, expect, test} from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import {GenerateOptions, generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {Field, SemanticModel} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';

const FIXTURES = path.join(__dirname, 'fixtures');

// Loads a corpus fixture to its IR (same defaults the e2e golden suite uses),
// so the invariant guard below can run over the exact models the goldens
// capture.
function loadFixture(fixture: string): SemanticModel {
  const text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
  const {models} = loadModels(text, {
    defaultProject: 'sqlgen-testing',
    defaultDataset: 'demo',
    allowLegacyBareSource: true,
  });
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

  test('a key field bound to a computed expression warns at the structural site', () => {
    // A KEY / SOURCE KEY / REFERENCES site must name a bare column. A key bound
    // to a computed expression resolves to SQL, not a column, which BigQuery
    // rejects; the generator must warn statically rather than emit broken DDL.
    const model = orders();
    model.entities[0].fields[0].expression = 'CONCAT(orders.a, orders.b)';
    const {warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(warnings.some(
               w => w.includes('o_orderkey') &&
                   w.includes('non-column expression')))
        .toBe(true);
  });

  test(
      'an unbound field (no column) is omitted from the node table with a warning',
      () => {
        // Availability pruning normally removes unbound fields; generating DDL
        // without pruning (e.g. straight from a bindingOptional load) must not
        // emit the field as a phantom bare column.
        const model = orders();
        model.entities[0].fields.push({name: 'notes'});  // no expression/binding
        const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(ddl).not.toContain('notes');
        expect(warnings.some(
                   w => w.includes('notes') && w.includes('no column')))
            .toBe(true);
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

  test(
      'a measure over a struct path whose subfield matches another entity name is placed on the leading qualifier entity',
      () => {
        const model = orders();
        model.entities.push({
          name: 'customer',
          dataSource: 'customer',
          keys: ['c_id'],
          fields: [{name: 'c_id', expression: 'customer.c_id'}],
        });
        model.metrics = [{
          name: 'cust_amount',
          expression: 'SUM(orders.customer.amount)',
          entity: 'orders',
        }];
        const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(warnings.some(w => w.includes('spans multiple tables')))
            .toBe(false);
        expect(ddl).toContain('customer.amount AS cust_amount_input');
        expect(ddl).toContain('MEASURE(SUM(cust_amount_input)) AS cust_amount');
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
      'a model whose every entity is abstract throws, blaming abstractness not a missing KEY',
      () => {
        // An abstract entity is a table-less supertype that forms no node table
        // by design. When every entity is abstract, the failure must name that
        // cause rather than misdiagnose it as a missing primary key.
        expect(
            () => generatePropertyGraph(
                {
                  name: 'm',
                  relationships: [],
                  metrics: [],
                  entities: [
                    {
                      name: 'a',
                      dataSource: '',
                      keys: [],
                      fields: [],
                      abstract: true
                    },
                    {
                      name: 'b',
                      dataSource: '',
                      keys: [],
                      fields: [],
                      abstract: true
                    },
                  ],
                },
                GEN_OPTS))
            .toThrow(/every entity is abstract/);
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

  test(
      'a dataSource whose table name contains spaces is backtick-quoted without a query warning',
      () => {
        const model: SemanticModel = {
          name: 'm',
          relationships: [],
          metrics: [],
          entities: [{
            name: 'order_items',
            dataSource: 'acme.sales.order items',
            keys: ['id'],
            fields: [{name: 'id', expression: 'order_items.id'}]
          }],
        };
        const {ddl, warnings} = generatePropertyGraph(model);
        expect(warnings).toEqual([]);
        expect(ddl).toContain('`acme.sales.order items` AS order_items');
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
      'examples render as a joined line and custom ai_context members stay out of the DDL',
      () => {
        const m = model();
        m.entities[0].fields[1].aiContext = {
          instructions: 'Use for net revenue',
          synonyms: ['total', 'value'],
          examples: ['net revenue last month', 'revenue by region'],
          additionalProperties: {
            custom_hint: 'prioritize verified orders',
          },
        };
        const {ddl} = generatePropertyGraph(m, GEN_OPTS);
        expect(ddl).toContain(
            'Examples: net revenue last month; revenue by region');
        // A custom member has no slot in a property-graph deployment; it
        // reaches Knowledge Catalog only.
        expect(ddl).not.toContain('custom_hint');
        expect(ddl).not.toContain('prioritize verified orders');
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
  // and `Organization`, bind it. Party's inherited `id`/`name` are bound on
  // each subtype's OWN table under DIFFERENT columns (person.p_name vs
  // org.o_name). resolveInheritance flattens Party's fields onto each subtype
  // and expands their `extends` to [Party], so each concrete node table
  // declares `LABEL Party` with that subtype's OWN binding of the inherited
  // names (`p_name AS name` / `o_name AS name`). BigQuery reconciles a shared
  // label by property name, not backing column, so the differing columns are
  // valid; a bare-alias reference (`PROPERTIES(name)`) would not deploy
  // (verified live). Party itself must produce NO node table -- it survives
  // only as that shared label.
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
          fields: [
            {name: 'id', expression: 'p_id'},
            {name: 'name', expression: 'p_name'},
            {name: 'ssn', expression: 'p_ssn'},
          ],
        },
        {
          name: 'Organization',
          dataSource: 'sqlgen-testing.demo.organization',
          keys: ['id'],
          extends: ['Party'],
          fields: [
            {name: 'id', expression: 'o_id'},
            {name: 'name', expression: 'o_name'},
            {name: 'taxId', expression: 'o_tax'},
          ],
        },
      ],
      relationships: [],
      metrics: [],
    };
  }

  test(
      'the abstract class produces no node table but survives as a label',
      () => {
        const {ddl} = generatePropertyGraph(partyModel(), GEN_OPTS);
        // No `AS Party` node table (it has no source/KEY to materialize)...
        expect(ddl).not.toContain('AS Party');
        // ...but its label is present on the concrete descendants.
        expect(ddl).toContain('LABEL Party');
      });

  test(
      'concrete subclasses share the abstract label and its flattened fields',
      () => {
        const {ddl} = generatePropertyGraph(partyModel(), GEN_OPTS);
        // Both Person and Organization declare the shared Party label, each
        // with a PROPERTIES block listing Party's flattened `id`/`name`
        // rendered from that subtype's OWN binding (assert inside the block, so
        // an unrelated substring elsewhere can't satisfy this).
        const partyBlocks =
            [...ddl.matchAll(/LABEL Party\s*\n\s*PROPERTIES\(([\s\S]*?)\)/g)];
        expect(partyBlocks.length).toBe(2);
        for (const [, props] of partyBlocks) {
          expect(props).toContain('name');
          expect(props).toContain('id');
        }
        // The label signature must REDEFINE each inherited property with the
        // subtype's own column (`<col> AS <name>`), never a bare-alias
        // reference -- the shape BigQuery accepts across element tables with
        // differing columns (verified live).
        const props = partyBlocks.map(m => m[1]);
        expect(props.some(p => /p_name\s+AS\s+name/.test(p))).toBe(true);
        expect(props.some(p => /o_name\s+AS\s+name/.test(p))).toBe(true);
      });

  test('both concrete node tables are still emitted', () => {
    const {ddl} = generatePropertyGraph(partyModel(), GEN_OPTS);
    expect(ddl).toContain('AS Person');
    expect(ddl).toContain('AS Organization');
  });

  test(
      'an abstract class that is nobody\'s supertype is warned and dropped',
      () => {
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
    // Person's description would normally ride its DEFAULT LABEL OPTIONS;
    // because the label is shared with Customer it must be options-free.
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
                   w.includes('not a leaf type')))
        .toBe(true);
  });

  test('a metric on a leaf (non-supertype) entity is still emitted', () => {
    const model = hierModel();
    // Retarget to the leaf Customer -- nobody extends it, so its label is not
    // shared and a MEASURE binds cleanly.
    model.metrics =
        [{name: 'total_customers', expression: 'COUNT(Customer.id)'}];
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain('AS total_customers');
    expect(warnings.some(w => w.includes('total_customers'))).toBe(false);
  });
});


describe('inherited property rendering (shared-label consistency)', () => {
  // BigQuery requires a property carried by a label bound to more than one
  // element table to have an IDENTICAL definition in every table. These tests
  // pin the two ways a naive renderer would violate that: a supertype field
  // whose expression is qualified with its own name, and a subclass that
  // redefines an inherited field.
  function base(
      customerFields: Array<{name: string; expression?: string}>,
      personFields: Array<{name: string; expression?: string}>): SemanticModel {
    return {
      name: 'hier',
      entities: [
        {name: 'Person', dataSource: 'proj.ds.person', keys: ['id'],
         fields: personFields},
        {name: 'Customer', dataSource: 'proj.ds.customer', keys: ['id'],
         extends: ['Person'], fields: customerFields},
      ],
      relationships: [],
      metrics: [],
    };
  }

  test(
      'a supertype expression qualified with its own name is localized', () => {
        // Person.email references Person's table; inherited onto Customer it
        // must be the local `email`, so the qualifier appears NOWHERE in the
        // DDL and every binding of the Person label lists an identical `email`
        // property.
        const model = base([{name: 'id', expression: 'id'}], [
          {name: 'id', expression: 'id'},
          {name: 'email', expression: 'Person.email'}
        ]);
        const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(ddl).not.toContain('Person.email');
        // Person's own DEFAULT LABEL, Customer's DEFAULT LABEL, and Customer's
        // LABEL Person block must all list `email` the same way -> three
        // occurrences.
        expect(ddl.match(/\bemail\b/g)?.length).toBe(3);
        // A well-formed hierarchy raises no override warning.
        expect(warnings.some(w => w.includes('redefines inherited')))
            .toBe(false);
      });

  test('a subclass structurally remapping an inherited field is warned', () => {
    // Customer remaps `email` (inherited from Person) to a different
    // expression. That cannot be represented under the shared Person label, so
    // the supertype's definition wins and the remap is dropped with a warning
    // that names it as a column/expression remap.
    const model = base(
        [
          {name: 'id', expression: 'id'},
          {name: 'email', expression: 'LOWER(email)'}
        ],
        [{name: 'id', expression: 'id'}, {name: 'email', expression: 'email'}]);
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(warnings.some(
               w => w.includes(`remaps inherited property 'email'`) &&
                   w.includes('remapping is dropped')))
        .toBe(true);
    // The remapping expression is gone; only the supertype's `email` remains.
    expect(ddl).not.toContain('LOWER(email)');
  });

  test(
      'a subclass refining only inherited metadata is warned as metadata-only',
      () => {
        // Customer keeps `email`'s column but adds a description. The
        // structural core matches the supertype, so under the shared label the
        // supertype's (option-free) definition still wins -- but the warning
        // must say the refinement was METADATA, not a redefined column, and the
        // added text must not leak into the DDL.
        const model: SemanticModel = {
           name: 'hier',
           entities: [
             {
               name: 'Person', dataSource: 'proj.ds.person', keys: ['id'],
               fields: [{name: 'id', expression: 'id'},
                        {name: 'email', expression: 'email'}],
             },
             {
               name: 'Customer', dataSource: 'proj.ds.customer', keys: ['id'],
               extends: ['Person'],
               fields: [{name: 'id', expression: 'id'}, {
                 name: 'email',
                 expression: 'email',
                 description: 'Customer-specific email',
               }],
             },
           ],
           relationships: [],
           metrics: [],
         };
        const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
        expect(
            warnings.some(
                w =>
                    w.includes(
                        `overrides the description/synonyms of inherited property 'email'`) &&
                    w.includes('metadata is used')))
            .toBe(true);
        // Not mislabeled as a structural remap...
        expect(warnings.some(w => w.includes('remaps inherited property')))
            .toBe(false);
        // ...and the subclass metadata is dropped, not emitted.
        expect(ddl).not.toContain('Customer-specific email');
      });

  test(
      'a subclass extending a KEY-less (dropped) supertype omits that label',
      () => {
        // Person is concrete but has no KEY, so it forms no node table. It must
        // NOT be resurrected as a shared label on its subclass -- that would
        // contradict the "skipped, invalid" report. The subclass keeps the
        // flattened columns but drops the LABEL, with a warning explaining why.
        const model: SemanticModel = {
           name: 'hier',
           entities: [
             {
               name: 'Person', dataSource: 'proj.ds.person', keys: [],
               fields: [{name: 'id', expression: 'id'},
                        {name: 'email', expression: 'email'}],
             },
             {
               name: 'Customer', dataSource: 'proj.ds.customer', keys: ['id'],
               extends: ['Person'],
               fields: [{name: 'id', expression: 'id'},
                        {name: 'loyalty', expression: 'loyalty'}],
             },
           ],
           relationships: [],
           metrics: [],
         };
        const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
        // No Person node table, and NOT a Person label anywhere.
        expect(ddl).not.toContain('AS Person');
        expect(ddl).not.toContain('LABEL Person');
        // Reported both as the KEY defect and as the omitted label.
        expect(warnings.some(w => w.includes('empty KEY'))).toBe(true);
        expect(warnings.some(
                   w => w.includes(
                       `the 'Person' label is omitted from 'Customer'`)))
            .toBe(true);
        // Person's `email` still flattened onto Customer (it physically
        // exists).
        expect(ddl).toContain('email');
      });
});

describe('reserved-word names in an M:N association edge are quoted', () => {
  // The open format has no association-table syntax, so this hand-built IR is
  // the only path that exercises renderAssociationEdge's identifier quoting: the
  // edge alias, KEY, SOURCE KEY / DESTINATION KEY columns, and both REFERENCES
  // labels, each named with a GoogleSQL reserved keyword.
  const RW_ASSOC: SemanticModel = {
    name: 'rw_assoc',
    entities: [
      {
        name: 'Order',
        dataSource: 'proj.ds.orders',
        keys: ['order'],
        fields: [{name: 'order', expression: 'Order.order'}],
      },
      {
        name: 'Group',
        dataSource: 'proj.ds.groups',
        keys: ['id'],
        fields: [{name: 'id', expression: 'Group.id'}],
      },
    ],
    relationships: [{
      name: 'from',
      source: {entity: 'Order', columns: ['order']},
      destination: {entity: 'Group', columns: ['id']},
      association: {
        dataSource: 'proj.ds.order_group',
        keys: ['order'],
        sourceColumns: ['order'],
        destinationColumns: ['id'],
        fields: [],
      },
    }],
    metrics: [],
  };

  test('every reserved identifier position in the edge is backtick-quoted', () => {
    const {ddl} = generatePropertyGraph(RW_ASSOC, GEN_OPTS);
    expect(ddl).toContain('`proj.ds.order_group` AS `from`');
    expect(ddl).toContain('KEY(`order`)');
    expect(ddl).toContain('SOURCE KEY(`order`) REFERENCES `Order`(`order`)');
    expect(ddl).toContain('DESTINATION KEY(id) REFERENCES `Group`(id)');
  });
});


describe('a comment in a field expression', () => {
  // Left in, a line comment runs to the end of the line and swallows the
  // ` AS <name>` after the expression, and the comma after that.
  const model: SemanticModel = {
    name: 'm',
    relationships: [],
    metrics: [],
    entities: [{
      name: 'orders',
      dataSource: 'p.d.orders',
      keys: ['id'],
      fields: [
        {name: 'id', expression: 'order_id -- the key'},
        {name: 'total', expression: 'amount -- in cents'},
        {name: 'notes', expression: '/* free text */ orders.notes'},
        {name: 'status', expression: 'status # open or closed'},
        {name: 'code', expression: "CONCAT('--', code)"},
      ],
    }],
  };

  test('is removed before the field is written', () => {
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain('KEY(order_id)');
    expect(ddl).toContain(
        '      order_id AS id,\n      amount AS total,\n      notes,\n' +
        "      status,\n      CONCAT('--', code) AS code\n");
    expect(ddl).not.toContain('the key');
    expect(ddl).not.toContain('free text');
    expect(warnings).toEqual([]);
  });

  test('is removed from a metric before it is lowered', () => {
    const withMetric: SemanticModel = {
      ...model,
      metrics: [{name: 'revenue', entity: 'orders',
                 expression: 'SUM(orders.amount -- in cents\n)'}],
    };
    const {ddl, warnings} = generatePropertyGraph(withMetric, GEN_OPTS);
    expect(ddl).toContain('MEASURE(SUM(total)) AS revenue');
    expect(warnings).toEqual([]);
  });

  test('a metric whose aggregate has no operand is skipped with a warning', () => {
    // Lowered, it would give a measure input property with no SQL.
    for (const expression of [
           'SUM()', 'SUM(/* in cents */)', 'SUM(orders.)', 'COUNT(DISTINCT)',
           'SUM(DISTINCT orders.)', 'COUNT(DISTINCT /* in cents */)']) {
      const {ddl, warnings} = generatePropertyGraph(
          {...model, metrics: [{name: 'revenue', entity: 'orders', expression}]},
          GEN_OPTS);
      expect(ddl).not.toContain('revenue');
      expect(warnings.some(w => w.startsWith("metric 'revenue' expression"))).toBe(true);
    }
  });

  test('is read as BigQuery reads it, even when a PostgreSQL entry holds the same text', () => {
    // A target text is read as the graph's engine reads it, so `# in cents`
    // comes out of `net`. A field or metric with only imported PostgreSQL SQL
    // has nothing BigQuery runs, so it is left out however its comments read.
    const vendor: SemanticModel = {
      name: 'm',
      relationships: [],
      entities: [{
        name: 'orders',
        dataSource: 'p.d.orders',
        keys: ['id'],
        fields: [
          {name: 'id', expression: 'id'},
          {name: 'flags', dialects: [{dialect: 'POSTGRES', expression: 'flags # 1'}],
           importedExpression: 'flags # 1', importedDialect: 'POSTGRES'},
          {name: 'total', dialects: [{dialect: 'POSTGRES', expression: 'amount -- in cents'}],
           importedExpression: 'amount -- in cents', importedDialect: 'POSTGRES'},
          {name: 'net', expression: 'net_amount # in cents',
           dialects: [{dialect: 'POSTGRES', expression: 'net_amount # in cents'},
                      {dialect: 'BIGQUERY', expression: 'net_amount # in cents'}]},
        ],
      }],
      metrics: [{
        name: 'xor_bits',
        entity: 'orders',
        dialects: [{dialect: 'POSTGRES', expression: 'SUM(orders.bits # 1\n)'}],
        importedExpression: 'SUM(orders.bits # 1\n)',
        importedDialect: 'POSTGRES',
      }],
    };
    const {ddl, warnings} = generatePropertyGraph(vendor, GEN_OPTS);
    expect(ddl).toContain('net_amount AS net');
    expect(ddl).not.toContain('flags');
    expect(ddl).not.toContain('AS total');
    expect(ddl).not.toContain('xor_bits');
    expect(warnings).toEqual([
      `metric 'xor_bits' has no 'BIGQUERY' or 'ANSI_SQL' expression; skipped ` +
          `(nothing to emit as a MEASURE)`,
      `entity 'orders': field 'flags' has no 'BIGQUERY' or 'ANSI_SQL' ` +
          `expression; omitted from the node table`,
      `entity 'orders': field 'total' has no 'BIGQUERY' or 'ANSI_SQL' ` +
          `expression; omitted from the node table`,
    ]);
  });

  test('next to a dot leaves no space, so the qualifier still comes off', () => {
    const dotted: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [{name: 'revenue', entity: 'orders',
                 expression: 'SUM(orders/* in cents */.amount)'}],
      entities: [{
        name: 'orders',
        dataSource: 'p.d.orders',
        keys: ['id'],
        fields: [
          {name: 'id', expression: 'orders./* the key */order_id'},
          {name: 'amount', expression: 'orders/* in cents */.amount'},
          {name: 'select', expression: 'orders. /* a keyword */ select'},
        ],
      }],
    };
    const {ddl, warnings} = generatePropertyGraph(dotted, GEN_OPTS);
    expect(ddl).toContain('KEY(order_id)');
    expect(ddl).toContain(
        '      order_id AS id,\n      amount,\n      `select`,\n' +
        '      MEASURE(SUM(amount)) AS revenue\n');
    expect(warnings).toEqual([]);
  });

  test('on an inherited field is read in its own dialect, even when a vendor entry holds the same text', () => {
    // Read as PostgreSQL, where `#` is an operator, the apostrophe opens a
    // string, the subtype's copy keeps `base.second`, and the generator warns
    // that the subtype remaps a property it only inherits.
    const text = "base.first # base's first\n|| base.second || ' '";
    const inherited: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'base',
          dataSource: 'p.d.base',
          keys: ['id'],
          fields: [
            {name: 'id', expression: 'id'},
            {name: 'label', expression: text, importedExpression: text,
             importedDialect: 'POSTGRES',
             dialects: [{dialect: 'POSTGRES', expression: text},
                        {dialect: 'BIGQUERY', expression: text}]},
          ],
        },
        {name: 'orders', dataSource: 'p.d.orders', keys: ['id'],
         extends: ['base'], fields: []},
      ],
    };
    const {ddl, warnings} = generatePropertyGraph(inherited, GEN_OPTS);
    expect(ddl).not.toContain('base.second');
    expect(ddl.match(/first \|\| second \|\| ' ' AS label/g)).toHaveLength(3);
    expect(warnings).toEqual([]);
  });
});


describe('each field and metric emits BigQuery\'s own SQL', () => {
  // Fields and metrics carry only a dialect list here, with no `expression`
  // beside it, so the emitted text can only have come from the list. (The
  // loader also copies the BIGQUERY or ANSI_SQL entry into `expression`.)
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

  // Built the way the loader builds a field written only for Snowflake. Leave
  // `importedExpression` in: without it the field has nothing to emit however
  // the generator chooses.
  const snowflakeOnly =
      (): Pick<Field, 'dialects'|'importedExpression'|'importedDialect'> => ({
    dialects: [{dialect: 'SNOWFLAKE', expression: 'DIV0(a,b)'}],
    importedExpression: 'DIV0(a,b)',
    importedDialect: 'SNOWFLAKE',
  });

  test('a BIGQUERY entry beats ANSI_SQL, and ANSI_SQL is used without one', () => {
    const model = orders();
    model.entities[0].fields.push(
        {
          name: 'order_month',
          dialects: [
            {
              dialect: 'ANSI_SQL',
              expression: 'DATE_TRUNC(\'month\', orders.order_ts)'
            },
            {
              dialect: 'BIGQUERY',
              expression: 'TIMESTAMP_TRUNC(orders.order_ts, MONTH)'
            },
          ],
        },
        {
          name: 'net',
          dialects: [
            {dialect: 'SNOWFLAKE', expression: 'DIV0(orders.a, orders.b)'},
            {dialect: 'ANSI_SQL', expression: 'orders.a / NULLIF(orders.b, 0)'},
          ],
        });
    model.metrics = [
      {
        name: 'revenue',
        dialects: [
          {dialect: 'ANSI_SQL', expression: 'SUM(orders.amount)'},
          {dialect: 'BIGQUERY', expression: 'SUM(orders.amount_usd)'},
        ],
      },
      {
        name: 'units',
        dialects: [
          {dialect: 'SNOWFLAKE', expression: 'SUM(ZEROIFNULL(orders.qty))'},
          {dialect: 'ANSI_SQL', expression: 'SUM(COALESCE(orders.qty, 0))'},
        ],
      },
    ];
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain('TIMESTAMP_TRUNC(order_ts, MONTH) AS order_month');
    expect(ddl).toContain('a / NULLIF(b, 0) AS net');
    expect(ddl).toContain('MEASURE(SUM(amount_usd)) AS revenue');
    expect(ddl).toContain('COALESCE(qty, 0) AS units_input');
    expect(ddl).toContain('MEASURE(SUM(units_input)) AS units');
    expect(ddl).not.toContain('DATE_TRUNC');
    expect(ddl).not.toContain('DIV0');
    expect(ddl).not.toContain('ZEROIFNULL');
    expect(warnings).toEqual([]);
  });

  test('another engine\'s SQL is never emitted', () => {
    const model = orders();
    model.entities[0].fields.push({name: 'ratio', ...snowflakeOnly()});
    model.metrics = [{name: 'revenue', ...snowflakeOnly(), entity: 'orders'}];
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).not.toContain('DIV0');
    expect(ddl).not.toContain('ratio');
    expect(ddl).not.toContain('revenue');
    expect(warnings).toContain(
        `entity 'orders': field 'ratio' has no 'BIGQUERY' or 'ANSI_SQL' ` +
        `expression; omitted from the node table`);
    expect(warnings).toContain(
        `metric 'revenue' has no 'BIGQUERY' or 'ANSI_SQL' expression; ` +
        `skipped (nothing to emit as a MEASURE)`);
  });

  test('SQL the transpile pass wrote into expression is still emitted', () => {
    const model = orders();
    model.entities[0].fields.push(
        {name: 'ratio', ...snowflakeOnly(), expression: 'IF(b = 0, 0, a / b)'});
    model.metrics = [{
      name: 'revenue',
      ...snowflakeOnly(),
      expression: 'SUM(orders.amount)',
    }];
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain('IF(b = 0, 0, a / b) AS ratio');
    expect(ddl).toContain('MEASURE(SUM(amount)) AS revenue');
    expect(ddl).not.toContain('DIV0');
    expect(warnings).toEqual([]);
  });

  test('a field or metric with no SQL at all keeps the unbound message', () => {
    const model = orders();
    model.entities[0].fields.push({name: 'notes'});
    model.metrics = [{name: 'revenue', entity: 'orders'}];
    const {warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(warnings).toEqual([
      `metric 'revenue' has no expression; skipped (nothing to emit as a ` +
          `MEASURE)`,
      `entity 'orders': field 'notes' has no column under this binding; ` +
          `omitted from the node table (bind it, or govern the logical model ` +
          `in Knowledge Catalog instead)`,
    ]);
  });

  test('a subtype that rebinds an inherited field with only a dialect list emits its own SQL', () => {
    const model: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'party',
          dataSource: '',
          keys: [],
          abstract: true,
          fields: [{name: 'nm', expression: 'party.display_name'}],
        },
        {
          name: 'person',
          dataSource: 'p.d.people',
          keys: ['id'],
          extends: ['party'],
          fields: [
            {name: 'id', expression: 'person.id'},
            {
              name: 'nm',
              dialects: [{dialect: 'BIGQUERY', expression: 'person.full_name'}],
            },
          ],
        },
      ],
    };
    const {ddl} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain('full_name AS nm');
    expect(ddl).not.toContain('display_name');
  });

  test('a concrete parent\'s field with no BigQuery SQL is left out of the parent\'s label on every table', () => {
    const model: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'person',
          dataSource: 'p.d.person',
          keys: ['id'],
          fields: [
            {name: 'id', expression: 'person.id'},
            {name: 'nick', ...snowflakeOnly()},
          ],
        },
        {
          name: 'customer',
          dataSource: 'p.d.customer',
          keys: ['id'],
          extends: ['person'],
          fields: [{name: 'id', expression: 'customer.id'}],
        },
      ],
    };
    expect(generatePropertyGraph(model, GEN_OPTS).ddl).not.toMatch(/\bnick\b/);
    // A subtype that binds the field in BigQuery SQL keeps its own SQL.
    model.entities[1].fields.push({name: 'nick', expression: 'customer.nick2'});
    const {ddl} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain('nick2 AS nick');
    expect(ddl).not.toMatch(/^\s+nick,?$/m);
  });

  test('an abstract parent\'s label leaves out a field one leaf has no BigQuery SQL for, on every leaf', () => {
    const leaf = (
        name: string,
        code: Pick<Field, 'expression'|'dialects'|'importedExpression'|
                          'importedDialect'>): SemanticModel['entities'][number] => ({
      name,
      dataSource: `p.d.${name}`,
      keys: ['id'],
      extends: ['party'],
      fields: [
        {name: 'id', expression: `${name}.id`},
        {name: 'nm', expression: `${name}.${name}_nm`},
        {name: 'code', ...code},
      ],
    });
    const model: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'party',
          abstract: true,
          dataSource: '',
          keys: [],
          fields: [{name: 'nm'}, {name: 'code'}],
        },
        leaf('person', {expression: 'person.p_code'}),
        leaf('org', snowflakeOnly()),
      ],
    };
    const labels = (ddl: string) =>
        [...ddl.matchAll(/LABEL party\s+(PROPERTIES\([^)]*\)|NO PROPERTIES)/g)]
            .map(m => m[1].replace(/\s+/g, ' '));
    expect(labels(generatePropertyGraph(model, GEN_OPTS).ddl)).toEqual([
      'PROPERTIES( person_nm AS nm )',
      'PROPERTIES( org_nm AS nm )',
    ]);
    // When nothing else is left, the label lists no properties, since a bare
    // LABEL exposes every column of its table.
    for (const e of model.entities) e.fields = e.fields.filter(f => f.name !== 'nm');
    const {ddl} = generatePropertyGraph(model, GEN_OPTS);
    expect(labels(ddl)).toEqual(['NO PROPERTIES', 'NO PROPERTIES']);
    expect(ddl).toContain('p_code AS code');
  });

  test('a metric over a field with no BigQuery SQL is skipped', () => {
    const model = orders();
    model.entities[0].fields.push({name: 'ratio', ...snowflakeOnly()});
    model.metrics = [{name: 'total_ratio', expression: 'SUM(orders.ratio)'}];
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).not.toContain('ratio');
    expect(warnings).toContain(
        `metric 'total_ratio' aggregates field 'ratio', which has no ` +
        `'BIGQUERY' or 'ANSI_SQL' expression; skipped (nothing to emit as a ` +
        `MEASURE)`);
  });

  test('a key field with only Snowflake SQL keeps its column in KEY', () => {
    const model = orders();
    model.entities[0].keys = ['order_id'];
    model.entities[0].fields = [{
      name: 'order_id',
      dialects: [{dialect: 'SNOWFLAKE', expression: 'o_orderkey'}],
      importedExpression: 'o_orderkey',
      importedDialect: 'SNOWFLAKE',
    }];
    const {ddl} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toContain('KEY(o_orderkey)');
    expect(ddl).not.toContain('order_id');
  });

  test('an association field with no BigQuery SQL is left out of its edge', () => {
    const model = orders();
    model.entities.push({
      name: 'parts',
      dataSource: 'parts',
      keys: ['p_partkey'],
      fields: [{name: 'p_partkey', expression: 'parts.p_partkey'}],
    });
    model.relationships = [{
      name: 'contains',
      source: {entity: 'orders', columns: ['o_orderkey']},
      destination: {entity: 'parts', columns: ['p_partkey']},
      association: {
        dataSource: 'lineitem',
        keys: ['l_orderkey', 'l_partkey'],
        sourceColumns: ['l_orderkey'],
        destinationColumns: ['l_partkey'],
        fields: [{name: 'ratio', ...snowflakeOnly()}],
      },
    }];
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).not.toContain('ratio');
    expect(warnings).toContain(
        `relationship 'contains': field 'ratio' has no 'BIGQUERY' or ` +
        `'ANSI_SQL' expression; omitted from the edge table`);
  });

  test('a subtype that restates an inherited field in Snowflake SQL only keeps the supertype\'s definition under its label', () => {
    const model: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'person',
          dataSource: 'p.d.person',
          keys: ['id'],
          fields: [
            {name: 'id', expression: 'person.id'},
            {name: 'nick', expression: 'person.nick'},
          ],
        },
        {
          name: 'customer',
          dataSource: 'p.d.customer',
          keys: ['id'],
          extends: ['person'],
          fields: [
            {name: 'id', expression: 'customer.id'},
            {name: 'nick', ...snowflakeOnly()},
          ],
        },
      ],
    };
    const {ddl, warnings} = generatePropertyGraph(model, GEN_OPTS);
    expect(ddl).toMatch(/LABEL person\s+PROPERTIES\(\s+id,\s+nick\s+\)/);
    expect(warnings).toContain(
        `entity 'customer': field 'nick' has no 'BIGQUERY' or 'ANSI_SQL' ` +
        `expression; omitted from the node table's own label, and the ` +
        `supertype's label keeps the supertype's definition`);
  });
});
