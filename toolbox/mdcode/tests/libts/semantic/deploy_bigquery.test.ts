// Tests for the semantic-model BigQuery deploy leg
// (src/libts/semantic/deploy_bigquery.ts).
//
// `bigQueryGraphTargets` is exercised as a pure function; `deployBigQuery` is
// exercised end to end over an Ossie fixture (loader -> IR -> generator ->
// target), with the BigQuery client stubbed so no network call is made.

import {describe, expect, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as bq from '../../../src/libts/gcp/bigquery';
import {ApiContext} from '../../../src/libts/gcp/context';
import {bigQueryGraphTargets, deployBigQuery} from '../../../src/libts/semantic/deploy_bigquery';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {loadSemanticModels} from '../../../src/libts/semantic/loader';

const CTX = new ApiContext('test-project', 'us', 'test-token');

// The deploy leg now consumes models already parsed by loadSemanticModels
// (shared with the Knowledge Catalog leg). These tests still author documents,
// so this helper parses them the way commands.ts does. defaultProject mirrors
// the scope's declared project.
function models(docs: {name: string; text: string}[], defaultProject = 'test-project') {
  const r = loadSemanticModels(docs, {defaultProject});
  if (r.error) throw new Error(r.error);
  return r.models;
}

const FIXTURES = path.join(__dirname, 'fixtures');

const BQ_URI =
    '//bigquery.googleapis.com/projects/demo/datasets/sales/propertyGraphs/sales_graph';

// A loader-valid model that declares a GOOGLE BigQuery Graph deployment target
// (resolves to demo.sales.sales_graph), and the same model without one.
const OSSIE =
    fs.readFileSync(path.join(FIXTURES, 'sales_bq_graph_target.yaml'), 'utf8');
const OSSIE_NO_TARGET =
    fs.readFileSync(path.join(FIXTURES, 'sales_no_target.yaml'), 'utf8');
// An existing fixture whose only GOOGLE deployment target is a (non-BigQuery)
// Dataplex URI; exercises the deploy leg's unparseable-target path.
const OSSIE_DATAPLEX_ONLY =
    fs.readFileSync(path.join(FIXTURES, 'sales_google_ext.yaml'), 'utf8');
// A model whose only GOOGLE target carries the BigQuery prefix but fails the
// strict URI match; exercises the "declared but unparseable" report.
const OSSIE_BAD_TARGET =
    fs.readFileSync(path.join(FIXTURES, 'sales_bad_target.yaml'), 'utf8');
// A model whose dataset `source` omits its project, so the loader must qualify
// it with the caller-supplied defaultProject.
const OSSIE_UNQUALIFIED_SOURCE = fs.readFileSync(
    path.join(FIXTURES, 'sales_unqualified_source.yaml'), 'utf8');

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
    const {targets, malformed} = bigQueryGraphTargets(
        modelWithExtension(JSON.stringify({deploymentTargets: [BQ_URI]})));
    expect(targets).toEqual([
      {
        project: 'demo',
        dataset: 'sales',
        graphName: 'sales_graph',
        uri: BQ_URI
      },
    ]);
    expect(malformed).toEqual([]);
  });

  test('ignores non-GOOGLE vendor extensions', () => {
    const {targets} = bigQueryGraphTargets(modelWithExtension(
        JSON.stringify({deploymentTargets: [BQ_URI]}), 'DATABRICKS'));
    expect(targets).toEqual([]);
  });

  test('reports a non-BigQuery deployment target as malformed', () => {
    // We only support BigQuery Graph targets, so any other URI does not parse
    // as one and is collected as malformed (rejected), not silently ignored.
    const dataplexUri =
        'projects/demo/locations/us/entryGroups/@bigquery/entries/sales_graph';
    const {targets, malformed} = bigQueryGraphTargets(
        modelWithExtension(JSON.stringify({deploymentTargets: [dataplexUri]})));
    expect(targets).toEqual([]);
    expect(malformed).toEqual([dataplexUri]);
  });

  test('returns [] for a model with no custom extensions', () => {
    const {targets} = bigQueryGraphTargets(
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
    const {targets} = bigQueryGraphTargets(modelWithExtension(
        JSON.stringify({deploymentTargets: [BQ_URI, uri2]})));
    expect(targets.map(t => t.graphName)).toEqual(['sales_graph', 'g2']);
  });

  test('collects a prefix-matching URI that fails the strict match', () => {
    // A backtick/semicolon in the graph name would break out of the quoted
    // identifier in the generated DDL; the tightened capture groups reject it.
    // It carries the BigQuery prefix, so it is surfaced as malformed rather
    // than silently dropped.
    const evil =
        '//bigquery.googleapis.com/projects/demo/datasets/sales/propertyGraphs/g`;DROP';
    const {targets, malformed} = bigQueryGraphTargets(
        modelWithExtension(JSON.stringify({deploymentTargets: [evil]})));
    expect(targets).toEqual([]);
    expect(malformed).toEqual([evil]);
  });

  test('reports a host/scheme-typo target as malformed, not silently dropped', () => {
    // A truncated host (`.co` not `.com`) and an `https://` scheme both
    // fail the strict match; both are reported as malformed rather than
    // dropped and later misreported as "no target declared".
    const hostTypo =
        '//bigquery.googleapis.co/projects/demo/datasets/sales/propertyGraphs/g';
    const scheme =
        'https://bigquery.googleapis.com/projects/demo/datasets/sales/propertyGraphs/g';
    const {targets, malformed} = bigQueryGraphTargets(modelWithExtension(
        JSON.stringify({deploymentTargets: [hostTypo, scheme]})));
    expect(targets).toEqual([]);
    expect(malformed).toEqual([hostTypo, scheme]);
  });
});


describe('deployBigQuery', () => {
  // Every execution path resolves the dataset location before submitting the
  // query job. Stubbed so tests make no network call and the job location is
  // deterministic.
  function mockDataset() {
    return spyOn(bq.BigQueryClient.prototype, 'getDataset')
        .mockImplementation(
            async () => ({status: 200, result: {location: 'US'}} as any));
  }

  test('validateOnly returns the DDL without calling BigQuery', async () => {
    const querySpy = spyOn(bq.BigQueryClient.prototype, 'query');
    try {
      const res = await deployBigQuery(
          models([{name: 'sales', text: OSSIE}]), CTX, {validateOnly: true});
      expect(res.success).toBe(true);
      expect(res.deployed).toBe(0);
      expect(querySpy).not.toHaveBeenCalled();

      // The DDL is returned to the caller, not printed by the library.
      const ddl = res.ddl.join('\n');
      expect(ddl).toContain('CREATE OR REPLACE PROPERTY GRAPH');
      // The graph name is qualified from the deployment target, not gcloud
      // defaults.
      expect(ddl).toContain('`demo.sales.sales_graph`');
    } finally {
      querySpy.mockRestore();
    }
  });

  test('executes the DDL against the target project', async () => {
    const dsSpy = mockDataset();
    const querySpy =
        spyOn(bq.BigQueryClient.prototype, 'query')
            .mockImplementation(
                async () => ({status: 200, result: {jobComplete: true}}));
    try {
      const res = await deployBigQuery(models([{name: 'sales', text: OSSIE}]), CTX, {});
      expect(res.success).toBe(true);
      expect(res.deployed).toBe(1);
      expect(querySpy).toHaveBeenCalledTimes(1);

      // query(project, sql, location) -- the resolved dataset location is
      // threaded to the job.
      const [project, sql, location] = querySpy.mock.calls[0];
      expect(project).toBe('demo');
      expect(sql).toContain(
          'CREATE OR REPLACE PROPERTY GRAPH `demo.sales.sales_graph`');
      expect(location).toBe('US');
    } finally {
      dsSpy.mockRestore();
      querySpy.mockRestore();
    }
  });

  test('polls getQueryResults until the job completes', async () => {
    const dsSpy = mockDataset();
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
    try {
      const res = await deployBigQuery(models([{name: 'sales', text: OSSIE}]), CTX, {});
      expect(res.success).toBe(true);
      expect(pollSpy).toHaveBeenCalledTimes(1);
      // getQueryResults(project, jobId, location) -- jobId is the second arg.
      expect(pollSpy.mock.calls[0][1]).toBe('job-1');
    } finally {
      dsSpy.mockRestore();
      pollSpy.mockRestore();
      querySpy.mockRestore();
    }
  });

  test(
      'fails clearly when the job never completes and has no job reference',
      async () => {
        // jobComplete:false with no jobId cannot be polled; the error must say
        // so rather than claim it polled to exhaustion.
        const dsSpy = mockDataset();
        const querySpy =
            spyOn(bq.BigQueryClient.prototype, 'query')
                .mockImplementation(
                    async () => ({status: 200, result: {jobComplete: false}}));
        try {
          const res =
              await deployBigQuery(models([{name: 'sales', text: OSSIE}]), CTX, {});
          expect(res.success).toBe(false);
          expect(res.details).toContain('no job reference to poll');
        } finally {
          dsSpy.mockRestore();
          querySpy.mockRestore();
        }
      });

  test(
      'treats errors[] as warnings when the job has no errorResult',
      async () => {
        // A completed job whose errors[] holds only a warning must not fail the
        // deploy: the definitive fatal signal is status.errorResult.
        const dsSpy = mockDataset();
        const querySpy =
            spyOn(bq.BigQueryClient.prototype, 'query')
                .mockImplementation(async () => ({
                                      status: 200,
                                      result: {
                                        jobComplete: true,
                                        jobReference: {jobId: 'job-1'},
                                        errors: [{message: 'a warning'}],
                                      },
                                    }));
        const jobSpy =
            spyOn(bq.BigQueryClient.prototype, 'getJob')
                .mockImplementation(
                    async () => ({status: 200, result: {status: {}}}));
        try {
          const res =
              await deployBigQuery(models([{name: 'sales', text: OSSIE}]), CTX, {});
          expect(res.success).toBe(true);
          expect(jobSpy).toHaveBeenCalledTimes(1);
        } finally {
          dsSpy.mockRestore();
          jobSpy.mockRestore();
          querySpy.mockRestore();
        }
      });

  test('fails on the job errorResult', async () => {
    const dsSpy = mockDataset();
    const querySpy = spyOn(bq.BigQueryClient.prototype, 'query')
                         .mockImplementation(async () => ({
                                               status: 200,
                                               result: {
                                                 jobComplete: true,
                                                 jobReference: {jobId: 'job-1'},
                                                 errors: [{message: 'summary'}],
                                               },
                                             }));
    const jobSpy =
        spyOn(bq.BigQueryClient.prototype, 'getJob')
            .mockImplementation(
                async () => ({
                  status: 200,
                  result: {
                    status: {errorResult: {message: 'Not found: table'}},
                  },
                }));
    try {
      const res = await deployBigQuery(models([{name: 'sales', text: OSSIE}]), CTX, {});
      expect(res.success).toBe(false);
      expect(res.details).toContain('Not found: table');
    } finally {
      dsSpy.mockRestore();
      jobSpy.mockRestore();
      querySpy.mockRestore();
    }
  });

  test(
      'fails on errors[] when there is no job reference to disambiguate',
      async () => {
        const dsSpy = mockDataset();
        const querySpy =
            spyOn(bq.BigQueryClient.prototype, 'query')
                .mockImplementation(
                    async () => ({
                      status: 200,
                      result: {
                        jobComplete: true,
                        errors: [{message: 'graph already exists'}],
                      },
                    }));
        try {
          const res =
              await deployBigQuery(models([{name: 'sales', text: OSSIE}]), CTX, {});
          expect(res.success).toBe(false);
          expect(res.details).toContain('graph already exists');
        } finally {
          dsSpy.mockRestore();
          querySpy.mockRestore();
        }
      });

  test('fails when BigQuery rejects the DDL', async () => {
    const dsSpy = mockDataset();
    const querySpy = spyOn(bq.BigQueryClient.prototype, 'query')
                         .mockImplementation(
                             async () => ({status: 400, message: 'bad DDL'}));
    try {
      const res = await deployBigQuery(models([{name: 'sales', text: OSSIE}]), CTX, {});
      expect(res.success).toBe(false);
      expect(res.details).toContain('bad DDL');
    } finally {
      dsSpy.mockRestore();
      querySpy.mockRestore();
    }
  });

  test(
      'fails when the job never completes after the poll budget is exhausted',
      async () => {
        // A job that stays jobComplete:false must eventually be given up on.
        // Small bounds + zero backoff keep this instant (the real defaults
        // would burn ~29s of sleeps).
        const dsSpy = mockDataset();
        const stuck = {
          status: 200,
          result: {jobComplete: false, jobReference: {jobId: 'j'}},
        };
        const querySpy = spyOn(bq.BigQueryClient.prototype, 'query')
                             .mockImplementation(async () => stuck);
        const pollSpy = spyOn(bq.BigQueryClient.prototype, 'getQueryResults')
                            .mockImplementation(async () => stuck);
        try {
          const res = await deployBigQuery(
              models([{name: 'sales', text: OSSIE}]), CTX,
              {maxQueryPolls: 3, pollBackoffMs: 0});
          expect(res.success).toBe(false);
          expect(res.details).toContain('did not complete after 3 polls');
          expect(pollSpy).toHaveBeenCalledTimes(3);
        } finally {
          dsSpy.mockRestore();
          pollSpy.mockRestore();
          querySpy.mockRestore();
        }
      });

  test('fails fast when the target dataset does not exist', async () => {
    // A 404 on the location pre-flight is a precise error; the DDL job that
    // would otherwise fail with a murkier message is never submitted.
    const dsSpy = spyOn(bq.BigQueryClient.prototype, 'getDataset')
                      .mockImplementation(async () => ({status: 404} as any));
    const querySpy = spyOn(bq.BigQueryClient.prototype, 'query');
    try {
      const res = await deployBigQuery(models([{name: 'sales', text: OSSIE}]), CTX, {});
      expect(res.success).toBe(false);
      expect(res.details).toContain('demo.sales not found');
      expect(querySpy).not.toHaveBeenCalled();
    } finally {
      dsSpy.mockRestore();
      querySpy.mockRestore();
    }
  });

  test(
      'proceeds with inferred location when the dataset read is forbidden',
      async () => {
        // A 403 (caller lacks bigquery.datasets.get) is non-fatal: the deploy
        // proceeds and lets BigQuery infer the location (no location arg), but
        // records a warning so the degraded path is visible.
        const dsSpy =
            spyOn(bq.BigQueryClient.prototype, 'getDataset')
                .mockImplementation(async () => ({status: 403} as any));
        const querySpy =
            spyOn(bq.BigQueryClient.prototype, 'query')
                .mockImplementation(
                    async () => ({status: 200, result: {jobComplete: true}}));
        try {
          const res =
              await deployBigQuery(models([{name: 'sales', text: OSSIE}]), CTX, {});
          expect(res.success).toBe(true);
          expect(querySpy.mock.calls[0][2]).toBeUndefined();
          expect(res.warnings.some(
                     w => w.includes('could not read location of dataset')))
              .toBe(true);
        } finally {
          dsSpy.mockRestore();
          querySpy.mockRestore();
        }
      });

  test(
      'resolves the dataset location once across targets in one dataset',
      async () => {
        // Two documents deploying to demo.sales must trigger a single
        // datasets.get, not one per graph.
        const dsSpy = mockDataset();
        const querySpy =
            spyOn(bq.BigQueryClient.prototype, 'query')
                .mockImplementation(
                    async () => ({status: 200, result: {jobComplete: true}}));
        try {
          const res = await deployBigQuery(
              models([{name: 'a', text: OSSIE}, {name: 'b', text: OSSIE}]), CTX, {});
          expect(res.success).toBe(true);
          expect(res.deployed).toBe(2);
          expect(dsSpy).toHaveBeenCalledTimes(1);
        } finally {
          dsSpy.mockRestore();
          querySpy.mockRestore();
        }
      });

  test(
      'names an unparseable BigQuery target instead of reporting none',
      async () => {
        // A typo'd URI that carries the BigQuery prefix must be reported as
        // unparseable, not as "declares no deploymentTarget".
        const res = await deployBigQuery(
            models([{name: 'sales', text: OSSIE_BAD_TARGET}]), CTX,
            {validateOnly: true});
        expect(res.success).toBe(false);
        expect(res.details).toContain('could not be parsed');
        expect(res.details).toContain('propertyGraph/sales_graph');
        expect(res.details).not.toContain('declares no BigQuery Graph');
      });

  test(
      'reports already-deployed graphs when a later target fails', async () => {
        // Two documents, each a single-target model: the first deploys, the
        // second fails. The failure must surface that graph #1 already mutated
        // production.
        const dsSpy = mockDataset();
        let calls = 0;
        const querySpy = spyOn(bq.BigQueryClient.prototype, 'query')
                             .mockImplementation(async () => {
                               calls++;
                               return calls === 1 ?
                                   {status: 200, result: {jobComplete: true}} :
                                   {status: 400, message: 'boom'};
                             });
        try {
          const res = await deployBigQuery(
              models([{name: 'a', text: OSSIE}, {name: 'b', text: OSSIE}]), CTX, {});
          expect(res.success).toBe(false);
          expect(res.deployed).toBe(1);
          expect(res.details).toContain('boom');
          expect(res.details).toContain('already deployed in this run');
        } finally {
          dsSpy.mockRestore();
          querySpy.mockRestore();
        }
      });

  test(
      'fails when a model declares no BigQuery deployment target', async () => {
        const res = await deployBigQuery(
            models([{name: 'sales', text: OSSIE_NO_TARGET}]), CTX,
            {validateOnly: true});
        expect(res.success).toBe(false);
        expect(res.details).toContain('no BigQuery Graph');
      });

  test(
      'fails when the only deployment target is not a BigQuery Graph URI',
      async () => {
        // A non-BigQuery destination does not parse as a BigQuery Graph target,
        // so it is reported as unparseable rather than "none declared".
        const res = await deployBigQuery(
            models([{name: 'sales', text: OSSIE_DATAPLEX_ONLY}]), CTX,
            {validateOnly: true});
        expect(res.success).toBe(false);
        expect(res.details).toContain('could not be parsed');
      });

  test(
      'qualifies an under-qualified source with the given defaultProject',
      async () => {
        // The loader qualifies `sales.orders` with the passed defaultProject
        // ('scope-proj'), not the ambient ctx.project ('test-project'): the
        // scope's declared project is deterministic where gcloud's is not.
        const res = await deployBigQuery(
            models([{name: 'sales', text: OSSIE_UNQUALIFIED_SOURCE}], 'scope-proj'),
            CTX, {validateOnly: true});
        expect(res.success).toBe(true);
        const ddl = res.ddl.join('\n');
        expect(ddl).toContain('`scope-proj.sales.orders`');
        expect(ddl).not.toContain('test-project.sales.orders');
      });

  test('validateOnly over an empty workspace is a clean no-op', async () => {
    // validate-only mutates nothing, so no documents is success (exit 0) with a
    // warning, not an error.
    const res = await deployBigQuery([], CTX, {validateOnly: true});
    expect(res.success).toBe(true);
    expect(res.deployed).toBe(0);
    expect(res.warnings.some(w => w.includes('nothing to validate')))
        .toBe(true);
  });

  test('a real push with no model documents fails', async () => {
    // Outside validate-only, "nothing to deploy" is a configuration error worth
    // surfacing rather than silently succeeding.
    const res = await deployBigQuery([], CTX, {});
    expect(res.success).toBe(false);
    expect(res.details).toContain('No semantic model documents');
  });

  test('fails a 200 response that carries no body', async () => {
    // A 200 with no result body cannot confirm the DDL ran; it must fail rather
    // than fall through to success.
    const dsSpy = mockDataset();
    const querySpy =
        spyOn(bq.BigQueryClient.prototype, 'query')
            .mockImplementation(async () => ({status: 200} as any));
    try {
      const res = await deployBigQuery(models([{name: 'sales', text: OSSIE}]), CTX, {});
      expect(res.success).toBe(false);
      expect(res.details).toContain('no response body');
    } finally {
      dsSpy.mockRestore();
      querySpy.mockRestore();
    }
  });
});
