// Tests for the semantic-model Spanner deploy leg
// (src/libts/semantic/deploy_spanner.ts).
//
// `spannerGraphTargets` is exercised as a pure function; `deploySpanner` is
// exercised end to end over a fixture (loader -> IR -> generator -> target),
// with the Spanner client stubbed so no network call is made.

import {describe, expect, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {ApiContext} from '../../../src/libts/gcp/context';
import * as spannerClient from '../../../src/libts/gcp/spanner';
import {deploySpanner} from '../../../src/libts/semantic/deploy_spanner';
import {spannerGraphTargets} from '../../../src/libts/semantic/deployment_target';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {loadSemanticModels} from '../../../src/libts/semantic/loader';

const CTX = new ApiContext('test-project', 'us', 'test-token');

function models(
    docs: {name: string; text: string}[], defaultProject = 'test-project') {
  const r = loadSemanticModels(docs, {defaultProject});
  if (r.error) throw new Error(r.error);
  return r.models;
}

const FIXTURES = path.join(__dirname, 'fixtures');

const SPANNER_URI =
    '//spanner.googleapis.com/projects/demo/instances/prod/databases/commerce/propertyGraphs/sales_graph';
const BQ_URI =
    '//bigquery.googleapis.com/projects/demo/datasets/sales/propertyGraphs/sales_graph';

const OSSIE = fs.readFileSync(
    path.join(FIXTURES, 'sales_spanner_graph_target.yaml'), 'utf8');

function modelWithExtension(data: string, vendor = 'GOOGLE'): SemanticModel {
  return {
    name: 'm',
    entities: [],
    relationships: [],
    metrics: [],
    customExtensions: [{vendorName: vendor, data}],
  };
}


describe('spannerGraphTargets', () => {
  test('parses a Spanner Graph deployment target', () => {
    const {targets, malformed} = spannerGraphTargets(
        modelWithExtension(JSON.stringify({deploymentTargets: [SPANNER_URI]})));
    expect(targets).toEqual([
      {
        project: 'demo',
        instance: 'prod',
        database: 'commerce',
        graphName: 'sales_graph',
        uri: SPANNER_URI,
      },
    ]);
    expect(malformed).toEqual([]);
  });

  test('a BigQuery target is not a Spanner target, and not malformed', () => {
    // A BigQuery URI is a recognized destination, just not a Spanner one, so it
    // is neither returned as a Spanner target nor flagged as a typo.
    const {targets, malformed} = spannerGraphTargets(
        modelWithExtension(JSON.stringify({deploymentTargets: [BQ_URI]})));
    expect(targets).toEqual([]);
    expect(malformed).toEqual([]);
  });

  test('an unsupported URI is collected as malformed', () => {
    const bad = '//alloydb.googleapis.com/projects/p/whatever';
    const {targets, malformed} = spannerGraphTargets(
        modelWithExtension(JSON.stringify({deploymentTargets: [bad]})));
    expect(targets).toEqual([]);
    expect(malformed).toEqual([bad]);
  });

  test('rejects a graph name with an injection character', () => {
    const evil =
        '//spanner.googleapis.com/projects/demo/instances/prod/databases/commerce/propertyGraphs/g`;DROP';
    const {targets, malformed} = spannerGraphTargets(
        modelWithExtension(JSON.stringify({deploymentTargets: [evil]})));
    expect(targets).toEqual([]);
    expect(malformed).toEqual([evil]);
  });
});


describe('deploySpanner', () => {
  test('validateOnly returns the DDL without calling Spanner', async () => {
    const ddlSpy =
        spyOn(spannerClient.SpannerClient.prototype, 'updateDatabaseDdl');
    try {
      const res = await deploySpanner(
          models([{name: 'sales', text: OSSIE}]), CTX, {validateOnly: true});
      expect(res.success).toBe(true);
      expect(res.deployed).toBe(0);
      expect(ddlSpy).not.toHaveBeenCalled();

      const ddl = res.ddl.join('\n');
      expect(ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH sales_graph');
      // Bare table name, not the three-part BigQuery source.
      expect(ddl).toContain('Orders AS orders');
      // The metric is dropped (Spanner has no MEASURE).
      expect(res.warnings.some(w => w.includes('total_revenue'))).toBe(true);
    } finally {
      ddlSpy.mockRestore();
    }
  });

  test(
      'applies the DDL to the target database and polls to completion',
      async () => {
        const ddlSpy =
            spyOn(spannerClient.SpannerClient.prototype, 'updateDatabaseDdl')
                .mockImplementation(async () => ({
                                      status: 200,
                                      result: {name: 'op-1', done: false},
                                    }));
        const opSpy =
            spyOn(spannerClient.SpannerClient.prototype, 'getOperation')
                .mockImplementation(
                    async () => ({status: 200, result: {done: true}}));
        try {
          const res = await deploySpanner(
              models([{name: 'sales', text: OSSIE}]), CTX, {pollBackoffMs: 0});
          expect(res.success).toBe(true);
          expect(res.deployed).toBe(1);
          expect(ddlSpy).toHaveBeenCalledTimes(1);

          // updateDatabaseDdl(project, instance, database, statements) -- the
          // coords come from the deployment-target URI.
          const [project, instance, database, statements] =
              ddlSpy.mock.calls[0];
          expect(project).toBe('demo');
          expect(instance).toBe('prod');
          expect(database).toBe('commerce');
          expect(statements[0])
              .toContain('CREATE OR REPLACE PROPERTY GRAPH sales_graph');

          // The returned operation was polled by name until done.
          expect(opSpy).toHaveBeenCalledTimes(1);
          expect(opSpy.mock.calls[0][0]).toBe('op-1');
        } finally {
          ddlSpy.mockRestore();
          opSpy.mockRestore();
        }
      });

  test('a completed operation carrying an error fails the deploy', async () => {
    const ddlSpy =
        spyOn(spannerClient.SpannerClient.prototype, 'updateDatabaseDdl')
            .mockImplementation(async () => ({
                                  status: 200,
                                  result: {
                                    name: 'op-1',
                                    done: true,
                                    error: {code: 3, message: 'bad DDL'},
                                  },
                                }));
    try {
      const res = await deploySpanner(
          models([{name: 'sales', text: OSSIE}]), CTX, {pollBackoffMs: 0});
      expect(res.success).toBe(false);
      expect(res.details).toContain('bad DDL');
      expect(res.deployed).toBe(0);
    } finally {
      ddlSpy.mockRestore();
    }
  });

  test(
      'an operation that never completes fails after exhausting polls',
      async () => {
        const ddlSpy =
            spyOn(spannerClient.SpannerClient.prototype, 'updateDatabaseDdl')
                .mockImplementation(async () => ({
                                      status: 200,
                                      result: {name: 'op-1', done: false},
                                    }));
        const opSpy =
            spyOn(spannerClient.SpannerClient.prototype, 'getOperation')
                .mockImplementation(
                    async () => ({status: 200, result: {done: false}}));
        try {
          const res = await deploySpanner(
              models([{name: 'sales', text: OSSIE}]), CTX,
              {pollBackoffMs: 0, maxOperationPolls: 3});
          expect(res.success).toBe(false);
          expect(res.details).toContain('did not complete after 3 polls');
        } finally {
          ddlSpy.mockRestore();
          opSpy.mockRestore();
        }
      });

  test('a model with no Spanner target fails clearly', async () => {
    // A BigQuery-only model handed to the Spanner leg has nothing to deploy;
    // commands.ts routes such models away, so this is the direct-call guard.
    const bqDoc = fs.readFileSync(
        path.join(FIXTURES, 'sales_bq_graph_target.yaml'), 'utf8');
    const res = await deploySpanner(
        models([{name: 'sales', text: bqDoc}]), CTX, {validateOnly: true});
    expect(res.success).toBe(false);
    expect(res.details).toContain('no Spanner Graph deploymentTarget');
  });
});
