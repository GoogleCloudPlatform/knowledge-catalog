// How the store a model's deployments name reaches kcmd skills-generate and
// kcmd profiles: which models still get a skill when the store cannot be
// resolved, and which deployments are refused.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {AlloyDbClient} from '../../src/libts/gcp/alloydb';
import {ApiContext} from '../../src/libts/gcp/context';
import {createSemanticRuntimes} from '../../src/libts/semantic/runtime/runtime';
import {profiles, skillsGenerate} from '../../src/tool/commands';
import {stubCloudSqlEntry} from '../libts/mocks';

const CTX = new ApiContext('test-project', 'us', 'test-token');
const SPANNER_DB =
    '//spanner.googleapis.com/projects/acme-ops/instances/prod/databases/commerce';
const BQ = '//bigquery.googleapis.com/projects/acme';
const CLUSTER =
    '//alloydb.googleapis.com/projects/acme-ops/locations/us-central1/clusters/main';

let dir = '';
let cwd = '';
let logs: string[] = [];
// What console.log printed, which is the report and --print-store output.
let out: string[] = [];

function writeModel(file: string, text: string): void {
  fs.writeFileSync(
      path.join(dir, 'catalog.yaml'),
      'scope: semantic-model.test-project.us.commerce_eg\n');
  const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
  fs.mkdirSync(eg, {recursive: true});
  fs.writeFileSync(path.join(eg, file), text);
}

function model(deployments: string, source: string, actions = true): string {
  return `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
${deployments}    entities:
      - name: Order
        source: ${source}
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
          - { name: total, expression: Total }
` + (actions ? `    actions:
      - name: IssueCredit
        description: Does a thing to an order.
        executor:
          sql:
            statements:
              - UPDATE Orders SET Total = 0 WHERE OrderId = @order
        parameters:
          - {name: order, type: Integer}
        affects:
          - {concept: Order, operation: modify}
` :
                 '');
}

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-runtime-store-'));
  process.chdir(dir);
  logs = [];
  out = [];
  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  spyOn(globalThis, 'fetch').mockImplementation((() => {
    throw new Error('unexpected network call');
  }) as any);
  spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
    out.push(a.join(' '));
    logs.push(a.join(' '));
  });
  for (const channel of ['warn', 'error'] as const) {
    spyOn(console, channel).mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
  }
});

afterEach(() => {
  process.chdir(cwd);
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
  mock.restore();
});


// A model with no actions gets a skill whose text never names the store, so
// the store cannot be what stops it.
describe('a model with no actions', () => {
  test('gets a skill when its BigQuery tables sit outside the graph dataset',
       async () => {
         writeModel(
             'commerce.yaml',
             model(
                 `      - name: prod\n` +
                     `        target: ${BQ}/datasets/graphs/propertyGraphs/commerce\n`,
                 `${BQ}/datasets/sales/tables/orders`, false));
         expect(await skillsGenerate({out: 'skills'})).toBe(0);
       });

  test('gets a skill when the AlloyDB listing fails', async () => {
    spyOn(AlloyDbClient.prototype, 'listInstances')
        .mockRejectedValue(new Error('fetch failed'));
    writeModel(
        'commerce.yaml',
        model(
            `      - name: alloy\n        target: ${CLUSTER}/databases/commerce\n`,
            `${CLUSTER}/databases/commerce/schemas/public/tables/orders`,
            false));
    expect(await skillsGenerate({out: 'skills'})).toBe(0);
  });
});


// `kcmd profiles` and `kcmd profiles --print-store` read the same binding.
describe('the profiles report and --print-store', () => {
  test('agree on the target of a profile file a deployment names', async () => {
    writeModel(
        'commerce.yaml',
        model(
            `      - name: prod\n` +
                `        target: ${SPANNER_DB}/propertyGraphs/commerce\n` +
                `        profile: prod\n`,
            `${SPANNER_DB}/tables/Orders`, false));
    writeModel(
        'commerce.profile.prod.yaml',
        `name: prod\nentities:\n  - name: Order\n    source: ${
            SPANNER_DB}/tables/Orders\n`);
    expect(await profiles({printStore: true, profile: 'prod'})).toBe(0);
    expect(out).toEqual(['acme-ops/prod/commerce']);
    out = [];
    await profiles({profile: 'prod'});
    const target = out.find(l => l.trim().startsWith('target:'));
    expect(target).toBe(`    target: ${SPANNER_DB}/propertyGraphs/commerce`);
  });

  test('agree on the target of a legacy wrapper', async () => {
    writeModel(
        'commerce.yaml',
        model(
            `      - name: analytical\n` +
                `        target: ${BQ}/datasets/sales/propertyGraphs/commerce\n` +
                `        profile: analytical\n` +
                `      - name: prod\n` +
                `        target: ${SPANNER_DB}/propertyGraphs/commerce\n`,
            `${SPANNER_DB}/tables/Orders`, false));
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(path.join(eg, 'commerce.profiles'), {recursive: true});
    for (const name of ['staging', 'analytical']) {
      fs.writeFileSync(
          path.join(eg, 'commerce.profiles', `${name}.yaml`),
          `semantic_model:\n  - name: commerce\n    entities:\n` +
              `      - name: Order\n        source: ${
                  SPANNER_DB}/tables/Orders\n`);
    }
    expect(await profiles({printStore: true, profile: 'staging'})).toBe(0);
    expect(out).toEqual(['acme-ops/prod/commerce']);
    out = [];
    await profiles({profile: 'staging'});
    const target = out.find(l => l.trim().startsWith('target:'));
    expect(target).toBe(
        `    target: ${SPANNER_DB}/propertyGraphs/commerce`);
  });
});


// Under `default`, a deployment with `profile: default` counts as one that
// names no profile. A legacy wrapper falls back to the same deployments.
describe('a deployment that names profile default', () => {
  test('is the one a legacy wrapper no deployment names falls back to',
       async () => {
         writeModel(
             'commerce.yaml',
             model(
                 `      - name: main\n` +
                     `        target: ${SPANNER_DB}/propertyGraphs/commerce\n` +
                     `        profile: default\n`,
                 `${SPANNER_DB}/tables/Orders`, false));
         const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
         fs.mkdirSync(path.join(eg, 'commerce.profiles'), {recursive: true});
         fs.writeFileSync(
             path.join(eg, 'commerce.profiles', 'prod.yaml'),
             `semantic_model:\n  - name: commerce\n    entities:\n` +
                 `      - name: Order\n        source: ${
                     SPANNER_DB}/tables/Orders\n`);
         const byDefault = await createSemanticRuntimes({ctx: CTX});
         if ('error' in byDefault) throw new Error(byDefault.error);
         expect(byDefault[0].store?.name)
             .toBe('projects/acme-ops/instances/prod/databases/commerce');
         const wrapped = await createSemanticRuntimes({ctx: CTX, profile: 'prod'});
         if ('error' in wrapped) throw new Error(wrapped.error);
         expect(wrapped[0].storeError).toBeUndefined();
         expect(wrapped[0].store?.name)
             .toBe('projects/acme-ops/instances/prod/databases/commerce');
       });
});


// A legacy wrapper names its target in `deployment_target`. The loader turns
// it into a deployment called `default`, which the author never wrote, so a
// message names the key.
describe('a legacy wrapper whose deployment_target is in no accepted form', () => {
  test('is reported as the wrapper\'s deployment_target', async () => {
    writeModel(
        'commerce.yaml',
        model(
            `      - name: prod\n` +
                `        target: ${SPANNER_DB}/propertyGraphs/commerce\n`,
            `${SPANNER_DB}/tables/Orders`, false));
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(path.join(eg, 'commerce.profiles'), {recursive: true});
    fs.writeFileSync(
        path.join(eg, 'commerce.profiles', 'staging.yaml'),
        `semantic_model:\n  - name: commerce\n` +
            `    deployment_target: spanner:graph:acme-ops.regional-us.prod.commerce.commerce\n` +
            `    entities:\n      - name: Order\n        source: ${
                SPANNER_DB}/tables/Orders\n`);
    const rt = await createSemanticRuntimes({ctx: CTX, profile: 'staging'});
    if ('error' in rt) throw new Error(rt.error);
    expect(rt[0].storeError).not.toContain("deployment 'default'");
  });
});


// A deployment's `profile` names a profile the model does not declare.
describe('a deployment whose profile is a typo', () => {
  test('is reported', async () => {
    writeModel(
        'commerce.yaml',
        model(
            `      - name: prod\n` +
                `        target: ${SPANNER_DB}/propertyGraphs/commerce\n` +
                `        profile: prdo\n`,
            `${SPANNER_DB}/tables/Orders`).replace(/        executor:\n(.*\n){3}/, ''));
    writeModel(
        'commerce.profile.prod.yaml',
        `name: prod\nentities:\n  - name: Order\n    source: ${
            SPANNER_DB}/tables/Orders\nactions:\n  - name: IssueCredit\n    executor:\n      sql:\n        statements:\n          - UPDATE Orders SET Total = 0 WHERE OrderId = @order\n`);
    const code = await skillsGenerate({out: 'skills', profile: 'prod'});
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain("profile 'prdo'");
  });
});


// Resolving inheritance throws on a cycle. createSemanticRuntimes returns
// the error, as it does for every other model push refuses before any store.
describe('an inheritance cycle', () => {
  test('is returned as an error, naming the document and the model',
       async () => {
         writeModel('commerce.yaml', `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: prod
        target: ${SPANNER_DB}/propertyGraphs/commerce
    entities:
      - name: A
        extends: [B]
        source: ${SPANNER_DB}/tables/A
        primary_key: [key]
        fields:
          - { name: key, expression: Id }
      - name: B
        extends: [A]
        source: ${SPANNER_DB}/tables/B
        primary_key: [key]
        fields:
          - { name: key, expression: Id }
`);
         const rt = await createSemanticRuntimes({ctx: CTX});
         expect('error' in rt).toBe(true);
         if (!('error' in rt)) return;
         expect(rt.error).toStartWith("[commerce] model 'commerce': ");
         expect(rt.error).toContain('cycle');
       });
});


// A Cloud SQL table written as its resource name takes its dialect from its
// Knowledge Catalog entry, which the runtime looks up before it loads.
describe('a Cloud SQL source written as a resource name', () => {
  const TABLE = 'cloudsql.googleapis.com/projects/acme-ops/locations/us-central1/' +
      'instances/ms/databases/shop/schemas/sales/tables/Orders';
  const DEPLOY = '      - {name: default, target: ' +
      'bigquery.googleapis.com/projects/acme/datasets/d/propertyGraphs/g}\n';

  test('takes the dialect its catalog entry gives', async () => {
    writeModel('commerce.yaml', model(DEPLOY, TABLE, false));
    const lookup = stubCloudSqlEntry(200, 'cloudsql-sqlserver-table');
    const rt = await createSemanticRuntimes({ctx: CTX});
    if ('error' in rt) throw new Error(rt.error);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(rt[0].model.entities[0].sourceDialect).toBe('SQLSERVER');
  });

  test('a profile file that binds one takes the dialect its catalog entry gives', async () => {
    writeModel('commerce.yaml', model(DEPLOY, `${SPANNER_DB}/tables/Orders`, false));
    writeModel('commerce.profile.prod.yaml',
               `name: prod\nentities:\n  - name: Order\n    source: ${TABLE}\n`);
    stubCloudSqlEntry(200, 'cloudsql-sqlserver-table');
    const rt = await createSemanticRuntimes({ctx: CTX, profile: 'prod'});
    if ('error' in rt) throw new Error(rt.error);
    expect(rt[0].model.entities[0].sourceDialect).toBe('SQLSERVER');

    // So does a profile in a vanilla model's GOOGLE block, and one that binds
    // nothing keeps the model file's Spanner source, which needs no lookup.
    fs.rmSync(path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg', 'commerce.profile.prod.yaml'));
    const profiles = [
      {name: 'prod', entities: [{name: 'Order', source: TABLE}]},
      {name: 'logical', entities: []},
    ];
    writeModel('commerce.yaml', `version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    custom_extensions:
      - vendor_name: GOOGLE
        data: '${JSON.stringify({profiles})}'
    datasets:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - name: key
            expression: {dialects: [{dialect: ANSI_SQL, expression: OrderId}]}
`);
    for (const [profile, dialect] of [['prod', 'SQLSERVER'], ['logical', undefined]]) {
      const block = await createSemanticRuntimes({ctx: CTX, profile});
      if ('error' in block) throw new Error(block.error);
      expect(block[0].model.entities[0].sourceDialect).toBe(dialect);
    }
  });

  test('stops with the Dataplex message when its entry cannot be read', async () => {
    writeModel('commerce.yaml', model(DEPLOY, TABLE, false));
    stubCloudSqlEntry(403);
    const rt = await createSemanticRuntimes({ctx: CTX});
    expect('error' in rt && rt.error).toContain(
        "Turn on Dataplex integration for instance 'ms' (gcloud sql instances " +
        'patch ms --enable-dataplex-integration --project acme-ops)');
  });
});
