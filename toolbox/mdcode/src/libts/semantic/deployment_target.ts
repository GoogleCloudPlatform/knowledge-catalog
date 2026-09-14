// Reads a model's GOOGLE deployment-target extension and classifies each
// declared target URI.
//
// A semantic model names where it deploys with `deploymentTargets` in a GOOGLE
// `custom_extensions` block (the loader folds a model-level
// `deployment_target:` key into the same block). Three destination types are
// recognized here, each an AIP-122 resource name:
//
//   BigQuery Graph:
//     //bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>
//   Spanner Graph:
//     //spanner.googleapis.com/projects/<p>/instances/<i>/databases/<db>/propertyGraphs/<g>
//   AlloyDB database:
//     //alloydb.googleapis.com/projects/<p>/locations/<l>/clusters/<c>/instances/<i>/databases/<db>
//
// The first two name a GRAPH; the third names a DATABASE, and the difference is
// not an oversight. AlloyDB has no property-graph DDL, so there is no graph to
// address and a URI pretending otherwise would name something that cannot be
// created. What an AlloyDB target says is where the model's rows live -- which
// is the whole of what a runtime needs in order to read an entity and carry out
// an action. A model bound to it deploys to Knowledge Catalog and runs; it does
// not deploy a graph, and `validatePushRequirements` says so in those words
// rather than reporting the URI as a typo.
//
// The deploy legs (deploy_bigquery, deploy_spanner) and the push-time validator
// all derive their targets from this one reader, so a multi-destination push
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

// An AlloyDB database. The segments are an AlloyDB instance resource name --
// AlloyDB locates an instance by cluster and region rather than by instance id
// alone, which is why there is a `locations` segment here and none in the
// Spanner target -- followed by the PostgreSQL database inside it. A database
// name is a PostgreSQL identifier, and the strict class serves the same purpose
// as it does above: the name is interpolated into a connection string and into
// generated SQL, so a permissive class would let a quote character through.
const ALLOYDB_TARGET =
    /^\/\/alloydb\.googleapis\.com\/projects\/([A-Za-z0-9_-]+)\/locations\/([A-Za-z0-9_-]+)\/clusters\/([A-Za-z0-9_-]+)\/instances\/([A-Za-z0-9_-]+)\/databases\/([A-Za-z0-9_-]+)$/;


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

export interface AlloyDbTarget {
  project: string;
  location: string;
  cluster: string;
  instance: string;
  database: string;
  uri: string;
}

export interface GoogleDeploymentTargets {
  // Every declared deploymentTarget URI, in declaration order.
  uris: string[];
  // The subset that parse as BigQuery Graph targets.
  bigQuery: BigQueryGraphTarget[];
  // The subset that parse as Spanner Graph targets.
  spanner: SpannerGraphTarget[];
  // The subset that parse as AlloyDB database targets. Not a graph: see the
  // file header for why this one names a database.
  alloyDb: AlloyDbTarget[];
  // URIs that parse as NONE of the supported destinations (a host/scheme/
  // segment/identifier typo, or an unsupported destination). Kept so a caller
  // can name the typo instead of silently dropping it.
  malformed: string[];
}


// Memoizes the parse per model object so the several callers within one push
// (validation, source-project lookup, per-leg routing, each deploy leg) share a
// single parse rather than re-running JSON.parse + the regexes once per reader.
// Keyed by model identity: the IR object is stable through a push (the loader,
// transpile, and inheritance passes each hand on a fixed set of objects) and
// its customExtensions are not mutated after loading. The returned value is
// read-only by convention -- no caller mutates its arrays.
const targetsCache = new WeakMap<SemanticModel, GoogleDeploymentTargets>();

// Reads a model's GOOGLE custom_extension(s) in a single pass and returns the
// deployment-target facts every caller derives from them. The extension `data`
// is an opaque, vendor-serialized JSON string (the loader keeps it verbatim);
// we own its `deploymentTargets` shape. Throws on malformed extension JSON.
export function googleDeploymentTargets(model: SemanticModel):
    GoogleDeploymentTargets {
  const cached = targetsCache.get(model);
  if (cached) return cached;

  const uris: string[] = [];
  const bigQuery: BigQueryGraphTarget[] = [];
  const spanner: SpannerGraphTarget[] = [];
  const alloyDb: AlloyDbTarget[] = [];
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
      const ad = uri.match(ALLOYDB_TARGET);
      if (ad) {
        alloyDb.push({
          project: ad[1],
          location: ad[2],
          cluster: ad[3],
          instance: ad[4],
          database: ad[5],
          uri,
        });
        continue;
      }
      // Matches no supported destination type: collect it as malformed
      // (rejected by the validator) rather than silently ignoring it.
      malformed.push(uri);
    }
  }

  const result:
      GoogleDeploymentTargets = {uris, bigQuery, spanner, alloyDb, malformed};
  targetsCache.set(model, result);
  return result;
}


// The BigQuery Graph deployment targets a model declares, plus any URIs that
// parse as no supported destination type. A view over googleDeploymentTargets,
// preserving the historical shape the BigQuery leg and Knowledge Catalog leg
// consume. Note `malformed` excludes a valid Spanner Graph or AlloyDB target:
// each is a recognized destination, just not a BigQuery one, so neither is
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


// The AlloyDB database targets a model declares. Symmetric to the two above in
// shape, but there is no deploy leg behind it: an AlloyDB target is a store to
// run against, not a graph to create, so the only callers are store resolution
// and the messages that explain why a graph push has nothing to do.
export function alloyDbTargets(model: SemanticModel):
    {targets: AlloyDbTarget[]; malformed: string[]} {
  const {alloyDb, malformed} = googleDeploymentTargets(model);
  return {targets: alloyDb, malformed};
}


// Every deploymentTarget URI a model declares, regardless of whether each
// parses as a supported target. Validation uses this to require that a model
// declares exactly one deployment target. Throws on malformed extension JSON.
export function deploymentTargetUris(model: SemanticModel): string[] {
  return googleDeploymentTargets(model).uris;
}
