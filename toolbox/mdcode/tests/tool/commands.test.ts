// Tests for the files a push reads and a pull writes
// (src/tool/commands.ts, src/libts/semantic/deploy_knowledge_catalog.ts).

import {afterEach, beforeEach, describe, expect, mock, Mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiContext} from '../../src/libts/gcp/context';
import {CatalogClient, Entry, EntryLink} from '../../src/libts/gcp/dataplex';
import {SpannerClient} from '../../src/libts/gcp/spanner';
import {OverviewSidecar, SemanticModelLayout} from '../../src/libts/layouts/semantic-model';
import * as bqLeg from '../../src/libts/semantic/deploy_bigquery';
import * as kc from '../../src/libts/semantic/deploy_knowledge_catalog';
import * as spannerLeg from '../../src/libts/semantic/deploy_spanner';
import {SemanticModel} from '../../src/libts/semantic/ir';
import {entryIdOf} from '../../src/libts/semantic/kc_ids';
import * as loaderMod from '../../src/libts/semantic/loader';
import * as osi from '../../src/libts/semantic/osi_converter';
import * as pullKc from '../../src/libts/semantic/pull_kc';
import * as pullUpdate from '../../src/libts/semantic/pull_update';
import {createSemanticRuntimes} from '../../src/libts/semantic/runtime/runtime';
import * as sqlParser from '../../src/libts/semantic/sql_parser';
import * as validateMod from '../../src/libts/semantic/validate';
import {profiles, pull, push, skillsGenerate} from '../../src/tool/commands';
import {entryDenied} from '../libts/gcp/location_responses';
import {passGraphChecks, passSourceCheck} from '../libts/mocks';
import {FIRST_GEN_MODEL_FILE, FIRST_GEN_OPTS, firstGenEntries} from '../libts/semantic/fixtures/first_gen_entries';

const CTX = new ApiContext('test-project', 'us', 'test-token');

const MODEL_YAML = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        primary_key: [key]
        fields:
          - { name: key, label: Customer ID }
`;

// Profile prod, which binds Customer to the prod table with its own key.
const PROD_PROFILE = `name: prod
entities:
  - name: Customer
    source: bigquery.googleapis.com/projects/test-project/datasets/prod/tables/customer
    primary_key: [cust_key]
    fields: [{ name: key, expression: cust_key }]
`;

let dir = '';
let cwd = '';

function writeWorkspace(): void {
  fs.writeFileSync(
      path.join(dir, 'catalog.yaml'),
      'scope: semantic-model.test-project.us.commerce_eg\n');
  const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
  fs.mkdirSync(eg, {recursive: true});
  fs.writeFileSync(path.join(eg, 'commerce.yaml'), MODEL_YAML);
}

// A model file's text without its deployments list, which publishes to
// Knowledge Catalog and deploys nothing.
const withoutDeployments = (model: string) =>
    model.replace(/ {4}deployments:\n.*\n.*\n/, '');

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-commands-'));
  process.chdir(dir);
  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  spyOn(console, 'log').mockImplementation(() => {});
  spyOn(console, 'error').mockImplementation(() => {});
  spyOn(console, 'warn').mockImplementation(() => {});
  // A call no test stubs fails instead of reaching the network.
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a test made a network call');
  }) as any);
  // Push checks that each custom type a model uses exists.
  spyOn(CatalogClient.prototype, 'getEntryType')
      .mockResolvedValue({status: 200, result: {}} as any);
  spyOn(CatalogClient.prototype, 'getAspectType')
      .mockResolvedValue({status: 200, result: {}} as any);
  passGraphChecks();
  passSourceCheck();
});

afterEach(() => {
  process.chdir(cwd);
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
  mock.restore();
});

describe('push prints Knowledge Catalog warnings', () => {
  const RESULT = {
    success: true, created: 1, updated: 0, deleted: 0, linked: 0,
    unchangedLinks: 0, unlinked: 0, warnings: ['a relationship is skipped'],
    plan: [],
  };
  // The model binds no table and declares no named profile, so push warns
  // before it reaches the catalog.
  const NON_EXECUTABLE = "Warning: model 'commerce' (commerce) is " +
      "non-executable: the model file leaves entity 'Customer' without a " +
      'source, and the model declares no named profile. It cannot be ' +
      'queried until it is bound.';

  test('before the first catalog write, once each', async () => {
    writeWorkspace();
    const events: string[] = [];
    spyOn(console, 'warn').mockImplementation((m: any) => {
      events.push(String(m));
    });
    // A preflight that passes gives its warnings with the prepared writes.
    spyOn(kc, 'preflightKnowledgeCatalog').mockResolvedValue({
      prepared: {emitted: [], existing: [], warnings: RESULT.warnings, plan: []},
    });
    spyOn(kc, 'applyKnowledgeCatalog').mockImplementation(async () => {
      events.push('first catalog write');
      return RESULT;
    });

    expect(await push({})).toBe(0);
    expect(events).toEqual([
      NON_EXECUTABLE,
      'Warning: a relationship is skipped',
      'first catalog write',
    ]);
  });

  test('under --validate-only, from the result', async () => {
    writeWorkspace();
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    // Under --validate-only the preflight gives its result, warnings included.
    spyOn(kc, 'preflightKnowledgeCatalog').mockResolvedValue({result: RESULT});

    expect(await push({validateOnly: true})).toBe(0);
    expect(warn.mock.calls.map(c => String(c[0]))).toEqual([
      NON_EXECUTABLE,
      'Warning: a relationship is skipped',
    ]);
  });
});

describe('push preflights under a deployment\'s profile', () => {
  // Each live preflight gets documents labeled with the deployment, so its
  // errors name the deployment whose profile may have set the value they are
  // about. Profile bq leaves field ltv out, so push prints a pruning note
  // before a source check that fails.
  test('every preflight names the deployment, and a push whose source check fails still prints the pruning note', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: bq
        target: bigquery.googleapis.com/projects/test-project/datasets/d/propertyGraphs/g
        profile: bq
      - name: sp
        target: spanner.googleapis.com/projects/test-project/instances/i/databases/d/graphs/g
        profile: sp
    entities:
      - name: Customer
        source: bigquery.googleapis.com/projects/test-project/datasets/raw/tables/customer
        primary_key: [key]
        fields:
          - { name: key, expression: c_key }
          - { name: ltv }
          - { name: odd, expression: "odd +* (" }
`);
    const profileFile = (name: string, source: string) =>
        `name: ${name}\nentities:\n  - name: Customer\n    source: ${source}\n` +
        '    primary_key: [key]\n    fields: [{ name: key, expression: c_key }]\n' +
        '    fields_exclude: [ltv]\n';
    fs.writeFileSync(path.join(eg, 'commerce.profile.bq.yaml'), profileFile(
        'bq', 'bigquery.googleapis.com/projects/test-project/datasets/prod/tables/customer'));
    fs.writeFileSync(path.join(eg, 'commerce.profile.sp.yaml'), profileFile(
        'sp', 'spanner.googleapis.com/projects/test-project/instances/i/databases/d/tables/Customer'));
    const seen: Record<string, string[]> = {};
    const record = (name: string) => async (models: any[]) => {
      (seen[name] ??= []).push(...models.map(m => m.document));
      return [];
    };
    spyOn(validateMod, 'validateBigQueryDataSources').mockImplementation(record('sources') as any);
    spyOn(validateMod, 'validateBigQueryActionStatements').mockImplementation(record('bqDml') as any);
    spyOn(validateMod, 'validateSpannerActionStatements').mockImplementation(record('spDml') as any);
    spyOn(bqLeg, 'deployBigQuery').mockResolvedValue(
        {success: true, deployed: 0, ddl: [], warnings: []} as any);
    spyOn(spannerLeg, 'deploySpanner').mockResolvedValue(
        {success: true, warnings: [], ddl: [], deployed: 0} as any);

    expect(await push({validateOnly: true})).toBe(0);
    expect(seen).toEqual({
      sources: ["commerce, deployment 'bq'"],
      bqDml: ["commerce, deployment 'bq'"],
      spDml: ["commerce, deployment 'sp'"],
    });
    spyOn(validateMod, 'validateBigQueryDataSources').mockResolvedValue(['gone']);
    const warn = spyOn(console, 'warn').mockClear();
    const error = spyOn(console, 'error').mockClear();
    expect(await push({validateOnly: true, deployment: ['bq']})).toBe(1);
    expect(messages(error)).toBe('Error: gone');
    expect(messages(warn).split('\n')).toEqual([
      "Warning: field 'Customer.odd' in model 'commerce' (commerce): kcmd " +
          'could not read its SQL, so the fields it reads were not checked.',
      "Note: model 'commerce' (commerce, deployment 'bq') excludes field " +
          "'Customer.ltv'.",
    ]);
  });
});


// A model with no deployments list but with profile files deploys nothing.
// Push checks the sources of every profile file there too, before it writes
// anything.
describe('a model with no deployments checks every profile file\'s sources', () => {
  const BQ = 'bigquery.googleapis.com/projects/test-project/datasets';
  const [RAW, PROD, DEV] =
      ['raw', 'prod', 'dev'].map(d => `${BQ}/${d}/tables/customer`);
  const profileFile = (name: string, source: string) =>
      `name: ${name}\nentities:\n  - name: Customer\n    source: ${source}\n` +
      '    primary_key: [cust_key]\n    fields: [{ name: key, expression: cust_key }]\n';
  const entry = (source: string) =>
      `projects/test-project/locations/us/entryGroups/@bigquery/entries/${source}`;

  test('a missing table in profile file dev stops push', async () => {
    writeWorkspace();
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.writeFileSync(path.join(eg, 'commerce.yaml'),
                     MODEL_YAML.replace('    entities:\n      - name: Customer\n',
                                        `    entities:\n      - name: Customer\n        source: ${RAW}\n`));
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'), profileFile('prod', PROD));
    fs.writeFileSync(path.join(eg, 'commerce.profile.dev.yaml'), profileFile('dev', DEV));
    const lookup = spyOn(CatalogClient.prototype, 'lookupEntry')
        .mockImplementation((async (_p: string, _l: string, name: string) =>
            name.endsWith(`/entries/${DEV}`) ? entryDenied(name) :
                                               {status: 200, result: {name}}) as any);
    const preflightSpy = spyOn(kc, 'preflightKnowledgeCatalog');
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    expect(await push({})).toBe(1);
    expect(messages(errorSpy)).toBe(
        `Error: entity 'Customer' in profile 'dev': source '${DEV}' names no ` +
        `table Knowledge Catalog knows about. BigQuery has the table, but ` +
        `Knowledge Catalog has no entry for it that you may read. Fix the ` +
        `access or the source. --skip-source-check skips this lookup, but a ` +
        `deployment that reads the table still checks the table itself.`);
    expect(preflightSpy).not.toHaveBeenCalled();
    expect(lookup.mock.calls.map(c => c[2]).sort())
        .toEqual([RAW, PROD, DEV].map(entry).sort());
  });
});

describe('a catalog-only push with a sibling profile file', () => {
  const setup = (entities: string) => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
${entities}`);
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'), PROD_PROFILE);
  };
  const CUSTOMER = `      - name: Customer
        source: bigquery.googleapis.com/projects/test-project/datasets/raw/tables/customer
        primary_key: [key]
        fields:
          - { name: key, expression: c_key }
`;

  // A named profile binds every concrete entity, whether or not a push
  // deploys it, so an entity the profile file leaves without a source stops a
  // catalog-only push too.
  test('an entity left without a source stops a catalog-only push', async () => {
    setup(CUSTOMER + `      - name: Orders
        primary_key: [id]
        fields:
          - { name: id, expression: o_id }
`);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const preflightSpy = spyOn(kc, 'preflightKnowledgeCatalog');

    expect(await push({validateOnly: true})).toBe(1);
    expect(preflightSpy).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map(c => String(c[0]))).toEqual([
      "Error: [commerce.profile.prod.yaml] profile 'prod': entity 'Orders' " +
          'has no source in this profile',
    ]);
  });

  test('publishes the model file as written, unpruned, with the profile attached', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    // No deployment target, so the push publishes to Knowledge Catalog only.
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: bigquery.googleapis.com/projects/test-project/datasets/raw/tables/customer
        fields:
          - { name: key, expression: c_key }
          - { name: credit, expression: c_credit }
`);
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'),
                     `${PROD_PROFILE}    fields_exclude: [credit]\n`);
    const preflightSpy = spyOn(kc, 'preflightKnowledgeCatalog');

    const code = await push({validateOnly: true});

    expect(code).toBe(0);
    const model = preflightSpy.mock.calls[0][0][0].model;
    const customer = model.entities[0];
    expect(customer.dataSource).toBe('test-project.raw.customer');
    expect(customer.fields.find(f => f.name === 'key')!.expression)
        .toBe('c_key');
    // The field the profile leaves out keeps its binding.
    expect(customer.fields.find(f => f.name === 'credit')!.expression)
        .toBe('c_credit');
    expect(customer.excludedFields).toBeUndefined();
    expect(model.profiles!.map(p => p.name)).toEqual(['prod']);
  });
});


describe('a push that deploys no graph gives no graph key warning', () => {
  test('a keyless entity gets only the catalog\'s warning', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Wide
        fields:
          - { name: id }
`);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    expect(await push({validateOnly: true})).toBe(0);
    expect(warnSpy.mock.calls.map(c => String(c[0]))).toEqual([
      "Warning: model 'commerce' (commerce) is non-executable: the model " +
          "file leaves entity 'Wide' without a source, and the model " +
          'declares no named profile. It cannot be queried until it is bound.',
      "Warning: [commerce] entity 'Wide': no keys declared in the source " +
          'model; declare primary_key or unique_keys in the model file or ' +
          'in a profile to record a key in Knowledge Catalog',
    ]);
  });
});


describe('a push error under a named profile names the profile', () => {
  const writeModel = (profile: string) => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: g
        target: bigquery.googleapis.com/projects/test-project/datasets/d/propertyGraphs/g
        profile: prod
    entities:
      - name: Customer
        source: bigquery.googleapis.com/projects/test-project/datasets/raw/tables/customer
        primary_key: [c_key]
        fields:
          - { name: key, expression: c_key }
      - name: Order
        source: bigquery.googleapis.com/projects/test-project/datasets/raw/tables/orders
        primary_key: [o_key]
        fields:
          - { name: key, expression: o_key }
    relationships:
      - name: placed_by
        from: Order
        to: Customer
        from_columns: [o_cust]
        to_columns: [c_key]
`);
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'), profile);
  };

  // The profile's key leaves the relationship's to_columns covering none.
  test('a key the profile sets', async () => {
    writeModel(`${PROD_PROFILE.replaceAll('cust_key', 'cust_id')}  - name: Order
    source: bigquery.googleapis.com/projects/test-project/datasets/prod/tables/orders
    primary_key: [o_key]
    fields: [{ name: key, expression: o_key }]
relationships:
  - name: placed_by
    from_columns: [o_cust]
    to_columns: [c_key]
`);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const code = await push({validateOnly: true});

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.map(c => String(c[0]))).toEqual([
      "Error: [commerce.profile.prod.yaml] profile 'prod': relationship " +
          "'placed_by' joins on to_columns [\"c_key\"], which cover no " +
          "primary or unique key of 'Customer'",
    ]);
  });

  // A model file that does not load on its own is the loader's error, which
  // names the document itself.
  test('a model file that does not load alone', async () => {
    writeModel('name: prod\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: not a table
`);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const code = await push({validateOnly: true});

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.map(c => String(c[0]))).toEqual([
      "Error: Model document 'commerce': Semantic model load error: entity " +
          "'Customer': source 'not a table' looks like a SQL query; a " +
          'query-valued source is not supported yet. Bind \'source\' to a ' +
          'physical table using its GCP resource name (e.g. ' +
          "'bigquery.googleapis.com/projects/<p>/datasets/<d>/tables/<t>').",
    ]);
  });

  // The profile's source is read by the loader's source reader, so it is
  // rejected as the same source in a model file is.
  test('a source the loader rejects', async () => {
    writeModel(`name: prod
entities:
  - name: Customer
    source: prod.customer
`);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const code = await push({validateOnly: true});

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain(
            "[commerce.profile.prod.yaml] profile 'prod': entity 'Customer': " +
            "bare table name 'prod.customer' is not a valid source");
  });
});


// The profile file is applied to the model file loaded on its own, so a model
// file that does not load alone stops the push, even where the profile would
// complete it. The YAML merge loaded the merged text instead.
describe('a catalog-only push of a profile file loads the model file alone', () => {
  test('a half-bound join in the model file is reported', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    const BQ = (t: string) =>
        `bigquery.googleapis.com/projects/test-project/datasets/raw/tables/${t}`;
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: ${BQ('customer')}
        primary_key: [key]
        fields:
          - { name: key, expression: c_key }
      - name: Order
        source: ${BQ('orders')}
        primary_key: [key]
        fields:
          - { name: key, expression: o_key }
    relationships:
      - name: placed_by
        from: Order
        to: Customer
        from_columns: [o_cust]
`);
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'), `name: prod
relationships:
  - name: placed_by
    to_columns: [c_key]
`);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    spyOn(console, 'warn').mockImplementation(() => {});
    const preflightSpy = spyOn(kc, 'preflightKnowledgeCatalog');

    const code = await push({validateOnly: true});

    expect(code).toBe(1);
    expect(preflightSpy).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.map(c => c.join(' ')).join('\n')).toContain(
        "relationship 'placed_by': from_columns and to_columns must be given " +
        'together');
  });
});


// A Spanner graph reads a field's SPANNER text, else its ANSI_SQL one, and a
// BigQuery graph its BIGQUERY text, else its ANSI_SQL one. Pruning, and the
// check of what a profile excludes, read the text each deployment's graph
// reads. Entity big_orders extends orders, so a graph deployment of the model
// file's own bindings may leave field tax of orders without an expression.
describe('a model with a Spanner graph target is pruned in the Spanner dialect', () => {
  test('push drops a field, and a profile must exclude one, by the text its graph reads', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    const spDb = 'spanner.googleapis.com/projects/test-project/instances/i/databases/db';
    const bqTable =
        'bigquery.googleapis.com/projects/test-project/datasets/ds/tables/orders';
    const bqGraph =
        'bigquery.googleapis.com/projects/test-project/datasets/ds/propertyGraphs/g';
    const writeModel = (deployments: string, more = '') =>
        fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
${deployments}
    entities:
      - name: orders
        source: ${spDb}/tables/Orders
        primary_key: [order_id]
        fields:
          - { name: order_id, expression: order_id }
          - { name: gross, expression: gross }
          - { name: tax }
          - name: net
            expression:
              dialects:
                - { dialect: BIGQUERY, expression: "orders.gross" }
                - { dialect: SPANNER, expression: "orders.gross - orders.tax" }
          - name: total
            expression:
              dialects:
                - { dialect: SPANNER, expression: "orders.gross" }
                - { dialect: ANSI_SQL, expression: "orders.gross - orders.tax" }
${more}`);
    // Entity big_orders extends orders and binds tax.
    writeModel(`      - { name: sp, target: ${spDb}/graphs/g }`, `      - name: big_orders
        extends: [orders]
        source: ${spDb}/tables/BigOrders
        primary_key: [order_id]
        fields:
          - { name: order_id, expression: order_id }
          - { name: gross, expression: gross }
          - { name: tax, expression: tax }
`);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const deploySpy = spyOn(spannerLeg, 'deploySpanner');

    expect(await push({validateOnly: true})).toBe(0);
    const omits = (field: string, why: string) =>
        `Warning: field 'orders.${field}' in model 'commerce' (commerce, ` +
        `deployment 'sp') ${why}, so the graph omits it.`;
    expect(messages(warnSpy).split('\n').filter(
               w => w.startsWith('Warning: field')))
        .toEqual([
          omits('tax', 'has no expression'),
          omits('net', 'reads orders.tax, which is unavailable'),
        ]);
    // Orders keeps the fields big_orders inherits, and marks them excluded.
    const orders = deploySpy.mock.calls[0][0][0].model.entities[0];
    expect(orders.excludedFields).toEqual(['tax', 'net']);

    // Each profile leaves field tax out.
    const profileFile = (name: string, source: string) => `name: ${name}
entities:
  - name: orders
    source: ${source}
    primary_key: [order_id]
    fields:
      - { name: order_id, expression: order_id }
      - { name: gross, expression: gross }
    fields_exclude: [tax]
`;
    fs.writeFileSync(path.join(eg, 'commerce.profile.spprof.yaml'),
                     profileFile('spprof', `${spDb}/tables/Orders`));
    fs.writeFileSync(path.join(eg, 'commerce.profile.bqprof.yaml'),
                     profileFile('bqprof', bqTable));
    writeModel(`      - { name: bq, target: ${bqGraph}, profile: bqprof }
      - { name: sp, target: ${spDb}/graphs/g, profile: spprof }`);
    const depends = (profile: string, field: string) =>
        `Error: [commerce.profile.${profile}.yaml] profile '${profile}': ` +
        `field 'orders.${field}' depends on 'orders.tax', which this profile ` +
        `excludes; add '${field}' to the 'fields_exclude' of entity 'orders', ` +
        `or rebind it`;

    expect(await push({validateOnly: true})).toBe(1);
    expect(messages(errorSpy).split('\n'))
        .toEqual([depends('bqprof', 'total'), depends('spprof', 'net')]);
  });
});


// A push that deploys a graph prunes unbound fields, which can remove the very
// field an inheritance rule is about. The rules run on the model before
// pruning, so a graph push and a catalog-only push give the same answer.
describe('a graph push checks inheritance before pruning', () => {
  const GRAPH_MODEL = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: prod
        target: bigquery.googleapis.com/projects/test-project/datasets/d/propertyGraphs/g
    entities:
      - name: customer
        source: bigquery.googleapis.com/projects/test-project/datasets/d/tables/customer
        primary_key: [id]
        fields:
          - { name: id, datatype: Integer, expression: id }
          - { name: name, datatype: String, expression: cust_name }
      - name: vip
        extends: [customer]
        source: bigquery.googleapis.com/projects/test-project/datasets/d/tables/vip
        primary_key: [id]
        fields:
          - { name: id, expression: id }
          - { name: name, datatype: Integer, description: VIP name }
`;

  test('a redefined inherited field with no column is reported', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), GRAPH_MODEL);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const code = await push({validateOnly: true});

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain("field 'name' is inherited, so it may only be rebound to a column");
  });

  test('a metric reading an unbound field and a non-existent field is reported before pruning drops it', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: default
        target: bigquery.googleapis.com/projects/test-project/datasets/d/propertyGraphs/g
    entities:
      - name: customer
        source: bigquery.googleapis.com/projects/test-project/datasets/d/tables/customer
        primary_key: [id]
        fields:
          - { name: id, datatype: Integer, expression: id }
          - { name: credit_limit, datatype: Decimal }
    metrics:
      - name: bad_metric
        expression:
          dialects:
            - dialect: BIGQUERY
              expression: SUM(customer.credit_limit) + SUM(customer.non_existent)
`);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const code = await push({validateOnly: true});

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain("expression references 'customer.non_existent', but entity 'customer' has no field 'non_existent'");
  });

  test('an unparseable metric expression prints its unreadable-SQL warning only once on push, and entry points load the SQL engine', async () => {
    writeWorkspace();
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - { name: default, target: bigquery.googleapis.com/projects/test-project/datasets/d/propertyGraphs/g }
    entities:
      - name: customer
        source: bigquery.googleapis.com/projects/test-project/datasets/d/tables/customer
        primary_key: [id]
        fields: [{ name: id, datatype: Integer, expression: id }]
    metrics:
      - name: broken_metric
        entity: customer
        expression: "SUM(customer.id"
`);
    spyOn(validateMod, 'validateBigQueryDataSources').mockResolvedValue([]);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    const order: string[] = [];
    const origLoad = sqlParser.loadSqlEngine;
    const spy = spyOn(sqlParser, 'loadSqlEngine').mockImplementation(async () => {
      order.push('loadSqlEngine');
      return origLoad();
    });
    const origLoadModels = loaderMod.loadSemanticModels;
    spyOn(loaderMod, 'loadSemanticModels').mockImplementation((...args) => {
      order.push('loadSemanticModels');
      return origLoadModels(...args);
    });
    const origExprRefs = validateMod.validateExpressionReferences;
    spyOn(validateMod, 'validateExpressionReferences')
        .mockImplementation((...args) => {
          order.push('validateExpressionReferences');
          return origExprRefs(...args);
        });
    const origPushReqs = validateMod.validatePushRequirements;
    spyOn(validateMod, 'validatePushRequirements')
        .mockImplementation((...args) => {
          order.push('validatePushRequirements');
          return origPushReqs(...args);
        });

    expect(await push({validateOnly: true})).toBe(0);
    expect(warnSpy.mock.calls.map(c => String(c[0])).filter(m => m.includes('could not read its SQL')))
        .toEqual([
          "Warning: metric 'broken_metric' in model 'commerce' (commerce): kcmd " +
          'could not read its SQL, so the fields it reads were not checked.',
        ]);
    // The BigQuery measure rule also runs the reference rules, to leave the
    // metrics they report to them.
    expect(order).toEqual([
      'loadSqlEngine',
      'loadSemanticModels',
      'validateExpressionReferences',
      // The catalog's model, then the deployment's.
      'validatePushRequirements',
      'validateExpressionReferences',
      'validateExpressionReferences',
      'validatePushRequirements',
      'validateExpressionReferences',
    ]);
    expect(spy).toHaveBeenCalledTimes(1);

    await profiles();
    await pullKc.pullKnowledgeCatalog(
        {async *listEntries() {}} as any, {project: 'p', location: 'us', entryGroup: 'eg'});
    await createSemanticRuntimes();
    expect(spy).toHaveBeenCalledTimes(4);
  });
});


// ---------------------------------------------------------------------------
// The files push reads and pull writes.
// ---------------------------------------------------------------------------

// A model file with a deployment, whose comments, key order and flow style the
// serializer would not reproduce.
const ROUND_TRIP_MODEL = `# The commerce model.
version: "0.2.0.dev0/google"
semantic_model:
  - description: Orders and customers   # description before name
    name: commerce
    deployments:
      - name: prod
        target: bigquery.googleapis.com/projects/test-project/datasets/d/propertyGraphs/g
    entities:
      - name: Customer
        source: bigquery.googleapis.com/projects/test-project/datasets/d/tables/customer
        primary_key: [key]
        fields:
          - { name: key, expression: c_key }   # flow style
`;

const ROUND_TRIP_PROFILE = `# Production bindings.\n${PROD_PROFILE}`;

function entryGroupDir(): string {
  return path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
}

function writeRoundTripWorkspace(profile = ROUND_TRIP_PROFILE): void {
  fs.writeFileSync(
      path.join(dir, 'catalog.yaml'),
      'scope: semantic-model.test-project.us.commerce_eg\n');
  fs.mkdirSync(entryGroupDir(), {recursive: true});
  fs.writeFileSync(path.join(entryGroupDir(), 'commerce.yaml'), ROUND_TRIP_MODEL);
  fs.writeFileSync(
      path.join(entryGroupDir(), 'commerce.profile.prod.yaml'), profile);
}

// The engine of a Cloud SQL instance, as its tables' entry types name it.
type CloudSqlEngine = 'mysql'|'postgresql'|'sqlserver';

// The type of the entry Dataplex keeps for the table whose system entry is
// `name`, as a full name: the live types of a BigQuery, BigLake, Spanner and
// AlloyDB table (2026-10-27), and the Cloud SQL table type of `engine`.
// Dataplex knows each instance's engine; a name in a schema cannot tell
// PostgreSQL from SQL Server, so without `engine` a table in a schema is
// PostgreSQL's and any other MySQL's.
function systemEntryType(name: string, engine?: CloudSqlEngine): string {
  const group = /\/entryGroups\/@([a-z]+)\//.exec(name)![1];
  const type = group === 'cloudsql' ?
      `cloudsql-${engine ?? (name.includes('/schemas/') ? 'postgresql' : 'mysql')}-table` :
      {bigquery: 'bigquery-table', biglake: 'biglake-table',
       spanner: 'cloud-spanner-table', alloydb: 'alloydb-table'}[group];
  return `projects/655216118709/locations/global/entryTypes/${type}`;
}

// An in-memory catalog that push writes into and pull reads from. Every
// client call the two legs make is answered here, and fetch throws, so no
// test reaches the network. `cloudSqlEngine` is the engine of every Cloud SQL
// instance.
function fakeCatalog(opts: {cloudSqlEngine?: CloudSqlEngine} = {}) {
  const entries = new Map<string, Entry>();
  const P = CatalogClient.prototype;
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a test made a network call');
  }) as any);
  spyOn(P, 'getEntryGroup').mockResolvedValue({status: 200} as any);
  // A list returns entries without their aspects.
  const list = spyOn(P, 'listEntries').mockImplementation(async function*() {
    for (const e of entries.values()) {
      yield {name: e.name, entryType: e.entryType, parentEntry: e.parentEntry};
    }
  } as any);
  // Writes after the first `stop.after`, and writes of an entry `stop.fails`
  // names, fail, as when a push stops partway.
  const stop = {after: Infinity, fails: (_name: string) => false};
  const stopped = (name = '') => stop.after-- <= 0 || stop.fails(name);
  const INJECTED = {status: 500, message: 'injected'};
  const create = spyOn(P, 'createEntry')
                     .mockImplementation(async (...args: any[]) => {
                       const entry: Entry = args[4];
                       if (entries.has(entry.name)) return {status: 409};
                       if (stopped(entry.name)) return INJECTED;
                       entries.set(entry.name, structuredClone(entry));
                       return {status: 200, result: entry};
                     });
  // An update leaves the aspects alone when its mask does not name them.
  spyOn(P, 'updateEntry').mockImplementation(async (entry, mask) => {
    if (stopped(entry.name)) return INJECTED;
    const aspects = mask?.includes('aspects') ?
        entry.aspects :
        entries.get(entry.name)?.aspects;
    entries.set(entry.name, structuredClone({...entry, aspects}));
    return {status: 200, result: entry};
  });
  spyOn(P, 'deleteEntry').mockImplementation(async (...args: any[]) => {
    if (stopped()) return INJECTED;
    for (const name of entries.keys()) {
      if (name.endsWith(`/entries/${args[3]}`)) entries.delete(name);
    }
    return {status: 200};
  });
  // A lookup returns only the aspects it asks for. A table's own entry, in a
  // system entry group such as `@bigquery`, is Dataplex's, not push's: it is
  // found, as it is for every table that exists.
  spyOn(P, 'lookupEntry')
      .mockImplementation(async (_p: string, _l: string, name: string,
                                 lookupOpts: {aspects?: string[]} = {}) => {
        const aspectTypes = lookupOpts.aspects;
        if (name.includes('/entryGroups/@')) {
          return {status: 200, result: {name, entryType: systemEntryType(name, opts.cloudSqlEngine)}};
        }
        const e = entries.get(name);
        if (!e) return {status: 404, message: 'not found'};
        const aspects = Object.fromEntries(
            Object.entries(e.aspects ?? {})
                .filter(([, a]) => (aspectTypes ?? []).includes(a.aspectType!)));
        return {status: 200, result: {...structuredClone(e), aspects}};
      });
  // A get returns the entry without its aspects.
  spyOn(P, 'getEntry').mockImplementation(async (...[p, l, g, id]: any[]) => {
    const e = entries.get(
        `projects/${p}/locations/${l}/entryGroups/${g}/entries/${id}`);
    return e ? {status: 200, result: {...structuredClone(e), aspects: {}}} :
               {status: 404, message: 'not found'};
  });
  // A link lookup returns the stored links that reference the entry.
  const links = new Map<string, EntryLink>();
  spyOn(P, 'lookupEntryLinks')
      .mockImplementation(async (_p: string, _l: string, {entry}) => ({
        status: 200,
        result: [...links.values()]
                    .filter(l => l.entryReferences.some(r => r.name === entry))
                    .map(l => structuredClone(l)),
      }));
  spyOn(P, 'createEntryLink').mockImplementation(async (...args: any[]) => {
    const link: EntryLink = args[4];
    if (stopped()) return INJECTED;
    if (links.has(link.name!)) return {status: 409};
    links.set(link.name!, structuredClone(link));
    return {status: 200};
  });
  spyOn(P, 'updateEntryLink').mockImplementation(async (link) => {
    const stored = links.get(link.name!);
    if (!stored) return {status: 404, message: 'not found'};
    stored.aspects = {...stored.aspects, ...structuredClone(link.aspects)};
    return {status: 200, result: stored};
  });
  return {entries, create, list, stop};
}

// Every file under the entry group directory, with its text.
const localFiles = (): Record<string, string> => Object.fromEntries(
    (fs.readdirSync(entryGroupDir(), {recursive: true}) as string[])
        .map(f => path.join(entryGroupDir(), f))
        .filter(f => fs.statSync(f).isFile())
        .map(f => [f, fs.readFileSync(f, 'utf8')]));

// Mocks the BigQuery leg's live checks and deploy, and returns the deploy's
// mock.
function mockBigQuery() {
  spyOn(validateMod, 'validateBigQueryDataSources').mockResolvedValue([]);
  spyOn(validateMod, 'validateBigQueryActionStatements').mockResolvedValue([]);
  return spyOn(bqLeg, 'deployBigQuery').mockResolvedValue(
      {success: true, deployed: 1, ddl: [], warnings: []} as any);
}

function messages(spy: any): string {
  return spy.mock.calls.map((c: any[]) => c.map(String).join(' ')).join('\n');
}

// The catalog answers a Cloud SQL table's entry with its engine's type, which
// gives the push the table's dialect, as it answers every other table's.
describe('push checks that each file is valid UTF-8', () => {
  // A first line holding a Latin-1 é. Read as UTF-8, it becomes U+FFFD.
  const latin1 = (text: string) => Buffer.concat(
      [Buffer.from('# caf'), Buffer.from([0xe9]), Buffer.from(`\n${text}`)]);
  for (const [file, text] of [
         ['commerce.yaml', ROUND_TRIP_MODEL],
         ['commerce.profile.prod.yaml', ROUND_TRIP_PROFILE],
         ['commerce.overview.md', 'Orders and customers.\n'],
       ]) {
    test(`a ${file} that is not valid UTF-8 fails the push, naming it`,
         async () => {
           writeRoundTripWorkspace();
           fs.writeFileSync(path.join(entryGroupDir(), file), latin1(text));
           const {create} = fakeCatalog();
           const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

           expect(await push({deployment: false})).toBe(1);
           expect(messages(errorSpy))
               .toContain(
                   `Error: File '${file}' is not valid UTF-8; save it as ` +
                   `UTF-8.`);
           expect(create).not.toHaveBeenCalled();
         });
  }

  test('a file holding U+FFFD as text is pushed', async () => {
    writeRoundTripWorkspace(
        `# \uFFFD marks a lost character.\n${ROUND_TRIP_PROFILE}`);
    fs.writeFileSync(
        path.join(entryGroupDir(), 'commerce.overview.md'), '\uFFFD\n');
    fakeCatalog();

    expect(await push({deployment: false})).toBe(0);
  });
});


describe('a profile file that binds a Cloud SQL table', () => {
  const CLOUDSQL = 'cloudsql.googleapis.com/projects/test-project/locations/' +
      'us-central1/instances/shop/databases/sales';
  for (const [engine, table] of [
    ['mysql', `${CLOUDSQL}/tables/customer`],
    ['postgresql', `${CLOUDSQL}/schemas/public/tables/customer`],
    ['sqlserver', `${CLOUDSQL}/schemas/dbo/tables/customer`],
  ] as const) {
    test(`is pushed, for ${engine}`, async () => {
      writeRoundTripWorkspace(
          PROD_PROFILE.replace(/source: .*/, `source: ${table}`));
      fakeCatalog({cloudSqlEngine: engine});
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      expect(await push({deployment: false})).toBe(0);
      expect(messages(errorSpy)).toBe('');
      // The table is looked up once, and its entry names its engine.
      const lookup = CatalogClient.prototype.lookupEntry as unknown as Mock<any>;
      const types = (await Promise.all(lookup.mock.results.map(r => r.value)))
                        .map(a => a.result?.entryType as string)
                        .filter(t => t.includes('/cloudsql-'));
      expect(types).toEqual([
          `projects/655216118709/locations/global/entryTypes/cloudsql-${engine}-table`]);
    });
  }
});


describe('a push of overview sidecars', () => {
  // Push still reads each profile file, to check it. A push of a model with no
  // deployments list and a --no-deployment push both write each overview
  // sidecar into its entry's overview aspect, and a malformed sidecar stops
  // them before they read the catalog.
  test('push writes the overview sidecars, with --no-deployment too; a ' +
           'malformed sidecar or profile file fails it',
       async () => {
         writeRoundTripWorkspace();
         const write = (name: string, text: string) => {
           fs.mkdirSync(path.dirname(path.join(entryGroupDir(), name)),
                        {recursive: true});
           fs.writeFileSync(path.join(entryGroupDir(), name), text);
         };
         write('commerce.overview.md',
               '---\ncontentType: MARKDOWN\n---\n# Commerce\n');
         // A sidecar with no frontmatter is stored with LF line endings too.
         write('commerce/entities/Customer.overview.md',
               'A buyer.\r\nOn Windows.\r\n');
         const {entries, create, list} = fakeCatalog();
         const overview = (id: string) =>
             entries
                 .get('projects/test-project/locations/us/entryGroups/' +
                      `commerce_eg/entries/${id}`)!
                 .aspects!['dataplex-types.global.overview'].data;
         const pushes = [
           {options: {}, model: withoutDeployments(ROUND_TRIP_MODEL)},
           {options: {deployment: false}, model: ROUND_TRIP_MODEL},
         ];
         for (const {options, model} of pushes) {
           write('commerce.yaml', model);
           expect(await push(options)).toBe(0);
           expect(overview('commerce'))
               .toEqual({content: '# Commerce', contentType: 'MARKDOWN'});
           expect(overview('commerce/entities/Customer'))
               .toEqual({content: 'A buyer.\nOn Windows.'});
         }

         write('commerce/metrics/revenue.overview.md',
               '---\ncontentType: TEXT\n---\nNet.\n');
         const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
         for (const {options, model} of pushes) {
           write('commerce.yaml', model);
           list.mockClear();
           create.mockClear();
           errorSpy.mockClear();
           expect(await push(options)).toBe(1);
           expect(messages(errorSpy)).toBe(
               'Error: Overview sidecar ' +
               "'commerce/metrics/revenue.overview.md': contentType is " +
               "MARKDOWN or HTML, not 'TEXT'.");
           expect(list).not.toHaveBeenCalled();
           expect(create).not.toHaveBeenCalled();
         }

         writeRoundTripWorkspace('name: [unterminated\n');
         errorSpy.mockClear();
         expect(await push({deployment: false})).toBe(1);
         expect(messages(errorSpy)).toContain('commerce.profile.prod.yaml');
         write('commerce.yaml', withoutDeployments(ROUND_TRIP_MODEL));
         errorSpy.mockClear();
         expect(await push({})).toBe(1);
         expect(messages(errorSpy)).toContain('commerce.profile.prod.yaml');
       });
});


// A model pulled from the catalog, with an entity and profile prod, which push
// accepts.
const SECOND_GEN: SemanticModel = {
  name: 'commerce',
  relationships: [],
  metrics: [],
  profiles: [{
    name: 'prod',
    entities: [{
      name: 'Customer',
      source: 'bigquery.googleapis.com/projects/test-project/datasets/d/tables/customer',
      fields: [{name: 'id', expression: 'c_id'}],
    }],
    relationships: [],
    metricsExclude: '*',
  }],
  entities: [{
    name: 'Customer', dataSource: '', keys: [], fields: [{name: 'id'}],
  }],
};
// What a pull of `model` returns.
const pulled =
    (model = SECOND_GEN, overviews?: Map<string, OverviewSidecar>) =>
        spyOn(pullKc, 'pullKnowledgeCatalog').mockResolvedValue({
          models: [model], warnings: [],
          ...(overviews ? {overviews} : {}),
        });
// The files pull writes for `model`, by name.
const serializedFiles = (model = SECOND_GEN): Record<string, string> =>
    Object.fromEntries(osi.serializeModelFiles(model, {logical: true})
                           .files.map(f => [f.fileName, f.content]));
const local = (name: string) => path.join(entryGroupDir(), name);
// How a message names a local file: relative to the workspace.
const shown = (name: string) =>
    path.join('catalog', 'EntryGroups', 'commerce_eg', name);
// A workspace holding the model file and two profile files, of which the
// catalog has only `prod`.
const withStaleProfile = () => {
  writeRoundTripWorkspace('name: prod\n');
  fs.writeFileSync(local('commerce.profile.dev.yaml'), 'name: dev\n');
};


// Push, `kcmd profiles` and `kcmd skills-generate` refuse each legacy profile
// form before they read a model, and name every one found. Pull still works
// beside them, so an author can pull before moving to the current forms.
describe('the legacy profile forms', () => {
  const forms: Array<[string, () => void, string[]]> = [
    [
      'default_profile in catalog.yaml',
      () => fs.appendFileSync('catalog.yaml', 'default_profile: prod\n'),
      [`'default_profile' in catalog.yaml is no longer supported; specify ` +
       `'profile:' on each entry under 'deployments:' in your model YAML.`],
    ],
    [
      'a <model>.profiles/ directory',
      () => {
        fs.mkdirSync(local('commerce.profiles'));
        fs.writeFileSync(local('commerce.profiles/prod.yaml'), PROD_PROFILE);
      },
      [`Legacy profile directory 'commerce.profiles/' is no longer ` +
       `supported; rename profile files to 'commerce.profile.<name>.yaml' ` +
       `beside 'commerce.yaml'.`],
    ],
    [
      'a profile file with no model file',
      () => fs.writeFileSync(local('gone.profile.prod.yaml'), PROD_PROFILE),
      [`Profile file 'gone.profile.prod.yaml' has no 'gone.yaml' beside it.`],
    ],
    [
      'a nameless profile file with no model file',
      () => fs.writeFileSync(local('gone.profile.yaml'), PROD_PROFILE),
      [`Profile file 'gone.profile.yaml' has no 'gone.yaml' beside it.`],
    ],
  ];
  const commands: Array<() => Promise<number>> = [
    () => push({validateOnly: true}),
    () => profiles({profile: 'prod'}),
    () => profiles({printStore: true, profile: 'prod'}),
    () => skillsGenerate({profile: 'prod'}),
  ];

  for (const [form, setup, errors] of [
         ...forms,
         [
           'every form at once', () => forms.forEach(([, s]) => s()),
           forms.flatMap(([, , e]) => e)
         ] as const,
       ]) {
    test(`${form} stops push, profiles and skills-generate, not pull`,
         async () => {
           writeRoundTripWorkspace();
           setup();
           const errorSpy =
               spyOn(console, 'error').mockImplementation(() => {});
           for (const run of commands) {
             errorSpy.mockClear();
             expect(await run()).toBe(1);
             expect(errorSpy.mock.calls.map(c => c.join(' ')))
                 .toEqual(errors.map(e => `Error: ${e}`));
           }
           pulled();
           expect(await pull()).toBe(0);
         });
  }
});


// A pull changes a local model or profile file only where the catalog
// differs from it. The rest keeps its comments, key order and style, and the
// forms pull would write differently, such as a string `ai_context`, the
// order of entities and metrics, custom ai_context members and
// `metrics_exclude`. So a file that already holds what the catalog holds
// stays byte for byte. A file that does not exist, or that pull cannot change
// that way, is written in full.
describe('a pull after a push', () => {
  const MODEL = `# Hand-written model.
version: "0.2.0.dev0/google"
semantic_model:
  - description: Orders and customers   # before name
    name: commerce
    ai_context: Answer in dollars.
    entities:
      - name: Order
        primary_key: [id]
        ai_context:
          instructions: An order.
          custom: {zeta: 1, alpha: 2}
        fields:
          - { name: id }
          - { name: buyer }
      - name: Customer
        primary_key: [key]
        fields:
          - { name: key, label: Customer ID }   # flow style
    relationships:
      - { name: placed_by, from: Order, to: Customer, from_columns: [buyer], to_columns: [key] }
    metrics:
      - { name: orders, expression: COUNT(Order.id) }
      - { name: customers, expression: COUNT(Customer.key) }
      - { name: buyers, expression: COUNT(Order.buyer) }
`;
  const TABLES = 'bigquery.googleapis.com/projects/test-project/datasets/prod/tables';
  const PROFILE = `# Production bindings.
name: prod
entities:
  - name: Order
    source: ${TABLES}/orders
    primary_key: [id]
    fields: [{ name: id, expression: o_id }, { name: buyer, expression: o_buyer }]
  - name: Customer
    source: ${TABLES}/customer
    primary_key: [key]
    fields: [{ name: key, expression: c_key }]
relationships:
  - { name: placed_by, from_columns: [buyer], to_columns: [key] }
metrics_exclude: [orders, customers]
`;
  // A vanilla-flavor model, which binds each dataset to its table and writes
  // each expression as a list of dialects.
  const ansi = (sql: string) =>
      `{dialects: [{dialect: ANSI_SQL, expression: "${sql}"}]}`;
  const VANILLA = `# Hand-written vanilla model.
version: "0.2.0.dev0"
semantic_model:
  - description: Orders and customers   # before name
    name: commerce
    ai_context: Answer in dollars.
    datasets:
      - name: Order
        source: ${TABLES}/orders
        primary_key: [id]
        ai_context:
          instructions: An order.
          custom: {zeta: 1, alpha: 2}
        fields:
          - { name: id, expression: ${ansi('o_id')} }
          - { name: buyer, expression: ${ansi('o_buyer')} }
      - name: Customer
        source: ${TABLES}/customer
        primary_key: [key]
        fields:
          - { name: key, expression: ${ansi('c_key')} }   # flow style
    relationships:
      - { name: placed_by, from: Order, to: Customer, from_columns: [buyer], to_columns: [key] }
    metrics:
      - { name: orders, expression: ${ansi('COUNT(Order.id)')} }
      - { name: customers, expression: ${ansi('COUNT(Customer.key)')} }
`;

  // Writes `files` into the scope's entry group directory, and pushes them.
  async function pushed(files: Record<string, string>) {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(local(name)), {recursive: true});
      fs.writeFileSync(local(name), text);
    }
    const catalog = fakeCatalog();
    expect(await push({deployment: false})).toBe(0);
    return catalog;
  }

  // Push checks a profile without the model's actions, so a `sql` executor in
  // the model does not count against the profile file.
  const WITH_SQL_ACTION = `${MODEL}    actions:
      - name: CloseBooks
        executor: {sql: {statements: ["UPDATE ledger SET closed = TRUE"]}}
`;
  // Push checks a profile without its own actions too, so a GOOGLE block
  // profile that binds an action the vanilla model cannot declare counts as
  // the catalog's.
  const BLOCK_DATA = {profiles: [{
    name: 'prod',
    entities: [
      {name: 'Order', source: `${TABLES}/orders`, primary_key: ['id'],
       fields: [{name: 'id', expression: 'o_id'},
                {name: 'buyer', expression: 'o_buyer'}]},
      {name: 'Customer', source: `${TABLES}/customer`, primary_key: ['key'],
       fields: [{name: 'key', expression: 'c_key'}]},
    ],
    relationships:
        [{name: 'placed_by', from_columns: ['buyer'], to_columns: ['key']}],
  }]};
  // `model` with a GOOGLE block holding `data`, written by hand over several
  // lines with each entity on one line, and a comment on its `vendor_name`
  // line.
  const withBlock = (data: object, model = VANILLA) => model.replace(
      '    ai_context: Answer in dollars.\n',
      '    ai_context: Answer in dollars.\n    custom_extensions:\n' +
          '      - vendor_name: GOOGLE   # bindings\n        data: |\n' +
          JSON.stringify(data, null, 2)
              .replace(/^ {8}\{[^]*?^ {8}\}/gm,
                       s => s.replace(/\n\s*/g, ' ')
                                .replace(/([{[]) | ([}\]])/g, '$1$2'))
              .replace(/^/gm, '          ') +
          '\n');
  const WITH_BLOCK_ACTION = withBlock({profiles: [{
    ...BLOCK_DATA.profiles[0],
    actions: [{name: 'Refund', executor: null}],
  }]});
  for (const [flavor, files] of [
    ['Google-flavor', {'commerce.yaml': MODEL, 'commerce.profile.prod.yaml': PROFILE}],
    ['vanilla', {'commerce.yaml': VANILLA}],
    ['Google-flavor with a sql action',
     {'commerce.yaml': WITH_SQL_ACTION, 'commerce.profile.prod.yaml': PROFILE}],
    ['vanilla with a GOOGLE block profile that binds an action',
     {'commerce.yaml': WITH_BLOCK_ACTION}],
    // Push stores a sidecar's text with LF line endings and without trailing
    // blank lines, so a sidecar that reads as the catalog's overview keeps its
    // bytes.
    ['Google-flavor and overview sidecar', {
      'commerce.yaml': MODEL,
      'commerce.overview.md':
          '---\ncontentType: MARKDOWN\n---\nTrailing blank lines.\n\n\n',
      'commerce/entities/Customer.overview.md':
          '---\r\ncontentType: MARKDOWN\r\n---\r\n# Customer\r\n\r\nOn Windows.\r\n',
      'commerce/entities/Order.overview.md':
          '---\ncontentType: MARKDOWN\n---\nNo final newline.',
      'commerce/metrics/orders.overview.md': 'No frontmatter.\r\nOn Windows.\r\n',
    }],
  ] as const) {
    test(`that changes nothing keeps the ${flavor} files byte for byte`,
         async () => {
           await pushed(files);
           const logSpy = console.log as Mock<any>;
           logSpy.mockClear();

           expect(await pull()).toBe(0);
           expect(localFiles()).toEqual(
               Object.fromEntries(Object.entries(files).map(
                   ([name, text]) => [local(name), text])));
           for (const name of Object.keys(files)) {
             expect(messages(logSpy)).toContain(`unchanged ${shown(name)}`);
           }
         });
  }

  // Pull writes an action statement on one line, so YAML joins no lines of
  // it and push accepts it again.
  test('a pulled long action statement pushes again', async () => {
    await pushed({
      'commerce.yaml': WITH_SQL_ACTION.replace(
          'UPDATE ledger SET closed = TRUE',
          "UPDATE ledger SET note = CONCAT(note, ' -- closed by the " +
              "nightly job') WHERE closed = FALSE"),
      'commerce.profile.prod.yaml': PROFILE,
    });
    fs.rmSync(local('commerce.yaml'));

    expect(await pull()).toBe(0);
    expect(await push({deployment: false})).toBe(0);
  });

  // A statement that holds a carriage return is written double-quoted, and
  // pull keeps it on one line too.
  test('a pulled statement with a carriage return stays on one line', async () => {
    const statement =
        'UPDATE ledger SET closed = TRUE -- all of them\\r\\nWHERE closed = FALSE';
    await pushed({
      'commerce.yaml': WITH_SQL_ACTION.replace('UPDATE ledger SET closed = TRUE', statement),
      'commerce.profile.prod.yaml': PROFILE,
    });
    fs.rmSync(local('commerce.yaml'));

    expect(await pull()).toBe(0);
    expect(fs.readFileSync(local('commerce.yaml'), 'utf8')).toContain(`- "${statement}"`);
  });

  // Pull keeps a statement that YAML reads as the catalog holds it, and warns
  // when push refuses it.
  test('a kept statement that push refuses draws push\'s error', async () => {
    await pushed({'commerce.yaml': WITH_SQL_ACTION, 'commerce.profile.prod.yaml': PROFILE});
    const kept = WITH_SQL_ACTION.replace(
        '{sql: {statements: ["UPDATE ledger SET closed = TRUE"]}}',
        '\n          sql:\n            statements:\n' +
            '              - UPDATE ledger SET closed = TRUE # all rows');
    fs.writeFileSync(local('commerce.yaml'), kept);
    (console.warn as Mock<any>).mockClear();

    expect(await pull()).toBe(0);
    expect(fs.readFileSync(local('commerce.yaml'), 'utf8')).toBe(kept);
    expect(messages(console.warn)).toContain(
        'has a sql executor whose statement 1 has a comment on the same line');
  });

  // `text` with each pair of `pairs` replaced, each first part found once.
  const edited = (text: string, ...pairs: Array<[string, string]>) =>
      pairs.reduce((t, [from, to]) => {
        expect(t.split(from)).toHaveLength(2);
        return t.replace(from, to);
      }, text);
  // MODEL and PROFILE with an entity, a field, a metric and the profile's
  // entry for the entity added, each new item with a comment.
  const LARGER = edited(
      MODEL,
      ['          - { name: key, label: Customer ID }   # flow style\n',
       '          - { name: key, label: Customer ID }   # flow style\n' +
           '          - { name: since }   # added\n'],
      ['    relationships:\n',
       '      - name: Item   # added\n        primary_key: [sku]\n' +
           '        fields:\n          - { name: sku }\n' +
           '    relationships:\n'],
      ['      - { name: buyers, expression: COUNT(Order.buyer) }\n',
       '      - { name: buyers, expression: COUNT(Order.buyer) }\n' +
           '      - { name: items, expression: COUNT(Item.sku) }   # added\n']);
  const LARGER_PROFILE = edited(
      PROFILE,
      ['    fields: [{ name: key, expression: c_key }]\n',
       '    fields: [{ name: key, expression: c_key }, ' +
           '{ name: since, expression: c_since }]\n' +
           `  - name: Item   # added\n    source: ${TABLES}/item\n` +
           '    primary_key: [sku]\n' +
           '    fields: [{ name: sku, expression: i_sku }]\n']);
  // MODEL and PROFILE after a pull of LARGER and LARGER_PROFILE. Each new item
  // is written in pull's form, and goes after the item it follows in pull's
  // order, where entities, metrics and relationships are sorted by name.
  const ADDED = edited(
      MODEL,
      ['   # flow style\n', '   # flow style\n          - name: since\n'],
      ['    relationships:\n',
       '      - name: Item\n        primary_key:\n          - sku\n' +
           '        fields:\n          - name: sku\n    relationships:\n'],
      ['      - { name: customers, expression: COUNT(Customer.key) }\n',
       '      - { name: customers, expression: COUNT(Customer.key) }\n' +
           '      - name: items\n        entity: Item\n' +
           '        expression: COUNT(Item.sku)\n']);
  const ADDED_PROFILE = edited(
      PROFILE,
      ['{ name: key, expression: c_key }]\n',
       '{ name: key, expression: c_key }, ' +
           '{ name: since, expression: c_since }]\n' +
           `  - name: Item\n    source: ${TABLES}/item\n` +
           '    primary_key:\n      - sku\n' +
           '    fields:\n      - name: sku\n        expression: i_sku\n']);
  const BOTH = (model: string, profile = PROFILE) =>
      ({'commerce.yaml': model, 'commerce.profile.prod.yaml': profile});
  // BLOCK_DATA with `edit` applied to a copy.
  const blockData = (edit: (d: typeof BLOCK_DATA) => void) => {
    const d = structuredClone(BLOCK_DATA);
    edit(d);
    return d;
  };
  // VANILLA with a dataset added, written by hand and in pull's form, and
  // BLOCK_DATA with its binding.
  const withItem = (dataset: string) => edited(
      VANILLA,
      ['    relationships:\n',
       `      - name: Item\n        source: ${TABLES}/item\n${dataset}` +
           '    relationships:\n']);
  const VANILLA_ITEM = withItem(
      `        primary_key: [sku]\n        fields:\n` +
      `          - { name: sku, expression: ${ansi('i_sku')} }\n`);
  const PULLED_ITEM = withItem(
      '        primary_key:\n          - sku\n        fields:\n' +
      '          - name: sku\n            expression:\n' +
      '              dialects:\n                - dialect: ANSI_SQL\n' +
      '                  expression: i_sku\n');
  const ITEM_DATA = blockData(d => d.profiles[0].entities.push({
    name: 'Item', source: `${TABLES}/item`, primary_key: ['sku'],
    fields: [{name: 'sku', expression: 'i_sku'}],
  }));
  // BLOCK_DATA whose profile excludes `metrics`.
  const excluding = (metrics: string[]) => blockData(
      d => Object.assign(d.profiles[0], {metrics_exclude: metrics}));
  // A second profile file, and the files of a model with both profiles.
  const staging = (profile: string) => edited(
      profile, ['# Production bindings.', '# Staging bindings.'],
      ['name: prod', 'name: staging']);
  const ALL = (model: string, profile = PROFILE) => ({
    ...BOTH(model, profile),
    'commerce.profile.staging.yaml': staging(profile),
  });
  // A stale local profile file the catalog does not have. It does not load.
  const STALE = {
    'commerce.profile.dev.yaml':
        'name: dev\nentities: []\nrelationships: []\nmetrics_exclude: [zz]\n',
  };
  // Stale local profile files the layout refuses: one with no profile name in
  // its file name, and one that does not parse.
  const REFUSED = {
    'commerce.profile.yaml': 'name: x\n',
    'commerce.profile.dev.yaml': 'entities: [\n',
  };

  // MODEL with action CloseBooks, whose sql executor runs a statement written
  // as a '|' block and then `second`.
  const STATEMENTS = (second: string) => `${MODEL}    actions:
      - name: CloseBooks
        executor:
          sql:
            statements:
              - |
                UPDATE ledger SET closed = TRUE
              - ${second}
`;
  // MODEL with actions CloseBooks, Reopen, Recheck, Audit and Purge, whose
  // statements are written as `lists` after their `statements:`.
  const ACTIONS = (...lists: string[]) => `${MODEL}    actions:\n${
      ['CloseBooks', 'Reopen', 'Recheck', 'Audit', 'Purge'].map((name, i) => `      - name: ${name}
        executor:
          sql:
            statements:${lists[i]}
`).join('')}`;

  // Each row pushes the catalog's files, writes the local ones in their
  // place, pulls, and gives the files pull leaves. Only what the catalog
  // changes is written, and the rest keeps its comments, key order and style.
  for (const [what, catalog, locals, want] of [
    [
      'one value of a Google model file',
      BOTH(edited(MODEL, ['Orders and customers', 'Sales'])),
      BOTH(MODEL),
      BOTH(edited(MODEL, ['Orders and customers', 'Sales'])),
    ],
    [
      'one value of a vanilla model file',
      {'commerce.yaml': edited(VANILLA, ['Orders and customers', 'Sales'])},
      {'commerce.yaml': VANILLA},
      {'commerce.yaml': edited(VANILLA, ['Orders and customers', 'Sales'])},
    ],
    // A vanilla model's profiles sit in the JSON `data` of its GOOGLE block,
    // which keeps its layout.
    [
      'one profile source in a vanilla model\'s GOOGLE block',
      {'commerce.yaml': withBlock(blockData(
           d => d.profiles[0].entities[0].source = `${TABLES}/orders_v2`))},
      {'commerce.yaml': withBlock(BLOCK_DATA)},
      {'commerce.yaml': withBlock(blockData(
           d => d.profiles[0].entities[0].source = `${TABLES}/orders_v2`))},
    ],
    [
      'an added dataset and its binding in a vanilla model\'s GOOGLE block',
      {'commerce.yaml': withBlock(ITEM_DATA, VANILLA_ITEM)},
      {'commerce.yaml': withBlock(BLOCK_DATA)},
      // The new dataset is written in pull's form, and its binding in the
      // block's layout.
      {'commerce.yaml': withBlock(ITEM_DATA, PULLED_ITEM)},
    ],
    [
      'a removed dataset and its binding in a vanilla model\'s GOOGLE block',
      {'commerce.yaml': withBlock(BLOCK_DATA)},
      {'commerce.yaml': withBlock(ITEM_DATA, VANILLA_ITEM)},
      {'commerce.yaml': withBlock(BLOCK_DATA)},
    ],
    // An unchanged '|' statement keeps its text when the one after it
    // changes.
    [
      'one of two action statements',
      BOTH(STATEMENTS('DELETE FROM ledger WHERE closed = TRUE')),
      BOTH(STATEMENTS('DELETE FROM ledger WHERE closed = FALSE')),
      BOTH(STATEMENTS('DELETE FROM ledger WHERE closed = TRUE')),
    ],
    // A statement pull writes where a comment comes to end it is
    // double-quoted, since push refuses it plain, also when a comment ended it
    // in the local file's flow list or anchor. A statement the local file
    // already writes so and pull leaves alone stays as written.
    [
      'action statements a comment comes to follow',
      BOTH(ACTIONS(
          '\n              - UPDATE ledger SET closed = TRUE' +
              '\n              - DELETE FROM ledger WHERE closed = FALSE',
          '\n              - UPDATE ledger SET closed = TRUE'.repeat(2),
          ' [UPDATE ledger SET closed = TRUE]',
          '\n              - INSERT INTO audit VALUES (1)' +
              '\n              - UPDATE ledger SET closed = TRUE',
          ' [DELETE FROM audit]')),
      BOTH(ACTIONS(
          '\n              [\n                &close UPDATE ledger SET closed = TRUE # as before' +
              '\n              ] # only closed rows\n                # and none reopened',
          '\n              - *close\n                # as CloseBooks did' +
              '\n              -\n                *close # again',
          ' [*close # as Reopen does\n              ]',
          '\n                # close first\n              - UPDATE ledger SET closed = TRUE',
          '\n              - DELETE FROM audit # keep a week')),
      BOTH(ACTIONS(
          '\n              - "UPDATE ledger SET closed = TRUE" # only closed rows' +
              '\n              - "DELETE FROM ledger WHERE closed = FALSE"' +
              '\n                # and none reopened',
          '\n              - "UPDATE ledger SET closed = TRUE"' +
              '\n                # as CloseBooks did' +
              '\n              -\n                "UPDATE ledger SET closed = TRUE" # again',
          ' ["UPDATE ledger SET closed = TRUE" # as Reopen does\n              ]',
          '\n              - "INSERT INTO audit VALUES (1)"' +
              '\n                # close first\n              - UPDATE ledger SET closed = TRUE',
          '\n              - DELETE FROM audit # keep a week')),
    ],
    [
      'one value of a profile file',
      BOTH(MODEL, edited(PROFILE, ['/orders\n', '/orders_v2\n'])),
      BOTH(MODEL),
      BOTH(MODEL, edited(PROFILE, ['/orders\n', '/orders_v2\n'])),
    ],
    [
      'a string ai_context whose instructions changed',
      BOTH(edited(MODEL, ['Answer in dollars.', 'Answer in euros.'])),
      BOTH(MODEL),
      BOTH(edited(
          MODEL,
          ['ai_context: Answer in dollars.',
           'ai_context:\n      instructions: Answer in euros.'])),
    ],
    [
      'an added entity, field, metric and profile entry',
      BOTH(LARGER, LARGER_PROFILE),
      BOTH(MODEL),
      BOTH(ADDED, ADDED_PROFILE),
    ],
    [
      'a removed entity, field, metric and profile entry, with their comments',
      BOTH(MODEL),
      BOTH(LARGER, LARGER_PROFILE),
      BOTH(MODEL),
    ],
    // Each profile file is read on its own, so one that would not load beside
    // another's local text still changes only what differs.
    [
      'a removed entity, field, metric and entry in two profile files',
      ALL(MODEL),
      ALL(LARGER, LARGER_PROFILE),
      ALL(MODEL),
    ],
    [
      'one value of a profile file beside a stale one that does not load',
      BOTH(MODEL, edited(PROFILE, ['/orders\n', '/orders_v2\n'])),
      {...BOTH(MODEL), ...STALE},
      {
        ...BOTH(MODEL, edited(PROFILE, ['/orders\n', '/orders_v2\n'])),
        ...STALE,
      },
    ],
    [
      'one value of a profile file beside stale ones the layout refuses',
      BOTH(MODEL, edited(PROFILE, ['/orders\n', '/orders_v2\n'])),
      {...BOTH(MODEL), ...REFUSED},
      {
        ...BOTH(MODEL, edited(PROFILE, ['/orders\n', '/orders_v2\n'])),
        ...REFUSED,
      },
    ],
  ] as const) {
    test(`changes only ${what}`, async () => {
      await pushed(catalog);
      for (const [name, text] of Object.entries(locals)) {
        fs.writeFileSync(local(name), text);
      }

      expect(await pull()).toBe(0);
      expect(localFiles()).toEqual(Object.fromEntries(
          Object.entries(want).map(([name, text]) => [local(name), text])));
    });
  }

  // When the GOOGLE block's `data` with its layout kept would not hold the
  // catalog's content, `data` is the catalog's, and the rest of the file
  // still keeps its text. Here the change that keeps the layout leaves the
  // file as it is, without the metric the catalog adds.
  test('changes only the rest of a vanilla model when its GOOGLE block ' +
           'data cannot keep its layout',
       async () => {
         const customers =
             `      - { name: customers, expression: ${ansi('COUNT(Customer.key)')} }\n`;
         const buyers = edited(VANILLA, [
           customers,
           customers +
               `      - { name: buyers, expression: ${ansi('COUNT(Order.buyer)')} }\n`,
         ]);
         const moved = (d: typeof BLOCK_DATA) =>
             d.profiles[0].entities[0].source = `${TABLES}/orders_v2`;
         const catalog = excluding(['buyers', 'customers', 'orders']);
         moved(catalog);
         await pushed({'commerce.yaml': withBlock(catalog, buyers)});
         const text = withBlock(excluding(['orders', 'customers']));
         fs.writeFileSync(local('commerce.yaml'), text);
         const warnSpy = console.warn as Mock<any>;
         const real = pullUpdate.updatedText;
         spyOn(pullUpdate, 'updatedText').mockImplementation(
             (text, base, pulled, jsonLayout = true) =>
                 jsonLayout ? text : real(text, base, pulled, jsonLayout));

         expect(await pull()).toBe(0);
         // Pull's `data` sorts the entities by name. Its `metrics_exclude`
         // names every metric, since the local file writes it as a list.
         const pulled = excluding(['buyers', 'customers', 'orders']);
         moved(pulled);
         pulled.profiles[0].entities.reverse();
         expect(messages(warnSpy)).not.toContain('pull cannot change only');
         expect(fs.readFileSync(local('commerce.yaml'), 'utf8'))
             .toBe(edited(
                 text,
                 [text.slice(text.indexOf('        data: |\n'),
                             text.indexOf('    datasets:\n')),
                  `        data: |-\n          ${JSON.stringify(pulled)}\n`],
                 ['    metrics:\n',
                  '    metrics:\n      - name: buyers\n' +
                      '        expression:\n          dialects:\n' +
                      '            - dialect: ANSI_SQL\n' +
                      '              expression: COUNT(Order.buyer)\n' +
                      '        custom_extensions:\n' +
                      '          - vendor_name: GOOGLE\n' +
                      '            data: \'{"entity":"Order"}\'\n']));
       });

  // A local model file push would refuse is written from the catalog. Its
  // profile file still holds the catalog's content beside the model file pull
  // writes, so it stays.
  for (const [why, text, warning] of [
    ['does not load', Buffer.from(`${MODEL}    colour: red\n`),
     `Warning: local model file ${shown('commerce.yaml')} does not load, so ` +
         'pull writes it from the catalog: '],
    ['names another model',
     Buffer.from(MODEL.replace('name: commerce', 'name: other')),
     `Warning: local model file ${shown('commerce.yaml')} names model ` +
         "'other', so pull writes it from the catalog."],
    // The bad byte is in a comment, so the content is the catalog's.
    ['is not valid UTF-8',
     Buffer.concat([Buffer.from('# caf'), Buffer.from([0xe9]),
                    Buffer.from(`\n${MODEL}`)]),
     `Warning: ${shown('commerce.yaml')} is not valid UTF-8, so pull writes ` +
         'it from the catalog.'],
  ] as const) {
    test(`writes the model file in full when it ${why}`,
         async () => {
           await pushed(
               {'commerce.yaml': MODEL, 'commerce.profile.prod.yaml': PROFILE});
           fs.writeFileSync(local('commerce.yaml'), text);
           const warnSpy = console.warn as Mock<any>;

           expect(await pull()).toBe(0);
           if (warning) {
             expect(messages(warnSpy)).toContain(warning);
           } else {
             expect(messages(warnSpy)).not.toContain('does not load');
           }
           expect(fs.readFileSync(local('commerce.yaml'), 'utf8'))
               .not.toContain('# Hand-written model.');
           expect(fs.readFileSync(local('commerce.profile.prod.yaml'), 'utf8'))
               .toBe(PROFILE);
         });
  }

  // A local profile file push or the layout would refuse is written from the
  // catalog, and the model file stays.
  const ONE = `Warning: local profile file ${
      shown('commerce.profile.prod.yaml')} does not load, so pull writes it ` +
      'from the catalog: ';
  for (const [why, profile, warning] of [
    ['names another profile',
     PROFILE.replace('name: prod', 'name: production'), ONE],
    ['excludes a metric the model does not declare',
     PROFILE.replace('[orders, customers]', '[orders, customers, zz]'),
     `${ONE}profile 'prod': metric 'zz'`],
    ['has a key a profile file does not take', `${PROFILE}colour: red\n`,
     `${ONE}`],
    ['declares no name', PROFILE.replace('name: prod\n', ''),
     `${ONE}Profile file 'commerce.profile.prod.yaml' declares no name; ` +
         "add 'name: prod'."],
  ] as const) {
    test(`keeps the model file and writes the profile file in full, with a ` +
             `warning, when the profile file ${why}`,
         async () => {
           await pushed(
               {'commerce.yaml': MODEL, 'commerce.profile.prod.yaml': PROFILE});
           fs.writeFileSync(local('commerce.profile.prod.yaml'), profile);
           const warnSpy = console.warn as Mock<any>;

           expect(await pull()).toBe(0);
           expect(messages(warnSpy)).toContain(warning);
           expect(fs.readFileSync(local('commerce.yaml'), 'utf8')).toBe(MODEL);
           expect(fs.readFileSync(local('commerce.profile.prod.yaml'), 'utf8'))
               .not.toContain('# Production bindings.');
         });
  }

  test('warns and writes a profile file beside a vanilla model file from the ' +
           'catalog',
       async () => {
         // A vanilla model keeps its profiles in its GOOGLE block, so read
         // beside the local model file, the profile file has no text. Push
         // refuses this workspace.
         await pushed(BOTH(MODEL));
         const item = `  - name: Item\n    source: ${TABLES}/item\n` +
             '    primary_key: [sku]\n';
         fs.writeFileSync(local('commerce.yaml'), edited(VANILLA, [
           '    relationships:\n',
           `    ${item.replace(/\n  /g, '\n      ')}        fields:\n` +
               `          - { name: sku, expression: ${ansi('i_sku')} }\n` +
               '    relationships:\n',
         ]));
         fs.writeFileSync(local('commerce.profile.prod.yaml'), edited(PROFILE, [
           'relationships:\n',
           `${item}    fields: [{ name: sku, expression: i_sku }]\n` +
               'relationships:\n',
         ]));

         expect(await pull()).toBe(0);
         expect(messages(console.warn as Mock<any>)).toContain(ONE);
         expect(fs.readFileSync(local('commerce.profile.prod.yaml'), 'utf8'))
             .not.toContain('# Production bindings.');
       });

  // Pull keeps a changed local file only when it holds the catalog's content.
  for (const [why, setup, written] of [
    ['the changed file would not hold the catalog\'s content', async () => {
      await pushed(BOTH(MODEL, edited(PROFILE, ['/orders\n', '/orders_v2\n'])));
      fs.writeFileSync(local('commerce.profile.prod.yaml'), PROFILE);
      // A change that leaves the local text as it is.
      spyOn(pullUpdate, 'updatedText').mockImplementation(text => text);
    }, '/orders_v2'],
    // A writer other than push may leave a profile that binds a field the
    // catalog's model lacks. The local profile file is the catalog's beside
    // the local model file, but it does not load beside the catalog's.
    ['the catalog\'s profile binds a field its model lacks', async () => {
      await pushed(BOTH(LARGER, LARGER_PROFILE));
      const {models: [model]} = await pullKc.pullKnowledgeCatalog(
          new CatalogClient(CTX),
          {project: 'test-project', location: 'us', entryGroup: 'commerce_eg'});
      pulled({...model, entities: model.entities.map(e => e.name === 'Customer' ?
          {...e, fields: e.fields.filter(f => f.name !== 'since')} : e)});
    }, 'c_since'],
  ] as const) {
    test(`writes a profile file whole when ${why}`, async () => {
      await setup();

      expect(await pull()).toBe(0);
      const profile =
          fs.readFileSync(local('commerce.profile.prod.yaml'), 'utf8');
      expect(profile).not.toContain('# Production bindings.');
      expect(profile).toContain(written);
      expect(messages(console.warn as Mock<any>)).toContain(
          'Warning: pull cannot change only the values that differ in ' +
          `${shown('commerce.profile.prod.yaml')}, so it writes the file ` +
          'from the catalog.');
    });
  }

  test('changes a profile file whose metrics_exclude list names every ' +
           'metric only beside the local model file',
       async () => {
         // The catalog adds metric `buyers` and excludes it from prod. The
         // local profile file also binds an entity the catalog's model does
         // not have, so pull reads it beside the local model file, where it
         // excludes every metric just as the catalog's does. The list gets
         // `buyers`.
         await pushed(BOTH(MODEL, PROFILE.replace(
             '[orders, customers]', '[orders, customers, buyers]')));
         fs.writeFileSync(local('commerce.yaml'), edited(
             MODEL,
             ['      - { name: buyers, expression: COUNT(Order.buyer) }\n', ''],
             ['    relationships:\n',
              '      - { name: Item, primary_key: [sku], ' +
                  'fields: [{ name: sku }] }\n    relationships:\n']));
         fs.writeFileSync(local('commerce.profile.prod.yaml'), edited(
             PROFILE,
             ['relationships:\n',
              `  - name: Item\n    source: ${TABLES}/item\n` +
                  '    primary_key: [sku]\n' +
                  '    fields: [{ name: sku, expression: i_sku }]\n' +
                  'relationships:\n']));

         expect(await pull()).toBe(0);
         expect(fs.readFileSync(local('commerce.profile.prod.yaml'), 'utf8'))
             .toBe(PROFILE.replace(
                 '[orders, customers]', '[buyers, orders, customers]'));
         expect(messages(console.warn as Mock<any>))
             .not.toContain('pull cannot change');
       });

  test('writes a profile file that holds the catalog\'s content only beside ' +
           'the local model file',
       async () => {
         // The catalog adds metric `buyers` and excludes it from prod, so prod
         // excludes every metric. Locally prod excludes every metric too, as
         // the local model has no `buyers`.
         await pushed({
           'commerce.yaml': MODEL,
           'commerce.profile.prod.yaml': PROFILE.replace(
               '[orders, customers]', '[orders, customers, buyers]'),
         });
         const older = MODEL.replace(
             '      - { name: buyers, expression: COUNT(Order.buyer) }\n', '');
         fs.writeFileSync(local('commerce.yaml'), older);
         fs.writeFileSync(local('commerce.profile.prod.yaml'), PROFILE);

         expect(await pull()).toBe(0);
         expect(fs.readFileSync(local('commerce.yaml'), 'utf8'))
             .toContain('name: buyers');
         expect(fs.readFileSync(local('commerce.profile.prod.yaml'), 'utf8'))
             .not.toBe(PROFILE);
       });

  // A vanilla model's GOOGLE block profile names every metric in its
  // `metrics_exclude`. The catalog adds metric `buyers` and excludes it there.
  test('adds the metric the catalog adds to a vanilla profile\'s ' +
           'metrics_exclude list',
       async () => {
         await pushed({'commerce.yaml': withBlock(
             excluding(['orders', 'customers', 'buyers']),
             VANILLA + '      - { name: buyers, expression: ' +
                 `${ansi('COUNT(Order.buyer)')} }\n`)});
         const text = withBlock(excluding(['orders', 'customers']));
         fs.writeFileSync(local('commerce.yaml'), text);

         expect(await pull()).toBe(0);
         expect(messages(console.warn as Mock<any>))
             .not.toContain('pull cannot change');
         const written = fs.readFileSync(local('commerce.yaml'), 'utf8');
         // The block's JSON keeps its text up to the list.
         const block = text.slice(text.indexOf('        data: |\n'),
                                  text.indexOf('"metrics_exclude"'));
         for (const kept of ['# Hand-written vanilla model.', '# bindings',
                             '# flow style', 'name: buyers', block]) {
           expect(written).toContain(kept);
         }
         const [, excluded] =
             /"metrics_exclude":\s*(\[[^\]]*\])/.exec(written)!;
         expect(JSON.parse(excluded).sort())
             .toEqual(['buyers', 'customers', 'orders']);
       });
});


describe('a pull', () => {
  test('writes the model, profile and sidecar files, skips a name push does ' +
           'not read, and names or deletes stale ones',
       async () => {
         withStaleProfile();
         // With no local model file, pull writes the one it builds.
         fs.rmSync(local('commerce.yaml'));
         const staleSidecar = 'commerce/metrics/old.overview.md';
         fs.mkdirSync(path.dirname(local(staleSidecar)), {recursive: true});
         fs.writeFileSync(local(staleSidecar), 'Old.\n');
         const warnSpy = console.warn as Mock<any>;
         const skipped = [
           // Push reads no sidecar at these paths.
           'commerce/notes/x', 'commerce/entities/a/b',
           // An absolute name, one that climbs out, one with a backslash `..`
           // segment, and another model's.
           '/tmp/commerce', 'commerce/../../escaped',
           'commerce/entities/..\\..\\escaped', 'other',
         ];
         const overviews = new Map<string, OverviewSidecar>([
           ['commerce', {content: '# Commerce\n', contentType: 'HTML',
                         links: [{url: 'https://x.test'}]}],
           ['commerce/entities/Customer', {content: 'A buyer.\n'}],
           ['commerce/metrics/Revenue', {content: 'Money in.\n'}],
           ['commerce/relationships/placed', {content: 'Orders.\n'}],
           ...skipped.map(id => [id, {content: 'x\n'}] as const),
         ]);
         const stub = pulled(SECOND_GEN, overviews);
         // The catalog holds no profile's actions, so the local ones stay.
         const actions = [{name: 'refund', executor: null}];
         fs.writeFileSync(local('commerce.profile.prod.yaml'),
                          'name: prod\nactions: [{name: refund, executor: null}]\n');
         const files = serializedFiles(
             {...SECOND_GEN, profiles: [{...SECOND_GEN.profiles![0], actions}]});

         expect(await pull()).toBe(0);
         // Sources only in profile files draw no missing-source warning.
         expect(messages(warnSpy)).not.toMatch(/no source|no expression/);
         expect(Object.keys(files)).toHaveLength(2);
         for (const [name, text] of [
                ...Object.entries(files),
                ['commerce.overview.md',
                 '---\ncontentType: HTML\nlinks:\n  - url: https://x.test\n' +
                     '---\n# Commerce\n'],
                ['commerce/entities/Customer.overview.md', 'A buyer.\n'],
                ['commerce/metrics/Revenue.overview.md', 'Money in.\n'],
                ['commerce/relationships/placed.overview.md', 'Orders.\n'],
              ]) {
           expect(fs.readFileSync(local(name), 'utf8')).toBe(text);
         }
         for (const id of skipped) {
           expect(messages(warnSpy))
               .toContain(
                   `Warning: skipped '${id}.overview.md' from the catalog; ` +
                   `pull writes only 'commerce.yaml', ` +
                   `'commerce.profile.<name>.yaml' and overview sidecars ` +
                   `inside the entry group directory.`);
         }
         for (const name of ['commerce/notes/x.overview.md',
                             'commerce/entities/a/b.overview.md',
                             'other.overview.md']) {
           expect(fs.existsSync(local(name))).toBe(false);
         }
         expect(fs.readdirSync(path.join(dir, 'catalog', 'EntryGroups')))
             .toEqual(['commerce_eg']);
         for (const [kind, name] of [['profile file', 'commerce.profile.dev.yaml'],
                                     ['overview sidecar', staleSidecar]]) {
           expect(messages(warnSpy))
               .toContain(`local ${kind} ${shown(name)} is not in the catalog`);
           expect(fs.existsSync(local(name))).toBe(true);
         }

         expect(await pull({forceRemove: true})).toBe(0);
         expect(fs.existsSync(local('commerce.profile.dev.yaml'))).toBe(false);
         expect(fs.existsSync(local(staleSidecar))).toBe(false);

         // A vanilla model declares no action, so its profiles get none.
         stub.mockResolvedValue({models: [{...SECOND_GEN, version: '0.2.0.dev0'}],
                                 warnings: []});
         expect(await pull()).toBe(0);
         expect(fs.readFileSync(local('commerce.yaml'), 'utf8'))
             .not.toContain('refund');
       });

  // Under --force-remove the summary counts the files pull removes, and pull
  // removes each directory it leaves empty, a legacy profile directory with
  // two files included.
  test('under --force-remove counts the files it removes and removes the ' +
           'directories it empties',
       async () => {
         writeRoundTripWorkspace();
         fs.rmSync(local('commerce.profile.prod.yaml'));
         fs.renameSync(local('commerce.yaml'), local('sales.yaml'));
         for (const name of ['sales.overview.md',
                             'sales/entities/Customer.overview.md',
                             'sales.profiles/a.yaml', 'sales.profiles/b.yaml']) {
           fs.mkdirSync(path.dirname(local(name)), {recursive: true});
           fs.writeFileSync(local(name), 'Old.\n');
         }
         const logSpy = console.log as Mock<any>;
         pulled();

         expect(await pull({dryRun: true, forceRemove: true})).toBe(0);
         expect(messages(logSpy)).toContain(
             'Dry run: would write 2 new and 0 updated file(s); would remove ' +
             '5 file(s).');
         expect(await pull({forceRemove: true})).toBe(0);
         expect(messages(logSpy)).toContain(
             'Wrote 2 new and 0 updated file(s); removed 5 file(s).');
         expect(fs.readdirSync(entryGroupDir()).sort())
             .toEqual(['commerce.profile.prod.yaml', 'commerce.yaml']);
       });

  // Writes catalog.yaml, and pulls `model` with `options`.
  const pullModel = (model = SECOND_GEN, options: {dryRun?: boolean} = {}) => {
    fs.writeFileSync(path.join(dir, 'catalog.yaml'),
                     'scope: semantic-model.test-project.us.commerce_eg\n');
    pulled(model);
    return pull(options);
  };
  // Pulls `model`, and checks that pull writes its model file, warns with
  // push's `error` when there is one, and reads no table's SQL dialect.
  const checkPull = async (model: SemanticModel, error: string) => {
    expect(await pullModel(model)).toBe(0);
    expect(fs.readFileSync(local('commerce.yaml'), 'utf8'))
        .toBe(serializedFiles(model)['commerce.yaml']);
    expect(messages(console.warn)).toBe(error && `Warning: push refuses ${
        shown('commerce.yaml')} as pull writes it: ${error}`);
    expect(SpannerClient.prototype.getDatabase).not.toHaveBeenCalled();
    expect(CatalogClient.prototype.lookupEntry).not.toHaveBeenCalled();
  };
  // The tables of a Spanner database and of a Cloud SQL database.
  const SPANNER = 'spanner.googleapis.com/projects/test-project/instances/i/' +
      'databases/db/tables';
  const CLOUDSQL = 'cloudsql.googleapis.com/projects/test-project/locations/' +
      'us-central1/instances/i/databases/shop/tables';
  // Entity `name` on table `source`, whose fields read the columns of their
  // names.
  const onTable = (name: string, source: string, fields: string[]) => ({
    name, dataSource: source, keys: ['id'],
    fields: fields.map(f => ({name: f, expression: f, stringForm: true})),
  });
  // Metric `name`, on `entity` when one is given.
  const metric = (name: string, expression: string, entity?: string) =>
      ({name, expression, stringForm: true,
        ...(entity ? {entity, authoredEntity: entity} : {})});

  // Another writer may delete an entry the model needs, such as an entity
  // another one extends or a metric reads. Pull still writes the model file,
  // and warns with push's first error.
  for (const [what, model, error] of [
    ['an entity another extends',
     {...SECOND_GEN, entities: [{...SECOND_GEN.entities[0], extends: ['Named']}]},
     "model 'commerce' (commerce): entity 'Customer' extends unknown entity " +
         "'Named'; it is not defined in the model. Checks that need the " +
         'resolved model are skipped until this is fixed.'],
    ['an entity a metric reads',
     {...SECOND_GEN, metrics: [{name: 'm', expression: 'COUNT(Gone.id)'}]},
     "metric 'm' in model 'commerce' (commerce): 'Gone.id' has qualifier " +
         "'Gone', which is not a declared entity in model 'commerce'; write " +
         "'entity.field' starting with a declared entity."],
    // Pull reads no Spanner table's dialect, and still checks the fields a
    // profile field reads.
    ['a field a profile field reads',
     {...SECOND_GEN, profiles: [{...SECOND_GEN.profiles![0], entities: [{
       name: 'Customer', source: `${SPANNER}/customer`,
       fields: [{name: 'id', expression: 'Customer.gone * 2', stringForm: true}],
     }]}]},
     "[commerce.profile.prod.yaml] profile 'prod': field 'Customer.id' reads " +
         "'Customer.gone', which is not a field of 'Customer'."],
    // The catalog lists its profiles in its own order. Push lists them by
    // name.
    ['the profile a deployment names',
     {...SECOND_GEN,
      profiles: ['staging', 'dev'].map(name => ({...SECOND_GEN.profiles![0], name})),
      deployments: [{name: 'qa', target: 'bigquery.googleapis.com/projects/' +
                         'test-project/datasets/d/propertyGraphs/g',
                     profile: 'missing'}]},
     "[commerce] model 'commerce': deployment 'qa' names unknown binding " +
         "profile 'missing'; defined profiles: dev, staging."],
  ] as Array<[string, SemanticModel, string]>) {
    test(`warns when push refuses the model file it writes without ${what}`,
         () => checkPull(model, error));
  }

  // With no table's dialect read, pull still reads which fields and entities
  // an ANSI_SQL expression reads, and warns as push refuses. It leaves to push
  // a text that one of the dialects the table may have cannot parse.
  for (const [kind, source] of [
    ['Spanner', `${SPANNER}/orders`],
    ['Cloud SQL', `${CLOUDSQL}/orders`],
    ['third-party', 'projects/test-project/locations/us/entryGroups/snow/' +
         'entries/orders'],
  ]) {
    for (const [what, fields, expression, error] of [
      ['a field', ['id'], 'SUM(Order.amount)',
       "expression references 'Order.amount', but entity 'Order' has no " +
           "field 'amount'; metric expressions must reference declared " +
           'fields, not physical columns.'],
      ['an entity', ['id', 'amount'], 'SUM(Order.amount) + COUNT(Gone.id)',
       "'Gone.id' has qualifier 'Gone', which is not a declared entity in " +
           "model 'commerce'; write 'entity.field' starting with a declared " +
           'entity.'],
      // MySQL and Spanner GoogleSQL read "Order" as a string, so they cannot
      // parse this text.
      ['a field beside quoted names', ['id'],
       'COUNT("Order"."id") + SUM(Order.amount)', ''],
    ] as Array<[string, string[], string, string]>) {
      test(`on a ${kind} table ${error ? 'warns' : 'gives no warning'} ` +
               `about ${what} a metric reads that the catalog lacks`,
           () => checkPull({
             name: 'commerce', relationships: [],
             entities: [onTable('Order', source, fields)],
             metrics: [metric('m', expression, 'Order')],
           }, error && `metric 'm' in model 'commerce' (commerce): ${error}`));
    }
  }

  // A Spanner database reads an action's statement as GoogleSQL or as
  // PostgreSQL. With no table's dialect read, pull warns only about a
  // statement push refuses under both: for a rule both find it breaks, in
  // GoogleSQL's words, or else for what GoogleSQL finds.
  for (const [what, statement, error] of [
    // PostgreSQL reads `$$@raw$$` as a string.
    ['a parameter only GoogleSQL reads that the action does not declare',
     'UPDATE orders SET note = $$@raw$$ WHERE id = @id', ''],
    // GoogleSQL reads `#` as the start of a comment.
    ['a parameter only PostgreSQL reads that the action does not declare',
     'UPDATE orders SET flags = flags # 1 WHERE id = @missing', ''],
    // GoogleSQL matches `@ID` to `id`, and PostgreSQL does not.
    ['a parameter GoogleSQL matches in another case',
     'UPDATE orders SET note = @ID WHERE id = @id', ''],
    ['a parameter both read that the action does not declare',
     'UPDATE orders SET note = @note WHERE id = @id',
     "has a sql executor whose statement 1 binds '@note', but action 'tag' " +
         'declares no parameter of that name.'],
    // PostgreSQL reads `#` as an operator, so it finds no verb outside the
    // parenthesis.
    ['a MERGE after a `#` line, which each reads in its own words',
     '# (\nMERGE INTO orders t USING src s ON t.id = s.id WHEN MATCHED THEN DELETE',
     "has a sql executor whose statement 1 starts with 'MERGE', but a " +
         'statement must be one of INSERT, UPDATE, DELETE.'],
    // GoogleSQL reads the line as a comment, and PostgreSQL reads a DELETE
    // that binds `@missing`.
    ['a statement GoogleSQL refuses for its verb and PostgreSQL for a parameter',
     '# DELETE FROM orders WHERE id = @missing',
     'has a sql executor whose statement 1 has no readable DML verb, but a ' +
         'statement must be one of INSERT, UPDATE, DELETE.'],
  ]) {
    test(`on a Spanner table ${error ? 'warns' : 'gives no warning'} about ` +
             what,
         () => checkPull({
           name: 'commerce', relationships: [], metrics: [],
           entities: [onTable('Order', `${SPANNER}/orders`, ['id'])],
           actions: [{
             name: 'tag', parameters: [{name: 'id', type: 'String'}],
             executor: {kind: 'sql', sql: {statements: [statement]}},
           }],
         }, error && `action 'tag' in model 'commerce' (commerce) ${error}`));
  }

  // GoogleSQL reads `id` and `ID` as one name, and PostgreSQL does not.
  test('on a Spanner table gives no warning about two parameter names that ' +
           'differ only in case',
       () => checkPull({
         name: 'commerce', relationships: [], metrics: [],
         entities: [onTable('Order', `${SPANNER}/orders`, ['id'])],
         actions: [{
           name: 'tag',
           parameters: [{name: 'id', type: 'String'}, {name: 'ID', type: 'Integer'}],
           executor: {kind: 'sql', sql: {statements: ['UPDATE orders SET note = @ID WHERE id = @id']}},
         }],
       }, ''));

  // A table's dialect may read an unqualified name as a keyword and a name in
  // double quotes as a string, so pull skips both. A metric text that loses a
  // name is not judged on the entities it reaches.
  test('skips the names whose reading depends on the table\'s dialect',
       () => checkPull({
         name: 'commerce', relationships: [],
         entities: ['Order', 'Customer'].map(
             name => onTable(name, `${SPANNER}/${name}`, ['id', 'amount'])),
         metrics: [
           metric('m1', 'MAX(DATE_TRUNC(month, Order.amount)) + ' +
                      'COUNT("Gone"."id")', 'Order'),
           metric('m2', 'COUNT("Order"."id")'),
           metric('m3', 'COUNT("Order"."id") + COUNT(Customer.id)', 'Order'),
         ],
       }, ''));

  // Reading a table's SQL dialect calls Spanner or Knowledge Catalog, so pull
  // leaves the checks that need one to push.
  test('reads no table\'s SQL dialect', () => {
    const [entity] = SECOND_GEN.entities;
    const [prod] = SECOND_GEN.profiles!;
    return checkPull({
      ...SECOND_GEN,
      entities: [{...entity, dataSource: `${SPANNER}/customer`}],
      profiles: [{...prod, entities: [
        {...prod.entities[0], source: `${CLOUDSQL}/customer`},
      ]}],
    }, '');
  });

  // A local model file that holds the catalog's model under another name is
  // kept by renaming it and its profile files, unless a file the rename
  // writes is there already, an earlier file is renamed to it, or two of its
  // files would be renamed to one. The refusal names what to do, and writes
  // nothing.
  const holds = "Error: local model file 'mysales.yaml' holds model 'commerce', ";
  test.each([
    ['the rename that keeps it', ['mysales.yaml'],
     holds + "which pull writes as 'commerce.yaml'. Rename the file to " +
         "'commerce.yaml' to keep it, or re-run with --force-remove to " +
         "delete it and pull the catalog's.", 'commerce'],
    ['the rename of each profile file', ['mysales.yaml', 'mysales.profile.prod.yaml'],
     holds + "which pull writes as 'commerce.yaml'. Rename the file to " +
         "'commerce.yaml' and 'mysales.profile.prod.yaml' to " +
         "'commerce.profile.prod.yaml' to keep them, or re-run with " +
         "--force-remove to delete them and pull the catalog's.", 'commerce'],
    ['the rename of each file in the older profile directory',
     ['mysales.yaml', 'mysales.profiles/prod.yaml'],
     holds + "which pull writes as 'commerce.yaml'. Rename the file to " +
         "'commerce.yaml' and 'mysales.profiles/prod.yaml' to " +
         "'commerce.profile.prod.yaml' to keep them, or re-run with " +
         "--force-remove to delete them and pull the catalog's.", 'commerce'],
    ['no two renames onto one profile file',
     ['mysales.yaml', 'mysales.profile.prod.yaml', 'mysales.profiles/prod.yaml'],
     holds + "and its profile 'prod' is in both 'mysales.profile.prod.yaml' " +
         "and 'mysales.profiles/prod.yaml'. Delete one of them, or re-run " +
         "with --force-remove to delete 'mysales.yaml', " +
         "'mysales.profile.prod.yaml' and 'mysales.profiles/prod.yaml' and " +
         "pull the catalog's.", 'commerce'],
    ['no rename onto the catalog model\'s file',
     ['commerce.yaml', 'mysales.yaml', 'mysales.profile.prod.yaml'],
     holds + "which 'commerce.yaml' also holds. Delete one of them with its " +
         "profile files, or re-run with --force-remove to delete " +
         "'mysales.yaml' and 'mysales.profile.prod.yaml' and pull the " +
         "catalog's.", 'commerce'],
    ['no second rename onto one file', ['mysales.yaml', 'sales2.yaml'],
     holds + "which pull writes as 'commerce.yaml'. Rename the file to " +
         "'commerce.yaml' to keep it, or re-run with --force-remove to " +
         "delete it and pull the catalog's.\nError: local model file " +
         "'sales2.yaml' holds model 'commerce', which 'mysales.yaml' also " +
         "holds. Delete one of them, or re-run with --force-remove to " +
         "delete 'sales2.yaml' and pull the catalog's.", 'commerce'],
    ['the profile files of the file that also holds it',
     ['commerce.yaml', 'commerce.profile.prod.yaml', 'mysales.yaml'],
     holds + "which 'commerce.yaml' also holds. Delete one of them with its " +
         "profile files, or re-run with --force-remove to delete " +
         "'mysales.yaml' and pull the catalog's.", 'commerce'],
    ['no rename onto a profile file already there',
     ['mysales.yaml', 'mysales.profile.prod.yaml', 'commerce.profile.prod.yaml'],
     holds + "which pull writes as 'commerce.yaml', and " +
         "'commerce.profile.prod.yaml' is already there. Delete one of them " +
         "with its profile files, or re-run with --force-remove to delete " +
         "'mysales.yaml' and 'mysales.profile.prod.yaml' and pull the " +
         "catalog's.", 'commerce'],
    ['no rename onto a file that holds another model',
     ['commerce.yaml', 'commerce.profile.prod.yaml', 'mysales.yaml'],
     holds + "which pull writes as 'commerce.yaml', and 'commerce.yaml' is " +
         "already there. Delete one of them with its profile files, or " +
         "re-run with --force-remove to delete 'mysales.yaml' and pull the " +
         "catalog's.",
     {'commerce.yaml': 'other', 'mysales.yaml': 'commerce'} as Record<string, string>],
    ['the model a file declares under another name', ['old.yaml'],
     "Error: local model(s) 'other' in 'old.yaml' do not match the catalog " +
         "model 'commerce' in this entry group. An entry group holds one " +
         "model, so pull will not leave two behind. Re-run with " +
         "--force-remove to delete the local model(s) and pull the " +
         "catalog's.", 'other'],
  ])('refuses a local file that holds another model name, naming %s',
     async (_, files, error, declares) => {
       writeRoundTripWorkspace();
       for (const f of fs.readdirSync(entryGroupDir())) fs.rmSync(local(f));
       for (const f of files) {
         fs.mkdirSync(path.dirname(local(f)), {recursive: true});
         fs.writeFileSync(local(f), f.includes('.profile') ?
             ROUND_TRIP_PROFILE :
             ROUND_TRIP_MODEL.replace('name: commerce', `name: ${
                 typeof declares === 'string' ? declares : declares[f]}`));
       }
       pulled();

       expect(await pull()).toBe(1);
       expect(messages(console.error)).toBe(error);
       const left = fs.readdirSync(
           entryGroupDir(), {encoding: 'utf8', recursive: true});
       expect(left.filter(f => f.endsWith('.yaml')).sort())
           .toEqual([...files].sort());
     });

  test('under --dry-run nothing is written or deleted', async () => {
    withStaleProfile();
    // Push rejects this sidecar, which the catalog's overview replaces, so it
    // draws no warning.
    const sidecar = '---\nfoo: bar\n---\nOld.\n';
    fs.writeFileSync(local('commerce.overview.md'), sidecar);
    pulled(SECOND_GEN, new Map([['commerce', {content: 'New.\n'}]]));

    expect(await pull({dryRun: true, forceRemove: true})).toBe(0);
    expect(fs.readFileSync(local('commerce.yaml'), 'utf8'))
        .toBe(ROUND_TRIP_MODEL);
    expect(fs.readFileSync(local('commerce.profile.prod.yaml'), 'utf8'))
        .toBe('name: prod\n');
    expect(fs.existsSync(local('commerce.profile.dev.yaml'))).toBe(true);
    expect(fs.readFileSync(local('commerce.overview.md'), 'utf8'))
        .toBe(sidecar);
    expect(messages(console.warn)).not.toContain('push refuses');
  });

  // Pull writes its files as UTF-8, so --dry-run does not read the bytes of a
  // file it has not written yet.
  test('under --dry-run gives no warning for text that holds U+FFFD',
       async () => {
         expect(await pullModel(
             {...SECOND_GEN, description: 'Replaced \uFFFD char'},
             {dryRun: true})).toBe(0);
         expect(messages(console.warn)).not.toContain('push refuses');
       });

  // Pull keeps a local sidecar the catalog lacks, and push reads it, so
  // --dry-run warns about one push rejects, as the real pull does.
  test('under --dry-run warns about a kept local sidecar push rejects',
       async () => {
         const sidecar = 'commerce/entities/Customer.overview.md';
         fs.mkdirSync(path.dirname(local(sidecar)), {recursive: true});
         fs.writeFileSync(local(sidecar), '---\nfoo: bar\n---\nOld.\n');

         expect(await pullModel(SECOND_GEN, {dryRun: true})).toBe(0);
         expect(messages(console.warn)).toBe(
             `Warning: local overview sidecar ${shown(sidecar)} is not in ` +
             `the catalog; delete it, or pull with --force-remove to delete ` +
             `it.\nWarning: push refuses ${shown('commerce.yaml')} as pull ` +
             `writes it: Overview sidecar '${sidecar}': its frontmatter ` +
             `holds only contentType and links, not 'foo'.`);
       });

  test('profile files are written and deleted through the layout', async () => {
    withStaleProfile();
    const write = spyOn(SemanticModelLayout.prototype, 'writeProfileDocument');
    const remove = spyOn(SemanticModelLayout.prototype, 'removeProfileDocument');
    pulled();

    expect(await pull({forceRemove: true})).toBe(0);
    expect(write.mock.calls).toEqual([
      ['commerce', 'prod', serializedFiles()['commerce.profile.prod.yaml']],
    ]);
    expect(remove.mock.calls).toEqual([['commerce', 'dev']]);
  });

  // A teammate converts the model to the vanilla flavor, whose profiles sit in
  // its GOOGLE block, and pushes. Pull writes that model file beside the local
  // sibling profile file.
  test('a local sibling profile file beside a pulled vanilla model file is ' +
           'named, and deleted under --force-remove',
       async () => {
         writeRoundTripWorkspace();
         const vanilla: SemanticModel = {...SECOND_GEN, version: '0.2.0.dev0'};
         pulled(vanilla);

         expect(await pull()).toBe(0);
         expect(messages(console.warn))
             .toContain(
                 `local profile file ${shown('commerce.profile.prod.yaml')} ` +
                 `is not in the catalog`);
         expect(fs.existsSync(local('commerce.profile.prod.yaml'))).toBe(true);

         expect(await pull({forceRemove: true})).toBe(0);
         expect(fs.readdirSync(entryGroupDir())).toEqual(['commerce.yaml']);
         expect(fs.readFileSync(local('commerce.yaml'), 'utf8'))
             .toBe(serializedFiles(vanilla)['commerce.yaml']);
       });

  // Push refuses the older directory, so a file left there is stale too. The
  // dry run reads the disk before any write and the real run after, and both
  // report the same removal.
  test('a profile file left in the older directory is removed by a dry run ' +
           'and a real run alike',
       async () => {
         writeRoundTripWorkspace();
         fs.rmSync(local('commerce.profile.prod.yaml'));
         fs.mkdirSync(local('commerce.profiles'));
         fs.writeFileSync(local('commerce.profiles/prod.yaml'), 'legacy\n');
         const logSpy = console.log as Mock<any>;
         pulled();

         expect(await pull({dryRun: true, forceRemove: true})).toBe(0);
         expect(messages(logSpy))
             .toContain(`would remove ${shown('commerce.profiles/prod.yaml')}`);
         expect(fs.existsSync(local('commerce.profiles/prod.yaml'))).toBe(true);

         expect(await pull({forceRemove: true})).toBe(0);
         expect(messages(logSpy))
             .toContain(`  removed ${shown('commerce.profiles/prod.yaml')}`);
         expect(fs.existsSync(local('commerce.profiles/prod.yaml'))).toBe(false);
         expect(fs.readFileSync(local('commerce.profile.prod.yaml'), 'utf8'))
             .toBe(serializedFiles()['commerce.profile.prod.yaml']);
       });

  // Push refuses a profile file with no model beside it, so a local model the
  // catalog does not name goes with its profile files.
  test('under --force-remove a stale local model goes with its profile files',
       async () => {
         writeRoundTripWorkspace();
         fs.renameSync(local('commerce.yaml'), local('old.yaml'));
         fs.renameSync(
             local('commerce.profile.prod.yaml'), local('old.profile.prod.yaml'));
         pulled();

         expect(await pull({forceRemove: true})).toBe(0);
         expect(fs.readdirSync(entryGroupDir()).sort())
             .toEqual(['commerce.profile.prod.yaml', 'commerce.yaml']);
       });

  test('the summary counts new, updated and unchanged files apart, and an ' +
           'unchanged file is not rewritten',
       async () => {
         const model: SemanticModel = {
           ...SECOND_GEN,
           profiles: ['dev', 'prod', 'qa'].map(
               name => ({...SECOND_GEN.profiles![0], name})),
         };
         const files = serializedFiles(model);
         writeRoundTripWorkspace();
         fs.rmSync(local('commerce.profile.prod.yaml'));
         fs.writeFileSync(local('commerce.yaml'), 'an older model file\n');
         fs.writeFileSync(local('commerce.profile.dev.yaml'),
                          files['commerce.profile.dev.yaml']);
         const logSpy = console.log as Mock<any>;
         pulled(model);
         const written = spyOn(fs, 'writeFileSync');

         expect(await pull()).toBe(0);
         const out = messages(logSpy);
         for (const [state, name] of [
                ['updated', 'commerce.yaml'],
                ['unchanged', 'commerce.profile.dev.yaml'],
                ['created', 'commerce.profile.prod.yaml'],
                ['created', 'commerce.profile.qa.yaml'],
              ]) {
           expect(out).toContain(`  ${state} ${shown(name)}`);
         }
         expect(out).toContain(
             'Wrote 2 new and 1 updated file(s); 1 unchanged.');
         expect(written.mock.calls.map(c => String(c[0]))).not.toContain(
             shown('commerce.profile.dev.yaml'));
       });

  // The model name comes from the catalog's model entry, which another
  // writer may have named so.
  test('a model name holding a path separator gets a flat model file',
       async () => {
         fs.writeFileSync(
             path.join(dir, 'catalog.yaml'),
             'scope: semantic-model.test-project.us.commerce_eg\n');
         fs.mkdirSync(entryGroupDir(), {recursive: true});
         const model = {...SECOND_GEN, name: 'sub/retail'};
         pulled(model);

         expect(await pull()).toBe(0);
         expect(fs.readdirSync(entryGroupDir())).toEqual(['sub_retail.yaml']);
         expect(fs.readFileSync(local('sub_retail.yaml'), 'utf8'))
             .toBe(serializedFiles(model)['sub/retail.yaml']);
         // Its profile file has no flat name to go to.
         expect(messages(console.warn))
             .toContain(`skipped 'sub/retail.profile.prod.yaml' from the catalog`);
       });

  test('a model whose catalog name is an absolute path writes nothing',
       async () => {
         fs.writeFileSync(
             path.join(dir, 'catalog.yaml'),
             'scope: semantic-model.test-project.us.commerce_eg\n');
         fs.mkdirSync(entryGroupDir(), {recursive: true});
         const abs = path.join(dir, 'abs', 'retail');
         pulled({...SECOND_GEN, name: abs});

         expect(await pull()).toBe(0);
         for (const name of [`${abs}.yaml`, `${abs}.profile.prod.yaml`]) {
           expect(messages(console.warn))
               .toContain(`skipped '${name}' from the catalog`);
         }
         expect(fs.readdirSync(entryGroupDir())).toEqual([]);
         expect(fs.existsSync(path.dirname(abs))).toBe(false);
       });

  // The model name comes from the catalog's model entry, which another
  // writer may have named so.
  test('a model name with a `..` segment reaches no profile file outside ' +
           'the entry group',
       async () => {
         fs.writeFileSync(
             path.join(dir, 'catalog.yaml'),
             'scope: semantic-model.test-project.us.commerce_eg\n');
         fs.mkdirSync(entryGroupDir(), {recursive: true});
         const outside =
             path.join(dir, 'catalog', 'EntryGroups', 'other', 'retail.profiles');
         fs.mkdirSync(outside, {recursive: true});
         fs.writeFileSync(path.join(outside, 'prod.yaml'), 'name: prod\n');
         pulled({...SECOND_GEN, name: '../other/retail'});

         expect(await pull({forceRemove: true})).toBe(0);
         expect(fs.existsSync(path.join(outside, 'prod.yaml'))).toBe(true);
       });

  test('a pull of an entry group only an older kcmd pushed exits 0, writes ' +
           'no model, and names what it left out',
       async () => {
         const {project, location, entryGroup} = FIRST_GEN_OPTS;
         fs.writeFileSync(
             'catalog.yaml',
             `scope: semantic-model.${project}.${location}.${entryGroup}\n`);
         const {entries} = fakeCatalog();
         for (const e of firstGenEntries()) entries.set(e.name, e);
         // Pull reads no entry link.
         const links = spyOn(CatalogClient.prototype, 'lookupEntryLinks');
         const logSpy = console.log as Mock<any>;
         const warnSpy = console.warn as Mock<any>;

         expect(await pull()).toBe(0);
         expect(messages(warnSpy)).toBe(
             `Warning: model 'shop' in entry group '${entryGroup}' was pushed ` +
             `by an older kcmd (first-generation aspects: semantic-model, ` +
             `semantic-entity, semantic-metric). Pull wrote nothing for it; ` +
             `push it again with the current kcmd`);
         expect(messages(logSpy)).toContain('Wrote nothing.');
         expect(links).not.toHaveBeenCalled();
         expect(fs.existsSync(path.join('catalog', 'EntryGroups', entryGroup)))
             .toBe(false);
       });

  test('a pull that leaves out a model an older kcmd pushed deletes no ' +
           'local file, even under --force-remove',
       async () => {
         writeRoundTripWorkspace();
         const shop = new Map([
           ['shop.yaml', FIRST_GEN_MODEL_FILE],
           ['shop.overview.md', 'The shop.\n'],
           ['shop/entities/orders.overview.md', 'An order.\n'],
         ]);
         for (const [name, text] of shop) {
           fs.mkdirSync(path.dirname(local(name)), {recursive: true});
           fs.writeFileSync(local(name), text);
         }
         const commerce = fs.readFileSync(local('commerce.yaml'), 'utf8');
         const warnSpy = console.warn as Mock<any>;
         // What pullKnowledgeCatalog returns for a group
         // holding only the captured first-generation model: no model, and
         // the one it left out with its warning.
         const warning = 'model \'shop\' in entry group \'commerce_eg\' was ' +
             'pushed by an older kcmd (first-generation aspects: ' +
             'semantic-model, semantic-entity, semantic-metric). Pull wrote ' +
             'nothing for it; push it again with the current kcmd';
         spyOn(pullKc, 'pullKnowledgeCatalog').mockResolvedValue({
           models: [],
           warnings: [warning],
           firstGeneration: [{
             name: 'shop',
             entries: firstGenEntries().filter(e => [
               'semantic-model', 'semantic-entity', 'semantic-metric'
             ].some(t => e.entryType.endsWith(`/entryTypes/${t}`))),
           }],
         });

         for (const forceRemove of [false, true]) {
           expect(await pull({forceRemove})).toBe(0);
           for (const [name, text] of shop) {
             expect(fs.readFileSync(local(name), 'utf8')).toBe(text);
           }
           expect(fs.readFileSync(local('commerce.yaml'), 'utf8'))
               .toBe(commerce);
         }
         expect(console.error).not.toHaveBeenCalled();
         expect(messages(warnSpy))
             .toBe(`Warning: ${warning}\nWarning: ${warning}`);
       });
});


// An older kcmd stored a copy of each model and profile file under the
// model's `.files.` entry id prefix, which push still owns, so the next push
// deletes the copies. It also deletes the first-generation entries, whose
// dotted ids the second-generation types do not use. The catalog holds what
// that kcmd pushed, as captured.
describe('a push over an entry group an older kcmd pushed', () => {
  const GROUP = `projects/${FIRST_GEN_OPTS.project}/locations/` +
      `${FIRST_GEN_OPTS.location}/entryGroups/${FIRST_GEN_OPTS.entryGroup}`;
  const deleted = ['shop.files.shop.yaml', 'shop.entities.orders',
                   'shop.entities.customers', 'shop.metrics.revenue'];
  test(`exits 0 and deletes ${deleted.join(', ')}`, async () => {
    const {project, location, entryGroup} = FIRST_GEN_OPTS;
    fs.writeFileSync(
        'catalog.yaml',
        `scope: semantic-model.${project}.${location}.${entryGroup}\n`);
    const eg = path.join('catalog', 'EntryGroups', entryGroup);
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'shop.yaml'), FIRST_GEN_MODEL_FILE);
    const {entries} = fakeCatalog();
    for (const e of firstGenEntries()) entries.set(e.name, e);
    for (const id of deleted) {
      expect(entries.has(`${GROUP}/entries/${id}`)).toBe(true);
    }

    expect(await push({})).toBe(0);
    expect(messages(console.error)).toBe('');
    for (const id of deleted) {
      expect(entries.has(`${GROUP}/entries/${id}`)).toBe(false);
    }
    expect([...entries.values()].filter(
               e => e.entryType.endsWith('/semantic-model-file')))
        .toEqual([]);
  });
});


// Dataplex deletes the old model entry's children with it, so a rename that
// stops after that delete leaves no model at all.
describe('a --force-remove rename that stopped after deleting the old model', () => {
  test('leaves a catalog pull writes nothing from', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    fs.mkdirSync(entryGroupDir(), {recursive: true});
    const shop = path.join(entryGroupDir(), 'shop.yaml');
    fs.writeFileSync(
        shop, ROUND_TRIP_MODEL.replace('name: commerce', 'name: shop'));
    const {entries} = fakeCatalog();
    expect(await push({deployment: false})).toBe(0);

    fs.rmSync(shop);
    fs.writeFileSync(
        path.join(entryGroupDir(), 'commerce.yaml'), ROUND_TRIP_MODEL);
    // Every delete but the old model entry's fails.
    spyOn(CatalogClient.prototype, 'deleteEntry')
        .mockImplementation(async (...args: any[]) => {
          if (args[3] !== 'shop') return {status: 500, message: 'injected'};
          for (const name of [...entries.keys()]) {
            const id = entryIdOf(name);
            if (id === 'shop' || id.startsWith('shop/')) entries.delete(name);
          }
          return {status: 200};
        });
    expect(await push({deployment: false, forceRemove: true})).toBe(1);
    expect(entries.size).toBe(0);

    const before = localFiles();
    const logSpy = console.log as Mock<any>;
    expect(await pull()).toBe(0);
    expect(await pull({forceRemove: true})).toBe(0);
    expect(localFiles()).toEqual(before);
    expect(messages(logSpy).split('No semantic models found').length)
        .toBe(3);
  });
});


describe('the push-state label on the model entry', () => {
  const ANCHOR = 'projects/test-project/locations/us/entryGroups/commerce_eg/' +
      'entries/commerce';
  test('pull refuses after a push that stopped at any write, until a push ' +
           'finishes',
       async () => {
         writeRoundTripWorkspace();
         const {entries, stop} = fakeCatalog();
         expect(await push({deployment: false})).toBe(0);
         // Rename the entity in the model file and the profile file.
         for (const [f, text] of Object.entries(localFiles())) {
           fs.writeFileSync(f, text.replaceAll('Customer', 'Client'));
         }
         const authored = localFiles();

         // Each push stops one write later than the one before, until one
         // finishes. Each pull in between writes and deletes nothing.
         let code = 1;
         let refused = '';
         for (let n = 1; n < 50; n++) {
           stop.after = n;
           code = await push({deployment: false});
           if (!code) break;
           refused = await pull({forceRemove: true})
                         .then(() => '', (e: Error) => e.message);
           expect(refused)
               .toStartWith('the last push of model \'commerce\' did not ' +
                            'finish: ');
           expect(localFiles()).toEqual(authored);
         }
         expect(code).toBe(0);
         // The push before the one that finished wrote every entry and
         // stopped before its last write, so only the label tells.
         expect(refused).toContain(
             'its model entry\'s kcmd-push-state label still says writing, ' +
             'so pull writes nothing. Push again, then pull.');

         // --validate-only, which --dry-run runs too, writes nothing, so it
         // leaves the label as it is.
         stop.after = 0;
         expect(await push({deployment: false, validateOnly: true})).toBe(0);
         stop.after = Infinity;
         expect(await pull()).toBe(0);
         expect(Object.values(localFiles()).join()).not.toContain('Customer');
         expect([...entries.keys()].join()).not.toContain('Customer');
       });

  test('a push keeps the label and the source update time another writer ' +
           'sets on the model entry while it runs',
       async () => {
         writeRoundTripWorkspace();
         const {entries} = fakeCatalog();
         expect(await push({deployment: false})).toBe(0);
         // Another writer changes the model entry right after the push
         // writes it. Like Dataplex, the fake then refuses an entrySource
         // update that leaves the update time out or moves it back.
         const updateTime = '2026-11-04T08:00:00Z';
         const update =
             CatalogClient.prototype.updateEntry as unknown as Mock<any>;
         const write = update.getMockImplementation()!;
         update.mockImplementation(async (entry: Entry, mask: string[]) => {
           const held = entries.get(entry.name)!.entrySource?.updateTime;
           const sent = entry.entrySource?.updateTime;
           if (held && (!sent || sent < held)) {
             return {status: 400, message: 'update_time is required'};
           }
           const res = await write(entry, mask);
           if (entry.name === ANCHOR && mask.includes('aspects')) {
             const source = entries.get(ANCHOR)!.entrySource!;
             source.updateTime = updateTime;
             source.labels = {...source.labels, steward: 'data-team'};
           }
           return res;
         });
         expect(await push({deployment: false})).toBe(0);
         expect(entries.get(ANCHOR)!.entrySource).toMatchObject({
           updateTime,
           labels: {'steward': 'data-team', 'kcmd-push-state': 'finished'},
         });
       });

  // The push reads the model entry before it labels it finished. The read can
  // answer an error, or throw when the request fails.
  for (const [how, read, reason] of [
    ['answers an error',
     async () => ({status: 503, message: 'Service unavailable.'}),
     'Service unavailable'],
    ['throws', async () => {
      throw new Error('fetch failed');
    }, 'fetch failed'],
  ] as const) {
    test(`a push whose read of the model entry ${how} before it labels it ` +
             'finished says to push again before you pull, and that works',
         async () => {
           writeRoundTripWorkspace();
           fakeCatalog();
           expect(await push({deployment: false})).toBe(0);
           (CatalogClient.prototype.getEntry as unknown as Mock<any>)
               .mockImplementationOnce(read);
           expect(await push({deployment: false})).toBe(1);
           expect(messages(console.error))
               .toBe(
                   'Error pushing semantic model to Knowledge Catalog: Model ' +
                   '\'commerce\': setting the kcmd-push-state label of entry ' +
                   `'commerce' to finished failed: ${reason}. Push again ` +
                   'before you pull.');
           expect(await push({deployment: false})).toBe(0);
           expect(await pull()).toBe(0);
         });
  }
});


// Makes the fake catalog answer an update the way Dataplex does. The update
// writes each aspect `aspectKeys` names that the body carries. A key that ends
// in `@*` names the type's aspects at every field path. With
// `deleteMissingAspects` the update removes each named aspect the body leaves
// out, and the response lists that aspect under its key with an empty value,
// spelling the type's project as a number.
function patchLikeDataplex(entries: Map<string, Entry>): void {
  (CatalogClient.prototype.updateEntry as any).mockRestore();
  spyOn(CatalogClient.prototype as any, '_patch')
      .mockImplementation(async (...args: any[]) => {
        const [name, body, params] = args as [string, Entry, any];
        const stored = entries.get(name);
        if (!stored) return {status: 404, message: 'not found'};
        const aspects = {...stored.aspects};
        const answered: Record<string, any> = {};
        for (const listed of params.aspectKeys ?? []) {
          const keys = listed.endsWith('@*') ?
              [...Object.keys(aspects), ...Object.keys(body.aspects ?? {})]
                  .filter(k => k.startsWith(listed.slice(0, -1))) :
              [listed];
          for (const key of new Set(keys)) {
            if (body.aspects?.[key]) {
              aspects[key] = structuredClone(body.aspects[key]);
              answered[key] = {...body.aspects[key], createTime: 'now'};
            } else if (params.deleteMissingAspects && aspects[key]) {
              delete aspects[key];
              answered[key.replace(/^dataplex-types\./, '655216118709.')] = {};
            }
          }
        }
        entries.set(name, {...structuredClone(body), aspects});
        return {
          status: 200,
          result: {name, entryType: body.entryType, aspects: answered},
        };
      });
}

describe('a push whose update removes an aspect', () => {
  const WITH_INSTRUCTIONS = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        primary_key: [key]
        ai_context:
          instructions: Join orders on the customer key.
        fields:
          - { name: key, label: Customer ID }
      - name: Order
        primary_key: [id]
        fields:
          - { name: id }
    metrics:
      - name: customers
        description: Customers
        entity: Customer
        expression: COUNT(Customer.key)
`;
  // The instructions and the Order entity are gone, and the metric has a new
  // description.
  const WITHOUT_INSTRUCTIONS = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        primary_key: [key]
        fields:
          - { name: key, label: Customer ID }
    metrics:
      - name: customers
        description: Customer count
        entity: Customer
        expression: COUNT(Customer.key)
`;
  const named = (id: string) =>
      `projects/test-project/locations/us/entryGroups/commerce_eg/entries/${id}`;

  test('exits 0, removes the aspect, sql-expressions and a field\'s ' +
           'guidelines, and finishes the writes and deletions after the update',
       async () => {
         writeWorkspace();
         const modelPath = path.join(entryGroupDir(), 'commerce.yaml');
         fs.writeFileSync(modelPath, WITH_INSTRUCTIONS);
         const {entries} = fakeCatalog();
         patchLikeDataplex(entries);
         expect(await push({})).toBe(0);
         const customer = () =>
             entries.get(named('commerce/entities/Customer'))!.aspects!;
         expect(Object.keys(customer()))
             .toContain('dataplex-types.global.guidelines');
         // Another writer adds two aspects that push owns.
         customer()['dataplex-types.global.sql-expressions'] = {
           aspectType:
               'projects/dataplex-types/locations/global/aspectTypes/' +
               'sql-expressions',
           data: {},
         };
         customer()['dataplex-types.global.guidelines@Schema.key'] = {
           aspectType:
               'projects/dataplex-types/locations/global/aspectTypes/guidelines',
           path: 'Schema.key',
           data: {instructions: 'The key.', userManaged: true},
         };

         fs.writeFileSync(modelPath, WITHOUT_INSTRUCTIONS);
         const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
         const code = await push({});

         expect(messages(errorSpy)).toBe('');
         expect(code).toBe(0);
         expect(Object.keys(customer()).sort()).toEqual([
           'dataplex-types.global.schema',
           'dataplex-types.global.semantic-entity',
         ]);
         // The metric is written after the entities, and an orphaned entry is
         // deleted last.
         expect(entries.get(named('commerce/metrics/customers'))!.entrySource
                    ?.description)
             .toBe('Customer count');
         expect(entries.has(named('commerce/entities/Order'))).toBe(false);
       });
});


// Push applies a profile, loads its models and checks them. It prints each
// warning after `Warning:`, the summary of what pruning leaves unavailable after
// `Note:` and each error after `Error:`.
describe('push applies, loads and checks a profile', () => {
  const BQ = 'bigquery.googleapis.com/projects/acme/datasets/sales';
  const prints = (spy: any) => spy.mock.calls.map((c: any[]) => c.join(' '));

  // Writes the scope and its model file, and returns the entry group's
  // directory.
  function writeModel(text: string): string {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), text);
    return eg;
  }

  // Mocks the Knowledge Catalog preflight of a --validate-only push, which
  // gives its result, and returns the mock.
  function mockKc() {
    return spyOn(kc, 'preflightKnowledgeCatalog').mockResolvedValue({
      result: {
        success: true,
        warnings: [],
        created: 0,
        updated: 0,
        deleted: 0,
        linked: 0,
        unchangedLinks: 0,
        unlinked: 0,
        plan: [],
      },
    });
  }

  // A model whose field 'customer.ltv' has no expression, with a BigQuery
  // deployment for each name in `deployments`.
  const ltvUnbound = (deployments: string[]) =>
      `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
${deployments.map(d => `      - { name: ${d}, target: "${BQ}/propertyGraphs/${d}" }`).join('\n')}
    entities:
      - name: customer
        source: ${BQ}/tables/customer
        primary_key: [c_id]
        fields:
          - { name: c_id, expression: c_id }
          - { name: ltv }
`;

  test('a pruned push that fails a source check still notes the field its profile excludes', async () => {
    const eg = writeModel(ltvUnbound(['g']).replace(
        'propertyGraphs/g" }', 'propertyGraphs/g", profile: prod }'));
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'), `name: prod
entities:
  - name: customer
    source: ${BQ}/tables/customer
    primary_key: [c_id]
    fields: [{ name: c_id, expression: c_id }]
    fields_exclude: [ltv]
`);
    spyOn(validateMod, 'validateBigQueryDataSources')
        .mockResolvedValue(['the table is gone']);
    const bqSpy = spyOn(bqLeg, 'deployBigQuery').mockResolvedValue(
        {success: true, deployed: 0, ddl: [], warnings: []} as any);
    expect(await push({validateOnly: true})).toBe(1);
    expect(prints(console.error)).toEqual(['Error: the table is gone']);
    expect(prints(console.warn)).toEqual([
      "Note: model 'commerce' (commerce, deployment 'g') excludes field " +
          "'customer.ltv'.",
    ]);
    expect(bqSpy).toHaveBeenCalledTimes(1);
  });

  // Push checks every aspect's size before any graph deploys.
  test('a graph push stops at an aspect too large before the graph deploys',
       async () => {
         const model = ltvUnbound(['staging']).replace(
             'propertyGraphs/staging" }', 'propertyGraphs/staging", profile: staging }');
         const eg = writeModel(model);
         fs.writeFileSync(path.join(eg, 'commerce.profile.staging.yaml'), `name: staging
entities:
  - name: customer
    source: ${BQ}/tables/customer_staging
    primary_key: [c_id]
    fields: [{ name: c_id, expression: c_id }]
    fields_exclude: [ltv]
`);
         spyOn(validateMod, 'validateBigQueryDataSources')
             .mockResolvedValue([]);
         const bqSpy = spyOn(bqLeg, 'deployBigQuery').mockResolvedValue(
             {success: true, deployed: 0, ddl: [], warnings: []} as any);
         expect(await push({validateOnly: true})).toBe(0);
         writeModel(`${model}    ai_context:\n      instructions: ${
             'x'.repeat(kc.MAX_ASPECT_DATA_BYTES)}\n`);
         expect(await push({})).toBe(1);
         expect(prints(console.error)).toEqual([
           'Error pushing semantic model to Knowledge Catalog: aspect ' +
               "'dataplex-types.global.guidelines' of entry 'commerce' is " +
               'too large to store in Knowledge Catalog: its data takes ' +
               '122918 bytes, and one aspect holds at most 122880.',
         ]);
         expect(prints(console.warn))
             .toEqual([
               "Note: model 'commerce' (commerce, deployment 'staging') " +
                   "excludes field 'customer.ltv'.",
             ]);
         // Each push generates the graph offline; neither deploys it.
         expect(bqSpy.mock.calls.map(c => c[2])).toEqual([
           {validateOnly: true}, {validateOnly: true},
         ]);
       });

  // Unlike a field with no expression, a field with a blank one stops the push
  // when its model file loads.
  test('a push stops at a blank field expression and names the field', async () => {
    writeModel(`version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - { name: g, target: "${BQ}/propertyGraphs/g" }
    entities:
      - name: customer
        source: ${BQ}/tables/customer
        primary_key: [c_id]
        fields:
          - { name: c_id, expression: c_id }
          - { name: ltv, expression: "" }
`);
    const kcSpy = mockKc();
    expect(await push({validateOnly: true})).toBe(1);
    expect(prints(console.error).join('\n'))
        .toContain("field 'customer.ltv': 'expression' is blank");
    expect(prints(console.warn)).toEqual([]);
    expect(kcSpy).not.toHaveBeenCalled();
  });

  // BigQuery read `-- x AS notes,` as a comment, so the graph deployed without
  // the field and with no error.
  test('a push stops at a field whose expression is only a comment', async () => {
    writeModel(`version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - { name: g, target: "${BQ}/propertyGraphs/g" }
    entities:
      - name: customer
        source: ${BQ}/tables/customer
        primary_key: [c_id]
        fields:
          - { name: c_id, expression: c_id }
          - { name: notes, expression: "-- x" }
          - { name: ltv, expression: ltv }
`);
    const kcSpy = mockKc();
    expect(await push({validateOnly: true})).toBe(1);
    expect(prints(console.error).join('\n'))
        .toContain("field 'customer.notes': 'expression' is only a comment");
    expect(kcSpy).not.toHaveBeenCalled();
  });

  // Setting 'entity' on a metric with no SQL let the push pass, and the graph
  // dropped the metric.
  test('a push stops at a blank metric expression and does not ask for an entity', async () => {
    writeModel(`version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - { name: g, target: "${BQ}/propertyGraphs/g" }
    entities:
      - name: customer
        source: ${BQ}/tables/customer
        primary_key: [c_id]
        fields:
          - { name: c_id, expression: c_id }
          - { name: ltv, expression: ltv }
    metrics:
      - { name: total, expression: "  " }
`);
    const kcSpy = mockKc();
    expect(await push({validateOnly: true})).toBe(1);
    const errors = prints(console.error).join('\n');
    expect(errors).toContain(
        "metric 'total': 'expression' is blank; write the metric's SQL");
    expect(errors).not.toContain("'entity'");
    expect(kcSpy).not.toHaveBeenCalled();
  });

  test('--transpile is refused before push reads anything', async () => {
    expect(await push({validateOnly: true, transpile: true})).toBe(1);
    expect(prints(console.error)).toEqual([
      "Error: '--transpile' is no longer supported on 'kcmd push'; use " +
      "'kcmd import <file> --input first-party --flavor <ossie|google> " +
      "--transpile' to translate SQL dialects when importing a model, in the " +
      'model and each profile whose tables are all in BigQuery or BigLake.',
    ]);
    expect(prints(console.warn)).toEqual([]);
  });

  test('a vendor-only metric for a BigQuery graph points at kcmd import --transpile', async () => {
    writeModel(`version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - { name: g, target: "${BQ}/propertyGraphs/g" }
    entities:
      - name: purchase
        source: ${BQ}/tables/purchase
        primary_key: [p_id]
        fields:
          - { name: p_id, expression: p_id }
          - { name: amount, expression: amount }
    metrics:
      - name: positive_spend
        expression:
          dialects:
            - { dialect: SNOWFLAKE, expression: "SUM(IFF(purchase.amount > 0, purchase.amount, 0))" }
`);
    const kcSpy = spyOn(kc, 'preflightKnowledgeCatalog');
    expect(await push({validateOnly: true})).toBe(1);
    expect(prints(console.warn)).toEqual([
      "Warning: [commerce] metric 'positive_spend': no 'BIGQUERY' or " +
      "'ANSI_SQL' dialect, so a BIGQUERY table cannot run its 'SNOWFLAKE' " +
      "expression; give it one, or add one with 'kcmd import <file> " +
      "--input first-party --flavor google --transpile'",
    ]);
    expect(prints(console.error).join('\n')).toContain(
        "targets a BigQuery graph with only a 'SNOWFLAKE' expression; supply " +
        "a 'BIGQUERY' or 'ANSI_SQL' expression, or add one with 'kcmd " +
        "import <file> --input first-party --flavor google --transpile'.");
    expect(kcSpy).not.toHaveBeenCalled();
  });

  test('a pruned push warns about a metric whose SQL it cannot read', async () => {
    writeModel(`version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - { name: a, target: "${BQ}/propertyGraphs/a" }
      - { name: b, target: "${BQ}/propertyGraphs/b" }
    entities:
      - name: customer
        source: ${BQ}/tables/customer
        primary_key: [c_id]
        fields:
          - { name: c_id, expression: c_id }
    metrics:
      - { name: broken, expression: "SUM((customer.c_id" }
`);
    expect(await push({validateOnly: true})).toBe(0);
    expect(prints(console.warn))
        .toContain(
            "Warning: metric 'broken' in model 'commerce' (commerce): kcmd " +
            'could not read its SQL, so the fields it reads were not checked.');
  });

  test('a pruned push reports a SQL parser that cannot load', async () => {
    writeModel(`version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - { name: g, target: "${BQ}/propertyGraphs/g" }
    entities:
      - name: customer
        source: ${BQ}/tables/customer
        primary_key: [c_id]
        fields:
          - { name: c_id, expression: c_id }
`);
    spyOn(sqlParser, 'loadSqlEngine')
        .mockRejectedValue(new Error('engine missing'));
    expect(await push({validateOnly: true})).toBe(1);
    expect(prints(console.error)).toEqual(
        ['Error: the SQL parser could not be loaded: engine missing']);
  });

  // The yaml library expands at most 100 aliases. Push reports the load's
  // error for the text.
  test('a push reports a model file with more aliases than a load expands', async () => {
    writeModel(MODEL_YAML.replace(
        'semantic_model:\n', `x: &a 1\nys:\n${'  - *a\n'.repeat(101)}semantic_model:\n`));
    expect(await push({validateOnly: true})).toBe(1);
    expect(prints(console.error).join('\n')).toContain(
        'could not parse input: Excessive alias count');
  });

  // The model file binds no table, so a deployment names the profile.
  for (const [what, deployments] of [
    ['a push with no deployments', ''],
    ['a push whose deployment names it', `    deployments:
      - { name: g, target: "${BQ}/propertyGraphs/g", profile: prod }
`],
  ]) {
    test(`each profile file is read once during ${what}`, async () => {
      const eg = writeModel(MODEL_YAML.replace(
          '  - name: commerce\n', `  - name: commerce\n${deployments}`));
      const profilePath = path.join(eg, 'commerce.profile.prod.yaml');
      fs.writeFileSync(profilePath, `name: prod
entities:
  - name: Customer
    source: ${BQ}/tables/customer
    primary_key: [c_id]
    fields:
      - { name: key, expression: c_id }
`);
      mockKc();
      mockBigQuery();
      const readSpy = spyOn(fs, 'readFileSync');

      expect(await push({validateOnly: true})).toBe(0);

      const reads = readSpy.mock.calls.filter(
          c => path.resolve(String(c[0])) === profilePath);
      expect(reads).toHaveLength(1);
    });
  }
});

describe('a vanilla model\'s profiles in its GOOGLE block', () => {
  const BQ = 'bigquery.googleapis.com/projects/test-project/datasets';
  // A profile that binds Customer to `source`, with its own key and column.
  const binding = (name: string, source: string) => ({name, entities: [{
    name: 'Customer', source, primary_key: ['cust_key'],
    fields: [{name: 'key', expression: 'cust_key'}],
  }]});
  const prod = (source: string) =>
      JSON.stringify({profiles: [binding('prod', source)]});
  function writeModel(block: string): void {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    custom_extensions:
      - vendor_name: GOOGLE
        data: '${block}'
    datasets:
      - name: Customer
        source: ${BQ}/raw/tables/customer
        primary_key: [key]
        fields:
          - name: key
            expression: {dialects: [{dialect: ANSI_SQL, expression: c_key}]}
`);
  }

  test('push applies one as it applies a profile file', async () => {
    writeModel(JSON.stringify({
      ...JSON.parse(prod(`${BQ}/prod/tables/customer`)),
      deployments: [{name: 'g', target: `${BQ}/d/propertyGraphs/g`, profile: 'prod'}],
    }));
    const deploySpy = mockBigQuery();

    expect(await push({validateOnly: true})).toBe(0);
    const customer = deploySpy.mock.calls[0][0][0].model.entities[0];
    expect(customer.dataSource).toBe('test-project.prod.customer');
  });

  // A model with no deployments list checks every source too, the model
  // file's and each block profile's, before it writes anything.
  test('push checks every source before it writes, and --skip-source-check looks nothing up', async () => {
    const PROD = `${BQ}/prod/tables/customer`;
    const DEV = `${BQ}/dev/tables/customer`;
    writeModel(JSON.stringify({profiles: [binding('prod', PROD), binding('dev', DEV)]}));
    const lookup = spyOn(CatalogClient.prototype, 'lookupEntry')
        .mockImplementation((async (_p: string, _l: string, name: string) =>
            name.endsWith(`/entries/${DEV}`) ? entryDenied(name) :
                                               {status: 200, result: {name}}) as any);
    spyOn(kc, 'preflightKnowledgeCatalog').mockResolvedValue(
        {prepared: {emitted: [], existing: [], warnings: [], plan: []}});
    const applySpy = spyOn(kc, 'applyKnowledgeCatalog').mockResolvedValue(
        {success: true, warnings: [], created: 0, updated: 0, deleted: 0,
         linked: 0, unchangedLinks: 0, unlinked: 0, plan: []});
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});

    expect(await push({})).toBe(1);
    expect(messages(errorSpy)).toBe(
        `Error: entity 'Customer' in profile 'dev': source '${DEV}' names no ` +
        `table Knowledge Catalog knows about. BigQuery has the table, but ` +
        `Knowledge Catalog has no entry for it that you may read. Fix the ` +
        `access or the source. --skip-source-check skips this lookup, but a ` +
        `deployment that reads the table still checks the table itself.`);
    expect(applySpy).not.toHaveBeenCalled();
    const entry = (source: string) =>
        `projects/test-project/locations/us/entryGroups/@bigquery/entries/${source}`;
    expect(lookup.mock.calls.map(c => c[2]).sort())
        .toEqual([`${BQ}/raw/tables/customer`, PROD, DEV].map(entry).sort());

    lookup.mockClear();
    expect(await push({skipSourceCheck: true})).toBe(0);
    expect(lookup).not.toHaveBeenCalled();
    expect(messages(logSpy))
        .toContain('Skipping the source check (--skip-source-check).');
    expect(applySpy).toHaveBeenCalledTimes(1);
  });

  // Reading a block profile checks each field binding for SQL, which needs the
  // SQL parser. Each command loads the parser before it reads a block profile.
  test('each command loads the SQL parser before it reads a block profile', async () => {
    writeModel(prod(`${BQ}/prod/tables/customer`));
    // As in a new process, the parser reads nothing until a command loads it.
    let loaded = false;
    const load = sqlParser.loadSqlEngine;
    const holdsNoSql = sqlParser.holdsNoSql;
    spyOn(sqlParser, 'loadSqlEngine').mockImplementation(async () => {
      const engine = await load();
      loaded = true;
      return engine;
    });
    spyOn(sqlParser, 'holdsNoSql').mockImplementation((text, dialect) => {
      if (!loaded) {
        throw new Error('the SQL parser is not loaded; call loadSqlEngine() first');
      }
      return holdsNoSql(text, dialect);
    });
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    expect(await push({validateOnly: true})).toBe(0);
    loaded = false;
    expect(await skillsGenerate({out: 'skills'})).toBe(0);
    loaded = false;
    expect(await profiles({printStore: true})).toBe(1);
    expect(messages(errorSpy)).toBe(
        "Error: Model 'commerce' declares no deployment target in " +
        "'deployments', so there is no store to run against. In a GOOGLE " +
        "custom_extensions block on the model, declare a deployment in " +
        "'deployments' whose target names a database.");
  });

  test('kcmd profiles lists one, and reports what push rejects', async () => {
    writeModel(prod(`${BQ}/prod/tables/customer`));
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});

    expect(await profiles()).toBe(0);
    expect(messages(logSpy)).toContain(
        "  profile 'prod'\n" +
        '    target: (none; no deployment names this profile)\n' +
        '    sources:\n' +
        '      Customer -> bigquery.googleapis.com/projects/test-project/datasets/prod/tables/customer');

    // A source push rejects is reported under the profile, as for a file.
    writeModel(prod('not a source'));
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    expect(await profiles()).toBe(1);
    expect(messages(errorSpy)).toContain(
        "    push rejects:\n" +
        "      [commerce] profile 'prod': entity 'Customer': source 'not a source'");
  });

  // Push and kcmd profiles print the same error the runtime returns, and exit
  // 1; kcmd profiles under every profile selection that reads the block
  // profiles.
  const unreadable = [
    ['has data that is not a JSON object', () => writeModel('[]'),
     "model 'commerce': the 'data' of a GOOGLE custom_extensions block must " +
         'be a JSON object.'],
    ['sets profiles in two GOOGLE blocks', () => {
       writeModel('{"profiles": [{"name": "prod"}]}');
       const file = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg', 'commerce.yaml');
       fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
           '    datasets:\n',
           '      - vendor_name: GOOGLE\n' +
               `        data: '{"profiles": [{"name": "dev"}]}'\n    datasets:\n`));
     },
     "model 'commerce': two GOOGLE custom_extensions blocks both set " +
         "'profiles'; set it in one block."],
  ] as const;
  for (const [what, write, problem] of unreadable) {
    test(`a model whose GOOGLE block ${what} stops push and kcmd profiles with exit 1`, async () => {
      write();
      const error =
          `Error: Model document 'commerce': Semantic model load error: ${problem}`;
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = spyOn(console, 'log').mockImplementation(() => {});

      expect(await push({validateOnly: true})).toBe(1);
      expect(messages(errorSpy)).toBe(error);
      errorSpy.mockClear();
      for (const options of [{}, {profile: 'prod'}]) {
        expect(await profiles(options)).toBe(1);
        expect(messages(errorSpy)).toBe(error);
        expect(messages(logSpy)).toBe('');
        errorSpy.mockClear();
      }
      const opened = await createSemanticRuntimes({ctx: CTX, onWarning: () => {}});
      expect('error' in opened && `Error: ${opened.error}`).toBe(error);
    });
  }

  // The runtime reads the GOOGLE block before the load, so beside a
  // third-party block that fails the load it names the GOOGLE block. Push
  // loads the model file first, so it stops at the loader's error for the
  // third-party block.
  test('a GOOGLE block that does not load stops the runtime, and push stops at the load error', async () => {
    writeModel('{');
    const file = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg', 'commerce.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
        '    datasets:\n', '      - vendor_name: ACME\n        data: 123\n    datasets:\n'));
    const error = "Semantic model load error: model 'commerce': the 'data' of " +
        'a GOOGLE custom_extensions block must be a JSON object.';
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const loadError = "model 'commerce': 'data' of entry 2 of " +
        "'custom_extensions' is 123; it takes a string";
    expect(await push({validateOnly: true})).toBe(1);
    expect(messages(errorSpy)).toBe(
        `Error: Model document 'commerce': Semantic model load error: ${loadError}`);
    errorSpy.mockClear();

    expect(await profiles({printStore: true})).toBe(1);
    expect(messages(errorSpy)).toBe(`Error: Model document 'commerce': ${error}`);
    errorSpy.mockClear();
    expect(await skillsGenerate({out: 'skills'})).toBe(1);
    expect(messages(errorSpy)).toBe(`Error: Model document 'commerce': ${error}`);
  });

  // The runtime reads every model's profiles before it applies one, as push
  // reads every model, so a later model's GOOGLE block is reported under a
  // named profile too, whichever model comes first.
  test("the runtime reads every model's GOOGLE block before it applies a profile", async () => {
    for (const bad of ['alpha', 'beta']) {
      writeModel('{}');
      const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
      const text = fs.readFileSync(path.join(eg, 'commerce.yaml'), 'utf8');
      fs.rmSync(path.join(eg, 'commerce.yaml'));
      for (const name of ['alpha', 'beta']) {
        fs.writeFileSync(path.join(eg, `${name}.yaml`), text
            .replace('  - name: commerce\n', `  - name: ${name}\n`)
            .replace("data: '{}'", name === bad ? "data: '{'" : "data: '{}'"));
      }
      const error = `model '${bad}': the 'data' of a GOOGLE custom_extensions ` +
          'block must be a JSON object.';

      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      expect(await push({validateOnly: true})).toBe(1);
      expect(messages(errorSpy)).toContain(error);
      errorSpy.mockRestore();
      const opened = await createSemanticRuntimes(
          {ctx: CTX, profile: 'prod', onWarning: () => {}});
      expect('error' in opened && opened.error).toContain(error);
    }
  });

  const PROD_SOURCE = `${BQ}/prod/tables/customer`;
  const NO_TARGET = "binding profile 'prod' is a named profile, which names no " +
      'deployment target';

  // As a profile file is found beside a model file that does not load. The
  // load rejects each of these blocks for its shape.
  const rejected = [
    ['a third-party block the loader rejects', '      - vendor_name: ACME\n        data: 123\n'],
    ['a GOOGLE block whose data is a number', '      - vendor_name: GOOGLE\n        data: 123\n'],
    ['a GOOGLE block with a key other than data',
     "      - vendor_name: GOOGLE\n        data: '{}'\n        note: x\n"],
    ['a GOOGLE block whose data is a YAML mapping',
     '      - vendor_name: GOOGLE\n        data:\n          entity: x\n'],
  ];
  for (const [what, block] of rejected) {
    test(`${what} does not hide one`, async () => {
      writeModel(prod(PROD_SOURCE));
      const file = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg', 'commerce.yaml');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
          '    datasets:\n', `${block}    datasets:\n`));
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = spyOn(console, 'log').mockImplementation(() => {});
      const alone = "(under profile 'prod', the model file must load on its " +
          'own before the profile applies)';

      // The report gives a plain push's error under the profile.
      expect(await profiles({profile: 'prod'})).toBe(1);
      expect(messages(logSpy)).toContain("  profile 'prod'");
      expect(messages(errorSpy)).toStartWith(
          "push rejects:\n  Model document 'commerce': Semantic model load " +
          'error: ');
      errorSpy.mockClear();
      expect(await profiles({printStore: true, profile: 'prod'})).toBe(1);
      expect(messages(errorSpy)).toContain(alone);
    });
  }

  // A model file with a YAML error ahead of its GOOGLE block. The load
  // rejects it. Past a key set twice or an alias whose anchor is not set, the
  // profile is still read. Any other YAML error can move the block, so the
  // YAML error is reported.
  const yamlErrors = [
    ['sets a key twice', '    description: a\n    description: b\n',
     'Map keys must be unique', true],
    ['has a YAML syntax error', '    description: [x\n', 'could not parse input', false],
    ['has an alias whose anchor is not set', '    description: *nope\n',
     'Unresolved alias', true],
    ['has an unquoted \'*\'', '    description: *\n',
     'write it in quotes, as in description: "*".', false],
  ] as const;
  for (const [what, extra, problem, listed] of yamlErrors) {
    const writeBroken = () => {
      writeModel(prod(PROD_SOURCE));
      const file = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg', 'commerce.yaml');
      fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
          '    custom_extensions:\n', `${extra}    custom_extensions:\n`));
    };

    // As a profile file is found beside a model file the load rejects.
    test(`a model file that ${what} ${listed ? 'does not hide one' : 'reports the YAML error'}`, async () => {
      writeBroken();
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      const alone = "(under profile 'prod', the model file must load on its " +
          'own before the profile applies)';

      // Push loads the model file first, whatever profile it holds.
      expect(await push({validateOnly: true})).toBe(1);
      expect(messages(errorSpy)).toStartWith(
          "Error: Model document 'commerce': Semantic model load error: " +
          'could not parse input: ');
      expect(messages(errorSpy)).toContain(problem);
      errorSpy.mockClear();
      // The runtime finds the profile past a key set twice or an alias whose
      // anchor is not set.
      expect(await profiles({printStore: true, profile: 'prod'})).toBe(1);
      expect(messages(errorSpy)).toContain(problem);
      if (listed) expect(messages(errorSpy)).toContain(alone);
      else expect(messages(errorSpy)).not.toContain(alone);
    });

    // Past a key set twice or an alias whose anchor is not set, the layout reads
    // the model file's version as the block lookup reads the file, so it still
    // refuses a sibling profile file, and the profile is not listed twice.
    if (!listed) continue;
    test(`a sibling profile file beside a model file that ${what} is refused`, async () => {
      writeBroken();
      fs.writeFileSync(
          path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg', 'commerce.profile.prod.yaml'),
          `name: prod\nentities:\n  - name: Customer\n    source: ${PROD_SOURCE}\n`);
      const beside = "Profile file 'commerce.profile.prod.yaml' sits beside " +
          "'commerce.yaml', which is a 0.2.0.dev0 document";

      // The runtime refuses it under the profile. A plain push loads the
      // model file first, and so does the report.
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      expect(await profiles({printStore: true, profile: 'prod'})).toBe(1);
      expect(messages(errorSpy)).toStartWith(`Error: ${beside};`);
      errorSpy.mockClear();
      expect(await push({validateOnly: true})).toBe(1);
      expect(messages(errorSpy)).toContain(problem);
      expect(messages(errorSpy)).not.toContain(beside);
      errorSpy.mockClear();
      expect(await profiles()).toBe(1);
      expect(messages(errorSpy)).toContain(problem);
    });
  }

  // With a YAML error in the text, each GOOGLE block is read for its profiles
  // alone, so a key the block may not set does not hide one.
  test('a model file with a YAML error does not hide one beside a key the block may not set', async () => {
    writeModel(JSON.stringify({...JSON.parse(prod(PROD_SOURCE)), bogus: 1}));
    const file = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg', 'commerce.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
        '    custom_extensions:\n',
        '    description: a\n    description: b\n    custom_extensions:\n'));
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    expect(await profiles({printStore: true, profile: 'prod'})).toBe(1);
    expect(messages(errorSpy)).toContain('Map keys must be unique');
    expect(messages(errorSpy)).toContain(
        "(under profile 'prod', the model file must load on its own before " +
        'the profile applies)');
  });

  // As a profile file is found beside a model file the load rejects, a key
  // other than profiles that the load rejects does not hide one.
  const otherKeys = [
    ['a deployment with no target beside it', () => writeModel(JSON.stringify(
         {...JSON.parse(prod(PROD_SOURCE)), deployments: [{name: 'main'}]})),
     "model 'commerce': deployment 'main': 'target' is missing; it takes a string"],
    ['a deployment with no target in a second block', () => {
       writeModel(prod(PROD_SOURCE));
       const file = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg', 'commerce.yaml');
       fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(
           '    datasets:\n',
           '      - vendor_name: GOOGLE\n' +
               `        data: '{"deployments": [{"name": "main"}]}'\n    datasets:\n`));
     },
     "model 'commerce': deployment 'main': 'target' is missing; it takes a string"],
    ['a key the block may not set beside it', () => writeModel(JSON.stringify(
         {...JSON.parse(prod(PROD_SOURCE)), bogus: 1})),
     "'bogus' is not a key a GOOGLE custom_extensions block takes"],
    ['a key set twice outside the profiles', () => writeModel(
         prod(PROD_SOURCE).replace('{', '{"x": 1, "x": 2, ')),
     'block sets a key twice'],
  ] as const;
  for (const [what, write, problem] of otherKeys) {
    test(`a GOOGLE block with ${what} does not hide one`, async () => {
      write();
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = spyOn(console, 'log').mockImplementation(() => {});
      const alone = "(under profile 'prod', the model file must load on its " +
          'own before the profile applies)';

      expect(await push({validateOnly: true})).toBe(1);
      expect(messages(errorSpy)).toContain(problem);
      errorSpy.mockClear();
      expect(await profiles({profile: 'prod'})).toBe(1);
      expect(messages(logSpy)).toContain("  profile 'prod'");
      // The report gives a plain push's error.
      expect(messages(errorSpy)).toContain(problem);
      expect(messages(errorSpy)).not.toContain(alone);
      errorSpy.mockClear();
      expect(await profiles({printStore: true, profile: 'prod'})).toBe(1);
      expect(messages(errorSpy)).toContain(problem);
      expect(messages(errorSpy)).toContain(alone);
      errorSpy.mockClear();
      expect(await skillsGenerate({out: 'skills', profile: 'prod'})).toBe(1);
      expect(messages(errorSpy)).toContain(alone);
    });
  }

  // The GOOGLE block that holds the profile has a shape the load rejects. The
  // profile is still read from it, and the load reports the shape.
  const misshapen = [
    ['has data written as a YAML mapping', (text: string, json: string) => text.replace(
        `        data: '${json}'\n`,
        '        data:\n          profiles:\n            - name: prod\n' +
            `              entities: [{name: Customer, source: '${PROD_SOURCE}'}]\n`)],
    ['has a key other than data', (text: string, json: string) => text.replace(
        `        data: '${json}'\n`, `        data: '${json}'\n        note: x\n`)],
    ['is not in a list', (text: string, json: string) => text.replace(
        `      - vendor_name: GOOGLE\n        data: '${json}'\n`,
        `      vendor_name: GOOGLE\n      data: '${json}'\n`)],
    ['lists it with no data', (text: string, json: string) => text.replace(
        `        data: '${json}'\n`,
        '        profiles:\n          - name: prod\n' +
            `            entities: [{name: Customer, source: '${PROD_SOURCE}'}]\n`)],
  ] as const;
  for (const [what, edit] of misshapen) {
    test(`one is found when the GOOGLE block that holds it ${what}`, async () => {
      const json = prod(PROD_SOURCE);
      writeModel(json);
      const file = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg', 'commerce.yaml');
      const text = fs.readFileSync(file, 'utf8');
      expect(edit(text, json)).not.toBe(text);
      fs.writeFileSync(file, edit(text, json));
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
      const logSpy = spyOn(console, 'log').mockImplementation(() => {});
      const alone = "(under profile 'prod', the model file must load on its " +
          'own before the profile applies)';

      expect(await push({validateOnly: true})).toBe(1);
      expect(messages(errorSpy)).toContain('custom_extensions');
      errorSpy.mockClear();
      // The report gives a plain push's error, and the runtime finds the
      // profile.
      expect(await profiles({profile: 'prod'})).toBe(1);
      expect(messages(logSpy)).toContain("  profile 'prod'");
      expect(messages(errorSpy)).toContain('custom_extensions');
      errorSpy.mockClear();
      expect(await profiles({printStore: true, profile: 'prod'})).toBe(1);
      expect(messages(errorSpy)).toContain(alone);
    });
  }

  // Other model files that are not valid YAML. The load rejects each.
  const invalidYaml = [
    ['has an alias whose anchor is not set, and a key the GOOGLE block may not set',
     (text: string) => text
         .replace('"profiles"', '"bogus":1,"profiles"')
         .replace('        primary_key: [key]\n',
                  '        primary_key: [key]\n        description: *nope\n'),
     'Unresolved alias'],
  ] as const;
  for (const [what, edit, problem] of invalidYaml) {
    test(`a model file that ${what} does not hide one`, async () => {
      writeModel(prod(PROD_SOURCE));
      const file = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg', 'commerce.yaml');
      const text = fs.readFileSync(file, 'utf8');
      expect(edit(text)).not.toBe(text);
      fs.writeFileSync(file, edit(text));
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      expect(await profiles({printStore: true, profile: 'prod'})).toBe(1);
      expect(messages(errorSpy)).toContain(problem);
      expect(messages(errorSpy)).toContain(
          "(under profile 'prod', the model file must load on its own before " +
          'the profile applies)');
      errorSpy.mockClear();
      expect(await push({validateOnly: true})).toBe(1);
      expect(messages(errorSpy)).toContain(problem);
    });
  }

  // A key set twice on the path to the GOOGLE block leaves which value holds
  // the profile unknown, so the YAML error is reported.
  const ambiguous = [
    ['is written twice', (text: string) => text + text],
    ['has a GOOGLE block that sets data twice', (text: string) =>
        text.replace(/( {8}data: '.*'\n)/, "$1        data: '{}'\n")],
    ['sets semantic_model twice', (text: string) =>
        text.replace('semantic_model:\n', 'semantic_model:\n  - name: commerce\nsemantic_model:\n')],
    ['sets custom_extensions twice', (text: string) => text.replace(
        '    datasets:\n',
        "    custom_extensions:\n      - vendor_name: ACME\n        data: '{}'\n    datasets:\n")],
  ] as const;
  for (const [what, edit] of ambiguous) {
    test(`a model file that ${what} reports the YAML error`, async () => {
      writeModel(prod(PROD_SOURCE));
      const file = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg', 'commerce.yaml');
      const text = fs.readFileSync(file, 'utf8');
      expect(edit(text)).not.toBe(text);
      fs.writeFileSync(file, edit(text));
      const error = 'Semantic model load error: could not parse input: Map keys must be unique';
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      expect(await push({validateOnly: true})).toBe(1);
      expect(messages(errorSpy)).toContain(error);
      errorSpy.mockClear();
      expect(await profiles({profile: 'prod'})).toBe(1);
      expect(messages(errorSpy)).toContain(error);
    });
  }

  // A quote left open in the GOOGLE block's data cuts the block short, so its
  // profile cannot be read. The YAML error is reported instead.
  test('a model file whose GOOGLE block a YAML error cuts short reports the error', async () => {
    writeModel(prod(PROD_SOURCE));
    const file = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg', 'commerce.yaml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/}'\n/, '}\n'));
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    expect(await push({validateOnly: true})).toBe(1);
    expect(messages(errorSpy)).toContain(
        'Semantic model load error: could not parse input: Missing closing');
    errorSpy.mockClear();
    expect(await profiles({profile: 'prod'})).toBe(1);
    expect(messages(errorSpy)).toContain('could not parse input: Missing closing');
  });

  test('they are listed by name, as profile files are', async () => {
    const profiles2 =
        {profiles: [binding('prod', PROD_SOURCE), binding('dev', PROD_SOURCE)]};
    writeModel(JSON.stringify({
      ...profiles2,
      deployments: [{name: 'g', target: `${BQ}/d/propertyGraphs/g`, profile: 'qa'}],
    }));
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const defined = 'defined profiles: dev, prod.';

    expect(await push({validateOnly: true})).toBe(1);
    expect(messages(errorSpy)).toContain(defined);
    errorSpy.mockClear();
    writeModel(JSON.stringify(profiles2));
    expect(await profiles({printStore: true, profile: 'qa'})).toBe(1);
    expect(messages(errorSpy)).toContain(defined);
    expect(await profiles()).toBe(0);
    const report = messages(logSpy);
    expect(report.indexOf("  profile 'dev'"))
        .toBeLessThan(report.indexOf("  profile 'prod'"));
  });

  test('the runtime applies one under --profile', async () => {
    writeModel(prod(PROD_SOURCE));
    const named = await createSemanticRuntimes(
        {ctx: CTX, profile: 'prod', onWarning: () => {}});
    if ('error' in named) throw new Error(named.error);
    expect(named[0].model.entities[0].dataSource)
        .toBe('test-project.prod.customer');
    expect(named[0].storeError)
        .toBe(`${NO_TARGET}, so there is no database to run it against`);
  });

  test('kcmd profiles --print-store and skills-generate find one', async () => {
    writeModel(prod(PROD_SOURCE));
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    expect(await profiles({printStore: true, profile: 'prod'})).toBe(1);
    expect(messages(errorSpy))
        .toBe(`Error: ${NO_TARGET}, so there is no database to run it against`);
    errorSpy.mockClear();
    expect(await skillsGenerate({out: 'skills', profile: 'prod'})).toBe(0);
    expect(messages(errorSpy)).toBe('');
    expect(fs.existsSync(path.join('skills', 'commerce', 'SKILL.md'))).toBe(true);
  });

  test("one named 'default' in any letter case stops push and the runtime", async () => {
    writeModel(JSON.stringify(
        {profiles: [{name: 'Default', entities: [{name: 'Customer', source: PROD_SOURCE}]}]}));
    const error = "model 'commerce': a profile in a GOOGLE custom_extensions " +
        "block may not be named 'Default'; 'default' names the model's " +
        'inline bindings.';
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    expect(await push({validateOnly: true})).toBe(1);
    expect(messages(errorSpy)).toContain(error);
    const opened = await createSemanticRuntimes({ctx: CTX, onWarning: () => {}});
    expect('error' in opened && opened.error).toContain(error);
  });

  // A vanilla model with no target is told to declare one in 'deployments'.
  const noTarget = [
    ['no GOOGLE block', '{}', (text: string) => text.replace(
        "    custom_extensions:\n      - vendor_name: GOOGLE\n        data: '{}'\n", ''),
     "'deployments'"],
    ['an empty deployments list', '{"deployments": []}', (text: string) => text,
     "'deployments'"],
    ['an empty deployments list beside a third-party block', '{"deployments": []}',
     (text: string) => text.replace(
         '    datasets:\n', "      - vendor_name: ACME\n        data: '{}'\n    datasets:\n"),
     "'deployments'"],
  ] as const;
  for (const [what, block, edit, where] of noTarget) {
    test(`the runtime's no-target error names ${where} for ${what}`, async () => {
      writeModel(block);
      const file = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg', 'commerce.yaml');
      fs.writeFileSync(file, edit(fs.readFileSync(file, 'utf8')));
      const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

      expect(await profiles({printStore: true})).toBe(1);
      expect(messages(errorSpy)).toBe(
          `Error: Model 'commerce' declares no deployment target in ${where}, ` +
          'so there is no store to run against. In a GOOGLE custom_extensions ' +
          "block on the model, declare a deployment in 'deployments' whose " +
          'target names a database.');
    });
  }
});

describe('what a push says about relationships', () => {
  const TWO_ON_ONE_PAIR = `${MODEL_YAML}      - name: Order
        primary_key: [id]
        fields:
          - { name: id }
          - { name: buyer }
          - { name: payer }
    relationships:
      - { name: bought_by, from: Order, to: Customer,
          from_columns: [buyer], to_columns: [key] }
      - { name: paid_by, from: Order, to: Customer,
          from_columns: [payer], to_columns: [key] }
`;
  const PAID_BY = /\n      - \{ name: paid_by[^}]*\}\n/;
  // Each case gives the exit code and a line the push prints. A case with a
  // fifth model pushes that model first.
  const cases: [string, string, number, string, string?][] = [
    ['counts entry links: one for the relationships on one pair, and two ' +
         'reference links for each relationship',
     TWO_ON_ONE_PAIR, 0,
     'Wrote 5 new and 0 updated Knowledge Catalog entries; wrote 5 entry ' +
         'links.'],
    ['relationships in both directions on one pair stop the push',
     TWO_ON_ONE_PAIR.replace(
         PAID_BY,
         '\n      - { name: first_order_of, from: Customer, to: Order, ' +
             'from_columns: [key], to_columns: [buyer] }\n'),
     1,
     "Error: relationship 'first_order_of' in model 'commerce' (commerce) " +
         "runs from 'Customer' to 'Order', and relationship 'bought_by' runs " +
         'the other way; keep the relationships between two entities in one ' +
         'direction.'],
    ['a relationship from an entity to itself stops the push',
     TWO_ON_ONE_PAIR.replace(
         PAID_BY,
         '\n      - { name: referred_by, from: Customer, to: Customer, ' +
             'from_columns: [key], to_columns: [key] }\n'),
     1,
     "Error: relationship 'referred_by' in model 'commerce' (commerce) " +
         "runs from 'Customer' to itself; a relationship joins two " +
         'different entities.'],
    ['an unchanged re-push counts its entry links as unchanged',
     TWO_ON_ONE_PAIR, 0,
     'Wrote 0 new and 5 updated Knowledge Catalog entries; wrote 0 entry ' +
         'links (5 unchanged).',
     TWO_ON_ONE_PAIR],
    ['a re-push that adds a relationship on a linked pair counts the entry ' +
         'links it wrote and the unchanged ones',
     TWO_ON_ONE_PAIR, 0,
     'Wrote 1 new and 4 updated Knowledge Catalog entries; wrote 3 entry ' +
         'links (2 unchanged).',
     TWO_ON_ONE_PAIR.replace(PAID_BY, '\n')],
  ];
  for (const [title, model, code, line, before] of cases) {
    test(title, async () => {
      writeWorkspace();
      fakeCatalog();
      const modelFile = path.join(entryGroupDir(), 'commerce.yaml');
      if (before) {
        fs.writeFileSync(modelFile, before);
        expect(await push({})).toBe(0);
      }
      fs.writeFileSync(modelFile, model);

      expect(await push({})).toBe(code);
      expect(messages(code ? console.error : console.log).split('\n'))
          .toContain(line);
    });
  }
});

// skills-generate runs none of push's profile checks, so under a profile it
// warns about a field whose table cannot run its text, as it does without one.
describe('skills-generate --profile', () => {
  const rows = [
    ['SPANNER', 'spanner.googleapis.com/projects/test-project/instances/i/databases/db/tables/customer'],
    ['ALLOYDB', 'alloydb.googleapis.com/projects/test-project/locations/us-central1/clusters/c/databases/db/schemas/public/tables/customer'],
    ['POSTGRES', 'cloudsql.googleapis.com/projects/test-project/locations/us-central1/instances/shop/databases/sales/schemas/public/tables/customer'],
  ] as const;
  for (const [dialect, source] of rows) {
    test(`warns about a field its ${dialect} table cannot run`, async () => {
      writeWorkspace();
      fs.writeFileSync(local('commerce.profile.p.yaml'), `name: p
entities:
  - name: Customer
    source: ${source}
    fields:
      - name: key
        expression:
          dialects:
            - {dialect: BIGQUERY, expression: c_key}
`);
      fakeCatalog();

      expect(await skillsGenerate({out: 'skills', profile: 'p'})).toBe(0);
      expect(messages(console.warn)).toContain(
          `Warning: [commerce] field 'Customer.key': no '${dialect}' or ` +
          `'ANSI_SQL' dialect, so the ${dialect} table of entity 'Customer' ` +
          'cannot run it');
    });
  }
});
