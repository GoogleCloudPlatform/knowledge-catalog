// Tests of which pushes take two phases, the push flags a push in two phases
// refuses, the deployments `--deployment` selects and checks, and the Spanner
// metrics rule (src/tool/commands.ts, src/libts/semantic/deployment_target.ts).

import {expect, test} from 'bun:test';

import {loadSemanticModels} from '../../../src/libts/semantic/loader';
import {typedDeployment} from '../../../src/tool/commands';

import {boundAt, boundTo, CUSTOMER, err, EXPRESSION_KEY, has, modelFile, msg, PushRun, refused, scenarios, SPANNER_CUSTOMER, spannerGraph} from './harness';

const ONE_PHASE = {
  called: {preflight: 0, apply: 0, deployKc: 1},
  check: (r: PushRun) => {
    const [models, , options] = r.fake.deployKc.mock.calls[0];
    const loaded = loadSemanticModels(
        [{name: 'commerce', text: modelFile()}],
        {defaultProject: 'test-project'});
    expect(loaded.error).toBeUndefined();
    expect(models).toEqual(loaded.models);
    expect((options.sourceFiles ?? []).map((f: any) => f.fileName))
        .toEqual(['commerce.yaml']);
  },
};

scenarios('the two-phase push path', [
  {
    name: '--no-kc, --profile, --all-profiles and --no-profile each fail before any network call with --no-deployment, as do --no-deployment with --deployment in either order, a bare or empty --deployment and a deployment name the model lacks',
    deployments: ['g1', 'g2'],
    profiles: {x: boundTo('x')},
    ...refused({kc: false, deployment: false}, err(msg.flag.noKc)),
    then: [
      refused({profile: 'x', deployment: false}, err(msg.flag.profile)),
      refused({allProfiles: true, deployment: false},
              err(msg.flag.allProfiles)),
      refused({profile: false, deployment: false}, err(msg.flag.noProfile)),
      refused({deployment: [false, 'g1']}, err(msg.flag.both)),
      refused({deployment: ['g1', false]}, err(msg.flag.both)),
      refused({deployment: [true]}, err(msg.flag.bare)),
      refused({deployment: ['']}, err(msg.flag.bare)),
      refused({deployment: ['nope']}, err(
          "Model 'commerce' has no deployment named 'nope' (available: " +
          'g1, g2).')),
    ],
  },
  {
    name: '--deployment g1 fails before any network call when the unselected ' +
        'g2 has a target in no accepted form, names a profile the model does ' +
        'not declare, or names a profile whose key column is an expression, ' +
        "and with g2 selected that error prints beside another profile's error",
    deployments: ['g1', {name: 'g2', target: 'not-a-target'}],
    profiles: {prod: boundTo('prod')},
    ...refused({deployment: ['g1']}, has(
        "Error: Model 'commerce': deployment 'g2' targets 'not-a-target'")),
    then: [{
      deployments: ['g1', {name: 'g2', profile: 'nope'}],
      ...refused({deployment: ['g1']},
                 err(msg.unknownProfile('g2', 'nope', ['prod']))),
    }, {
      deployments: ['g1', {name: 'g2', profile: 'prod'}],
      profiles: {prod: {entities: {Customer: EXPRESSION_KEY}}},
      ...refused({deployment: ['g1']}, has(
          "key column 'UPPER(c_key)' is not a physical column name")),
    }, {
      deployments: [{name: 'g1', profile: 'p1'}, {name: 'g2', profile: 'prod'}],
      profiles: {
        p1: {entities: {Customer: {...CUSTOMER, primary_key: undefined}}},
        prod: {entities: {Customer: EXPRESSION_KEY}},
      },
      flags: {deployment: ['g1', 'g2']},
      code: 1,
      errors: [
        has("profile 'p1': entity 'Customer' has no primary_key"),
        has("profile 'prod': entity 'Customer' key column 'UPPER(c_key)'"),
      ],
      noNetwork: true,
    }],
  },
  {
    name: '--deployment in a scope with no model is refused',
    noModel: true,
    ...refused({deployment: ['nope']},
               err("--deployment names 'nope', but the scope has no model.")),
  },
  {
    // cac gives `true` for an absent flag that has a negated form.
    name: 'a model with no deployments list and no profile file does not push in two phases, with no flags, deployment: true or profile: true',
    ...ONE_PHASE,
    then: [
      {flags: {deployment: true}, code: 0, ...ONE_PHASE},
      {flags: {profile: true}, code: 0, ...ONE_PHASE},
    ],
  },
  {
    name: 'a Spanner deployment that names no profile is refused when the model has metrics and deploys when it has none, and one under a profile whose metrics_exclude is "*" deploys',
    deployments: [{name: 'sp', target: spannerGraph('g')}],
    entities: [{...CUSTOMER, source: SPANNER_CUSTOMER}],
    metrics: [{
      name: 'customers',
      entity: 'Customer',
      expression: 'COUNT(Customer.key)',
    }],
    code: 1,
    errors: [err(msg.spannerMetrics('sp'))],
    called: {preflight: 0},
    nothingWritten: true,
    then: [{
      metrics: undefined,
      code: 0,
      events: ['preflight', 'apply', 'deploy sp'],
    }, {
      deployments: [{name: 'sp', target: spannerGraph('g'), profile: 'ops'}],
      entities: [CUSTOMER],
      profiles: {ops: {...boundAt(SPANNER_CUSTOMER), metrics_exclude: '*'}},
      code: 0,
      events: ['preflight', 'apply', 'deploy sp'],
    }],
  },
], {code: 0});

// Each row gives the command line and the option push gets.
test.each([
  [['--deployment'], [true]],
  [['--deployment', '--validate-only'], [true]],
  [['--deployment', ''], ['']],
  [['--deployment=a,b'], ['a,b']],
  [['--deployment', 'a', '--deployment', 'b'], ['a', 'b']],
  [['--', '--deployment', 'a'], true],
  [['--deployment', 'g1', '--no-deployment'], ['g1', false]],
  [['-no-deployment'], false],
])('typedDeployment(%p)', (args, expected) =>
    expect(typedDeployment(args)).toEqual(expected));
