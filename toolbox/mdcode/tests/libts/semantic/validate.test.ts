// Behavior spec for the push-time validation gate
// (src/libts/semantic/validate.ts).

import {describe, expect, test} from 'bun:test';

import {CustomExtension, Entity, Metric, SemanticModel} from '../../../src/libts/semantic/ir';
import {LoadedModel} from '../../../src/libts/semantic/loader';
import {validateBigQueryDataSources, validatePushRequirements} from '../../../src/libts/semantic/validate';
import {BigQueryClientMock} from '../mocks';

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


// Helpers for the live data-source check.
function entity(name: string, dataSource: string): Entity {
  return {name, dataSource, keys: [], fields: []} as Entity;
}

function mockTable(project: string, dataset: string, tableId: string) {
  return {id: tableId, tableReference: {projectId: project, datasetId: dataset, tableId}};
}

describe('validateBigQueryDataSources', () => {
  test('passes when every entity source table is reachable', async () => {
    const bq = new BigQueryClientMock();
    bq.addMockTable(mockTable('p', 'd', 'orders'));
    bq.addMockTable(mockTable('p', 'd', 'customer'));
    const m = model(
        {entities: [entity('orders', 'p.d.orders'),
                    entity('customer', 'p.d.customer')]});
    expect(await validateBigQueryDataSources([loaded(m)], bq)).toEqual([]);
  });

  test('reports a missing source table, naming the entity/model/document',
     async () => {
       const bq = new BigQueryClientMock();
       bq.addMockTable(mockTable('p', 'd', 'orders'));
       const m = model({
         entities: [entity('orders', 'p.d.orders'),
                    entity('gone', 'p.d.ghost')],
       });
       const errs = await validateBigQueryDataSources([loaded(m)], bq);
       expect(errs.length).toBe(1);
       expect(errs[0]).toContain('p.d.ghost');
       expect(errs[0]).toContain('does not exist');
       expect(errs[0]).toContain("entity 'gone'");
       expect(errs[0]).toContain('doc');
     });

  test('reports a permission-denied (403) source table', async () => {
    const bq = new BigQueryClientMock();
    bq.getTable = (async () => ({status: 403, message: 'denied'})) as any;
    const m = model({entities: [entity('o', 'p.d.o')]});
    const errs = await validateBigQueryDataSources([loaded(m)], bq);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('permission denied');
  });

  test('skips sources that are not a plain three-part table reference',
     async () => {
       // A query source and an under-qualified ref cannot be probed with
       // tables.get, so neither is checked (and no table is mocked).
       const bq = new BigQueryClientMock();
       const m = model({
         entities: [entity('q', 'SELECT * FROM x'),
                    entity('short', 'd.t')],
       });
       expect(await validateBigQueryDataSources([loaded(m)], bq)).toEqual([]);
     });

  test('probes each distinct table once across entities and models',
     async () => {
       const bq = new BigQueryClientMock();
       bq.addMockTable(mockTable('p', 'd', 'shared'));
       let calls = 0;
       const orig = bq.getTable.bind(bq);
       bq.getTable = ((p: string, d: string, t: string) => {
         calls++;
         return orig(p, d, t);
       }) as any;
       const m1 = model({name: 'm1', entities: [entity('a', 'p.d.shared')]});
       const m2 = model({name: 'm2', entities: [entity('b', 'p.d.shared')]});
       const errs = await validateBigQueryDataSources(
           [loaded(m1, 'd1'), loaded(m2, 'd2')], bq);
       expect(errs).toEqual([]);
       expect(calls).toBe(1);
     });
});
