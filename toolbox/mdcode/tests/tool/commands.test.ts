// Tests for `kcV2Aspects()` and forwarding of `v2Aspects` through `kcmd push`
// and `kcmd pull` (src/tool/commands.ts,
// src/libts/semantic/deploy_knowledge_catalog.ts).

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiContext} from '../../src/libts/gcp/context';
import * as kc from '../../src/libts/semantic/deploy_knowledge_catalog';
import * as kcEmit from '../../src/libts/semantic/knowledge_catalog';
import * as pullKc from '../../src/libts/semantic/pull_kc';
import {kcV2Aspects, pull, push} from '../../src/tool/commands';

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

let dir = '';
let cwd = '';
let savedEnv: string|undefined;

function writeWorkspace(): void {
  fs.writeFileSync(
      path.join(dir, 'catalog.yaml'),
      'scope: semantic-model.test-project.us.commerce_eg\n');
  const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
  fs.mkdirSync(eg, {recursive: true});
  fs.writeFileSync(path.join(eg, 'commerce.yaml'), MODEL_YAML);
}

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-commands-'));
  process.chdir(dir);
  savedEnv = process.env.KC_V2_ASPECTS;
  delete process.env.KC_V2_ASPECTS;
  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  spyOn(console, 'log').mockImplementation(() => {});
  spyOn(console, 'error').mockImplementation(() => {});
  spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.KC_V2_ASPECTS;
  } else {
    process.env.KC_V2_ASPECTS = savedEnv;
  }
  process.chdir(cwd);
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
  mock.restore();
});

describe('kcV2Aspects', () => {
  test('returns true only when KC_V2_ASPECTS is "1"', () => {
    delete process.env.KC_V2_ASPECTS;
    expect(kcV2Aspects()).toBe(false);

    process.env.KC_V2_ASPECTS = '';
    expect(kcV2Aspects()).toBe(false);

    process.env.KC_V2_ASPECTS = '0';
    expect(kcV2Aspects()).toBe(false);

    process.env.KC_V2_ASPECTS = 'true';
    expect(kcV2Aspects()).toBe(false);

    process.env.KC_V2_ASPECTS = '1';
    expect(kcV2Aspects()).toBe(true);
  });
});

describe('v2Aspects forwarding', () => {
  test(
      'push forwards v2Aspects: false when KC_V2_ASPECTS is unset',
      async () => {
        writeWorkspace();
        const deploySpy = spyOn(kc, 'deployKnowledgeCatalog');
        const emitSpy = spyOn(kcEmit, 'generateCatalogResources');

        const code = await push({validateOnly: true});

        expect(code).toBe(0);
        expect(deploySpy).toHaveBeenCalledTimes(1);
        expect(deploySpy.mock.calls[0][2].v2Aspects).toBe(false);
        expect(emitSpy).toHaveBeenCalledTimes(1);
        expect(emitSpy.mock.calls[0][1].v2Aspects).toBe(false);
      });

  test('push forwards v2Aspects: true when KC_V2_ASPECTS is "1"', async () => {
    writeWorkspace();
    process.env.KC_V2_ASPECTS = '1';
    const deploySpy = spyOn(kc, 'deployKnowledgeCatalog');
    const emitSpy = spyOn(kcEmit, 'generateCatalogResources');

    const code = await push({validateOnly: true});

    expect(code).toBe(0);
    expect(deploySpy).toHaveBeenCalledTimes(1);
    expect(deploySpy.mock.calls[0][2].v2Aspects).toBe(true);
    expect(emitSpy).toHaveBeenCalledTimes(1);
    expect(emitSpy.mock.calls[0][1].v2Aspects).toBe(true);
  });

  test(
      'pull forwards v2Aspects: false when KC_V2_ASPECTS is unset',
      async () => {
        writeWorkspace();
        const pullSpy = spyOn(pullKc, 'pullKnowledgeCatalog')
                            .mockResolvedValue({models: [], warnings: []});

        const code = await pull();

        expect(code).toBe(0);
        expect(pullSpy).toHaveBeenCalledTimes(1);
        expect(pullSpy.mock.calls[0][1].v2Aspects).toBe(false);
      });

  test('pull forwards v2Aspects: true when KC_V2_ASPECTS is "1"', async () => {
    writeWorkspace();
    process.env.KC_V2_ASPECTS = '1';
    const pullSpy = spyOn(pullKc, 'pullKnowledgeCatalog')
                        .mockResolvedValue({models: [], warnings: []});

    const code = await pull();

    expect(code).toBe(0);
    expect(pullSpy).toHaveBeenCalledTimes(1);
    expect(pullSpy.mock.calls[0][1].v2Aspects).toBe(true);
  });
});


// A push that deploys a graph prunes unbound fields, which can remove the very
// field an inheritance rule is about. The rules run on the model before
// pruning, so a graph push and a catalog-only push give the same answer.
describe('a push with a sibling profile file', () => {
  test('a graph push of the profile file is refused before anything deploys', async () => {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'),
        'scope: semantic-model.test-project.us.commerce_eg\n');
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployment_target: //bigquery.googleapis.com/projects/test-project/datasets/d/propertyGraphs/g
    entities:
      - name: Customer
        source: //bigquery.googleapis.com/projects/test-project/datasets/d/tables/customer
        primary_key: [key]
        fields:
          - { name: key, expression: c_key }
`);
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'), `name: prod
entities:
  - name: Customer
    source: //bigquery.googleapis.com/projects/test-project/datasets/prod/tables/customer
`);
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    const code = await push({validateOnly: true, kc: false, profile: 'prod'});

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain("binding profile 'prod' is a profile file, which names no deployment target");
  });
});


describe('a graph push checks inheritance before pruning', () => {
  const GRAPH_MODEL = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployment_target: //bigquery.googleapis.com/projects/test-project/datasets/d/propertyGraphs/g
    entities:
      - name: customer
        source: //bigquery.googleapis.com/projects/test-project/datasets/d/tables/customer
        primary_key: [id]
        fields:
          - { name: id, datatype: Integer, expression: id }
          - { name: name, datatype: String, expression: cust_name }
      - name: vip
        extends: [customer]
        source: //bigquery.googleapis.com/projects/test-project/datasets/d/tables/vip
        primary_key: [id]
        fields:
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

    const code = await push({validateOnly: true, kc: false});

    expect(code).toBe(1);
    expect(errorSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain("field 'name' is inherited, so it may only be rebound to a column");
  });
});
