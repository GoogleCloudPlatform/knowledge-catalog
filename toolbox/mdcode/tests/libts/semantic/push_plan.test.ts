// Tests the semantic-model push routing (src/tool/commands.ts): which
// destination legs run, and how a model document's deployment target is
// detected. The graph backend is NOT a command-line choice -- a model deploys
// to whichever backend its deployment target names -- so these pin the two
// pure decisions that drive dispatch: planPush (models + KC flag -> legs) and
// declaresGraphTarget (does a document name a graph at all).
//
// The deploy legs themselves are covered end to end elsewhere
// (deploy_bigquery.test.ts, deploy_spanner.test.ts,
// deploy_knowledge_catalog.test.ts).

import {describe, expect, test} from 'bun:test';

import {declaresGraphTarget, planPush} from '../../../src/tool/commands';

describe('planPush', () => {
  // The graph and Knowledge Catalog legs are two symmetric toggles, both on by
  // default. `on` is the common case; individual tests override a field.
  const on = {
    hasBigQuery: false,
    hasSpanner: false,
    hasUntargeted: false,
    graphEnabled: true,
    kcEnabled: true,
  };

  test('a BigQuery model deploys BigQuery then Knowledge Catalog', () => {
    expect(planPush({...on, hasBigQuery: true}))
        .toEqual({destinations: ['bigquery', 'kc']});
  });

  test('a Spanner model deploys Spanner then Knowledge Catalog', () => {
    expect(planPush({...on, hasSpanner: true}))
        .toEqual({destinations: ['spanner', 'kc']});
  });

  test('a logical model (no graph target) deploys only Knowledge Catalog', () => {
    expect(planPush({...on, hasUntargeted: true}))
        .toEqual({destinations: ['kc']});
  });

  test('the legs run in canonical order: BigQuery, then Spanner, then KC', () => {
    // Fail-fast runs BigQuery first regardless of how models are declared.
    expect(planPush({...on, hasBigQuery: true, hasSpanner: true}))
        .toEqual({destinations: ['bigquery', 'spanner', 'kc']});
  });

  test('--no-kc deploys only the graph backend the model names', () => {
    expect(planPush({...on, hasBigQuery: true, kcEnabled: false}))
        .toEqual({destinations: ['bigquery']});
  });

  test('--no-graph publishes only to Knowledge Catalog, leaving the graph alone',
       () => {
         // The bound model still has a graph target, but --no-graph skips the
         // graph leg -- a catalog-only push of the same model.
         expect(planPush({...on, hasBigQuery: true, graphEnabled: false}))
             .toEqual({destinations: ['kc']});
       });

  test('--no-graph and --no-kc together are an error: nothing to deploy', () => {
    const plan =
        planPush({...on, hasBigQuery: true, graphEnabled: false, kcEnabled: false});
    expect('error' in plan).toBe(true);
  });

  test('--no-kc on a logical model (no graph target) is an error: nowhere to go',
       () => {
         const plan = planPush({...on, hasUntargeted: true, kcEnabled: false});
         expect('error' in plan).toBe(true);
       });

  test('--no-kc errors when any model is untargeted, even alongside a graph model',
       () => {
         // The untargeted model can only reach Knowledge Catalog, so dropping it
         // fails the whole push rather than silently skipping that model.
         const plan =
             planPush({...on, hasBigQuery: true, hasUntargeted: true, kcEnabled: false});
         expect('error' in plan).toBe(true);
       });
});


describe('declaresGraphTarget', () => {
  const withSugar = `
semantic_model:
  - name: sales
    deployment_target: //bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g
`;
  const withExtension = `
semantic_model:
  - name: sales
    custom_extensions:
      - vendor_name: GOOGLE
        data: '{"deploymentTargets":["//spanner.googleapis.com/projects/p/instances/i/databases/db/propertyGraphs/g"]}'
`;
  const logicalOnly = `
semantic_model:
  - name: sales
    datasets:
      - name: orders
`;

  test('detects the deployment_target sugar', () => {
    expect(declaresGraphTarget(withSugar)).toBe(true);
  });

  test('detects a GOOGLE custom_extension deploymentTargets list', () => {
    expect(declaresGraphTarget(withExtension)).toBe(true);
  });

  test('a purely logical model declares no graph target', () => {
    expect(declaresGraphTarget(logicalOnly)).toBe(false);
  });

  test('an empty deployment_target string is not a target', () => {
    expect(declaresGraphTarget(`
semantic_model:
  - name: sales
    deployment_target: '   '
`)).toBe(false);
  });

  test('a non-GOOGLE extension is ignored', () => {
    expect(declaresGraphTarget(`
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
semantic_model:
  - name: sales
    custom_extensions:
      - vendor_name: GOOGLE
        data: 'not json'
`)).toBe(true);
       });
});
