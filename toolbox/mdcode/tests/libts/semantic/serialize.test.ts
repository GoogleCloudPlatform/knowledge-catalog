// Behavior specification for the semantic-model serializer
// (src/libts/semantic/serialize.ts).
//
// serialize.ts is the inverse of loader.ts: IR -> open-format YAML. The
// strongest guarantee is a round trip through the loader -- load a fixture to
// the IR, serialize it, load the serialized text again, and assert the two IRs
// are identical. That pins IR-level fidelity across every feature the loader
// produces (datasets, fields, datatypes, dimensions, labels, ai_context,
// custom_extensions, relationships, metrics, imported expressions) without
// hard-coding YAML text. Targeted structural tests cover the mapping details a
// round trip cannot isolate.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

import {Field, Metric, Relationship, SemanticModel} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';
import {modelDocument, serializeModel} from '../../../src/libts/semantic/serialize';

const FIXTURES = path.join(__dirname, 'fixtures');

function loadFixture(name: string): SemanticModel[] {
  const text = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  return loadModels(text).models;
}


describe('loader <-> serialize round trip is IR-stable', () => {
  // Each fixture exercises a different slice of the format: relationships +
  // ai_context + synonyms + label + dimension; the full tpc-ds corpus with
  // custom_extensions + unique_keys; explicit datatypes; and imported
  // (vendor-dialect) expressions.
  const fixtures = [
    'star_orders_customer.yaml',
    'tpcds_retail.yaml',
    'sales_google_ext.yaml',
    'vendor_dialects.yaml',
    'lineitem_databricks_ext.yaml',
    'sales_bq_graph_target.yaml',
  ];

  for (const fixture of fixtures) {
    test(`${fixture} survives IR -> YAML -> IR unchanged`, () => {
      const original = loadFixture(fixture);
      expect(original.length).toBeGreaterThan(0);

      for (const model of original) {
        const {yaml: text} = serializeModel(model);
        const reloaded = loadModels(text).models;
        expect(reloaded).toHaveLength(1);
        // IR-level equality: every field the loader keeps must match exactly.
        expect(reloaded[0]).toEqual(model);
      }
    });
  }
});


describe('serialized document structure', () => {
  const model = loadFixture('star_orders_customer.yaml')[0];
  const doc = modelDocument(model) as any;
  const sm = doc.semantic_model[0];

  test('emits the supported version and a single model', () => {
    expect(doc.version).toBe('0.2.0.dev0');
    expect(doc.semantic_model).toHaveLength(1);
    expect(sm.name).toBe(model.name);
  });

  test('a dataset source is the opaque dataSource string, verbatim', () => {
    const orders = sm.datasets.find((d: any) => d.name === 'orders');
    const entity = model.entities.find(e => e.name === 'orders')!;
    expect(orders.source).toBe(entity.dataSource);
    expect(typeof orders.source).toBe('string');
  });

  test('primary_key mirrors the entity keys', () => {
    const orders = sm.datasets.find((d: any) => d.name === 'orders');
    const entity = model.entities.find(e => e.name === 'orders')!;
    expect(orders.primary_key).toEqual(entity.keys);
  });

  test('ai_context is emitted structurally (synonyms round-trip)', () => {
    // The fixture annotates a field (o_orderdate) with synonyms; find it and
    // assert the structured ai_context is emitted under that field.
    const entity = model.entities.find(
        e => e.fields.some(f => f.aiContext?.synonyms?.length))!;
    const field = entity.fields.find(f => f.aiContext?.synonyms?.length)!;
    const dsDoc = sm.datasets.find((d: any) => d.name === entity.name);
    const fieldDoc = dsDoc.fields.find((f: any) => f.name === field.name);
    expect(fieldDoc.ai_context.synonyms).toEqual(field.aiContext!.synonyms);
  });

  test('a relationship maps to from/to + positional columns', () => {
    expect(sm.relationships.length).toBeGreaterThan(0);
    const rel = model.relationships[0];
    const relDoc = sm.relationships[0];
    expect(relDoc.from).toBe(rel.source.entity);
    expect(relDoc.to).toBe(rel.destination.entity);
    expect(relDoc.from_columns).toEqual(rel.source.columns);
    expect(relDoc.to_columns).toEqual(rel.destination.columns);
  });
});


describe('expression + datatype + dimension mapping', () => {
  test('an explicit datatype round-trips as `datatype`', () => {
    const model = loadFixture('sales_google_ext.yaml')[0];
    const typed = model.entities.flatMap(e => e.fields).find(f => f.type);
    expect(typed).toBeDefined();
    const {yaml: text} = serializeModel(model);
    const reloaded = loadModels(text).models[0];
    const back = reloaded.entities.flatMap(e => e.fields)
                     .find(f => f.name === typed!.name)!;
    expect(back.type).toBe(typed!.type);
  });

  test('a bare dimension marker survives as `dimension: {}`', () => {
    const field:
        Field = {name: 'ship_date', expression: 'e.ship_date', dimension: {}};
    const model: SemanticModel = {
      name: 'm',
      entities:
          [{name: 'e', dataSource: 'p.d.t', keys: ['k'], fields: [field]}],
      relationships: [],
      metrics: [],
    };
    const doc = modelDocument(model) as any;
    const fieldDoc = doc.semantic_model[0].datasets[0].fields[0];
    expect(fieldDoc.dimension).toEqual({});
    // And it reloads back to a dimension field.
    const reloaded = loadModels(serializeModel(model).yaml).models[0];
    expect(reloaded.entities[0].fields[0].dimension).toEqual({});
  });

  test('an imported vendor expression is emitted under its own dialect', () => {
    const field: Field = {
      name: 'amt',
      expression: 'e.amt',
      importedExpression: 'e.amt::NUMBER',
      importedDialect: 'SNOWFLAKE',
    };
    const model: SemanticModel = {
      name: 'm',
      entities:
          [{name: 'e', dataSource: 'p.d.t', keys: ['k'], fields: [field]}],
      relationships: [],
      metrics: [],
    };
    const doc = modelDocument(model) as any;
    const dialects =
        doc.semantic_model[0].datasets[0].fields[0].expression.dialects;
    const labels = dialects.map((d: any) => d.dialect);
    expect(labels).toContain('SNOWFLAKE');
    // The canonical form is labeled BIGQUERY so the loader re-picks it exactly.
    expect(labels).toContain('BIGQUERY');
  });

  test('a metric does not emit its derived attach entity', () => {
    const metric: Metric = {
      name: 'total',
      expression: 'SUM(orders.amt)',
      entity: 'orders',
    };
    const model: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'orders',
        dataSource: 'p.d.t',
        keys: ['k'],
        fields: [{name: 'amt', expression: 'orders.amt'}],
      }],
      relationships: [],
      metrics: [metric],
    };
    const metricDoc =
        (modelDocument(model) as any).semantic_model[0].metrics[0];
    expect(metricDoc).not.toHaveProperty('entity');
    // The loader re-derives it on reload.
    const reloaded = loadModels(serializeModel(model).yaml).models[0];
    expect(reloaded.metrics[0].entity).toBe('orders');
  });
});


describe('lossy edges are flagged', () => {
  test(
      'an association relationship warns and drops the junction detail', () => {
        const rel: Relationship = {
          name: 'enrollment',
          source: {entity: 'student', columns: ['id']},
          destination: {entity: 'course', columns: ['id']},
          association: {
            dataSource: 'p.d.enrollment',
            keys: ['student_id', 'course_id'],
            sourceColumns: ['student_id'],
            destinationColumns: ['course_id'],
          },
        };
        const model: SemanticModel = {
          name: 'school',
          entities: [
            {
              name: 'student',
              dataSource: 'p.d.student',
              keys: ['id'],
              fields: []
            },
            {
              name: 'course',
              dataSource: 'p.d.course',
              keys: ['id'],
              fields: []
            },
          ],
          relationships: [rel],
          metrics: [],
        };
        const {yaml: text, warnings} = serializeModel(model);
        expect(warnings.some(w => /association/i.test(w))).toBe(true);
        // The direct-FK view is still emitted (from/to + columns), so it
        // reloads.
        const relDoc = yaml.parse(text).semantic_model[0].relationships[0];
        expect(relDoc.from).toBe('student');
        expect(relDoc.to).toBe('course');
        expect(relDoc.from_columns).toEqual(['id']);
      });
});


describe('serialize flags loader-invalid reconstructions', () => {
  test('a model with no entities warns that datasets is required', () => {
    const model: SemanticModel = {
      name: 'empty',
      entities: [],
      relationships: [],
      metrics: [],
    };
    const {warnings} = serializeModel(model);
    expect(warnings.some(w => /no datasets/i.test(w))).toBe(true);
  });

  test('a field with no expression warns that one is required', () => {
    const model: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'orders',
        dataSource: 'p.d.t',
        keys: [],
        fields: [{name: 'orphan'}],
      }],
      relationships: [],
      metrics: [],
    };
    const {warnings} = serializeModel(model);
    expect(warnings.some(w => /field 'orphan'.*no expression/i.test(w)))
        .toBe(true);
  });

  test(
      'an imported dialect colliding with the canonical label is relabeled',
      () => {
        const model: SemanticModel = {
          name: 'm',
          entities: [{
            name: 'orders',
            dataSource: 'p.d.t',
            keys: [],
            fields: [{
              name: 'amt',
              expression: 'orders.amt',
              importedExpression: 'orders.AMT',
              importedDialect: 'BIGQUERY',
            }],
          }],
          relationships: [],
          metrics: [],
        };
        const doc = modelDocument(model) as any;
        const labels: string[] =
            doc.semantic_model[0].datasets[0].fields[0].expression.dialects.map(
                (d: any) => d.dialect);
        // No duplicate dialect label: the imported form is relabeled off
        // BIGQUERY so the loader does not pick between two BIGQUERY entries.
        expect(new Set(labels).size).toBe(labels.length);
        expect(labels).toContain('BIGQUERY');
      });
});
