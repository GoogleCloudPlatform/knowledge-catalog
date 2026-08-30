// Behavior specification for the Spanner property-graph generator
// (src/libts/semantic/spanner.ts).
//
// The readable "big picture" tests live in `spanner.e2e.test.ts`: a corpus of
// `<fixture>.yaml` inputs, each with a committed `<fixture>.spanner.golden.sql`
// showing the exact generated DDL and warnings. Prefer adding a fixture +
// golden there.
//
// This file holds only what a loader fixture CANNOT express: an M:N association
// edge (the open format has no association-table syntax, so its IR is
// hand-built and checked against a committed golden), and degenerate/negative
// inputs and pure GenerateOptions behavior (graph naming, bare table mapping).

import {describe, expect, test} from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import {SemanticModel} from '../../../src/libts/semantic/ir';
import {GenerateOptions, generateSpannerPropertyGraph} from '../../../src/libts/semantic/spanner';

const FIXTURES = path.join(__dirname, 'fixtures');


describe(
    'M:N association edge (no association-table syntax in the open format yet)',
    () => {
      // Hand-built because the loader's relationship schema is direct-FK only;
      // it cannot express an edge backed by its own association table with its
      // own KEY and edge properties. The expected DDL is a committed golden
      // (`school_manytomany.spanner.golden.sql`), the Spanner counterpart to
      // the BigQuery association golden, so the two shapes are reviewable side
      // by side.
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

      test('the association graph matches its committed golden DDL', () => {
        const {ddl} = generateSpannerPropertyGraph(SCHOOL);
        const golden =
            path.join(FIXTURES, 'school_manytomany.spanner.golden.sql');
        if (process.env.UPDATE_GOLDENS) {
          fs.writeFileSync(golden, ddl);
          return;
        }
        expect(ddl).toBe(fs.readFileSync(golden, 'utf8'));
      });

      test(
          'an edge property carries no OPTIONS (Spanner has no per-element options)',
          () => {
            // The junction's `grade` field has a description; on BigQuery that
            // becomes an OPTIONS clause, on Spanner it is dropped.
            const {ddl} = generateSpannerPropertyGraph(SCHOOL);
            expect(ddl).toContain('grade');
            expect(ddl).not.toContain('OPTIONS');
          });
    });


describe('graph naming', () => {
  const oneEntity = (): SemanticModel => ({
    name: 'my_model',
    relationships: [],
    metrics: [],
    entities: [{
      name: 'orders',
      dataSource: 'proj.ds.orders',
      keys: ['id'],
      fields: [{name: 'id', expression: 'orders.id'}]
    }],
  });

  test(
      'the graph name defaults to the model name, bare (no project.dataset)',
      () => {
        const {ddl} = generateSpannerPropertyGraph(oneEntity());
        expect(ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH my_model');
      });

  test('opts.graphName overrides the model name', () => {
    const {ddl} =
        generateSpannerPropertyGraph(oneEntity(), {graphName: 'chosen'});
    expect(ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH chosen');
  });

  test('a non-simple graph name is backtick-quoted', () => {
    // A hyphen is not a valid unquoted GoogleSQL identifier; the graph name
    // from a deployment-target URI can contain one, so it must be quoted.
    const opts: GenerateOptions = {graphName: 'sales-graph'};
    const {ddl} = generateSpannerPropertyGraph(oneEntity(), opts);
    expect(ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH `sales-graph`');
  });
});


describe('bare table mapping', () => {
  const withSource = (source: string): SemanticModel => ({
    name: 'm',
    relationships: [],
    metrics: [],
    entities: [{
      name: 'orders',
      dataSource: source,
      keys: ['id'],
      fields: [{name: 'id', expression: 'orders.id'}]
    }],
  });

  test('a three-part source reduces to its final table segment', () => {
    const {ddl} = generateSpannerPropertyGraph(withSource('proj.ds.Orders'));
    expect(ddl).toContain('Orders AS orders');
    expect(ddl).not.toContain('proj.ds.Orders');
  });

  test('a bare source is used as-is', () => {
    const {ddl} = generateSpannerPropertyGraph(withSource('Orders'));
    expect(ddl).toContain('Orders AS orders');
  });

  test('a backtick-quoted final segment is unwrapped to its bare name', () => {
    const {ddl} = generateSpannerPropertyGraph(withSource('proj.ds.`Orders`'));
    expect(ddl).toContain('Orders AS orders');
  });

  test(
      'a dot INSIDE a quoted final segment does not split the table name',
      () => {
        // The naive `split('.')` mangled `weird.name` into `name`; the quoted
        // segment must survive whole (and be re-quoted, since it is not a
        // simple identifier).
        const {ddl} =
            generateSpannerPropertyGraph(withSource('proj.ds.`weird.name`'));
        expect(ddl).toContain('`weird.name` AS orders');
        expect(ddl).not.toContain('name AS orders');
      });

  test(
      'a query source is emitted verbatim (parenthesized) with a warning',
      () => {
        const {ddl, warnings} =
            generateSpannerPropertyGraph(withSource('SELECT * FROM t'));
        expect(ddl).toContain('(SELECT * FROM t) AS orders');
        expect(warnings.some(w => w.includes('looks like a query'))).toBe(true);
      });
});


describe(
    'remapped physical columns (a profile binds fields to differently named columns)',
    () => {
      // A binding profile can map a logical field onto a differently named
      // physical column (a warehouse's `o_orderkey` vs an operational store's
      // `OrderId`). Every structural site -- node KEY, edge KEY / SOURCE KEY /
      // DESTINATION KEY, and each REFERENCES target -- must name the physical
      // column, never the property alias exposed under the field name, or
      // Spanner rejects the DDL
      // ("Column 'o_orderkey' not found in table 'Orders'"). PROPERTIES still
      // exposes the alias. Mirrors the BigQuery leg.
      const remapped = (): SemanticModel => ({
        name: 'sales',
        metrics: [],
        entities: [
          {
            name: 'orders',
            dataSource: 'Orders',
            keys: ['o_orderkey'],
            fields: [
              {name: 'o_orderkey', expression: 'OrderId'},
              {name: 'o_custkey', expression: 'CustomerId'},
            ],
          },
          {
            name: 'customer',
            dataSource: 'Customers',
            keys: ['c_custkey'],
            fields: [
              {name: 'c_custkey', expression: 'CustomerId'},
              {name: 'c_name', expression: 'FullName'},
            ],
          },
        ],
        relationships: [{
          name: 'orders_to_customer',
          source: {entity: 'orders', columns: ['o_custkey']},
          destination: {entity: 'customer', columns: ['c_custkey']},
        }],
      });

      test(
          'node KEY names the physical column, PROPERTIES keeps the alias',
          () => {
            const {ddl} = generateSpannerPropertyGraph(remapped());
            expect(ddl).toContain('KEY(OrderId)');
            expect(ddl).not.toContain('KEY(o_orderkey)');
            expect(ddl).toContain('OrderId AS o_orderkey');
          });

      test(
          'edge SOURCE/DESTINATION KEY and REFERENCES name physical columns',
          () => {
            const {ddl} = generateSpannerPropertyGraph(remapped());
            expect(ddl).toContain(
                'SOURCE KEY(OrderId) REFERENCES orders(OrderId)');
            expect(ddl).toContain(
                'DESTINATION KEY(CustomerId) REFERENCES customer(CustomerId)');
            // The FK's logical name may still appear as a PROPERTIES alias
            // (`CustomerId AS o_custkey`); it must not appear at a key site.
            expect(ddl).not.toContain('KEY(o_custkey)');
          });

      test(
          'a key field bound to a non-column expression is warned (Spanner needs a bare column)',
          () => {
            const model = remapped();
            model.entities[0].fields[0].expression = 'UPPER(OrderId)';
            const {warnings} = generateSpannerPropertyGraph(model);
            expect(warnings.some(
                       w => w.includes('o_orderkey') &&
                           w.includes('non-column expression')))
                .toBe(true);
          });
    });

describe('degenerate inputs', () => {
  test(
      'a model with no entities throws (an empty NODE TABLES is invalid DDL)',
      () => {
        expect(
            () => generateSpannerPropertyGraph(
                {name: 'm', entities: [], relationships: [], metrics: []}))
            .toThrow(/at least one NODE TABLE/);
      });

  test('an entity with no KEY is skipped and warned', () => {
    const model: SemanticModel = {
      name: 'm',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'good',
          dataSource: 'ds.good',
          keys: ['id'],
          fields: [{name: 'id', expression: 'good.id'}]
        },
        {name: 'bad', dataSource: 'ds.bad', keys: [], fields: []},
      ],
    };
    const {ddl, warnings} = generateSpannerPropertyGraph(model);
    expect(ddl).toContain('good AS good');
    expect(ddl).not.toContain('AS bad');
    expect(warnings.some(w => w.includes('empty KEY'))).toBe(true);
  });
});
