// Tests for the semantic-model BigQuery deploy leg
// (src/libts/semantic/deploy.ts).
//
// `bigQueryGraphTargets` is exercised as a pure function; `deployBigQuery` is
// exercised end to end over an inline Ossie document (loader -> IR -> generator
// -> target), with the BigQuery client stubbed so no network call is made.

import {describe, expect, spyOn, test} from 'bun:test';

import * as bq from '../../../src/libts/gcp/bigquery';
import {ApiContext} from '../../../src/libts/gcp/context';
import {bigQueryGraphTargets, deployBigQuery} from '../../../src/libts/semantic/deploy';
import {SemanticModel} from '../../../src/libts/semantic/ir';

const CTX = new ApiContext('test-project', 'us', 'test-token');

const BQ_URI =
    '//bigquery.googleapis.com/projects/demo/datasets/sales/propertyGraphs/sales_graph';

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

// A minimal, loader-valid Ossie document that declares a GOOGLE BigQuery
// Graph deployment target.
const OSSIE = `
version: "0.2.0.dev0"
semantic_model:
  - name: sales
    custom_extensions:
      - vendor_name: GOOGLE
        data: '{"deploymentTargets": ["${BQ_URI}"]}'
    datasets:
      - name: orders
        source: demo.sales.orders
        primary_key: [o_orderkey]
        fields:
          - name: o_orderkey
            expression:
              dialects:
                - dialect: ANSI_SQL
                  expression: o_orderkey
          - name: o_totalprice
            expression:
              dialects:
                - dialect: ANSI_SQL
                  expression: o_totalprice
    metrics:
      - name: total_revenue
        expression:
          dialects:
            - dialect: ANSI_SQL
              expression: SUM(orders.o_totalprice)
`;

// The same document without any deployment target.
const OSSIE_NO_TARGET = `
version: "0.2.0.dev0"
semantic_model:
  - name: sales
    datasets:
      - name: orders
        source: demo.sales.orders
        primary_key: [o_orderkey]
        fields:
          - name: o_orderkey
            expression:
              dialects:
                - dialect: ANSI_SQL
                  expression: o_orderkey
`;


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
            .mockImplementation(async () => ({status: 200, result: {}}));
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
});
