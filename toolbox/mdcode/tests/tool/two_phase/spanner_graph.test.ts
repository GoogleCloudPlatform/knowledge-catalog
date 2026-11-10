// Tests that push refuses a Spanner graph that Spanner would refuse before it
// writes anything: from the model alone for every Spanner deployment, and from
// reads of the database for each Spanner deployment it deploys
// (src/libts/semantic/validate.ts, src/tool/commands.ts).

import {CUSTOMER, err, scenarios, SPANNER_CUSTOMER, spannerGraph} from './harness';

const ON_SPANNER = {...CUSTOMER, source: SPANNER_CUSTOMER};
const BAD_NAME =
    "model 'commerce' (commerce) deployment 'sp' targets Spanner graph " +
    "'my-graph', but a Spanner graph name starts with a letter, holds only " +
    'letters, digits and underscores, and is at most 128 characters long; ' +
    'rename the graph in the target.';

scenarios('a Spanner graph', [
  {
    name: 'that Spanner would refuse for its name is refused before the catalog preflight, also under --no-deployment, and kcmd profiles reports it',
    deployments: [{name: 'sp', target: spannerGraph('my-graph')}],
    errors: [err(BAD_NAME)],
    report: {code: 1, rejects: {'no profiles': [BAD_NAME]}},
    then: [{
      flags: {deployment: false}, code: 1, nothingWritten: true,
      errors: [err(BAD_NAME)],
    }],
  },
], {entities: [ON_SPANNER], code: 1, nothingWritten: true, events: []});
