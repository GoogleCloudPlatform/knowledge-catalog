// Push and the commands that read a model's store agree on a model's
// deployments and profile files. Each case writes one scope and runs
// `kcmd push --validate-only`, the `kcmd profiles` report,
// `kcmd profiles --print-store` and `kcmd skills-generate` over it. On
// deployments and profile files, no runtime command accepts a model push
// rejects, and none rejects a model push accepts, apart from a few cases. The
// docs describe a deployment that names a profile, `default` included, a
// profile file that no deployment uses, an AlloyDB target and several
// targets. Push also accepts a Spanner model that binds a table outside its
// database today. The runtime refuses it on purpose: a write would land in
// the target database's table of that name, so --print-store gives no store
// and skills-generate fails for a model with actions.
//
// Of push's checks on the model itself, the runtime runs only the one on
// inheritance. A model that push refuses for an entity with no source, a
// relationship with no join columns, a key that is not a column, or a broken
// expression, action or constraint still gets a store and a skill. Like push,
// the runtime loads every profile file except a legacy wrapper of a profile
// it does not read. It does not run push's checks that every named profile
// applies to the model and is complete. So a model whose profile file or
// GOOGLE block profile those checks refuse still gets a store and a skill
// under the default profile. The runtime also skips the
// checks of push's Knowledge Catalog leg: one model per entry group, and with
// KC_V2_ASPECTS off the checks on the copies of the model and profile files,
// such as whether each is valid UTF-8. Two models that deploy to one graph
// each get a skill.
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


// A BigQuery table name may hold characters a dataset name may not, such as a
// `$` or a letter outside ASCII. The loader accepts them. The table is still
// in the graph's dataset, so the runtime gives that store.
describe('a BigQuery table name with $ or a non-ASCII letter', () => {
  for (const table of ['orders$20260101', 'bestellungen_ä']) {
    test(`'${table}' in the graph dataset: every command accepts it`,
         async () => {
           writeScope({'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: prod
        target: ${BQ('graphs')}/propertyGraphs/commerce
    entities:
      - name: Order
        source: ${BQ('graphs')}/tables/${table}
        primary_key: [key]
        fields:
          - { name: key, expression: order_id }
`});
           const r = await runAll();
           expect(codes(r))
               .toEqual({push: 0, report: 0, printStore: 0, skills: 0});
           expect(r.printStore.out).toBe('bigquery:acme/graphs');
         });
  }
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


// A vanilla model's GOOGLE block lists a BigQuery target twice beside a
// Spanner target. The Spanner target alone would give a store, and every push
// refuses the repeat.
describe('a vanilla GOOGLE block that lists a target twice', () => {
  test('beside a Spanner target, push rejects it, so skills-generate does too',
       async () => {
         const graph = `${BQ('graphs')}/propertyGraphs/commerce`;
         writeScope({'commerce.yaml': `version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    custom_extensions:
      - vendor_name: GOOGLE
        data: '{"deploymentTargets": ["${SPANNER_DB}/propertyGraphs/commerce", "${graph}", "${graph}"]}'
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
         expect(r.printStore.out)
             .toContain(`declares duplicate deployment target '${graph}'`);
         expect(r.skills.out)
             .toContain(`declares duplicate deployment target '${graph}'`);
       });

  // A resource name and its URI name the same target, so listing the graph
  // once each way is a repeat too.
  test('once as its URI and once as its resource name, every command refuses',
       async () => {
         const graph = `${BQ('graphs')}/propertyGraphs/commerce`;
         const name = graph.slice(2);
         writeScope({'commerce.yaml': `version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    custom_extensions:
      - vendor_name: GOOGLE
        data: '{"deploymentTargets": ["${SPANNER_DB}/propertyGraphs/commerce", "${graph}", "${name}"]}'
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
         expect(r.printStore.out)
             .toContain(`declares duplicate deployment target '${name}'`);
         expect(r.skills.out)
             .toContain(`declares duplicate deployment target '${name}'`);
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


// An entity extends one the model does not declare. The loader lets it
// through, and push reports it when it resolves inheritance.
describe('an entity that extends an unknown entity', () => {
  test('push rejects it, so skills-generate does too, naming the model',
       async () => {
         writeScope({'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: prod
        target: ${SPANNER_DB}/propertyGraphs/commerce
    entities:
      - name: Order
        extends: [Missing]
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
`});
         const r = await runAll();
         expect(codes(r)).toEqual({push: 1, report: 1, printStore: 1, skills: 1});
         for (const name of ['push', 'printStore', 'skills']) {
           expect(r[name].out).toContain("model 'commerce'");
           expect(r[name].out)
               .toContain("entity 'Order' extends unknown entity 'Missing'");
         }
       });
});


// A cycle, and a field two unrelated ancestors both declare. Push reports
// each when it resolves inheritance, and so does the runtime.
describe('an inheritance cycle or an ambiguous inherited field', () => {
  const cases: Array<[string, string, string]> = [
    ['a cycle', `      - name: A
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
`, "'extends' must not form a cycle"],
    ['an ambiguous field', `      - name: P
        abstract: true
        fields:
          - { name: f, datatype: string }
      - name: Q
        abstract: true
        fields:
          - { name: f, datatype: string }
      - name: C
        extends: [P, Q]
        source: ${SPANNER_DB}/tables/C
        primary_key: [key]
        fields:
          - { name: key, expression: Id }
          - { name: f, expression: F }
`, "inherits field 'f' from 'P' and from 'Q'"],
  ];
  for (const [label, entities, message] of cases) {
    test(`${label}: push rejects it, so skills-generate does too`, async () => {
      writeScope({'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: prod
        target: ${SPANNER_DB}/propertyGraphs/commerce
    entities:
${entities}`});
      const r = await runAll();
      expect(codes(r)).toEqual({push: 1, report: 1, printStore: 1, skills: 1});
      for (const name of ['push', 'printStore', 'skills']) {
        expect(r[name].out).toContain("model 'commerce'");
        expect(r[name].out).toContain(message);
      }
    });
  }
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

  // A model with a deployment dev for default, and a deployment prod for the
  // declared profile prod.
  function devAndProd(prodTarget: string): Record<string, string> {
    return {
      'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: dev
        target: ${SPANNER_DB}/propertyGraphs/commerce
      - name: prod
        target: ${prodTarget}
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
    };
  }

  test('a malformed deployment for another declared profile: every command refuses',
       async () => {
         writeScope(devAndProd(`${SPANNER_DB}/propertyGraph/typo`));
         const r = await runAll();
         expect(codes(r)).toEqual({push: 1, report: 1, printStore: 1, skills: 1});
         expect(r.printStore.out).toContain("deployment 'prod' targets");
         expect(r.skills.out).toContain("deployment 'prod' targets");
       });

  // Push refuses a deployment that names a profile, whatever its target. The
  // runtime uses dev, as the docs say.
  test('a valid deployment for another declared profile: push refuses, the runtime uses dev',
       async () => {
         writeScope(devAndProd(`${SPANNER_DB}2/propertyGraphs/commerce`));
         const r = await runAll();
         expect(codes(r)).toEqual({push: 1, report: 1, printStore: 0, skills: 0});
         expect(r.printStore.out).toBe('acme-ops/prod/commerce');
       });

  test('a malformed deployment for default under a profile file: every command refuses',
       async () => {
         writeScope({
           'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: dev
        target: ${SPANNER_DB}/propertyGraph/typo
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
         expect(codes(r)).toEqual({push: 1, report: 1, printStore: 1, skills: 1});
         expect(r.printStore.out).toContain("deployment 'dev' targets");
         expect(r.skills.out).toContain("deployment 'dev' targets");
       });

  test('a legacy profile named default in any letter case: every command refuses',
       async () => {
         const reserved = "a binding profile may not be named 'default'";
         for (const file of ['Default.yaml', 'default.yaml']) {
           fs.rmSync(path.join(dir, 'catalog'), {recursive: true, force: true});
           writeScope({
             'commerce.yaml': `version: "0.2.0.dev0/google"
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
`,
             [`commerce.profiles/${file}`]: `semantic_model:
  - name: commerce
    entities:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
`,
           });
           for (const profile of [undefined, 'Default']) {
             const r = await runAll(profile);
             expect(codes(r))
                 .toEqual({push: 1, report: 1, printStore: 1, skills: 1});
             expect(r.printStore.out).toContain(reserved);
             expect(r.skills.out).toContain(reserved);
           }
         }
       });

  // Push and the report read every model's profile files first. A file whose
  // `name:` does not match its file name throws there, and the CLI prints the
  // error and exits 1.
  test('a profile file whose name does not match its file name: every command refuses',
       async () => {
         writeScope({
           'commerce.yaml': `version: "0.2.0.dev0/google"
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
`,
           'commerce.profile.prod.yaml': `name: prd
entities:
  - name: Order
    source: ${SPANNER_DB}/tables/Orders
`,
         });
         const mismatch = "Profile file 'commerce.profile.prod.yaml' declares " +
             "name 'prd', which does not match filename suffix 'prod'.";
         const r = await runAll();
         expect(codes(r)).toEqual({
           push: `threw: ${mismatch}`,
           report: `threw: ${mismatch}`,
           printStore: 1,
           skills: 1,
         });
         expect(r.printStore.out).toBe(`Error: ${mismatch}`);
         expect(r.skills.out).toBe(`Error: ${mismatch}`);
       });

  // Push checks every profile file, whichever profile it deploys, so under the
  // default profile it refuses a profile file that names an entity the model
  // lacks. The report refuses it too. The runtime applies only the profile it
  // is given, so --print-store and skills-generate accept the file.
  test('a profile file that does not apply: push refuses it under default, the runtime accepts it',
       async () => {
         writeScope({
           'commerce.yaml': `version: "0.2.0.dev0/google"
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
`,
           'commerce.profile.prod.yaml': `name: prod
entities:
  - name: Nope
    source: ${SPANNER_DB}/tables/Orders
`,
         });
         const r = await runAll();
         expect(codes(r)).toEqual({push: 1, report: 1, printStore: 0, skills: 0});
         expect(r.push.out).toContain(
             "Error: [commerce.profile.prod.yaml] profile 'prod': entity " +
             "'Nope' is not in the logical model");
         expect(r.report.out).toContain("entity 'Nope' is not in the logical model");
       });

  // Push and the runtime load every profile file except a legacy wrapper,
  // whichever profile they read. A file in <model>.profiles/ takes its
  // profile name from its file name, and loading it checks the `name:`
  // inside it.
  test('a file in <model>.profiles/ whose name does not match its file name: every command refuses',
       async () => {
         writeScope({
           'commerce.yaml': `version: "0.2.0.dev0/google"
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
`,
           'commerce.profiles/prod.yaml': `name: prd
entities:
  - name: Order
    source: ${SPANNER_DB}/tables/Orders
`,
         });
         const mismatch = "[commerce.profiles/prod.yaml] profile 'prod' " +
             "declares name 'prd', which does not match its file's profile " +
             "name 'prod'";
         for (const r of [await runAll(), await runAll('prod')]) {
           expect(codes(r))
               .toEqual({push: 1, report: 1, printStore: 1, skills: 1});
           expect(r.push.out).toContain(`Error: ${mismatch}`);
           expect(r.printStore.out).toBe(`Error: ${mismatch}`);
           expect(r.skills.out).toContain(`Error: ${mismatch}`);
         }
       });

  test('a profile file that sets a key a profile may not set: every command refuses',
       async () => {
         writeScope({
           'commerce.yaml': `version: "0.2.0.dev0/google"
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
`,
           'commerce.profile.prod.yaml': `name: prod
bogus: 1
entities:
  - name: Order
    source: ${SPANNER_DB}/tables/Orders
`,
         });
         const r = await runAll();
         expect(codes(r))
             .toEqual({push: 1, report: 1, printStore: 1, skills: 1});
         expect(r.printStore.out)
             .toContain("[commerce.profile.prod.yaml] profile 'prod'");
         expect(r.push.out).toContain(r.printStore.out);
         expect(r.skills.out).toBe(r.printStore.out);
       });

  // Push loads the model files before the profile files it does not apply.
  // When both fail to load, every command gives the model file's error.
  test('a model file and a profile file that both fail to load: every command gives the model file error',
       async () => {
         writeScope({
           'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    bogus_model_key: 1
    deployments:
      - name: prod
        target: ${SPANNER_DB}/propertyGraphs/commerce
    entities:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
`,
           'commerce.profile.prod.yaml': 'name: prod\nbogus: 1\n',
         });
         const r = await runAll();
         for (const k of ['push', 'printStore', 'skills']) {
           expect(r[k].code).toBe(1);
           expect(r[k].out).toContain("Error: Model document 'commerce'");
           expect(r[k].out).not.toContain("sets 'bogus'");
         }
       });

  test('a profile file that is not valid UTF-8: push refuses its copy, the runtime reads it',
       async () => {
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
         fs.writeFileSync(
             path.join(eg(), 'commerce.profile.prod.yaml'),
             Buffer.concat([
               Buffer.from('name: prod\n# '),
               Buffer.from([0xff]),
               Buffer.from(
                   `\nentities:\n  - name: Order\n    source: ${
                       SPANNER_DB}/tables/Orders\n`),
             ]));
         const r = await runAll();
         expect(codes(r)).toEqual({push: 1, report: 1, printStore: 0, skills: 0});
         expect(r.push.out).toContain('is not valid UTF-8');
       });

  test('a deployment that names profile default: push refuses, the runtime uses it',
       async () => {
         writeScope({'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: prod
        target: ${SPANNER_DB}/propertyGraphs/commerce
        profile: default
    entities:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
`});
         const r = await runAll();
         expect(codes(r)).toEqual({push: 1, report: 1, printStore: 0, skills: 0});
         expect(r.printStore.out).toBe('acme-ops/prod/commerce');
       });

  test('a profile file no deployment uses: push refuses, skills-generate writes a skill with no store',
       async () => {
         writeScope({
           'commerce.yaml': `version: "0.2.0.dev0/google"
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
`,
           'commerce.profile.prod.yaml': `name: prod
entities:
  - name: Order
    source: ${SPANNER_DB}/tables/Orders
`,
         });
         const r = await runAll('prod');
         expect(codes(r)).toEqual({push: 1, report: 1, printStore: 1, skills: 0});
         expect(r.push.out).toContain("binding profile 'prod' is a named profile");
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


// The report and --print-store describe one profile's store the same way.
describe('kcmd profiles: the report and --print-store on one profile', () => {
  test('the report names the target --print-store prints', async () => {
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
    expect(r.printStore.out).toBe('acme-ops/prod/commerce');
    expect(r.report.out).not.toContain(
        'target: (none; a profile file names no deployment target)');
    expect(r.report.out).toContain(
        `target: ${SPANNER_DB}/propertyGraphs/commerce`);
  });
});


// --print-store and skills-generate --name refuse a scope of several models
// before they look up any AlloyDB cluster in it.
describe('--print-store and skills-generate --name over several models', () => {
  test('refuse before any AlloyDB lookup', async () => {
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
    logs = [];
    const out = path.join(dir, 'skills-out');
    expect(await skillsGenerate({out, name: 'custom'})).toBe(1);
    expect(logs.join('\n')).toContain(
        '--name applies to one skill, and this scope has 2 models');
    expect(list).not.toHaveBeenCalled();
    // Without --name, skills-generate looks up the cluster.
    await skillsGenerate({out});
    expect(list).toHaveBeenCalled();
  });
});


// A vanilla model carries its profiles, deployments and `extends` in GOOGLE
// blocks. Each case writes the Google-flavor scope, with deployments and a
// profile file, then the equivalent vanilla scope, and expects every command
// to give the same result for both.
describe('a vanilla model with GOOGLE blocks agrees with the Google flavor', () => {
  type Deployment = {name: string; target: string; profile?: string};

  const prodProfile = `name: prod
entities:
  - name: Order
    source: ${SPANNER_DB}/tables/Orders
`;

  function googleScope(deployments: Deployment[], extendsList?: string[]):
      Record<string, string> {
    const lines = deployments.map(
        d => `      - name: ${d.name}\n        target: ${d.target}\n` +
            (d.profile ? `        profile: ${d.profile}\n` : ''));
    return {
      'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
${lines.join('')}    entities:
      - name: Order
${extendsList ? `        extends: [${extendsList.join(', ')}]\n` : ''}\
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
`,
      'commerce.profile.prod.yaml': prodProfile,
    };
  }

  function vanillaScope(deployments: Deployment[], extendsList?: string[]):
      Record<string, string> {
    const model = JSON.stringify({
      profiles: [{
        name: 'prod',
        entities: [{name: 'Order', source: `${SPANNER_DB}/tables/Orders`}],
      }],
      deployments,
    });
    const dataset = extendsList ?
        `        custom_extensions:
          - vendor_name: GOOGLE
            data: '${JSON.stringify({extends: extendsList})}'
` :
        '';
    return {
      'commerce.yaml': `version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    custom_extensions:
      - vendor_name: GOOGLE
        data: '${model}'
    datasets:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
${dataset}        fields:
          - name: key
            expression: {dialects: [{dialect: ANSI_SQL, expression: OrderId}]}
`,
    };
  }

  // Runs the four commands over each flavor's scope, in a fresh directory.
  async function bothFlavors(
      deployments: Deployment[], profile?: string, extendsList?: string[]):
      Promise<{google: Record<string, Outcome>; vanilla: Record<string, Outcome>}> {
    writeScope(googleScope(deployments, extendsList));
    const google = await runAll(profile);
    fs.rmSync(path.join(dir, 'catalog'), {recursive: true, force: true});
    writeScope(vanillaScope(deployments, extendsList));
    const vanilla = await runAll(profile);
    return {google, vanilla};
  }

  const dev = {name: 'dev', target: `${SPANNER_DB}/propertyGraphs/commerce`};
  const prod = (target: string) => ({name: 'prod', target, profile: 'prod'});

  // The runtime checks that each deployment's profile is declared. A vanilla
  // model declares prod in its GOOGLE block.
  test('a deployment for a declared profile, under default: the runtime uses dev',
       async () => {
         const {google, vanilla} = await bothFlavors(
             [dev, prod(`${SPANNER_DB}2/propertyGraphs/commerce`)]);
         expect(codes(google))
             .toEqual({push: 1, report: 1, printStore: 0, skills: 0});
         expect(codes(vanilla)).toEqual(codes(google));
         // The vanilla expression form adds a dialect warning on its own line.
         expect(vanilla.printStore.out.split('\n').pop())
             .toBe(google.printStore.out);
       });

  test('a deployment for a declared profile, under it: the runtime uses it',
       async () => {
         const {google, vanilla} = await bothFlavors(
             [prod(`${SPANNER_DB}/propertyGraphs/commerce`)], 'prod');
         expect(codes(google))
             .toEqual({push: 1, report: 1, printStore: 0, skills: 0});
         expect(codes(vanilla)).toEqual(codes(google));
         expect(vanilla.printStore.out.split('\n').pop())
             .toBe('acme-ops/prod/commerce');
       });

  test('a deployment for an undeclared profile: every runtime command refuses',
       async () => {
         const {google, vanilla} = await bothFlavors([
           dev,
           {name: 'prod', target: `${SPANNER_DB}2/propertyGraphs/commerce`,
            profile: 'prdo'},
         ]);
         expect(codes(google))
             .toEqual({push: 1, report: 1, printStore: 1, skills: 1});
         expect(codes(vanilla)).toEqual(codes(google));
         expect(vanilla.printStore.out).toContain(
             "deployment 'prod' names unknown binding profile 'prdo'; " +
             'defined profiles: prod.');
       });

  test('a malformed deployment for another declared profile: every command refuses',
       async () => {
         const {google, vanilla} = await bothFlavors(
             [dev, prod(`${SPANNER_DB}/propertyGraph/typo`)]);
         expect(codes(google))
             .toEqual({push: 1, report: 1, printStore: 1, skills: 1});
         expect(codes(vanilla)).toEqual(codes(google));
         expect(vanilla.printStore.out).toContain("deployment 'prod' targets");
       });

  test('an extends that names an unknown entity: every command refuses',
       async () => {
         const {google, vanilla} = await bothFlavors([dev], undefined, ['Missing']);
         expect(codes(google))
             .toEqual({push: 1, report: 1, printStore: 1, skills: 1});
         expect(codes(vanilla)).toEqual(codes(google));
         for (const name of ['printStore', 'skills']) {
           expect(vanilla[name].out)
               .toContain("entity 'Order' extends unknown entity 'Missing'");
         }
       });
});
