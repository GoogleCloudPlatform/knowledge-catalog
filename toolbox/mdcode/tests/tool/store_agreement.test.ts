// Push and the commands that read a model's store agree on which models they
// accept. Each case writes one scope and runs `kcmd push --validate-only`, the
// `kcmd profiles` report, `kcmd profiles --print-store` and
// `kcmd skills-generate` over it. No runtime command accepts a model push
// rejects, and none rejects a model push accepts. The exceptions are the ones
// the docs describe: a deployment that names a profile, an AlloyDB target, and
// several targets.
//
// Live checks are mocked, and no case reaches the network.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {AlloyDbClient} from '../../src/libts/gcp/alloydb';
import {ApiContext} from '../../src/libts/gcp/context';
import {CatalogClient} from '../../src/libts/gcp/dataplex';
import * as kc from '../../src/libts/semantic/deploy_knowledge_catalog';
import * as validateMod from '../../src/libts/semantic/validate';
import {profiles, push, skillsGenerate} from '../../src/tool/commands';

const CTX = new ApiContext('test-project', 'us', 'test-token');

const SPANNER_DB =
    '//spanner.googleapis.com/projects/acme-ops/instances/prod/databases/commerce';
const BQ = (dataset: string) =>
    `//bigquery.googleapis.com/projects/acme/datasets/${dataset}`;

let dir = '';
let cwd = '';
let logs: string[] = [];
let savedV2Aspects: string|undefined;

function eg(): string {
  return path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
}

function writeScope(files: Record<string, string>): void {
  fs.writeFileSync(
      path.join(dir, 'catalog.yaml'),
      'scope: semantic-model.test-project.us.commerce_eg\n');
  fs.mkdirSync(eg(), {recursive: true});
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(eg(), name)), {recursive: true});
    fs.writeFileSync(path.join(eg(), name), text);
  }
}

type Outcome = {code: number|string; out: string};

// Runs the four commands over the scope, under `profile` when given.
async function runAll(profile?: string): Promise<Record<string, Outcome>> {
  const p = profile ? {profile} : {};
  const out = path.join(dir, 'skills-out');
  const commands: Array<[string, () => Promise<number>]> = [
    ['push', () => push({validateOnly: true, ...p})],
    ['report', () => profiles({...p})],
    ['printStore', () => profiles({printStore: true, ...p})],
    ['skills', () => skillsGenerate({out, ...p})],
  ];
  const results: Record<string, Outcome> = {};
  for (const [name, run] of commands) {
    logs = [];
    let code: number|string;
    try {
      code = await run();
    } catch (e: any) {
      code = `threw: ${e?.message ?? e}`;
    }
    results[name] = {code, out: logs.join('\n')};
    fs.rmSync(out, {recursive: true, force: true});
  }
  return results;
}

function codes(r: Record<string, Outcome>): Record<string, number|string> {
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.code]));
}

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-store-agreement-'));
  process.chdir(dir);
  logs = [];
  savedV2Aspects = process.env.KC_V2_ASPECTS;
  delete process.env.KC_V2_ASPECTS;
  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  for (const channel of ['log', 'warn', 'error'] as const) {
    spyOn(console, channel).mockImplementation((...a: unknown[]) => {
      logs.push(a.join(' '));
    });
  }
  spyOn(globalThis, 'fetch').mockImplementation((async () => {
    throw new Error('a test made a network call');
  }) as any);
  // Push's live checks and its Knowledge Catalog leg. Their local checks run
  // before them, in prepareModels.
  spyOn(CatalogClient.prototype, 'getEntryType')
      .mockResolvedValue({status: 200, result: {}} as any);
  spyOn(CatalogClient.prototype, 'getAspectType')
      .mockResolvedValue({status: 200, result: {}} as any);
  spyOn(validateMod, 'validateBigQueryDataSources').mockResolvedValue([]);
  spyOn(validateMod, 'validateBigQueryActionStatements').mockResolvedValue([]);
  spyOn(validateMod, 'validateSpannerActionStatements').mockResolvedValue([]);
  spyOn(kc, 'deployKnowledgeCatalog').mockResolvedValue({
    success: true,
    warnings: [],
    plan: [],
    created: 0,
    updated: 0,
    deleted: 0,
  } as any);
});

afterEach(() => {
  if (savedV2Aspects === undefined) {
    delete process.env.KC_V2_ASPECTS;
  } else {
    process.env.KC_V2_ASPECTS = savedV2Aspects;
  }
  process.chdir(cwd);
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
  mock.restore();
});


// The control: one Spanner deployment, every source in its database.
describe('control', () => {
  test('a Spanner model every command accepts', async () => {
    writeScope({'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: prod
        target: ${SPANNER_DB}/propertyGraphs/commerce
    entities:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
`});
    const r = await runAll();
    expect(codes(r)).toEqual({push: 0, report: 0, printStore: 0, skills: 0});
  });
});


// A BigQuery graph lives in one dataset and may read tables in another, or a
// BigLake table. Push accepts both, since all of BigQuery is one database.
// The runtime takes the graph's dataset as the store and gives no store for
// such a model, and skills-generate still writes the skill.
describe('a BigQuery model whose tables sit outside the graph dataset', () => {
  function bigQueryModel(source: string): string {
    return `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: prod
        target: ${BQ('graphs')}/propertyGraphs/commerce
    entities:
      - name: Order
        source: ${source}
        primary_key: [key]
        fields:
          - { name: key, expression: order_id }
`;
  }

  test('a table in another dataset: push accepts, so skills-generate does too',
       async () => {
         writeScope({'commerce.yaml': bigQueryModel(`${BQ('raw')}/tables/orders`)});
         const r = await runAll();
         expect(r.push.code).toBe(0);
         expect(r.report.code).toBe(0);
         expect(r.skills.out).not.toContain('Error:');
         expect(r.skills.code).toBe(0);
       });

  test('a BigLake table: push accepts, so skills-generate does too',
       async () => {
         writeScope({
           'commerce.yaml': bigQueryModel(
               '//biglake.googleapis.com/projects/acme/catalogs/lake/' +
               'namespaces/sales/tables/orders'),
         });
         const r = await runAll();
         expect(r.push.code).toBe(0);
         expect(r.report.code).toBe(0);
         expect(r.skills.out).not.toContain('Error:');
         expect(r.skills.code).toBe(0);
       });
});


// A deployment whose `profile` names no profile the model declares. Push
// refuses any deployment that names a profile, and the runtime refuses one
// that names an undeclared profile.
describe('a deployment that names an undeclared profile', () => {
  test('push rejects it, so skills-generate does too', async () => {
    writeScope({'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: prod
        target: ${SPANNER_DB}/propertyGraphs/commerce
        profile: prdo
    entities:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
`});
    const r = await runAll();
    expect(r.push.code).toBe(1);
    expect(r.report.code).toBe(1);
    expect(r.printStore.code).toBe(1);
    expect(r.skills.code).toBe(1);
  });

  test('a typo for a declared profile file fails as push does',
       async () => {
         writeScope({
           'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: prod
        target: ${SPANNER_DB}/propertyGraphs/commerce
        profile: prdo
    entities:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
`,
           'commerce.profile.prod.yaml': `name: prod
entities:
  - name: Order
    source: ${SPANNER_DB}/tables/Orders
`,
         });
         const r = await runAll('prod');
         expect(r.push.code).toBe(1);
         expect(r.skills.code).toBe(1);
       });
});


// A vanilla model's GOOGLE block lists something that is not a string. Push
// and the runtime both read it as a target in no accepted form.
describe('a vanilla GOOGLE block whose deploymentTargets holds a non-string',
         () => {
           test('push rejects it, so skills-generate does too', async () => {
             writeScope({'commerce.yaml': `version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    custom_extensions:
      - vendor_name: GOOGLE
        data: '{"deploymentTargets": [42]}'
    datasets:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - name: key
            expression: {dialects: [{dialect: ANSI_SQL, expression: OrderId}]}
`});
             const r = await runAll();
             expect(codes(r))
                 .toEqual({push: 1, report: 1, printStore: 1, skills: 1});
           });

           test('beside a padded valid target, push rejects it, so skills-generate does too',
                async () => {
                  writeScope({'commerce.yaml': `version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    custom_extensions:
      - vendor_name: GOOGLE
        data: '{"deploymentTargets": ["  ${SPANNER_DB}/propertyGraphs/commerce  ", 42]}'
    datasets:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - name: key
            expression: {dialects: [{dialect: ANSI_SQL, expression: OrderId}]}
`});
                  const r = await runAll();
                  expect(codes(r)).toEqual(
                      {push: 1, report: 1, printStore: 1, skills: 1});
                });
         });


// A vanilla model's GOOGLE block lists only blank targets. They name nothing,
// so push publishes to Knowledge Catalog only and the runtime finds no store.
describe('a vanilla GOOGLE block whose deploymentTargets are all blank', () => {
  test('push accepts it, so skills-generate does too', async () => {
    writeScope({'commerce.yaml': `version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    custom_extensions:
      - vendor_name: GOOGLE
        data: '{"deploymentTargets": ["  ", ""]}'
    datasets:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - name: key
            expression: {dialects: [{dialect: ANSI_SQL, expression: OrderId}]}
`});
    const r = await runAll();
    expect(codes(r)).toEqual({push: 0, report: 0, printStore: 1, skills: 0});
    expect(r.printStore.out).toContain('declares no deployment target');
    expect(r.skills.out).not.toContain('Error:');
  });
});


// A legacy wrapper that sets `deployment_target` to an empty string. Push
// reads no graph target and publishes to Knowledge Catalog only, and the
// loader makes no deployment of it.
describe('a legacy wrapper with an empty deployment_target', () => {
  test('push accepts it, so skills-generate does too', async () => {
    writeScope({
      'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
`,
      'commerce.profiles/prod.yaml': `semantic_model:
  - name: commerce
    deployment_target: ""
    entities:
      - name: Order
        source: ${SPANNER_DB}/tables/OrdersProd
`,
    });
    const r = await runAll('prod');
    expect(r.push.code).toBe(0);
    expect(r.report.code).toBe(0);
    expect(r.skills.out).not.toContain('Error:');
    expect(r.skills.code).toBe(0);
  });
});


// The differences the docs describe, and cases where every command agrees.
describe('documented divergences', () => {
  test('a deployment that names a declared profile: push refuses, the runtime uses it',
       async () => {
         writeScope({
           'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: prod
        target: ${SPANNER_DB}/propertyGraphs/commerce
        profile: prod
    entities:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
`,
           'commerce.profile.prod.yaml': `name: prod
entities:
  - name: Order
    source: ${SPANNER_DB}/tables/Orders
`,
         });
         const r = await runAll('prod');
         expect(codes(r)).toEqual({push: 1, report: 1, printStore: 0, skills: 0});
         expect(r.printStore.out).toBe('acme-ops/prod/commerce');
       });

  test('Spanner beside BigQuery: push refuses two, the runtime takes Spanner',
       async () => {
         writeScope({'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: sp
        target: ${SPANNER_DB}/propertyGraphs/commerce
      - name: bq
        target: ${BQ('graphs')}/propertyGraphs/commerce
    entities:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
`});
         const r = await runAll();
         expect(codes(r)).toEqual({push: 1, report: 1, printStore: 0, skills: 0});
       });

  test('a vanilla GOOGLE block with two Spanner targets: every command refuses',
       async () => {
         writeScope({'commerce.yaml': `version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    custom_extensions:
      - vendor_name: GOOGLE
        data: '{"deploymentTargets": ["${SPANNER_DB}/propertyGraphs/a", "${SPANNER_DB}2/propertyGraphs/b"]}'
    datasets:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - name: key
            expression: {dialects: [{dialect: ANSI_SQL, expression: OrderId}]}
`});
         const r = await runAll();
         expect(codes(r)).toEqual({push: 1, report: 1, printStore: 1, skills: 1});
         expect(r.skills.out).toContain(
             "in its GOOGLE block's 'deploymentTargets'");
       });

  test('a vanilla GOOGLE block with no target: none of the four says deployments',
       async () => {
         writeScope({'commerce.yaml': `version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    custom_extensions:
      - vendor_name: GOOGLE
        data: '{"deploymentTargets": []}'
    datasets:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - name: key
            expression: {dialects: [{dialect: ANSI_SQL, expression: OrderId}]}
`});
         const r = await runAll();
         expect(codes(r)).toEqual({push: 0, report: 0, printStore: 1, skills: 0});
         expect(r.printStore.out).toContain(
             "declares no deployment target in its GOOGLE block's " +
             "'deploymentTargets'");
         expect(r.printStore.out).not.toContain("Declare one deployment");
       });

  test('a duplicate target: the loader refuses it for every command', async () => {
    writeScope({'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: a
        target: ${SPANNER_DB}/propertyGraphs/commerce
      - name: b
        target: ${SPANNER_DB}/propertyGraphs/commerce
        profile: prod
    entities:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
`});
    const r = await runAll();
    expect(codes(r)).toEqual({push: 1, report: 1, printStore: 1, skills: 1});
  });

  test('a malformed deployment beside a valid one for the same profile: every command refuses',
       async () => {
         writeScope({'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: a
        target: ${SPANNER_DB}/propertyGraphs/commerce
      - name: b
        target: ${SPANNER_DB}/propertyGraph/typo
    entities:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
`});
         const r = await runAll();
         expect(codes(r)).toEqual({push: 1, report: 1, printStore: 1, skills: 1});
       });

  test('a logical model with no deployments: push and skills-generate accept it',
       async () => {
         writeScope({'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Order
        primary_key: [key]
        fields:
          - { name: key }
`});
         const r = await runAll();
         expect(codes(r)).toEqual({push: 0, report: 0, printStore: 1, skills: 0});
       });
});


// --print-store refuses a scope of several models before it looks up any
// AlloyDB cluster in it.
describe('kcmd profiles --print-store over several models', () => {
  test('refuses before any AlloyDB lookup', async () => {
    const list = spyOn(AlloyDbClient.prototype, 'listInstances')
                     .mockResolvedValue({status: 200, result: []});
    const cluster =
        '//alloydb.googleapis.com/projects/acme/locations/us-central1/clusters/main';
    const alloy = (name: string) => `version: "0.2.0.dev0/google"
semantic_model:
  - name: ${name}
    deployments:
      - name: prod
        target: ${cluster}/databases/${name}
    entities:
      - name: Order
        source: ${cluster}/databases/${name}/schemas/public/tables/orders
        primary_key: [key]
        fields:
          - { name: key, expression: order_id }
`;
    writeScope({'a.yaml': alloy('a'), 'b.yaml': alloy('b')});
    logs = [];
    expect(await profiles({printStore: true})).toBe(1);
    expect(logs.join('\n')).toContain('this scope holds 2 models');
    expect(list).not.toHaveBeenCalled();
  });
});
