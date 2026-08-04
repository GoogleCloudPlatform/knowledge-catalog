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

import {BigQueryClient} from '../gcp/bigquery';
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


// Deploys the BigQuery Graph for each authored model document.
export async function deployBigQuery(
    docs: {name: string; text: string}[], ctx: context.ApiContext,
    options: DeployOptions = {}): Promise<DeployResult> {
  const bigQuery = new BigQueryClient(ctx);
  let deployed = 0;

  for (const doc of docs) {
    const {models, warnings} =
        loadModels(doc.text, {defaultProject: ctx.project});
    for (const w of warnings) {
      console.warn(`Warning [${doc.name}]: ${w}`);
    }

    for (const model of models) {
      const targets = bigQueryGraphTargets(model);
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
        const res = await bigQuery.query(target.project, gen.ddl);
        if (res.status !== 200) {
          return {
            success: false,
            details: `Failed to deploy '${target.graphName}': ${
                res.message || res.status}`,
          };
        }

        const errors = res.result?.errors;
        if (errors && errors.length) {
          return {
            success: false,
            details: `Failed to deploy '${target.graphName}': ` +
                errors.map(e => e.message).join('; '),
          };
        }

        deployed++;
      }
    }
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
