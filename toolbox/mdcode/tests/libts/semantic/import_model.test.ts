// Tests for the semantic model import engine (import_model.ts).

import {describe, expect, test} from 'bun:test';

import {importSemanticModelYaml} from '../../../src/libts/semantic/import_model';
import {loadModels} from '../../../src/libts/semantic/loader';

const BQ_PREFIX = 'bigquery.googleapis.com/projects/acme/datasets/sales';
const BQ_TABLE = `${BQ_PREFIX}/tables/orders`;
const CLOUDSQL_PREFIX =
    'cloudsql.googleapis.com/projects/acme/locations/us-central1/instances/pg1/databases/app/schemas/public';

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

describe('sources', () => {
  test.each([
    ['1-part from dataset prefix', 'orders', BQ_PREFIX],
    ['2-part from dataset prefix', 'sales.orders', BQ_PREFIX],
    ['3-part from dataset prefix', 'acme.sales.orders', BQ_PREFIX],
    [
      'single-backticked 3-part from dataset prefix',
      '\'`acme.sales.orders`\'',
      BQ_PREFIX,
    ],
    [
      'single-backticked 2-part from dataset prefix',
      '\'`sales.orders`\'',
      BQ_PREFIX,
    ],
    [
      '2-part from project prefix', 'sales.orders',
      'bigquery.googleapis.com/projects/acme'
    ],
  ])('qualifies a %s bare name', async (_, bare, sourcePrefix) => {
    const res =
        await importSemanticModelYaml(ossieDoc({source: bare}), {sourcePrefix});

    expect(res.ok).toBe(true);
    expect(res.warnings[0]).toContain(BQ_TABLE);
    expect(
        loadModels(res.files[0].content).models[0].entities[0].authoredSource)
        .toBe(BQ_TABLE);
  });

  test.each([
    ['no sourcePrefix', 'orders', {}],
    ['disagreeing prefix', 'raw.orders', {sourcePrefix: BQ_PREFIX}],
    [
      'backtick-quoted table with dot',
      '\'sales.`my.table`\'',
      {sourcePrefix: BQ_PREFIX},
    ],
    ['3P source', 'trino:cat.sch.orders', {sourcePrefix: BQ_PREFIX}],
  ])('leaves %s as written with a warning and writes the file',
     async (_, src, opts) => {
       const res = await importSemanticModelYaml(ossieDoc({source: src}), opts);
       const cleanSrc = src.replace(/^'|'$/g, '');

       expect(res.ok).toBe(true);
       expect(res.warnings.some(
                  w => w.includes(cleanSrc) && w.includes('--source-prefix')))
           .toBe(true);
     });

  test(
      'qualifies matching 1-, 2-, and 3-part Cloud SQL names and warns on disagreeing names',
      async () => {
        const dbPrefix =
            'cloudsql.googleapis.com/projects/acme/locations/us-central1/instances/pg1/databases/app';
        for (const bare of ['orders', 'public.orders', 'app.public.orders']) {
          const res = await importSemanticModelYaml(
              ossieDoc({source: bare}), {sourcePrefix: CLOUDSQL_PREFIX});
          expect(res.ok).toBe(true);
          expect(loadModels(res.files[0].content, {warnUnacceptedSource: true})
                     .models[0]
                     .entities[0]
                     .authoredSource)
              .toBe(`${CLOUDSQL_PREFIX}/tables/orders`);
        }
        const dbMatch = await importSemanticModelYaml(
            ossieDoc({source: 'app.orders'}), {sourcePrefix: dbPrefix});
        const dbMismatch = await importSemanticModelYaml(
            ossieDoc({source: 'public.orders'}), {sourcePrefix: dbPrefix});

        expect(dbMatch.ok).toBe(true);
        expect(
            loadModels(dbMatch.files[0].content, {warnUnacceptedSource: true})
                .models[0]
                .entities[0]
                .authoredSource)
            .toBe(`${dbPrefix}/tables/orders`);
        expect(dbMismatch.ok).toBe(true);
        expect(loadModels(
                   dbMismatch.files[0].content, {warnUnacceptedSource: true})
                   .models[0]
                   .entities[0]
                   .authoredSource)
            .toBe('public.orders');
        expect(dbMismatch.warnings.some(w => w.includes('--source-prefix')))
            .toBe(true);
      });

  test(
      'removes a query-valued source in Google output and rejects it in vanilla output',
      async () => {
        const query = '"SELECT * FROM sales.orders"';
        const googleRes = await importSemanticModelYaml(
            ossieDoc({source: query}), {flavor: 'google'});
        const ossieRes = await importSemanticModelYaml(
            ossieDoc({source: query}), {flavor: 'ossie'});

        expect(googleRes.ok).toBe(true);
        const loaded =
            loadModels(googleRes.files[0].content, {bindingOptional: true});
        expect(loaded.models[0].entities[0].dataSource).toBe('');
        expect(ossieRes.ok).toBe(false);
      });
});

describe('dialects and datatypes', () => {
  test(
      'maps dialect aliases, drops non-SQL dialects, canonicalizes datatypes, and drops Opaque',
      async () => {
        const extra =
            `          - name: amount\n            datatype: Opaque\n            expression:\n              dialects:\n                - {dialect: GOOGLESQL, expression: "orders.amount"}\n                - {dialect: POSTGRESQL, expression: "orders.amount"}\n                - {dialect: TSQL, expression: "orders.amount"}\n          - name: bi_only\n            datatype: datetimetz\n            expression:\n              dialects:\n                - {dialect: MDX, expression: "[Measures].[BiOnly]"}\n`;
        const res = await importSemanticModelYaml(
            ossieDoc({
              fieldExpr:
                  '{\n              dialects: [{dialect: GOOGLE_SQL, expression: "orders.order_id"}, {dialect: TABLEAU, expression: "[Order ID]"}]\n            }\n            datatype: integer',
              extra,
            }),
            {flavor: 'google'});

        expect(res.ok).toBe(true);
        const fields =
            loadModels(res.files[0].content).models[0].entities[0].fields;
        expect(fields[0].type).toBe('Integer');
        expect(fields[0].dialects?.map(d => d.dialect)).toEqual(['BIGQUERY']);
        expect(fields[1].type).toBeUndefined();
        expect(fields[1].dialects?.map(d => d.dialect)).toEqual([
          'BIGQUERY',
          'POSTGRES',
          'SQLSERVER',
        ]);
        expect(fields[2].type).toBe('DateTimeTz');
        expect(fields[2].expression).toBeUndefined();
      });

  test(
      'reports an error when a vanilla field or metric is left with no supported dialect',
      async () => {
        const extra =
            `    metrics:\n      - name: total_orders\n        expression:\n          dialects:\n            - {dialect: MAQL, expression: "SELECT COUNT(order_id)"}\n`;
        const res = await importSemanticModelYaml(ossieDoc({
          fieldExpr:
              '{\n              dialects: [{dialect: MAQL, expression: "1"}]\n            }',
          extra,
        }));

        expect(res.ok).toBe(false);
        expect(res.errors.some(e => e.includes('orders.order_id'))).toBe(true);
        expect(res.errors.some(e => e.includes('total_orders'))).toBe(true);
      });

  test(
      'rejects a dialect entry missing a dialect name even when other repairs modify the document',
      async () => {
        const res = await importSemanticModelYaml(
            ossieDoc({
              fieldExpr:
                  '{dialects: [{dialect: ANSI_SQL, expression: order_id}, {expression: "CAST(order_id AS STRING)"}]}',
            }),
            {flavor: 'google'});

        expect(res.ok).toBe(false);
        expect(res.files).toEqual([]);
        expect(res.errors.some(e => e.includes('dialect'))).toBe(true);
      });
});

describe('unsupported constructs, lengths, and strict repairs', () => {
  test(
      'removes extra models, prunes unanchored metrics, and truncates descriptions > 2000 chars',
      async () => {
        const extra = `      - name: customers\n        source: ${
            BQ_TABLE}\n        primary_key: [customer_id]\n        fields:\n          - name: customer_id\n            expression:\n              dialects: [{dialect: BIGQUERY, expression: "customers.customer_id"}]\n    metrics:\n      - name: row_count\n        expression: "COUNT(*)"\n        custom_extensions:\n          - vendor_name: DBT\n            data: "{}"\n      - name: cross_entity\n        expression:\n          dialects: [{dialect: BIGQUERY, expression: "COUNT(orders.order_id) + COUNT(customers.customer_id)"}]\n      - name: valid_orders\n        expression:\n          dialects: [{dialect: BIGQUERY, expression: "COUNT(orders.order_id)"}]\n  - name: extra_model\n    datasets: []\n`;
        const res = await importSemanticModelYaml(
            ossieDoc({modelDescription: 'x'.repeat(2105), extra}));
        const googleRes = await importSemanticModelYaml(
            ossieDoc({extra}), {flavor: 'google'});

        expect(res.ok).toBe(true);
        expect(res.warnings.some(w => w.includes('extra_model'))).toBe(true);
        expect(res.warnings.some(
                   w => w.includes('row_count') &&
                       w.includes('GOOGLE custom_extensions block')))
            .toBe(true);
        expect(res.warnings.some(w => w.includes('cross_entity'))).toBe(true);
        expect(googleRes.warnings.some(
                   w => w.includes('row_count') &&
                       w.includes('with an \'entity\' anchor')))
            .toBe(true);
        const loaded = loadModels(res.files[0].content);
        expect(loaded.models).toHaveLength(1);
        expect(loaded.models[0].description).toHaveLength(2000);
        expect(loaded.models[0].metrics.map(m => m.name)).toEqual([
          'valid_orders'
        ]);
      });

  test.each([
    ['bare source in strict mode', googleDoc({source: 'orders'})],
    [
      'non-SQL dialect in strict mode', googleDoc({
        fieldExpr:
            '{\n              dialects: [{dialect: MDX, expression: "1"}, {dialect: BIGQUERY, expression: "orders.order_id"}]\n            }'
      })
    ],
    [
      'query source in strict mode',
      googleDoc({source: '"SELECT * FROM orders"'})
    ],
    [
      'multi-dialect metric with blank SQL entry',
      googleDoc({
        extra:
            '    metrics:\n      - name: m1\n        expression:\n          dialects: [{dialect: BIGQUERY, expression: "COUNT(*)"}, {dialect: ANSI_SQL, expression: "   "}]\n',
      }),
    ],
    [
      'metric with empty-string entity anchor',
      googleDoc({
        extra:
            '    metrics:\n      - name: m1\n        entity: ""\n        expression: "COUNT(*)"\n',
      }),
    ],
  ])('reports %s as an error', async (_, input) => {
    const res = await importSemanticModelYaml(input, {strict: true});

    expect(res.ok).toBe(false);
    expect(res.files).toEqual([]);
  });
});
