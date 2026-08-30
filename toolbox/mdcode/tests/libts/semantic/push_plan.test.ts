// Tests the semantic-model push flag logic (src/tool/commands.ts): which flag
// combinations are coherent, and how a model document's deployment target is
// detected. The graph backend is NOT a command-line choice -- a model deploys
// to whichever backend its deployment target names -- so these pin the two pure
// decisions that gate a push: checkPushSelection (are the leg toggles and
// binding-profile selection consistent?) and declaresGraphTarget (does a
// document name a graph at all).
//
// The deploy legs themselves are covered end to end elsewhere
// (deploy_bigquery.test.ts, deploy_spanner.test.ts,
// deploy_knowledge_catalog.test.ts).

import {describe, expect, test} from 'bun:test';

import {checkPushSelection, declaresGraphTarget} from '../../../src/tool/commands';

describe('checkPushSelection', () => {
  // Both legs on, no binding-profile selection: the default `kcmd push`. Each
  // test overrides the field it exercises.
  const base = {
    graphEnabled: true,
    kcEnabled: true,
    allProfiles: false,
    namedProfile: false,
  };

  test('the default push (both legs, default profile) is coherent', () => {
    expect(checkPushSelection(base)).toBeNull();
  });

  test('--no-kc (graph only) is coherent', () => {
    expect(checkPushSelection({...base, kcEnabled: false})).toBeNull();
  });

  test('--no-graph (catalog only) is coherent', () => {
    expect(checkPushSelection({...base, graphEnabled: false})).toBeNull();
  });

  test('--profile selects one binding profile', () => {
    expect(checkPushSelection({...base, namedProfile: true})).toBeNull();
  });

  test('--all-profiles fans out over every binding profile', () => {
    expect(checkPushSelection({...base, allProfiles: true})).toBeNull();
  });

  test('--no-graph --no-kc is an error: nothing to deploy', () => {
    const r = checkPushSelection({...base, graphEnabled: false, kcEnabled: false});
    expect(r).not.toBeNull();
    expect(r!.error).toContain('nothing to deploy');
  });

  test('--no-graph --profile is an error: no graph leg to bind', () => {
    const r =
        checkPushSelection({...base, graphEnabled: false, namedProfile: true});
    expect(r).not.toBeNull();
    expect(r!.error).toContain('no graph leg to bind');
  });

  test('--no-graph --all-profiles is an error: no graph leg to bind', () => {
    const r =
        checkPushSelection({...base, graphEnabled: false, allProfiles: true});
    expect(r).not.toBeNull();
    expect(r!.error).toContain('no graph leg to bind');
  });

  test('--profile --all-profiles is an error: one profile or every profile', () => {
    const r =
        checkPushSelection({...base, namedProfile: true, allProfiles: true});
    expect(r).not.toBeNull();
    expect(r!.error).toContain('use one or the other');
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
