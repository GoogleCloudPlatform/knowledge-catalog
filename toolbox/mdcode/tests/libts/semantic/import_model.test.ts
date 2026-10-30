// Tests for the semantic model import engine (import_model.ts).

import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'fs';
import {join} from 'path';
import * as yaml from 'yaml';

import {importSemanticModelYaml} from '../../../src/libts/semantic/import_model';
import {loadModels} from '../../../src/libts/semantic/loader';
import {loadProfileFile} from '../../../src/libts/semantic/resolve_profiles';

const BQ_PREFIX = 'bigquery.googleapis.com/projects/acme/datasets/sales';
const BQ_TABLE = `${BQ_PREFIX}/tables/orders`;
const CLOUDSQL_PREFIX =
    'cloudsql.googleapis.com/projects/acme/locations/us-central1/instances/pg1/databases/app/schemas/public';
const ALLOYDB_DB =
    'alloydb.googleapis.com/projects/acme/locations/us-central1/clusters/c1/databases/analytics';

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
        expect(res.files[0].content).toContain('version: "0.2.0.dev0/google"');
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
      'Google to vanilla without strict', googleDoc(),
      {flavor: 'ossie' as const}, '--input first-party'
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
    [
      'dialect alias in strict mode',
      googleDoc().replace('dialect: BIGQUERY', 'dialect: GOOGLE_SQL'),
      {strict: true},
      `field 'orders.order_id': rewrote dialect 'GOOGLE_SQL' to 'BIGQUERY'.`
    ],
    [
      'vanilla datatype in another casing in strict mode',
      ossieDoc({extra: '            datatype: integer\n'}),
      {flavor: 'google' as const, strict: true},
      `field 'orders.order_id': rewrote datatype 'integer' to 'Integer'.`
    ],
    [
      'one-part name against an AlloyDB database prefix in strict mode',
      googleDoc({source: 'orders'}), {strict: true, sourcePrefix: ALLOYDB_DB},
      `dataset 'orders': source 'orders' names no schema, and neither does '--source-prefix', so import cannot complete it; add the schema to the source or to '--source-prefix'.`
    ],
    [
      'lowercase Opaque in strict mode',
      ossieDoc({extra: '            datatype: opaque\n'}), {strict: true},
      `field 'orders.order_id': removed datatype 'opaque'.`
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
        // Without translation, the BigQuery table's vendor field and its
        // double-quoted ANSI_SQL metric each warn.
        expect(offRes.warnings.map(w => w.split(':')[0])).toEqual([
          "field 'orders.order_id'", "metric 'total_orders'",
        ]);
        expect(onStrictRes.ok).toBe(true);
        expect(onStrictRes.warnings).toEqual([
          "field 'orders.order_id': transpiled 'SNOWFLAKE' -> 'BIGQUERY'",
          "metric 'total_orders': transpiled 'ANSI_SQL' -> 'BIGQUERY'",
        ]);
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

  // Only a source in no Google Cloud form gets the entry name advice.
  test.each([
    ['no sourcePrefix', 'orders', {}, true],
    ['disagreeing prefix', 'raw.orders', {sourcePrefix: BQ_PREFIX}, true],
    [
      'backtick-quoted table with dot',
      '\'sales.`my.table`\'',
      {sourcePrefix: BQ_PREFIX},
      true,
    ],
    ['3P source', 'trino:cat.sch.orders', {sourcePrefix: BQ_PREFIX}, true],
    ['resource URI', `//${BQ_TABLE}`, {}, false],
    ['first-party catalog name', 'bigquery:acme.sales.orders', {}, false],
    ['system entry name', 'projects/acme/locations/us/entryGroups/@bigquery/entries/orders', {}, false],
  ])('leaves %s as written with a warning and writes the file',
     async (_, src, opts, advice) => {
       const res = await importSemanticModelYaml(ossieDoc({source: src}), opts);
       const cleanSrc = src.replace(/^'|'$/g, '');

       expect(res.ok).toBe(true);
       const warning = res.warnings.find(
           w => w.includes(cleanSrc) && w.includes('--source-prefix'));
       expect(warning?.endsWith(
                  'A table outside Google Cloud is written as the entry name ' +
                  "of its Knowledge Catalog entry, 'projects/<p>/locations/" +
                  "<l>/entryGroups/<g>/entries/<id>'."))
           .toBe(advice);
     });

  test('keeps a third-party entry name as written, with no warning', async () => {
    const entry = 'projects/acme/locations/us/entryGroups/sf/entries/orders';
    const res = await importSemanticModelYaml(
        ossieDoc({source: entry}), {sourcePrefix: BQ_PREFIX});
    expect([res.ok, res.warnings, res.files[0].content])
        .toEqual([true, [], ossieDoc({source: entry})]);
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

  const ALLOYDB = `${ALLOYDB_DB}/schemas/public`;
  // [label, bare name, prefix, the source it completes to, or undefined when
  // it differs from the prefix only in letter case]
  test.each([
    ['AlloyDB, unquoted', 'ANALYTICS.PUBLIC.ORDERS', ALLOYDB, `${ALLOYDB}/tables/orders`],
    ['AlloyDB database', 'Public.ORDERS', ALLOYDB_DB, `${ALLOYDB}/tables/orders`],
    ['AlloyDB, double-quoted table', 'PUBLIC."Orders"', ALLOYDB, `${ALLOYDB}/tables/Orders`],
    ['AlloyDB, backticked table', 'PUBLIC.`Orders`', ALLOYDB, `${ALLOYDB}/tables/Orders`],
    ['AlloyDB, backticked schema', '`Public`.ORDERS', ALLOYDB_DB, `${ALLOYDB_DB}/schemas/Public/tables/orders`],
    ['AlloyDB, quoted schema', '"PUBLIC".orders', ALLOYDB, undefined],
    ['AlloyDB, non-ASCII letter', 'PUBLIC.ÄRGER', ALLOYDB, `${ALLOYDB}/tables/Ärger`],
    ['AlloyDB, mixed-case prefix', 'sales.orders', `${ALLOYDB_DB}/schemas/Sales`, undefined],
    ['BigQuery', 'SALES.orders', BQ_PREFIX, undefined],
    ['Cloud SQL', 'PUBLIC.orders', CLOUDSQL_PREFIX, undefined],
  ])('matches letter case against a prefix: %s', async (_, bare, sourcePrefix, completed) => {
    const res = await importSemanticModelYaml(
        ossieDoc({source: `'${bare}'`}), {sourcePrefix});

    expect(res.warnings).toEqual([
      completed ?
          `dataset 'orders': rewrote bare source '${bare}' to '${completed}'.` :
          `dataset 'orders': source '${bare}' differs from '--source-prefix' only in letter case, so import cannot complete it; correct the letter case of the source or of '--source-prefix'.`,
    ]);
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
        expect(res.warnings).toEqual(expect.arrayContaining([
          `field 'orders.order_id': rewrote dialect 'GOOGLE_SQL' to 'BIGQUERY'.`,
          `field 'orders.order_id': rewrote datatype 'integer' to 'Integer'.`,
        ]));
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

  test('canonicalizes a Google-flavor datatype and drops Opaque in strict mode', async () => {
    const res = await importSemanticModelYaml(
        googleDoc({extra: '            datatype: integer\n          - name: amount\n            datatype: Opaque\n            expression: amount\n'}),
        {strict: true});

    expect(res.errors).toEqual([]);
    expect(res.files[0].content).toContain('datatype: Integer');
    expect(res.files[0].content).not.toContain('Opaque');
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

describe('first-party flavor conversion (vanilla <-> Google)', () => {
  const googleModelYaml = `
version: "0.2.0.dev0/google"
semantic_model:
  - name: retail
    ai_context:
      instructions: "Retail model"
      synonyms: [commerce]
      examples: ["total orders"]
      custom:
        owner: analytics
        flag: "yes"
    deployments:
      - name: prod_bq
        target: bigquery.googleapis.com/projects/acme/datasets/sales/propertyGraphs/retail
        profile: prod
    entities:
      - name: orders
        source: ${BQ_TABLE}
        primary_key: [order_id]
        extends: [base_orders]
        fields:
          - name: order_id
            expression: "orders.order_id"
      - name: base_orders
        source: ${BQ_TABLE}
        primary_key: [order_id]
        fields:
          - name: order_id
            datatype: Integer
            expression:
              dialects:
                - dialect: BIGQUERY
                  expression: "base_orders.order_id"
    relationships:
      - name: order_base
        from: orders
        to: base_orders
        from_columns: [order_id]
        to_columns: [order_id]
        description: "Order to base"
    metrics:
      - name: total_orders
        entity: orders
        expression: "COUNT(*)"
`;
  const longSql =
      `CASE WHEN orders.order_id > 0 THEN 'known order' ELSE 'unknown order' END`;
  const profileYaml = `
name: prod
entities:
  - name: orders
    source: ${BQ_TABLE}
    primary_key: [order_id]
    fields:
      - name: order_id
        expression: {dialects: [{dialect: BIGQUERY, expression: "${longSql}"}]}
`;

  test(
      'converts vanilla 0.2.0.dev0 with GOOGLE blocks and custom ai_context to Google flavor and profile files',
      async () => {
        const input = `
version: "0.2.0.dev0"
semantic_model:
  - name: retail
    ai_context:
      instructions: "Retail model"
      owner: analytics
    datasets:
      - name: orders
        source: ${BQ_TABLE}
        primary_key: [order_id]
        fields:
          - name: order_id
            expression:
              dialects:
                - dialect: SNOWFLAKE
                  expression: "orders.order_id"
        ai_context:
          tier: gold
        custom_extensions:
          - vendor_name: GOOGLE
            data: '{"extends":["base_orders"]}'
      - name: base_orders
        source: ${BQ_TABLE}
        primary_key: [order_id]
        fields:
          - name: order_id
            expression:
              dialects:
                - dialect: BIGQUERY
                  expression: "base_orders.order_id"
    relationships:
      - name: order_base
        from: orders
        to: base_orders
        from_columns: [order_id]
        to_columns: [order_id]
        custom_extensions:
          - vendor_name: GOOGLE
            data: '{"description":"Order to base"}'
    metrics:
      - name: total_orders
        expression:
          dialects:
            - dialect: BIGQUERY
              expression: "COUNT(*)"
        custom_extensions:
          - vendor_name: GOOGLE
            data: '{"entity":"orders"}'
          - vendor_name: DBT
            data: '{"keep":true}'
    custom_extensions:
      - vendor_name: GOOGLE
        data: |
          {
            "deployments": [
              {
                "name": "prod_bq",
                "target": "bigquery.googleapis.com/projects/acme/datasets/sales/propertyGraphs/retail",
                "profile": "prod"
              }
            ],
            "profiles": [
              {
                "name": "prod",
                "entities": [
                  {
                    "name": "orders",
                    "source": "${BQ_TABLE}",
                    "primary_key": ["order_id"]
                  }
                ]
              }
            ]
          }
`;
        const res = await importSemanticModelYaml(
            input, {flavor: 'google', strict: true, transpile: true});

        expect(res.ok).toBe(true);
        expect(res.errors).toEqual([]);
        expect(res.files.map(f => f.fileName)).toEqual([
          'retail.yaml',
          'retail.profile.prod.yaml',
        ]);
        const parsedModelDoc = yaml.parse(res.files[0].content);
        expect(parsedModelDoc.version).toBe('0.2.0.dev0/google');
        expect(parsedModelDoc.semantic_model[0].datasets).toBeUndefined();
        expect(parsedModelDoc.semantic_model[0].ai_context.custom).toEqual({
          owner: 'analytics',
        });
        expect(res.files[0].content).not.toContain('vendor_name: GOOGLE');
        const loaded = loadModels(res.files[0].content).models[0];
        expect(loaded.entities[0].fields[0].dialects).toEqual([
          {dialect: 'SNOWFLAKE', expression: 'orders.order_id'},
          {dialect: 'BIGQUERY', expression: 'orders.order_id'},
        ]);
        expect(loaded.entities[0].aiContext?.additionalProperties).toEqual({
          tier: 'gold',
        });
        expect(loaded.entities[0].extends).toEqual(['base_orders']);
        expect(loaded.relationships[0].description).toBe('Order to base');
        expect(loaded.metrics[0].authoredEntity).toBe('orders');
        expect(loaded.metrics[0].customExtensions).toEqual([
          {vendorName: 'DBT', data: '{"keep":true}'},
        ]);
        expect(loaded.deployments).toEqual([
          {
            name: 'prod_bq',
            target:
                'bigquery.googleapis.com/projects/acme/datasets/sales/propertyGraphs/retail',
            profile: 'prod',
          },
        ]);
        const loadedProfile = loadProfileFile(res.files[1].content, 'prod');
        expect(loadedProfile).toEqual({
          name: 'prod',
          entities: [
            {
              name: 'orders',
              source: BQ_TABLE,
              primaryKey: ['order_id'],
            },
          ],
          relationships: [],
        });
      });

  test(
      'converts Google-flavor 0.2.0.dev0/google with profile files and Google constructs to vanilla 0.2.0.dev0',
      async () => {
        const res = await importSemanticModelYaml(googleModelYaml, {
          flavor: 'ossie',
          strict: true,
          profileFiles: [
            {fileName: 'retail.profile.prod.yaml', content: profileYaml},
          ],
        });

        expect(res.ok).toBe(true);
        expect(res.errors).toEqual([]);
        expect(res.files).toHaveLength(1);
        expect(res.files[0].fileName).toBe('retail.yaml');
        const parsedVanillaDoc = yaml.parse(res.files[0].content);
        expect(parsedVanillaDoc.version).toBe('0.2.0.dev0');
        expect(parsedVanillaDoc.semantic_model[0].entities).toBeUndefined();
        expect(parsedVanillaDoc.semantic_model[0].ai_context.owner)
            .toBe('analytics');
        expect(parsedVanillaDoc.semantic_model[0].ai_context.custom)
            .toBeUndefined();
        // A YAML 1.1 reader would read a plain `yes` as true.
        expect(res.files[0].content).toContain('flag: "yes"');
        const loaded = loadModels(res.files[0].content).models[0];
        expect(loaded.entities[0].fields[0].dialects).toEqual([
          {dialect: 'ANSI_SQL', expression: 'orders.order_id'},
        ]);
        expect(loaded.entities[0].extends).toEqual(['base_orders']);
        expect(loaded.relationships[0].description).toBe('Order to base');
        expect(loaded.metrics[0].authoredEntity).toBe('orders');
        expect(loaded.deployments?.[0].name).toBe('prod_bq');
        expect(loaded.profiles?.map(p => p.name)).toEqual(['prod']);
        expect(loaded.aiContext?.additionalProperties).toEqual({
          owner: 'analytics',
          flag: 'yes',
        });
      });

  test(
      'reports all conversion gaps in a single run when converting to vanilla',
      async () => {
        const input = `
version: "0.2.0.dev0/google"
semantic_model:
  - name: retail
    entities:
      - name: orders
        source: ${BQ_TABLE}
        primary_key: [order_id]
        fields:
          - name: order_id
            expression: "orders.order_id"
          - name: amount
            datatype: Decimal
      - name: base_entity
        abstract: true
      - name: unbound_entity
        fields:
          - name: id
            expression: "unbound_entity.id"
    relationships:
      - name: rel_no_cols
        from: orders
        to: unbound_entity
        description: "Has GOOGLE block description"
    actions:
      - name: act1
        parameters:
          - name: p1
            type: String
    constraints:
      - name: con1
        judgment: "Always valid"
        on_violation: reject
`;
        const res = await importSemanticModelYaml(
            input, {flavor: 'ossie', strict: true});

        expect(res.ok).toBe(false);
        expect(res.files).toEqual([]);
        expect(res.errors).toEqual([
          `Cannot convert 'retail' to version '0.2.0.dev0': action 'act1' is not supported in version '0.2.0.dev0'.`,
          `Cannot convert 'retail' to version '0.2.0.dev0': constraint 'con1' is not supported in version '0.2.0.dev0'.`,
          `Cannot convert 'retail' to version '0.2.0.dev0': field 'orders.amount' has no 'expression'.`,
          `Cannot convert 'retail' to version '0.2.0.dev0': entity 'base_entity' is 'abstract', which version '0.2.0.dev0' does not support.`,
          `Cannot convert 'retail' to version '0.2.0.dev0': entity 'unbound_entity' has no 'source'.`,
          `Cannot convert 'retail' to version '0.2.0.dev0': relationship 'rel_no_cols' has no join columns ('from_columns' and 'to_columns').`,
        ]);
      });

  test.each([
    [
      'legacy deploymentTargets in vanilla GOOGLE block',
      ossieDoc({
        extra: `    custom_extensions:
      - vendor_name: GOOGLE
        data: |
          {
            "deploymentTargets": [
              "//bigquery.googleapis.com/projects/acme/datasets/sales/propertyGraphs/retail"
            ]
          }
`,
      }),
      {flavor: 'google' as const, strict: true},
      `model 'retail': 'deploymentTargets' is no longer supported; use 'deployments:' inside the GOOGLE block instead.`,
    ],
    [
      'non-JSON YAML alias in GOOGLE block data',
      ossieDoc({
        extra: `    custom_extensions:
      - vendor_name: GOOGLE
        data: '{*bad}'
`,
      }),
      {flavor: 'google' as const, strict: true},
      `the 'data' of a GOOGLE custom_extensions block must be a JSON object`,
    ],
  ])('refuses invalid GOOGLE block when converting to Google flavor: %s',
     async (_, input, opts, expectedMsg) => {
       const res = await importSemanticModelYaml(input, opts);

       expect(res.ok).toBe(false);
       expect(res.files).toEqual([]);
       expect(res.errors.some(e => e.includes(expectedMsg))).toBe(true);
     });

  test.each([
    [
      'reserved default profile name',
      [{fileName: 'retail.profile.default.yaml', content: 'name: default\n'}],
      `'default' names the model's inline bindings`,
    ],
    [
      'case-insensitive duplicate profile names',
      [
        {fileName: 'retail.profile.prod.yaml', content: 'name: prod\n'},
        {fileName: 'PROD.yaml', content: 'name: PROD\n'},
      ],
      `duplicate profile name 'PROD'`,
    ],
    [
      'mismatched profile name inside file',
      [{fileName: '/dir/retail.profile.prod.yaml', content: 'name: staging\n'}],
      `does not match its file's profile name 'prod'`,
    ],
    [
      'nameless .yml profile file',
      [{fileName: 'retail.profile.yml', content: 'name: ""\n'}],
      `Profile name '' is not valid`,
    ],
  ])('refuses invalid profile file when converting to vanilla: %s',
     async (_, profileFiles, expectedMsg) => {
       const res = await importSemanticModelYaml(
           googleDoc(), {flavor: 'ossie', strict: true, profileFiles});

       expect(res.ok).toBe(false);
       expect(res.files).toEqual([]);
       expect(res.errors.some(e => e.includes(expectedMsg))).toBe(true);
     });

  test(
      'round-trips Google flavor to vanilla and back with equal loaded IR (wrapping short-form as ANSI_SQL) and preserves canonical files identically',
      async () => {
        const toVanilla = await importSemanticModelYaml(googleModelYaml, {
          flavor: 'ossie',
          strict: true,
          profileFiles: [
            {fileName: 'retail.profile.prod.yaml', content: profileYaml},
          ],
        });
        const canonicalGoogle =
            await importSemanticModelYaml(toVanilla.files[0].content, {
              flavor: 'google',
              strict: true,
            });
        const vanillaAgain =
            await importSemanticModelYaml(canonicalGoogle.files[0].content, {
              flavor: 'ossie',
              strict: true,
              profileFiles: canonicalGoogle.files.slice(1),
            });
        const roundTrippedCanonical =
            await importSemanticModelYaml(vanillaAgain.files[0].content, {
              flavor: 'google',
              strict: true,
            });

        expect(toVanilla.ok).toBe(true);
        expect(canonicalGoogle.ok).toBe(true);
        const origIr = loadModels(googleModelYaml).models[0];
        const roundTripIr =
            loadModels(canonicalGoogle.files[0].content).models[0];
        expect(origIr.entities[0].fields[0].stringForm).toBe(true);
        expect(roundTripIr.entities[0].fields[0].stringForm).toBe(false);
        expect(roundTripIr.entities[0].fields[0].dialects).toEqual([
          {dialect: 'ANSI_SQL', expression: 'orders.order_id'},
        ]);
        expect(origIr.metrics[0].stringForm).toBe(true);
        expect(roundTripIr.metrics[0].stringForm).toBe(false);
        expect(roundTripIr.metrics[0].dialects).toEqual([
          {dialect: 'ANSI_SQL', expression: 'COUNT(*)'},
        ]);
        origIr.entities[0].fields[0].stringForm = false;
        origIr.metrics[0].stringForm = false;
        expect(roundTripIr).toEqual(origIr);
        expect(loadProfileFile(canonicalGoogle.files[1].content, 'prod'))
            .toEqual(loadProfileFile(profileYaml, 'prod'));
        expect(roundTrippedCanonical.files).toEqual(canonicalGoogle.files);
        // Long SQL stays on one line in the GOOGLE block and the profile file.
        expect(toVanilla.files[0].content).toContain(longSql);
        expect(canonicalGoogle.files[1].content)
            .toContain(`expression: ${longSql}\n`);
      });

  test('ignores profileFiles when target flavor is google', async () => {
    const googleRes = await importSemanticModelYaml(ossieDoc(), {
      flavor: 'google',
      strict: true,
      profileFiles: [
        {
          fileName: 'retail.profile.default.yaml',
          content: 'name: default\n',
        },
      ],
    });

    expect(googleRes.ok).toBe(true);
    expect(googleRes.errors).toEqual([]);
    expect(googleRes.files.map(f => f.fileName)).toEqual(['retail.yaml']);
  });
});

describe('comments', () => {
  const HEADER =
      '# Copyright 2026 Example Corp. Licensed under the Apache License, Version 2.0.';
  const ROW_COUNT =
      '      # rows in any table\n      - name: row_count\n        expression: COUNT(*)\n';
  const ORDER_COUNT = '      # orders placed\n      - name: order_count\n';

  // A model file with a comment on each part import may change. A
  // third-party file needs repairs; a first-party file converts with none.
  function commentedModel(
      {google = false, firstParty = false, metrics}:
          {google?: boolean, firstParty?: boolean, metrics: string}) {
    const version = google ? '0.2.0.dev0/google' : '0.2.0.dev0';
    const owner =
        google ? 'custom:\n        owner: analytics' : 'owner: analytics';
    const source = firstParty ? BQ_TABLE : 'orders';
    const datatype = firstParty ? 'Integer' : 'integer';
    const dialect = firstParty ? 'SNOWFLAKE' : 'snowflake';
    return `${HEADER}

version: "${version}"  # format version
semantic_model:
  - name: retail
    ${google ? 'entities' : 'datasets'}:
      # one row per order
      - name: orders
        source: ${source}  # the orders table
        primary_key: [order_id]
        fields:
          # the order key
          - name: order_id
            datatype: ${datatype}  # a whole number
            expression:
              dialects:
                - dialect: ${dialect}  # as written
                  expression: orders.order_id
    ai_context:
      # prefer net revenue
      instructions: Prefer net revenue
      ${owner}
    metrics:  # every metric
${metrics}# end of model
`;
  }
  // Import removes the unanchored `row_count`, which a blank line separates
  // from the metric after it.
  const thirdParty = commentedModel({
    metrics: `${ROW_COUNT}\n${
        ORDER_COUNT}        expression: COUNT(orders.order_id)  # counts orders\n`,
  });
  const vanilla = commentedModel({
    firstParty: true,
    metrics: `${ORDER_COUNT}        expression:  # counts orders
          dialects: [{dialect: ANSI_SQL, expression: COUNT(orders.order_id)}]
        custom_extensions: [{vendor_name: GOOGLE, data: '{"entity":"orders"}'}]
`,
  });
  const google = commentedModel({
    google: true,
    firstParty: true,
    metrics: `${ORDER_COUNT}        entity: orders
        expression: COUNT(orders.order_id)  # counts orders
`,
  });

  // The text that shows each comment in place in an output file.
  function expectedComments({google = false, source, counts}: {
    google?: boolean, source: string, counts: string
  }): string[] {
    const version = google ? '0.2.0.dev0/google' : '0.2.0.dev0';
    const list = google ? 'entities' : 'datasets';
    return [
      `${HEADER}\n\nversion: "${version}" # format version\n`,
      '      # prefer net revenue\n      instructions: Prefer net revenue\n',
      `  - name: retail\n    ${list}:\n      # one row per order\n`,
      '      # one row per order\n      - name: orders\n',
      `        source: ${source} # the orders table\n`,
      '          # the order key\n          - name: order_id\n',
      '            datatype: Integer # a whole number\n',
      '                - dialect: SNOWFLAKE # as written\n',
      `    metrics: # every metric\n${ORDER_COUNT}`,
      counts,
      '\n# end of model\n',
    ];
  }
  const ABOVE = '        expression: # counts orders\n          dialects:';
  const INLINE = '        expression: COUNT(orders.order_id) # counts orders\n';
  const TRANSPILED =
      '# as written\n                  expression: orders.order_id\n                - dialect: BIGQUERY\n';

  test.each([
    [
      'third-party repairs and a removed metric', thirdParty, {},
      expectedComments({source: 'orders', counts: ABOVE})
    ],
    [
      'a source completed from --source-prefix', thirdParty,
      {sourcePrefix: BQ_PREFIX},
      expectedComments({source: BQ_TABLE, counts: ABOVE})
    ],
    [
      'a BIGQUERY entry added by --transpile', thirdParty, {transpile: true},
      [...expectedComments({source: 'orders', counts: ABOVE}), TRANSPILED]
    ],
    [
      'a third-party file written in the Google flavor', thirdParty,
      {flavor: 'google' as const},
      expectedComments({google: true, source: 'orders', counts: INLINE})
    ],
    [
      'a conversion from vanilla to Google', vanilla,
      {flavor: 'google' as const, strict: true}, expectedComments({
        google: true,
        source: BQ_TABLE,
        counts: `      - name: order_count\n        entity: orders\n${ABOVE}`,
      })
    ],
    [
      'a conversion from Google to vanilla', google,
      {flavor: 'ossie' as const, strict: true},
      expectedComments({source: BQ_TABLE, counts: ABOVE})
    ],
    [
      'a metric whose first key import removes', commentedModel({
        metrics: ORDER_COUNT.replace(
                     '- name', '- datatype: Opaque\n\n        name') +
            '        expression: COUNT(orders.order_id)\n',
      }),
      {}, [`    metrics: # every metric\n${ORDER_COUNT}`]
    ],
  ])('keeps comments in place through %s', async (_, input, opts, lines) => {
    const res = await importSemanticModelYaml(input, opts);

    expect(res.errors).toEqual([]);
    for (const line of lines) expect(res.files[0].content).toContain(line);
    expect(res.files[0].content).not.toContain('# rows in any table');
  });

  test('drops the metrics key when import removes every metric', async () => {
    const res =
        await importSemanticModelYaml(commentedModel({metrics: ROW_COUNT}));

    expect(res.files[0].content).not.toContain('metrics');
  });

  test('writes a changed CRLF file with LF line endings only', async () => {
    const input =
        thirdParty
            .replace(
                '# the order key', '# the order key\n          # second line')
            .replace(/\n/g, '\r\n');

    const res = await importSemanticModelYaml(input);

    expect(res.files[0].content)
        .toContain('# the order key\n          # second line\n');
    expect(res.files[0].content).not.toContain('\r');
  });

  test('writes a changed JSON file as block YAML', async () => {
    const json = JSON.stringify(yaml.parse(thirdParty), null, 2);

    const res = await importSemanticModelYaml(json);

    expect(res.files[0].content)
        .toContain('\n    datasets:\n      - name: orders\n');
  });

  test('keeps every comment of the Apache Ossie TPC-DS example', async () => {
    const raw = readFileSync(
        join(__dirname, 'fixtures/ossie/tpcds_semantic_model.yaml'), 'utf8');
    // Every comment the parser finds in `text`, in order.
    const comments = (text: string) => {
      const doc = yaml.parseDocument(text);
      const found: Array<string|null|undefined> = [doc.commentBefore];
      yaml.visit(
          doc, {Node: (_, n) => void found.push(n.commentBefore, n.comment)});
      return [...found, doc.comment].filter(c => c);
    };

    const instructions = raw.split('\n').find(l => l.includes('instructions'));

    const res = await importSemanticModelYaml(raw);

    expect(res.files[0].content).not.toContain('customer_lifetime_value');
    expect(comments(res.files[0].content)).toEqual(comments(raw));
    expect(res.files[0].content)
        .toContain(
            '        primary_key: [ss_item_sk, ss_ticket_number] # Composite primary key\n');
    expect(res.files[0].content).toContain(`${instructions}\n`);
  });
});
