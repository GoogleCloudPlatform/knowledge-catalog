// Reads a model's GOOGLE deployment-target extension and classifies each
// declared target URI.
//
// A semantic model names where its graph deploys with `deploymentTargets` in a
// GOOGLE `custom_extensions` block (the loader folds a model-level
// `deployment_target:` key into the same block). Two destination types are
// recognized here, each an AIP-122 resource name:
//
//   BigQuery Graph:
//     //bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>
//   Spanner Graph:
//     //spanner.googleapis.com/projects/<p>/instances/<i>/databases/<db>/propertyGraphs/<g>
//
// The deploy legs (deploy_bigquery, deploy_spanner) and the push-time validator
// all derive their targets from this one reader, so a `--target all` push
// parses each model's extension once rather than once per reader.
//
// The capture groups are restricted to valid identifier characters: the
// components are interpolated into DDL unescaped (see the generators), so a
// permissive `[^/]+` would let backticks or semicolons through. A URI that
// matches neither destination type is collected as `malformed` (rejected by the
// validator and named in errors) rather than silently skipped.

import {SemanticModel} from './ir';


// Our own vendor tag in the Ossie `custom_extensions` list.
const GOOGLE_VENDOR = 'GOOGLE';

// A BigQuery Graph deployment target.
const BQ_GRAPH_TARGET =
    /^\/\/bigquery\.googleapis\.com\/projects\/([A-Za-z0-9_-]+)\/datasets\/([A-Za-z0-9_-]+)\/propertyGraphs\/([A-Za-z0-9_-]+)$/;

// A Spanner Graph deployment target. Instance and database ids follow Spanner's
// resource-id grammar (lowercase letters, digits, hyphens); the graph name is a
// GoogleSQL identifier. As with BigQuery, the segments are interpolated into
// DDL (the graph name) and into the Spanner Admin API path (project/instance/
// database), so the character classes stay strict.
const SPANNER_GRAPH_TARGET =
    /^\/\/spanner\.googleapis\.com\/projects\/([A-Za-z0-9_-]+)\/instances\/([A-Za-z0-9_-]+)\/databases\/([A-Za-z0-9_-]+)\/propertyGraphs\/([A-Za-z0-9_-]+)$/;


export interface BigQueryGraphTarget {
  project: string;
  dataset: string;
  graphName: string;
  uri: string;
}

export interface SpannerGraphTarget {
  project: string;
  instance: string;
  database: string;
  graphName: string;
  uri: string;
}

export interface GoogleDeploymentTargets {
  // Every declared deploymentTarget URI, in declaration order.
  uris: string[];
  // The subset that parse as BigQuery Graph targets.
  bigQuery: BigQueryGraphTarget[];
  // The subset that parse as Spanner Graph targets.
  spanner: SpannerGraphTarget[];
  // URIs that parse as NEITHER a BigQuery nor a Spanner Graph target (a
  // host/scheme/segment/identifier typo, or an unsupported destination). Kept
  // so a caller can name the typo instead of silently dropping it.
  malformed: string[];
}


// Reads a model's GOOGLE custom_extension(s) in a single pass and returns the
// deployment-target facts every caller derives from them. The extension `data`
// is an opaque, vendor-serialized JSON string (the loader keeps it verbatim);
// we own its `deploymentTargets` shape. Throws on malformed extension JSON.
export function googleDeploymentTargets(model: SemanticModel):
    GoogleDeploymentTargets {
  const uris: string[] = [];
  const bigQuery: BigQueryGraphTarget[] = [];
  const spanner: SpannerGraphTarget[] = [];
  const malformed: string[] = [];

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

    const list = data?.deploymentTargets;
    if (!Array.isArray(list)) {
      continue;
    }

    for (const uri of list) {
      if (typeof uri !== 'string') {
        continue;
      }
      uris.push(uri);
      const bq = uri.match(BQ_GRAPH_TARGET);
      if (bq) {
        bigQuery.push({project: bq[1], dataset: bq[2], graphName: bq[3], uri});
        continue;
      }
      const sp = uri.match(SPANNER_GRAPH_TARGET);
      if (sp) {
        spanner.push({
          project: sp[1],
          instance: sp[2],
          database: sp[3],
          graphName: sp[4],
          uri,
        });
        continue;
      }
      // Matches no supported destination type: collect it as malformed
      // (rejected by the validator) rather than silently ignoring it.
      malformed.push(uri);
    }
  }

  return {uris, bigQuery, spanner, malformed};
}


// The BigQuery Graph deployment targets a model declares, plus any URIs that
// parse as no supported destination type. A view over googleDeploymentTargets,
// preserving the historical shape the BigQuery leg and Knowledge Catalog leg
// consume. Note `malformed` excludes a valid Spanner Graph target: a Spanner
// URI is a recognized destination, just not a BigQuery one, so it is not
// reported as a BigQuery typo.
export function bigQueryGraphTargets(model: SemanticModel):
    {targets: BigQueryGraphTarget[]; malformed: string[]} {
  const {bigQuery, malformed} = googleDeploymentTargets(model);
  return {targets: bigQuery, malformed};
}


// The Spanner Graph deployment targets a model declares, plus any URIs that
// parse as no supported destination type. Symmetric to bigQueryGraphTargets.
export function spannerGraphTargets(model: SemanticModel):
    {targets: SpannerGraphTarget[]; malformed: string[]} {
  const {spanner, malformed} = googleDeploymentTargets(model);
  return {targets: spanner, malformed};
}


// Every deploymentTarget URI a model declares, regardless of whether each
// parses as a supported target. Validation uses this to require that a model
// declares exactly one deployment target. Throws on malformed extension JSON.
export function deploymentTargetUris(model: SemanticModel): string[] {
  return googleDeploymentTargets(model).uris;
}
