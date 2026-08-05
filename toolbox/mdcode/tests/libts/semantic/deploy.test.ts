// Tests for the semantic-model BigQuery deploy leg
// (src/libts/semantic/deploy.ts).
//
// `bigQueryGraphTargets` is exercised as a pure function; `deployBigQuery` is
// exercised end to end over an Ossie fixture (loader -> IR -> generator ->
// target), with the BigQuery client stubbed so no network call is made.

import {describe, expect, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as bq from '../../../src/libts/gcp/bigquery';
import {ApiContext} from '../../../src/libts/gcp/context';
import {bigQueryGraphTargets, deployBigQuery} from '../../../src/libts/semantic/deploy';
import {SemanticModel} from '../../../src/libts/semantic/ir';

const CTX = new ApiContext('test-project', 'us', 'test-token');

const FIXTURES = path.join(__dirname, 'fixtures');

const BQ_URI =
    '//bigquery.googleapis.com/projects/demo/datasets/sales/propertyGraphs/sales_graph';

// A loader-valid model that declares a GOOGLE BigQuery Graph deployment target
// (resolves to demo.sales.sales_graph), and the same model without one.
const OSSIE =
    fs.readFileSync(path.join(FIXTURES, 'sales_bq_graph_target.yaml'), 'utf8');
const OSSIE_NO_TARGET =
    fs.readFileSync(path.join(FIXTURES, 'sales_no_target.yaml'), 'utf8');

// A model carrying only a single custom_extension.
function modelWithExtension(data: string, vendor = 'GOOGLE'): SemanticModel {
  return {
    name: 'm',
    entities: [],
    relationships: [],
    metrics: [],
    customExtensions: [{vendorName: vendor, data}],
  };
}


describe('bigQueryGraphTargets', () => {
  test('parses a BigQuery Graph deployment target', () => {
    const targets = bigQueryGraphTargets(
        modelWithExtension(JSON.stringify({deploymentTargets: [BQ_URI]})));
    expect(targets).toEqual([
      {
        project: 'demo',
        dataset: 'sales',
        graphName: 'sales_graph',
        uri: BQ_URI
      },
    ]);
  });

  test('ignores non-GOOGLE vendor extensions', () => {
    const targets = bigQueryGraphTargets(modelWithExtension(
        JSON.stringify({deploymentTargets: [BQ_URI]}), 'DATABRICKS'));
    expect(targets).toEqual([]);
  });

  test('ignores deployment targets that are not BigQuery Graphs', () => {
    const dataplexUri =
        'projects/demo/locations/us/entryGroups/@bigquery/entries/sales_graph';
    const targets = bigQueryGraphTargets(
        modelWithExtension(JSON.stringify({deploymentTargets: [dataplexUri]})));
    expect(targets).toEqual([]);
  });

  test('returns [] for a model with no custom extensions', () => {
    const targets = bigQueryGraphTargets(
        {name: 'm', entities: [], relationships: [], metrics: []});
    expect(targets).toEqual([]);
  });

  test('throws on malformed extension JSON', () => {
    expect(() => bigQueryGraphTargets(modelWithExtension('{not json')))
        .toThrow(/not valid JSON/);
  });

  test('collects multiple targets in order', () => {
    const uri2 =
        '//bigquery.googleapis.com/projects/p2/datasets/d2/propertyGraphs/g2';
    const targets = bigQueryGraphTargets(modelWithExtension(
        JSON.stringify({deploymentTargets: [BQ_URI, uri2]})));
    expect(targets.map(t => t.graphName)).toEqual(['sales_graph', 'g2']);
  });
});


describe('deployBigQuery', () => {
  test('validateOnly emits the DDL without calling BigQuery', async () => {
    const querySpy = spyOn(bq.BigQueryClient.prototype, 'query');
    const logs: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((m?: any) => {
      logs.push(String(m));
    });
    try {
      const res = await deployBigQuery(
          [{name: 'sales', text: OSSIE}], CTX, {validateOnly: true});
      expect(res.success).toBe(true);
      expect(querySpy).not.toHaveBeenCalled();

      const out = logs.join('\n');
      expect(out).toContain('CREATE OR REPLACE PROPERTY GRAPH');
      // The graph name is qualified from the deployment target, not gcloud
      // defaults.
      expect(out).toContain('`demo.sales.sales_graph`');
    } finally {
      logSpy.mockRestore();
      querySpy.mockRestore();
    }
  });

  test('executes the DDL against the target project', async () => {
    const querySpy =
        spyOn(bq.BigQueryClient.prototype, 'query')
            .mockImplementation(
                async () => ({status: 200, result: {jobComplete: true}}));
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await deployBigQuery([{name: 'sales', text: OSSIE}], CTX, {});
      expect(res.success).toBe(true);
      expect(querySpy).toHaveBeenCalledTimes(1);

      const [project, sql] = querySpy.mock.calls[0];
      expect(project).toBe('demo');
      expect(sql).toContain(
          'CREATE OR REPLACE PROPERTY GRAPH `demo.sales.sales_graph`');
    } finally {
      logSpy.mockRestore();
      querySpy.mockRestore();
    }
  });

  test('polls getQueryResults until the job completes', async () => {
    const querySpy =
        spyOn(bq.BigQueryClient.prototype, 'query')
            .mockImplementation(
                async () => ({
                  status: 200,
                  result: {jobComplete: false, jobReference: {jobId: 'job-1'}},
                }));
    const pollSpy =
        spyOn(bq.BigQueryClient.prototype, 'getQueryResults')
            .mockImplementation(
                async () => ({status: 200, result: {jobComplete: true}}));
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await deployBigQuery([{name: 'sales', text: OSSIE}], CTX, {});
      expect(res.success).toBe(true);
      expect(pollSpy).toHaveBeenCalledTimes(1);
      // getQueryResults(project, jobId, location) -- jobId is the second arg.
      expect(pollSpy.mock.calls[0][1]).toBe('job-1');
    } finally {
      logSpy.mockRestore();
      pollSpy.mockRestore();
      querySpy.mockRestore();
    }
  });

  test('fails when the completed job reports errors', async () => {
    const querySpy =
        spyOn(bq.BigQueryClient.prototype, 'query')
            .mockImplementation(async () => ({
                                  status: 200,
                                  result: {
                                    jobComplete: true,
                                    errors: [{message: 'graph already exists'}],
                                  },
                                }));
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await deployBigQuery([{name: 'sales', text: OSSIE}], CTX, {});
      expect(res.success).toBe(false);
      expect(res.details).toContain('graph already exists');
    } finally {
      logSpy.mockRestore();
      querySpy.mockRestore();
    }
  });

  test('fails when BigQuery rejects the DDL', async () => {
    const querySpy = spyOn(bq.BigQueryClient.prototype, 'query')
                         .mockImplementation(
                             async () => ({status: 400, message: 'bad DDL'}));
    const logSpy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      const res = await deployBigQuery([{name: 'sales', text: OSSIE}], CTX, {});
      expect(res.success).toBe(false);
      expect(res.details).toContain('bad DDL');
    } finally {
      logSpy.mockRestore();
      querySpy.mockRestore();
    }
  });

  test(
      'fails when a model declares no BigQuery deployment target', async () => {
        const res = await deployBigQuery(
            [{name: 'sales', text: OSSIE_NO_TARGET}], CTX,
            {validateOnly: true});
        expect(res.success).toBe(false);
        expect(res.details).toContain('no BigQuery Graph');
      });

  test('fails when there are no model documents', async () => {
    const res = await deployBigQuery([], CTX, {validateOnly: true});
    expect(res.success).toBe(false);
    expect(res.details).toContain('No semantic model documents');
  });
});
