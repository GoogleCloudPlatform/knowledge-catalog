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
import * as path from 'node:path';
import * as yaml from 'yaml';

import {ActionParameter, ALLOWED_DIALECTS, CustomExtension, Entity, Field, Metric, Relationship, SemanticModel, SqlDialect} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {loadModels} from '../../../src/libts/semantic/loader';
import {modelDocument, serializeModel} from '../../../src/libts/semantic/osi_converter';

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
    'actions_place_order.yaml',
    'lineitem_databricks_ext.yaml',
  ];

  for (const fixture of fixtures) {
    test(`${fixture} survives IR -> YAML -> IR unchanged`, () => {
      const original = loadFixture(fixture);
      expect(original.length).toBeGreaterThan(0);

      for (const model of original) {
        const {yaml: text} = serializeModel(model);
        const reloaded = loadModels(text, {allowLegacyBareSource: true}).models;
        expect(reloaded).toHaveLength(1);
        expect(reloaded[0]).toEqual(model);
      }
    });
  }

  // The loader reads a vanilla metric's anchor out of its GOOGLE block, and a
  // '0.2.0.dev0' write does not put it back in one yet. Two metrics in this
  // fixture are anchored in a GOOGLE block, and each reads two datasets. The
  // reload cannot infer one entity for them, so each comes back with none.
  // The write warns once for each, and everything else survives.
  test('tpcds_retail.yaml survives IR -> YAML -> IR apart from its GOOGLE block anchors', () => {
    const [model] = loadFixture('tpcds_retail.yaml');
    const anchored = model.metrics.filter(m => m.authoredEntity !== undefined);
    expect(anchored.map(m => m.name)).toEqual(['customer_lifetime_value', 'store_productivity']);

    const {yaml: text, warnings} = serializeModel(model);
    const reloaded = loadModels(text, {allowLegacyBareSource: true}).models;
    const unanchored = model.metrics.map(m => {
      const copy = {...m};
      if (copy.authoredEntity !== undefined) {
        delete copy.authoredEntity;
        delete copy.entity;
      }
      return copy;
    });
    expect(reloaded).toEqual([{...model, metrics: unanchored}]);
    expect(warnings).toEqual(anchored.map(({name}) =>
        `metric '${name}': 'entity' has no representation under '0.2.0.dev0' and is not serialized`));
  });
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

  test('a dataset source is the opaque dataSource string, verbatim', () => {
    const orders = sm.entities.find((d: any) => d.name === 'orders');
    const entity = model.entities.find(e => e.name === 'orders')!;
    expect(orders.source).toBe(entity.dataSource);
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
      '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';
  const spTarget =
      '//spanner.googleapis.com/projects/p/instances/i/databases/db' +
      '/propertyGraphs/g';
  const ordersEntity: Entity = {
    name: 'orders',
    dataSource: 'p.d.orders',
    authoredSource: 'bigquery:p.d.orders',
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
      '        source: bigquery:p.d.orders',
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
            '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';
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
                authoredSource: 'bigquery:p.d.orders',
                customExtensions: ext,
                fields: [{...typedId, customExtensions: ext}],
              },
              {
                ...baseOrders,
                name: 'customers',
                dataSource: 'p.d.customers',
                authoredSource: 'bigquery:p.d.customers',
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
      deployments: [{name: 'prod', target: 'bigquery:p.d'}],
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
      `model 'm': 'deployments' has no representation under '0.2.0.dev0' and is not serialized`,
      `model 'm': 'profiles' has no representation under '0.2.0.dev0' and is not serialized`,
      `model 'm': 'actions' has no representation under '0.2.0.dev0' and is not serialized`,
      `model 'm': 'constraints' has no representation under '0.2.0.dev0' and is not serialized`,
      `entity 'orders': 'extends' has no representation under '0.2.0.dev0' and is not serialized`,
      `relationship 'rel': 'description' has no representation under '0.2.0.dev0' and is not serialized`,
      `metric 'total': 'entity' has no representation under '0.2.0.dev0' and is not serialized`,
    ]);
  });

  // A GOOGLE block the model keeps, such as one that lists deploymentTargets,
  // is written as it is, with any profiles in it.
  test('does not warn about profiles in a GOOGLE block the model keeps under 0.2.0.dev0', () => {
    const block = (data: object) =>
        `      - vendor_name: GOOGLE\n        data: '${JSON.stringify(data)}'\n`;
    const text = (blocks: string) => `version: "0.2.0.dev0"
semantic_model:
  - name: m
    custom_extensions:
${blocks}    datasets:
      - name: orders
        source: bigquery:p.d.orders
        primary_key: [id]
        fields:
          - name: id
            expression: {dialects: [{dialect: ANSI_SQL, expression: id}]}
`;
    const target = 'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';
    const prod = {name: 'prod'};
    const warning =
        `model 'm': 'profiles' has no representation under '0.2.0.dev0' and is not serialized`;

    const [kept] = loadModels(text(block({deploymentTargets: [target], profiles: [prod]}))).models;
    const written = serializeModel(kept);
    expect(written.warnings).not.toContain(warning);
    expect(loadModels(written.yaml).models[0].profiles).toEqual(kept.profiles);

    const [own] = loadModels(text(block({deploymentTargets: [target]}) + block({profiles: [prod]}))).models;
    expect(serializeModel(own).warnings).toContain(warning);
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
        authoredSource: 'bigquery:p.d.orders',
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
