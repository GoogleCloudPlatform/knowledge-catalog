// Behavior specification for the OSI converter's serialize direction
// (serializeModel in src/libts/semantic/osi_converter.ts).
//
// The serializer is the inverse of loader.ts: IR -> open-format YAML. The
// strongest guarantee is a round trip through the loader -- load a fixture to
// the IR, serialize it, load the serialized text again, and assert the two IRs
// are identical. That pins IR-level fidelity across every feature the loader
// produces (datasets, fields, datatypes, dimensions, labels, ai_context,
// deployment targets, relationships, metrics, imported expressions) without
// hard-coding YAML text. Targeted structural tests cover the mapping details a
// round trip cannot isolate.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as yaml from 'yaml';

import {SemanticModelLayout} from '../../../src/libts/layouts/semantic-model';
import {ActionParameter, ALLOWED_DIALECTS, CustomExtension, Entity, Field, Metric, ProfileSpec, Relationship, SemanticModel, SqlDialect} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {loadModels} from '../../../src/libts/semantic/loader';
import {modelDocument, serializeModel, serializeModelFiles} from '../../../src/libts/semantic/osi_converter';
import {loadProfileFile} from '../../../src/libts/semantic/resolve_profiles';

const FIXTURES = path.join(__dirname, 'fixtures');

function loadFixture(name: string): SemanticModel[] {
  const text = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  return loadModels(text, {allowLegacyBareSource: true}).models;
}


describe('loader <-> serialize round trip is IR-stable', () => {
  // Each fixture exercises a different slice of the format: relationships +
  // ai_context + synonyms + label + dimension; a GOOGLE deployment target;
  // unique_keys; explicit datatypes; imported (vendor-dialect) expressions;
  // and third-party `custom_extensions` across model, entity, field,
  // relationship, and metric levels.
  const fixtures = [
    'star_orders_customer.yaml',
    'sales_google_ext.yaml',
    'vendor_dialects.yaml',
    'sales_bq_graph_target.yaml',
    'tpcds_retail.yaml',
    'actions_place_order.yaml',
    'lineitem_databricks_ext.yaml',
  ];

  for (const fixture of fixtures) {
    test(`${fixture} survives IR -> YAML -> IR unchanged`, () => {
      const original = loadFixture(fixture);
      expect(original.length).toBeGreaterThan(0);

      for (const model of original) {
        const {yaml: text, warnings} = serializeModel(model);
        expect(warnings).toEqual([]);
        const reloaded = loadModels(text, {allowLegacyBareSource: true}).models;
        expect(reloaded).toHaveLength(1);
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
    expect(doc.version).toBe('0.2.0.dev0/google');
    expect(doc.semantic_model).toHaveLength(1);
    expect(sm.name).toBe(model.name);
  });

  test('a dataset source is the source as written, verbatim', () => {
    const orders = sm.entities.find((d: any) => d.name === 'orders');
    const entity = model.entities.find(e => e.name === 'orders')!;
    expect(orders.source).toBe(entity.authoredSource);
    expect(typeof orders.source).toBe('string');
  });

  test('primary_key mirrors the entity keys', () => {
    const orders = sm.entities.find((d: any) => d.name === 'orders');
    const entity = model.entities.find(e => e.name === 'orders')!;
    expect(orders.primary_key).toEqual(entity.keys);
  });

  test('ai_context is emitted structurally (synonyms round-trip)', () => {
    // The fixture annotates a field (o_orderdate) with synonyms; find it and
    // assert the structured ai_context is emitted under that field.
    const entity = model.entities.find(
        e => e.fields.some(f => f.aiContext?.synonyms?.length))!;
    const field = entity.fields.find(f => f.aiContext?.synonyms?.length)!;
    const dsDoc = sm.entities.find((d: any) => d.name === entity.name);
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

  const bqTarget =
      'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';
  const spTarget =
      'spanner.googleapis.com/projects/p/instances/i/databases/db' +
      '/graphs/g';
  const ordersEntity: Entity = {
    name: 'orders',
    dataSource: 'p.d.orders',
    authoredSource: 'bigquery.googleapis.com/projects/p/datasets/d/tables/orders',
    keys: ['id'],
    fields: [{name: 'id', expression: 'id'}],
  };

  function vanillaTargetsYaml(targets: string[]): string {
    return [
      'version: "0.2.0.dev0"',
      'semantic_model:',
      '  - name: sales',
      '    custom_extensions:',
      '      - vendor_name: GOOGLE',
      `        data: '${JSON.stringify({deploymentTargets: targets})}'`,
      '    datasets:',
      '      - name: orders',
      '        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders',
      '        primary_key: [id]',
      '        fields:',
      '          - name: id',
      '            expression:',
      '              dialects:',
      '                - dialect: ANSI_SQL',
      '                  expression: id',
    ].join('\n');
  }

  test('keeps a deployment profile and omits deploymentTargets', () => {
    const withProfile: SemanticModel = {
      name: 'sales',
      deployments: [
        {name: 'staging', target: bqTarget, profile: 'spanner_binding'},
      ],
      customExtensions: [{
        vendorName: 'GOOGLE',
        data: JSON.stringify({deploymentTargets: [bqTarget]}),
      }],
      entities: [{...ordersEntity, fields: []}],
      relationships: [],
      metrics: [],
    };

    const {yaml: text, warnings} = serializeModel(withProfile);
    const parsed = yaml.parse(text);

    expect(warnings).toEqual([]);
    expect(parsed.semantic_model[0].deployments).toEqual([
      {name: 'staging', target: bqTarget, profile: 'spanner_binding'},
    ]);
    expect(parsed.semantic_model[0].custom_extensions).toBeUndefined();
    expect(text).not.toContain('deploymentTargets');
  });

  test('keeps a GOOGLE block verbatim under 0.2.0.dev0', () => {
    const [vanillaModel] = loadModels(vanillaTargetsYaml([bqTarget])).models;

    const serialized = serializeModel(vanillaModel);
    const parsed = yaml.parse(serialized.yaml);

    expect(vanillaModel.deployments).toBeUndefined();
    expect(serialized.warnings).toEqual([]);
    expect(parsed.version).toBe('0.2.0.dev0');
    expect(parsed.semantic_model[0].deployments).toBeUndefined();
    expect(parsed.semantic_model[0].custom_extensions).toEqual([
      {
        vendor_name: 'GOOGLE',
        data: JSON.stringify({deploymentTargets: [bqTarget]}),
      },
    ]);
  });

  test(
      'serializes a single GOOGLE target as default under 0.2.0.dev0/google',
      () => {
        const [vanillaModel] =
            loadModels(vanillaTargetsYaml([bqTarget])).models;
        const googleModel: SemanticModel = {
          ...vanillaModel,
          version: '0.2.0.dev0/google',
        };

        const serialized = serializeModel(googleModel);
        const parsed = yaml.parse(serialized.yaml);

        expect(serialized.warnings).toEqual([]);
        expect(parsed.semantic_model[0].deployments).toEqual([
          {name: 'default', target: bqTarget},
        ]);
      });

  test('numbers multiple GOOGLE targets under 0.2.0.dev0/google', () => {
    const [vanillaModel] =
        loadModels(vanillaTargetsYaml([spTarget, bqTarget])).models;
    const googleModel: SemanticModel = {
      ...vanillaModel,
      version: '0.2.0.dev0/google',
    };

    const serialized = serializeModel(googleModel);
    const parsed = yaml.parse(serialized.yaml);

    expect(serialized.warnings).toEqual([]);
    expect(parsed.semantic_model[0].deployments).toEqual([
      {name: 'deployment_1', target: spTarget},
      {name: 'deployment_2', target: bqTarget},
    ]);
  });

  // A padded repeat of a target is the same target, and a blank one names
  // none. Written out as they are, either gives a file that fails to load.
  test('deduplicates padded GOOGLE targets and drops blanks', () => {
    const data =
        JSON.stringify({deploymentTargets: [bqTarget, '  ', ` ${bqTarget} `]});
    const model: SemanticModel = {
      name: 'sales',
      version: '0.2.0.dev0/google',
      customExtensions: [{vendorName: 'GOOGLE', data}],
      entities: [ordersEntity],
      relationships: [],
      metrics: [],
    };

    const serialized = serializeModel(model);
    const parsed = yaml.parse(serialized.yaml);
    const reloaded = loadModels(serialized.yaml).models[0];

    const expected = [{name: 'default', target: bqTarget}];
    expect(parsed.semantic_model[0].deployments).toEqual(expected);
    expect(reloaded.deployments).toEqual(expected);
  });

  test('keeps valid GOOGLE targets past an invalid JSON block', () => {
    const validData = JSON.stringify({deploymentTargets: [bqTarget]});
    const model: SemanticModel = {
      name: 'sales',
      version: '0.2.0.dev0/google',
      customExtensions: [
        {vendorName: 'GOOGLE', data: 'not json'},
        {vendorName: 'GOOGLE', data: validData},
      ],
      entities: [ordersEntity],
      relationships: [],
      metrics: [],
    };

    const serialized = serializeModel(model);
    const parsed = yaml.parse(serialized.yaml);

    expect(parsed.semantic_model[0].deployments).toEqual([
      {name: 'default', target: bqTarget},
    ]);
    expect(serialized.warnings).toHaveLength(1);
  });

  test(
      'serializes a non-string GOOGLE target as its JSON text under 0.2.0.dev0/google',
      () => {
        const model: SemanticModel = {
          name: 'sales',
          version: '0.2.0.dev0/google',
          customExtensions: [{
            vendorName: 'GOOGLE',
            data: JSON.stringify({deploymentTargets: [7]}),
          }],
          entities: [ordersEntity],
          relationships: [],
          metrics: [],
        };

        const serialized = serializeModel(model);
        const parsed = yaml.parse(serialized.yaml);

        expect(parsed.semantic_model[0].deployments).toEqual([
          {name: 'default', target: '7'},
        ]);
        expect(serialized.warnings).toEqual([]);
      });
});


describe('expression + datatype + dimension mapping', () => {
  test('an explicit datatype round-trips as `datatype`', () => {
    const model = loadFixture('sales_google_ext.yaml')[0];
    const typed = model.entities.flatMap(e => e.fields).find(f => f.type);
    expect(typed).toBeDefined();
    const {yaml: text} = serializeModel(model);
    const reloaded = loadModels(text, {allowLegacyBareSource: true}).models[0];
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
    const fieldDoc = doc.semantic_model[0].entities[0].fields[0];
    expect(fieldDoc.dimension).toEqual({});
    // And it reloads back to a dimension field.
    const reloaded =
        loadModels(serializeModel(model).yaml, {allowLegacyBareSource: true})
            .models[0];
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
        doc.semantic_model[0].entities[0].fields[0].expression.dialects;
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
    const reloaded =
        loadModels(serializeModel(model).yaml, {allowLegacyBareSource: true})
            .models[0];
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

  test(
      'warns and drops a GOOGLE extension without targets under 0.2.0.dev0/google',
      () => {
        const model: SemanticModel = {
          name: 'm',
          version: '0.2.0.dev0/google',
          customExtensions: [{vendorName: 'GOOGLE', data: '{"other": true}'}],
          entities: [{
            name: 'orders',
            dataSource: 'p.d.t',
            keys: ['id'],
            customExtensions: [{vendorName: 'GOOGLE', data: '{"meta": 1}'}],
            fields: [{name: 'id', expression: 'orders.id'}],
          }],
          relationships: [],
          metrics: [],
        };

        const {yaml: text, warnings} = serializeModel(model);

        const pattern = /GOOGLE custom_extension.*no representation under/i;
        expect(warnings.some(w => pattern.test(w))).toBe(true);
        expect(text).not.toContain('custom_extensions');
      });

  test(
      'warns and drops custom_extensions on an action under 0.2.0.dev0/google',
      () => {
        const model: SemanticModel = {
          name: 'm',
          version: '0.2.0.dev0/google',
          entities: [{
            name: 'orders',
            dataSource: 'p.d.t',
            keys: ['id'],
            fields: [{name: 'id', expression: 'orders.id'}],
          }],
          relationships: [],
          metrics: [],
          actions: [{
            name: 'Close',
            executor:
                {kind: 'mcp', mcp: {server: '//x/mcpServers/s', tool: 't'}},
            parameters: [],
            customExtensions: [{vendorName: 'DBT', data: '{"meta": 1}'}],
          }],
        };

        const {yaml: text, warnings} = serializeModel(model);

        expect(
            warnings.some(
                w => w.includes('action \'Close\'') &&
                    w.includes('custom_extension(s) have no representation')))
            .toBe(true);
        expect(text).not.toContain('custom_extensions');
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

  test('a metric with no expression warns that one is required', () => {
    const orphanMetric: Metric = {
      name: 'orphan_metric',
      expression: undefined as unknown as string,
    };
    const model: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'orders',
        dataSource: 'p.d.t',
        keys: ['id'],
        fields: [{name: 'id', expression: 'id'}],
      }],
      relationships: [],
      metrics: [orphanMetric],
    };

    const {warnings} = serializeModel(model);

    expect(warnings.some(w => /metric 'orphan_metric'.*no expression/i.test(w)))
        .toBe(true);
  });

  test('a non-abstract entity with no source warns it will not reload', () => {
    // A lossy pull could drop an entity's binding without marking it abstract;
    // the loader requires a source unless abstract, so flag it at write time.
    const model: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'orphanEntity',
        dataSource: '',
        keys: ['id'],
        fields: [{name: 'id', expression: 'id'}],
      }],
      relationships: [],
      metrics: [],
    };
    const {warnings} = serializeModel(model);
    expect(warnings.some(
               w => /orphanEntity.*no source and is not abstract/i.test(w)))
        .toBe(true);
  });

  test(
      'suppresses missing-source and missing-expression warnings when logical',
      () => {
        const model: SemanticModel = {
          name: 'm',
          entities: [{
            name: 'logicalEntity',
            dataSource: '',
            keys: [],
            fields: [{name: 'logicalField'}],
          }],
          relationships: [],
          metrics: [],
        };

        const {warnings} = serializeModel(model, {logical: true});

        expect(warnings).toEqual([]);
      });

  test('omits imported dialect colliding with canonical or unallowed', () => {
    const model: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'orders',
        dataSource: 'p.d.t',
        keys: [],
        fields: [
          {
            name: 'amt',
            expression: 'orders.amt',
            importedExpression: 'orders.AMT',
            importedDialect: 'BIGQUERY',
          },
          {
            name: 'unknown_dialect',
            expression: 'orders.id',
            importedExpression: 'orders.ID',
            importedDialect: 'IMPORTED',
          },
        ],
      }],
      relationships: [],
      metrics: [],
    };

    const doc = modelDocument(model);
    const fields = doc.semantic_model[0].entities[0].fields;

    const allowed: ReadonlySet<string> = new Set(ALLOWED_DIALECTS);
    for (const f of fields) {
      const labels =
          f.expression.dialects.map((d: {dialect: string}) => d.dialect);
      expect(labels).toEqual(['BIGQUERY']);
      expect(labels.every((l: string) => allowed.has(l))).toBe(true);
    }
  });
});


// -- Golden corpus: the whole IR -> OSI YAML output, reviewable as a file. --
//
// The round-trip tests above prove IR-level stability but never pin the exact
// YAML text. These goldens capture the full serialized document for a small
// corpus so a reviewer can open a `.yaml` next to its `.osi.golden.yaml` and see
// exactly what the serializer emits. The same corpus backs kc_converter's
// `.pull.golden.yaml`, so diffing the two shows what a Knowledge Catalog round
// trip loses relative to the authored source.
//
//   Regenerate after an intentional serializer change:
//     UPDATE_GOLDENS=1 npx bun test ./tests/libts/semantic/osi_converter.test.ts
describe('golden OSI document: each corpus fixture serializes to its exact YAML',
         () => {
           const CORPUS = [
             'sales_bq_graph_target.yaml',
             'star_orders_customer.yaml',
             'tpcds_date_edge.yaml',
             // The only corpus fixture with actions and constraints, so it is
             // the only golden showing the custom `semantic-action` and
             // `semantic-constraint` types.
             'actions_place_order.yaml',
           ];
           // Same load defaults as the KC e2e/pull goldens, so the OSI golden
           // and the pull golden are directly comparable.
           const LOAD = {
             defaultProject: 'sqlgen-testing',
             defaultDataset: 'demo',
             allowLegacyBareSource: true,
           };
           const osiGoldenPath = (fixture: string) =>
               path.join(FIXTURES, fixture.replace(/\.yaml$/, '.osi.golden.yaml'));

           for (const fixture of CORPUS) {
             test(fixture, () => {
               const text = fs.readFileSync(path.join(FIXTURES, fixture), 'utf8');
               const models = loadModels(text, LOAD).models;
               const actual = models.map(m => serializeModel(m).yaml).join('---\n');
               const golden = osiGoldenPath(fixture);
               if (process.env.UPDATE_GOLDENS) {
                 fs.writeFileSync(golden, actual);
                 return;
               }
               if (!fs.existsSync(golden)) {
                 throw new Error(`missing golden ${
                     path.basename(golden)} \u2014 run UPDATE_GOLDENS=1 to create it`);
               }
               expect(actual).toBe(fs.readFileSync(golden, 'utf8'));
             });
           }
         });


describe('a projection is only emitted when it will supply a type', () => {
  test('a field carrying no datatype falls back and warns', () => {
    // The field resolves by NAME, so the pair looked emittable and the
    // parameter's resolved `type` was suppressed in favour of it. On reload
    // the projection resolves to no type at all, and the document this wrote
    // fails to load -- against a model that was fine.
    const model: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'Order',
        dataSource: 'p.d.o',
        keys: ['key'],
        fields: [{name: 'key', expression: 'key'}],
      }],
      relationships: [],
      metrics: [],
      actions: [{
        name: 'Close',
        executor: {kind: 'mcp', mcp: {server: '//x/mcpServers/s', tool: 't'}},
        parameters: [{name: 'order', concept: 'Order', field: 'key'}],
      }],
    };
    const warnings: string[] = [];
    const doc = modelDocument(model, warnings) as any;
    const param = doc.semantic_model[0].actions[0].parameters[0];
    expect(param.concept).toBeUndefined();
    expect(warnings.some(
               w => w.includes('parameter \'order\'') &&
                   w.includes('no resolved datatype')))
        .toBe(true);
  });

  test('a field carrying a datatype still emits as a projection', () => {
    const model: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'Order',
        dataSource: 'p.d.o',
        keys: ['key'],
        fields: [{name: 'key', type: 'String', expression: 'key'}],
      }],
      relationships: [],
      metrics: [],
      actions: [{
        name: 'Close',
        executor: {kind: 'mcp', mcp: {server: '//x/mcpServers/s', tool: 't'}},
        parameters: [
          {name: 'order', concept: 'Order', field: 'key', type: 'String'}
        ],
      }],
    };
    const warnings: string[] = [];
    const doc = modelDocument(model, warnings) as any;
    const param = doc.semantic_model[0].actions[0].parameters[0];
    expect(param.concept).toBe('Order');
    expect(param.field).toBe('key');
    expect(param.datatype).toBeUndefined();
    expect(warnings.some(w => w.includes('parameter \'order\''))).toBe(false);
  });

  const projectionModel =
      (entity: Partial<Entity>,
       parameters: ActionParameter[]): SemanticModel => ({
        name: 'm',
        entities: [{
          name: 'Order',
          dataSource: 'p.d.o',
          keys: ['key'],
          fields: [{name: 'key', type: 'String', expression: 'key'}],
          ...entity,
        }],
        relationships: [],
        metrics: [],
        actions: [{
          name: 'Close',
          executor: {kind: 'mcp', mcp: {server: '//x/mcpServers/s', tool: 't'}},
          parameters,
        }],
      });

  test('falls back when a projected field carries datatype Opaque', () => {
    const model = projectionModel(
        {fields: [{name: 'key', type: 'Opaque', expression: 'key'}]}, [
          {name: 'fallback', concept: 'Order', field: 'key', type: 'String'},
          {name: 'opaque', concept: 'Order', field: 'key', type: 'Opaque'},
        ]);
    const warnings: string[] = [];

    const doc = modelDocument(model, warnings);
    const [withFallback, withOpaque] =
        doc.semantic_model[0].actions[0].parameters;

    expect(withFallback.concept).toBeUndefined();
    expect(withFallback.field).toBeUndefined();
    expect(withFallback.type).toBe('String');
    expect(withOpaque.concept).toBeUndefined();
    expect(withOpaque.field).toBeUndefined();
    expect(withOpaque.type).toBe('Opaque');
    expect(doc.semantic_model[0].entities[0].fields[0].datatype)
        .toBeUndefined();
    expect(warnings.some(w => w.includes('parameter \'fallback\'')))
        .toBe(false);
    expect(warnings.some(w => w.includes('parameter \'opaque\''))).toBe(false);
  });

  test('keeps a standalone parameter typed Opaque', () => {
    const model = projectionModel(
        {}, [{name: 'payload', type: 'Opaque', required: true}]);
    const {entries, entryLinks} = generateCatalogResources(model, {
      project: 'p',
      location: 'us',
      entryGroup: 'eg',
      emitExpressions: true,
    });
    const rebuilt = modelsFromCatalogResources(entries, entryLinks).models[0];

    const {yaml: text, warnings} = serializeModel(rebuilt);
    const reloaded = loadModels(text).models[0];

    expect(warnings).toEqual([]);
    expect(reloaded.actions?.[0].parameters?.[0]).toEqual({
      name: 'payload',
      type: 'Opaque',
      required: true,
    });
  });

  test(
      'keeps projections as authored when inheritance fails to resolve', () => {
        const model = projectionModel({extends: ['MissingSuper']}, [
          {name: 'order', concept: 'Order', field: 'key', type: 'String'},
        ]);
        const warnings: string[] = [];

        const doc = modelDocument(model, warnings);
        const param = doc.semantic_model[0].actions[0].parameters[0];

        expect(param.concept).toBe('Order');
        expect(param.field).toBe('key');
        expect(param.type).toBeUndefined();
      });
});


describe('dual-version model serialization', () => {
  const idField: Field = {name: 'id', expression: 'id'};
  const baseOrders: Entity = {
    name: 'orders',
    dataSource: 'p.d.orders',
    keys: ['id'],
    fields: [idField],
  };
  const emptyModel: SemanticModel = {
    name: 'm',
    entities: [],
    relationships: [],
    metrics: [],
  };

  function firstModelDoc(model: SemanticModel, warnings?: string[]) {
    return modelDocument(model, warnings).semantic_model[0];
  }

  test('selects output format from model.version', () => {
    const base: SemanticModel = {...emptyModel, entities: [baseOrders]};

    const fromUndefined = modelDocument(base);
    const fromGoogle = modelDocument({...base, version: '0.2.0.dev0/google'});
    const fromVanilla = modelDocument({...base, version: '0.2.0.dev0'});

    expect(fromUndefined.version).toBe('0.2.0.dev0/google');
    expect(fromUndefined.semantic_model[0].entities).toBeDefined();
    expect(fromUndefined.semantic_model[0].datasets).toBeUndefined();
    expect(fromGoogle.version).toBe('0.2.0.dev0/google');
    expect(fromGoogle.semantic_model[0].entities).toBeDefined();
    expect(fromGoogle.semantic_model[0].datasets).toBeUndefined();
    expect(fromVanilla.version).toBe('0.2.0.dev0');
    expect(fromVanilla.semantic_model[0].datasets).toBeDefined();
    expect(fromVanilla.semantic_model[0].entities).toBeUndefined();
  });

  test('formats stringForm expressions per version', () => {
    const entity: Entity = {
      ...baseOrders,
      fields: [
        {
          ...idField,
          stringForm: true,
          dialects: [{dialect: 'ANSI_SQL', expression: 'id'}],
        },
        {name: 'doubled', expression: 'amount * 2', stringForm: true},
      ],
    };
    const base: SemanticModel = {...emptyModel, entities: [entity]};

    const googleDoc = firstModelDoc({...base, version: '0.2.0.dev0/google'});
    const vanillaDoc = firstModelDoc({...base, version: '0.2.0.dev0'});

    expect(googleDoc.entities[0].fields[0].expression).toBe('id');
    expect(googleDoc.entities[0].fields[1].expression).toBe('amount * 2');
    expect(vanillaDoc.datasets[0].fields[0].expression).toEqual({
      dialects: [{dialect: 'ANSI_SQL', expression: 'id'}],
    });
    expect(vanillaDoc.datasets[0].fields[1].expression).toEqual({
      dialects: [{dialect: 'ANSI_SQL', expression: 'amount * 2'}],
    });
  });

  for (const version of ['0.2.0.dev0/google', '0.2.0.dev0'] as const) {
    test(
        `preserves dialect order and filters unallowed labels in ${version}`,
        () => {
          const badDialect = 'ORACLE' as unknown as SqlDialect;
          const mixedMetric: Metric = {
            name: 'total',
            expression: 'SUM(x)',
            dialects: [
              {dialect: 'POSTGRES', expression: 'SUM(x)'},
              {dialect: badDialect, expression: 'SUM(x)'},
              {dialect: 'ANSI_SQL', expression: 'SUM(x)'},
            ],
          };
          const allUnallowedMetric: Metric = {
            name: 'fallback_metric',
            expression: 'COUNT(x)',
            dialects: [{dialect: badDialect, expression: 'COUNT(x)'}],
          };
          const model: SemanticModel = {
            ...emptyModel,
            version,
            metrics: [mixedMetric, allUnallowedMetric],
          };

          const doc = firstModelDoc(model);

          expect(doc.metrics[0].expression).toEqual({
            dialects: [
              {dialect: 'POSTGRES', expression: 'SUM(x)'},
              {dialect: 'ANSI_SQL', expression: 'SUM(x)'},
            ],
          });
          expect(doc.metrics[1].expression).toEqual({
            dialects: [{dialect: 'BIGQUERY', expression: 'COUNT(x)'}],
          });
        });
  }

  test('formats ai_context additionalProperties per version', () => {
    const modelWithAi =
        (aiContext: SemanticModel['aiContext'],
         version?: SemanticModel['version']): SemanticModel => ({
          ...emptyModel,
          version,
          aiContext,
        });
    const both = modelWithAi({
      instructions: 'use carefully',
      additionalProperties: {team: 'analytics', empty: undefined},
    });
    const customOnly =
        modelWithAi({additionalProperties: {owner: 'data-team'}});
    const onlyUndefined = modelWithAi(
        {instructions: 'only', additionalProperties: {x: undefined}},
        '0.2.0.dev0/google');
    const emptyContext = modelWithAi(
        {additionalProperties: {x: undefined}}, '0.2.0.dev0/google');

    const googleDoc = firstModelDoc({...both, version: '0.2.0.dev0/google'});
    const vanillaDoc = firstModelDoc({...both, version: '0.2.0.dev0'});
    const customGoogle =
        firstModelDoc({...customOnly, version: '0.2.0.dev0/google'});
    const customVanilla = firstModelDoc({...customOnly, version: '0.2.0.dev0'});
    const onlyUndefinedDoc = firstModelDoc(onlyUndefined);
    const emptyContextDoc = firstModelDoc(emptyContext);

    expect(googleDoc.ai_context).toEqual({
      instructions: 'use carefully',
      custom: {team: 'analytics'},
    });
    expect(vanillaDoc.ai_context).toEqual({
      instructions: 'use carefully',
      team: 'analytics',
    });
    expect(customGoogle.ai_context).toEqual({custom: {owner: 'data-team'}});
    expect(customVanilla.ai_context).toEqual({owner: 'data-team'});
    expect(onlyUndefinedDoc.ai_context).toEqual({instructions: 'only'});
    expect(emptyContextDoc.ai_context).toBeUndefined();
  });

  test(
      'emits metric entity only from authoredEntity under 0.2.0.dev0/google',
      () => {
        const model: SemanticModel = {
          ...emptyModel,
          entities: [{
            ...baseOrders,
            fields: [idField, {name: 'amt', expression: 'amt'}],
          }],
          metrics: [
            {
              name: 'authored',
              entity: 'orders',
              authoredEntity: 'orders',
              expression: 'SUM(orders.amt)',
            },
            {name: 'derived', entity: 'orders', expression: 'SUM(orders.amt)'},
          ],
        };

        const googleDoc =
            firstModelDoc({...model, version: '0.2.0.dev0/google'});
        const vanillaDoc = firstModelDoc({...model, version: '0.2.0.dev0'});

        expect(googleDoc.metrics[0].entity).toBe('orders');
        expect(googleDoc.metrics[1].entity).toBeUndefined();
        expect(vanillaDoc.metrics[0].entity).toBeUndefined();
        expect(vanillaDoc.metrics[1].entity).toBeUndefined();
      });

  test(
      'omits Google-only keys under 0.2.0.dev0 and warns on missing source',
      () => {
        const target =
            'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';
        const model: SemanticModel = {
          ...emptyModel,
          version: '0.2.0.dev0',
          deployments: [{name: 'prod', target}],
          entities: [
            {...baseOrders, name: 'base', dataSource: '', abstract: true},
            {...baseOrders, extends: ['base']},
          ],
          relationships: [{
            name: 'rel',
            source: {entity: 'orders', columns: ['id']},
            destination: {entity: 'base', columns: ['id']},
            description: 'rel desc',
          }],
          actions: [{
            name: 'act',
            executor:
                {kind: 'mcp', mcp: {server: '//x/mcpServers/s', tool: 't'}},
            parameters: [],
          }],
          constraints: [{
            name: 'con',
            judgment: 'orders.id is valid',
            onViolation: 'reject',
          }],
        };
        const warnings: string[] = [];

        const doc = firstModelDoc(model, warnings);

        expect(doc.deployments).toBeUndefined();
        expect(doc.actions).toBeUndefined();
        expect(doc.constraints).toBeUndefined();
        expect(doc.datasets[0].abstract).toBeUndefined();
        expect(doc.datasets[0].source).toBeUndefined();
        expect(doc.datasets[1].extends).toBeUndefined();
        expect(doc.relationships[0].description).toBeUndefined();
        expect(warnings.some(w => w.includes('entity \'base\' has no source')))
            .toBe(true);
      });

  for (const version of ['0.2.0.dev0/google', '0.2.0.dev0'] as const) {
    test(`omits datatype Opaque on fields and metrics in ${version}`, () => {
      const model: SemanticModel = {
        ...emptyModel,
        version,
        entities: [{
          ...baseOrders,
          fields: [
            {...idField, type: 'String'},
            {name: 'payload', type: 'Opaque', expression: 'payload'},
          ],
        }],
        metrics: [{name: 'm1', type: 'Opaque', expression: 'COUNT(orders.id)'}],
      };

      const doc = firstModelDoc(model);
      const list = doc.entities ?? doc.datasets;

      expect(list[0].fields[0].datatype).toBe('String');
      expect(list[0].fields[1].datatype).toBeUndefined();
      expect(doc.metrics[0].datatype).toBeUndefined();
    });
  }

  for (const version of ['0.2.0.dev0/google', '0.2.0.dev0'] as const) {
    test(
        `round-trips custom_extensions across all 5 IR types in ${version}`,
        () => {
          const ext: CustomExtension[] = [
            {vendorName: 'DBT', data: '{"meta":"v"}'},
          ];
          const stringForm = version === '0.2.0.dev0/google';
          const typedId: Field = {
            ...idField,
            type: 'String',
            stringForm,
            dialects: [{dialect: 'ANSI_SQL', expression: 'id'}],
          };
          const model: SemanticModel = {
            ...emptyModel,
            version,
            customExtensions: ext,
            entities: [
              {
                ...baseOrders,
                authoredSource: 'bigquery.googleapis.com/projects/p/datasets/d/tables/orders',
                customExtensions: ext,
                fields: [{...typedId, customExtensions: ext}],
              },
              {
                ...baseOrders,
                name: 'customers',
                dataSource: 'p.d.customers',
                authoredSource: 'bigquery.googleapis.com/projects/p/datasets/d/tables/customers',
                fields: [typedId],
              },
            ],
            relationships: [{
              name: 'orders_customer',
              source: {entity: 'orders', columns: ['id']},
              destination: {entity: 'customers', columns: ['id']},
              customExtensions: ext,
            }],
            metrics: [{
              name: 'total',
              entity: 'orders',
              expression: 'COUNT(orders.id)',
              stringForm,
              dialects: [
                {dialect: 'ANSI_SQL', expression: 'COUNT(orders.id)'},
              ],
              customExtensions: ext,
            }],
          };

          const serialized = serializeModel(model);
          const reloaded = loadModels(serialized.yaml).models[0];

          expect(serialized.warnings).toEqual([]);
          expect(reloaded).toEqual(model);
        });
  }

  test('warns for each Google-only IR construct dropped under 0.2.0.dev0', () => {
    const model: SemanticModel = {
      ...emptyModel,
      version: '0.2.0.dev0',
      deployments: [{name: 'prod', target: 'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g'}],
      profiles: [{name: 'prod', entities: [], relationships: []}],
      entities: [{...baseOrders, extends: ['base']}],
      relationships: [{
        name: 'rel',
        source: {entity: 'orders', columns: ['id']},
        destination: {entity: 'orders', columns: ['id']},
        description: 'rel desc',
      }],
      metrics: [{
        name: 'total',
        authoredEntity: 'orders',
        expression: 'COUNT(*)',
      }],
      actions: [{
        name: 'act',
        executor: {kind: 'mcp', mcp: {server: '//x/mcpServers/s', tool: 't'}},
        parameters: [],
      }],
      constraints: [{
        name: 'con',
        judgment: 'orders.id is valid',
        onViolation: 'reject',
      }],
    };

    const {warnings} = serializeModel(model);

    expect(warnings).toEqual([
      `model 'm': 'actions' has no representation under '0.2.0.dev0' and is not serialized`,
      `model 'm': 'constraints' has no representation under '0.2.0.dev0' and is not serialized`,
    ]);
  });

  // A GOOGLE block the model keeps, such as one that lists deploymentTargets,
  // is written as it is, with any profiles in it; when profiles were in a
  // separate block, the serializer writes them back into a GOOGLE block.
  test('does not warn about profiles in a GOOGLE block the model keeps under 0.2.0.dev0', () => {
    const block = (data: object) =>
        `      - vendor_name: GOOGLE\n        data: '${JSON.stringify(data)}'\n`;
    const text = (blocks: string) => `version: "0.2.0.dev0"
semantic_model:
  - name: m
    custom_extensions:
${blocks}    datasets:
      - name: orders
        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders
        primary_key: [id]
        fields:
          - name: id
            expression: {dialects: [{dialect: ANSI_SQL, expression: id}]}
`;
    const target = 'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';
    const prod = {name: 'prod'};

    const [kept] = loadModels(text(block({deploymentTargets: [target], profiles: [prod]}))).models;
    const written = serializeModel(kept);
    expect(written.warnings).toEqual([]);
    expect(loadModels(written.yaml).models[0]).toEqual(kept);

    const [own] = loadModels(text(block({deploymentTargets: [target]}) + block({profiles: [prod]}))).models;
    const ownWritten = serializeModel(own);
    expect(ownWritten.warnings).toEqual([]);
    expect(loadModels(ownWritten.yaml).models[0]).toEqual(own);
  });

  test('warns that abstract is dropped under 0.2.0.dev0', () => {
    const model: SemanticModel = {
      ...emptyModel,
      version: '0.2.0.dev0',
      entities: [{
        name: 'base',
        dataSource: '',
        abstract: true,
        keys: ['id'],
        fields: [idField],
      }],
    };

    const {warnings} = serializeModel(model);

    expect(warnings).toEqual([
      `entity 'base' has no source; the serialized document will not reload until a source is set`,
      `entity 'base': 'abstract' has no representation under '0.2.0.dev0' and is not serialized`,
    ]);
  });

  test(
      'warns on missing source and expression in 0.2.0.dev0 even when logical',
      () => {
        const model: SemanticModel = {
          ...emptyModel,
          version: '0.2.0.dev0',
          entities: [
            {name: 'orders', dataSource: '', keys: [], fields: [{name: 'id'}]}
          ],
        };

        const {warnings} = serializeModel(model, {logical: true});

        expect(warnings).toEqual([
          `entity 'orders' has no source; the serialized document will not reload until a source is set`,
          `field 'id': no expression; a '0.2.0.dev0' document requires one per field and will not load until it is set.`,
        ]);
      });

  test(
      'does not warn on unbound fields of an abstract entity in 0.2.0.dev0/google',
      () => {
        const model: SemanticModel = {
          ...emptyModel,
          entities: [{
            name: 'base',
            dataSource: '',
            abstract: true,
            keys: [],
            fields: [{name: 'id', type: 'String'}],
          }],
        };

        const {yaml: text, warnings} = serializeModel(model);

        expect(warnings).toEqual([]);
        expect(() => loadModels(text)).not.toThrow();
      });

  test(
      'warns when an imported expression has a dialect outside ALLOWED_DIALECTS',
      () => {
        const model: SemanticModel = {
          ...emptyModel,
          entities: [{
            ...baseOrders,
            fields: [
              {
                name: 'amt',
                expression: 'orders.amt',
                importedExpression: 'orders.AMT',
                importedDialect: 'BIGQUERY',
              },
              {
                name: 'unknown_dialect',
                expression: 'orders.id',
                importedExpression: 'orders.ID',
                importedDialect: 'IMPORTED',
              },
            ],
          }],
        };

        const {warnings} = serializeModel(model);

        expect(warnings).toEqual([
          `field 'amt': imported expression in dialect 'BIGQUERY' has the same dialect as the expression and is not serialized`,
          `field 'unknown_dialect': imported expression in dialect 'IMPORTED' is not a dialect the loader accepts and is not serialized`,
        ]);
      });

  test('keeps an imported expression beside a short-form expression', () => {
    const model: SemanticModel = {
      ...emptyModel,
      entities: [{
        ...baseOrders,
        fields: [{
          name: 'amt',
          expression: 'orders.amt',
          stringForm: true,
          importedExpression: 'NVL(orders.amt, 0)',
          importedDialect: 'SNOWFLAKE',
        }],
      }],
    };

    const doc = firstModelDoc(model);

    expect(doc.entities[0].fields[0].expression).toEqual({
      dialects: [
        {dialect: 'ANSI_SQL', expression: 'orders.amt'},
        {dialect: 'SNOWFLAKE', expression: 'NVL(orders.amt, 0)'},
      ],
    });
  });

  test('warns for each expression dropped for its dialect', () => {
    const model: SemanticModel = {
      ...emptyModel,
      entities: [{
        ...baseOrders,
        fields: [
          {
            name: 'no_dialect',
            expression: 'orders.a',
            importedExpression: 'orders.A',
          },
          {
            name: 'bad_in_list',
            expression: 'orders.b',
            dialects: [
              {dialect: 'ANSI_SQL', expression: 'orders.b'},
              {dialect: 'ORACLE' as SqlDialect, expression: 'orders.B'},
            ],
          },
        ],
      }],
    };

    const {warnings} = serializeModel(model);

    expect(warnings).toEqual([
      `field 'no_dialect': imported expression has no dialect and is not serialized`,
      `field 'bad_in_list': expression in dialect 'ORACLE' is not a dialect the loader accepts and is not serialized`,
    ]);
  });

  test('warns when a 0.2.0.dev0 relationship has no join columns', () => {
    const model: SemanticModel = {
      ...emptyModel,
      version: '0.2.0.dev0',
      entities: [
        baseOrders,
        {...baseOrders, name: 'customers', dataSource: 'p.d.customers'},
      ],
      relationships: [{
        name: 'orders_customer',
        source: {entity: 'orders', columns: []},
        destination: {entity: 'customers', columns: []},
      }],
    };

    const {warnings} = serializeModel(model);

    expect(warnings).toEqual([
      `relationship 'orders_customer': no join columns; a '0.2.0.dev0' document requires from_columns and to_columns and will not load until they are set.`,
    ]);
  });

  test('0.2.0.dev0 output drops a field-level GOOGLE block with a warning', () => {
    const google: CustomExtension[] = [
      {vendorName: 'GOOGLE', data: '{"label":"Id"}'},
    ];
    const model: SemanticModel = {
      ...emptyModel,
      version: '0.2.0.dev0',
      entities: [{
        ...baseOrders,
        authoredSource: 'bigquery.googleapis.com/projects/p/datasets/d/tables/orders',
        fields: [{
          name: 'id',
          expression: 'id',
          dialects: [{dialect: 'ANSI_SQL', expression: 'id'}],
          customExtensions: google,
        }],
      }],
    };

    const {yaml: text, warnings} = serializeModel(model);

    expect(() => loadModels(text)).not.toThrow();
    expect(warnings).toEqual([
      `field 'id': 1 GOOGLE custom_extension(s) have no representation on a field under '0.2.0.dev0' and are not serialized`,
    ]);
  });

  for (const compactFlow of [false, true]) {
    test(
        `quotes YAML 1.1 booleans and dates (compactFlow=${compactFlow})`,
        () => {
          const model: SemanticModel = {
            ...emptyModel,
            aiContext: {
              additionalProperties:
                  {flag: 'yes', toggle: 'on', day: '2001-12-14'},
            },
            entities: [baseOrders],
          };

          const {yaml: text} = serializeModel(model, {compactFlow});
          const parsed = yaml.parse(text, {version: '1.1'});
          const custom = parsed.semantic_model[0].ai_context.custom;

          expect(custom).toEqual(
              {flag: 'yes', toggle: 'on', day: '2001-12-14'});
        });
  }
});


describe('serializeModelFiles and profile sidecar files', () => {
  const baseEntity: Entity = {
    name: 'orders',
    dataSource: 'p.d.orders',
    keys: ['id'],
    fields: [{name: 'id', expression: 'id'}],
  };

  const vanillaOrders: Entity = {
    name: 'orders',
    dataSource: 'p.d.orders',
    authoredSource: 'bigquery.googleapis.com/projects/p/datasets/d/tables/orders',
    keys: ['id'],
    fields: [{
      name: 'id',
      expression: 'id',
      dialects: [{dialect: 'ANSI_SQL', expression: 'id'}],
      stringForm: false,
    }],
  };

  const prodProfile: ProfileSpec = {
    name: 'prod',
    entities: [
      {
        name: 'orders',
        source: 'bigquery.googleapis.com/projects/prod/datasets/sales/tables/orders',
        primaryKey: ['order_id'],
        uniqueKeys: [['order_code', 'region']],
        fields: [
          {
            name: 'id',
            expression: 'order_id',
            stringForm: true,
            dialects: [{dialect: 'ANSI_SQL', expression: 'order_id'}],
          },
          {
            name: 'total',
            expression: 'SAFE_CAST(total AS FLOAT64)',
            importedExpression: 'TRY_CAST(total AS DOUBLE)',
            importedDialect: 'SNOWFLAKE',
            stringForm: false,
            dialects: [
              {
                dialect: 'BIGQUERY',
                expression: 'SAFE_CAST(total AS FLOAT64)',
              },
              {
                dialect: 'SNOWFLAKE',
                expression: 'TRY_CAST(total AS DOUBLE)',
              },
            ],
          },
        ],
        fieldsExclude: ['internal_note'],
      },
      {name: 'bare', source: 'bigquery.googleapis.com/projects/prod/datasets/sales/tables/bare'},
    ],
    relationships: [
      {
        name: 'orders_customer',
        fromColumns: ['customer_id'],
        toColumns: ['id'],
      },
      {name: 'partial_rel', fromColumns: ['id'], toColumns: []},
    ],
    metricsExclude: ['draft_revenue', 'debug_count'],
    actions: [
      {
        name: 'CloseMcp',
        executor: {kind: 'mcp', mcp: {server: '//x/mcpServers/s', tool: 't'}},
      },
      {
        name: 'CloseRest',
        executor: {
          kind: 'rest',
          rest: {endpoint: 'https://api.example/x', method: 'POST'}
        },
      },
      {
        name: 'CloseGrpc',
        executor: {kind: 'grpc', grpc: {service: 'OrderSvc', method: 'Close'}},
      },
      {
        name: 'CloseSql',
        executor: {kind: 'sql', sql: {statements: ['DELETE FROM orders']}},
      },
      {name: 'KeepInherited'},
      {name: 'WithdrawExecutor', executor: null},
    ],
  };

  const stagingProfile: ProfileSpec = {
    name: 'staging',
    entities: [{
      name: 'orders',
      primaryKey: [],
      uniqueKeys: [],
      fields: [],
      fieldsExclude: [],
    }],
    relationships: [],
    metricsExclude: '*',
    actions: [],
  };

  const minimalProfile: ProfileSpec = {
    name: 'minimal',
    entities: [],
    relationships: [],
  };

  // `metrics_exclude: []` is the one empty list `stagingProfile` cannot carry,
  // since it states "*".
  const noneExcludedProfile: ProfileSpec = {
    name: 'noneexcluded',
    entities: [],
    relationships: [],
    metricsExclude: [],
  };

  test(
      'emits the model file and one sidecar file per profile in Google version',
      () => {
        const model: SemanticModel = {
          name: 'retail',
          entities: [baseEntity],
          relationships: [],
          metrics: [],
          profiles: [prodProfile, stagingProfile],
        };

        const result = serializeModelFiles(model);
        const single = serializeModel(model);
        const compactResult = serializeModelFiles(model, {compactFlow: true});

        expect(result.files.map(f => f.fileName)).toEqual([
          'retail.yaml',
          'retail.profile.prod.yaml',
          'retail.profile.staging.yaml',
        ]);
        expect(single.yaml).toBe(result.files[0].content);
        expect(single.warnings).toEqual(result.warnings);
        expect(compactResult.files[1].content)
            .toContain('primary_key: [order_id]');
        expect(loadProfileFile(compactResult.files[1].content, 'prod'))
            .toEqual(prodProfile);
      });

  test('omits profile sidecar files under 0.2.0.dev0', () => {
    const model: SemanticModel = {
      name: 'retail',
      version: '0.2.0.dev0',
      entities: [vanillaOrders],
      relationships: [],
      metrics: [],
      profiles: [prodProfile, stagingProfile],
    };

    const result = serializeModelFiles(model);

    expect(result.files.map(f => f.fileName)).toEqual(['retail.yaml']);
    expect(result.warnings).toEqual([]);
    const [reloaded] = loadModels(result.files[0].content).models;
    expect(reloaded.profiles).toEqual([prodProfile, stagingProfile]);
  });

  // Acceptance (Round-trip, YAML -> IR -> YAML -> IR): start from an authored
  // vanilla '0.2.0.dev0' document with GOOGLE blocks at all four levels beside
  // third-party custom_extensions, load, write back out, and load again.
  test(
      'round-trips authored vanilla YAML with GOOGLE blocks at all four levels and third-party extensions',
      () => {
        const authoredYaml = [
          'version: "0.2.0.dev0"',
          'semantic_model:',
          '  - name: retail',
          '    custom_extensions:',
          '      - vendor_name: ACME',
          '        data: \'{"model_meta":true}\'',
          '      - vendor_name: GOOGLE',
          '        data: \'{"deployments":[{"name":"prod_bq","target":"bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g","profile":"prod"}],"profiles":[{"name":"prod","entities":[{"name":"orders","source":"bigquery.googleapis.com/projects/p/datasets/d/tables/orders_prod","fields":[{"name":"id","expression":"order_id"}]}]}]}\'',
          '    datasets:',
          '      - name: orders',
          '        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders',
          '        primary_key: [id]',
          '        fields:',
          '          - name: id',
          '            expression:',
          '              dialects:',
          '                - dialect: ANSI_SQL',
          '                  expression: id',
          '      - name: vip_orders',
          '        source: bigquery.googleapis.com/projects/p/datasets/d/tables/vip_orders',
          '        primary_key: [id]',
          '        custom_extensions:',
          '          - vendor_name: GOOGLE',
          '            data: \'{"extends":["orders"]}\'',
          '          - vendor_name: ACME',
          '            data: \'{"entity_meta":1}\'',
          '        fields:',
          '          - name: amt',
          '            expression:',
          '              dialects:',
          '                - dialect: ANSI_SQL',
          '                  expression: amt',
          '    relationships:',
          '      - name: vip_to_order',
          '        from: vip_orders',
          '        to: orders',
          '        from_columns: [id]',
          '        to_columns: [id]',
          '        custom_extensions:',
          '          - vendor_name: ACME',
          '            data: \'{"rel_meta":2}\'',
          '          - vendor_name: GOOGLE',
          '            data: \'{"description":"VIP order to base order"}\'',
          '    metrics:',
          '      - name: vip_spend',
          '        expression:',
          '          dialects:',
          '            - dialect: ANSI_SQL',
          '              expression: SUM(vip_orders.amt) / COUNT(orders.id)',
          '        custom_extensions:',
          '          - vendor_name: ACME',
          '            data: \'{"metric_meta":3}\'',
          '          - vendor_name: GOOGLE',
          '            data: \'{"entity":"vip_orders"}\'',
        ].join('\n');

        const [loaded] = loadModels(authoredYaml).models;
        const {files, warnings} = serializeModelFiles(loaded);

        expect(warnings).toEqual([]);
        expect(files.map(f => f.fileName)).toEqual(['retail.yaml']);
        const [reloaded] = loadModels(files[0].content).models;
        expect(reloaded).toEqual(loaded);
        expect(serializeModel(reloaded).yaml).toBe(files[0].content);
      });

  // Acceptance (Writing): each construct lands in a GOOGLE block on its owning
  // object after third-party blocks, and objects with empty/inferred values
  // emit no GOOGLE block.
  test(
      'emits exact GOOGLE block structure at all four levels and omits empty or inferred blocks',
      () => {
        const profiles =
            [prodProfile, stagingProfile, minimalProfile, noneExcludedProfile];
        const bqTarget =
            'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';
        const spTarget =
            'spanner.googleapis.com/projects/p/instances/i/databases/d/graphs/g';
        const vipOrders: Entity = {
          name: 'vip_orders',
          dataSource: 'p.d.vip_orders',
          authoredSource: 'bigquery.googleapis.com/projects/p/datasets/d/tables/vip_orders',
          extends: ['orders'],
          keys: ['id'],
          fields: [{
            name: 'id',
            expression: 'id',
            dialects: [{dialect: 'ANSI_SQL', expression: 'id'}],
            stringForm: false,
          }],
          customExtensions: [{vendorName: 'ACME', data: '{"entity_meta":1}'}],
        };
        const model: SemanticModel = {
          name: 'retail',
          version: '0.2.0.dev0',
          deployments: [
            {name: 'prod_bq', target: bqTarget, profile: 'prod'},
            {name: 'staging_sp', target: spTarget},
          ],
          profiles,
          customExtensions: [{vendorName: 'ACME', data: '{"model_meta":true}'}],
          entities: [vanillaOrders, vipOrders],
          relationships: [{
            name: 'vip_to_order',
            source: {entity: 'vip_orders', columns: ['id']},
            destination: {entity: 'orders', columns: ['id']},
            description: 'VIP order to base order',
            customExtensions: [{vendorName: 'ACME', data: '{"rel_meta":2}'}],
          }],
          metrics: [
            {
              name: 'vip_count',
              authoredEntity: 'vip_orders',
              entity: 'vip_orders',
              expression: 'COUNT(*)',
              dialects: [{dialect: 'ANSI_SQL', expression: 'COUNT(*)'}],
              stringForm: false,
              customExtensions:
                  [{vendorName: 'ACME', data: '{"metric_meta":3}'}],
            },
            {
              // Inferred `entity` (no `authoredEntity`) must NOT emit a GOOGLE
              // block.
              name: 'order_count',
              entity: 'orders',
              expression: 'COUNT(orders.id)',
              dialects: [{dialect: 'ANSI_SQL', expression: 'COUNT(orders.id)'}],
              stringForm: false,
            },
          ],
        };

        const doc = modelDocument(model).semantic_model[0];

        expect(doc.custom_extensions).toEqual([
          {vendor_name: 'ACME', data: '{"model_meta":true}'},
          {
            vendor_name: 'GOOGLE',
            data: JSON.stringify({
              profiles:
                  serializeModelFiles({...model, version: '0.2.0.dev0/google'})
                      .files.slice(1)
                      .map(f => yaml.parse(f.content)),
              deployments: model.deployments,
            }),
          },
        ]);
        expect(doc.datasets[0].custom_extensions).toBeUndefined();
        expect(doc.datasets[1].custom_extensions).toEqual([
          {vendor_name: 'ACME', data: '{"entity_meta":1}'},
          {vendor_name: 'GOOGLE', data: '{"extends":["orders"]}'},
        ]);
        expect(doc.relationships[0].custom_extensions).toEqual([
          {vendor_name: 'ACME', data: '{"rel_meta":2}'},
          {
            vendor_name: 'GOOGLE',
            data: '{"description":"VIP order to base order"}'
          },
        ]);
        expect(doc.metrics[0].custom_extensions).toEqual([
          {vendor_name: 'ACME', data: '{"metric_meta":3}'},
          {vendor_name: 'GOOGLE', data: '{"entity":"vip_orders"}'},
        ]);
        expect(doc.metrics[1].custom_extensions).toBeUndefined();

        const {files, warnings} = serializeModelFiles(model);
        expect(warnings).toEqual([]);
        expect(loadModels(files[0].content).models[0]).toEqual(model);
      });

  // Converting a loaded 0.2.0.dev0/google model (which carries a folded
  // `deploymentTargets` shim on `model.customExtensions`) to 0.2.0.dev0 drops
  // the shim so `readGoogleBlocks` does not see both `deployments` and
  // `deploymentTargets`.
  test(
      'converts a loaded 0.2.0.dev0/google model with deployments and profiles cleanly to 0.2.0.dev0',
      () => {
        const [googleModel] = loadModels([
                                'version: 0.2.0.dev0/google',
                                'semantic_model:',
                                '  - name: retail',
                                '    deployments:',
                                '      - name: prod_bq',
                                '        target: bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g',
                                '        profile: prod',
                                '    entities:',
                                '      - name: base_orders',
                                '        source: bigquery.googleapis.com/projects/p/datasets/d/tables/base_orders',
                                '        primary_key: [id]',
                                '        fields:',
                                '          - name: id',
                                '            expression: id',
                                '      - name: orders',
                                '        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders',
                                '        extends: [base_orders]',
                                '        primary_key: [id]',
                                '        fields: []',
                                '    relationships:',
                                '      - name: order_to_base',
                                '        from: orders',
                                '        to: base_orders',
                                '        from_columns: [id]',
                                '        to_columns: [id]',
                                '        description: Order to base',
                                '    metrics:',
                                '      - name: total',
                                '        entity: orders',
                                '        expression: COUNT(*)',
                              ].join('\n'))
                                  .models;
        googleModel.profiles = [prodProfile];

        const {files, warnings} = serializeModelFiles({
          ...googleModel,
          version: '0.2.0.dev0',
        });

        expect(warnings).toEqual([]);
        expect(files.map(f => f.fileName)).toEqual(['retail.yaml']);
        const [reloaded] = loadModels(files[0].content).models;
        expect(reloaded.version).toBe('0.2.0.dev0');
        expect(reloaded.deployments).toEqual(googleModel.deployments);
        expect(reloaded.profiles).toEqual([prodProfile]);
        expect(reloaded.entities[1].extends).toEqual(['base_orders']);
        expect(reloaded.relationships[0].description).toBe('Order to base');
        expect(reloaded.metrics[0].authoredEntity).toBe('orders');
        expect(reloaded.customExtensions).toBeUndefined();
      });

  // Kept `deploymentTargets` blocks (including empty `[]`, blank `["  "]`, and
  // hand-authored `profiles` with non-canonical key order or empty arrays) are
  // preserved verbatim.
  test('preserves kept deploymentTargets blocks verbatim', () => {
    const vanillaWithBlock = (data: object) =>
        ['version: "0.2.0.dev0"',
         'semantic_model:',
         '  - name: m',
         '    custom_extensions:',
         `      - vendor_name: GOOGLE`,
         `        data: '${JSON.stringify(data)}'`,
         '    datasets:',
         '      - name: orders',
         '        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders',
         '        primary_key: [id]',
         '        fields:',
         '          - name: id',
         '            expression: {dialects: [{dialect: ANSI_SQL, expression: id}]}',
    ].join('\n');

    for (const payload
             of [{deploymentTargets: []},
                 {deploymentTargets: ['  ']},
                 {
                   deploymentTargets: [],
                   profiles: [{
                     entities: [{
                       source: 'bigquery.googleapis.com/projects/x/datasets/y/tables/z',
                       name: 'orders',
                       fields: [{name: 'id', expression: 'oid'}]
                     }],
                     name: 'prod',
                     relationships: [],
                   }],
                 },
    ]) {
      const [loaded] = loadModels(vanillaWithBlock(payload)).models;
      const {yaml: out, warnings} = serializeModel(loaded);
      expect(warnings).toEqual([]);
      expect(yaml.parse(out).semantic_model[0].custom_extensions[0].data)
          .toBe(JSON.stringify(payload));
      expect(loadModels(out).models[0]).toEqual(loaded);
    }
  });

  // In-memory raw GOOGLE blocks on non-field objects (other than the model's
  // kept `deploymentTargets` block) are dropped with a warning under
  // 0.2.0.dev0 so they never collide with the synthesized GOOGLE block.
  test(
      'drops raw in-memory GOOGLE blocks on model and dataset with a warning under 0.2.0.dev0',
      () => {
        const model: SemanticModel = {
          name: 'retail',
          version: '0.2.0.dev0',
          deployments: [{
            name: 'prod_bq',
            target:
                'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g',
          }],
          customExtensions: [
            {
              vendorName: 'GOOGLE',
              data:
                  '{"deployments":[{"name":"prod_bq","target":"bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g"}]}',
            },
            {
              vendorName: 'GOOGLE',
              data: 'not-valid-json',
            },
          ],
          entities: [
            vanillaOrders,
            {
              ...vanillaOrders,
              name: 'vip_orders',
              dataSource: 'p.d.vip_orders',
              authoredSource: 'bigquery.googleapis.com/projects/p/datasets/d/tables/vip_orders',
              extends: ['orders'],
              customExtensions:
                  [{vendorName: 'GOOGLE', data: '{"extends":["orders"]}'}],
            },
          ],
          relationships: [],
          metrics: [],
        };

        const {yaml: out, warnings} = serializeModel(model);

        expect(warnings).toEqual([
          `entity 'vip_orders': 1 GOOGLE custom_extension(s) are not serialized under '0.2.0.dev0'; its GOOGLE block is written from its own fields`,
          `model 'retail': 2 GOOGLE custom_extension(s) are not serialized under '0.2.0.dev0'; its GOOGLE block is written from its own fields`,
        ]);
        const [reloaded] = loadModels(out).models;
        expect(reloaded.deployments).toEqual(model.deployments);
        expect(reloaded.entities[1].extends).toEqual(['orders']);
      });

  test('round-trips every profile feature through loadProfileFile', () => {
    const profiles =
        [prodProfile, stagingProfile, minimalProfile, noneExcludedProfile];
    const model: SemanticModel = {
      name: 'retail',
      version: '0.2.0.dev0/google',
      entities: [baseEntity],
      relationships: [],
      metrics: [],
      profiles,
    };

    const {files} = serializeModelFiles(model);

    for (let i = 0; i < profiles.length; i++) {
      const profile = profiles[i];
      const file = files[i + 1];
      const raw = yaml.parse(file.content);

      expect(file.fileName).toBe(`retail.profile.${profile.name}.yaml`);
      expect(raw.version).toBeUndefined();
      expect(raw.semantic_model).toBeUndefined();
      expect(loadProfileFile(file.content, profile.name)).toEqual(profile);
    }
  });

  test('skips duplicate, reserved, or invalid profile names with warnings', () => {
    const model: SemanticModel = {
      name: 'retail',
      entities: [baseEntity],
      relationships: [],
      metrics: [],
      profiles: [
        {
          name: 'prod',
          entities: [{name: 'orders', source: 'bigquery.googleapis.com/projects/prod/datasets/sales/tables/orders'}],
          relationships: [],
        },
        {
          name: 'Prod',
          entities: [{name: 'orders', source: 'bigquery.googleapis.com/projects/stale/datasets/sales/tables/orders'}],
          relationships: [],
        },
        {name: 'Default', entities: [], relationships: []},
        {name: 'bad/name', entities: [], relationships: []},
      ],
    };

    const {files, warnings} = serializeModelFiles(model);

    expect(files.map(f => f.fileName)).toEqual([
      'retail.yaml',
      'retail.profile.prod.yaml',
    ]);
    expect(files[1].content).toContain('bigquery.googleapis.com/projects/prod/datasets/sales/tables/orders');
    expect(warnings).toEqual([
      `model 'retail': profiles 'prod' and 'Prod' name the same profile (profile names are unique ignoring case); only 'prod' is serialized`,
      `model 'retail': profile 'Default' uses the name reserved for the model's inline bindings and is not serialized`,
      `model 'retail': profile 'bad/name' is not a valid profile name and is not serialized`,
    ]);
  });

  test('words an exact repeat apart from a case-only repeat', () => {
    const model: SemanticModel = {
      name: 'retail',
      entities: [baseEntity],
      relationships: [],
      metrics: [],
      profiles: [
        {name: 'prod', entities: [], relationships: []},
        {name: 'prod', entities: [], relationships: []},
        {name: 'Prod', entities: [], relationships: []},
      ],
    };

    const {files, warnings} = serializeModelFiles(model);

    expect(files.map(f => f.fileName)).toEqual([
      'retail.yaml',
      'retail.profile.prod.yaml',
    ]);
    expect(warnings).toEqual([
      `model 'retail': profile 'prod' is listed more than once; only 'prod' is serialized`,
      `model 'retail': profiles 'prod' and 'Prod' name the same profile (profile names are unique ignoring case); only 'prod' is serialized`,
    ]);
  });

  test(
      'names the entity in profile field warnings and flags missing expressions',
      () => {
        const imported = {
          expression: 'id',
          importedExpression: 'CAST(id AS INT)',
          importedDialect: 'TERADATA',
        };
        const model: SemanticModel = {
          name: 'retail',
          entities: [baseEntity],
          relationships: [],
          metrics: [],
          profiles: [{
            name: 'prod',
            entities: [
              {
                name: 'orders',
                fields: [{name: 'id', ...imported}, {name: 'note'}],
              },
              {name: 'items', fields: [{name: 'id', ...imported}]},
            ],
            relationships: [],
          }],
        };

        const {warnings} = serializeModelFiles(model);

        expect(warnings).toEqual([
          `profile 'prod': entity 'orders': field 'id': imported expression in dialect 'TERADATA' is not a dialect the loader accepts and is not serialized`,
          `profile 'prod': entity 'orders': field 'note': no expression; the profile file will not load until it is set or the field is listed in 'fields_exclude'.`,
          `profile 'prod': entity 'items': field 'id': imported expression in dialect 'TERADATA' is not a dialect the loader accepts and is not serialized`,
        ]);
      });

  test('flags a blank profile field expression, which the loader rejects', () => {
    const model: SemanticModel = {
      name: 'retail',
      entities: [baseEntity],
      relationships: [],
      metrics: [],
      profiles: [{
        name: 'prod',
        entities: [{
          name: 'orders',
          fields: [
            {
              name: 'empty',
              expression: '',
              stringForm: true,
              dialects: [{dialect: 'ANSI_SQL', expression: ''}],
            },
            {name: 'spaces', expression: '   '},
          ],
        }],
        relationships: [],
      }],
    };

    const {files, warnings} = serializeModelFiles(model);

    expect(() => loadProfileFile(files[1].content, 'prod')).toThrow(/blank/);
    expect(warnings).toEqual([
      `profile 'prod': entity 'orders': field 'empty': expression is blank; the profile file will not load until its SQL is written.`,
      `profile 'prod': entity 'orders': field 'spaces': expression is blank; the profile file will not load until its SQL is written.`,
    ]);
  });

  test('does not write YAML anchors for shared IR arrays', () => {
    const cols = ['id'];
    const profile: ProfileSpec = {
      name: 'prod',
      entities: [{name: 'customers', primaryKey: cols}],
      relationships: [{
        name: 'placed_by',
        fromColumns: ['cust'],
        toColumns: cols,
      }],
    };
    const model: SemanticModel = {
      name: 'retail',
      entities: [
        {
          ...baseEntity,
          keys: ['oid'],
          fields: [{name: 'oid', expression: 'oid'}]
        },
        {
          name: 'customers',
          dataSource: 'p.d.customers',
          keys: cols,
          fields: [{name: 'id', expression: 'id'}],
        },
      ],
      relationships: [{
        name: 'placed_by',
        source: {entity: 'orders', columns: ['cust']},
        destination: {entity: 'customers', columns: cols},
      }],
      metrics: [],
      profiles: [profile],
    };

    const blockFiles = serializeModelFiles(model).files;
    const compactFiles = serializeModelFiles(model, {compactFlow: true}).files;

    for (const f of [...blockFiles, ...compactFiles]) {
      expect(f.content).not.toMatch(/[&*]a\d/);
    }
  });

  test('keeps a short profile file a block mapping under compactFlow', () => {
    const model: SemanticModel = {
      name: 'retail',
      entities: [baseEntity],
      relationships: [],
      metrics: [],
      profiles: [
        minimalProfile,
        {
          name: 'nometrics',
          entities: [],
          relationships: [],
          metricsExclude: '*',
        },
      ],
    };

    const {files} = serializeModelFiles(model, {compactFlow: true});

    expect(files[1].content).toBe('name: minimal\n');
    expect(files[2].content).toBe('name: nometrics\nmetrics_exclude: "*"\n');
  });

  test(
      'serializeModel returns the model file and the warnings serializeModelFiles gives',
      () => {
        const model: SemanticModel = {
          name: 'retail',
          entities: [baseEntity],
          relationships: [],
          metrics: [],
          profiles: [{
            name: 'prod',
            entities: [{
              name: 'orders',
              fields: [{
                name: 'id',
                expression: 'id',
                importedExpression: 'CAST(id AS INT)',
                importedDialect: 'TERADATA',
              }],
            }],
            relationships: [],
          }],
        };

        const single = serializeModel(model);
        const all = serializeModelFiles(model);

        expect(single.yaml).toBe(all.files[0].content);
        expect(single.warnings).toEqual(all.warnings);
      });

  test('accepts exactly the profile names profilePath accepts', () => {
    const names = [
      'prod',
      'p-1_x',
      '1x',
      'a.b',
      'a/b',
      '',
      'x'.repeat(500),
      'x'.repeat(501),
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kc-'));
    try {
      const layout = new SemanticModelLayout(dir, 'eg');
      const layoutAccepts = (name: string) => {
        try {
          layout.profilePath('retail', name);
          return true;
        } catch {
          return false;
        }
      };

      const actual = names.map(
          name => ({
            name: name.slice(0, 12),
            accepted: serializeModelFiles({
                        name: 'retail',
                        entities: [baseEntity],
                        relationships: [],
                        metrics: [],
                        profiles: [{name, entities: [], relationships: []}],
                      }).files.length === 2,
          }));

      expect(actual).toEqual(names.map(
          name => ({name: name.slice(0, 12), accepted: layoutAccepts(name)})));
    } finally {
      fs.rmSync(dir, {recursive: true, force: true});
    }
  });
});
