// Edge cases for resolveStore and withPrimaryInstance: deployments that name
// profiles, targets push reads differently from a plain URI, and AlloyDB
// listings that page oddly. The AlloyDB listing is mocked.

import {describe, expect, spyOn, test} from 'bun:test';

import {AlloyDbClient} from '../../../../src/libts/gcp/alloydb';
import {ApiContext} from '../../../../src/libts/gcp/context';
import {resolveModelDeployments} from '../../../../src/libts/semantic/deployment_target';
import {SemanticModel} from '../../../../src/libts/semantic/ir';
import {loadModels} from '../../../../src/libts/semantic/loader';
import {undeclaredProfileError} from '../../../../src/libts/semantic/runtime/runtime';
import {AlloyDbDatabase, resolveStore, withPrimaryInstance} from '../../../../src/libts/semantic/runtime/store';

const DB = 'spanner.googleapis.com/projects/p/instances/i/databases/d';
const SPANNER_GRAPH = `${DB}/graphs/g`;
const CLUSTER =
    'alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c';

function model(body: string): SemanticModel {
  return loadModels(
             `version: "0.2.0.dev0/google"\nsemantic_model:\n  - name: m\n${
                 body}`,
             {bindingOptional: true, allowLegacyBareSource: true})
      .models[0];
}

function deployed(entries: string, source = `${DB}/tables/Customer`):
    SemanticModel {
  return model(
      `    deployments:\n${entries}` +
      `    entities:\n` +
      `      - name: Customer\n` +
      `        primary_key: [id]\n` +
      `        source: ${source}\n` +
      `        fields:\n` +
      `          - {name: id, datatype: Integer, expression: id}\n`);
}

function vanilla(data: string): SemanticModel {
  return {
    ...deployed(`      - {name: x, target: "${SPANNER_GRAPH}"}\n`),
    version: '0.2.0.dev0',
    deployments: undefined,
    customExtensions: [{vendorName: 'GOOGLE', data}],
  };
}


describe('deployments and the profiles they name', () => {
  // `profile: default` names the model file's own bindings, so resolveStore
  // uses it for `default`, and so does a legacy wrapper that falls back to
  // those bindings.
  test('a deployment naming default is the model file\'s for a legacy wrapper too',
       () => {
         const m = deployed(
             `      - {name: prod, target: "${SPANNER_GRAPH}", profile: default}\n`);
         const byDefault = resolveStore(m, 'default');
         expect('error' in byDefault).toBe(false);
         const wrapped = resolveStore(m, 'staging', {legacyWrapper: true});
         expect(wrapped).toEqual(byDefault);
       });

  // A deployment whose profile no profile file declares would be used by no
  // profile. Push refuses the deployment, and so does the runtime.
  test('a deployment naming an undeclared profile is refused', () => {
    const m = deployed(
        `      - {name: prod, target: "${SPANNER_GRAPH}", profile: prdo}\n`);
    expect(undeclaredProfileError('m.yaml', m, ['prod']))
        .toBe(
            "[m.yaml] model 'm': deployment 'prod' names unknown binding " +
            "profile 'prdo'; defined profiles: prod.");
    expect(undeclaredProfileError('m.yaml', m, ['prdo'])).toBeUndefined();
  });

  // The legacy wrapper fallback uses the deployments for `default`, and the
  // ambiguity message says they are default's.
  test('the ambiguity message under a legacy wrapper names whose deployments they are',
       () => {
         const m = deployed(
             `      - {name: a, target: "${SPANNER_GRAPH}"}\n` +
             `      - {name: b, target: "${DB}2/graphs/g"}\n`);
         const store = resolveStore(m, 'staging', {legacyWrapper: true});
         expect('error' in store && store.error)
             .not.toContain("for profile 'staging' (a, b)");
         expect('error' in store && store.error)
             .toContain("in 'deployments' for profile 'default' (a, b)");
       });
});


describe('targets', () => {
  // A non-string entry is a target in no accepted form, to push and to the
  // runtime.
  test('a non-string GOOGLE block target fails the store', () => {
    const store = resolveStore(vanilla(JSON.stringify({deploymentTargets: [42]})));
    expect(store).toEqual({
      error: expect.stringContaining('deploymentTargets'),
      named: true,
      rejected: true,
    });
  });

  // Push checks the target of every deployment a model declares, so a target
  // in no accepted form fails the store under every profile.
  test('a target in no accepted form for another profile fails the store',
       () => {
         const typo = `${DB}/propertyGraph/typo`;
         const m = deployed(
             `      - {name: dev, target: "${SPANNER_GRAPH}"}\n` +
             `      - {name: prod, target: "${typo}", profile: prod}\n`);
         expect(resolveStore(m, 'default')).toEqual({
           error: expect.stringContaining(`deployment 'prod' targets '${typo}'`),
           named: true,
           rejected: true,
         });
       });

  // So does a GOOGLE block that is not valid JSON, under a profile no
  // deployment uses.
  test('a GOOGLE block that is not valid JSON fails the store under every profile',
       () => {
         expect(resolveStore(vanilla('{not-json'), 'prod')).toEqual({
           error: "Model 'm': GOOGLE custom_extension 'data' is not valid JSON.",
           named: true,
           rejected: true,
         });
       });

  // Every push refuses a target listed twice. So does the runtime under every
  // profile, even beside a Spanner target that alone would give the store.
  test('a target a GOOGLE block lists twice fails the store under every profile',
       () => {
         const graph =
             'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';
         const m = vanilla(
             JSON.stringify({deploymentTargets: [SPANNER_GRAPH, graph, graph]}));
         for (const profile of ['default', 'prod']) {
           expect(resolveStore(m, profile)).toEqual({
             error: `Model 'm' declares duplicate deployment target '${
                        graph}' in its GOOGLE block's 'deploymentTargets'; ` +
                 `each deployment must target a distinct resource.`,
             named: true,
             rejected: true,
           });
         }
       });

  // The instance-based AlloyDB URI in a `deployments:` list.
  // resolveModelDeployments rejects it, and resolveStore reads it until the
  // legacy forms go.
  test('an instance-based AlloyDB URI in a list: resolveStore reads it, resolveModelDeployments rejects it',
       () => {
         const m = deployed(
             `      - {name: old, target: "${CLUSTER}/instances/i/databases/d"}\n`,
             `${CLUSTER}/databases/d/schemas/public/tables/customer`);
         const store = resolveStore(m);
         expect('error' in store).toBe(false);
         expect('error' in resolveModelDeployments(m)).toBe(true);
       });

  // A programmatic empty list hides the GOOGLE block, the same way push
  // reads it, so both see no target.
  test('an empty deployments list beside a GOOGLE block reads no target', () => {
    const m: SemanticModel = {
      ...vanilla(JSON.stringify({deploymentTargets: [SPANNER_GRAPH]})),
      deployments: [],
    };
    const store = resolveStore(m);
    expect('error' in store && store.error).toContain('declares no deployment target');
  });
});


describe('the AlloyDB instance listing', () => {
  const CTX = new ApiContext('test-project', 'us', 'test-token');
  const store: AlloyDbDatabase = {
    kind: 'alloydb',
    name: 'projects/p/locations/us-central1/clusters/c/databases/d',
    project: 'p',
    location: 'us-central1',
    cluster: 'c',
    database: 'd',
  };

  test('page tokens that cycle through two values stop', async () => {
    const client = new AlloyDbClient(CTX);
    let calls = 0;
    spyOn(client as any, '_get').mockImplementation(async () => {
      calls++;
      return {
        status: 200,
        result: {instances: [], ...(calls < 10 ? {nextPageToken: calls % 2 ? 'A' : 'B'} : {})},
      };
    });
    const found = await withPrimaryInstance(store, client);
    expect('error' in found && found.error).toContain("page token 'A' twice");
    expect(calls).toBe(3);
  });

  test('a primary with no name is reported as missing', async () => {
    const client = new AlloyDbClient(CTX);
    spyOn(client, 'listInstances').mockResolvedValue({
      status: 200,
      result: [{instanceType: 'PRIMARY', state: 'READY'}],
    });
    const found = await withPrimaryInstance(store, client);
    expect('error' in found && found.error).toContain('has no primary instance');
  });

  test('a listing page that is not a list fails, naming the cluster', async () => {
    const client = new AlloyDbClient(CTX);
    spyOn(client as any, '_get').mockResolvedValue({
      status: 200,
      result: {instances: {name: 'x'}},
    });
    const found = await withPrimaryInstance(store, client);
    expect('error' in found && found.error)
        .toContain("Could not list the instances of AlloyDB cluster 'projects/p/locations/us-central1/clusters/c'");
  });

  test('a token that cannot be read fails, naming the cluster', async () => {
    const ctx = new ApiContext('test-project', 'us', 'test-token');
    Object.defineProperty(ctx, 'token', {
      get() {
        throw new Error('gcloud is not installed');
      },
    });
    const found = await withPrimaryInstance(store, new AlloyDbClient(ctx));
    expect('error' in found && found.error)
        .toContain('gcloud is not installed');
  });
});
