// Tests for `kcmd push --no-deployment`, which publishes the model to
// Knowledge Catalog and deploys nothing, and for the local checks that refuse
// a scope before any network call (src/tool/commands.ts, checkBeforeWrites).

import {expect, mock, spyOn} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as YAML from 'yaml';

import {createSemanticRuntimes} from '../../../src/libts/semantic/runtime/runtime';

import {boundTo, bqGraph, bqTable, Case, CTX, CUSTOMER, err, EXPRESSION_KEY, has, kcResult, msg, PREPARED, pushed, scenarios, Scope, SNOWFLAKE_METRIC, TRANSPILE_WARNING, writeScope} from './harness';

const PROD = boundTo('prod');
const legacy = (model: string, entities?: object[], actions?: object[]) =>
    YAML.stringify({semantic_model: [{name: model, entities, actions}]});
const PLAN = ['-- Knowledge Catalog --', 'PLAN LINE'];

// A catalog preflight that plans one line and gives `result`.
const planned = (result = {}) =>
    ({preflight: {result: kcResult({plan: ['PLAN LINE'], ...result})}});

scenarios('push --no-deployment', [
  {
    name: '--no-deployment passes the catalog a deployment that names a profile file, with that profile attached, and both files as copies',
    deployments: [{name: 'g', profile: 'prod'}],
    profiles: {prod: PROD},
    flags: {validateOnly: true},
    code: 0, log: [msg.VALIDATED],
    called: {preflight: 1, sources: 0, query: 0},
    check: r => {
      expect(r.published.deployments?.map(d => [d.name, d.profile]))
          .toEqual([['g', 'prod']]);
      expect(r.published.profiles?.map(p => p.name)).toEqual(['prod']);
      expect(r.fake.preflight.mock.calls[0][2].sourceFiles.map(
                 (f: any) => f.fileName))
          .toEqual(['commerce.yaml', 'commerce.profile.prod.yaml']);
    },
  },
  {
    name: '--no-deployment publishes to Knowledge Catalog, printing the preflight\'s warnings, and deploys nothing, also when only the deployment\'s profile gives a join its columns',
    deployments: ['g1', 'g2'],
    // cac gives `profile: true` when --profile is absent.
    flags: {profile: true},
    services: {preflight: {prepared: {...PREPARED, warnings: ['w']}}},
    code: 0,
    events: ['preflight', 'apply'],
    called: {bq: 0, spanner: 0, sources: 0},
    warnings: ['Warning: w'],
    then: [{
      deployments: [{name: 'g1', profile: 'prod'}],
      entities: [CUSTOMER, {...CUSTOMER, name: 'Order', source: bqTable('o')}],
      relationships: [{name: 'refers', from: 'Order', to: 'Customer'}],
      profiles: {prod: {
        entities: {
          ...PROD.entities,
          Order: {...CUSTOMER, name: 'Order', source: bqTable('o', 'prod')},
        },
        relationships: [
          {name: 'refers', from_columns: ['key'], to_columns: ['key']},
        ],
      }},
      code: 0,
    }],
  },
  {
    name: '--transpile adds a BIGQUERY dialect entry in the model Knowledge Catalog receives',
    metrics: [SNOWFLAKE_METRIC],
    flags: {validateOnly: true},
    code: 0,
    warnings: [has('needs transpilation')],
    check: r => expect(r.published.metrics![0].dialects).toEqual([
      {dialect: 'SNOWFLAKE', expression: 'SUM(IFF(Customer.key > 0, 1, 0))'},
    ]),
    then: [{
      flags: {validateOnly: true, transpile: true},
      code: 0,
      warnings: [TRANSPILE_WARNING],
      check: r => expect(r.published.metrics![0].dialects).toEqual([
        {dialect: 'SNOWFLAKE', expression: 'SUM(IFF(Customer.key > 0, 1, 0))'},
        {dialect: 'BIGQUERY', expression: 'SUM(IF(Customer.key > 0, 1, 0))'},
      ]),
    }],
  },
  {
    name: '--validate-only --print prints the catalog plan first',
    flags: {validateOnly: true, print: true},
    services: planned(),
    code: 0, log: [...PLAN, msg.VALIDATED], errors: [], called: {apply: 0},
  },
  {
    name: 'a failed catalog preflight under --print still prints the plan and its warnings',
    flags: {print: true},
    services: planned(
        {success: false, details: 'permission denied', warnings: ['w']}),
    code: 1, log: PLAN, called: {apply: 0},
    errors: [
      'Error pushing semantic model to Knowledge Catalog: permission denied',
    ],
    warnings: ['Warning: w'],
  },
], {flags: {deployment: false}});

// The error the runtime gives when it opens scope `s`.
async function runtimeError(s: Scope): Promise<string|undefined> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-runtime-'));
  spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('a test made a network call'));
  try {
    writeScope(dir, s);
    const opened = await createSemanticRuntimes(
        {path: dir, ctx: CTX, onWarning: () => {}});
    return 'error' in opened ? opened.error : undefined;
  } finally {
    mock.restore();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}
// A refusal whose error is also the runtime's when it opens the scope.
const sameAsRuntime = (c: Case): Case => ({
  ...c,
  check: async r =>
      expect(r.errors).toEqual([`Error: ${await runtimeError(c)}`]),
});

scenarios('push --no-deployment refuses a scope before any network call', [
  {
    name: '--no-deployment refuses a target a vanilla GOOGLE block lists twice',
    google: {deploymentTargets: [bqGraph('g'), bqGraph('g')]},
    errors: [has(`declares duplicate deployment target '${bqGraph('g')}'`)],
  },
  {
    name: '--no-deployment refuses a deployment whose target is in no accepted form',
    deployments: [{name: 'g', target: 'bigquery:graph:test-project.d.g'}],
    errors: [has(
        "deployment 'g' targets 'bigquery:graph:test-project.d.g', which is " +
        'a Knowledge Catalog name')],
  },
  sameAsRuntime({
    name: 'the undeclared-profile message lists GOOGLE block profiles in sorted order',
    google: {
      profiles: ['zeta', 'alpha'].map(name => ({
        name,
        entities: [{name: 'Customer', source: bqTable('customer', name)}],
      })),
      deployments: [{name: 'dev', target: bqGraph('g'), profile: 'prdo'}],
    },
    errors: [err(msg.unknownProfile('dev', 'prdo', ['alpha', 'zeta']))],
  }),
  sameAsRuntime({
    name: 'the declared-profile check runs before the named profiles are checked, and every broken profile file is reported',
    deployments: [{name: 'g', profile: 'prd'}],
    profiles: {
      dev: {version: '0.2.0.dev0/google'},
      prod: {entities: {Customer: EXPRESSION_KEY}},
    },
    errors: [err(msg.unknownProfile('g', 'prd', ['dev', 'prod']))],
    then: [{
      deployments: [{name: 'g', profile: 'prod'}],
      errors: [
        err("[commerce.profile.dev.yaml] profile 'dev' sets 'version'; a " +
            'profile file takes its version from the model file beside it, ' +
            'so remove the line'),
        err("[commerce.profile.prod.yaml] profile 'prod': entity " +
            "'Customer' key column 'UPPER(c_key)' is not a physical " +
            'column name'),
      ],
    }],
  }),
  {
    name: '--no-deployment refuses a model file that does not load',
    entities: [{...CUSTOMER, colour: 'red'}],
    errors: [has('Semantic model load error')],
  },
  {
    name: '--no-deployment refuses a legacy profile file named default',
    legacy: {default: legacy('commerce')},
    errors: [err(
        "[commerce] a binding profile may not be named 'default' -- that " +
        "name refers to the model's inline bindings. Rename the profile.")],
  },
  sameAsRuntime({
    name: '--no-deployment refuses a default_profile the model does not declare',
    profiles: {prod: PROD},
    defaultProfile: 'prd',
    errors: [err(
        "unknown binding profile 'prd' for model 'commerce'; defined " +
        'profiles: prod.')],
    then: ['prod', 'default'].map(p => ({defaultProfile: p, code: 0})),
  }),
  sameAsRuntime({
    name: '--no-deployment refuses a default_profile the runtime refuses: the profile file has an action that does not load',
    profiles: {
      prod: {...PROD, actions: [{name: 'refund', executor: {bogus: {}}}]},
    },
    defaultProfile: 'prod',
    errors: [has("action 'refund'")],
  }),
  {
    name: '--no-deployment refuses a default_profile whose action push refuses',
    deployments: ['g'],
    actions: [{name: 'refund', executor: {mcp: {server: 's', tool: 't'}}}],
    profiles: {prod: {...PROD, actions: [
      {name: 'refund', executor: {mcp: {server: 's', tool: ' '}}},
    ]}},
    defaultProfile: 'prod',
    errors: [err(
        "action 'refund' in model 'commerce' (commerce, profile 'prod') has " +
        "an mcp executor whose 'tool' is missing or blank.")],
    then: [{
      profiles: {},
      legacy: {prod: legacy('commerce', undefined, [
        {name: 'refund', executor: {mcp: {server: 's', tool: ' '}}},
      ])},
      code: 1, rejects: [pushed()],
    }],
    report: {code: 1, rejects: {'prod (default)': [pushed()]}},
  },
  sameAsRuntime({
    name: '--no-deployment refuses a default_profile the runtime refuses: the profile is a legacy wrapper that does not merge',
    legacy: {
      prod: legacy(
          'shop', [{name: 'Customer', source: bqTable('customer', 'prod')}]),
    },
    defaultProfile: 'prod',
    errors: [has("model 'shop' is not in the logical model")],
  }),
  sameAsRuntime({
    name: '--no-deployment refuses a default_profile the runtime refuses: the profile is a legacy wrapper that merges but does not load',
    deployments: ['g'],
    legacy: {
      prod: legacy(
          'commerce', [{name: 'Customer', source: 'not a table at all'}]),
    },
    defaultProfile: 'prod',
    errors: [has("source 'not a table at all' looks like a SQL query")],
    report: {code: 1, rejects: {'prod (default)': [pushed()]}},
  }),
], {flags: {deployment: false}, code: 1, noNetwork: true});
