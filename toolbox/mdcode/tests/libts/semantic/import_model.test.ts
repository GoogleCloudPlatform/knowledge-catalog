// Tests for the semantic model import engine (import_model.ts).

import {describe, expect, test} from 'bun:test';
import * as yaml from 'yaml';

import {importSemanticModelYaml} from '../../../src/libts/semantic/import_model';
import {loadModels} from '../../../src/libts/semantic/loader';
import {loadProfileFile} from '../../../src/libts/semantic/resolve_profiles';

const BQ_PREFIX = 'bigquery.googleapis.com/projects/acme/datasets/sales';
const BQ_TABLE = `${BQ_PREFIX}/tables/orders`;
const SPANNER_TABLE =
    'spanner.googleapis.com/projects/acme/instances/i/databases/db/tables/orders';
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
      'system entry group sourcePrefix', ossieDoc(),
      {sourcePrefix: 'projects/acme/locations/us/entryGroups/@bigquery'},
      "names the system entry group '@bigquery', whose entries are Google Cloud tables"
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
      'catalog name a resource name cannot be built from',
      googleDoc({source: `'bigquery:acme.sales."a/b c"'`}), {strict: true},
      'is a Knowledge Catalog name'
    ],
    [
      'resource name with quotes in strict mode',
      googleDoc({source: `'${BQ_PREFIX}/tables/"orders"'`}), {strict: true},
      `so write '${BQ_TABLE}'. 'kcmd push' rejects the file until it is repointed.`
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
      ossieDoc({extra: '            datatype: integer\n'}), {strict: true},
      `field 'orders.order_id': rewrote datatype 'integer' to 'Integer'.`
    ],
    [
      'vanilla datatype in another casing converted to Google in strict mode',
      ossieDoc({extra: '            datatype: integer\n'}), {flavor: 'google' as const, strict: true},
      `Semantic model load error: field 'orders.order_id': datatype 'integer' is not valid in a '0.2.0.dev0' document; expected exactly one of String, Integer, Decimal, Float, Boolean, Date, Time, DateTime, DateTimeTz, Opaque.`
    ],
    [
      'one-part name against an AlloyDB database prefix in strict mode',
      googleDoc({source: 'orders'}), {strict: true, sourcePrefix: ALLOYDB_DB},
      `dataset 'orders': source 'orders' names no schema, and neither does '--source-prefix', so import cannot complete it; add the schema to the source or to '--source-prefix'.`
    ],
    [
      'an unquoted part against an AlloyDB prefix with a capital letter in strict mode',
      googleDoc({source: 'Sales.orders'}),
      {strict: true, sourcePrefix: `${ALLOYDB_DB}/schemas/Sales`},
      `dataset 'orders': source 'Sales.orders' names schema 'sales', since PostgreSQL reads an unquoted name in lower case. '--source-prefix' names schema 'Sales', so import cannot complete the source. If the schema is 'Sales', write it as '"Sales"' in the source; if it is 'sales', write 'sales' in '--source-prefix'.`
    ],
    [
      'lowercase Opaque in strict mode',
      ossieDoc({extra: '            datatype: opaque\n'}), {strict: true},
      `field 'orders.order_id': removed datatype 'opaque'.`
    ],
    [
      'a vanilla string expression in strict mode',
      ossieDoc({fieldExpr: '"orders.order_id"'}), {strict: true},
      `field 'orders.order_id': wrote the string expression as an 'ANSI_SQL' dialects entry.`
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
        // On a Spanner table, the vendor field warns that the table cannot
        // run it.
        const onSpanner = await importSemanticModelYaml(
            raw.replace(BQ_TABLE, SPANNER_TABLE), {strict: true});
        expect(onSpanner.warnings[0]).toBe(
            "field 'orders.order_id': no 'SPANNER' or 'ANSI_SQL' dialect, so " +
            "the SPANNER table of entity 'orders' cannot run it");
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

// A profile field written only in Snowflake SQL gets a BIGQUERY entry in every
// profile the import writes.
describe('profile translation', () => {
  const fieldExpr =
      '{dialects: [{dialect: SNOWFLAKE, expression: "NVL(orders.order_id, 0)"}]}';
  // Its Snowflake text spans two lines, which a profile file writes as a
  // block scalar.
  const SNOWFLAKE = 'NVL(o.order_id, 0)\n  + NVL(o.order_id, 1) + NVL(o.order_id, 2)';
  const PROD = {
    name: 'prod',
    entities: [{
      name: 'orders',
      source: `${BQ_PREFIX}/tables/orders_prod`,
      fields: [{
        name: 'order_id',
        expression: {dialects: [{dialect: 'SNOWFLAKE', expression: SNOWFLAKE}]},
      }],
    }],
  };
  const block = `    custom_extensions:\n      - vendor_name: GOOGLE\n        data: '${
      JSON.stringify({profiles: [PROD]})}'\n`;
  const prodFile = {fileName: 'retail.profile.prod.yaml', content: yaml.stringify(PROD)};
  // Push reads a profile file without its actions, so a malformed one does not
  // stop translation.
  const withActions = {
    ...prodFile,
    content: yaml.stringify({...PROD, actions: [{drop: {target: 'x'}}]}),
  };
  const strict = {strict: true, transpile: true};

  // [label, input, options]
  test.each([
    ['a GOOGLE block profile, written back into the block', ossieDoc({fieldExpr, extra: block}),
     {...strict, flavor: 'ossie' as const}],
    ['a GOOGLE block profile, written as a profile file', ossieDoc({fieldExpr, extra: block}),
     {...strict, flavor: 'google' as const}],
    ['a profile file, written into the vanilla model file', googleDoc({fieldExpr}),
     {...strict, flavor: 'ossie' as const, profileFiles: [prodFile]}],
    ['a profile file, written beside the Google model file', googleDoc({fieldExpr}),
     {...strict, flavor: 'google' as const, profileFiles: [prodFile]}],
    ['a profile file with a malformed action', googleDoc({fieldExpr}),
     {...strict, flavor: 'google' as const, profileFiles: [withActions]}],
  ])('translates %s', async (_, input, opts) => {
    const res = await importSemanticModelYaml(input, opts);
    expect(res.errors).toEqual([]);
    const written = res.files.length > 1 ?
        loadProfileFile(res.files[1].content, 'prod', {skipActions: true}) :
        loadModels(res.files[0].content).models[0].profiles![0];
    expect(written.entities[0].fields![0].dialects).toEqual([
      {dialect: 'SNOWFLAKE', expression: SNOWFLAKE},
      {
        dialect: 'BIGQUERY',
        expression: 'COALESCE(o.order_id, 0) + COALESCE(o.order_id, 1) + COALESCE(o.order_id, 2)',
      },
    ]);
    expect(res.warnings.filter(w => w.startsWith('profile '))).toEqual([
      "profile 'prod': field 'orders.order_id': transpiled 'SNOWFLAKE' -> 'BIGQUERY'",
    ]);
  });

  test('reports a profile file it writes that does not parse', async () => {
    const res = await importSemanticModelYaml(googleDoc(), {
      flavor: 'google',
      profileFiles: [{fileName: 'retail.profile.prod.yaml', content: 'name: [prod\n'}],
    });
    expect(res.errors).toEqual([expect.stringContaining(
        "the import writes 'retail.profile.prod.yaml', which does not parse: ")]);
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
        expect(res.warnings).toContain(
            `field 'orders.order_id': wrote the string expression as an ` +
            `'ANSI_SQL' dialects entry.`);
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
      'GOOGLE-block deployments URI',
      ossieDoc({
        extra:
            '    custom_extensions:\n      - vendor_name: GOOGLE\n        data: \'{"deployments":[{"name":"prod","target":"//bigquery.googleapis.com/projects/acme/datasets/sales/propertyGraphs/retail"}]}\'\n',
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

  // A path in one pair of backticks gives its parts under a BigLake prefix,
  // and a part in double quotes keeps its dot.
  const LAKE = 'biglake.googleapis.com/projects/acme/catalogs/lake';
  const LAKE_TABLE = `${LAKE}/namespaces/sales/tables/orders`;
  const ALLOYDB_APP =
      'alloydb.googleapis.com/projects/acme/locations/us/clusters/c/databases/app';
  test.each([
    ['`acme.lake.sales.orders`', LAKE, LAKE_TABLE],
    ['`acme.lake.sales.orders`', `${LAKE}/namespaces/sales`, LAKE_TABLE],
    ['public."order.items"', CLOUDSQL_PREFIX, `${CLOUDSQL_PREFIX}/tables/order.items`],
    ['public."order.items"', ALLOYDB_APP, `${ALLOYDB_APP}/schemas/public/tables/order.items`],
  ])('qualifies %s from %s', async (bare, sourcePrefix, table) => {
    const res = await importSemanticModelYaml(
        ossieDoc({source: `'${bare}'`}), {sourcePrefix});
    expect(loadModels(res.files[0].content, {warnUnacceptedSource: true})
               .models[0]
               .entities[0]
               .authoredSource)
        .toBe(table);
  });

  // Each warning ends with what to do: the entry name advice for a source in
  // no Google Cloud form, the name to write when the loader gives one, a run
  // with --source-prefix when a prefix of that kind completes the name, or why
  // kcmd cannot name the table.
  const ADVICE = 'A table outside Google Cloud is written as the entry name of ' +
      "its Knowledge Catalog entry, 'projects/<p>/locations/<l>/entryGroups/<g>/entries/<id>'.";
  const PUSH = "'kcmd push' rejects the file until it is repointed.";
  const RERUN = "or until 'kcmd import' runs again with '--source-prefix'.";
  const NO_QUOTE = 'kcmd cannot name a table whose name holds a quote.';
  test.each([
    ['no sourcePrefix', 'orders', {}, ADVICE],
    ['disagreeing prefix', 'raw.orders', {sourcePrefix: BQ_PREFIX}, `${RERUN} ${ADVICE}`],
    [
      'backtick-quoted table with dot',
      '\'sales.`my.table`\'',
      {sourcePrefix: BQ_PREFIX},
      ADVICE,
    ],
    [
      'double-quoted table with a space',
      'public."order items"',
      {sourcePrefix: CLOUDSQL_PREFIX},
      `kcmd cannot name a table whose name holds a space. ${PUSH} ${ADVICE}`,
    ],
    ['3P source', 'trino:cat.sch.orders', {sourcePrefix: BQ_PREFIX}, ADVICE],
    ['resource URI', `//${BQ_TABLE}`, {}, `'//': '${BQ_TABLE}'. ${PUSH}`],
    [
      'resource name with quotes', `'${BQ_PREFIX}/tables/"orders"'`, {},
      `so write '${BQ_TABLE}'. ${PUSH}`
    ],
    [
      'first-party catalog name', 'bigquery:acme.sales.orders', {},
      `resource name: '${BQ_TABLE}'. ${PUSH}`
    ],
    [
      'system entry name',
      'projects/acme/locations/us/entryGroups/@bigquery/entries/orders', {},
      `is not a valid GCP resource name; ${PUSH}`
    ],
    ['bare name with a doubled quote', `'"a""b"'`, {sourcePrefix: BQ_PREFIX}, `${NO_QUOTE} ${PUSH} ${ADVICE}`],
    ['bare name with an unclosed quote', `'sales."orders'`, {sourcePrefix: BQ_PREFIX}, `${NO_QUOTE} ${PUSH} ${ADVICE}`],
    // Only a BigQuery or BigLake prefix reads it as `orders`.
    ['backticked name with quotes', `'\`"orders"\`'`, {sourcePrefix: CLOUDSQL_PREFIX}, `${NO_QUOTE} ${PUSH} ${ADVICE}`],
    [
      'path in double quotes', `'"acme.sales.orders"'`, {sourcePrefix: BQ_PREFIX},
      "the quoted name 'acme.sales.orders' is one table name, and a BigQuery table name cannot hold a dot. " +
          "Write the table's GCP resource name instead, such as " +
          `'bigquery.googleapis.com/projects/<project>/datasets/<dataset>/tables/<table>'. ${PUSH} ${ADVICE}`,
    ],
    [
      'dotted name against a project prefix', `'"order.items"'`,
      {sourcePrefix: 'bigquery.googleapis.com/projects/acme'},
      "the quoted name 'order.items' is one table name, and a BigQuery table name cannot hold a dot. " +
          "Write the table's GCP resource name instead, such as " +
          `'bigquery.googleapis.com/projects/<project>/datasets/<dataset>/tables/<table>'. ${PUSH} ${ADVICE}`,
    ],
    // A prefix of the database `other` completes it.
    ['capitals against another AlloyDB database', 'OTHER.PUBLIC.Orders', {sourcePrefix: ALLOYDB_APP}, `${RERUN} ${ADVICE}`],
    [
      'dotted namespace', '\'lake.`my.ns`.orders\'', {sourcePrefix: LAKE},
      "the quoted name 'my.ns' is one namespace name, and a BigLake namespace name cannot hold a dot. " +
          "Write the table's GCP resource name instead, such as " +
          `'biglake.googleapis.com/projects/<project>/catalogs/<catalog>/namespaces/<namespace>/tables/<table>'. ${PUSH} ${ADVICE}`,
    ],
  ])('leaves %s as written with a warning and writes the file',
     async (_, src, opts, tail) => {
       const res = await importSemanticModelYaml(ossieDoc({source: src}), opts);
       const cleanSrc = src.replace(/^'|'$/g, '');

       const found = res.warnings.filter(w => w.includes(cleanSrc));
       expect([res.ok, found.length]).toEqual([true, 1]);
       expect(found[0]).toEndWith(tail);
     });

  test('keeps a third-party entry name as written, with no warning', async () => {
    const entry = 'projects/acme/locations/us/entryGroups/sf/entries/orders';
    const doc = ossieDoc({
      source: entry,
      fieldExpr: '{dialects: [{dialect: SNOWFLAKE, expression: order_id}]}',
    });
    const res = await importSemanticModelYaml(doc, {sourcePrefix: BQ_PREFIX});
    expect([res.ok, res.warnings, res.files[0].content])
        .toEqual([true, [], doc]);
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
  // The warnings for a model whose one source is `bare`.
  const caseWarnings = async (bare: string, sourcePrefix: string) =>
      (await importSemanticModelYaml(
           ossieDoc({
             source: `'${bare}'`,
             fieldExpr: '{dialects: [{dialect: ANSI_SQL, expression: order_id}]}',
           }),
           {sourcePrefix}))
          .warnings;
  const rewrote = (bare: string, completed: string) =>
      `dataset 'orders': rewrote bare source '${bare}' to '${completed}'.`;
  // [label, bare name, prefix, the source it completes to, or undefined when
  // it differs from the prefix only in letter case]
  test.each([
    ['AlloyDB, unquoted', 'ANALYTICS.PUBLIC.ORDERS', ALLOYDB, `${ALLOYDB}/tables/orders`],
    ['AlloyDB database', 'Public.ORDERS', ALLOYDB_DB, `${ALLOYDB}/tables/orders`],
    ['AlloyDB, double-quoted table', 'PUBLIC."Orders"', ALLOYDB, `${ALLOYDB}/tables/Orders`],
    ['AlloyDB, backticked table', 'PUBLIC.`Orders`', ALLOYDB, `${ALLOYDB}/tables/Orders`],
    ['AlloyDB, backticked schema', '`Public`.ORDERS', ALLOYDB_DB, `${ALLOYDB_DB}/schemas/Public/tables/orders`],
    ['AlloyDB, quoted schema', '"PUBLIC".orders', ALLOYDB, undefined],
    ['AlloyDB, quoted schema against a prefix with capitals', '"sales".orders', `${ALLOYDB_DB}/schemas/Sales`, undefined],
    ['AlloyDB, non-ASCII letter', 'PUBLIC.ÄRGER', ALLOYDB, `${ALLOYDB}/tables/Ärger`],
    ['BigQuery', 'SALES.orders', BQ_PREFIX, undefined],
    ['Cloud SQL', 'PUBLIC.orders', CLOUDSQL_PREFIX, undefined],
  ])('matches letter case against a prefix: %s', async (_, bare, sourcePrefix, completed) => {
    expect(await caseWarnings(bare, sourcePrefix)).toEqual([
      completed ?
          rewrote(bare, completed) :
          `dataset 'orders': source '${bare}' differs from '--source-prefix' only in letter case, so import cannot complete it; correct the letter case of the source or of '--source-prefix'.`,
    ]);
  });

  // An unquoted part, which PostgreSQL reads in lower case, never matches a
  // name with a capital letter from A to Z in an AlloyDB prefix. [bare name,
  // prefix, the part's kind, the prefix's name for it, the source with that
  // name double-quoted, the rest of the source it then completes to]
  test.each([
    ['Sales.orders', `${ALLOYDB_DB}/schemas/Sales`, 'schema', 'Sales', '"Sales".orders', '/tables/orders'],
    ['analytics.Sales.orders', `${ALLOYDB_DB}/schemas/Sales`, 'schema', 'Sales', 'analytics."Sales".orders', '/tables/orders'],
    ['Analytics.public.orders', ALLOYDB_DB.replace(/analytics$/, 'Analytics'), 'database', 'Analytics', '"Analytics".public.orders', '/schemas/public/tables/orders'],
  ])('says how to match an AlloyDB prefix with capitals: %s against %s', async (bare, prefix, kind, name, quoted, rest) => {
    const read = name.toLowerCase();
    expect(await caseWarnings(bare, prefix)).toEqual([
      `dataset 'orders': source '${bare}' names ${kind} '${read}', since PostgreSQL reads an unquoted name in lower case. '--source-prefix' names ${kind} '${name}', so import cannot complete the source. If the ${kind} is '${name}', write it as '"${name}"' in the source; if it is '${read}', write '${read}' in '--source-prefix'.`,
    ]);
    // Each way the warning gives completes the source.
    const lowered = prefix.replace(`/${name}`, `/${read}`);
    expect(await caseWarnings(quoted, prefix)).toEqual([rewrote(quoted, prefix + rest)]);
    expect(await caseWarnings(bare, lowered)).toEqual([rewrote(bare, lowered + rest)]);
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

describe('sources completed from an entry group', () => {
  const GROUP = 'projects/acme/locations/us/entryGroups/sf';
  // Listed with the project number, and written with the project as
  // --source-prefix spells it.
  const entry = (id: string, fullyQualifiedName: string) =>
      ({name: `projects/123/locations/us/entryGroups/sf/entries/${id}`, fullyQualifiedName});
  const ENTRIES = [
    entry('orders', 'snowflake:acme.retail.public.orders'),
    // Ends in public.orders in another letter case, as Snowflake reads it.
    entry('orders-upper', 'snowflake:acme.RETAIL.PUBLIC.ORDERS'),
    entry('items-a', 'snowflake:acme.retail.public.items'),
    entry('items-b', 'snowflake:acme.retail.sales.items'),
    entry('public', 'snowflake:acme.retail.public'),
    entry('dotted', 'snowflake:acme.retail.`my.schema`.t'),
    entry('customers', 'snowflake:acme.RETAIL.PUBLIC.CUSTOMERS'),
    entry('lines-a', 'snowflake:acme.RETAIL.PUBLIC.LINES'),
    entry('lines-b', 'snowflake:acme.RETAIL.PUBLIC.Lines'),
  ];
  // Each [dataset, source] pair as a dataset of a vanilla model.
  const model = (...datasets: Array<[string, string]>) =>
      'version: "0.2.0.dev0"\nsemantic_model:\n  - name: retail\n    datasets:\n' +
      datasets.map(([name, source]) => `      - name: ${name}\n        source: ${
          source}\n        primary_key: [id]\n        fields:\n          - name: id\n` +
          `            expression: {dialects: [{dialect: BIGQUERY, expression: ${name}.id}]}\n`)
          .join('');
  // A lister that records each call and yields ENTRIES, or throws `error`.
  const lister = (error?: string) => {
    const calls: string[][] = [];
    const listEntries = async function*(...args: string[]) {
      calls.push(args);
      if (error) throw new Error(error);
      yield* ENTRIES;
    };
    return {calls, listEntries};
  };
  const input = model(
      ['quoted', `'"public"."orders"'`], ['dotted', "'`my.schema`.t'"],
      ['customers', 'public.customers'], ['orders', 'public.orders'], ['items', 'items'],
      ['lines', 'public.lines'], ['ghosts', 'public.ghosts'],
      ['quoted_lower', `'"public".customers'`], ['ticked_lower', "'`public`.customers'"]);
  // Entry `id` as the import writes it, and its fullyQualifiedName.
  const named = (id: string) => ({
    name: `${GROUP}/entries/${id}`,
    fqn: ENTRIES.find(e => e.name.endsWith(`/${id}`))!.fullyQualifiedName,
  });
  // The message for `source` of dataset `ds`, completed to entry `id`.
  const rewrote = (ds: string, source: string, id: string) =>
      `dataset '${ds}': rewrote bare source '${source}' to '${named(id).name}', ` +
      `the entry whose fullyQualifiedName is '${named(id).fqn}'.`;
  // The message for `source` of dataset `ds`, which no entry ends in.
  const noEntry = (ds: string, source: string) =>
      `dataset '${ds}': left bare source '${source}' as written, since no entry for ` +
      `a table or view in entry group '${GROUP}' has a fullyQualifiedName that ends in ` +
      "it. 'kcmd push' rejects the file until the source is the entry name of the " +
      "table's Knowledge Catalog entry, 'projects/<p>/locations/<l>/entryGroups/<g>/entries/<id>'.";
  // The message for `source` of dataset `ds`, which the entries `ids` end in.
  const several = (ds: string, source: string, ...ids: string[]) =>
      `dataset '${ds}': left bare source '${source}' as written, since several entries in ` +
      `entry group '${GROUP}' have a fullyQualifiedName that ends in it: ${
          ids.map(id => `'${named(id).name}' (${named(id).fqn})`).join(', ')}. ` +
      "'kcmd push' rejects the file until the source names one of them.";
  const completed = [
    rewrote('quoted', '"public"."orders"', 'orders'),
    rewrote('dotted', '`my.schema`.t', 'dotted'),
    rewrote('customers', 'public.customers', 'customers'),
  ];
  const left = [
    several('orders', 'public.orders', 'orders', 'orders-upper'),
    several('items', 'items', 'items-a', 'items-b'),
    several('lines', 'public.lines', 'lines-a', 'lines-b'),
    noEntry('ghosts', 'public.ghosts'),
    // A quoted part keeps its letter case.
    noEntry('quoted_lower', '"public".customers'),
    noEntry('ticked_lower', '`public`.customers'),
  ];

  // A completion is a warning in strict mode too; a name left as written is an
  // error there, as any bare source is.
  test.each([
    ['third-party', false, [...completed, ...left], []],
    ['first-party', true, completed, left],
  ])('completes each name one entry ends in, and reports the rest (%s)',
     async (_, strict, warnings, errors) => {
       const {calls, listEntries} = lister();
       const res = await importSemanticModelYaml(
           input, {flavor: 'ossie', strict, sourcePrefix: GROUP, listEntries});
       expect([res.warnings, res.errors]).toEqual([warnings, errors]);
       expect(calls).toEqual([['acme', 'us', 'sf']]);
       if (!strict) {
         expect(loadModels(res.files[0].content, {warnUnacceptedSource: true})
                    .models[0].entities.map(e => e.authoredSource))
             .toEqual([...['orders', 'dotted', 'customers'].map(id => named(id).name),
                       'public.orders', 'items', 'public.lines', 'public.ghosts',
                       '"public".customers', '`public`.customers']);
       }
     });

  // [label, input, sourcePrefix]
  test.each([
    ['a first-party prefix', model(['orders', 'orders']), BQ_PREFIX],
    ['sources that are not bare names',
     model(['orders', `${GROUP}/entries/orders`], ['other', 'trino:cat.public.orders']), GROUP],
  ])('reads no catalog for %s', async (_, text, sourcePrefix) => {
    const {calls, listEntries} = lister();
    const res = await importSemanticModelYaml(text, {sourcePrefix, listEntries});
    expect(res.ok).toBe(true);
    expect(calls).toEqual([]);
  });

  test('stops when the entry group cannot be listed', async () => {
    const {listEntries} = lister('Failed to list entries: Permission denied');
    const res = await importSemanticModelYaml(
        input, {sourcePrefix: GROUP, listEntries});
    expect([res.ok, res.files, res.errors]).toEqual([false, [], [
      `Could not list the entries of entry group '${GROUP}' to complete bare ` +
          'table names: Failed to list entries: Permission denied',
    ]]);
  });
});

describe('dialects and datatypes', () => {
  test(
      'maps dialect aliases and drops non-SQL dialects',
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
        expect(res.warnings).toContain(
            `field 'orders.order_id': rewrote dialect 'GOOGLE_SQL' to 'BIGQUERY'.`);
        expect(res.files[0].content).toContain('datatype: integer');
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

  test.each([
    ['a Google file', {strict: true}, ['datatype: integer', 'datatype: Opaque']],
    [
      'a Google file converted to vanilla',
      {flavor: 'ossie' as const, strict: true},
      ['datatype: Integer', 'datatype: Opaque', 'dialect: ANSI_SQL'],
    ],
  ])('keeps each datatype the output flavor accepts in %s', async (_, opts, lines) => {
    const res = await importSemanticModelYaml(
        googleDoc({extra: '            datatype: integer\n          - name: amount\n            datatype: Opaque\n            expression: amount\n'}),
        opts);

    expect(res.errors).toEqual([]);
    expect(res.warnings.filter(w => w.startsWith('field '))).toEqual([]);
    for (const line of lines) expect(res.files[0].content).toContain(line);
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
        const strictRes = await importSemanticModelYaml(
            ossieDoc({extra}), {flavor: 'google', strict: true});

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
        expect(strictRes.errors.some(
                   e => e.includes('row_count') &&
                       e.includes('GOOGLE custom_extensions block')))
            .toBe(true);
        const loaded = loadModels(res.files[0].content);
        expect(loaded.models).toHaveLength(1);
        expect(loaded.models[0].description).toHaveLength(2000);
        expect(loaded.models[0].metrics.map(m => m.name)).toEqual([
          'valid_orders'
        ]);
      });

  // A GOOGLE block comes only in strict mode, which writes no file.
  test.each([
    ['written natively', googleDoc, 'description: %s', false],
    ['in a GOOGLE block', ossieDoc, `custom_extensions: [{vendor_name: GOOGLE, data: '{"description": "%s"}'}]`, true],
  ])('reports a relationship description over 2,000 characters %s', async (_, build, line, strict) => {
    const res = await importSemanticModelYaml(build({
      extra: `    relationships:\n      - name: oc\n        from: orders\n        to: orders\n        from_columns: [order_id]\n        to_columns: [order_id]\n        ${line.replace('%s', 'd'.repeat(2005))}\n`,
    }), {strict});

    expect([...res.warnings, ...res.errors]).toEqual([
      `relationship 'oc': truncated 'description' from 2005 to 2000 characters.`,
    ]);
    expect(res.files.map(f => loadModels(f.content).models[0].relationships[0].description))
        .toEqual(strict ? [] : ['d'.repeat(2000)]);
  });

  test('counts a description without its surrounding whitespace, as push does', async () => {
    const input = googleDoc({
      extra: `    relationships:\n      - name: oc\n        from: orders\n        to: orders\n        from_columns: [order_id]\n        to_columns: [order_id]\n        description: |\n          ${'d'.repeat(2000)}\n`,
    });
    const res = await importSemanticModelYaml(input, {strict: true});

    expect(res.errors).toEqual([]);
    expect(res.files.map(f => f.content)).toEqual([input]);
  });

  test('cuts a description before a surrogate pair it would split', async () => {
    const res = await importSemanticModelYaml(googleDoc({
      extra: `    relationships:\n      - name: oc\n        from: orders\n        to: orders\n        from_columns: [order_id]\n        to_columns: [order_id]\n        description: " ${'d'.repeat(1999)}\u{1F600}${'d'.repeat(10)} "\n`,
    }));

    expect(res.warnings).toEqual(
        [`relationship 'oc': truncated 'description' from 2011 to 1999 characters.`]);
    expect(res.files[0].content).toContain(`description: "${'d'.repeat(1999)}"\n`);
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
      `model 'retail': 'deploymentTargets' is no longer supported; use 'deployments' inside the GOOGLE custom_extensions block instead, for example {"deployments": [{"name": "default", "target": "<target>"}]}.`,
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

  // A relationship from `orders` to itself, with `lines` added to it.
  const selfJoin = (lines: string) => `    relationships:
      - name: self
        from: orders
        to: orders
        from_columns: [order_id]
        to_columns: [order_id]
${lines}`;
  test.each([
    ['a padded description', '    description: "  Retail model  "\n'],
    ['a block description', '    description: |\n      Retail model.\n'],
    ['a string ai_context', '    ai_context: Retail model\n'],
    ['an empty metrics list', '    metrics: []  # none yet\n'],
    ['repeated synonyms', '    ai_context:\n      synonyms: [shop, shop, store]\n'],
    ['an empty ai_context', '    ai_context: {}\n'],
  ].flatMap(
      ([what, lines]): Array<[string, string, string, string | string[]]> => [
        [what, 'google', ossieDoc({modelAiContext: lines}), lines],
        [what, 'ossie', googleDoc({modelAiContext: lines}), lines],
      ]).concat([
    [
      'GOOGLE block values in their own keys', 'google',
      ossieDoc({
        modelDescription: 'Retail',
        modelAiContext:
            `    custom_extensions: [{vendor_name: GOOGLE, data: '{"deployments": [{"name": "prod", "target": "${BQ_PREFIX}/propertyGraphs/retail"}]}'}]\n`,
        source: `${BQ_TABLE}\n        custom_extensions: [{vendor_name: GOOGLE, data: '{"extends": ["base"]}'}]`,
        extra: `      - name: base\n        source: ${BQ_TABLE}\n        fields: []\n` +
            selfJoin(
                `        custom_extensions: [{vendor_name: GOOGLE, data: '{"description": "  Self join.\\n"}'}]\n`),
      }),
      [
        '    description: "Retail"\n    deployments:\n      - name: prod\n',
        `        source: ${BQ_TABLE}\n        extends:\n          - base\n        primary_key:`,
        '        to_columns: [order_id]\n        description: |2\n            Self join.\n',
      ],
    ],
    [
      'a description in a GOOGLE block', 'ossie',
      googleDoc({
        extra: selfJoin(
            '        description: |\n          Self join.\n        custom_extensions:\n          - vendor_name: DBT\n            data: "{}"\n'),
      }),
      `            data: "{}"\n          - vendor_name: GOOGLE\n            data: '{"description":"Self join.\\n"}'\n`,
    ],
    [
      'custom ai_context members where custom was', 'ossie',
      googleDoc({
        modelAiContext:
            '    ai_context:\n      instructions: i\n      custom:\n        team: sales\n      synonyms: [s]\n',
        source: `${BQ_TABLE}\n        ai_context: {instructions: d, custom: {k: d}}`,
        fieldExpr: 'order_id\n            ai_context: {instructions: f, custom: {k: f}}',
        extra: selfJoin('        ai_context: {instructions: r, custom: {k: r}}\n') +
            '    metrics:\n      - name: n\n        expression: COUNT(orders.order_id)\n        ai_context: {instructions: m, custom: {k: m}}\n',
      }),
      [
        '    ai_context:\n      instructions: i\n      team: sales\n      synonyms: [s]\n',
        ...['d', 'f', 'r', 'm'].map(x => `ai_context: {instructions: ${x}, k: ${x}}\n`),
      ],
    ],
    [
      'no empty value, abstract: false or empty actions', 'ossie',
      googleDoc({
        modelAiContext:
            '    deployments: []\n    ai_context: {custom: {}}\n    actions: []\n    constraints: []\n',
        source: `${BQ_TABLE}\n        abstract: false\n        extends: []`,
        extra: selfJoin('        description: ""\n') + '# end\n',
      }),
      ossieDoc({extra: `${selfJoin('')}# end\n`}),
    ],
    [
      'the GOOGLE block after the entities that came before deployments', 'ossie',
      googleDoc({
        modelAiContext: '    # Entities\n',
        extra: `    deployments:\n      - name: prod\n        target: ${BQ_PREFIX}/propertyGraphs/retail\n`,
      }),
      ossieDoc({
        modelAiContext: '    # Entities\n',
        extra: `    custom_extensions:\n      - vendor_name: GOOGLE\n        data: '{"deployments":[{"name":"prod","target":"${BQ_PREFIX}/propertyGraphs/retail"}]}'\n`,
      }),
    ],
  ]))('writes %s in a conversion to %s', async (_, flavor, input, lines) => {
    const res = await importSemanticModelYaml(
        input, {flavor: flavor as 'google' | 'ossie', strict: true});

    expect(res.errors).toEqual([]);
    for (const line of [lines].flat()) {
      expect(res.files[0].content).toContain(line);
    }
    const again =
        await importSemanticModelYaml(res.files[0].content, {strict: true});
    expect(again.files[0].content).toBe(res.files[0].content);
  });

  test.each([
    ['abstract: false', {source: `${BQ_TABLE}\n        abstract: false`}, '        abstract: false\n'],
    [
      'extends', {
        source: `${BQ_TABLE}\n        extends: [base]`,
        extra: `      - name: base\n        source: ${BQ_TABLE}\n        fields: []\n`,
      },
      '        extends: [base]\n',
    ],
    ['a relationship description', {extra: selfJoin('        description: Self join.\n')}, '        description: Self join.\n'],
    [
      'a metric entity',
      {extra: '    metrics:\n      - name: n\n        entity: orders\n        expression: {dialects: [{dialect: BIGQUERY, expression: COUNT(orders.order_id)}]}\n'},
      '        entity: orders\n',
    ],
    [
      'deployments',
      {modelAiContext: `    deployments:\n      - name: prod\n        target: ${BQ_PREFIX}/propertyGraphs/retail\n`},
      '    deployments:\n      - name: prod\n',
    ],
  ])('keeps %s that a third-party vanilla file writes as a native key, writing it as Google', async (_, overrides, line) => {
    const res = await importSemanticModelYaml(ossieDoc(overrides), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(res.files[0].content).toContain(line);
  });

  test('refuses a native profiles key in a third-party vanilla file written as Google', async () => {
    const res = await importSemanticModelYaml(
        ossieDoc({modelAiContext: '    profiles:\n      - name: prod\n'}),
        {flavor: 'google'});

    expect(res.errors).toEqual(
        [expect.stringContaining('inline \'profiles\' are not supported')]);
  });

  test('keeps a GOOGLE block when a strict import into vanilla completes a source', async () => {
    const block = `    custom_extensions: [{vendor_name: GOOGLE, data: '{"deployments": [{"name": "prod", "target": "${BQ_PREFIX}/propertyGraphs/retail"}]}'}]\n`;
    const res = await importSemanticModelYaml(
        ossieDoc({source: 'orders', modelAiContext: block}),
        {strict: true, sourcePrefix: BQ_PREFIX});

    expect(res.errors).toEqual([]);
    expect(res.files[0].content).toContain(block);
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

test('drops the blank lines after `{` and `[` of a JSON file', async () => {
  // Blank lines follow `{` and `[`, and sit between two keys and between two
  // list items. Only the last two kinds stay. The empty list stays `[]`.
  const json = `{

  "version": "0.2.0.dev0",

  "semantic_model": [

    {

      "name": "retail",
      "datasets": [

        {"name": "orders", "source": "orders", "primary_key": [

          "id"],

          "fields": [{"name": "id", "expression": "id"}]},

        {"name": "items", "source": "items"}
      ],
      "relationships": []
    }
  ]
}
`;

  const res = await importSemanticModelYaml(json);

  expect(res.warnings).toContain("Converted 'retail.yaml' to YAML.");
  expect(res.files[0].content).toBe(`version: 0.2.0.dev0

semantic_model:
  - name: retail
    datasets:
      - name: orders
        source: orders
        primary_key:
          - id

        fields:
          - name: id
            expression:
              dialects:
                - dialect: ANSI_SQL
                  expression: id

      - name: items
        source: items
    relationships: []
`);
});
