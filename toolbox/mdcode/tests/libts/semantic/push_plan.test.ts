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
  test('a BigQuery model with KC on deploys BigQuery then Knowledge Catalog',
       () => {
         expect(planPush({
           hasBigQuery: true,
           hasSpanner: false,
           hasUntargeted: false,
           kcEnabled: true,
         })).toEqual({destinations: ['bigquery', 'kc']});
       });

  test('a Spanner model with KC on deploys Spanner then Knowledge Catalog',
       () => {
         expect(planPush({
           hasBigQuery: false,
           hasSpanner: true,
           hasUntargeted: false,
           kcEnabled: true,
         })).toEqual({destinations: ['spanner', 'kc']});
       });

  test('a logical model (no graph target) with KC on deploys only Knowledge Catalog',
       () => {
         expect(planPush({
           hasBigQuery: false,
           hasSpanner: false,
           hasUntargeted: true,
           kcEnabled: true,
         })).toEqual({destinations: ['kc']});
       });

  test('the legs run in canonical order: BigQuery, then Spanner, then KC', () => {
    // Fail-fast runs BigQuery first regardless of how models are declared.
    expect(planPush({
      hasBigQuery: true,
      hasSpanner: true,
      hasUntargeted: false,
      kcEnabled: true,
    })).toEqual({destinations: ['bigquery', 'spanner', 'kc']});
  });

  test('--no-kc deploys only the graph backend the model names', () => {
    expect(planPush({
      hasBigQuery: true,
      hasSpanner: false,
      hasUntargeted: false,
      kcEnabled: false,
    })).toEqual({destinations: ['bigquery']});
  });

  test('--no-kc on a logical model (no graph target) is an error: nowhere to go',
       () => {
         const plan = planPush({
           hasBigQuery: false,
           hasSpanner: false,
           hasUntargeted: true,
           kcEnabled: false,
         });
         expect('error' in plan).toBe(true);
       });

  test('--no-kc errors when any model is untargeted, even alongside a graph model',
       () => {
         // The untargeted model can only reach Knowledge Catalog, so dropping it
         // fails the whole push rather than silently skipping that model.
         const plan = planPush({
           hasBigQuery: true,
           hasSpanner: false,
           hasUntargeted: true,
           kcEnabled: false,
         });
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
