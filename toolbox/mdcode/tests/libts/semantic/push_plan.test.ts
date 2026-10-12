// Tests the semantic-model push/pull/profiles planning and CLI guards
// (src/tool/commands.ts): which flag combinations are coherent
// (checkPushSelection), how a model document's deployment target is detected
// (declaresGraphTarget), when a push warns that it publishes to Knowledge
// Catalog only (catalogOnlyWarning), how a graph push treats a profile file,
// how deployment-level `profile:` guards behave across `kcmd push`, `kcmd
// profiles`, and `createSemanticRuntimes`, and how `kcmd pull` reconstructs
// loadable `.yaml` files from Knowledge Catalog resources.
//
// The deploy legs themselves are covered end to end elsewhere
// (deploy_bigquery.test.ts, deploy_spanner.test.ts,
// deploy_knowledge_catalog.test.ts).

import {afterEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiContext} from '../../../src/libts/gcp/context';
import * as bqDeploy from '../../../src/libts/semantic/deploy_bigquery';
import * as kcDeploy from '../../../src/libts/semantic/deploy_knowledge_catalog';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {loadModels} from '../../../src/libts/semantic/loader';
import {serializeModel} from '../../../src/libts/semantic/osi_converter';
import * as pullKc from '../../../src/libts/semantic/pull_kc';
import {createSemanticRuntimes} from '../../../src/libts/semantic/runtime/runtime';
import {catalogOnlyWarning, checkPushSelection, declaresGraphTarget, isProfileFileForm, profileFileGraphError, profiles, pull, push} from '../../../src/tool/commands';

describe('checkPushSelection', () => {
  // Both legs on, no binding-profile selection: the default `kcmd push`. Each
  // test overrides the field it exercises.
  const base = {
    graphEnabled: true,
    kcEnabled: true,
    allProfiles: false,
    namedProfile: false,
  };

  test('the default push (both legs, default profile) is coherent', () => {
    expect(checkPushSelection(base)).toBeNull();
  });

  test('--no-kc (graph only) is coherent', () => {
    expect(checkPushSelection({...base, kcEnabled: false})).toBeNull();
  });

  test('--no-profile (catalog only) is coherent', () => {
    expect(checkPushSelection({...base, graphEnabled: false})).toBeNull();
  });

  test('--profile selects one binding profile', () => {
    expect(checkPushSelection({...base, namedProfile: true})).toBeNull();
  });

  test('--all-profiles fans out over every binding profile', () => {
    expect(checkPushSelection({...base, allProfiles: true})).toBeNull();
  });

  test('--no-profile --no-kc is an error: nothing to deploy', () => {
    const r = checkPushSelection({...base, graphEnabled: false, kcEnabled: false});
    expect(r).not.toBeNull();
    expect(r!.error).toContain('nothing to deploy');
  });

  test('--no-profile --profile is an error: no graph to bind', () => {
    const r =
        checkPushSelection({...base, graphEnabled: false, namedProfile: true});
    expect(r).not.toBeNull();
    expect(r!.error).toContain('no graph to bind');
  });

  test('--no-profile --all-profiles is an error: no graph to bind', () => {
    const r =
        checkPushSelection({...base, graphEnabled: false, allProfiles: true});
    expect(r).not.toBeNull();
    expect(r!.error).toContain('no graph to bind');
  });

  test('--profile --all-profiles is an error: one profile or every profile', () => {
    const r =
        checkPushSelection({...base, namedProfile: true, allProfiles: true});
    expect(r).not.toBeNull();
    expect(r!.error).toContain('use one or the other');
  });
});



describe('declaresGraphTarget', () => {
  const withSugar = `
version: 0.2.0.dev0/google
semantic_model:
  - name: sales
    deployment_target: //bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g
`;
  const withDeployments = `
version: 0.2.0.dev0/google
semantic_model:
  - name: sales
    deployments:
      - name: prod
        target: //bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g
`;
  const withExtension = `
version: 0.2.0.dev0
semantic_model:
  - name: sales
    custom_extensions:
      - vendor_name: GOOGLE
        data: '{"deploymentTargets":["//spanner.googleapis.com/projects/p/instances/i/databases/db/propertyGraphs/g"]}'
`;
  const logicalOnly = `
version: 0.2.0.dev0
semantic_model:
  - name: sales
    datasets:
      - name: orders
`;

  test('detects the deployment_target sugar', () => {
    expect(declaresGraphTarget(withSugar)).toBe(true);
  });

  test('detects a file whose only target is in deployments:', () => {
    expect(declaresGraphTarget(withDeployments)).toBe(true);
  });

  test('detects a GOOGLE custom_extension deploymentTargets list', () => {
    expect(declaresGraphTarget(withExtension)).toBe(true);
  });

  test('a purely logical model declares no graph target', () => {
    expect(declaresGraphTarget(logicalOnly)).toBe(false);
  });

  test('an empty deployment_target string is not a target', () => {
    expect(declaresGraphTarget(`
version: 0.2.0.dev0/google
semantic_model:
  - name: sales
    deployment_target: '   '
`)).toBe(false);
  });

  test('an empty deployments list is not a target', () => {
    expect(declaresGraphTarget(`
version: 0.2.0.dev0/google
semantic_model:
  - name: sales
    deployments: []
`)).toBe(false);
  });

  test('a GOOGLE block whose targets are all blank or not strings is not a target', () => {
    for (const list of ['["  "]', '[""]', '[7]']) {
      expect(declaresGraphTarget(`
version: 0.2.0.dev0
semantic_model:
  - name: sales
    custom_extensions:
      - vendor_name: GOOGLE
        data: '{"deploymentTargets":${list}}'
`)).toBe(false);
    }
  });

  test('a non-GOOGLE extension is ignored', () => {
    expect(declaresGraphTarget(`
version: 0.2.0.dev0
semantic_model:
  - name: sales
    custom_extensions:
      - vendor_name: ACME
        data: '{"deploymentTargets":["//x"]}'
`)).toBe(false);
  });

  test('unparseable YAML resolves to true so the strict load reports it', () => {
    expect(declaresGraphTarget(': : not valid : yaml :')).toBe(true);
  });

  test('malformed GOOGLE data resolves to true so the strict load reports it',
       () => {
         expect(declaresGraphTarget(`
version: 0.2.0.dev0
semantic_model:
  - name: sales
    custom_extensions:
      - vendor_name: GOOGLE
        data: 'not json'
`)).toBe(true);
       });
});


// --no-kc drops the only leg an action or a constraint deploys through. The
// warning counted actions alone, so a model whose catalog-only content was all
// constraints was dropped without a word.
describe('catalogOnlyWarning', () => {
  test('names constraints when the model declares only constraints', () => {
    const msg = catalogOnlyWarning('sales', {actions: 0, constraints: 2});
    expect(msg).toContain('2 constraint(s)');
    expect(msg).not.toContain('action(s)');
    expect(msg).toContain('--no-kc');
  });

  test('names actions when the model declares only actions', () => {
    const msg = catalogOnlyWarning('sales', {actions: 1, constraints: 0});
    expect(msg).toContain('1 action(s)');
    expect(msg).not.toContain('constraint(s)');
  });

  test('names both, in one sentence, when the model declares both', () => {
    expect(catalogOnlyWarning('sales', {actions: 1, constraints: 2}))
        .toContain('1 action(s) and 2 constraint(s)');
  });
});


describe('a graph push of a profile file', () => {
  test('the profile file form is told apart from the legacy wrapper', () => {
    expect(isProfileFileForm('name: prod\nentities: []\n')).toBe(true);
    expect(isProfileFileForm('version: x\nsemantic_model: []\n')).toBe(false);
  });

  test('is refused before any deploy, since a profile file names no target', () => {
    expect(profileFileGraphError(
               [{name: 'retail', text: '', applied: {} as any}], 'prod'))
        .toContain("binding profile 'prod' is a profile file, which names no deployment target");
    expect(profileFileGraphError([{name: 'retail', text: ''}], 'prod'))
        .toBeUndefined();
  });
});


describe('push, legacy profiles, and pull fallback (b/567743508)', () => {
  const CTX = new ApiContext('test-project', 'us', 'test-token');
  let dir = '';
  let cwd = '';

  function setupWorkspace(): string {
    cwd = process.cwd();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-push-plan-'));
    process.chdir(dir);
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.sales_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'sales_eg');
    fs.mkdirSync(eg, {recursive: true});
    spyOn(ApiContext, 'default').mockReturnValue(CTX);
    spyOn(console, 'log').mockImplementation(() => {});
    return eg;
  }

  afterEach(() => {
    if (cwd) process.chdir(cwd);
    if (dir) fs.rmSync(dir, {recursive: true, force: true});
    dir = '';
    cwd = '';
    mock.restore();
  });

  // A legacy wrapper is merged into the model file's text and may set its own
  // target, so a deployment-profile error is reported under each wrapper, and
  // under the inline bindings.
  test('kcmd profiles reports a deployment-profile error under each legacy wrapper', async () => {
    const eg = setupWorkspace();
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    fs.writeFileSync(path.join(eg, 'sales.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    deployments:
      - name: g
        target: //bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g
        profile: prod
    datasets:
      - name: orders
        source: bigquery:p.d.orders
        primary_key: [id]
        fields:
          - { name: id, expression: id }
`);
    fs.mkdirSync(path.join(eg, 'sales.profiles'));
    for (const name of ['prod', 'qa']) {
      fs.writeFileSync(
          path.join(eg, 'sales.profiles', `${name}.yaml`),
          `semantic_model:\n  - name: sales\n    datasets:\n      - name: orders\n        source: bigquery:p.d.${name}_orders\n`);
    }

    expect(await profiles()).toBe(1);
    const errors = errSpy.mock.calls.map(c => c.join(' '));
    expect(errors.filter(
               l => l === "      [sales] model 'sales': deployment 'g' names " +
                   "profile 'prod'; remove 'profile' from the deployment " +
                   "entry so it uses the model file's own bindings."))
        .toHaveLength(3);
  });

  test('a model file the loader rejects is reported, not thrown', async () => {
    const eg = setupWorkspace();
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const bqSpy = spyOn(bqDeploy, 'deployBigQuery');
    const kcSpy = spyOn(kcDeploy, 'deployKnowledgeCatalog');
    const model = (name: string, target: string) => `version: "0.2.0.dev0/google"
semantic_model:
  - name: ${name}
    ${target}
    datasets:
      - name: orders
        source: bigquery:p.d.orders
        primary_key: [id]
        fields:
          - { name: id, expression: id }
`;
    const graph = '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';
    fs.writeFileSync(
        path.join(eg, 'a.yaml'), model('a', `deployment_target: ${graph}`));
    fs.writeFileSync(
        path.join(eg, 'b.yaml'),
        model('b', `deployments:\n      - { name: prod, target: "${graph}2" }`));
    // `kcmd profiles` loads a model file only when it has a profile.
    fs.writeFileSync(
        path.join(eg, 'a.profile.x.yaml'),
        'name: x\nentities:\n  - name: orders\n    source: bigquery:p.d.orders2\n');

    expect(await push({})).toBe(1);
    expect(bqSpy).not.toHaveBeenCalled();
    expect(kcSpy).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errors).toContain(
        "Model document 'a': Semantic model load error: model 'a': " +
        "'deployment_target' is no longer supported");

    expect(await createSemanticRuntimes({ctx: CTX})).toEqual({
      error: expect.stringContaining(
          "Model document 'a': Semantic model load error: model 'a': " +
          "'deployment_target' is no longer supported"),
    });

    // `kcmd profiles` reports the bad file and still lists the good one.
    errSpy.mockClear();
    logSpy.mockClear();
    expect(await profiles()).toBe(1);
    expect(errSpy.mock.calls.map(c => c.join(' ')).join('\n'))
        .toContain(
            "'deployment_target' is no longer supported; migrate to the named " +
            "'deployments' list");
    expect(errSpy.mock.calls.map(c => c.join(' ')).join('\n'))
        .toContain(
            "(under profile 'x', the model file must load on its own before " +
            'the profile applies)');
    expect(logSpy.mock.calls.map(c => c.join(' ')).join('\n'))
        .toContain("Model 'b'");
  });

  test('a push with a deployment naming a profile fails before anything is written', async () => {
    const eg = setupWorkspace();
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    const bqSpy = spyOn(bqDeploy, 'deployBigQuery');
    const kcSpy = spyOn(kcDeploy, 'deployKnowledgeCatalog');

    const modelYaml = `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    deployments:
      - name: staging
        target: //bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g
        profile: spanner_binding
    datasets:
      - name: orders
        source: bigquery:p.d.orders
        primary_key: [id]
        fields:
          - { name: id, expression: id }
`;
    fs.writeFileSync(path.join(eg, 'sales.yaml'), modelYaml);
    fs.writeFileSync(
        path.join(eg, 'sales.profile.spanner_binding.yaml'),
        'name: spanner_binding\nentities:\n  - name: orders\n    source: bigquery:p.d.orders\n');
    fs.writeFileSync(
        path.join(eg, 'sales.profile.other.yaml'),
        'name: other\nentities:\n  - name: orders\n    source: bigquery:p.d.orders2\n');

    const code = await push({});
    expect(code).toBe(1);
    expect(bqSpy).not.toHaveBeenCalled();
    expect(kcSpy).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errors).toContain("deployment 'staging' names profile 'spanner_binding'");
    expect(errors).toContain("remove 'profile' from the deployment entry so it uses the model file's own bindings");
    expect(errors).not.toContain('--deployment');

    // The runtime takes the store of the deployment that uses the profile,
    // so the default profile has none.
    const rt = await createSemanticRuntimes({ctx: CTX});
    if ('error' in rt) throw new Error(rt.error);
    expect(rt[0].store).toBeUndefined();
    expect(rt[0].storeError).toContain(
        "declares no deployment without a 'profile' in 'deployments'");

    // The runtime applies the profile file to the model file, and the applied
    // model keeps the model file's deployments, so it has the store.
    const rtProfile =
        await createSemanticRuntimes({ctx: CTX, profile: 'spanner_binding'});
    if ('error' in rtProfile) throw new Error(rtProfile.error);
    expect(rtProfile[0].store?.name).toBe('projects/p/datasets/d');

    // And `kcmd profiles` reports what push reports, and exits non-zero. A
    // push of the inline bindings gives the deployment's error. A push of
    // either profile file refuses it, since the model file names a graph.
    errSpy.mockClear();
    logSpy.mockClear();
    expect(await profiles()).toBe(1);
    const profErrors = errSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(profErrors).toContain(
        "  [sales] model 'sales': deployment 'staging' names profile 'spanner_binding'");
    expect(profErrors.split('names profile').length - 1).toBe(1);
    for (const name of ['other', 'spanner_binding']) {
      expect(profErrors).toContain(
          `[sales] binding profile '${name}' is a profile file, which names ` +
          'no deployment target');
    }
  });

  // The error names the model and the profile on each side.
  test('push --all-profiles refuses two profiles that deploy one graph', async () => {
    const eg = setupWorkspace();
    spyOn(globalThis, 'fetch').mockImplementation((() => {
      throw new Error('unexpected network call');
    }) as any);
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    spyOn(console, 'warn').mockImplementation(() => {});
    const bqSpy = spyOn(bqDeploy, 'deployBigQuery');
    fs.writeFileSync(path.join(eg, 'sales.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    deployments:
      - name: prod
        target: //bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g
    datasets:
      - name: orders
        source: bigquery:p.d.orders
        primary_key: [id]
        fields:
          - { name: id, expression: id }
`);
    fs.mkdirSync(path.join(eg, 'sales.profiles'), {recursive: true});
    fs.writeFileSync(path.join(eg, 'sales.profiles', 'staging.yaml'), `semantic_model:
  - name: sales
    deployment_target: //bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g
    entities:
      - name: orders
        source: bigquery:p.d.orders_staging
`);

    expect(await push({allProfiles: true, kc: false, validateOnly: true}))
        .toBe(1);
    expect(bqSpy).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map(c => c.join(' ')).join('\n'))
        .toContain(
            "model 'sales' under binding profile 'staging' and model 'sales' " +
            "under binding profile 'default' both deploy to the same graph " +
            "'//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g'");
  });

  // Both models are under one profile, so only their names tell them apart.
  test('push refuses two model files that deploy one graph', async () => {
    const eg = setupWorkspace();
    spyOn(globalThis, 'fetch').mockImplementation((() => {
      throw new Error('unexpected network call');
    }) as any);
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    spyOn(console, 'warn').mockImplementation(() => {});
    const bqSpy = spyOn(bqDeploy, 'deployBigQuery');
    const modelFile = (name: string) => `version: "0.2.0.dev0/google"
semantic_model:
  - name: ${name}
    deployments:
      - name: prod
        target: //bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g
    datasets:
      - name: orders
        source: bigquery:p.d.orders
        primary_key: [id]
        fields:
          - { name: id, expression: id }
`;
    fs.writeFileSync(path.join(eg, 'a.yaml'), modelFile('a'));
    fs.writeFileSync(path.join(eg, 'b.yaml'), modelFile('b'));

    expect(await push({kc: false, validateOnly: true})).toBe(1);
    expect(bqSpy).not.toHaveBeenCalled();
    expect(errSpy.mock.calls.map(c => c.join(' ')).join('\n'))
        .toContain(
            "model 'a' under binding profile 'default' and model 'b' under " +
            "binding profile 'default' both deploy to the same graph " +
            "'//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g'");
  });

  test('push refuses a deployment naming a profile when it sits in the second of two model files', async () => {
    const eg = setupWorkspace();
    const errSpy = spyOn(console, 'error').mockImplementation(() => {});
    spyOn(console, 'log').mockImplementation(() => {});
    const bqSpy = spyOn(bqDeploy, 'deployBigQuery');
    const kcSpy = spyOn(kcDeploy, 'deployKnowledgeCatalog');

    fs.writeFileSync(path.join(eg, '01_valid.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: first_model
    deployments:
      - name: prod
        target: //bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g1
    datasets:
      - name: orders
        source: bigquery:p.d.orders
        primary_key: [id]
        fields:
          - { name: id, expression: id }
`);
    fs.writeFileSync(path.join(eg, '02_invalid.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: second_model
    deployments:
      - name: staging
        target: //bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g2
        profile: spanner_binding
    datasets:
      - name: items
        source: bigquery:p.d.items
        primary_key: [id]
        fields:
          - { name: id, expression: id }
`);

    const code = await push({});
    expect(code).toBe(1);
    expect(bqSpy).not.toHaveBeenCalled();
    expect(kcSpy).not.toHaveBeenCalled();
    const errors = errSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(errors).toContain(
        "model 'second_model': deployment 'staging' names profile 'spanner_binding'");
  });

  test('a legacy profile file carrying deployment_target and a bare source still merges and loads', async () => {
    const eg = setupWorkspace();
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});

    fs.mkdirSync(path.join(eg, 'sales.profiles'), {recursive: true});
    fs.writeFileSync(path.join(eg, 'sales.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    datasets:
      - name: orders
        primary_key: [id]
        fields:
          - { name: id }
`);
    fs.writeFileSync(path.join(eg, 'sales.profiles', 'bq.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    deployment_target: //bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g
    datasets:
      - name: orders
        source: p.d.orders
        fields:
          - { name: id, expression: id }
`);

    const code = await profiles({profile: 'bq'});
    expect(code).toBe(0);
    const out = logSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(out).toContain('bq');
    expect(out).toContain('p.d.orders');
  });

  test('pull reconstructs deployments in declaration order, warns that deployment names were not recovered, and round-trips every source form cleanly (one database per model)', async () => {
    const eg = setupWorkspace();
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});

    const spGraph = '//spanner.googleapis.com/projects/p/instances/i/databases/db/propertyGraphs/g1';
    const bqGraph = '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g2';
    const alloyTarget = '//alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c/instances/i/databases/db';

    // Primary model pushed without `emitExpressions` (the default push) and
    // pulled through the CLI: two BigQuery entities in the same dataset (short
    // form and full URI) and two deployments in [Spanner, BigQuery] order.
    const salesYaml = `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    deployments:
      - name: sp_prod
        target: ${spGraph}
      - name: bq_prod
        target: ${bqGraph}
    datasets:
      - name: bq_short
        source: bigquery:p.d.orders
        primary_key: [id]
        fields: [{ name: id, expression: id }]
      - name: bq_uri
        source: //bigquery.googleapis.com/projects/p/datasets/d/tables/items
        primary_key: [id]
        fields: [{ name: id, expression: id }]
`;
    const {models: [sales]} = loadModels(salesYaml);
    const {entries, entryLinks} = generateCatalogResources(
        sales, {project: 'test-project', location: 'us', entryGroup: 'sales_eg'});
    const pulled = modelsFromCatalogResources(entries, entryLinks);

    spyOn(pullKc, 'pullKnowledgeCatalog').mockResolvedValue(pulled);

    const code = await pull();
    expect(code).toBe(0);

    const warnings = warnSpy.mock.calls.map(c => c.join(' ')).join('\n');
    expect(warnings).toContain('deployment names were not recovered');
    expect(warnings).not.toContain('no representation');

    const written = fs.readFileSync(path.join(eg, 'sales.yaml'), 'utf8');
    expect(written).not.toContain('deployment_target');
    expect(written).not.toContain('deploymentTargets');
    expect(written).not.toContain('custom_extensions');

    // The rebuilt file (whose fields came back unbound because the default push
    // omits `emitExpressions`) loads without allowLegacyBareSource and
    // preserves deployment targets in declaration order and both BigQuery
    // source forms.
    const loaded = loadModels(written);
    expect(loaded.models).toHaveLength(1);
    const m = loaded.models[0];
    expect(m.deployments).toEqual([
      {name: 'deployment_1', target: spGraph},
      {name: 'deployment_2', target: bqGraph},
    ]);
    const byName = new Map(m.entities.map(e => [e.name, e]));
    expect(byName.get('bq_short')!.authoredSource).toBe('bigquery:p.d.orders');
    expect(byName.get('bq_short')!.dataSource).toBe('p.d.orders');
    expect(byName.get('bq_short')!.fields[0].expression).toBeUndefined();
    expect(byName.get('bq_uri')!.authoredSource)
        .toBe('//bigquery.googleapis.com/projects/p/datasets/d/tables/items');
    expect(byName.get('bq_uri')!.dataSource).toBe('p.d.items');

    // Each other backend gets its own single-database model and round-trips
    // through generateCatalogResources -> modelsFromCatalogResources ->
    // serializeModel -> loadModels cleanly.
    const otherSystems: Array<{
      name: string;
      target?: string;
      source: string;
      expectedDataSource: string;
    }> = [
      {
        name: 'spanner_sales',
        target: spGraph,
        source: '//spanner.googleapis.com/projects/p/instances/i/databases/db/tables/Orders',
        expectedDataSource: '//spanner.googleapis.com/projects/p/instances/i/databases/db/tables/Orders',
      },
      {
        name: 'biglake_sales',
        target: bqGraph,
        source: '//biglake.googleapis.com/projects/p/catalogs/c/namespaces/n/tables/events',
        expectedDataSource: 'p.c.n.events',
      },
      {
        name: 'alloy_sales',
        target: alloyTarget,
        source: '//alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c/databases/db/schemas/public/tables/users',
        expectedDataSource: '//alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c/databases/db/schemas/public/tables/users',
      },
      {
        name: 'mysql_sales',
        source: 'mysql:inst.shop.payments',
        expectedDataSource: 'mysql:inst.shop.payments',
      },
    ];

    for (const sys of otherSystems) {
      const sysYaml = `version: "0.2.0.dev0/google"
semantic_model:
  - name: ${sys.name}
${sys.target ? `    deployments:\n      - name: prod\n        target: ${sys.target}\n` : ''}    datasets:
      - name: tbl
        source: ${sys.source}
        primary_key: [id]
        fields: [{ name: id, expression: id }]
`;
      const [authoredSys] = loadModels(sysYaml).models;
      const kcRes = generateCatalogResources(
          authoredSys,
          {project: 'test-project', location: 'us', entryGroup: 'sales_eg', emitExpressions: true});
      const [recovered] =
          modelsFromCatalogResources(kcRes.entries, kcRes.entryLinks).models;
      const {yaml: serialized, warnings: serWarnings} = serializeModel(recovered);
      expect(serWarnings).toEqual([]);
      const [reloaded] = loadModels(serialized).models;
      expect(reloaded.deployments).toEqual(
          sys.target ? [{name: 'default', target: sys.target}] : undefined);
      expect(reloaded.entities[0].authoredSource).toBe(sys.source);
      expect(reloaded.entities[0].dataSource).toBe(sys.expectedDataSource);
    }
  });
});


