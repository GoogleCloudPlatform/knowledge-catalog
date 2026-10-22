// The store a model's data lives in.
//
// A deployment that uses a binding profile names a target; this module turns
// that declaration into structured store coordinates. A profile may deploy to
// Spanner, to AlloyDB or to BigQuery. `kind` is the discriminant, and what
// differs by it is how the store is ADDRESSED -- the coordinates it takes and
// the dialect it speaks -- not whether an action may write to it.
//
// All three execute SQL DML, so all three can be the store a model's actions
// run against. BigQuery is a warehouse rather than a transactional database
// and a write there costs what a warehouse write costs, but that is a question
// about the model an author is building, not a rule this module enforces.
//
// Identity is `name`, the resource the store addresses. Two profiles naming
// the same database describe ONE store; the profile is how a caller found it,
// not what it is.

import {AlloyDbClient, Instance} from '../../gcp/alloydb';
import {ApiResult} from '../../gcp/api';
import {AlloyDbTarget, deploymentTargetError, deploymentTargetKeyError, destinationKey, googleBlockTargetError, GoogleDeploymentTargets, googleDeploymentTargets} from '../deployment_target';
import {SemanticModel} from '../ir';
import {asResourceName, databaseOf, OSSIE_VERSION, writtenSource} from '../loader';
import {DEFAULT_PROFILE} from '../resolve_profiles';


/** A Spanner database. An action's statements can write to it. */
export interface SpannerStore {
  kind: 'spanner';
  /** `projects/<p>/instances/<i>/databases/<d>`. The store's identity. */
  name: string;
  project: string;
  instance: string;
  database: string;
}


/**
 * An AlloyDB database. An action's statements can write to it. The instance a
 * connection goes through may not be known yet.
 */
export interface AlloyDbDatabase {
  kind: 'alloydb';
  /**
   * `projects/<p>/locations/<l>/clusters/<c>/databases/<d>`. The store's
   * identity, which on AlloyDB reaches all the way down to the PostgreSQL
   * database: one cluster holds several, and two of them are two stores. A
   * legacy instance-based target takes the same name, and its instance is in
   * `instance`.
   */
  name: string;
  project: string;
  location: string;
  cluster: string;
  /**
   * The instance a connection goes through. A legacy target names it. For
   * any other target, withPrimaryInstance finds the cluster's primary
   * instance.
   */
  instance?: string;
  database: string;
}


/** An AlloyDB database, with the instance a connection goes through. */
export interface AlloyDbStore extends AlloyDbDatabase {
  instance: string;
}


/** A BigQuery dataset. An action's statements can write to it. */
export interface BigQueryStore {
  kind: 'bigquery';
  /** `projects/<p>/datasets/<d>`. The store's identity. */
  name: string;
  project: string;
  dataset: string;
}


export type Store = SpannerStore|AlloyDbStore|BigQueryStore;


/**
 * The store resolveStore chooses. An AlloyDB database may still need its
 * instance found with withPrimaryInstance.
 */
export type ChosenStore = SpannerStore|AlloyDbDatabase|BigQueryStore;


// The instance-based AlloyDB table URI kcmd used before, which legacy profiles
// still bind.
const LEGACY_ALLOYDB_TABLE_SOURCE =
    /^\/\/alloydb\.googleapis\.com\/projects\/([A-Za-z0-9_-]+)\/locations\/([A-Za-z0-9_-]+)\/clusters\/([A-Za-z0-9_-]+)\/instances\/[A-Za-z0-9_-]+\/databases\/([A-Za-z0-9_-]+)\/tables\/.+$/;

// A BigQuery table an entity is bound to. The loader rewrites the resource-name
// URI an author may write into `project.dataset.table`, which is the form the
// generator emits and the only one that reaches here. The table name takes any
// character the loader allows in one, which is anything but a dot or a slash,
// so a name with `$` or a letter outside ASCII is still a table here.
const BIGQUERY_TABLE_SOURCE = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.[^./]+$/;


// The database a bound table sits in, or undefined when the source names no
// table of any backend this module knows. A Spanner or AlloyDB source, in
// either spelling, takes the loader's databaseOf form, `spanner/<p>/<i>/<db>`
// or `alloydb/<p>/<l>/<c>/<db>`. An AlloyDB database belongs to its cluster,
// so an instance in a legacy source is not part of it.
function storeOf(source: string): string|undefined {
  const database = databaseOf(source);
  if (database?.startsWith('spanner/') || database?.startsWith('alloydb/')) {
    return database;
  }
  const legacy = source.match(LEGACY_ALLOYDB_TABLE_SOURCE);
  if (legacy) {
    return `alloydb/${legacy[1]}/${legacy[2]}/${legacy[3]}/${legacy[4]}`;
  }
  const bigQuery = source.match(BIGQUERY_TABLE_SOURCE);
  if (bigQuery) return `bigquery/${bigQuery[1]}/${bigQuery[2]}`;
  return undefined;
}


// Every table the model binds, not just its entities: a many-to-many
// relationship is backed by a junction table of its own, and an action that
// creates the edge writes to exactly that one.
function boundTables(model: SemanticModel):
    Array<{name: string; source: string; shown: string}> {
  const bindings: Array<{name: string; source: string; shown: string}> = [];
  for (const entity of model.entities ?? []) {
    bindings.push({
      name: entity.name,
      source: entity.dataSource ?? '',
      shown: writtenSource(entity),
    });
  }
  for (const relationship of model.relationships ?? []) {
    const source = relationship.association?.dataSource;
    if (source) {
      bindings.push({name: relationship.name, source, shown: asResourceName(source)});
    }
  }
  return bindings;
}


// The database a store addresses, in the form storeOf gives. An AlloyDB
// store matches a source on project, location, cluster and database.
function storeDatabase(store: ChosenStore): string {
  switch (store.kind) {
    case 'spanner':
      return `spanner/${store.project}/${store.instance}/${store.database}`;
    case 'alloydb':
      return `alloydb/${store.project}/${store.location}/${store.cluster}/${
          store.database}`;
    case 'bigquery':
      return `bigquery/${store.project}/${store.dataset}`;
  }
}


// Bindings that address something other than the store the deployment target
// names. An action's statements address a table by its NAME, with the
// project/instance/database qualifier dropped, so an entity bound elsewhere
// would produce a statement against whatever table of that name the target
// store happens to hold.
function strayBindings(model: SemanticModel, store: ChosenStore): string[] {
  const database = storeDatabase(store);
  const strays: string[] = [];
  for (const binding of boundTables(model)) {
    const source = binding.source.trim();
    if (!source) continue;
    const bound = storeOf(source);
    if (!bound) {
      strays.push(`'${binding.name}' to ${
          binding.shown}, which is not a table in this store`);
      continue;
    }
    if (bound !== database) strays.push(`'${binding.name}' to ${binding.shown}`);
  }
  return strays;
}


/**
 * Why resolveStore gives no store.
 *
 * `named` is set when the model's deployments name a target and still no
 * store results, so a caller that runs against the store fails. `rejected` is
 * set with it when the deployments give no store whatever the model is used
 * for: a target in no accepted form in any deployment, a target listed twice,
 * a GOOGLE block whose data is not valid JSON, or several targets for the
 * profile. `named` alone means the model binds a table outside its Spanner or
 * AlloyDB store.
 *
 * Neither is set when the profile names no store, unless a target is in no
 * accepted form or listed twice, or a GOOGLE block is not valid JSON. Neither
 * is set either when a BigQuery model binds a table outside the graph's
 * dataset, which push accepts.
 */
export interface StoreError {
  error: string;
  named?: boolean;
  rejected?: boolean;
}


/**
 * The store a model runs against under binding profile `profile`, which
 * defaults to `default`, the model file's own bindings. It is the one the
 * deployments for that profile name: those that name it in `profile`, or that
 * name none or `default` for `default`. A model with no `deployments` list,
 * such as a vanilla model that lists `deploymentTargets` in its GOOGLE block,
 * names no profile for any of its targets, so they are all for `default`. The
 * instance-based and cluster-based URIs of one AlloyDB database are one store.
 * With several targets, the store is the single operational one, Spanner or
 * AlloyDB.
 *
 * Set `legacyWrapper` for a model a legacy `semantic_model:` wrapper was
 * merged into. Set `deploymentTarget` when the model's deployment comes from a
 * `deployment_target` key, which the loader names `default`, so that a
 * message names the key instead.
 *
 * Fails seven ways:
 *
 * 1. A GOOGLE block's data is not valid JSON, so its targets cannot be read.
 * 2. A target is listed twice. Push refuses that on every push, so this fails
 *    the store under every profile.
 * 3. A target names no supported destination. Push checks the target of every
 *    deployment, so this fails the store under every profile.
 * 4. No deployment uses the profile.
 * 5. There are several targets and no single operational one, so which store
 *    is meant is ambiguous.
 * 6. There is no target, so there is nothing to run against.
 * 7. The model binds a table outside the store. For a Spanner or AlloyDB
 *    store, a write would land in the wrong place, and the error is named. A
 *    BigQuery graph may read tables in any dataset, and push accepts that, so
 *    for a BigQuery store the error is not named.
 */
export function resolveStore(
    model: SemanticModel, profile: string = DEFAULT_PROFILE,
    opts: {legacyWrapper?: boolean; deploymentTarget?: boolean} = {}):
    ChosenStore|StoreError {
  // Push checks the target of every deployment the model declares, so the
  // targets of every deployment are read before the profile's are picked.
  let all: GoogleDeploymentTargets;
  try {
    all = googleDeploymentTargets(model);
  } catch (err: any) {
    // It throws when a GOOGLE block's data is not valid JSON. Push reports
    // that as an error, so the store fails.
    return {error: `${err?.message || err}`, named: true, rejected: true};
  }

  // The loader reads a vanilla model's `deployments` out of its GOOGLE block.
  // It keeps a GOOGLE block on the model only when the block lists
  // `deploymentTargets`, the older form, whose targets carry no deployment
  // name. A message names that key only for such a block, and names the
  // block's `deployments` for a vanilla model that lists them, as push does.
  const vanilla = model.version === OSSIE_VERSION;
  const inGoogleBlock = vanilla && model.deployments === undefined &&
      (model.customExtensions ?? []).some(e => e.vendorName === 'GOOGLE');
  const where = inGoogleBlock ? `its GOOGLE block's 'deploymentTargets'` :
      vanilla && model.deployments ? `its GOOGLE block's 'deployments'` :
                                     `'deployments'`;

  // Every push refuses a target listed twice, even beside one that gives a
  // store. The loader refuses a repeat in `deployments`, so a repeat here is
  // in a GOOGLE block.
  const repeated = all.uris.find((uri, i) => all.uris.indexOf(uri) < i);
  if (repeated !== undefined) {
    return {
      error: `Model '${model.name}' declares duplicate deployment target '${
                 repeated}' in ${where}; each deployment must target a ` +
          `distinct resource.`,
      named: true,
      rejected: true,
    };
  }

  // A target in no accepted form is reported, alone or beside one that gives
  // a store, whichever profile its deployment is for.
  if (all.malformed.length) {
    const unparsed =
        model.deployments?.find(d => d.target === all.malformed[0]);
    let error: string;
    if (!unparsed) {
      error = googleBlockTargetError(model, all.malformed[0]);
    } else if (opts.deploymentTarget) {
      error = deploymentTargetKeyError(model, unparsed.target);
    } else {
      error = deploymentTargetError(model, unparsed);
    }
    return {error, named: true, rejected: true};
  }

  const used = deploymentsFor(model, profile, opts.legacyWrapper ?? false);
  if ('error' in used) return used;
  const {model: scoped, owner} = used;
  // The profile's targets are among those read above. So this does not
  // throw, and none of them is in no accepted form.
  const targets = googleDeploymentTargets(scoped);
  const {spanner, bigQuery} = targets;
  const alloyDb = mergeUriPairs(targets.alloyDb);
  const declared = spanner.length + alloyDb.length + bigQuery.length;

  const operational = [...spanner, ...alloyDb];
  const contenders = operational.length ? operational : bigQuery;
  if (contenders.length > 1) {
    const counted = [
      ...(spanner.length ? [`${spanner.length} Spanner`] : []),
      ...(alloyDb.length ? [`${alloyDb.length} AlloyDB`] : []),
      ...(operational.length ? [] : [`${bigQuery.length} BigQuery`]),
    ];
    const what = counted.length > 1 ?
        `deployment targets on two operational backends (${
            counted.join(' and ')})` :
        `${counted[0]} deployment targets`;
    const names = deploymentNames(scoped, contenders.map(t => t.uri), owner);
    return {
      error: `Model '${model.name}' declares ${what} in ${where}${
                 names}, so which store it runs against is ambiguous; the ` +
          `runtime uses exactly one deployment for now.`,
      named: true,
      rejected: true,
    };
  }
  if (!declared) {
    const declare = vanilla ?
        ` In a GOOGLE custom_extensions block on the model, declare a ` +
            `deployment in 'deployments' whose target names a database.` :
        ` Declare a deployment in 'deployments' whose target names a ` +
            `database.`;
    return {
      error: `Model '${model.name}' declares no deployment target in ${
                 where}, so there is no store to run against.${declare}`,
    };
  }

  const store = storeFor(spanner[0], alloyDb[0], bigQuery[0]);

  const strays = strayBindings(model, store);
  if (strays.length) {
    return {
      error: `Model '${model.name}' binds ${strays.join(', ')}, but its ` +
          `deployment target is ${store.name}. An action's statements ` +
          `address a table by name alone, so the write would land in the ` +
          `target store's table of that name rather than in the bound one. ` +
          `Bind both to the same store.`,
      // A BigQuery graph may read tables in any dataset, BigLake included,
      // and push accepts that. The model then has no store, and a caller
      // does not fail.
      ...(store.kind === 'bigquery' ? {} : {named: true}),
    };
  }
  return store;
}


// The AlloyDB targets, with each database that is named once by its
// instance-based URI and once by its cluster-based URI counted once. The
// instance-based one is kept, whichever is listed first, because it names the
// instance to connect through. Any other repeat of a database is kept, so two
// instances of one database count twice. resolveStore has already refused the
// same URI listed twice.
function mergeUriPairs(targets: AlloyDbTarget[]): AlloyDbTarget[] {
  const byDatabase = new Map<string, AlloyDbTarget[]>();
  for (const t of targets) {
    const key = destinationKey(t.uri);
    byDatabase.set(key, [...(byDatabase.get(key) ?? []), t]);
  }
  return targets.filter(t => {
    const named = byDatabase.get(destinationKey(t.uri))!;
    const pair = named.length === 2 &&
        named.some(n => n.instance !== undefined) &&
        named.some(n => n.instance === undefined);
    return !pair || t.instance !== undefined;
  });
}


// The model with only the deployments `profile` uses, or why there are none.
// `owner` is the profile those deployments are for: `profile` itself, or
// `default` when a legacy wrapper that no deployment names falls back to the
// model file's own, as push deploys it. A wrapper that names its own
// `deployment_target` has replaced the model file's deployments with it. A
// model with no `deployments` list keeps every target in its GOOGLE block for
// `default` and for a legacy wrapper. An empty list names no deployment.
// Either way, any other profile has none.
function deploymentsFor(
    model: SemanticModel, profile: string, legacyWrapper: boolean):
    {model: SemanticModel; owner: string}|{error: string} {
  const nothingToRun = `so there is no database to run it against`;
  const namedProfile = `binding profile '${profile}' is a named profile, ` +
      `which names no deployment target`;
  if (!model.deployments?.length) {
    return profile === DEFAULT_PROFILE || legacyWrapper ?
        {model, owner: DEFAULT_PROFILE} :
        {error: `${namedProfile}, ${nothingToRun}`};
  }
  const usedBy = (name: string) => model.deployments!.filter(
      d => (d.profile ?? DEFAULT_PROFILE) === name);
  let owner = profile;
  let used = usedBy(profile);
  if (!used.length && legacyWrapper) {
    owner = DEFAULT_PROFILE;
    used = usedBy(DEFAULT_PROFILE);
  }
  if (!used.length) {
    // A vanilla model lists its deployments in its GOOGLE block.
    const listed = model.version === OSSIE_VERSION ?
        `its GOOGLE block's 'deployments'` :
        `'deployments'`;
    let error: string;
    if (profile === DEFAULT_PROFILE) {
      error = `Model '${model.name}' declares no deployment without a ` +
          `'profile' in ${listed}, so there is no store to run against ` +
          `under binding profile '${DEFAULT_PROFILE}'.`;
    } else if (legacyWrapper) {
      error = `legacy binding profile '${profile}' names no ` +
          `'deployment_target', and every deployment in 'deployments' names ` +
          `another profile, ${nothingToRun}`;
    } else {
      error = `${namedProfile}, and no deployment in ${listed} uses it, ${
          nothingToRun}`;
    }
    return {error};
  }
  return {model: {...model, deployments: used}, owner};
}


/**
 * The targets binding profile `profile` uses, as resolveStore reads them: its
 * deployments' targets, or every target in a GOOGLE block for `default` and
 * for a legacy wrapper when the model has no `deployments` list. Empty when no
 * deployment is for the profile. Set `legacyWrapper` as for resolveStore.
 * Throws when a GOOGLE block's data is not valid JSON.
 */
export function profileTargets(
    model: SemanticModel, profile: string,
    opts: {legacyWrapper?: boolean} = {}): string[] {
  const used = deploymentsFor(model, profile, opts.legacyWrapper ?? false);
  return 'error' in used ? [] : googleDeploymentTargets(used.model).uris;
}


// The deployments whose targets are `uris`, for a message, or nothing when
// the targets come from a GOOGLE block, which names none. `owner` is the
// profile they are for.
function deploymentNames(
    model: SemanticModel, uris: string[], owner: string): string {
  const deployments = model.deployments;
  if (!deployments) return '';
  const names =
      uris.map(uri => deployments.find(d => d.target === uri)?.name ?? uri);
  return ` for profile '${owner}' (${names.join(', ')})`;
}


function storeFor(
    spanner: {project: string; instance: string; database: string}|undefined,
    alloyDb: AlloyDbTarget|undefined,
    bigQuery: {project: string; dataset: string}|undefined): ChosenStore {
  if (spanner) {
    return {
      kind: 'spanner',
      name: `projects/${spanner.project}/instances/${
          spanner.instance}/databases/${spanner.database}`,
      project: spanner.project,
      instance: spanner.instance,
      database: spanner.database,
    };
  }
  if (alloyDb) {
    return {
      kind: 'alloydb',
      name: `projects/${alloyDb.project}/locations/${
          alloyDb.location}/clusters/${alloyDb.cluster}/databases/${
          alloyDb.database}`,
      project: alloyDb.project,
      location: alloyDb.location,
      cluster: alloyDb.cluster,
      ...(alloyDb.instance !== undefined ? {instance: alloyDb.instance} : {}),
      database: alloyDb.database,
    };
  }
  return {
    kind: 'bigquery',
    name: `projects/${bigQuery!.project}/datasets/${bigQuery!.dataset}`,
    project: bigQuery!.project,
    dataset: bigQuery!.dataset,
  };
}


/**
 * `store` with the instance a connection goes through. An AlloyDB target
 * names a database in a cluster, so this asks the AlloyDB API for the
 * cluster's primary instance. Fails, naming the cluster, when it has none,
 * when the primary is not READY, or when the listing fails. Any other store,
 * and an AlloyDB store that already names its instance, comes back unchanged.
 */
export async function withPrimaryInstance(
    store: ChosenStore,
    client: AlloyDbClient): Promise<Store|{error: string}> {
  if (store.kind !== 'alloydb') return store;
  // A legacy target names its instance. The spread gives the type that says
  // so.
  if (store.instance !== undefined) return {...store, instance: store.instance};
  const cluster = `projects/${store.project}/locations/${
      store.location}/clusters/${store.cluster}`;
  let res: ApiResult<Instance[]>;
  try {
    res = await client.listInstances(
        store.project, store.location, store.cluster);
  } catch (err: any) {
    return {
      error: `Could not list the instances of AlloyDB cluster '${cluster}': ${
          err?.message ?? err}`,
    };
  }
  if (res.status !== 200) {
    return {
      error: `Could not list the instances of AlloyDB cluster '${cluster}': ${
          apiError(res)}`,
    };
  }
  const primary = res.result?.find(i => i.instanceType === 'PRIMARY');
  const instance = primary?.name?.split('/').pop();
  if (!primary || !instance) {
    return {
      error: `AlloyDB cluster '${cluster}' has no primary instance, so there ` +
          `is no instance to connect to database '${store.database}' through.`,
    };
  }
  if (primary.state !== 'READY') {
    return {
      error: `AlloyDB cluster '${cluster}' has primary instance '${
          instance}' in state ${primary.state ?? 'STATE_UNSPECIFIED'}; it ` +
          `must be READY to connect to database '${
              store.database}' through it.`,
    };
  }
  return {...store, instance};
}


// The message of a failed API call: the error the response body states, or
// failing that the body as it is, after the HTTP status.
function apiError(res: {status: number; message?: string}): string {
  try {
    const message = JSON.parse(res.message ?? '')?.error?.message;
    if (typeof message === 'string' && message) {
      return `${res.status} ${message}`;
    }
  } catch {
    // Not JSON: report the body as it is.
  }
  return res.message ? `${res.status} ${res.message}` : `${res.status}`;
}


/**
 * How a store is written down for a reader: the resource it addresses, with
 * the backend named ahead of it for everything but Spanner, which is the one
 * an unprefixed line has always meant.
 */
export function storeLine(store: Store): string {
  switch (store.kind) {
    case 'spanner':
      return `${store.project}/${store.instance}/${store.database}`;
    case 'alloydb':
      return `alloydb:${store.project}/${store.location}/${store.cluster}/` +
          `${store.instance}/${store.database}`;
    case 'bigquery':
      return `bigquery:${store.project}/${store.dataset}`;
  }
}
