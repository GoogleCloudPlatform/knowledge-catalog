// Reads where a model deploys and classifies each declared target.
//
// A semantic model names where it deploys with its `deployments:` list. Each
// entry has a name, a target and optionally the binding profile it uses. Three
// destination types are recognized here, each a
// GCP resource name, written with no leading `//`:
//
//   BigQuery Graph:
//     bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>
//   Spanner Graph:
//     spanner.googleapis.com/projects/<p>/instances/<i>/databases/<db>/graphs/<g>
//   AlloyDB database:
//     alloydb.googleapis.com/projects/<p>/locations/<l>/clusters/<c>/databases/<db>
//
// The first two name a GRAPH; the third names a DATABASE, and the difference is
// not an oversight. AlloyDB has no property-graph DDL, so there is no graph to
// address and a URI pretending otherwise would name something that cannot be
// created. What an AlloyDB target says is where the model's rows live -- which
// is the whole of what a runtime needs in order to read an entity and carry out
// an action. A model bound to it deploys to Knowledge Catalog and runs; it does
// not deploy a graph, and push says so in a note rather than reporting the URI
// as a typo.
//
// The deploy legs (deploy_bigquery, deploy_spanner) and the push-time validator
// all derive their targets from this one reader, so a multi-destination push
// parses each model's targets once rather than once per reader.
//
// The capture groups are restricted to valid identifier characters: the
// components are interpolated into DDL unescaped (see the generators), so a
// permissive `[^/]+` would let backticks or semicolons through. A URI that
// matches neither destination type is collected as `malformed` (rejected by the
// validator and named in errors) rather than silently skipped.

import {DeploymentSpec, Entity, ProfileSpec, SemanticModel} from './ir';
import {AROUND_WHITESPACE, asResourceName, asResourceUri, databaseOf, entityWord, listed, resourceUriFix} from './loader';
import {DEFAULT_PROFILE, profileSources} from './resolve_profiles';


// A BigQuery Graph deployment target.
const BQ_GRAPH_TARGET =
    /^\/\/bigquery\.googleapis\.com\/projects\/([A-Za-z0-9_-]+)\/datasets\/([A-Za-z0-9_-]+)\/propertyGraphs\/([A-Za-z0-9_-]+)$/;

// A Spanner Graph deployment target, named as Dataplex names the graph's
// entry: `graphs/<g>`, where a BigQuery graph is `propertyGraphs/<g>`.
// Instance and database ids follow Spanner's resource-id grammar (lowercase
// letters, digits, hyphens). The graph segment takes what every target segment
// takes, and push holds the graph name to Spanner's narrower naming rule
// (validateDeployments). As with
// BigQuery, the segments are interpolated into DDL (the graph name) and into
// the Spanner Admin API path (project/instance/database), so the character
// classes stay strict.
const SPANNER_GRAPH_TARGET =
    /^\/\/spanner\.googleapis\.com\/projects\/([A-Za-z0-9_-]+)\/instances\/([A-Za-z0-9_-]+)\/databases\/([A-Za-z0-9_-]+)\/graphs\/([A-Za-z0-9_-]+)$/;

// A Spanner graph written with BigQuery's `propertyGraphs` segment, which names
// no Dataplex entry. Push rejects it and names the `graphs` form. Its segments
// follow SPANNER_GRAPH_TARGET's, so the name it suggests is accepted.
const SPANNER_PROPERTY_GRAPH =
    /^(spanner\.googleapis\.com\/projects\/[A-Za-z0-9_-]+\/instances\/[A-Za-z0-9_-]+\/databases\/[A-Za-z0-9_-]+)\/propertyGraphs\/([A-Za-z0-9_-]+)$/;

// An AlloyDB database. A database belongs to its cluster, and AlloyDB locates
// a cluster by region, which is why there is a `locations` segment here and
// none in the Spanner target. A database name is a PostgreSQL identifier, and
// the strict class serves the same purpose as it does above: the name is
// interpolated into a connection string and into generated SQL, so a
// permissive class would let a quote character through.
const ALLOYDB_TARGET =
    /^\/\/alloydb\.googleapis\.com\/projects\/([A-Za-z0-9_-]+)\/locations\/([A-Za-z0-9_-]+)\/clusters\/([A-Za-z0-9_-]+)\/databases\/([A-Za-z0-9_-]+)$/;

// The instance-based AlloyDB URI kcmd used before. It names no real resource,
// and no target parses as it. It exists only so targetError can name the
// cluster-based form to write instead.
const LEGACY_ALLOYDB_TARGET =
    /^\/\/alloydb\.googleapis\.com\/projects\/([A-Za-z0-9_-]+)\/locations\/([A-Za-z0-9_-]+)\/clusters\/([A-Za-z0-9_-]+)\/instances\/([A-Za-z0-9_-]+)\/databases\/([A-Za-z0-9_-]+)$/;

// The GCP resource name form of each destination type, for messages.
export const BQ_GRAPH_FORM =
    'bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>';
export const SPANNER_GRAPH_FORM =
    'spanner.googleapis.com/projects/<p>/instances/<i>/databases/<db>/graphs/<g>';
export const ALLOYDB_FORM =
    'alloydb.googleapis.com/projects/<p>/locations/<l>/clusters/<c>/databases/<db>';

// The Knowledge Catalog name prefixes of a graph or an AlloyDB database, each
// with the resource name form to write instead. kcmd accepts no catalog name as
// a target. `bigquery:propertygraph:` is a deprecated synonym for
// `bigquery:graph:`.
const CATALOG_PREFIXES: Array<[string, string]> = [
  ['bigquery:graph:', BQ_GRAPH_FORM],
  ['bigquery:propertygraph:', BQ_GRAPH_FORM],
  ['spanner:graph:', SPANNER_GRAPH_FORM],
  ['alloydb:', ALLOYDB_FORM],
];


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
  database: string;
  uri: string;
}

export interface GoogleDeploymentTargets {
  // Every declared target, in declaration order.
  uris: string[];
  // The subset that parse as BigQuery Graph targets.
  bigQuery: BigQueryGraphTarget[];
  // The subset that parse as Spanner Graph targets.
  spanner: SpannerGraphTarget[];
  // The subset that parse as AlloyDB database targets. Not a graph: see the
  // file header for why this one names a database.
  alloyDb: AlloyDbTarget[];
  // Targets that parse as NONE of the supported destinations (a host/scheme/
  // segment/identifier typo, or an unsupported destination). Kept so a caller
  // can name the typo instead of silently dropping it.
  malformed: string[];
}

// A deployment target's engine, with its coordinates.
export type ParsedDeploymentTarget =
    {engine: 'bigquery'; coordinates: BigQueryGraphTarget}|
    {engine: 'spanner'; coordinates: SpannerGraphTarget}|
    {engine: 'alloydb'; coordinates: AlloyDbTarget};

// One entry of a model's `deployments:` list, with its target parsed.
export type ResolvedDeployment = ParsedDeploymentTarget&{
  name: string;
  // The binding profile the deployment uses: its `profile`, or `default`.
  profile: string;
};


// Parses a deployment target written as a GCP resource name. Returns undefined
// for any other form, the resource URI with its leading `//` included. `uri`
// in the result is the target as written.
function parseTarget(uri: string): ParsedDeploymentTarget|undefined {
  if (uri.startsWith('//')) return undefined;
  const resource = asResourceUri(uri);
  const bq = resource.match(BQ_GRAPH_TARGET);
  if (bq) {
    return {
      engine: 'bigquery',
      coordinates: {project: bq[1], dataset: bq[2], graphName: bq[3], uri},
    };
  }
  const sp = resource.match(SPANNER_GRAPH_TARGET);
  if (sp) {
    return {
      engine: 'spanner',
      coordinates: {
        project: sp[1],
        instance: sp[2],
        database: sp[3],
        graphName: sp[4],
        uri,
      },
    };
  }
  const ad = resource.match(ALLOYDB_TARGET);
  if (ad) {
    return {
      engine: 'alloydb',
      coordinates: {
        project: ad[1],
        location: ad[2],
        cluster: ad[3],
        database: ad[4],
        uri,
      },
    };
  }
  return undefined;
}

/**
 * The resource a deployment target names: two targets with the same key name
 * one resource. Spanner and BigQuery read a graph name without regard to case,
 * so the key holds it in lower case. A target in no accepted form keys on its
 * own text, which matches no accepted target's key.
 */
export function deploymentTargetKey(target: string): string {
  const parsed = parseTarget(target);
  if (!parsed) return `unparsed:${target}`;
  const {engine, coordinates: c} = parsed;
  switch (engine) {
    case 'bigquery':
      return `bigquery/${c.project}/${c.dataset}/${c.graphName.toLowerCase()}`;
    case 'spanner':
      return `spanner/${c.project}/${c.instance}/${c.database}/${
          c.graphName.toLowerCase()}`;
    case 'alloydb':
      return `alloydb/${c.project}/${c.location}/${c.cluster}/${c.database}`;
  }
}

// The cluster-based URI of the database a legacy instance-based AlloyDB URI
// names.
function clusterUri(legacy: RegExpMatchArray): string {
  return `//alloydb.googleapis.com/projects/${legacy[1]}/locations/${
      legacy[2]}/clusters/${legacy[3]}/databases/${legacy[5]}`;
}

/** Why a deployment's target is not accepted in a `deployments:` list. */
export function deploymentTargetError(
    model: SemanticModel, d: DeploymentSpec): string {
  return targetError(
      `Model '${model.name}': deployment '${d.name}' targets '${d.target}'`,
      d.target);
}

// The Dataplex name of a Spanner graph `target` names with `propertyGraphs`,
// or undefined for any other target.
function spannerGraphName(target: string): string|undefined {
  const m = asResourceName(target).match(SPANNER_PROPERTY_GRAPH);
  return m ? `${m[1]}/graphs/${m[2]}` : undefined;
}

/**
 * Why a push would reject `target`, or undefined when it accepts it. `at` says
 * where it is written.
 */
export function targetProblem(at: string, target: string): string|undefined {
  return parseTarget(target) ? undefined : targetError(at, target);
}

/** Why `target` is not accepted. `at` says where it is written. */
function targetError(at: string, target: string): string {
  if (target !== target.trim()) return `${at}, which ${AROUND_WHITESPACE}.`;
  const legacy = asResourceUri(target).match(LEGACY_ALLOYDB_TARGET);
  if (legacy) {
    return `${at}, the instance-based AlloyDB name, which names no real ` +
        `resource. An AlloyDB database belongs to its cluster; write '${
               asResourceName(clusterUri(legacy))}'.`;
  }
  const name = asResourceName(target);
  if (name !== target && parseTarget(name)) {
    return `${at}, which is ${resourceUriFix(target)}.`;
  }
  const graph = spannerGraphName(target);
  if (graph) {
    return `${at}, which names a Spanner graph by 'propertyGraphs'; write ` +
        `its Dataplex name: '${graph}'.`;
  }
  const form =
      CATALOG_PREFIXES.find(([prefix]) => target.startsWith(prefix))?.[1];
  if (form) {
    return `${at}, which is a Knowledge Catalog name. Write the GCP resource ` +
        `name instead: '${form}'.`;
  }
  return `${at}, which is not a BigQuery graph, a Spanner graph or an ` +
      `AlloyDB database. Write a GCP resource name: '${BQ_GRAPH_FORM}', '${
             SPANNER_GRAPH_FORM}' or '${ALLOYDB_FORM}'.`;
}


/**
 * The deployment names a `--deployment` flag selects, or undefined when the
 * flag is absent or negated. The flag is repeated or comma-separated. It
 * arrives as a string, as an array of them, or as a boolean when
 * it is absent or negated. Pieces are trimmed, empty ones dropped, and a
 * repeated name kept once, at its first position. Throws when any occurrence
 * of the flag names no deployment. A bare occurrence in an array
 * arrives as `true` and names none.
 */
export function parseDeploymentSelection(
    raw?: string|boolean|Array<string|boolean>): string[]|undefined {
  if (raw === undefined || typeof raw === 'boolean') return undefined;
  const noNames = `--deployment names no deployment; give one or more ` +
      `deployment names, comma-separated.`;
  const names: string[] = [];
  const parts = Array.isArray(raw) ? raw : [raw];
  for (const part of parts) {
    const pieces = typeof part === 'boolean' ?
        [] :
        String(part).split(',').map(p => p.trim()).filter(p => p);
    if (!pieces.length) throw new Error(noNames);
    for (const name of pieces) {
      if (!names.includes(name)) names.push(name);
    }
  }
  if (!names.length) throw new Error(noNames);
  return names;
}


/**
 * A model's deployments with each target parsed into its engine and
 * coordinates. Returns every deployment in declaration order, or only the
 * `selected` names, in the order given. Fails on a selected name the model
 * does not declare, and on a target in no accepted form.
 */
export function resolveModelDeployments(
    model: SemanticModel, selected?: string[]):
    {deployments: ResolvedDeployment[]}|{error: string} {
  const declared = model.deployments ?? [];
  let chosen = declared;
  if (selected !== undefined) {
    const byName = new Map(declared.map(d => [d.name, d]));
    chosen = [];
    for (const name of selected) {
      const d = byName.get(name);
      if (!d) {
        const available =
            declared.length ? declared.map(x => x.name).join(', ') : 'none';
        return {
          error: `Model '${model.name}' has no deployment named '${
              name}' (available: ${available}).`,
        };
      }
      chosen.push(d);
    }
  }
  const deployments: ResolvedDeployment[] = [];
  for (const d of chosen) {
    const parsed = parseTarget(d.target);
    if (!parsed) return {error: deploymentTargetError(model, d)};
    deployments.push({
      ...parsed,
      name: d.name,
      profile: d.profile ?? DEFAULT_PROFILE,
    });
  }
  return {deployments};
}


// Memoizes the parse per model object so the several callers within one push
// (validation, source-project lookup, per-leg routing, each deploy leg) share a
// single parse rather than re-running the regexes once per reader.
// Keyed by model identity: the IR object is stable through a push (the loader
// and inheritance passes each hand on a fixed set of objects) and
// its deployments are not mutated after loading.
// A caller that narrows `deployments` builds a new model object. The returned
// value is read-only by convention -- no caller mutates its arrays.
const targetsCache = new WeakMap<SemanticModel, GoogleDeploymentTargets>();

// Deployments for targets given without names. One target is `default`;
// several are `deployment_1`, `deployment_2`, and so on. Targets are trimmed,
// and blank ones dropped. A repeated target is dropped too, so the list loads
// as a `deployments:` list.
export function unnamedDeployments(targets: readonly string[]):
    Array<{name: string; target: string}> {
  const seen = new Set<string>();
  const kept = targets.map(t => t.trim()).filter(t => {
    if (t === '' || seen.has(t)) return false;
    seen.add(t);
    return true;
  });
  return kept.map((target, i) => ({
    name: kept.length === 1 ? 'default' : `deployment_${i + 1}`,
    target,
  }));
}

// Reads a model's deployment targets in a single pass and returns the facts
// every caller derives from them. The targets come from `model.deployments`.
export function googleDeploymentTargets(model: SemanticModel):
    GoogleDeploymentTargets {
  const cached = targetsCache.get(model);
  if (cached) return cached;

  const uris = (model.deployments ?? []).map(d => d.target);
  const bigQuery: BigQueryGraphTarget[] = [];
  const spanner: SpannerGraphTarget[] = [];
  const alloyDb: AlloyDbTarget[] = [];
  const malformed: string[] = [];

  for (const uri of uris) {
    const parsed = parseTarget(uri);
    if (parsed?.engine === 'bigquery') {
      bigQuery.push(parsed.coordinates);
    } else if (parsed?.engine === 'spanner') {
      spanner.push(parsed.coordinates);
    } else if (parsed?.engine === 'alloydb') {
      alloyDb.push(parsed.coordinates);
    } else {
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


// The database the tables of a deployment target must be in, as databaseOf
// gives it, and how an error names the target, the place outside it, and one
// table or several tables in it.
function targetDatabase({engine, coordinates: c}: ParsedDeploymentTarget) {
  if (engine === 'bigquery') {
    return {
      database: 'bigquery', target: 'a BigQuery graph',
      outside: 'outside BigQuery and BigLake',
      inside: ['a BigQuery or BigLake table', 'BigQuery or BigLake tables'],
    };
  }
  const [system, name] = engine === 'spanner' ?
      ['Spanner', `${c.project}/${c.instance}/${c.database}`] :
      ['AlloyDB', `${c.project}/${c.location}/${c.cluster}/${c.database}`];
  return {database: `${engine}/${name}`, target: `${system} database '${name}'`,
          outside: 'outside that database',
          inside: ['a table in that database', 'tables in that database']};
}


// The entities of `model` whose source, as `sourceOf` gives it, is a table
// outside `database`. An entity with no source is left out.
function entitiesOutside(
    model: SemanticModel, database: string,
    sourceOf: (e: Entity) => string | undefined): Entity[] {
  return (model.entities ?? []).filter(e => {
    const source = sourceOf(e)?.trim();
    return source && databaseOf(source) !== database;
  });
}


// Push's error for `deployment` of `model`, in `document`, when it binds
// entities to tables outside the database it deploys to, or none. The
// deployment's profile in `profiles` gives the sources, or `modelSource` gives
// the model file's for `default`. Push reads a named profile's own sources, so
// an entity the profile gives no source is unbound under it. A named profile
// not in `profiles` is in a profile file that does not load, which push
// reports instead. For a deployment on the model file's bindings, the error
// names each profile that binds every entity it lists and with which the
// deployment would pass this check. Push's other checks may still refuse such
// a profile.
export function tablesOutsideTarget(
    document: string, model: SemanticModel, deployment: ResolvedDeployment,
    modelSource: (e: Entity) => string | undefined,
    profiles: readonly ProfileSpec[]): string[] {
  const {database, target, outside, inside} = targetDatabase(deployment);
  const named = deployment.profile !== DEFAULT_PROFILE;
  const profile =
      named ? profiles.find(p => p.name === deployment.profile) : undefined;
  if (named && !profile) return [];
  const entities = entitiesOutside(
      model, database, profile ? profileSources(profile) : modelSource);
  if (!entities.length) return [];
  // A vanilla model calls an entity a dataset.
  const one = entityWord(model.version);
  const many = entities.length > 1;
  const kind = !many ? one : one === 'entity' ? 'entities' : 'datasets';
  const each = `${many ? 'each' : 'the'} ${one}`;
  const these = `${many ? 'these' : 'this'} ${kind} to ${inside[many ? 1 : 0]}`;
  const fits = named ? [] : profiles.filter(p => {
    const sourceOf = profileSources(p);
    return entities.every(e => sourceOf(e)?.trim()) &&
        !entitiesOutside(model, database, sourceOf).length;
  }).map(p => p.name).sort();
  let advice: string;
  if (named) {
    advice = `Bind ${each} to ${inside[0]} in profile '${deployment.profile}'.`;
  } else if (fits.length === 1) {
    advice = `Profile '${fits[0]}' binds ${these}. Set the deployment's ` +
        `profile to '${fits[0]}'.`;
  } else if (fits.length) {
    advice = `Profiles ${listed(fits.map(p => `'${p}'`))} bind ${these}. ` +
        `Set the deployment's profile to one of them.`;
  } else {
    advice = `Bind ${each} to ${inside[0]} in the model file, or set the ` +
        `deployment's profile to a profile that does.`;
  }
  return [
    `[${document}] deployment '${deployment.name}' targets ${target}, but ${
        named ? `profile '${deployment.profile}'` : 'the model file'} binds ${
        kind} ${listed(entities.map(e => `'${e.name}'`))} to ${
        many ? 'tables' : 'a table'} ${outside}. ${advice}`,
  ];
}
