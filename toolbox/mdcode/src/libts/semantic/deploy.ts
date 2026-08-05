// Deploys a semantic model's BigQuery Graph.
//
// This is the BigQuery leg of `kcmd push` for the semantic-model scope: it
// parses each authored Ossie document into the semantic IR (loader), lowers it
// to `CREATE OR REPLACE PROPERTY GRAPH` DDL (generator), and executes that DDL
// against the BigQuery project named by the model's GOOGLE deployment target.
//
// The Knowledge Catalog resource emit (entries + entryLinks) for the semantic
// model is a follow-on; `push` currently deploys only the BigQuery Graph.
//

import {ApiResult} from '../gcp/api';
import {BigQueryClient, QueryResponse} from '../gcp/bigquery';
import * as context from '../gcp/context';

import {generatePropertyGraph} from './bigquery';
import {SemanticModel} from './ir';
import {loadModels} from './loader';


// Our own vendor tag in the Ossie `custom_extensions` list.
const GOOGLE_VENDOR = 'GOOGLE';

// A BigQuery Graph deployment target, e.g.
// //bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>
const BQ_GRAPH_TARGET =
    /^\/\/bigquery\.googleapis\.com\/projects\/([^/]+)\/datasets\/([^/]+)\/propertyGraphs\/([^/]+)$/;


export interface BigQueryGraphTarget {
  project: string;
  dataset: string;
  graphName: string;
  uri: string;
}

export interface DeployOptions {
  force?: boolean;
  validateOnly?: boolean;
}

export interface DeployResult {
  success: boolean;
  details?: string;
}


// Extracts the BigQuery Graph deployment targets from a model's GOOGLE
// custom extension. The extension `data` is an opaque, vendor-serialized JSON
// string (the loader keeps it verbatim); we own its `deploymentTargets` shape.
export function bigQueryGraphTargets(model: SemanticModel):
    BigQueryGraphTarget[] {
  const targets: BigQueryGraphTarget[] = [];

  for (const ext of model.customExtensions ?? []) {
    if (ext.vendorName !== GOOGLE_VENDOR) {
      continue;
    }

    let data: any;
    try {
      data = JSON.parse(ext.data);
    } catch {
      throw new Error(`Model '${
          model.name}': GOOGLE custom_extension 'data' is not valid JSON.`);
    }

    const uris = data?.deploymentTargets;
    if (!Array.isArray(uris)) {
      continue;
    }

    for (const uri of uris) {
      const m = typeof uri === 'string' ? uri.match(BQ_GRAPH_TARGET) : null;
      if (m) {
        targets.push({project: m[1], dataset: m[2], graphName: m[3], uri});
      }
    }
  }

  return targets;
}


// Upper bound on getQueryResults polls before we give up on a job that never
// reports completion (each poll long-polls the server for up to 10s).
const MAX_QUERY_POLLS = 30;


// Waits for a jobs.query response to reach completion and reports any terminal
// error. jobs.query can return before a slow DDL statement finishes; in that
// case the response carries `jobComplete: false` and a job reference, and we
// poll getQueryResults until the job is done. Errors are only judged once the
// job has actually completed.
async function awaitQueryDone(
    bigQuery: BigQueryClient, project: string,
    started: ApiResult<QueryResponse>): Promise<{ok: boolean; error?: string}> {
  if (started.status !== 200) {
    return {ok: false, error: started.message || String(started.status)};
  }

  let result = started.result;
  const jobId = result?.jobReference?.jobId;
  const location = result?.jobReference?.location;

  let polls = 0;
  while (result?.jobComplete === false && jobId && polls < MAX_QUERY_POLLS) {
    polls++;
    const res = await bigQuery.getQueryResults(project, jobId, location);
    if (res.status !== 200) {
      return {ok: false, error: res.message || String(res.status)};
    }
    result = res.result;
  }

  if (result?.jobComplete === false) {
    return {
      ok: false,
      error: `job ${jobId ?? '(unknown)'} did not complete after ${
          MAX_QUERY_POLLS} polls`,
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


// Deploys the BigQuery Graph for each authored model document.
export async function deployBigQuery(
    docs: {name: string; text: string}[], ctx: context.ApiContext,
    options: DeployOptions = {}): Promise<DeployResult> {
  const bigQuery = new BigQueryClient(ctx);
  let deployed = 0;
  let modelsSeen = 0;

  for (const doc of docs) {
    const {models, warnings} =
        loadModels(doc.text, {defaultProject: ctx.project});
    for (const w of warnings) {
      console.warn(`Warning [${doc.name}]: ${w}`);
    }

    for (const model of models) {
      modelsSeen++;
      let targets: BigQueryGraphTarget[];
      try {
        targets = bigQueryGraphTargets(model);
      } catch (err: any) {
        return {
          success: false,
          details: `Model '${model.name}' (${doc.name}): ${err.message || err}`,
        };
      }
      if (!targets.length) {
        return {
          success: false,
          details: `Model '${model.name}' (${
                       doc.name}) declares no BigQuery Graph ` +
              `deploymentTarget in a GOOGLE custom_extension; nothing to deploy.`,
        };
      }

      for (const target of targets) {
        const gen = generatePropertyGraph(model, {
          project: target.project,
          dataset: target.dataset,
          graphName: target.graphName,
        });
        for (const w of gen.warnings) {
          console.warn(`Warning [${model.name} -> ${target.graphName}]: ${w}`);
        }

        if (options.validateOnly) {
          console.log(`-- ${target.uri}\n${gen.ddl}\n`);
          continue;
        }

        console.log(`Deploying BigQuery Graph ${target.project}.${
            target.dataset}.${target.graphName} ...`);
        const started = await bigQuery.query(target.project, gen.ddl);
        const outcome = await awaitQueryDone(bigQuery, target.project, started);
        if (!outcome.ok) {
          return {
            success: false,
            details: `Failed to deploy '${target.graphName}': ${outcome.error}`,
          };
        }

        deployed++;
      }
    }
  }

  if (!modelsSeen) {
    return {
      success: false,
      details: docs.length ?
          'No semantic models were parsed from the authored document(s); nothing to deploy.' :
          'No semantic model documents found under catalog/EntryGroups/*/; nothing to deploy.',
    };
  }

  if (options.validateOnly) {
    console.log('Validation complete; no changes applied.');
  } else {
    console.log(
        `Deployed ${deployed} BigQuery Graph(s). ` +
        `Knowledge Catalog resource emit for the semantic model is not yet implemented.`);
  }

  return {success: true};
}
