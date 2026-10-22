// Tests of which pushes take two phases and the push flags a push in two
// phases refuses (src/tool/commands.ts).

import {expect} from 'bun:test';

import {loadSemanticModels} from '../../../src/libts/semantic/loader';

import {boundTo, err, modelFile, msg, PushRun, refused, scenarios} from './harness';

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
    name: '--no-kc, --profile, --all-profiles and --no-profile each fail before any network call with --no-deployment',
    deployments: ['g1', 'g2'],
    profiles: {x: boundTo('x')},
    ...refused({kc: false, deployment: false}, err(msg.flag.noKc)),
    then: [
      refused({profile: 'x', deployment: false}, err(msg.flag.profile)),
      refused({allProfiles: true, deployment: false},
              err(msg.flag.allProfiles)),
      refused({profile: false, deployment: false}, err(msg.flag.noProfile)),
    ],
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
], {code: 0});
