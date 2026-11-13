// Tests for third-party import of a model written at the document root, as
// Apache Ossie '0.3.0.dev0' files and the Ossie converters' '0.2.0.dev0' files
// hold it (import_model.ts).

import {describe, expect, test} from 'bun:test';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import * as yaml from 'yaml';

import {importSemanticModelYaml} from '../../../src/libts/semantic/import_model';
import {loadModels, loadSemanticModels} from '../../../src/libts/semantic/loader';
import {loadSqlEngine} from '../../../src/libts/semantic/sql_parser';

const TABLES = 'bigquery.googleapis.com/projects/acme/datasets/sales/tables';
const CLOUD_SQL_TABLES =
    'cloudsql.googleapis.com/projects/acme/locations/l/instances/i/databases/db/schemas/public/tables';
const ALLOYDB_DB =
    'alloydb.googleapis.com/projects/acme/locations/us-central1/clusters/c1/databases/analytics';

// An Apache Ossie example, as Ossie wrote it.
function example(name: string): string {
  return readFileSync(join(__dirname, 'ossie_examples', name), 'utf8');
}

// The dialect entries of the first field of the model `content` holds.
function fieldDialects(content: string): unknown {
  return loadModels(content, {warnUnacceptedSource: true})
      .models[0].entities[0].fields[0].dialects;
}

// A model at the document root with one dataset and one field, as YAML.
// `edit` changes a copy of it first.
function rootDoc(edit: (m: any) => void = () => {}): string {
  const model: any = {
    version: '0.3.0.dev0',
    name: 'retail',
    datasets: [{
      name: 'orders',
      source: `${TABLES}/orders`,
      fields: [{
        name: 'order_id',
        expression: {dialects: [{dialect: 'ANSI_SQL', expression: 'order_id'}]},
      }],
    }],
  };
  edit(model);
  return yaml.stringify(model);
}

// The model text `rootDoc` writes, with each line after `version` under
// `semantic_model`, as a wrapped file of `version` writes it.
function wrapped(text: string, version: string): string {
  const [, ...lines] = text.split('\n');
  return `version: ${version}\nsemantic_model:\n` +
      lines.map((l, i) => !l ? l : i ? `    ${l}` : `  - ${l}`).join('\n');
}

describe('a model at the document root', () => {
  test.each([
    ['0.3.0.dev0', 'ossie', '0.2.0.dev0', `, and wrote version '0.3.0.dev0' as '0.2.0.dev0'.`],
    ['0.3.0.dev0', 'google', '0.2.0.dev0/google', `, and wrote version '0.3.0.dev0' as '0.2.0.dev0/google'.`],
    ['0.2.0.dev0', 'ossie', '0.2.0.dev0', '.'],
    ['0.2.0.dev0', 'google', '0.2.0.dev0/google', '.'],
  ] as const)('reads a %s file and writes it with --flavor %s', async (version, flavor, written, end) => {
    const input = rootDoc(m => m.version = version);
    const res = await importSemanticModelYaml(input, {flavor});

    expect(res.errors).toEqual([]);
    const expected = wrapped(input, written);
    expect(res.files[0].content)
        .toBe(flavor === 'google' ? expected.replace('datasets:', 'entities:') : expected);
    expect(res.warnings[0]).toBe(
        `Moved the model from the document root into 'semantic_model', where kcmd reads it${end}`);
  });

  test('reports each edit of the conversion', async () => {
    const input = `version: 0.3.0.dev0
name: retail
datasets:
  - name: orders
    source: ${TABLES}/orders
    primary_key: [id]
    fields:
      - name: id
        expression:
          sql: orders.order_id
      - name: amount
        expression:
          dialects:
            - dialect: BIGQUERY
              expression: orders.amt
    metrics:
      - name: revenue
        expression:
          sql: SUM(amount) + SUM(source.amt) + SUM(source.tax)
          dialects:
            - dialect: BIGQUERY
              expression: SUM(amount) + SUM(source.amt)
`;
    const res = await importSemanticModelYaml(input, {flavor: 'ossie'});

    expect(res.errors).toEqual([]);
    expect(res.warnings.slice(0, 8)).toEqual([
      `Moved the model from the document root into 'semantic_model', where kcmd reads it, ` +
          `and wrote version '0.3.0.dev0' as '0.2.0.dev0'.`,
      `Moved the metrics of these datasets to the model's 'metrics', each anchored on its ` +
          `dataset: dataset 'orders' ('revenue').`,
      `Wrote the 'sql' of these expressions as an 'OSSIE_SQL_2026' entry of 'dialects', as ` +
          `'0.2.0.dev0' reads it: field 'orders.id', metric 'revenue' of dataset 'orders'.`,
      `Removed the qualifier that names the field's own dataset from the expressions of these ` +
          `fields, since kcmd reads a column of the dataset's source unqualified: field ` +
          `'orders.id', field 'orders.amount'.`,
      `Rewrote each key and join column that names a field to the column the field reads: ` +
          `dataset 'orders': primary_key 'id' to 'order_id'.`,
      `Qualified with their dataset's name the field names these metrics read unqualified, ` +
          `since kcmd reads a metric's fields as '<dataset>.<field>': metric 'revenue' of ` +
          `dataset 'orders'.`,
      `Wrote each 'source.<column>' these metrics read as the field of their dataset that ` +
          `reads the column: metric 'revenue' of dataset 'orders' 'source.amt' to 'orders.amount'.`,
      `dataset 'orders': added field 'tax', which reads column 'tax', for metric 'revenue', ` +
          `which reads it as 'source.tax'.`,
    ]);
    expect(loadModels(res.files[0].content).models[0].metrics[0].dialects).toEqual([
      {dialect: 'OSSIE_SQL_2026', expression: 'SUM(orders.amount) + SUM(orders.amount) + SUM(orders.tax)'},
      {dialect: 'BIGQUERY', expression: 'SUM(orders.amount) + SUM(orders.amount)'},
    ]);
  });

  test.each([
    ['a dataset with no fields', (m: any) => delete m.datasets[0].fields],
    ['string custom_extensions data', (m: any) => {
      m.datasets[0].custom_extensions = [{vendor_name: 'THOUGHTSPOT', data: '{"a":1}'}];
    }],
  ])('reads a model with %s', async (_, edit) => {
    const res = await importSemanticModelYaml(rootDoc(edit), {flavor: 'google'});

    expect(res.errors).toEqual([]);
  });

  test('reads a file the Ossie converters write, its lists not indented', async () => {
    const input = `# Generated.
version: 0.2.0.dev0
name: retail
datasets:
- name: orders
  source: ${TABLES}/orders
  fields:
  - name: order_id
    expression:
      dialects:
      - dialect: THOUGHTSPOT
        expression: '[orders::order_id]'
      - dialect: ANSI_SQL
        expression: order_id
  custom_extensions:
  - vendor_name: THOUGHTSPOT
    data: '{"_v": 1, "connection_name": "Minimal Connection",
      "tml_object": "table"}'
`;
    const res = await importSemanticModelYaml(input, {flavor: 'ossie'});

    expect(res.errors).toEqual([]);
    expect(res.files[0].content).toBe(`# Generated.
version: 0.2.0.dev0
semantic_model:
- name: retail
  datasets:
  - name: orders
    source: ${TABLES}/orders
    fields:
    - name: order_id
      expression:
        dialects:
        - dialect: ANSI_SQL
          expression: order_id
    custom_extensions:
    - vendor_name: THOUGHTSPOT
      data: '{"_v": 1, "connection_name": "Minimal Connection",
        "tml_object": "table"}'
`);
  });

  test('writes a JSON file as YAML, with the text of each number, and says so once', async () => {
    const numbers = '{"huge":1e400,"big":12345678901234567890123,"f":1.50,"e":1E3}';
    const res = await importSemanticModelYaml(
        JSON.stringify(yaml.parse(rootDoc())).replace(
            /^\{/, `{"nonportable_extensions": [{"vendor_name": "V", "data": ${numbers}}], `),
        {flavor: 'ossie', fileName: 'retail.json'});

    expect(res.errors).toEqual([]);
    expect(res.warnings.filter(w => w.startsWith('Converted'))).toEqual([
      "Converted 'retail.json' to YAML.",
    ]);
    expect(yaml.parse(res.files[0].content).semantic_model[0].custom_extensions[0].data)
        .toBe(numbers);
  });

  test.each([
    [
      'a header, a document start and version last',
      `# Licensed to the ASF.\n---\nname: retail\n# The tables.\ndatasets:\n  - name: orders\n    source: ${TABLES}/orders\n    fields: [{name: order_id, expression: {dialects: [{dialect: ANSI_SQL, expression: order_id}]}}]\n\n# The version.\nversion: '0.3.0.dev0'  # dev\n`,
      `# Licensed to the ASF.\n---\n\n# The version.\nversion: '0.2.0.dev0'  # dev\nsemantic_model:\n  - name: retail\n    # The tables.\n    datasets:\n      - name: orders\n        source: ${TABLES}/orders\n        fields: [{name: order_id, expression: {dialects: [{dialect: ANSI_SQL, expression: order_id}]}}]\n`,
    ],
    [
      'CRLF line ends, no final line break and block scalars',
      `version: 0.3.0.dev0\r\nname: retail\r\n\r\ndescription: |2\r\n   indented\r\n  text\r\nai_context: >-\r\n  folded\r\n  text\r\ndatasets:\r\n- name: orders\r\n  source: ${TABLES}/orders\r\n  fields:\r\n  - name: order_id\r\n    expression: {dialects: [{dialect: ANSI_SQL, expression: order_id}]}`,
      `version: 0.2.0.dev0\r\nsemantic_model:\r\n- name: retail\r\n\r\n  description: |2\r\n     indented\r\n    text\r\n  ai_context: >-\r\n    folded\r\n    text\r\n  datasets:\r\n  - name: orders\r\n    source: ${TABLES}/orders\r\n    fields:\r\n    - name: order_id\r\n      expression: {dialects: [{dialect: ANSI_SQL, expression: order_id}]}`,
    ],
    [
      'a flow mapping over several lines and an alias of an anchor in another key',
      `version: 0.3.0.dev0\nname: &n retail\nai_context: {instructions: *n,\n  synonyms: [a,\n b]}\ndatasets:\n  - name: orders\n    source: ${TABLES}/orders\n    fields:\n      - {name: order_id, expression: {dialects: [{dialect: ANSI_SQL, expression: order_id}]}}\n`,
      `version: 0.2.0.dev0\nsemantic_model:\n  - name: &n retail\n    ai_context: {instructions: *n,\n      synonyms: [a,\n     b]}\n    datasets:\n      - name: orders\n        source: ${TABLES}/orders\n        fields:\n          - {name: order_id, expression: {dialects: [{dialect: ANSI_SQL, expression: order_id}]}}\n`,
    ],
    [
      'a document end marker',
      `version: 0.3.0.dev0\nname: retail\ndatasets: [{name: orders, source: ${TABLES}/orders}]\n...\n# After the end.\n`,
      `version: 0.2.0.dev0\nsemantic_model:\n  - name: retail\n    datasets: [{name: orders, source: ${TABLES}/orders}]\n...\n# After the end.\n`,
    ],
    [
      'its root mapping indented',
      `  version: 0.3.0.dev0\n  name: retail\n  datasets: [{name: orders, source: ${TABLES}/orders}]\n`,
      `  version: 0.2.0.dev0\n  semantic_model:\n    - name: retail\n      datasets: [{name: orders, source: ${TABLES}/orders}]\n`,
    ],
    [
      'CRLF line ends, no final line break and dataset metrics last',
      `version: 0.3.0.dev0\r\nname: retail\r\ndatasets:\r\n- name: orders\r\n  source: ${TABLES}/orders\r\n  metrics:\r\n  - name: n\r\n    expression: {dialects: [{dialect: ANSI_SQL, expression: COUNT(*)}]}`,
      `version: 0.2.0.dev0\r\nsemantic_model:\r\n- name: retail\r\n  datasets:\r\n  - name: orders\r\n    source: ${TABLES}/orders\r\n  metrics:\r\n  - name: n\r\n    expression: {dialects: [{dialect: ANSI_SQL, expression: COUNT(*)}]}\r\n    custom_extensions:\r\n    - vendor_name: GOOGLE\r\n      data: '{"entity":"orders"}'`,
    ],
  ])('keeps each line of a file with %s', async (_, input, output) => {
    const res = await importSemanticModelYaml(input, {flavor: 'ossie'});

    expect(res.errors).toEqual([]);
    expect(res.files[0].content).toBe(output);
  });
});

describe('an alias the conversion would put before its anchor', () => {
  const dataset = (name: string, more: string) =>
      `  - name: ${name}\n    source: ${TABLES}/${name}\n    fields:\n      - name: id\n        expression: {sql: id}\n${more}`;
  const context = {synonyms: ['count']};
  test.each([
    [
      'its anchor in a moved metric', 'ctx', ['entities', 1, 'fields', 0, 'ai_context'], context,
      `version: 0.3.0.dev0\nname: retail\ndatasets:\n` +
          dataset('orders', `    metrics:\n      - name: n\n        expression: {sql: COUNT(id)}\n        ai_context: &ctx {synonyms: [count]}\n`) +
          dataset('items', `        ai_context: *ctx\n`),
    ],
    [
      'its anchor on a long string with a line break in a moved metric', 'ctx', ['entities', 1, 'fields', 0, 'ai_context'],
      {instructions: 'a fairly long instruction line that runs past forty characters\nSecond'},
      `version: 0.3.0.dev0\nname: retail\ndatasets:\n` +
          dataset('orders', `    metrics:\n      - name: n\n        expression: {sql: COUNT(id)}\n        ai_context: &ctx {instructions: "a fairly long instruction line that runs past forty characters\\nSecond"}\n`) +
          dataset('items', `        ai_context: *ctx\n`),
    ],
    [
      'in a moved metric, the model\'s metrics first', 'ctx', ['metrics', 0, 'ai_context'], context,
      `version: 0.3.0.dev0\nmetrics: []\nname: retail\ndatasets:\n` +
          dataset('orders', `        ai_context: &ctx\n          synonyms: [count]\n    metrics:\n      - name: n\n        expression: {sql: COUNT(id)}\n        ai_context: *ctx\n`),
    ],
    [
      'in version', 'v', ['description'], '0.3.0.dev0',
      `description: &v 0.3.0.dev0\nname: retail\nversion: *v\ndatasets:\n` + dataset('orders', ''),
    ],
  ] as const)('is written as the anchor\'s value when it sits %s', async (_, anchor, path, value, input) => {
    const res = await importSemanticModelYaml(input, {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(res.warnings).toContain(
        `Wrote the value of these anchors in place of each alias the conversion would put ` +
        `before its anchor, since YAML reads an alias only after its anchor: '${anchor}'.`);
    expect(path.reduce((v: any, k) => v[k], yaml.parse(res.files[0].content).semantic_model[0]))
        .toEqual(value);
  });

  test('is not reported when it sits only in a metric import removes', async () => {
    const res = await importSemanticModelYaml(
        `version: 0.3.0.dev0\nname: retail\ndatasets:\n` +
            dataset('orders', `    metrics:\n      - name: n\n        expression: {sql: COUNT(id)}\n        ai_context: &ctx {synonyms: [count]}\n`) +
            `metrics:\n  - name: r\n    expression: {sql: COUNT(*)}\n    ai_context: *ctx\n`,
        {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(res.warnings).toContain(
        `metric 'r': removed unanchored metric whose expression reaches no declared entity; add ` +
        `the metric back with an 'entity' anchor.`);
    expect(res.warnings.filter(w => w.includes('anchors'))).toEqual([]);
  });
});

describe('a model at the document root that import refuses', () => {
  const stringData = (m: any) => {
    m.custom_extensions = [{vendor_name: 'DBT', data: '{}'}];
  };
  test.each([
    ['0.3.0.dev0', '0.3.0.dev0', (_: any) => {}],
    ['0.2.0.dev0', '0.2.0.dev0', (_: any) => {}],
    ['0.3.0.dev0 with string custom_extensions', '0.3.0.dev0', stringData],
  ])('under --input first-party: a %s file', async (_, version, edit) => {
    const res = await importSemanticModelYaml(rootDoc(m => {
      m.version = version;
      edit(m);
    }), {flavor: 'ossie', strict: true});

    expect(res.errors).toEqual([
      `Document is a third-party Ossie file: its '${version}' model sits at ` +
      `the document root, which kcmd never writes. Import it in the default ` +
      `'--input third-party' mode.`,
    ]);
  });

  test('a 0.3.0.dev0 file with a semantic_model list', async () => {
    const res = await importSemanticModelYaml(
        wrapped(rootDoc(), '0.3.0.dev0'), {flavor: 'ossie'});

    expect(res.errors).toEqual([
      `Document is a '0.3.0.dev0' file with a 'semantic_model' list, which ` +
      `Apache Ossie's schema refuses: in '0.3.0.dev0' the model sits at the ` +
      `document root. Move the model's keys to the root in place of ` +
      `'semantic_model'.`,
    ]);
  });

  // Where an extension block may sit, as the refusal names it.
  const LEVELS: Array<[string, (m: any) => any]> = [
    ["model 'retail'", m => m],
    ["dataset 'orders'", m => m.datasets[0]],
    ["field 'orders.order_id'", m => m.datasets[0].fields[0]],
    ["relationship 'r'", m => (m.relationships = [{name: 'r'}])[0]],
    ["metric 'n'", m => (m.metrics = [{name: 'n'}])[0]],
    ["metric 'n' of dataset 'orders'", m => (m.datasets[0].metrics = [{name: 'n'}])[0]],
  ];
  test.each(LEVELS.flatMap(([label, at]) => ['custom_extensions', 'nonportable_extensions'].map(
      key => [label, key, at] as const)))(
      'a GOOGLE block on %s under %s', async (label, key, at) => {
        const res = await importSemanticModelYaml(rootDoc(m => {
          at(m)[key] = [{vendor_name: 'Google', data: {entity: 'orders'}}];
        }), {flavor: 'google'});

        expect(res.errors).toEqual([
          `Document holds a 'GOOGLE' block in '${key}' of ${label}. kcmd ` +
          `never writes a '0.3.0.dev0' file with the model at the document ` +
          `root, so the block was not written for kcmd; remove it.`,
        ]);
      });

  test('an object with both extension keys', async () => {
    const res = await importSemanticModelYaml(rootDoc(m => {
      m.datasets[0].custom_extensions = [{vendor_name: 'DBT', data: '{}'}];
      m.datasets[0].nonportable_extensions = [{vendor_name: 'DBT', data: {}}];
    }), {flavor: 'google'});

    expect(res.errors).toEqual([
      `dataset 'orders' has both 'custom_extensions' and ` +
      `'nonportable_extensions'; list its extension blocks under one.`,
    ]);
  });
});

describe('a model at the document root in other commands', () => {
  test.each([
    [
      '0.3.0.dev0',
      `Semantic model load error: unknown version '0.3.0.dev0'; expected ` +
          `'0.2.0.dev0' or '0.2.0.dev0/google'. Run 'kcmd import <file> ` +
          `--flavor <ossie|google>' to convert it.`,
    ],
    [
      '0.2.0.dev0',
      `Semantic model load error: the document: 'semantic_model' is ` +
          `missing; it takes a list\nthe document: unknown keys 'name' and ` +
          `'datasets'; it takes 'version' and 'semantic_model'\nRun 'kcmd ` +
          `import <file> --flavor <ossie|google>' to convert it.`,
    ],
  ])('a %s file is refused with advice to import it', async (version, error) => {
    await loadSqlEngine();
    const loaded = loadSemanticModels(
        [{name: 'retail', text: rootDoc(m => m.version = version)}]);

    expect(loaded.error).toBe(`Model document 'retail': ${error}`);
  });

  test.each([
    ['a kcmd file whose semantic_model is misspelled', (m: any) => {
      m.version = '0.2.0.dev0';
      m.semantic_models = [{name: m.name, datasets: m.datasets}];
      delete m.name;
      delete m.datasets;
    }],
    ['an Ossie ontology document', (m: any) => {
      m.ontology = {name: m.name};
      delete m.name;
      delete m.datasets;
    }],
  ])('%s is refused with no advice to import it', async (_, edit) => {
    await loadSqlEngine();
    const text = rootDoc(edit);
    const loaded = loadSemanticModels([{name: 'retail', text}]);
    const imported = await importSemanticModelYaml(text, {flavor: 'google'});

    expect(loaded.error).not.toContain('kcmd import');
    expect(imported.errors[0]).toStartWith('Semantic model load error: ');
    expect(imported.errors[0]).not.toContain('document root');
  });
});

describe('extension blocks of a model at the document root', () => {
  test('moves each block to custom_extensions with its data as JSON text', async () => {
    const input = `version: 0.3.0.dev0
name: retail
datasets:
  - name: orders
    source: ${TABLES}/orders
    fields:
      - name: order_id
        expression: {dialects: [{dialect: ANSI_SQL, expression: order_id}]}
        custom_extensions:
          - vendor_name: DBT
            data: {meta: kept}
    nonportable_extensions:  # the tables
      # ThoughtSpot's
      - vendor_name: THOUGHTSPOT
        data: '{"a": 1}'
relationships:
  - name: self
    from: orders
    to: orders
    from_columns: [order_id]
    to_columns: [order_id]
    nonportable_extensions: [{vendor_name: DBT, data: {b: 2}}]
metrics:
  - name: order_count
    expression: {dialects: [{dialect: ANSI_SQL, expression: COUNT(orders.order_id)}]}
    nonportable_extensions: [{vendor_name: DBT, data: {c: [3]}}]
nonportable_extensions:
  - vendor_name: SALESFORCE
    data:
      workbook: tpcds   # the dashboard
`;
    const res = await importSemanticModelYaml(input, {flavor: 'ossie'});

    expect(res.errors).toEqual([]);
    expect(res.warnings.filter(w => w.startsWith('Wrote these extension'))).toEqual([
      `Wrote these extension blocks under 'custom_extensions' with their ` +
          `data as JSON text, as '0.2.0.dev0' reads them, and dropped any ` +
          `comments inside the data: model 'retail' ('SALESFORCE'), field ` +
          `'orders.order_id' ('DBT'), relationship 'self' ('DBT'), metric ` +
          `'order_count' ('DBT').`,
      `Wrote these extension blocks under 'custom_extensions', as '0.2.0.dev0' ` +
          `reads them, and kept their data as written: dataset 'orders' ('THOUGHTSPOT').`,
    ]);
    expect(res.files[0].content).toBe(`version: 0.2.0.dev0
semantic_model:
  - name: retail
    datasets:
      - name: orders
        source: ${TABLES}/orders
        fields:
          - name: order_id
            expression: {dialects: [{dialect: ANSI_SQL, expression: order_id}]}
            custom_extensions:
              - vendor_name: DBT
                data: '{"meta":"kept"}'
        custom_extensions:  # the tables
          # ThoughtSpot's
          - vendor_name: THOUGHTSPOT
            data: '{"a": 1}'
    relationships:
      - name: self
        from: orders
        to: orders
        from_columns: [order_id]
        to_columns: [order_id]
        custom_extensions: [{vendor_name: DBT, data: '{"b":2}'}]
    metrics:
      - name: order_count
        expression: {dialects: [{dialect: ANSI_SQL, expression: COUNT(orders.order_id)}]}
        custom_extensions: [{vendor_name: DBT, data: '{"c":[3]}'}]
    custom_extensions:
      - vendor_name: SALESFORCE
        data: '{"workbook":"tpcds"}'
`);
  });

  test('names a metric a dataset declares with its dataset', async () => {
    const total = {name: 'total', expression: {sql: 'COUNT(*)'}, nonportable_extensions: [{vendor_name: 'V', data: {a: 1}}]};
    const res = await importSemanticModelYaml(rootDoc(m => {
      m.datasets.push({...m.datasets[0], name: 'customers', source: `${TABLES}/customers`});
      for (const ds of m.datasets) ds.metrics = [total];
    }), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(res.warnings).toContain(
        `Wrote these extension blocks under 'custom_extensions' with their ` +
        `data as JSON text, as '0.2.0.dev0/google' reads them, and dropped any ` +
        `comments inside the data: metric 'total' of dataset 'orders' ('V'), ` +
        `metric 'total' of dataset 'customers' ('V').`);
  });

  test('keeps the key order and the text of each number JSON writes as YAML does', async () => {
    const data = `{z: 1, a: {n: [1, {x: y}]}, big: 12345678901234567890, f: 1.50, ` +
        `e: 1e3, huge: 1e400, plus: +1, half: .5, oct: 010, hex: 0x1F, t: true, n: null, ` +
        `tilde: ~, empty: , date: 2024-01-01, ts: !!timestamp 2001-12-14, ` +
        `bin: !!binary R0lG, q: "it's", o: {}, 1: one, alias: &a {k: v}, again: *a}`;
    const res = await importSemanticModelYaml(
        rootDoc().replace(/^name: retail$/m, `name: retail\nnonportable_extensions: [{vendor_name: V, data: ${data}}]`),
        {flavor: 'ossie'});

    expect(res.errors).toEqual([]);
    expect(yaml.parse(res.files[0].content).semantic_model[0].custom_extensions[0].data).toBe(
        `{"z":1,"a":{"n":[1,{"x":"y"}]},"big":12345678901234567890,"f":1.50,` +
        `"e":1e3,"huge":1e400,"plus":1,"half":0.5,"oct":10,"hex":31,"t":true,"n":null,` +
        `"tilde":null,"empty":null,"date":"2024-01-01","ts":"2001-12-14",` +
        `"bin":"R0lG","q":"it's","o":{},"1":"one","alias":{"k":"v"},"again":{"k":"v"}}`);
  });

  test.each([
    ['a block', 'nonportable_extensions:\n          - &b {vendor_name: DBT, data: {meta: shared}}', 'nonportable_extensions: [*b]'],
    ['a list of blocks', 'nonportable_extensions: &l\n          - {vendor_name: DBT, data: {meta: shared}}', 'nonportable_extensions: *l'],
    ['a key of the data', 'nonportable_extensions: [{vendor_name: DBT, data: {&k meta: x}}]', 'nonportable_extensions: [{vendor_name: DBT, data: {*k : shared}}]'],
  ])('writes the data of %s written as an alias', async (_, first, second) => {
    const input = `version: 0.3.0.dev0
name: retail
datasets:
  - name: orders
    source: ${TABLES}/orders
    fields:
      - name: order_id
        expression: {sql: order_id}
        ${first}
      - name: customer_id
        expression: {sql: customer_id}
        ${second}
`;
    const res = await importSemanticModelYaml(input, {flavor: 'ossie'});

    expect(res.errors).toEqual([]);
    expect(yaml.parse(res.files[0].content).semantic_model[0].datasets[0].fields[1].custom_extensions)
        .toEqual([{vendor_name: 'DBT', data: '{"meta":"shared"}'}]);
  });

  test('stops on two keys of the data that JSON writes alike', async () => {
    const res = await importSemanticModelYaml(rootDoc().replace(
        /^name: retail$/m, `name: retail\nnonportable_extensions: [{vendor_name: V, data: {a: {1: x, "1": y}}}]`),
    {flavor: 'ossie'});

    expect(res.errors).toEqual([
      `model 'retail': the data of its 'V' extension block holds two keys that ` +
      `JSON writes as '1' in 'a', so JSON cannot tell them apart; rename one.`,
    ]);
  });

  test.each(['.inf', '-.inf', '.nan'])('stops on %s, which JSON cannot write', async value => {
    const res = await importSemanticModelYaml(rootDoc(m => {
      m.datasets[0].fields[0].nonportable_extensions = [{vendor_name: 'V', data: {a: [1, 'X']}}];
    }).replace("- X", `- ${value}`), {flavor: 'ossie'});

    expect(res.errors).toEqual([
      `field 'orders.order_id': the data of its 'V' extension block holds ` +
      `'${value}' at 'a[1]', which JSON cannot write; write it in quotes or ` +
      `remove it.`,
    ]);
  });
});

describe('expressions of a model at the document root', () => {
  const OSSIE = 'OSSIE_SQL_2026';
  test.each([
    ['sql alone', {sql: 'a'}, [[OSSIE, 'a']], undefined],
    [
      'sql and other dialects', {sql: 'a', dialects: [{dialect: 'BIGQUERY', expression: 'b'}, {dialect: 'SNOWFLAKE', expression: 'c'}]},
      [[OSSIE, 'a'], ['BIGQUERY', 'b'], ['SNOWFLAKE', 'c']], undefined,
    ],
    [
      'sql and an OSSIE_SQL_2026 entry', {sql: 'a', dialects: [{dialect: 'ossie_sql_2026', expression: 'c'}]},
      [[OSSIE, 'a']],
      `field 'orders.order_id': dropped its 'OSSIE_SQL_2026' dialects entry, since ` +
          `'sql' holds its 'OSSIE_SQL_2026' expression and takes precedence.`,
    ],
    [
      'sql and a dialect kcmd does not run', {sql: 'a', dialects: [{dialect: 'TRINO', expression: 't'}]},
      [[OSSIE, 'a']], `field 'orders.order_id': dropped unsupported dialect 'TRINO'.`,
    ],
    [
      'an OSSIE_SQL_2026 entry in lower case', {dialects: [{dialect: 'ossie_sql_2026', expression: 'a'}]},
      [[OSSIE, 'a']], `field 'orders.order_id': rewrote dialect 'ossie_sql_2026' to 'OSSIE_SQL_2026'.`,
    ],
  ])('reads %s', async (_, expression, dialects, warning) => {
    const res = await importSemanticModelYaml(
        rootDoc(m => m.datasets[0].fields[0].expression = expression), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(fieldDialects(res.files[0].content))
        .toEqual(dialects.map(([dialect, expression]) => ({dialect, expression})));
    if (warning) expect(res.warnings).toContain(warning);
  });

  test.each(['ossie', 'google'] as const)('writes a model with no optional keys with --flavor %s', async flavor => {
    const input = `version: 0.3.0.dev0\nname: retail\ndatasets:\n  - name: orders\n    source: ${TABLES}/orders\n    fields:\n      - name: order_id\n        expression:\n          # The portable form.\n          sql: order_id\n`;
    const res = await importSemanticModelYaml(input, {flavor});

    expect(res.errors).toEqual([]);
    expect(res.files[0].content).toBe(
        `version: 0.2.0.dev0${flavor === 'google' ? '/google' : ''}\nsemantic_model:\n  - name: retail\n    ` +
        `${flavor === 'google' ? 'entities' : 'datasets'}:\n      - name: orders\n        source: ${TABLES}/orders\n        ` +
        `fields:\n          - name: order_id\n            expression:\n              # The portable form.\n              ` +
        `dialects:\n                - dialect: OSSIE_SQL_2026\n                  expression: order_id\n`);
  });

  test('keeps the text of each sql value and the comments around it', async () => {
    const input = String.raw`version: 0.3.0.dev0
name: retail
datasets:
  - name: orders
    source: ${TABLES}/orders
    fields:
      - name: id
        expression:
          # above sql
          sql: 'order_id'   # single-quoted
      - name: label
        expression:
          sql: "CASE WHEN s = 'x' THEN \"Order Status\" END"  # double-quoted
      - name: tab
        expression: {sql: "CONCAT(a, '\t', b)"}   # flow
      - name: total
        expression:
          sql: |
            -- a SQL comment
            price *
              quantity
      - name: folded
        expression:
          sql: >-
            COALESCE(discount,
            0)
      - name: plain
        expression:
          sql:
            # between key and value
            price
            + tax
      - name: keep
        expression:
          sql: |+
            amount

      - name: both
        expression:
          # above sql
          sql: price   # sql
          dialects:   # dialects
            # above BigQuery
            - dialect: BIGQUERY
              expression: 'price'
            - dialect: ossie_sql_2026
              expression: PRICE
      - name: after
        expression:
          dialects: [{dialect: SNOWFLAKE, expression: price::number}]
          sql: >-
            price
`;
    const res = await importSemanticModelYaml(input, {flavor: 'ossie'});

    expect(res.errors).toEqual([]);
    expect(res.files[0].content).toBe(String.raw`version: 0.2.0.dev0
semantic_model:
  - name: retail
    datasets:
      - name: orders
        source: ${TABLES}/orders
        fields:
          - name: id
            expression:
              # above sql
              dialects:
                - dialect: OSSIE_SQL_2026
                  expression: 'order_id'   # single-quoted
          - name: label
            expression:
              dialects:
                - dialect: OSSIE_SQL_2026
                  expression: "CASE WHEN s = 'x' THEN \"Order Status\" END"  # double-quoted
          - name: tab
            expression: {dialects: [{dialect: OSSIE_SQL_2026, expression: "CONCAT(a, '\t', b)"}]}   # flow
          - name: total
            expression:
              dialects:
                - dialect: OSSIE_SQL_2026
                  expression: |
                    -- a SQL comment
                    price *
                      quantity
          - name: folded
            expression:
              dialects:
                - dialect: OSSIE_SQL_2026
                  expression: >-
                    COALESCE(discount,
                    0)
          - name: plain
            expression:
              dialects:
                - dialect: OSSIE_SQL_2026
                  expression:
                    # between key and value
                    price
                    + tax
          - name: keep
            expression:
              dialects:
                - dialect: OSSIE_SQL_2026
                  expression: |+
                    amount

          - name: both
            expression:
              dialects:   # dialects
                # above sql
                - dialect: OSSIE_SQL_2026
                  expression: price   # sql
                # above BigQuery
                - dialect: BIGQUERY
                  expression: 'price'
          - name: after
            expression:
              dialects:
                - dialect: OSSIE_SQL_2026
                  expression: >-
                    price
                - {dialect: SNOWFLAKE, expression: price::number}
`);
  });

  test('moves the sql of an expression shared through an anchor once, and keeps the alias', async () => {
    const res = await importSemanticModelYaml(`version: 0.3.0.dev0
name: retail
datasets:
  - name: orders
    source: ${TABLES}/orders
    fields:
      - name: id
        expression: &e {sql: order_id, dialects: [{dialect: OSSIE_SQL_2026, expression: OLD}]}
      - name: id_copy
        expression: *e
`, {flavor: 'ossie'});

    expect(res.errors).toEqual([]);
    expect(res.files[0].content).toBe(`version: 0.2.0.dev0
semantic_model:
  - name: retail
    datasets:
      - name: orders
        source: ${TABLES}/orders
        fields:
          - name: id
            expression: &e {dialects: [{dialect: OSSIE_SQL_2026, expression: order_id}]}
          - name: id_copy
            expression: *e
`);
  });

  test.each([
    ['a field', '\n      - &f {name: id, expression: {sql: order_id, dialects: [{dialect: OSSIE_SQL_2026, expression: OLD}]}}', '\n      - *f'],
    ['a list of fields', ' &f\n      - {name: id, expression: {sql: order_id, dialects: [{dialect: OSSIE_SQL_2026, expression: OLD}]}}', ' *f'],
  ])('moves the sql of %s shared through an anchor once, and names each place', async (_, anchored, alias) => {
    const dataset = (name: string, fields: string) => `  - name: ${name}\n    source: ${TABLES}/${name}\n    fields:${fields}\n`;
    const res = await importSemanticModelYaml(
        `version: 0.3.0.dev0\nname: retail\ndatasets:\n${dataset('orders', anchored)}${dataset('items', alias)}`,
        {flavor: 'ossie'});

    expect(res.errors).toEqual([]);
    expect(res.files[0].content).toEndWith(' *f\n');
    expect(loadModels(res.files[0].content).models[0].entities.map(e => e.fields[0].dialects)).toEqual(
        Array(2).fill([{dialect: 'OSSIE_SQL_2026', expression: 'order_id'}]));
    expect(res.warnings).toContain(
        `Wrote the 'sql' of these expressions as an 'OSSIE_SQL_2026' entry of 'dialects', as ` +
        `'0.2.0.dev0' reads it: field 'orders.id', field 'items.id'.`);
  });

  test.each([
    ['its expression', '&e {sql: SUM(amount)}', '*e', ['SUM(orders.amount)', 'SUM(returns.amount)']],
    [
      'its dialects list', '{dialects: &e [{dialect: OSSIE_SQL_2026, expression: SUM(amount)}]}', '{dialects: *e}',
      ['SUM(orders.amount)', 'SUM(returns.amount)'],
    ],
    ['its expression, which translates alike for both', '&e {sql: COUNT(*)}', '*e', ['COUNT(*)', 'COUNT(*)']],
  ])('gives each of two dataset metrics that share %s through an alias its own names and translation', async (_, anchored, alias, translations) => {
    const dataset = (name: string, metric: string, expression: string) =>
        `  - name: ${name}\n    source: ${TABLES}/${name}\n    fields:\n      - {name: amount, expression: {sql: amt}}\n` +
        `    metrics:\n      - name: ${metric}\n        expression: ${expression}\n`;
    const res = await importSemanticModelYaml(
        `version: 0.3.0.dev0\nname: retail\ndatasets:\n${dataset('orders', 'total', anchored)}${dataset('returns', 'refunds', alias)}`,
        {flavor: 'google', transpile: true});

    expect(res.errors).toEqual([]);
    expect(loadModels(res.files[0].content).models[0].metrics.map(m => m.dialects?.at(-1)?.expression)).toEqual(translations);
    const split = translations[0] !== translations[1];
    expect(res.files[0].content.includes(`expression: ${alias}`)).toBe(!split);
    expect(res.warnings.filter(w => w.includes('alias'))).toEqual(split ? [
      `metric 'refunds' of dataset 'returns': wrote its expression in place of alias '*e', which it ` +
          `shares with metric 'total' of dataset 'orders', since import rewrote the names in it ` +
          `differently for each.`,
    ] : []);
  });

  test('keeps the comment after a one-line flow list it writes as a block list on the key line only', async () => {
    const res = await importSemanticModelYaml(`version: 0.3.0.dev0
name: retail
datasets:
  - name: orders
    source: ${TABLES}/orders
    fields:
      - name: a
        expression:
          sql: price
          dialects: [{dialect: BIGQUERY, expression: price}]   # flow dialects
    metrics:
      - {name: t, expression: {sql: COUNT(*)}}
metrics: [{name: n, expression: {sql: COUNT(orders.a)}}]  # root list
`, {flavor: 'ossie'});

    expect(res.errors).toEqual([]);
    expect(res.files[0].content).toBe(`version: 0.2.0.dev0
semantic_model:
  - name: retail
    datasets:
      - name: orders
        source: ${TABLES}/orders
        fields:
          - name: a
            expression:
              dialects:   # flow dialects
                - dialect: OSSIE_SQL_2026
                  expression: price
                - {dialect: BIGQUERY, expression: price}
    metrics:  # root list
      - {name: n, expression: {dialects: [{dialect: OSSIE_SQL_2026, expression: COUNT(orders.a)}]}}
      - {name: t, expression: {dialects: [{dialect: OSSIE_SQL_2026, expression: COUNT(*)}]}, custom_extensions: [{vendor_name: GOOGLE, data: '{"entity":"orders"}'}]}
`);
  });

  test.each([
    ['blank', ''],
    ['only a comment', '-- none'],
    ['empty', null],
    ["only the qualifier 'orders.'", 'orders.'],
    ["only the qualifier '\"ORDERS\" .'", '"ORDERS" . -- none'],
  ])('stops on sql that is %s', async (what, sql) => {
    const res = await importSemanticModelYaml(
        rootDoc(m => m.datasets[0].fields[0].expression = {sql}), {flavor: 'google'});

    expect(res.errors).toEqual([
      `field 'orders.order_id': 'sql' in its expression is ${what}; write the ` +
      `expression's SQL there.`,
    ]);
  });

  test('writes as written sql that is only a quoted qualifier Ossie does not read as its dataset, as "Orders". on orders', async () => {
    const res = await importSemanticModelYaml(
        rootDoc(m => m.datasets[0].fields[0].expression = {sql: '"Orders".'}), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(fieldDialects(res.files[0].content)).toEqual([{dialect: 'OSSIE_SQL_2026', expression: '"Orders".'}]);
  });

  test('translates sql to BigQuery with --transpile, by the rules of OSSIE_SQL_2026', async () => {
    const res = await importSemanticModelYaml(rootDoc(m => {
      m.datasets[0].fields[0].expression = {sql: '"Order Total"'};
      m.datasets[0].fields.push({name: 'half', expression: {sql: 'AGG(order_id)'}});
    }), {flavor: 'google', transpile: true});

    expect(res.errors).toEqual([]);
    expect(fieldDialects(res.files[0].content)).toEqual([
      {dialect: OSSIE, expression: '"Order Total"'},
      {dialect: 'BIGQUERY', expression: '`Order Total`'},
    ]);
    expect(res.warnings).toContain(
        `field 'orders.half': could not transpile 'OSSIE_SQL_2026' -> 'BIGQUERY' ` +
        `(kcmd does not translate AGG, which Ossie reserves); left untranslated`);
  });

  test.each([
    [
      'a BigQuery table', `${TABLES}/orders`,
      `field 'orders.order_id': no 'BIGQUERY' or 'ANSI_SQL' dialect, so a ` +
          `BIGQUERY table cannot run its 'OSSIE_SQL_2026' expression; give it ` +
          `one, or add one with 'kcmd import <file> --flavor google --transpile'`,
    ],
    [
      'a Spanner table', 'spanner.googleapis.com/projects/acme/instances/i/databases/db/tables/orders',
      `field 'orders.order_id': no 'SPANNER', 'POSTGRES' or 'ANSI_SQL' ` +
          `dialect, so the Spanner table of entity 'orders' cannot run it`,
    ],
    [
      'a Cloud SQL table whose dialect import does not read', `${CLOUD_SQL_TABLES}/orders`,
      `field 'orders.order_id': no 'POSTGRES', 'SQLSERVER' or 'ANSI_SQL' ` +
          `dialect, so the Cloud SQL table of entity 'orders' cannot run it`,
    ],
  ])('names the OSSIE_SQL_2026 text a field on %s cannot run', async (_, source, warning) => {
    const res = await importSemanticModelYaml(rootDoc(m => {
      m.datasets[0].source = source;
      m.datasets[0].fields[0].expression = {sql: 'order_id'};
    }), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(res.warnings).toContain(warning);
  });

  test.each([
    ['reads two datasets', 'SUM(orders.order_id) / COUNT(CUSTOMERS.order_id)', 'reaches multiple entities (orders, customers)'],
  ])('removes an unanchored metric whose sql %s', async (_, sql, problem) => {
    const res = await importSemanticModelYaml(rootDoc(m => {
      m.datasets.push({...m.datasets[0], name: 'customers', source: `${TABLES}/customers`});
      m.metrics = [{name: 'ratio', expression: {sql}}];
    }), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(res.warnings).toContain(
        `metric 'ratio': removed unanchored metric whose expression ${problem}; add the metric ` +
        `back with an 'entity' anchor.`);
  });

  test('leaves as written an OSSIE_SQL_2026 text kcmd cannot parse, and says so', async () => {
    const res = await importSemanticModelYaml(rootDoc(m => {
      m.datasets[0].fields[0].expression = {sql: 'orders.order_id +'};
    }), {flavor: 'google', transpile: true});

    expect(fieldDialects(res.files[0].content)).toEqual([{dialect: OSSIE, expression: 'orders.order_id +'}]);
    expect(res.warnings).toContain(
        `field 'orders.order_id': kcmd cannot parse its 'OSSIE_SQL_2026' expression 'orders.order_id +', ` +
        `so import left its names as written, and --transpile does not translate it.`);
  });

  test('keeps an OSSIE_SQL_2026 entry of a semantic_model file and translates it', async () => {
    const res = await importSemanticModelYaml(
        wrapped(rootDoc(m => m.datasets[0].fields[0].expression = {
          dialects: [{dialect: OSSIE, expression: 'order_id'}, {dialect: 'SNOWFLAKE', expression: 'IFF(TRUE, order_id, 0)'}],
        }), '"0.2.0.dev0"'),
        {flavor: 'ossie', transpile: true});

    expect(res.errors).toEqual([]);
    expect(fieldDialects(res.files[0].content)).toEqual([
      {dialect: OSSIE, expression: 'order_id'},
      {dialect: 'SNOWFLAKE', expression: 'IFF(TRUE, order_id, 0)'},
      {dialect: 'BIGQUERY', expression: 'order_id'},
    ]);
  });
});

describe('names in a model at the document root', () => {
  // A model whose dataset `orders` has the fields `fields`, keyed on `keys`,
  // and dataset `customers`, keyed on its field `id`, which reads `c_id`.
  const keyed = (keys: string[], fields: any[]) => rootDoc(m => {
    m.datasets = [
      {name: 'orders', source: `${TABLES}/orders`, primary_key: keys, fields},
      {
        name: 'customers', source: `${TABLES}/customers`, primary_key: ['id'],
        fields: [{name: 'id', expression: {sql: 'c_id'}}],
      },
    ];
  });
  const field = (name: string, ...texts: Array<[string, string]>) => ({
    name,
    expression: {dialects: texts.map(([dialect, expression]) => ({dialect, expression}))},
  });

  test('rewrites the keys and join columns of renamed_fields.yaml to the columns their fields read', async () => {
    const res = await importSemanticModelYaml(
        example('renamed_fields.yaml'), {flavor: 'google', sourcePrefix: 'bigquery.googleapis.com/projects/sales'});

    expect(res.errors).toEqual([]);
    expect(res.warnings).toContain(
        `Rewrote each key and join column that names a field to the column ` +
        `the field reads: dataset 'orders': primary_key 'order_id' to ` +
        `'o_orderkey', dataset 'customers': primary_key 'id' to 'c_custkey', ` +
        `relationship 'orders_to_customers': from_columns 'customer_id' to ` +
        `'o_custkey', relationship 'orders_to_customers': to_columns 'id' to ` +
        `'c_custkey'.`);
    const model = loadModels(res.files[0].content).models[0];
    expect(model.entities.map(e => e.keys)).toEqual([['o_orderkey'], ['c_custkey']]);
    expect(model.relationships[0].source.columns).toEqual(['o_custkey']);
    expect(model.relationships[0].destination.columns).toEqual(['c_custkey']);
  });

  test.each([
    [
      'the column of its name, no field, and a field in another letter case', ['order_id', 'o_x', 'Amount'],
      [field('order_id', ['ANSI_SQL', 'order_id']), field('amount', ['ANSI_SQL', 'amt'])], ['order_id', 'o_x', 'amt'],
    ],
    ['a field that reads its own dataset qualified', ['order_id'], [field('order_id', ['ANSI_SQL', 'orders.o_id'])], ['o_id']],
    ['a field that reads a quoted column', ['order_id'], [field('order_id', ['OSSIE_SQL_2026', '"Order Key"'])], ['`Order Key`']],
    [
      'a field whose texts read the same column', ['order_id'],
      [field('order_id', ['OSSIE_SQL_2026', 'o_id'], ['BIGQUERY', '(o_id)'], ['TRINO', 'x + y'])], ['o_id'],
    ],
    [
      'a field whose texts write its column in other letter cases', ['order_id'],
      [field('order_id', ['OSSIE_SQL_2026', 'o_id'], ['SNOWFLAKE', 'O_ID'], ['BIGQUERY', '`O_Id`'])], ['o_id'],
    ],
    ['a field whose expression is a string', ['order_id'], [{name: 'order_id', expression: 'orders.o_id'}], ['o_id']],
    ['a field that reads a quoted column named as a function', ['order_id'], [field('order_id', ['OSSIE_SQL_2026', '"current_date"'])], ['current_date']],
    [
      'a field whose texts of two dialects name its column with and without quotes', ['order_id'],
      [field('order_id', ['OSSIE_SQL_2026', 'o_id'], ['POSTGRES', '"o_id"'])], ['o_id'],
    ],
    [
      'a field whose OSSIE_SQL_2026 text qualifies its column with its dataset in capitals', ['order_id'],
      [field('order_id', ['OSSIE_SQL_2026', 'ORDERS.o_id'], ['BIGQUERY', 'o_id'])], ['o_id'],
    ],
    ['a field that reads a quoted column named as a function, in parentheses', ['order_id'], [field('order_id', ['BIGQUERY', '(`current_date`)'])], ['current_date']],
    [
      'a field whose ANSI_SQL text quotes its column in another letter case, as a BigQuery table reads it', ['order_id'],
      [field('order_id', ['OSSIE_SQL_2026', 'o_id'], ['ANSI_SQL', '`O_Id`'])], ['o_id'],
    ],
    [
      'a field whose OSSIE_SQL_2026 text qualifies a column named as a function, as written', ['order_id'],
      [field('order_id', ['OSSIE_SQL_2026', 'orders.current_date'])], ['current_date'],
    ],
  ])('reads a key that names %s', async (_, keys, fields, columns) => {
    const res = await importSemanticModelYaml(keyed(keys, fields), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(loadModels(res.files[0].content).models[0].entities[0].keys).toEqual(columns);
  });

  const NO_COLUMN = 'kcmd keys and join columns name columns.';
  test.each([
    [
      'a computed field', 'primary_key', [field('order_id', ['ANSI_SQL', 'o_id + 1'])],
      `whose expression 'o_id + 1' is not a single column`,
    ],
    [
      'a field whose texts read two columns', 'primary_key', [field('order_id', ['ANSI_SQL', 'o_id'], ['BIGQUERY', 'id'])],
      `whose expressions 'o_id' and 'id' name different columns`,
    ],
    [
      'a field with no text kcmd runs', 'primary_key', [field('order_id', ['TRINO', 'o_id'])],
      'which has no expression in a dialect kcmd runs',
    ],
    [
      'a field whose BigQuery text is a struct path in backticks', 'primary_key', [field('order_id', ['BIGQUERY', '`orders.addr.city`'])],
      "whose expression '`orders.addr.city`' is not a single column",
    ],
    [
      'a field whose ANSI_SQL text double-quotes its column, which a BigQuery table reads as text', 'primary_key',
      [field('order_id', ['OSSIE_SQL_2026', 'o_id'], ['ANSI_SQL', '"O_Id"'])],
      `whose expressions 'o_id' and '"O_Id"' are not a single column`,
    ],
    [
      'a field whose texts name columns that only some pairs tell apart', 'primary_key',
      [field('order_id', ['BIGQUERY', 'tax'], ['POSTGRES', '"Tax"'], ['ALLOYDB', 'tax'])],
      `whose expressions 'tax' and '"Tax"' name different columns`,
    ],
    [
      'a field whose one text two dialects read as different columns', 'primary_key',
      [field('order_id', ['SNOWFLAKE', 'straße'], ['POSTGRES', 'straße'])],
      `whose expression 'straße' names different columns in SNOWFLAKE and POSTGRES`,
    ],
    [
      'a computed field', 'unique_keys[0]', [field('order_id', ['ANSI_SQL', 'o_id + 1'])],
      `whose expression 'o_id + 1' is not a single column`,
    ],
  ])('removes a key whose entry names %s, from %s', async (_, where, fields, why) => {
    const model = yaml.parse(keyed(['order_id', 'o_x'], fields));
    if (where !== 'primary_key') {
      model.datasets[0].unique_keys = [model.datasets[0].primary_key];
      delete model.datasets[0].primary_key;
    }
    const res = await importSemanticModelYaml(yaml.stringify(model), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(yaml.parse(res.files[0].content).semantic_model[0].entities[0]).not.toContainKey(where.replace('[0]', ''));
    expect(res.warnings).toContain(
        `dataset 'orders': removed ${where}, since its entry 'order_id' names field ` +
        `'orders.order_id', ${why}; ${NO_COLUMN}`);
  });

  test('removes a relationship that joins on a computed field, as an Ossie converter writes one', async () => {
    const res = await importSemanticModelYaml(rootDoc(m => {
      m.datasets[0].fields.push({name: 'created_date', expression: {dialects: [
        {dialect: 'BIGQUERY', expression: 'CAST(created_at AS DATE)'}]}});
      m.datasets.push({
        name: 'calendar', source: `${TABLES}/calendar`, primary_key: ['date'],
        fields: [{name: 'date', expression: {dialects: [{dialect: 'BIGQUERY', expression: 'date'}]}}],
      });
      m.relationships = [{
        name: 'orders_to_calendar', from: 'orders', to: 'calendar',
        from_columns: ['created_date'], to_columns: ['date'],
      }];
    }), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(loadModels(res.files[0].content).models[0].relationships).toEqual([]);
    expect(res.warnings).toContain(
        `relationship 'orders_to_calendar': removed, since its from_columns entry ` +
        `'created_date' names field 'orders.created_date', whose expression ` +
        `'CAST(created_at AS DATE)' is not a single column; ${NO_COLUMN}`);
  });

  test('removes a relationship whose to_columns cover no key once import removes one', async () => {
    const model = yaml.parse(keyed(['order_id'], [field('order_id', ['ANSI_SQL', 'o_id'])]));
    model.datasets[1].fields[0].expression.sql = 'c_id + 0';
    model.datasets[1].fields.push({name: 'code', expression: {sql: 'c_code'}});
    model.relationships = [{name: 'r', from: 'orders', to: 'customers', from_columns: ['order_id'], to_columns: ['code']}];
    const res = await importSemanticModelYaml(yaml.stringify(model), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(loadModels(res.files[0].content).models[0].relationships).toEqual([]);
    expect(res.warnings).toContain(
        `relationship 'r': removed, since its to_columns ["code"] cover no primary ` +
        `or unique key of dataset 'customers' once import removed a key of that ` +
        `dataset; push refuses such a relationship.`);
    expect(res.warnings.filter(w => w.startsWith('Rewrote'))).toEqual([
      `Rewrote each key and join column that names a field to the column the field reads: ` +
          `dataset 'orders': primary_key 'order_id' to 'o_id'.`,
    ]);
  });

  test.each([
    ['its dataset', 'orders.o_id', 'o_id'],
    ['its dataset quoted in capitals', '"ORDERS".o_id', 'o_id'],
    ['its dataset in another letter case, before a name Ossie reads as a function alone', 'ORDERS.current_date', '"CURRENT_DATE"'],
    ['a dataset the parser reserves', 'order.o_id', 'o_id'],
    [
      'its dataset beside a struct, source, a string and a comment',
      "orders.o_id || address.city || source.o_id || 'customers.x' -- customers.y",
      "o_id || address.city || source.o_id || 'customers.x' -- customers.y",
    ],
  ])('removes from an OSSIE_SQL_2026 field expression the qualifier that is %s', async (what, sql, written) => {
    const res = await importSemanticModelYaml(rootDoc(m => {
      if (what.includes('reserves')) m.datasets[0].name = 'order';
      m.datasets[0].fields[0].expression = {sql};
      m.datasets.push({name: 'customers', source: `${TABLES}/customers`});
    }), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(fieldDialects(res.files[0].content)).toEqual([{dialect: 'OSSIE_SQL_2026', expression: written}]);
  });

  test.each([
    ['the name of a dataset', 'item'],
    ['the name of its own dataset', 'orders'],
  ])('leaves a field expression whose subquery binds %s as written', async (_, alias) => {
    const sql = `(SELECT SUM(${alias}.price) FROM UNNEST(line_items) AS ${alias})`;
    const res = await importSemanticModelYaml(keyed(['o_id'], [field('total', ['BIGQUERY', sql])]).replace(
        'name: customers', 'name: item'), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(fieldDialects(res.files[0].content)).toEqual([{dialect: 'BIGQUERY', expression: sql}]);
  });

  test('leaves its own qualifier in a subquery with its own FROM, and says what to do', async () => {
    const sql = '(SELECT COUNT(*) FROM refunds AS r WHERE r.order_id = orders.o_id) + ' +
        '(SELECT SUM(i.price) FROM UNNEST(orders.items) AS i) + orders.o_id';
    const res = await importSemanticModelYaml(rootDoc(m => {
      m.datasets[0].fields[0].expression = {dialects: [{dialect: 'BIGQUERY', expression: sql}]};
    }), {flavor: 'google'});

    expect(fieldDialects(res.files[0].content)).toEqual([{
      dialect: 'BIGQUERY',
      expression: '(SELECT COUNT(*) FROM refunds AS r WHERE r.order_id = orders.o_id) + ' +
          '(SELECT SUM(i.price) FROM UNNEST(items) AS i) + o_id',
    }]);
    expect(res.warnings).toContain(
        `field 'orders.order_id': left 'orders.o_id' as written, since it sits in a subquery with ` +
        `its own FROM, where 'o_id' without the qualifier may read a column of the subquery's ` +
        `tables. kcmd reads a field's columns without a qualifier, so remove the qualifier if ` +
        `those tables have no column 'o_id', or else write the expression without the subquery.`);
  });

  test('leaves a qualifier in a subquery with its own FROM that names another dataset, and says what to do', async () => {
    const sql = '(SELECT COUNT(*) FROM customers WHERE customers.id > 0)';
    const res = await importSemanticModelYaml(keyed(['o_id'], [field('n', ['BIGQUERY', sql])]), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(fieldDialects(res.files[0].content)).toEqual([{dialect: 'BIGQUERY', expression: sql}]);
    expect(res.warnings).toContain(
        `field 'orders.n': left 'customers.id' as written, since it sits in a subquery with its ` +
        `own FROM, where 'customers' may name a table of that FROM. A field expression cannot ` +
        `read dataset 'customers', so give that table an alias and qualify the column with it.`);
  });

  test.each([
    ['BIGQUERY', 'orders.current_timestamp', '`current_timestamp`'],
    ['POSTGRES', 'orders.current_user', '"current_user"'],
    ['SNOWFLAKE', 'orders.current_date', '"CURRENT_DATE"'],
    ['ANSI_SQL', 'COALESCE(orders.current_date, orders."order")', 'COALESCE(`current_date`, `order`)'],
    ['OSSIE_SQL_2026', 'COALESCE(orders.current_date, sysdate)', 'COALESCE("CURRENT_DATE", "SYSDATE")'],
    ['OSSIE_SQL_2026', 'if + DATE_PART("ORDERS".week, orders.d)', '"IF" + DATE_PART("WEEK", d)'],
    ['SQLSERVER', 'DATEDIFF(orders.day, orders.a, orders.b)', 'DATEDIFF([day], a, b)'],
    ['OSSIE_SQL_2026', 'TIMESTAMPDIFF(hour, a, b) + TIMESTAMPADD(orders.day, 1, d)', 'TIMESTAMPDIFF(hour, a, b) + TIMESTAMPADD("DAY", 1, d)'],
  ])('writes the column of a %s text that reads as something else where it stands without its qualifier as its table reads the column: %s', async (dialect, expression, written) => {
    const res = await importSemanticModelYaml(rootDoc(m => {
      m.datasets[0].fields[0].expression = {dialects: [{dialect, expression}]};
    }), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(fieldDialects(res.files[0].content)).toEqual([{dialect, expression: written}]);
    if (dialect === 'BIGQUERY') {
      expect(res.warnings).toContain(
          `Rewrote these column names so that the text's dialect reads each as its column: field ` +
          `'orders.order_id' 'orders.current_timestamp' to '\`current_timestamp\`'.`);
    }
  });

  test('writes a column of an ANSI_SQL text as its table reads it, on a table --source-prefix completes', async () => {
    const res = await importSemanticModelYaml(rootDoc(m => {
      m.datasets[0].source = 'orders';
      m.datasets[0].fields[0].expression = {dialects: [{dialect: 'ANSI_SQL', expression: 'orders.current_date'}]};
    }), {flavor: 'google', sourcePrefix: 'bigquery.googleapis.com/projects/acme/datasets/sales'});

    expect(res.errors).toEqual([]);
    expect(fieldDialects(res.files[0].content)).toEqual([{dialect: 'ANSI_SQL', expression: '`current_date`'}]);
  });

  test.each([
    ['ANSI_SQL', 'customers.c_id', 'customers.c_id'],
    ['OSSIE_SQL_2026', '"CUSTOMERS".c_id', '"CUSTOMERS".c_id'],
    ['BIGQUERY', '(SELECT COUNT(*) FROM refunds AS r WHERE r.cid = customers.c_id)', 'customers.c_id'],
    ['BIGQUERY', '(WITH customers AS (SELECT customers.c_id FROM x) SELECT MAX(c_id) FROM customers)', 'customers.c_id'],
  ])('stops on a %s field expression that reads a column of another dataset: %s', async (dialect, text, read) => {
    const res = await importSemanticModelYaml(keyed(['id'], [field('id', [dialect, text])]), {flavor: 'google'});

    expect(res.errors).toEqual([
      `field 'orders.id': its expression reads '${read}', a column of ` +
      `another dataset; a field expression reads only the columns of its own ` +
      `dataset's source.`,
    ]);
  });

  // The report on the double-quoted words of ANSI_SQL texts on BigQuery
  // tables that import reads as names, with `items`.
  const doubleQuotes = (...items: string[]) =>
      `Read these double-quoted words in ANSI_SQL texts on BigQuery tables as names, as ANSI_SQL ` +
      `reads double quotes; BigQuery reads a double-quoted word as text: ${items.join(', ')}.`;

  test.each([
    ['a BigQuery table', TABLES, 'orders.amount', [doubleQuotes(`'"amount"' in metric 'n' of dataset 'orders' as field 'orders.amount'`)]],
    ['a table of no known dialect', CLOUD_SQL_TABLES, 'orders."amount"', []],
  ])('reads the double quotes of an ANSI_SQL text on %s as names, and leaves a field\'s unqualified names as written', async (_, tables, read, reported) => {
    const ansi = (expression: string) => ({dialects: [{dialect: 'ANSI_SQL', expression}]});
    const res = await importSemanticModelYaml(rootDoc(m => {
      m.datasets = ['orders', 'customers'].map(name => ({name, source: `${tables}/${name}`, fields: [
        {name: 'kind', expression: ansi('kind')}, {name: 'amount', expression: ansi('amt')},
        {name: 'is_customer', expression: ansi('CASE WHEN kind = "customers" THEN 1 END')},
      ]}));
      m.datasets[0].metrics = [{name: 'n', expression: ansi('COUNT(CASE WHEN kind = "amount" THEN 1 END)')}];
    }), {flavor: 'google'});

    const model = loadModels(res.files[0].content).models[0];
    expect(model.entities[0].fields[2].dialects?.[0].expression).toBe('CASE WHEN kind = "customers" THEN 1 END');
    expect(model.metrics[0].dialects?.[0].expression).toBe(`COUNT(CASE WHEN orders.kind = ${read} THEN 1 END)`);
    expect(res.warnings.filter(w => w.startsWith('Read these double-quoted'))).toEqual(reported);
  });

  test('leaves as written a column of an ANSI_SQL field text named like a dataset and written without a qualifier', async () => {
    const expression = 'COALESCE("customers", 0)';
    const res = await importSemanticModelYaml(rootDoc(m => {
      m.datasets[0].fields[0].expression = {dialects: [{dialect: 'ANSI_SQL', expression}]};
      m.datasets.push({name: 'customers', source: `${TABLES}/customers`, fields: [{name: 'id', expression: {sql: 'id'}}]});
    }), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(fieldDialects(res.files[0].content)).toEqual([{dialect: 'ANSI_SQL', expression}]);
  });

  test.each(['ossie', 'google'] as const)('with --transpile and --flavor %s, converts the double-quoted names of ANSI_SQL texts on a BigQuery table so that push accepts them', async flavor => {
    const ansi = (expression: string) => ({dialects: [{dialect: 'ANSI_SQL', expression}]});
    const res = await importSemanticModelYaml(rootDoc(m => {
      m.datasets[0].fields.push({name: 'amt', expression: ansi('"orders"."amount"')});
      m.datasets[0].metrics = [
        {name: 'total', expression: ansi('SUM("amt")')}, {name: 'raw_total', expression: ansi('SUM(source."amount")')},
      ];
    }), {flavor, transpile: true});

    expect(res.errors).toEqual([]);
    const model = loadModels(res.files[0].content).models[0];
    expect(model.entities[0].fields[1].dialects).toEqual([{dialect: 'ANSI_SQL', expression: 'amount'}]);
    expect(model.metrics.map(mt => mt.dialects)).toEqual(
        [0, 1].map(() => [{dialect: 'ANSI_SQL', expression: 'SUM(orders.amt)'}]));
    expect(res.warnings.filter(w => w.includes(' in model '))).toEqual([]);
    expect(res.warnings).toContain(doubleQuotes(
        `'"orders"."amount"' in field 'orders.amt' as column 'amount'`,
        `'"amt"' in metric 'total' of dataset 'orders' as field 'orders.amt'`,
        `'source."amount"' in metric 'raw_total' of dataset 'orders' as field 'orders.amt'`));
  });

  test('writes the names an OSSIE_SQL_2026 metric reads as declared, from any letter case and quoted capitals', async () => {
    const text = 'COUNT(ORDERS.Id) + COUNT("ORDERS"."ID") + COUNT("Customers".id)';
    const res = await importSemanticModelYaml(keyed(['id'], [field('id', ['ANSI_SQL', 'o_id'])]).replace(
        /$/, `metrics:\n  - name: m\n    expression:\n      dialects:\n        - {dialect: OSSIE_SQL_2026, expression: '${text}'}\n        - {dialect: BIGQUERY, expression: COUNT(orders.id)}\n`),
        {flavor: 'google'});

    expect(loadModels(res.files[0].content).models[0].metrics[0].dialects).toEqual([
      {dialect: 'OSSIE_SQL_2026', expression: 'COUNT(orders.id) + COUNT(orders.id) + COUNT("Customers".id)'},
      {dialect: 'BIGQUERY', expression: 'COUNT(orders.id)'},
    ]);
    expect(res.warnings).toContain(
        `Rewrote these dataset and field names that metrics read so that the text's dialect reads each ` +
        `as the dataset or field it names: metric 'm' 'ORDERS.Id' to 'orders.id', metric 'm' ` +
        `'"ORDERS"."ID"' to 'orders.id'.`);
  });
});

describe('metrics a dataset of a model at the document root declares', () => {
  // A model whose dataset `orders` has the fields `order_id`, which reads
  // `order_id`, and `amount`, which reads `amt`, and declares `metrics`.
  // `edit` changes it first.
  const declaring = (metrics: any[], edit: (m: any) => void = () => {}) => rootDoc(m => {
    m.datasets[0].fields.push({name: 'amount', expression: {sql: 'amt'}});
    m.datasets[0].metrics = metrics;
    edit(m);
  });
  const metric = (name: string, sql: string) => ({name, expression: {sql}});
  // The name, anchor and texts of each metric of the model `content` holds.
  const metrics = (content: string) => loadModels(content).models[0].metrics.map(
      ({name, entity, dialects}) => ({name, entity, dialects: dialects?.map(d => d.expression)}));
  const customers = (m: any) => m.datasets.push(
      {name: 'customers', source: `${TABLES}/customers`, fields: [{name: 'id', expression: {sql: 'id'}}]});

  test.each(['ossie', 'google'] as const)('moves them to the model, anchored on the dataset, with --flavor %s', async flavor => {
    const res = await importSemanticModelYaml(declaring([
      metric('total', 'SUM(amount) + COUNT(*)'),
      {name: 'both', expression: {dialects: [
        {dialect: 'OSSIE_SQL_2026', expression: 'SUM(AMOUNT)'}, {dialect: 'BIGQUERY', expression: 'SUM(amount)'}]}},
      metric('unknown', 'SUM(nope)'),
    ]), {flavor});

    expect(res.errors).toEqual([]);
    expect(metrics(res.files[0].content)).toEqual([
      {name: 'total', entity: 'orders', dialects: ['SUM(orders.amount) + COUNT(*)']},
      {name: 'both', entity: 'orders', dialects: ['SUM(orders.amount)', 'SUM(orders.amount)']},
      {name: 'unknown', entity: 'orders', dialects: ['SUM(nope)']},
    ]);
    expect(res.warnings).toContain(
        `Qualified with their dataset's name the field names these metrics read unqualified, ` +
        `since kcmd reads a metric's fields as '<dataset>.<field>': metric 'total' of dataset 'orders', ` +
        `metric 'both' of dataset 'orders'.`);
  });

  test('keeps their text and the comments around them', async () => {
    const input = `version: 0.3.0.dev0
name: retail
datasets:
  - name: orders
    source: ${TABLES}/orders
    fields:
      - {name: amount, expression: {dialects: [{dialect: ANSI_SQL, expression: amt}]}}

    # The dataset's own metrics.
    metrics:
      # Its revenue.
      - name: revenue
        expression:
          dialects:
            - dialect: ANSI_SQL
              expression: |-
                SUM(amount)
        ai_context: {synonyms: [sales]}  # what people say
        nonportable_extensions: [{vendor_name: DBT, data: {a: 1}}]
# The model's metrics.
metrics:
  - name: amount_count
    expression: {dialects: [{dialect: ANSI_SQL, expression: COUNT(orders.amount)}]}
`;
    const res = await importSemanticModelYaml(input, {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(res.files[0].content).toBe(`version: 0.2.0.dev0/google
semantic_model:
  - name: retail
    entities:
      - name: orders
        source: ${TABLES}/orders
        fields:
          - {name: amount, expression: {dialects: [{dialect: ANSI_SQL, expression: amt}]}}
    # The model's metrics.
    metrics:
      - name: amount_count
        expression: {dialects: [{dialect: ANSI_SQL, expression: COUNT(orders.amount)}]}

      # The dataset's own metrics.
      # Its revenue.
      - name: revenue
        entity: orders
        expression:
          dialects:
            - dialect: ANSI_SQL
              expression: |-
                SUM(orders.amount)
        ai_context: {synonyms: [sales]}  # what people say
        custom_extensions: [{vendor_name: DBT, data: '{"a":1}'}]
`);
  });

  test('moves metrics written in any style by their text, with the comments around them', async () => {
    const input = `version: 0.3.0.dev0
name: retail
datasets:
  - name: orders
    source: ${TABLES}/orders
    fields:
      - {name: amount, expression: {sql: amt}}
    metrics: [  # the flow list
      {name: total, expression: {sql: SUM(amount)}},  # total
      # above count
      {name: cnt, expression: {sql: COUNT(*)}}
    ]
  - metrics:   # the items' metrics
      # above q
      - name: q   # q
        expression: {sql: SUM(qty)}
    name: items
    source: ${TABLES}/items
    fields:
      - {name: qty, expression: {sql: qty}}
  - name: returns
    source: ${TABLES}/returns
    fields:
      - {name: id, expression: {sql: id}}
    metrics: []
metrics: []  # the model's
`;
    const res = await importSemanticModelYaml(input, {flavor: 'ossie'});

    expect(res.errors).toEqual([]);
    const data = (ds: string) => `[{vendor_name: GOOGLE, data: '{"entity":"${ds}"}'}]`;
    expect(res.files[0].content).toBe(`version: 0.2.0.dev0
semantic_model:
  - name: retail
    datasets:
      - name: orders
        source: ${TABLES}/orders
        fields:
          - {name: amount, expression: {dialects: [{dialect: OSSIE_SQL_2026, expression: amt}]}}
      - name: items
        source: ${TABLES}/items
        fields:
          - {name: qty, expression: {dialects: [{dialect: OSSIE_SQL_2026, expression: qty}]}}
      - name: returns
        source: ${TABLES}/returns
        fields:
          - {name: id, expression: {dialects: [{dialect: OSSIE_SQL_2026, expression: id}]}}
    metrics:  # the model's
      # the flow list
      - {name: total, expression: {dialects: [{dialect: OSSIE_SQL_2026, expression: SUM(orders.amount)}]}, custom_extensions: ${data('orders')}}  # total
      # above count
      - {name: cnt, expression: {dialects: [{dialect: OSSIE_SQL_2026, expression: COUNT(*)}]}, custom_extensions: ${data('orders')}}
      # the items' metrics
      # above q
      - name: q   # q
        expression: {dialects: [{dialect: OSSIE_SQL_2026, expression: SUM(items.qty)}]}
        custom_extensions:
          - vendor_name: GOOGLE
            data: '{"entity":"items"}'
`);
    expect(res.warnings).toContain(
        `Removed the empty 'metrics' list of these datasets, since kcmd lists metrics only on the ` +
        `model: dataset 'returns'.`);
  });

  test.each([
    ['a list with no metric', ['x', null], `removed its 'metrics', since no entry of it is a metric.`],
    ['a mapping', {}, `removed its 'metrics', since it is not a list of metrics.`],
    ['a list with entries that are not metrics', ['x', metric('n', 'COUNT(*)'), 3], `removed entries 1 and 3 of its 'metrics', since they are not metrics.`],
  ])('says what it removes when metrics holds %s', async (_, value, removal) => {
    const res = await importSemanticModelYaml(declaring(value as any[]), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(res.warnings).toContain(`dataset 'orders': ${removal}`);
    expect(res.warnings.filter(w => w.includes('empty'))).toEqual([]);
  });

  const sourceDataset = (m: any) => m.datasets.push(
      {name: 'source', source: `${TABLES}/src`, fields: [{name: 'amt', expression: {sql: 'amt'}}]});
  // The name and texts of each field of dataset 'orders' after the two that
  // `declaring` gives it, in the model `content` holds.
  const addedFields = (content: string) => loadModels(content).models[0].entities[0].fields.slice(2)
      .map(f => [f.name, ...(f.dialects ?? []).map(d => d.expression)]);
  test.each([
    ['a field reads', 'SUM(source.amt)', 'SUM(orders.amount)', [], [], undefined],
    ['a field reads, written in capitals', 'SUM(SOURCE.amt)', 'SUM(orders.amount)', [], [], undefined],
    ['no field reads', 'SUM(source."Unit Tax")', 'SUM(orders.Unit_Tax)', [], [['Unit_Tax', '"Unit Tax"']], undefined],
    ['no field reads, named as a field is', 'SUM(source.amount)', 'SUM(orders.source_amount)', [], [['source_amount', 'amount']], undefined],
    [
      'no field reads, named as metrics are', 'SUM(source.tally)', 'SUM(orders.source_tally_2)',
      [metric('tally', 'COUNT(*)'), metric('source_tally', 'COUNT(*)')], [['source_tally_2', 'tally']], undefined,
    ],
    [
      'a column is named source', 'COUNT(DISTINCT source.source) + SUM(source.amt)',
      'COUNT(DISTINCT orders.source_source) + SUM(orders.amount)', [], [['source_source', 'source']], undefined,
    ],
    ['a dataset is named source', 'SUM(source.amt)', 'SUM(orders.amount)', [], [], sourceDataset],
    [
      'a field reads it in an ANSI_SQL text, which its BigQuery table reads in any letter case', 'SUM(source."Order_Id")',
      'SUM(orders.order_id)', [], [], undefined,
    ],
    [
      'a field reads the name unquoted, which Ossie tells apart from it quoted in lower case', 'SUM(source."cost")',
      'SUM(orders.cost)', [], [['levy', 'COST'], ['cost', '"cost"']],
      (m: any) => m.datasets[0].fields.push({name: 'levy', expression: {sql: 'COST'}}),
    ],
    [
      'a field is named Source, which Ossie tells apart from "source"', 'SUM("source".raw_col)', 'SUM(orders.raw_col)', [],
      [['Source', 'src'], ['raw_col', 'raw_col']], (m: any) => m.datasets[0].fields.push({name: 'Source', expression: {sql: 'src'}}),
    ],
  ])('writes an OSSIE_SQL_2026 source.column as the field that reads the column, added only when none reads it, when %s', async (_, sql, written, others, added, edit) => {
    const res = await importSemanticModelYaml(declaring([metric('total', sql), ...others], edit), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(metrics(res.files[0].content)[0].dialects).toEqual([written]);
    expect(addedFields(res.files[0].content)).toEqual(added);
  });

  test.each([
    ['OSSIE_SQL_2026', 'MAX(source.current_date)', 'MAX(orders."current_date")', ['current_date', '"CURRENT_DATE"']],
    ['BIGQUERY', 'MAX(source.current_timestamp)', 'MAX(orders.current_timestamp)', ['current_timestamp', '`current_timestamp`']],
  ])('writes the %s text of a field import adds for a column named as a function so that it reads the column', async (dialect, expression, written, added) => {
    const res = await importSemanticModelYaml(declaring([{name: 'last', expression: {dialects: [{dialect, expression}]}}]), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(metrics(res.files[0].content)[0].dialects).toEqual([written]);
    expect(addedFields(res.files[0].content)).toEqual([added]);
  });

  test.each([
    ['POSTGRES', 'SUM(source."Tax")', ['POSTGRES'], 'Tax'],
    ['SNOWFLAKE', 'SUM(source."tax")', ['SNOWFLAKE'], 'tax'],
    ['POSTGRES', 'SUM(source."Tax")', ['BIGQUERY', 'POSTGRES'], 'Tax'],
  ])('adds a field for a quoted %s column that a field reading the name unquoted does not read: %s, the field in %p', async (dialect, sql, levy, name) => {
    const res = await importSemanticModelYaml(declaring([{name: 'total', expression: {dialects: [{dialect, expression: sql}]}}], m => {
      m.datasets[0].fields.push({name: 'levy', expression: {dialects: levy.map(d => ({dialect: d, expression: 'tax'}))}});
    }), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(metrics(res.files[0].content)[0].dialects).toEqual([`SUM(orders.${name})`]);
  });

  test.each([
    ['date', "SUM(CASE WHEN CAST(created_at AS DATE) > DATE '2024-01-01' THEN amount END)",
      "SUM(CASE WHEN CAST(orders.created_at AS DATE) > DATE '2024-01-01' THEN orders.amount END)"],
    ['desc', 'RANK() OVER (ORDER BY SUM(amount) DESC)', 'RANK() OVER (ORDER BY SUM(orders.amount) DESC)'],
    ['end', 'SUM(CASE WHEN amount > 0 THEN amount END)', 'SUM(CASE WHEN orders.amount > 0 THEN orders.amount END)'],
    ['day', 'SUM(DATEDIFF(day, created_at, shipped_at))', 'SUM(DATEDIFF(day, orders.created_at, orders.shipped_at))'],
  ])('qualifies the names a metric reads when a field is named %s, and not the keyword', async (keyword, sql, written) => {
    const res = await importSemanticModelYaml(declaring([{name: 'total', expression: sql}], m => m.datasets[0].fields.push(
        ...[keyword, 'created_at', 'shipped_at'].map(name => ({name, expression: {sql: `c_${name}`}})))),
    {flavor: 'google'});

    expect(metrics(res.files[0].content)[0].dialects).toEqual([written]);
  });

  test.each(['date', 'Time', 'timestamp', 'interval'])('qualifies the names a metric reads in quotes when its dataset is named %s', async name => {
    const res = await importSemanticModelYaml(
        declaring([{name: 'total', expression: 'SUM(amount) + SUM(source.amt)'}], m => m.datasets[0].name = name),
        {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(metrics(res.files[0].content)[0].dialects).toEqual([`SUM(\`${name}\`.amount) + SUM(\`${name}\`.amount)`]);
    expect(res.warnings).toContain(
        `Rewrote these dataset and field names that metrics read so that the text's dialect reads each ` +
        `as the dataset or field it names: metric 'total' of dataset '${name}' 'amount' to ` +
        `'\`${name}\`.amount', metric 'total' of dataset '${name}' 'source.amt' to '\`${name}\`.amount'.`);
  });

  test.each([
    ['SNOWFLAKE', 'ORDERS.amt', 'SUM(ORDERS.AMOUNT)', 'amt', 'SUM(orders.amount)'],
    ['SNOWFLAKE', '"ORDERS".amt', 'SUM("orders".Amount)', 'amt', 'SUM("orders".amount)'],
    ['BIGQUERY', '`Orders`.amt', 'SUM(Orders.Amount)', 'amt', 'SUM(orders.amount)'],
    ['ANSI_SQL', 'Orders.amt', 'SUM(AMOUNT)', 'amt', 'SUM(orders.amount)'],
    ['POSTGRES', 'ORDERS.amt', 'SUM(Amount)', 'amt', 'SUM(orders.amount)'],
    ['POSTGRES', '"ORDERS".amt', 'SUM("ORDERS".amount)', '"ORDERS".amt', 'SUM("ORDERS".amount)'],
  ])('in a %s text, reads a dataset or field name as its database does: field %s, metric %s', async (dialect, read, sql, field, written) => {
    const text = (expression: string) => ({dialects: [{dialect, expression}]});
    const res = await importSemanticModelYaml(declaring([{name: 'total', expression: text(sql)}], m => {
      m.datasets[0].fields[1].expression = text(read);
    }), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(loadModels(res.files[0].content).models[0].entities[0].fields[1].dialects?.[0].expression).toBe(field);
    expect(metrics(res.files[0].content)[0].dialects).toEqual([written]);
  });

  test.each([
    [
      'in quotes the reserved name an added field takes from a metric import removes', {sql: 'SUM(source.order)'},
      (m: any) => m.metrics = [{name: 'order', expression: {dialects: [{dialect: 'THOUGHTSPOT', expression: '[x]'}]}}],
      'source.order', 'orders."order"',
    ],
  ])('writes %s, and reports it', async (_, expression, edit, before, after) => {
    const res = await importSemanticModelYaml(declaring([{name: 'total', expression}], edit), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(metrics(res.files[0].content)[0].dialects).toEqual([`SUM(${after})`]);
    expect(res.warnings.filter(w => w.startsWith('Rewrote these dataset'))).toEqual([
      `Rewrote these dataset and field names that metrics read so that the text's dialect reads each ` +
          `as the dataset or field it names: metric 'total' of dataset 'orders' '${before}' to '${after}'.`,
    ]);
  });

  test('keeps the first name of an added field when it cannot rewrite a metric that reads it, and says so', async () => {
    const res = await importSemanticModelYaml(declaring([
      metric('total', 'SUM(source.tax) + SUM(select)'), metric('other', 'MAX(source.tax)'),
    ], m => {
      m.metrics = [{name: 'tax', expression: {dialects: [{dialect: 'THOUGHTSPOT', expression: '[x]'}]}}];
    }), {flavor: 'google'});

    expect(metrics(res.files[0].content).map(m => m.dialects))
        .toEqual([['SUM(orders.source_tax) + SUM(select)'], ['MAX(orders.source_tax)']]);
    expect(addedFields(res.files[0].content)).toEqual([['source_tax', 'tax']]);
    expect(res.warnings.filter(w => w.includes('kept the name'))).toEqual([
      `dataset 'orders': kept the name 'source_tax' for the field import added, since it could not ` +
      `rewrite metric 'total' of dataset 'orders', which reads it.`]);
  });

  test('reads a key as the fields are written, before a metric adds one', async () => {
    const res = await importSemanticModelYaml(declaring([metric('n', 'SUM(source."Unit Tax")')], m => {
      m.datasets[0].primary_key = ['unit_tax'];
    }), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(loadModels(res.files[0].content).models[0].entities[0].keys).toEqual(['unit_tax']);
  });

  test('gives an added field an entry for each text that names its column, in any letter case', async () => {
    const res = await importSemanticModelYaml(declaring([{name: 'total', expression: {dialects: [
      {dialect: 'OSSIE_SQL_2026', expression: 'SUM(source.Tax)'}, {dialect: 'BIGQUERY', expression: 'SUM(source.TAX)'}]}}]),
    {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(loadModels(res.files[0].content).models[0].entities[0].fields.find(f => f.name === 'Tax')?.dialects).toEqual([
      {dialect: 'OSSIE_SQL_2026', expression: 'Tax'}, {dialect: 'BIGQUERY', expression: 'TAX'},
    ]);
  });

  test('stops when the field import would add for source.column breaks the name rule', async () => {
    const res = await importSemanticModelYaml(declaring([metric('total', `SUM(source.${'c'.repeat(301)})`)]), {flavor: 'google'});

    expect(res.errors).toEqual([
      `metric 'total' of dataset 'orders' reads a column of dataset 'orders' ` +
      `that no field reads, and the name of the field import would add for it ` +
      `breaks the name rule: Field name 'cccccccccccccccccccccccccccccccccccccccc...' ` +
      `is 301 characters long; names may be at most 300 characters. Add a ` +
      `field that reads the column, and name it in the metric.`,
    ]);
  });

  test.each(['OSSIE_SQL_2026', 'BIGQUERY'])('leaves a %s source.column as written, and adds no field, when the dataset has a field named source', async dialect => {
    const res = await importSemanticModelYaml(declaring([{name: 'total', expression: {dialects: [{dialect, expression: 'SUM(source.tax)'}]}}], m => {
      m.datasets[0].fields.push({name: 'source', expression: {sql: 'src'}});
    }), {flavor: 'google'});

    expect(metrics(res.files[0].content)[0].dialects).toEqual(['SUM(source.tax)']);
    expect(addedFields(res.files[0].content)).toEqual([['source', 'src']]);
  });

  test.each(['OSSIE_SQL_2026', 'POSTGRES'])('reads "Source" in a %s metric as the dataset of that name, and not as the source', async dialect => {
    const res = await importSemanticModelYaml(declaring([{name: 'n', expression: {dialects: [{dialect, expression: 'COUNT("Source".id)'}]}}], m => {
      m.datasets.push({name: 'Source', source: `${TABLES}/src`, fields: [{name: 'id', expression: {sql: 'id'}}]});
    }), {flavor: 'google'});

    expect(metrics(res.files[0].content)[0].dialects).toEqual(['COUNT("Source".id)']);
  });

  test('leaves a source.column as written, and adds no field, when the dataset inherits a field named source', async () => {
    const res = await importSemanticModelYaml(declaring([{name: 'total', expression: {dialects: [{dialect: 'BIGQUERY', expression: 'SUM(source.tax)'}]}}], m => {
      m.datasets.push({name: 'parent', source: `${TABLES}/parent`, fields: [{name: 'source', expression: {sql: 'src'}}]});
      m.datasets[0].extends = ['parent'];
    }), {flavor: 'google'});

    expect(metrics(res.files[0].content)[0].dialects).toEqual(['SUM(source.tax)']);
    expect(addedFields(res.files[0].content)).toEqual([]);
  });

  test('writes an added field\'s vendor label as ALLOYDB on an AlloyDB table, as for the metric', async () => {
    const res = await importSemanticModelYaml(declaring([
      {name: 'total', expression: {dialects: [{dialect: 'PostgreSQL', expression: 'SUM(source.tax)'}]}},
    ], m => m.datasets[0].source = 'orders'), {flavor: 'google', sourcePrefix: `${ALLOYDB_DB}/schemas/public`});

    expect(res.errors).toEqual([]);
    const model = loadModels(res.files[0].content).models[0];
    expect([model.entities[0].fields.find(f => f.name === 'tax')?.dialects, model.metrics[0].dialects]).toEqual([
      [{dialect: 'ALLOYDB', expression: 'tax'}],
      [{dialect: 'ALLOYDB', expression: 'SUM(orders.tax)'}],
    ]);
  });

  test('names an added field as import writes it when it reports the dialect its vendor label names', async () => {
    const res = await importSemanticModelYaml(declaring([
      {name: 'gone_reader', expression: {dialects: [{dialect: 'ALLOYDB', expression: 'SUM(source.Tax) + SUM(gone)'}]}},
      {name: 'kept', expression: {dialects: [{dialect: 'PostgreSQL', expression: 'SUM(source.tax)'}]}},
    ], m => {
      m.datasets[0].source = 'orders';
      m.datasets[0].fields.push({name: 'gone', expression: {dialects: [{dialect: 'THOUGHTSPOT', expression: '[x]'}]}});
    }), {flavor: 'ossie', sourcePrefix: `${ALLOYDB_DB}/schemas/public`});

    expect(res.errors).toEqual([]);
    expect(res.warnings.filter(w => w.startsWith('field ') && w.includes('rewrote dialect'))).toEqual([
      `field 'orders.tax': rewrote dialect 'PostgreSQL' to 'ALLOYDB'.`,
    ]);
  });

  test.each([
    ['another dataset has a metric of its name', customers, (m: any) => m.datasets[1].metrics = [metric('total', 'COUNT(id)')], 'customers_total'],
    ['the model has a metric of its name', () => {}, (m: any) => m.metrics = [metric('TOTAL', 'COUNT(orders.order_id)')], 'orders_total'],
    ['a field of the dataset has its name', () => {}, (m: any) => m.datasets[0].fields.push({name: 'Total', expression: {sql: 't'}}), 'orders_total'],
    [
      'its new name is taken too', () => {},
      (m: any) => m.metrics = [metric('total', 'COUNT(orders.order_id)'), metric('orders_total', 'COUNT(orders.order_id)')],
      'orders_total_2',
    ],
  ])('renames a metric when %s', async (_, before, edit, name) => {
    const res = await importSemanticModelYaml(declaring([metric('total', 'SUM(amount)')], m => {
      before(m);
      edit(m);
    }), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    const dataset = name.startsWith('customers') ? 'customers' : 'orders';
    expect(res.warnings).toContain(
        `metric 'total' of dataset '${dataset}': renamed to '${name}', since ` +
        `another metric or a field of dataset '${dataset}' has its name.`);
  });

  test('keeps the name of a metric whose namesake import removes, and reports nothing of that one', async () => {
    const res = await importSemanticModelYaml(declaring([metric('revenue', 'SUM(amount)')], m => {
      customers(m);
      m.metrics = [metric('revenue', 'SUM(ORDERS.amount) / COUNT(DISTINCT customers.id)')];
    }), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(metrics(res.files[0].content).map(m => m.name)).toEqual(['revenue']);
    expect(res.warnings.filter(w => /renamed|letter case|'sql'/.test(w))).toEqual([
      `Wrote the 'sql' of these expressions as an 'OSSIE_SQL_2026' entry of 'dialects', as ` +
          `'0.2.0.dev0/google' reads it: field 'orders.amount', field 'customers.id', metric ` +
          `'revenue' of dataset 'orders'.`,
    ]);
    expect(res.warnings).toContain(
        `metric 'revenue': removed unanchored metric whose expression reaches multiple entities ` +
        `(orders, customers); add the metric back under a name no other metric or field of its ` +
        `entity has, with an ` +
        `'entity' anchor.`);
  });

  test.each([
    ['a dataset metric import renames to it', 'orders_revenue', (m: any) => m.metrics.unshift(metric('revenue', 'COUNT(orders.order_id)'))],
    ['a field of the dataset it reads', 'amount', () => {}],
  ])('says to add a removed metric back under a free name when %s has its name', async (_, name, edit) => {
    const res = await importSemanticModelYaml(declaring([metric('revenue', 'SUM(amount)')], m => {
      m.metrics = [{name, expression: {dialects: [{dialect: 'THOUGHTSPOT', expression: 'sum([amt])'}]}}];
      edit(m);
    }), {flavor: 'google'});

    expect(res.errors).toEqual([]);
    expect(res.warnings).toContain(
        `metric '${name}': removed metric whose expression is written only in unsupported dialect ` +
        `'THOUGHTSPOT'; add the metric back under a name no other metric or field of its entity ` +
        `has, with an entry in a supported SQL dialect.`);
  });

  test('reports no edit of a metric or an added field that import then removes', async () => {
    const res = await importSemanticModelYaml(declaring([
      {name: 'ts_only', expression: {dialects: [{dialect: 'THOUGHTSPOT', expression: 'sum([amt])'}]}},
      metric('reads_gone', 'SUM(source.amt) + SUM(source.tax) + SUM(gone)'),
      metric('kept', 'SUM(amount)'),
    ], m => m.datasets[0].fields.push({name: 'gone', expression: {dialects: [{dialect: 'THOUGHTSPOT', expression: '[x]'}]}})),
    {flavor: 'ossie'});

    expect(res.errors).toEqual([]);
    expect(loadModels(res.files[0].content).models[0].entities[0].fields.map(f => f.name)).toEqual(['order_id', 'amount']);
    expect(res.warnings.filter(w => /^(Moved the metrics|Wrote each|dataset 'orders': added)/.test(w))).toEqual([
      `Moved the metrics of these datasets to the model's 'metrics', each anchored on its dataset: ` +
          `dataset 'orders' ('kept').`,
    ]);
  });

  test('lists only the metrics a dataset declares, and names a root metric as one, when an alias repeats the dataset', async () => {
    const res = await importSemanticModelYaml(`version: 0.3.0.dev0
name: retail
datasets:
  - &d
    name: orders
    source: ${TABLES}/orders
    fields:
      - {name: id, expression: {sql: id}}
    metrics:
      - {name: n, expression: {sql: COUNT(id)}}
  - *d
metrics:
  - {name: r, expression: {sql: COUNT(orders.id)}}
`, {flavor: 'google'});

    expect(res.errors).toEqual([`model 'retail': duplicate entity name 'orders'; names must be unique.`]);
    expect(res.warnings).toContain(
        `Moved the metrics of these datasets to the model's 'metrics', each anchored on its dataset: ` +
        `dataset 'orders' ('n').`);
    expect(res.warnings).toContain(
        `Wrote the 'sql' of these expressions as an 'OSSIE_SQL_2026' entry of 'dialects', as ` +
        `'0.2.0.dev0/google' reads it: field 'orders.id', metric 'r', metric 'n' of dataset 'orders'.`);
  });

  test.each([
    ['a BigQuery table', 'SNOWFLAKE', 'BIGQUERY', undefined],
    ['an AlloyDB table', 'PostgreSQL', 'ALLOYDB', `${ALLOYDB_DB}/schemas/public`],
  ] as const)('gives an added field on %s no entry or letter case of a metric import removes', async (_, removed, dialect, sourcePrefix) => {
    const texts = (label: string, expression: string) => ({expression: {dialects: [{dialect: label, expression}]}});
    const res = await importSemanticModelYaml(declaring([
      {name: 'gone_reader', ...texts(removed, 'SUM(source.TAX) + SUM(gone)')},
      {name: 'kept', ...texts(dialect, 'SUM(source.tax)')},
    ], m => {
      m.datasets[0].fields.push({name: 'gone', ...texts('THOUGHTSPOT', '[x]')});
      if (sourcePrefix) m.datasets[0].source = 'orders';
    }), {flavor: 'ossie', sourcePrefix});

    expect(res.errors).toEqual([]);
    const model = loadModels(res.files[0].content).models[0];
    const added = model.entities[0].fields.at(-1)!;
    expect([added.name, added.dialects, model.metrics[0].dialects]).toEqual([
      'tax', [{dialect, expression: 'tax'}], [{dialect, expression: 'SUM(orders.tax)'}],
    ]);
    expect(res.warnings).toContain(
        `dataset 'orders': added field 'tax', which reads column 'tax', for metric 'kept', which ` +
        `reads it as 'source.tax'.`);
  });

  test('stops when a renamed metric would take a name past 500 characters', async () => {
    const long = 'm'.repeat(495);
    const res = await importSemanticModelYaml(declaring([metric(long, 'SUM(amount)')], m => {
      m.metrics = [metric(long, 'COUNT(orders.order_id)')];
    }), {flavor: 'google'});

    expect(res.errors).toEqual([
      `metric '${long}' of dataset 'orders': another metric or a field of ` +
      `dataset 'orders' has its name, and its new name breaks the name rule: ` +
      `Metric name 'orders_mmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmmm...' is 502 ` +
      `characters long; names may be at most 500 characters. Rename the metric.`,
    ]);
  });

  test.each(['ossie', 'google'] as const)('imports tpcds_semantic_model.yaml with --flavor %s', async flavor => {
    const res = await importSemanticModelYaml(
        example('tpcds_semantic_model.yaml'),
        {flavor, sourcePrefix: 'bigquery.googleapis.com/projects/tpcds', transpile: true});

    expect(res.errors).toEqual([]);
    expect(metrics(res.files[0].content).map(m => m.name)).toEqual(
        ['total_sales', 'total_profit', 'sales_by_brand', 'total_quantity']);
    expect(metrics(res.files[0].content)[3]).toEqual({
      name: 'total_quantity', entity: 'store_sales',
      dialects: ['SUM(store_sales.ss_quantity)', 'SUM(store_sales.ss_quantity)'],
    });
    expect(res.files[0].content).toContain(
        `      # Dataset-scoped metric: aggregates this dataset's own declared field by\n` +
        `      # single-part (unqualified) name; resolves within store_sales. Contrast with\n` +
        `      # the model-root \`metrics:\` block below, whose expressions span datasets.\n` +
        `      - name: total_quantity\n`);
  });
});
