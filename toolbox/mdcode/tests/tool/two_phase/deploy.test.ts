// Tests that push checks every destination before it writes
// (src/tool/commands.ts, push).

import {bqGraph, err, has, modelFile, refused, scenarios, Scope} from './harness';

const sales = (s: Scope) =>
    modelFile(s).replace('name: commerce', 'name: sales');
const vanilla = (g: string) => ({google: {deploymentTargets: [bqGraph(g)]}});
const stops = (error: unknown, flags = {}) =>
    ({...refused(flags, error), log: []});
const NO_TARGET = has("model 'sales' (sales) declares 0 deployments");
const ONE_MODEL = err(
    "entry group 'commerce_eg' would receive 2 models, but only one model " +
    'per entry group is supported; split them into separate entry groups.');

scenarios('push writes nothing when a check fails', [
  {
    name: 'a push whose catalog leg fails its checks deploys no graph, and a ' +
        '--validate-only push reports the error before any live check',
    ...vanilla('g'),
    files: {'sales.yaml': sales({})},
    ...stops(NO_TARGET),
    then: [stops(NO_TARGET, {validateOnly: true})],
  },
  {
    name: 'a push of two model files whose GOOGLE block names the graph ' +
        'prints only the one-model error and checks no graph, as do a ' +
        '--validate-only, a catalog-only and a --no-deployment push',
    ...vanilla('g'),
    files: {'sales.yaml': sales(vanilla('h'))},
    ...stops(ONE_MODEL),
    then: [
      stops(ONE_MODEL, {validateOnly: true}),
      stops(ONE_MODEL, {validateOnly: true, profile: false}),
      stops(ONE_MODEL, {deployment: false}),
    ],
  },
], {
  code: 1,
  nothingWritten: true,
});
