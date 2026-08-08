// Behavior spec for the push-time validation gate
// (src/libts/semantic/validate.ts).

import {describe, expect, test} from 'bun:test';

import {CustomExtension, Metric, SemanticModel} from '../../../src/libts/semantic/ir';
import {LoadedModel} from '../../../src/libts/semantic/loader';
import {validatePushRequirements} from '../../../src/libts/semantic/validate';

// A parsed BigQuery Graph deployment target the strict matcher accepts.
const BQ_TARGET =
    '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';

function googleExt(targets: string[]): CustomExtension {
  return {vendorName: 'GOOGLE', data: JSON.stringify({deploymentTargets: targets})};
}

function loaded(model: SemanticModel, document = 'doc'): LoadedModel {
  return {document, model};
}

function model(
    over: Partial<SemanticModel> = {},
    exts?: CustomExtension[]): SemanticModel {
  return {
    name: 'm',
    entities: [],
    relationships: [],
    metrics: [],
    ...(exts ? {customExtensions: exts} : {}),
    ...over,
  };
}

describe('validatePushRequirements', () => {
  test('a model with a deployment target and resolved metrics passes', () => {
    const m = model(
        {metrics: [{name: 'rev', expression: 'SUM(o.p)', entity: 'o'} as Metric]},
        [googleExt([BQ_TARGET])]);
    expect(validatePushRequirements([loaded(m)])).toEqual([]);
  });

  test('a model with no deployment targets is rejected', () => {
    const errs = validatePushRequirements([loaded(model())]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('no deploymentTargets');
    expect(errs[0]).toContain('doc');
  });

  test('a BigQuery-target metric that resolves to no entity is rejected', () => {
    const m = model(
        {metrics: [{name: 'cnt', expression: 'COUNT(*)'} as Metric]},
        [googleExt([BQ_TARGET])]);
    const errs = validatePushRequirements([loaded(m)]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("metric 'cnt'");
    expect(errs[0]).toContain('single entity');
  });

  test('an entity-less metric is allowed when no BigQuery graph is targeted',
     () => {
       // A deployment target that is not a BigQuery Graph URI: the model still
       // declares a target (passes the first check) but does not target a
       // graph, so the metric-entity rule does not apply.
       const m = model(
           {metrics: [{name: 'cnt', expression: 'COUNT(*)'} as Metric]},
           [googleExt(['//dataplex.googleapis.com/projects/p/locations/us'])]);
       expect(validatePushRequirements([loaded(m)])).toEqual([]);
     });

  test('malformed GOOGLE extension JSON is reported, not thrown', () => {
    const m = model({}, [{vendorName: 'GOOGLE', data: '{not json'}]);
    const errs = validatePushRequirements([loaded(m)]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('not valid JSON');
  });

  test('errors accumulate across models', () => {
    const a = loaded(model({name: 'a'}), 'a');
    const b = loaded(model({name: 'b'}), 'b');
    const errs = validatePushRequirements([a, b]);
    expect(errs.length).toBe(2);
  });
});
