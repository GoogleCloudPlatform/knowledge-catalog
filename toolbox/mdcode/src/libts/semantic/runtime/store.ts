// The store a model's data lives in.
//
// A binding profile supplies a deployment target; this module turns that
// declaration into structured store coordinates. A profile may deploy to
// Spanner, to AlloyDB or to BigQuery, and what may be done with the result
// differs by which. `kind` is the discriminant, so a caller that needs an
// operational database checks `kind` instead of assuming a target is writable.
//
// Two of the three are OPERATIONAL: Spanner and AlloyDB hold rows an action's
// SQL statements change, and either can be the store a model runs against.
// BigQuery is the third and is not operational: it is where a graph goes to be
// analyzed.
//
// Identity is `name`, the resource the store addresses. Two profiles naming
// the same database describe ONE store; the profile is how a caller found it,
// not what it is.

import {googleDeploymentTargets} from '../deployment_target';
import {SemanticModel} from '../ir';


/** A Spanner database. An operational store: an action can write to it. */
export interface SpannerStore {
  kind: 'spanner';
  /** `projects/<p>/instances/<i>/databases/<d>`. The store's identity. */
  name: string;
  project: string;
  instance: string;
  database: string;
}


/** An AlloyDB database. An operational store: an action can write to it. */
export interface AlloyDbStore {
  kind: 'alloydb';
  /**
   * `projects/<p>/locations/<l>/clusters/<c>/instances/<i>/databases/<d>`.
   * The store's identity, which on AlloyDB reaches all the way down to the
   * PostgreSQL database: one instance holds several, and two of them are two
   * stores.
   */
  name: string;
  project: string;
  location: string;
  cluster: string;
  instance: string;
  database: string;
}


/** A BigQuery dataset. A real store, but not one an action writes to. */
export interface BigQueryStore {
  kind: 'bigquery';
  /** `projects/<p>/datasets/<d>`. The store's identity. */
  name: string;
  project: string;
  dataset: string;
}


export type Store = SpannerStore|AlloyDbStore|BigQueryStore;


// A Spanner table an entity is bound to.
const SPANNER_TABLE_SOURCE =
    /^\/\/spanner\.googleapis\.com\/projects\/([A-Za-z0-9_-]+)\/instances\/([A-Za-z0-9_-]+)\/databases\/([A-Za-z0-9_-]+)\/tables\/.+$/;

// An AlloyDB table an entity is bound to.
const ALLOYDB_TABLE_SOURCE =
    /^\/\/alloydb\.googleapis\.com\/projects\/([A-Za-z0-9_-]+)\/locations\/([A-Za-z0-9_-]+)\/clusters\/([A-Za-z0-9_-]+)\/instances\/([A-Za-z0-9_-]+)\/databases\/([A-Za-z0-9_-]+)\/tables\/.+$/;

// A BigQuery table an entity is bound to. The loader rewrites the resource-name
// URI an author may write into `project.dataset.table`, which is the form the
// generator emits and the only one that reaches here.
const BIGQUERY_TABLE_SOURCE =
    /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+$/;


// The store identity a bound table sits in, or undefined when the source names
// no table of any backend this module knows.
function storeOf(source: string): string|undefined {
  const spanner = source.match(SPANNER_TABLE_SOURCE);
  if (spanner) {
    return `projects/${spanner[1]}/instances/${spanner[2]}/databases/${
        spanner[3]}`;
  }
  const alloyDb = source.match(ALLOYDB_TABLE_SOURCE);
  if (alloyDb) {
    return `projects/${alloyDb[1]}/locations/${alloyDb[2]}/clusters/${
        alloyDb[3]}/instances/${alloyDb[4]}/databases/${alloyDb[5]}`;
  }
  const bigQuery = source.match(BIGQUERY_TABLE_SOURCE);
  if (bigQuery) return `projects/${bigQuery[1]}/datasets/${bigQuery[2]}`;
  return undefined;
}


// Every table the model binds, not just its entities: a many-to-many
// relationship is backed by a junction table of its own, and an action that
// creates the edge writes to exactly that one.
function boundTables(model: SemanticModel): Array<{name: string; source: string}> {
  const bindings: Array<{name: string; source: string}> = [];
  for (const entity of model.entities ?? []) {
    bindings.push({name: entity.name, source: entity.dataSource ?? ''});
  }
  for (const relationship of model.relationships ?? []) {
    const source = relationship.association?.dataSource;
    if (source) bindings.push({name: relationship.name, source});
  }
  return bindings;
}


// Bindings that address something other than the store the deployment target
// names. An action's statements address a table by its NAME, with the
// project/instance/database qualifier dropped, so an entity bound elsewhere
// would produce a statement against whatever table of that name the target
// store happens to hold.
function strayBindings(model: SemanticModel, store: string): string[] {
  const strays: string[] = [];
  for (const binding of boundTables(model)) {
    const source = binding.source.trim();
    if (!source) continue;
    const bound = storeOf(source);
    if (!bound) {
      strays.push(
          `'${binding.name}' to ${source}, which is not a table in this store`);
      continue;
    }
    if (bound !== store) strays.push(`'${binding.name}' to ${source}`);
  }
  return strays;
}


/**
 * The store a model runs against: whatever this profile's deployment target
 * names.
 *
 * Fails three ways: the profile names more than one target, so which store is
 * meant is ambiguous; it names none, so there is nothing to run against; or it
 * names one but binds an entity somewhere else, so a write would land in the
 * wrong place.
 */
export function resolveStore(model: SemanticModel): Store|{error: string} {
  const {spanner, alloyDb, bigQuery, malformed} =
      googleDeploymentTargets(model);
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
    return {
      error: `Model '${model.name}' declares ${what} under this profile, so ` +
          `which store it runs against is ambiguous. Give each its own ` +
          `profile.`,
    };
  }
  if (!declared) {
    return {
      error: `Model '${model.name}' declares no deployment target under this ` +
          `profile, so there is no store to run against` +
          (malformed.length ?
               ` (it declares ${malformed.length} target ${
                   malformed.length === 1 ? 'URI' :
                                            'URIs'} that name no supported ` +
                   `destination: ${malformed.join(', ')})` :
               '') +
          `. Select a profile whose deployment target names a database.`,
    };
  }

  const store = storeFor(spanner[0], alloyDb[0], bigQuery[0]);

  const strays = strayBindings(model, store.name);
  if (strays.length) {
    return {
      error: `Model '${model.name}' binds ${strays.join(', ')}, but its ` +
          `deployment target is ${store.name}. An action's statements ` +
          `address a table by name alone, so the write would land in the ` +
          `target store's table of that name rather than in the bound one. ` +
          `Bind both to the same store.`,
    };
  }
  return store;
}


function storeFor(
    spanner: {project: string; instance: string; database: string}|undefined,
    alloyDb: {
      project: string; location: string; cluster: string; instance: string;
      database: string
    }|undefined,
    bigQuery: {project: string; dataset: string}|undefined): Store {
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
          alloyDb.location}/clusters/${alloyDb.cluster}/instances/${
          alloyDb.instance}/databases/${alloyDb.database}`,
      project: alloyDb.project,
      location: alloyDb.location,
      cluster: alloyDb.cluster,
      instance: alloyDb.instance,
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


/**
 * Why this store cannot run SQL DML statements, or null when it is an
 * operational database (Spanner or AlloyDB).
 */
export function operationalStoreError(store: Store): string|null {
  if (store.kind === 'spanner' || store.kind === 'alloydb') return null;
  return `This profile deploys to the BigQuery dataset ${store.name}, and ` +
      `an action's statements run against an operational database. Select ` +
      `a profile whose deployment target is a Spanner or AlloyDB database.`;
}
