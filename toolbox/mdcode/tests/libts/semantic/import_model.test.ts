// Tests for the semantic model import engine (import_model.ts).

import {describe, expect, test} from 'bun:test';

import {importSemanticModelYaml} from '../../../src/libts/semantic/import_model';
import {loadModels} from '../../../src/libts/semantic/loader';

const BQ_PREFIX = 'bigquery.googleapis.com/projects/acme/datasets/sales';
const BQ_TABLE = `${BQ_PREFIX}/tables/orders`;

/**
 * Builds a minimal valid `0.2.0.dev0` (vanilla Ossie) YAML fixture with
 * overrides.
 */
function ossieDoc(overrides: {
  modelName?: string;
  modelDescription?: string;
  modelAiContext?: string;
  datasetName?: string;
  source?: string;
  fieldName?: string;
  fieldExpr?: string;
  extra?: string;
} = {}): string {
  const mName = overrides.modelName ?? 'retail';
  const mDesc = overrides.modelDescription ?
      `    description: "${overrides.modelDescription}"\n` :
      '';
  const mAi = overrides.modelAiContext ?? '';
  const dsName = overrides.datasetName ?? 'orders';
  const src = overrides.source ?? BQ_TABLE;
  const fName = overrides.fieldName ?? 'order_id';
  const fExpr = overrides.fieldExpr ??
      '{\n              dialects: [{dialect: BIGQUERY, expression: "orders.order_id"}]\n            }';
  const extra = overrides.extra ?? '';
  return `version: "0.2.0.dev0"
semantic_model:
  - name: ${mName}
${mDesc}${mAi}    datasets:
      - name: ${dsName}
        source: ${src}
        primary_key: [${fName}]
        fields:
          - name: ${fName}
            expression: ${fExpr}
${extra}`;
}

/** Builds a minimal valid `0.2.0.dev0/google` YAML fixture with overrides. */
function googleDoc(overrides: Parameters<typeof ossieDoc>[0] = {}): string {
  return ossieDoc(overrides)
      .replace('version: "0.2.0.dev0"', 'version: "0.2.0.dev0/google"')
      .replace('    datasets:\n', '    entities:\n');
}

describe('names', () => {
  test(
      'reports all invalid and over-length names in one run without rewriting',
      async () => {
        const longField = 'f'.repeat(301);
        const extra =
            `          - name: order-date\n            expression:\n              dialects: [{dialect: BIGQUERY, expression: "1"}]\n          - name: ${
                longField}\n            expression:\n              dialects: [{dialect: BIGQUERY, expression: "1"}]\n    custom_extensions:\n      - vendor_name: GOOGLE\n        data: '{"deployments":[{"name":"1bad_deploy","target":"t"}],"profiles":[{"name":"2bad_profile"}]}'\n`;
        const res = await importSemanticModelYaml(
            ossieDoc({datasetName: '2024_orders', extra}), {strict: true});

        expect(res.ok).toBe(false);
        expect(res.files).toEqual([]);
        expect(res.errors.some(e => e.includes('2024_orders'))).toBe(true);
        expect(res.errors.some(e => e.includes('order-date'))).toBe(true);
        expect(res.errors.some(e => e.includes('1bad_deploy'))).toBe(true);
        expect(res.errors.some(e => e.includes('2bad_profile'))).toBe(true);
        expect(
            res.errors.some(e => e.includes('may be at most 300 characters')))
            .toBe(true);
      });

  test('accepts a model and deployment name with a hyphen', async () => {
    const extra =
        `    deployments:\n      - name: prod-bq\n        target: bigquery.googleapis.com/projects/acme/datasets/sales/propertyGraphs/retail\n`;
    const res = await importSemanticModelYaml(
        googleDoc({modelName: 'sales-analytics', extra}), {strict: true});

    expect(res.ok).toBe(true);
    expect(res.files[0].fileName).toBe('sales-analytics.yaml');
  });
});

describe('conversion, strict mode, and translation', () => {
  test(
      'converts plain vanilla 0.2.0.dev0 with custom ai_context to Google flavor',
      async () => {
        const modelAiContext =
            `    ai_context:\n      instructions: "Retail instructions"\n      dbt_meta:\n        owner: analytics\n      custom:\n        a: 1\n`;
        const extra = `        ai_context:\n          custom: "scalar"\n`;
        const res = await importSemanticModelYaml(
            ossieDoc({modelAiContext, extra}),
            {flavor: 'google', sourcePrefix: BQ_PREFIX});

        expect(res.ok).toBe(true);
        expect(res.files[0].content).toContain('version: 0.2.0.dev0/google');
        expect(res.files[0].content).toContain('entities:');
        const loaded = loadModels(res.files[0].content);
        expect(loaded.models[0].aiContext?.additionalProperties).toEqual({
          dbt_meta: {owner: 'analytics'},
          custom: {a: 1},
        });
        expect(loaded.models[0].entities[0].aiContext?.additionalProperties)
            .toEqual({
              custom: 'scalar',
            });
      });

  test.each([
    ['malformed YAML', '[', {}, 'could not parse input'],
    [
      'unsupported version', 'version: "9.9.9"\nsemantic_model: []', {},
      'version'
    ],
    [
      'invalid FQN sourcePrefix', ossieDoc(),
      {sourcePrefix: 'bigquery:acme.sales'}, 'bigquery:acme.sales'
    ],
    [
      'BigLake sourcePrefix with dot in catalog', ossieDoc(),
      {sourcePrefix: 'biglake.googleapis.com/projects/acme/catalogs/c.1'},
      'biglake.googleapis.com/projects/acme/catalogs/c.1'
    ],
    [
      'Google to vanilla', googleDoc(),
      {flavor: 'ossie' as const, strict: true}, 'not supported yet'
    ],
    [
      'vanilla with GOOGLE block to Google', ossieDoc({
        extra:
            `    custom_extensions:\n      - vendor_name: GOOGLE\n        data: '{}'\n`
      }),
      {flavor: 'google' as const, strict: true}, 'not supported yet'
    ],
    [
      'GOOGLE block without strict', ossieDoc({
        extra:
            `    custom_extensions:\n      - vendor_name: GOOGLE\n        data: '{}'\n`
      }),
      {}, '--input first-party'
    ],
    [
      'bare source in strict mode', googleDoc({source: 'orders'}),
      {strict: true}, 'orders'
    ],
    [
      'loader error in Check step (blank SQL)', googleDoc({fieldExpr: '"   "'}),
      {}, 'blank'
    ],
  ])('refuses %s', async (_, input, opts, expectedMsg) => {
    const res = await importSemanticModelYaml(input, opts);

    expect(res.ok).toBe(false);
    expect(res.files).toEqual([]);
    expect(res.errors.some(e => e.includes(expectedMsg))).toBe(true);
  });

  test(
      'returns a valid Google-flavor model unchanged in strict mode and runs transpileModel when requested',
      async () => {
        const raw = googleDoc({
          fieldExpr:
              '{\n              dialects: [{dialect: SNOWFLAKE, expression: " orders.order_id "}]\n            }',
          extra:
              '    metrics:\n      - name: total_orders\n        entity: orders\n        expression: \'COUNT("orders"."order_id")\'\n',
        });
        const offRes = await importSemanticModelYaml(raw, {strict: true});
        const onStrictRes =
            await importSemanticModelYaml(raw, {strict: true, transpile: true});

        expect(offRes.ok).toBe(true);
        expect(offRes.files[0].content).toBe(raw);
        expect(onStrictRes.ok).toBe(true);
        const loaded = loadModels(onStrictRes.files[0].content).models[0];
        expect(loaded.entities[0].fields[0].dialects).toEqual([
          {dialect: 'SNOWFLAKE', expression: ' orders.order_id '},
          {dialect: 'BIGQUERY', expression: 'orders.order_id'},
        ]);
        expect(loaded.metrics[0].dialects).toEqual([
          {dialect: 'ANSI_SQL', expression: 'COUNT("orders"."order_id")'},
          {dialect: 'BIGQUERY', expression: 'COUNT(`orders`.`order_id`)'},
        ]);
      });

  test(
      'returns load errors and preserves warnings when transpile is enabled on a model that fails to load',
      async () => {
        const extra =
            `    relationships:\n      - name: to_customers\n        from: orders\n        to: customers\n        from_columns: [order_id]\n        to_columns: [id]\n        description: "Each order belongs to one customer."\n`;
        const res =
            await importSemanticModelYaml(ossieDoc({extra}), {transpile: true});

        expect(res.ok).toBe(false);
        expect(res.files).toEqual([]);
        expect(res.warnings.some(w => w.includes('to_customers'))).toBe(true);
        expect(res.errors.some(e => e.includes('customers'))).toBe(true);
      });
});

describe('vanilla output, extensions, and targets', () => {
  test(
      'wraps short-form expression, moves relationship description into GOOGLE block, and warns on unaccepted source',
      async () => {
        const extra =
            `      - name: customers\n        source: customers\n        primary_key: [customer_id]\n        fields:\n          - name: customer_id\n            expression: "customers.customer_id"\n    relationships:\n      - name: order_customer\n        from: orders\n        to: customers\n        from_columns: [order_id]\n        to_columns: [customer_id]\n        description: "Customer who placed the order"\n    custom_extensions:\n      - vendor_name: DBT\n        data: '{"meta":"kept"}'\n`;
        const res = await importSemanticModelYaml(
            ossieDoc({fieldExpr: '"orders.order_id"', extra}));

        expect(res.ok).toBe(true);
        expect(res.warnings.some(w => w.includes('order_customer'))).toBe(true);
        expect(res.warnings.some(w => w.includes('--source-prefix')))
            .toBe(true);
        const loaded = loadModels(res.files[0].content, {
                         warnUnacceptedSource: true
                       }).models[0];
        expect(loaded.entities[0].fields[0].dialects).toEqual([
          {dialect: 'ANSI_SQL', expression: 'orders.order_id'},
        ]);
        expect(loaded.relationships[0].description)
            .toBe('Customer who placed the order');
        expect(loaded.customExtensions).toEqual([
          {vendorName: 'DBT', data: '{"meta":"kept"}'},
        ]);
      });

  test.each([
    [
      'resource URI',
      googleDoc({
        extra:
            '    deployments:\n      - name: prod\n        target: "//bigquery.googleapis.com/projects/acme/datasets/sales/propertyGraphs/retail"\n',
      }),
      '//bigquery.googleapis.com/projects/acme/datasets/sales/propertyGraphs/retail',
    ],
    [
      'Knowledge Catalog name',
      googleDoc({
        extra:
            '    deployments:\n      - name: prod\n        target: "bigquery:graph:acme.sales.retail"\n',
      }),
      'bigquery:graph:acme.sales.retail',
    ],
    [
      'GOOGLE-block deploymentTargets URI',
      ossieDoc({
        extra:
            '    custom_extensions:\n      - vendor_name: GOOGLE\n        data: \'{"deploymentTargets":["//bigquery.googleapis.com/projects/acme/datasets/sales/propertyGraphs/retail"]}\'\n',
      }),
      '//bigquery.googleapis.com/projects/acme/datasets/sales/propertyGraphs/retail',
    ],
  ])('rejects a deployment target written as a %s with push message',
     async (_, doc, badTarget) => {
       const res = await importSemanticModelYaml(doc, {strict: true});

       expect(res.ok).toBe(false);
       expect(res.errors[0]).toContain(badTarget);
     });
});
