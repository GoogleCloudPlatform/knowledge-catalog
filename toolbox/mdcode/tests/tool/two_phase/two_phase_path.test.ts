// Tests of the push flags push refuses, what a model with no deployments
// publishes, the deployments `--deployment` selects and checks, the
// default_profile warning and the Spanner metrics rule (src/tool/commands.ts,
// src/libts/semantic/deployment_target.ts).

import {expect, test} from 'bun:test';

import {PushOptions, typedDeployment} from '../../../src/tool/commands';

import {boundAt, boundTo, Case, CUSTOMER, Deployment, err, EXPRESSION_KEY, has, msg, PushRun, refused, scenarios, SPANNER_CUSTOMER, spannerGraph} from './harness';

const ownBinding = (r: PushRun, model = r.published) =>
    expect(model.entities[0].dataSource).toBe('test-project.d.customer');

const CHOOSES_NO_BINDING = "Warning: catalog.yaml sets default_profile " +
    "'prod', which chooses no binding on this push: Knowledge Catalog " +
    'receives the model file as written, and each deployment uses the ' +
    'profile it names.';

// A push of a model with sibling profile file prod, under default_profile
// prod, that prints `warnings` and publishes the model file's own binding.
const underDefault =
    (name: string, deployments: Deployment[], flags: PushOptions,
     warnings: string[]): Case => ({
      name: `default_profile ${name}`,
      deployments,
      defaultProfile: 'prod',
      profiles: {prod: boundTo('prod')},
      flags,
      warnings,
      check: ownBinding,
    });

// A push that publishes the model file as written, with the profile files
// `profiles` lists, stores a copy of each file in `files`, and deploys nothing.
const published = (profiles: string[]|undefined, files: string[]) => ({
  code: 0,
  events: ['preflight', 'apply'],
  check: (r: PushRun) => {
    ownBinding(r);
    expect(r.published.profiles?.map(p => p.name)).toEqual(profiles);
    const [, , options] = r.fake.preflight.mock.calls[0];
    expect(options.sourceFiles.map((f: any) => f.fileName)).toEqual(files);
  },
});

scenarios('the two-phase push path', [
  {
    name: '--no-kc, --profile, --all-profiles, --no-profile and --emit-expressions each fail before any network call, all of them at once each with its own error, as do --no-deployment with --deployment in either order, a bare or empty --deployment and a deployment name the model lacks',
    deployments: ['g1', 'g2'],
    profiles: {x: boundTo('x')},
    ...refused({kc: false}, err(msg.retired['--no-kc'])),
    then: [
      // cac gives a numeric profile name as a number.
      refused({profile: 'x'}, err(msg.retired['--profile'])),
      refused({profile: 7 as any}, err(msg.retired['--profile'])),
      refused({allProfiles: true}, err(msg.retired['--all-profiles'])),
      refused({profile: false}, err(msg.retired['--no-profile'])),
      refused({emitExpressions: true}, err(msg.retired['--emit-expressions'])),
      {
        flags: {
          profile: false,
          allProfiles: true,
          emitExpressions: true,
          kc: false,
        },
        code: 1,
        errors: [
          msg.retired['--all-profiles'],
          msg.retired['--no-profile'],
          msg.retired['--emit-expressions'],
          msg.retired['--no-kc'],
        ].map(err),
        noNetwork: true,
      },
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
    ...underDefault(
        'does not choose the profile of a deployment', ['g'], {},
        [`${CHOOSES_NO_BINDING} Deployment 'g' uses the model file's own ` +
         'bindings.']),
    events: ['preflight', 'apply', 'deploy g'],
    check: r => {
      ownBinding(r);
      ownBinding(r, r.deployed('g', 'bq')!);
    },
  },
  underDefault(
      'needs no warning when every selected deployment names a profile and one uses it',
      [{name: 'g', profile: 'prod'}], {validateOnly: true}, []),
  underDefault(
      'names each deployment that names no profile when another deployment uses it',
      [{name: 'a', profile: 'prod'}, 'b', 'c'], {validateOnly: true},
      [`${CHOOSES_NO_BINDING} Deployments 'b', 'c' use the model file's ` +
       'own bindings.']),
  underDefault(
      'names no deployment under --no-deployment, which selects none', ['g'],
      {deployment: false}, [CHOOSES_NO_BINDING]),
  {
    ...underDefault(
        'does not choose the bindings Knowledge Catalog receives, and gives ' +
            'no warning in a scope with no model',
        [], {}, [CHOOSES_NO_BINDING]),
    then: [{noModel: true, flags: {deployment: false}, code: 0, warnings: []}],
  },
  {
    // cac gives `true` for an absent flag that has a negated form, and for a
    // bare `--profile`.
    name: 'a model with no deployments list publishes the model file as written, with its profile files, and deploys nothing, with no flags, profile: true or deployment: true, beside a sibling profile file, a legacy profile file or none',
    profiles: {prod: boundTo('prod')},
    ...published(['prod'], ['commerce.yaml', 'commerce.profile.prod.yaml']),
    then: [
      {
        flags: {profile: true, deployment: true},
        ...published(['prod'], ['commerce.yaml', 'commerce.profile.prod.yaml']),
      },
      {
        profiles: {},
        legacy: {old: 'semantic_model:\n  - name: commerce\n'},
        ...published(undefined, ['commerce.yaml', 'commerce.profiles/old.yaml']),
      },
      {profiles: {}, ...published(undefined, ['commerce.yaml'])},
    ],
  },
  {
    name: 'a Spanner deployment that names no profile is refused when the model has metrics, after the table check, and deploys when it has none, and one under a profile whose metrics_exclude is "*" deploys',
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
      entities: [CUSTOMER, {...CUSTOMER, name: 'Orders'}],
      code: 1,
      errors: ['Customer', 'Orders'].map(
          e => has(`but the model file binds entity '${e}'`)),
    }, {
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
