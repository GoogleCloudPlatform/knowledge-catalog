// Tests for `kcmd skills-generate` (src/tool/commands.ts, skillsGenerate()) --
// what reaches the filesystem, rather than what the generator composes.
//
// The document's own shape is covered in tests/libts/semantic/skills.test.ts,
// which needs no disk. What is under test here is the part that can lose work:
// which directory a skill lands in, what happens to the skill already there,
// and what happens when two models want the same one. It runs in a temp
// working directory with a pinned context, mirroring action.test.ts. The
// store each profile runs against, which a skill reports, is covered here too,
// through createSemanticRuntimes.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {AlloyDbClient} from '../../src/libts/gcp/alloydb';
import {ApiContext} from '../../src/libts/gcp/context';
import {readableEntities} from '../../src/libts/semantic/runtime/agent_tools';
import {dialectFor} from '../../src/libts/semantic/runtime/dialect';
import {createSemanticRuntimes} from '../../src/libts/semantic/runtime/runtime';
import {storeLine} from '../../src/libts/semantic/runtime/store';
import {skillsGenerate} from '../../src/tool/commands';

const CTX = new ApiContext('test-project', 'us', 'test-token');

const SPANNER = '//spanner.googleapis.com/projects/acme-ops/instances/prod';

function modelText(name: string, action: string): string {
  return `version: "0.2.0.dev0/google"
semantic_model:
  - name: ${name}
    description: Orders and what they are made of.
    deployments:
      - name: prod
        target: ${SPANNER}/databases/commerce/propertyGraphs/commerce
    entities:
      - name: Order
        source: ${SPANNER}/databases/commerce/tables/Orders
        primary_key: [key]
        fields:
          - { name: key, expression: OrderId }
          - { name: total, expression: Total }
    actions:
      - name: ${action}
        description: Does a thing to an order.
        executor:
          sql:
            statements:
              - UPDATE Orders SET Total = 0 WHERE OrderId = @order
        parameters:
          - {name: order, type: Order}
        affects:
          - {concept: Order, operation: modify}
`;
}

let dir = '';
let cwd = '';
let logs: string[] = [];

function writeModel(file: string, text: string): void {
  fs.writeFileSync(
      path.join(dir, 'catalog.yaml'),
      'scope: semantic-model.test-project.us.commerce_eg\n');
  const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
  fs.mkdirSync(eg, {recursive: true});
  fs.writeFileSync(path.join(eg, file), text);
}

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-skills-'));
  process.chdir(dir);
  logs = [];
  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  for (const channel of ['log', 'warn', 'error'] as const) {
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


describe('kcmd skills-generate: what lands on disk', () => {
  test('the directory is named for the skill, not for the caller', async () => {
    writeModel('commerce.yaml', modelText('commerce', 'IssueCredit'));
    expect(await skillsGenerate({out: 'skills'})).toBe(0);
    expect(fs.existsSync(path.join('skills', 'commerce', 'SKILL.md')))
        .toBe(true);
    expect(fs.existsSync(path.join(
               'skills', 'commerce', 'references', 'issue-credit.md')))
        .toBe(true);
  });

  test('--name names the skill of a scope with one model', async () => {
    writeModel('commerce.yaml', modelText('commerce', 'IssueCredit'));
    expect(await skillsGenerate({out: 'skills', name: 'orders'})).toBe(0);
    expect(fs.existsSync(path.join('skills', 'orders', 'SKILL.md')))
        .toBe(true);
    expect(fs.existsSync(path.join('skills', 'commerce'))).toBe(false);
  });

  test('an existing skill is not overwritten without --force', async () => {
    writeModel('commerce.yaml', modelText('commerce', 'IssueCredit'));
    expect(await skillsGenerate({out: 'skills'})).toBe(0);
    logs = [];
    expect(await skillsGenerate({out: 'skills'})).toBe(1);
    expect(logs.join('\n')).toContain('--force');
  });
});


describe('kcmd skills-generate: a broken profile file', () => {
  test('is reported as an error, not thrown', async () => {
    writeModel('commerce.yaml', modelText('commerce', 'IssueCredit'));
    writeModel('commerce.profile.prod.yaml', 'name: staging\n');
    expect(await skillsGenerate({out: 'skills', profile: 'prod'})).toBe(1);
    expect(logs.join('\n')).toContain('commerce.profile.prod.yaml');
  });
});


describe('kcmd skills-generate: a profile file', () => {
  // A profile file names no deployment target, so the skill says there is no
  // store to run its actions against.
  test('has no store', async () => {
    // A `sql` executor names one database's tables, so it lives in the
    // profile.
    writeModel(
        'commerce.yaml',
        modelText('commerce', 'IssueCredit')
            .replace(/        executor:\n(.*\n){3}/, ''));
    writeModel('commerce.profile.prod.yaml', `name: prod
entities:
  - name: Order
    source: ${SPANNER}/databases/commerce_prod/tables/Orders
actions:
  - name: IssueCredit
    executor:
      sql:
        statements:
          - UPDATE Orders SET Total = 0 WHERE OrderId = @order
`);
    expect(await skillsGenerate({out: 'skills', profile: 'prod'})).toBe(0);
    const skill =
        fs.readFileSync(path.join('skills', 'commerce', 'SKILL.md'), 'utf8');
    expect(skill).toContain('Store: none.');
    expect(skill).toContain(
        "binding profile 'prod' is a named profile, which names no deployment " +
        'target');
  });
});


describe('kcmd skills-generate: --force replaces rather than layers', () => {
  test('a page for an action the model dropped is removed', async () => {
    // Progressive disclosure means an agent opens files under references/ on
    // demand. A page left behind by a rename is read as current and describes
    // a call the CLI will reject as unknown.
    writeModel('commerce.yaml', modelText('commerce', 'PlaceOrder'));
    expect(await skillsGenerate({out: 'skills'})).toBe(0);
    const stale =
        path.join('skills', 'commerce', 'references', 'place-order.md');
    expect(fs.existsSync(stale)).toBe(true);

    writeModel('commerce.yaml', modelText('commerce', 'CreateOrder'));
    logs = [];
    expect(await skillsGenerate({out: 'skills', force: true})).toBe(0);
    expect(fs.existsSync(path.join(
               'skills', 'commerce', 'references', 'create-order.md')))
        .toBe(true);
    expect(fs.existsSync(stale)).toBe(false);
    expect(logs.join('\n')).toContain('Removed');
  });

  test('a file the generator did not put there is left alone', async () => {
    // Only reference pages are pruned. Anything else under the skill -- a
    // script, a note, a file a later version of this command writes -- is not
    // this command's to delete.
    writeModel('commerce.yaml', modelText('commerce', 'PlaceOrder'));
    expect(await skillsGenerate({out: 'skills'})).toBe(0);
    const note = path.join('skills', 'commerce', 'NOTES.md');
    fs.writeFileSync(note, 'kept');
    expect(await skillsGenerate({out: 'skills', force: true})).toBe(0);
    expect(fs.readFileSync(note, 'utf-8')).toBe('kept');
  });
});


describe('kcmd skills-generate: two models, one name', () => {
  test('a collision is refused rather than silently resolved', async () => {
    // A skill name is a lossy form of a model name. Writing both would leave
    // the second on disk and the first gone, with two "Wrote ..." lines and an
    // exit code of 0 saying otherwise.
    writeModel('a.yaml', modelText('sales-orders', 'PlaceOrder'));
    writeModel('b.yaml', modelText('sales_orders', 'CancelOrder'));
    const code = await skillsGenerate({out: 'skills'});
    expect(code).toBe(1);
    expect(logs.join('\n')).toContain('both name');
    // And neither is on disk. The collision is a fault in the scope, not in
    // one model: whichever happened to be generated first would otherwise be
    // left behind as the answer to a question the command refused to answer.
    expect(fs.existsSync(path.join('skills', 'sales-orders'))).toBe(false);
  });
});


// The runtime's store is the one the deployments for the selected profile
// name: those that name it in `profile`, or that name none for `default`.
describe('createSemanticRuntimes: the store a profile uses', () => {
  const SPANNER_DB = `${SPANNER}/databases/commerce`;
  const BQ =
      '//bigquery.googleapis.com/projects/acme-analytics/datasets/sales';
  const CLUSTER =
      '//alloydb.googleapis.com/projects/acme-ops/locations/us-central1/clusters/main';

  beforeEach(() => {
    // Nothing here may reach the network; the AlloyDB listing is mocked.
    spyOn(globalThis, 'fetch').mockImplementation((() => {
      throw new Error('unexpected network call');
    }) as any);
  });

  function logical(deployments: string, source: string): string {
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
`;
  }

  async function runtimeFor(profile?: string) {
    const runtimes = await createSemanticRuntimes(
        {ctx: CTX, ...(profile ? {profile} : {}), onWarning: () => {}});
    if ('error' in runtimes) throw new Error(runtimes.error);
    expect(runtimes).toHaveLength(1);
    return runtimes[0];
  }

  test('each sibling profile file takes the deployment that names it', async () => {
    writeModel(
        'commerce.yaml',
        logical(
            `      - name: bq_prod\n` +
                `        target: ${BQ}/propertyGraphs/commerce\n` +
                `        profile: analytical\n` +
                `      - name: spanner_prod\n` +
                `        target: ${SPANNER_DB}/propertyGraphs/commerce\n` +
                `        profile: operational\n`,
            `${SPANNER_DB}/tables/Orders`));
    writeModel(
        'commerce.profile.analytical.yaml',
        `name: analytical\nentities:\n  - name: Order\n    source: ${
            BQ}/tables/orders\n`);
    writeModel(
        'commerce.profile.operational.yaml',
        `name: operational\nentities:\n  - name: Order\n    source: ${
            SPANNER_DB}/tables/Orders\n`);

    const analytical = await runtimeFor('analytical');
    expect(analytical.store && storeLine(analytical.store))
        .toBe('bigquery:acme-analytics/sales');
    const operational = await runtimeFor('operational');
    expect(operational.store && storeLine(operational.store))
        .toBe('acme-ops/prod/commerce');
    // Neither deployment is for the model file's own bindings.
    const byDefault = await runtimeFor();
    expect(byDefault.store).toBeUndefined();
    expect(byDefault.storeError)
        .toContain("declares no deployment without a 'profile'");
  });

  // A legacy wrapper that names no `deployment_target` keeps the model file's
  // `deployments:` list. It takes the deployment that names it, and otherwise
  // the ones that name no profile, which is where push deploys it.
  test('a legacy wrapper with no target takes the deployments push uses',
       async () => {
         const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
         fs.mkdirSync(path.join(eg, 'commerce.profiles'), {recursive: true});
         // A deployment may name only a profile the model declares.
         for (const name of ['prod', 'analytical', 'operational']) {
           fs.writeFileSync(
               path.join(eg, 'commerce.profiles', `${name}.yaml`),
               `semantic_model:
  - name: commerce
    entities:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
`);
         }
         const withSpanner = (profileLine: string) => logical(
             `      - name: bq_prod\n` +
                 `        target: ${BQ}/propertyGraphs/commerce\n` +
                 `        profile: analytical\n` +
                 `      - name: spanner_prod\n` +
                 `        target: ${SPANNER_DB}/propertyGraphs/commerce\n` +
                 profileLine,
             `${SPANNER_DB}/tables/Orders`);

         writeModel('commerce.yaml', withSpanner(''));
         const unnamed = await runtimeFor('prod');
         expect(unnamed.store && storeLine(unnamed.store))
             .toBe('acme-ops/prod/commerce');

         writeModel('commerce.yaml', withSpanner('        profile: prod\n'));
         const named = await runtimeFor('prod');
         expect(named.store && storeLine(named.store))
             .toBe('acme-ops/prod/commerce');

         writeModel(
             'commerce.yaml', withSpanner('        profile: operational\n'));
         const none = await runtimeFor('prod');
         expect(none.store).toBeUndefined();
         expect(none.storeError)
             .toBe(
                 "legacy binding profile 'prod' names no 'deployment_target', " +
                 "and every deployment in 'deployments' names another profile, " +
                 'so there is no database to run it against');
       });

  test('default with one deployment takes it', async () => {
    writeModel(
        'commerce.yaml',
        logical(
            `      - name: prod\n` +
                `        target: ${SPANNER_DB}/propertyGraphs/commerce\n`,
            `${SPANNER_DB}/tables/Orders`));
    const runtime = await runtimeFor();
    expect(runtime.store && storeLine(runtime.store))
        .toBe('acme-ops/prod/commerce');
  });

  test('default with several takes the single operational store', async () => {
    writeModel(
        'commerce.yaml',
        logical(
            `      - name: bq_prod\n` +
                `        target: ${BQ}/propertyGraphs/commerce\n` +
                `      - name: spanner_prod\n` +
                `        target: ${SPANNER_DB}/propertyGraphs/commerce\n`,
            `${SPANNER_DB}/tables/Orders`));
    const runtime = await runtimeFor();
    expect(runtime.store && storeLine(runtime.store))
        .toBe('acme-ops/prod/commerce');
  });

  test('several with no single operational store fail, naming them', async () => {
    writeModel(
        'commerce.yaml',
        logical(
            `      - name: spanner_a\n` +
                `        target: ${SPANNER_DB}/propertyGraphs/commerce\n` +
                `      - name: alloy_b\n` +
                `        target: ${CLUSTER}/databases/commerce\n`,
            `${SPANNER_DB}/tables/Orders`));
    const runtime = await runtimeFor();
    expect(runtime.store).toBeUndefined();
    expect(runtime.storeError)
        .toContain(
            'deployment targets on two operational backends (1 Spanner and ' +
            "1 AlloyDB) in 'deployments' for profile 'default' (spanner_a, " +
            'alloy_b)');
  });

  test('an AlloyDB cluster connects through its primary instance', async () => {
    const list = spyOn(AlloyDbClient.prototype, 'listInstances')
                     .mockResolvedValue({
                       status: 200,
                       result: [{
                         name: 'projects/acme-ops/locations/us-central1/' +
                             'clusters/main/instances/main-primary',
                         instanceType: 'PRIMARY',
                         state: 'READY',
                       }],
                     });
    writeModel(
        'commerce.yaml',
        logical(
            `      - name: alloy_prod\n` +
                `        target: ${CLUSTER}/databases/commerce\n`,
            `${CLUSTER}/databases/commerce/schemas/public/tables/orders`));
    const runtime = await runtimeFor();
    expect(runtime.store && storeLine(runtime.store))
        .toBe('alloydb:acme-ops/us-central1/main/main-primary/commerce');
    expect(list).toHaveBeenCalledWith('acme-ops', 'us-central1', 'main');
  });

  test('an AlloyDB cluster with no primary instance has no store', async () => {
    spyOn(AlloyDbClient.prototype, 'listInstances')
        .mockResolvedValue({status: 200, result: []});
    writeModel(
        'commerce.yaml',
        logical(
            `      - name: alloy_prod\n` +
                `        target: ${CLUSTER}/databases/commerce\n`,
            `${CLUSTER}/databases/commerce/schemas/public/tables/orders`));
    const runtime = await runtimeFor();
    expect(runtime.store).toBeUndefined();
    expect(runtime.storeError)
        .toContain(
            "AlloyDB cluster 'projects/acme-ops/locations/us-central1/" +
            "clusters/main' has no primary instance");
  });

  // A store the model names but cannot reach is a fault to fix, so no skill
  // is written that says the model has none.
  test('skills-generate fails when the AlloyDB lookup fails', async () => {
    spyOn(AlloyDbClient.prototype, 'listInstances')
        .mockRejectedValue(new Error('fetch failed'));
    writeModel(
        'commerce.yaml',
        modelText('commerce', 'IssueCredit')
            .replace(
                `${SPANNER}/databases/commerce/propertyGraphs/commerce`,
                `${CLUSTER}/databases/commerce`)
            .replace(
                `${SPANNER}/databases/commerce/tables/Orders`,
                `${CLUSTER}/databases/commerce/schemas/public/tables/orders`));
    expect(await skillsGenerate({out: 'skills'})).toBe(1);
    expect(logs.join('\n'))
        .toContain(
            "Error: [commerce] Could not list the instances of AlloyDB " +
            "cluster 'projects/acme-ops/locations/us-central1/clusters/main': " +
            'fetch failed');
    expect(fs.existsSync(path.join('skills', 'commerce'))).toBe(false);
  });

  // The model names a store that cannot be resolved, so no skill is written
  // that says it has none.
  test('skills-generate fails when the deployments give no single store',
       async () => {
         const spannerGraph =
             `${SPANNER}/databases/commerce/propertyGraphs/commerce`;
         for (const [second, error] of [
                [
                  'bigquery:graph:acme-analytics.sales.commerce',
                  "deployment 'second' targets " +
                      "'bigquery:graph:acme-analytics.sales.commerce', which " +
                      'is a Knowledge Catalog name',
                ],
                [
                  `${CLUSTER}/databases/commerce`,
                  'deployment targets on two operational backends',
                ],
              ]) {
           logs = [];
           writeModel(
               'commerce.yaml',
               modelText('commerce', 'IssueCredit')
                   .replace(
                       `        target: ${spannerGraph}\n`,
                       `        target: ${spannerGraph}\n` +
                           `      - name: second\n` +
                           `        target: ${second}\n`));
           expect(await skillsGenerate({out: 'skills'})).toBe(1);
           expect(logs.join('\n')).toContain(error);
           expect(fs.existsSync(path.join('skills', 'commerce'))).toBe(false);
         }
       });

  // A vanilla model lists its targets in a GOOGLE block. Push rejects a target
  // in no accepted form and a block that is not JSON, so no skill is written
  // that says the model has no store.
  test('skills-generate fails when a GOOGLE block lists a target in no accepted form or is not JSON',
       async () => {
         const typo = `${SPANNER}/database/commerce/propertyGraphs/commerce`;
         const vanilla = (data: string) => `version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    custom_extensions:
      - vendor_name: GOOGLE
        data: '${data}'
    datasets:
      - name: Order
        source: ${SPANNER_DB}/tables/Orders
        primary_key: [key]
        fields:
          - name: key
            expression: {dialects: [{dialect: ANSI_SQL, expression: OrderId}]}
`;
         const listed = (uris: string[]) =>
             JSON.stringify({deploymentTargets: uris});
         const notAccepted = `Error: Model 'commerce': the GOOGLE ` +
             `custom_extension's 'deploymentTargets' lists '${typo}', which ` +
             'is not a BigQuery graph, a Spanner graph or an AlloyDB database';
         for (const [data, error] of [
                [listed([typo]), notAccepted],
                [
                  listed([`${SPANNER_DB}/propertyGraphs/commerce`, typo]),
                  notAccepted,
                ],
                [
                  '{not-json',
                  "Error: Model document 'commerce': Semantic model load " +
                      "error: model 'commerce': the " +
                      "'data' of a GOOGLE custom_extensions block must be a " +
                      'JSON object.',
                ],
              ]) {
           logs = [];
           writeModel('commerce.yaml', vanilla(data));
           expect(await skillsGenerate({out: 'skills'})).toBe(1);
           expect(logs.join('\n')).toContain(error);
           expect(fs.existsSync(path.join('skills', 'commerce'))).toBe(false);
         }
       });

  // A BigQuery graph may read tables in another dataset, and push accepts
  // that. The skill is written, and its store line says there is none.
  test('a BigQuery graph over tables in another dataset still gets its skill',
       async () => {
         writeModel(
             'commerce.yaml',
             modelText('commerce', 'IssueCredit')
                 .replace(
                     `${SPANNER}/databases/commerce/propertyGraphs/commerce`,
                     `${BQ}/propertyGraphs/commerce`)
                 .replace(
                     `${SPANNER}/databases/commerce/tables/Orders`,
                     '//bigquery.googleapis.com/projects/acme-analytics/' +
                         'datasets/raw/tables/orders'));
         expect(await skillsGenerate({out: 'skills'})).toBe(0);
         const skill = fs.readFileSync(
             path.join('skills', 'commerce', 'SKILL.md'), 'utf8');
         expect(skill).toContain(
             "- Store: none. Model 'commerce' binds 'Order' to " +
             'acme-analytics.raw.orders');
       });

  test('a skill generated from a profile file names that profile\'s store',
       async () => {
         writeModel(
             'commerce.yaml',
             modelText('commerce', 'IssueCredit')
                 .replace(/        executor:\n(.*\n){3}/, '')
                 .replace(
                     '      - name: prod\n',
                     '      - name: prod\n        profile: prod\n'));
         writeModel('commerce.profile.prod.yaml', `name: prod
entities:
  - name: Order
    source: ${SPANNER_DB}/tables/Orders
actions:
  - name: IssueCredit
    executor:
      sql:
        statements:
          - UPDATE Orders SET Total = 0 WHERE OrderId = @order
`);
         expect(await skillsGenerate({out: 'skills', profile: 'prod'})).toBe(0);
         const skill = fs.readFileSync(
             path.join('skills', 'commerce', 'SKILL.md'), 'utf8');
         expect(skill).toContain('- Store: `acme-ops/prod/commerce`');
       });
});


describe('createSemanticRuntimes: a column binding is read in the store\'s SQL', () => {
  const CLUSTER =
      '//alloydb.googleapis.com/projects/acme-ops/locations/us-central1/clusters/main';
  const SPANNER_DB = `${SPANNER}/databases/commerce`;

  beforeEach(() => {
    spyOn(globalThis, 'fetch').mockImplementation((() => {
      throw new Error('unexpected network call');
    }) as any);
    spyOn(AlloyDbClient.prototype, 'listInstances').mockResolvedValue({
      status: 200,
      result: [{
        name: 'projects/acme-ops/locations/us-central1/clusters/main/' +
            'instances/main-primary',
        instanceType: 'PRIMARY',
        state: 'READY',
      }],
    });
  });

  // A supertype, and a subtype that inherits its field `flags`.
  function hierarchy(target: string, table: (name: string) => string,
                     flags: string): string {
    return `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: prod
        target: ${target}
    entities:
      - name: person
        source: ${table('person')}
        primary_key: [id]
        fields:
          - { name: id, expression: id }
          - { name: flags, expression: ${JSON.stringify(flags)} }
      - name: customer
        extends: [person]
        source: ${table('customer')}
        primary_key: [id]
`;
  }

  async function columns() {
    const runtimes = await createSemanticRuntimes({ctx: CTX, onWarning: () => {}});
    if ('error' in runtimes) throw new Error(runtimes.error);
    const [runtime] = runtimes;
    return Object.fromEntries(
        readableEntities(runtime, dialectFor(runtime.store))
            .map(r => [r.entity.name, r.fields.map(f => f.column)]));
  }

  test('PostgreSQL reads `#` as an operator, on every entity that has the field', async () => {
    const alloyDb = (flags: string) => hierarchy(
        `${CLUSTER}/databases/commerce`,
        name => `${CLUSTER}/databases/commerce/schemas/public/tables/${name}`,
        flags);
    writeModel('commerce.yaml', alloyDb('flags # mask'));
    expect(await columns()).toEqual({person: ['id'], customer: ['id']});
    writeModel('commerce.yaml', alloyDb('flags -- a note'));
    expect(await columns())
        .toEqual({person: ['id', 'flags'], customer: ['id', 'flags']});
  });

  test('an AlloyDB store reads the text that database runs', async () => {
    // The BIGQUERY entry is the text the BigQuery graph writes. An AlloyDB
    // database runs the ALLOYDB entry, or else the ANSI_SQL one. A field with
    // neither, such as one with only a POSTGRES entry, keeps its binding.
    const model = (amount: string) => hierarchy(
        `${CLUSTER}/databases/commerce`,
        name => `${CLUSTER}/databases/commerce/schemas/public/tables/${name}`,
        'flags').replace(
        '          - { name: flags, expression: "flags" }\n',
        `          - name: amount\n            expression:\n              dialects: ${amount}\n`);
    writeModel('commerce.yaml', model(
        '[{dialect: BIGQUERY, expression: "amount_usd -- in dollars"}, ' +
        '{dialect: ALLOYDB, expression: amount_cents}]'));
    expect(await columns())
        .toEqual({person: ['id', 'amount_cents'], customer: ['id', 'amount_cents']});
    writeModel('commerce.yaml', model(
        '[{dialect: BIGQUERY, expression: amount_usd}, ' +
        '{dialect: ANSI_SQL, expression: amount_cents}]'));
    expect(await columns())
        .toEqual({person: ['id', 'amount_cents'], customer: ['id', 'amount_cents']});
    writeModel('commerce.yaml', model(
        '[{dialect: POSTGRES, expression: "amount -- in cents"}]'));
    expect(await columns())
        .toEqual({person: ['id', 'amount'], customer: ['id', 'amount']});
  });

  test('GoogleSQL reads `#` as a comment', async () => {
    writeModel('commerce.yaml', hierarchy(
        `${SPANNER_DB}/propertyGraphs/commerce`,
        name => `${SPANNER_DB}/tables/${name}`, 'flags # a note'));
    expect(await columns())
        .toEqual({person: ['id', 'flags'], customer: ['id', 'flags']});
  });
});
