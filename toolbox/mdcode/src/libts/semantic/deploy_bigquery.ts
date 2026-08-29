// Deploys a semantic model's BigQuery Graph.
//
// This is the BigQuery leg of `kcmd push` for the semantic-model scope: it
// consumes models already parsed into the semantic IR (see loadSemanticModels,
// shared with the Knowledge Catalog leg so a `--target all` push parses each
// document once), lowers each to `CREATE OR REPLACE PROPERTY GRAPH` DDL
// (generator), and executes that DDL against the BigQuery project named by the
// model's GOOGLE deployment target.
//
// This is a library module: it emits no console output. The generated DDL and
// any loader/generator warnings are returned in `DeployResult` for the CLI
// (src/tool/commands.ts) to print.
//

import {ApiResult} from '../gcp/api';
import {BigQueryClient, QueryResponse} from '../gcp/bigquery';
import * as context from '../gcp/context';

import {generatePropertyGraph} from './bigquery';
// The GOOGLE deployment-target reader lives in its own module so both deploy
// legs (BigQuery, Spanner) and the push-time validator share one parse. The
// BigQuery-facing views are re-exported here so existing importers
// (validate.ts, knowledge_catalog.ts, and the deploy tests) keep their
// historical import path.
import {BigQueryGraphTarget, bigQueryGraphTargets, deploymentTargetUris, googleDeploymentTargets} from './deployment_target';
import {LoadedModel} from './loader';

export {bigQueryGraphTargets, deploymentTargetUris, googleDeploymentTargets};
export type {BigQueryGraphTarget};


export interface DeployOptions {
  validateOnly?: boolean;
  // Poll bounds for a slow query job, overridable so tests can exercise the
  // exhaustion path without burning wall-clock. Default to the module
  // constants.
  maxQueryPolls?: number;
  pollBackoffMs?: number;
}

export interface DeployResult {
  success: boolean;
  details?: string;
  // Generated DDL, one entry per target (each prefixed with a `-- <uri>`
  // comment), in deploy order. Populated even for validateOnly, where nothing
  // is executed, so the caller can print or inspect it.
  ddl: string[];
  // Loader and generator warnings collected across all documents.
  warnings: string[];
  // Number of graphs actually executed against BigQuery (0 for validateOnly).
  deployed: number;
}


// Upper bound on getQueryResults polls before we give up on a job that never
// reports completion (each poll long-polls the server for up to 10s).
const MAX_QUERY_POLLS = 30;

// Pause between polls. getQueryResults long-polls server-side, so this is a
// backstop for the case where it returns promptly (which would otherwise fire
// MAX_QUERY_POLLS requests back-to-back with no pause).
const POLL_BACKOFF_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// Waits for a jobs.query response to reach completion and reports any terminal
// error. jobs.query can return before a slow DDL statement finishes; in that
// case the response carries `jobComplete: false` and a job reference, and we
// poll getQueryResults until the job is done. Errors are only judged once the
// job has actually completed.
async function awaitQueryDone(
    bigQuery: BigQueryClient, project: string,
    started: ApiResult<QueryResponse>, maxPolls: number,
    backoffMs: number): Promise<{ok: boolean; error?: string}> {
  if (started.status !== 200) {
    return {ok: false, error: started.message || String(started.status)};
  }

  let result = started.result;
  // A 200 with no body is not a verified success: without jobComplete/errors we
  // cannot confirm the DDL ran, so treat the missing body as a failure rather
  // than falling through to the `{ok: true}` return below.
  if (!result) {
    return {
      ok: false,
      error:
          started.message || 'query returned status 200 with no response body',
    };
  }
  const jobId = result?.jobReference?.jobId;
  const location = result?.jobReference?.location;

  let polls = 0;
  while (result?.jobComplete === false && jobId && polls < maxPolls) {
    if (polls > 0) {
      await sleep(backoffMs);
    }
    polls++;
    const res = await bigQuery.getQueryResults(project, jobId, location);
    if (res.status !== 200) {
      return {ok: false, error: res.message || String(res.status)};
    }
    result = res.result;
  }

  if (result?.jobComplete === false) {
    // Distinguish "polled to exhaustion" from "never had a job to poll": with
    // no jobId the loop above ran zero times, so a "did not complete after N
    // polls" message would be misleading.
    return {
      ok: false,
      error: jobId ?
          `job ${jobId} did not complete after ${maxPolls} polls` :
          'query did not complete and returned no job reference to poll',
    };
  }

  // errors[] mixes fatal errors and non-fatal warnings. When it is populated,
  // consult the job's status.errorResult -- the definitive fatal signal -- so a
  // deploy that only produced warnings is not reported as a failure.
  const errors = result?.errors;
  if (errors && errors.length) {
    if (jobId) {
      const job = await bigQuery.getJob(project, jobId, location);
      if (job.status !== 200) {
        return {ok: false, error: job.message || String(job.status)};
      }
      const fatal = job.result?.status?.errorResult;
      return fatal ? {ok: false, error: fatal.message} : {ok: true};
    }
    // No job reference to disambiguate; treat the errors as fatal.
    return {ok: false, error: errors.map(e => e.message).join('; ')};
  }

  return {ok: true};
}


// Looks up a dataset's BigQuery location so the query job, its result polls,
// and the job lookup all agree on a region. jobs.query would otherwise infer
// the location from the referenced tables, which can pick the wrong region for
// a non-US dataset.
//
// A 404 is a precise, free pre-flight: a typo'd dataset in the deployment
// target would otherwise surface later as a murkier DDL error, so we fail fast
// on it. Other failures (e.g. a 403 when the caller lacks
// bigquery.datasets.get) are non-fatal: fall back to letting BigQuery infer the
// location, but record a warning so the degraded path is visible -- otherwise a
// silent fallback can route a non-US CREATE to the wrong region and fail later
// with an opaque location error.
async function datasetLocation(
    bigQuery: BigQueryClient, target: BigQueryGraphTarget,
    warnings: string[]): Promise<string|undefined> {
  const res = await bigQuery.getDataset(target.project, target.dataset);
  if (res.status === 200) {
    return res.result?.location;
  }
  if (res.status === 404) {
    throw new Error(`dataset ${target.project}.${target.dataset} not found`);
  }
  warnings.push(
      `could not read location of dataset ${target.project}.${
          target.dataset} (${res.message || res.status}); ` +
      `letting BigQuery infer the query location`);
  return undefined;
}


// Deploys the BigQuery Graph for each pre-loaded model. Emits no console
// output; the generated DDL and any warnings are returned for the caller to
// print. The models are parsed once by the caller (loadSemanticModels) and
// shared with the Knowledge Catalog leg; each carries its originating document
// name for diagnostics.
export async function deployBigQuery(
    models: LoadedModel[], ctx: context.ApiContext,
    options: DeployOptions = {}): Promise<DeployResult> {
  const bigQuery = new BigQueryClient(ctx);
  const ddl: string[] = [];
  const warnings: string[] = [];
  let deployed = 0;
  let modelsSeen = 0;

  const fail = (details: string): DeployResult =>
      ({success: false, details, ddl, warnings, deployed});

  const maxPolls = options.maxQueryPolls ?? MAX_QUERY_POLLS;
  const backoffMs = options.pollBackoffMs ?? POLL_BACKOFF_MS;

  // A model can declare several graphs in one dataset; cache the location so we
  // issue one datasets.get per dataset rather than one per target.
  const locationCache = new Map<string, string|undefined>();
  const locationFor =
      async(target: BigQueryGraphTarget): Promise<string|undefined> => {
    const key = `${target.project}/${target.dataset}`;
    if (locationCache.has(key)) {
      return locationCache.get(key);
    }
    const loc = await datasetLocation(bigQuery, target, warnings);
    locationCache.set(key, loc);
    return loc;
  };

  for (const {document, model} of models) {
    modelsSeen++;
    let targets: BigQueryGraphTarget[];
    let malformed: string[];
    try {
      ({targets, malformed} = bigQueryGraphTargets(model));
    } catch (err: any) {
      return fail(`Model '${model.name}' (${document}): ${err.message || err}`);
    }
    if (!targets.length) {
      // A malformed-but-present target must not be reported as "none
      // declared" -- that sends the author hunting for an extension they
      // already wrote. Name the URIs that failed to parse.
      if (malformed.length) {
        return fail(
            `Model '${model.name}' (${document}) declares BigQuery Graph ` +
            `deploymentTarget(s) that could not be parsed: ` +
            `${malformed.join(', ')}. Expected //bigquery.googleapis.com/` +
            `projects/<p>/datasets/<d>/propertyGraphs/<g>.`);
      }
      return fail(
          `Model '${model.name}' (${document}) declares no BigQuery Graph ` +
          `deploymentTarget in a GOOGLE custom_extension; nothing to deploy.`);
    }
    // Malformed targets alongside valid ones: surface them so a typo'd URI is
    // not silently dropped when the deploy otherwise succeeds.
    for (const bad of malformed) {
      warnings.push(
          `[${model.name}] ignoring unparseable BigQuery Graph target: ${bad}`);
    }

    for (const target of targets) {
      const gen = generatePropertyGraph(model, {
        project: target.project,
        dataset: target.dataset,
        graphName: target.graphName,
      });
      for (const w of gen.warnings) {
        warnings.push(`[${model.name} -> ${target.graphName}] ${w}`);
      }
      ddl.push(`-- ${target.uri}\n${gen.ddl}`);

      if (options.validateOnly) {
        continue;
      }

      let location: string|undefined;
      try {
        location = await locationFor(target);
      } catch (err: any) {
        return fail(
            `Failed to deploy '${target.graphName}': ${err.message || err}`);
      }
      const started = await bigQuery.query(target.project, gen.ddl, location);
      const outcome = await awaitQueryDone(
          bigQuery, target.project, started, maxPolls, backoffMs);
      if (!outcome.ok) {
        // These are CREATE OR REPLACE statements executed one at a time, so
        // any graphs already deployed in this run have mutated production and
        // are not rolled back. Surface that alongside the failing target.
        const partial = deployed ?
            ` (${deployed} graph(s) already deployed in this run; ` +
                `CREATE OR REPLACE changes are not rolled back)` :
            '';
        return fail(`Failed to deploy '${target.graphName}': ${outcome.error}${
            partial}`);
      }

      deployed++;
    }
  }

  // A parsed document always yields at least one model (the loader enforces
  // `semantic_model` min 1), so modelsSeen is 0 only when no documents were
  // found at all. validateOnly mutates nothing, so an empty workspace is a
  // clean no-op there (exit 0); a real push treats "nothing to deploy" as a
  // configuration error worth flagging.
  if (!modelsSeen) {
    if (options.validateOnly) {
      warnings.push('No semantic model documents found; nothing to validate.');
      return {success: true, ddl, warnings, deployed};
    }
    return fail('No semantic model documents found; nothing to deploy.');
  }

  return {success: true, ddl, warnings, deployed};
}
