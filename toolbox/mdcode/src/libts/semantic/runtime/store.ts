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
import {AlloyDbTarget, deploymentTargetError, googleDeploymentTargets, ParsedDeploymentTarget, resolveModelDeployments, tablesOutsideTarget} from '../deployment_target';
import {Entity, SemanticModel} from '../ir';
import {asResourceName, databaseOf, listed, OSSIE_VERSION, writtenSource} from '../loader';
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
   * database: one cluster holds several, and two of them are two stores.
   */
  name: string;
  project: string;
  location: string;
  cluster: string;
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


// A BigQuery table an entity is bound to. The loader rewrites the resource-name
// URI an author may write into `project.dataset.table`, which is the form the
// generator emits and the only one that reaches here. The table name takes any
// character the loader allows in one, which is anything but a dot or a slash,
// so a name with `$` or a letter outside ASCII is still a table here.
const BIGQUERY_TABLE_SOURCE = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.[^./]+$/;


// The database a bound table sits in, or undefined when the source names no
// table of any backend this module knows. A Spanner or AlloyDB source, in
// either spelling, takes the loader's databaseOf form, `spanner/<p>/<i>/<db>`
// or `alloydb/<p>/<l>/<c>/<db>`.
function storeOf(source: string): string|undefined {
  const database = databaseOf(source);
  if (database?.startsWith('spanner/') || database?.startsWith('alloydb/')) {
    return database;
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
 * for: a target in no accepted form in any deployment, or several stores for
 * the profile. `named` alone means push refuses a table the model binds
 * outside the database a deployment targets, or the model declares actions
 * and binds a table outside its Spanner or AlloyDB store.
 *
 * Neither is set when the profile names no store, unless a target is in no
 * accepted form. Neither is set either when a BigQuery model with actions
 * binds a BigLake table or a table in another BigQuery dataset.
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
 * name none or `default` for `default`. With several targets, the store is the
 * one the operational targets, Spanner or AlloyDB, name, or else the one the
 * BigQuery targets name. Two graphs in one BigQuery dataset or one Spanner
 * database are one store. `document` names the model file in push's errors.
 * `sourceOf` gives the source push checks for each entity, and defaults to the
 * source the entity is written with.
 *
 * Fails six ways:
 *
 * 1. A target names no supported destination. Push checks the target of every
 *    deployment, so this fails the store under every profile.
 * 2. No deployment uses the profile.
 * 3. The targets name several stores and no single operational one, so which
 *    store is meant is ambiguous.
 * 4. There is no target, so there is nothing to run against.
 * 5. A deployment of the profile targets a database that holds no table an
 *    entity is bound to, which push refuses. The error is push's, and named.
 * 6. The model declares actions and binds a table outside the store. For a
 *    Spanner or AlloyDB store, a write would land in the wrong place, and the
 *    error is named. A BigQuery graph may read tables in any dataset, so for a
 *    BigQuery store the error is not named.
 */
export function resolveStore(
    model: SemanticModel, profile: string = DEFAULT_PROFILE,
    document = model.name,
    sourceOf: (e: Entity) => string|undefined = writtenSource):
    ChosenStore|StoreError {
  // Push checks the target of every deployment the model declares, so the
  // targets of every deployment are read before the profile's are picked.
  const all = googleDeploymentTargets(model);

  // The loader reads a vanilla model's `deployments` out of its GOOGLE block,
  // so a message names the block's `deployments`, as push does.
  const vanilla = model.version === OSSIE_VERSION;
  const where = vanilla && model.deployments ?
      `its GOOGLE block's 'deployments'` :
      `'deployments'`;

  // A target in no accepted form is reported, alone or beside one that gives
  // a store, whichever profile its deployment is for.
  if (all.malformed.length) {
    const unparsed =
        model.deployments!.find(d => d.target === all.malformed[0])!;
    return {
      error: deploymentTargetError(model, unparsed),
      named: true,
      rejected: true,
    };
  }

  const used = deploymentsFor(model, profile);
  if ('error' in used) return used;
  const scoped = used.model;
  // The profile's targets are among those read above, so none of them is in no
  // accepted form.
  const targets = googleDeploymentTargets(scoped);
  const {spanner, alloyDb, bigQuery} = targets;
  const declared = spanner.length + alloyDb.length + bigQuery.length;

  const operational = [...spanner, ...alloyDb];
  const contenders = operational.length ? operational : bigQuery;
  const stores = operational.length ?
      [...spanner.map(t => targetStore({engine: 'spanner', coordinates: t})),
       ...alloyDb.map(t => targetStore({engine: 'alloydb', coordinates: t}))] :
      bigQuery.map(t => targetStore({engine: 'bigquery', coordinates: t}));
  if (new Set(stores.map(s => s.name)).size > 1) {
    const counted = [
      ...(spanner.length ? [`${spanner.length} Spanner`] : []),
      ...(alloyDb.length ? [`${alloyDb.length} AlloyDB`] : []),
      ...(operational.length ? [] : [`${bigQuery.length} BigQuery`]),
    ];
    const what = counted.length > 1 ?
        `deployment targets on two operational backends (${
            counted.join(' and ')})` :
        `${counted[0]} deployment targets`;
    const names = deploymentNames(scoped, contenders.map(t => t.uri), profile);
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

  // Push refuses a deployment whose database holds no table an entity is
  // bound to. Each deployment that names the store is checked, with the
  // profile's bindings applied to the model.
  const resolved = resolveModelDeployments(scoped);
  const outside = 'error' in resolved ? [] : resolved.deployments
      .filter(d => targetStore(d).name === store.name)
      .flatMap(d => tablesOutsideTarget(document, model, d, sourceOf));
  if (outside.length) return {error: outside.join('\n'), named: true};

  // Only an action writes, so only a model that declares one needs every
  // table in the store.
  const strays = model.actions?.length ? strayBindings(model, store) : [];
  if (strays.length) {
    return {
      error: `Model '${model.name}' binds ${strays.join(', ')}, but its ` +
          `deployment target is ${store.name}. An action's statements ` +
          `address a table by name alone, so the write would land in the ` +
          `target store's table of that name rather than in the bound one. ` +
          `Bind both to the same store.`,
      // A BigQuery graph may read tables in any dataset, BigLake included,
      // so the model then has no store, and a caller
      // does not fail.
      ...(store.kind === 'bigquery' ? {} : {named: true}),
    };
  }
  return store;
}


// The model with only the deployments `profile` uses, or why there are none.
// A model with no or empty `deployments` list names no deployment.
function deploymentsFor(model: SemanticModel, profile: string):
    {model: SemanticModel}|{error: string} {
  const nothingToRun = `so there is no database to run it against`;
  const namedProfile = `binding profile '${profile}' is a named profile, ` +
      `which names no deployment target`;
  if (!model.deployments?.length) {
    return profile === DEFAULT_PROFILE ?
        {model} :
        {error: `${namedProfile}, ${nothingToRun}`};
  }
  const used = model.deployments.filter(
      d => (d.profile ?? DEFAULT_PROFILE) === profile);
  if (!used.length) {
    // A vanilla model lists its deployments in its GOOGLE block.
    const where = model.version === OSSIE_VERSION ?
        `its GOOGLE block's 'deployments'` :
        `'deployments'`;
    let error: string;
    if (profile === DEFAULT_PROFILE) {
      // Each deployment names a profile, so --profile selects its deployments.
      const named = [...new Set(model.deployments.map(d => d.profile!))];
      error = `Model '${model.name}' declares no deployment without a ` +
          `'profile' in ${where}, so there is no store to run against ` +
          `under binding profile '${DEFAULT_PROFILE}'. Its deployments use ` +
          `${named.length === 1 ? 'profile' : 'profiles'} ${
              listed(named.map(n => `'${n}'`))}; pass --profile ${
              named.length === 1 ? named[0] : '<name>'}.`;
    } else {
      error = `${namedProfile}, and no deployment in ${where} uses it, ${
          nothingToRun}`;
    }
    return {error};
  }
  return {model: {...model, deployments: used}};
}


/**
 * The targets binding profile `profile` uses, as resolveStore reads them: its
 * deployments' targets. Empty when no deployment is for the profile.
 */
export function profileTargets(model: SemanticModel, profile: string):
    string[] {
  const used = deploymentsFor(model, profile);
  return 'error' in used ? [] : googleDeploymentTargets(used.model).uris;
}


// The deployments whose targets are `uris`, for a message. `profile` is the
// profile they are for.
function deploymentNames(
    model: SemanticModel, uris: string[], profile: string): string {
  const deployments = model.deployments ?? [];
  const names =
      uris.map(uri => deployments.find(d => d.target === uri)?.name ?? uri);
  return ` for profile '${profile}' (${names.join(', ')})`;
}


// The store the deployment target `target` names.
function targetStore(target: ParsedDeploymentTarget): ChosenStore {
  switch (target.engine) {
    case 'spanner':
      return storeFor(target.coordinates, undefined, undefined);
    case 'alloydb':
      return storeFor(undefined, target.coordinates, undefined);
    case 'bigquery':
      return storeFor(undefined, undefined, target.coordinates);
  }
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
 * when the primary is not READY, or when the listing fails. Any other store
 * comes back unchanged.
 */
export async function withPrimaryInstance(
    store: ChosenStore,
    client: AlloyDbClient): Promise<Store|{error: string}> {
  if (store.kind !== 'alloydb') return store;
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


// The message of a failed API call, after the HTTP status.
function apiError(res: {status: number; message?: string}): string {
  const message = res.message?.trim();
  return message ? `${res.status} ${message}` : `${res.status}`;
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
