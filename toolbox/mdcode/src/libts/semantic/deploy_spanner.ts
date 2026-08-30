// Deploys a semantic model's Spanner Graph.
//
// This is the Spanner leg of `kcmd push` for the semantic-model scope, a
// sibling to deploy_bigquery: it consumes models already parsed into the
// semantic IR (see loadSemanticModels, shared across legs so a `--target all`
// push parses each document once), lowers each to `CREATE OR REPLACE PROPERTY
// GRAPH` DDL (generator: ./spanner), and applies that DDL to the Spanner
// database named by the model's GOOGLE deployment target.
//
// Spanner DDL is asynchronous: updateDatabaseDdl returns a long-running
// operation which this leg polls to completion, unlike the BigQuery leg's
// jobs.query.
//
// This is a library module: it emits no console output. The generated DDL and
// any loader/generator warnings are returned in `DeployResult` for the CLI
// (src/tool/commands.ts) to print.
//

import * as context from '../gcp/context';
import {Operation, SpannerClient} from '../gcp/spanner';

import {SpannerGraphTarget, spannerGraphTargets} from './deployment_target';
import {LoadedModel} from './loader';
import {generateSpannerPropertyGraph} from './spanner';


export interface DeployOptions {
  validateOnly?: boolean;
  // Poll bounds for a slow DDL operation, overridable so tests can exercise the
  // exhaustion path without burning wall-clock. Default to the module
  // constants.
  maxOperationPolls?: number;
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
  // Number of graphs actually applied to Spanner (0 for validateOnly).
  deployed: number;
}


// Upper bound on getOperation polls before we give up on an operation that
// never reports completion.
const MAX_OPERATION_POLLS = 60;

// Pause between polls of a running operation.
const POLL_BACKOFF_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}


// Waits for an updateDatabaseDdl long-running operation to complete and reports
// any terminal error. The initial POST returns an Operation (usually not yet
// `done`); we poll getOperation on its `name` until it is, then judge success
// by its `error` field.
async function awaitOperationDone(
    spanner: SpannerClient,
    started: {status: number; message?: string; result?: Operation},
    maxPolls: number,
    backoffMs: number): Promise<{ok: boolean; error?: string}> {
  if (started.status !== 200) {
    return {ok: false, error: started.message || String(started.status)};
  }
  let op = started.result;
  if (!op) {
    return {
      ok: false,
      error: started.message ||
          'updateDatabaseDdl returned status 200 with no operation body',
    };
  }
  const opName = op.name;

  let polls = 0;
  while (!op?.done && opName && polls < maxPolls) {
    if (polls > 0) {
      await sleep(backoffMs);
    }
    polls++;
    const res = await spanner.getOperation(opName);
    if (res.status !== 200) {
      return {ok: false, error: res.message || String(res.status)};
    }
    op = res.result;
  }

  if (!op?.done) {
    return {
      ok: false,
      error: opName ?
          `operation ${opName} did not complete after ${maxPolls} polls` :
          'updateDatabaseDdl returned no operation name to poll',
    };
  }
  if (op.error) {
    return {ok: false, error: op.error.message || `code ${op.error.code}`};
  }
  return {ok: true};
}


// Deploys the Spanner Graph for each pre-loaded model. Emits no console output;
// the generated DDL and any warnings are returned for the caller to print. The
// models are parsed once by the caller (loadSemanticModels) and shared with the
// other legs; each carries its originating document name for diagnostics.
export async function deploySpanner(
    models: LoadedModel[], ctx: context.ApiContext,
    options: DeployOptions = {}): Promise<DeployResult> {
  const spanner = new SpannerClient(ctx);
  const ddl: string[] = [];
  const warnings: string[] = [];
  let deployed = 0;
  let modelsSeen = 0;

  const fail = (details: string): DeployResult =>
      ({success: false, details, ddl, warnings, deployed});

  const maxPolls = options.maxOperationPolls ?? MAX_OPERATION_POLLS;
  const backoffMs = options.pollBackoffMs ?? POLL_BACKOFF_MS;

  for (const {document, model} of models) {
    modelsSeen++;
    let targets: SpannerGraphTarget[];
    let malformed: string[];
    try {
      ({targets, malformed} = spannerGraphTargets(model));
    } catch (err: any) {
      return fail(`Model '${model.name}' (${document}): ${err.message || err}`);
    }
    if (!targets.length) {
      // A malformed-but-present target must not be reported as "none declared".
      if (malformed.length) {
        return fail(
            `Model '${model.name}' (${document}) declares Spanner Graph ` +
            `deploymentTarget(s) that could not be parsed: ` +
            `${malformed.join(', ')}. Expected //spanner.googleapis.com/` +
            `projects/<p>/instances/<i>/databases/<db>/propertyGraphs/<g>.`);
      }
      return fail(
          `Model '${model.name}' (${document}) declares no Spanner Graph ` +
          `deploymentTarget in a GOOGLE custom_extension; nothing to deploy.`);
    }
    for (const bad of malformed) {
      warnings.push(
          `[${model.name}] ignoring unparseable Spanner Graph target: ${bad}`);
    }

    for (const target of targets) {
      const gen = generateSpannerPropertyGraph(model, {
        graphName: target.graphName,
      });
      for (const w of gen.warnings) {
        warnings.push(`[${model.name} -> ${target.graphName}] ${w}`);
      }
      ddl.push(`-- ${target.uri}\n${gen.ddl}`);

      if (options.validateOnly) {
        continue;
      }

      // updateDatabaseDdl takes each statement WITHOUT a trailing semicolon:
      // Spanner's DDL parser rejects one ("Expecting 'EOF' but found ';'" --
      // verified live), unlike BigQuery's jobs.query, which accepts it. The
      // generator terminates its DDL with `;` for the printed/golden artifact,
      // so strip it here for the wire statement only.
      const statement = gen.ddl.replace(/;\s*$/, '');
      const started = await spanner.updateDatabaseDdl(
          target.project, target.instance, target.database, [statement]);
      const outcome =
          await awaitOperationDone(spanner, started, maxPolls, backoffMs);
      if (!outcome.ok) {
        // CREATE OR REPLACE statements are applied one graph at a time, so any
        // graphs already deployed in this run have mutated the database and are
        // not rolled back. Surface that alongside the failing target.
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

  if (!modelsSeen) {
    if (options.validateOnly) {
      warnings.push('No semantic model documents found; nothing to validate.');
      return {success: true, ddl, warnings, deployed};
    }
    return fail('No semantic model documents found; nothing to deploy.');
  }

  return {success: true, ddl, warnings, deployed};
}
