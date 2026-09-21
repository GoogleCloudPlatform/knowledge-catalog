// The store a model's data lives in, and a client on it.
//
// A binding profile supplies a deployment target; this module turns that
// declaration into something callable. Which backend it is belongs in the
// answer rather than in the caller's assumptions: a profile may deploy to
// Spanner, to AlloyDB or to BigQuery, and what may be done with the result
// differs by which. `kind` is the discriminant, so a caller that needs to write
// asks for a store that can take a write instead of discovering at its first
// statement that it holds a dataset.
//
// Two of the three are OPERATIONAL: Spanner and AlloyDB hold rows an action
// changes, and either can be the store a model runs against. They are different
// databases, reached different ways and speaking different SQL, and the
// distance between them is the point -- a model, its actions and an agent over
// them do not name a backend anywhere, so which one a deployment uses is a line
// in a binding profile. BigQuery is the third and is not operational: it is
// where a graph goes to be analyzed.
//
// Identity is `name`, the resource the store addresses. Two profiles naming
// the same database describe ONE store; the profile is how a caller found it,
// not what it is.

import {AlloyDbDataClient} from '../../gcp/alloydb';
import {BigQueryClient} from '../../gcp/bigquery';
import * as context from '../../gcp/context';
import {SpannerDataClient} from '../../gcp/spanner';

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
  client: SpannerDataClient;
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
  client: AlloyDbDataClient;
}


/** A BigQuery dataset. A real store, but not one an action writes to. */
export interface BigQueryStore {
  kind: 'bigquery';
  /** `projects/<p>/datasets/<d>`. The store's identity. */
  name: string;
  project: string;
  dataset: string;
  client: BigQueryClient;
}


export type Store = SpannerStore|AlloyDbStore|BigQueryStore;


/**
 * A client that can run a statement: the two operational backends' clients.
 *
 * They are separate classes over entirely different transports, and this union
 * is what says they answer the same questions. Both offer the same six
 * methods with the same result shape, so a caller holding one of these runs
 * statements without knowing which database it reached.
 */
export type DataClient = SpannerDataClient|AlloyDbDataClient;


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
// creates the edge writes to exactly that one. No loader produces an
// association yet, so that leg is dormant -- but the day one does, the failure
// it prevents is a write landing in a different database silently, which is
// not the kind of thing to notice afterwards.
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
// names. Checking this matters more here than in any other leg: an action's
// statements address a table by its NAME, with the project/instance/database
// qualifier dropped, so an entity bound elsewhere still produces a statement
// that runs -- against whatever table of that name the target store happens to
// hold. Nothing later would report it.
function strayBindings(model: SemanticModel, store: string): string[] {
  const strays: string[] = [];
  for (const binding of boundTables(model)) {
    const source = binding.source.trim();
    // Nothing bound is not a mis-binding: the entity is declared and this
    // profile supplies it no table, which the statements will report on their
    // own terms when they name a table that is not there.
    if (!source) continue;
    const bound = storeOf(source);
    // A source that names no table at all is the same hazard and a likelier
    // one: the statements would still run, against whatever table of that name
    // the target store holds, and the data the model describes would sit
    // untouched wherever it actually is.
    if (!bound) {
      strays.push(
          `'${binding.name}' to ${source}, which is not a table in this store`);
      continue;
    }
    // Named verbatim rather than as the store it resolves to: the reader has
    // to find this line in a profile and change it, and two entities in one
    // wrong dataset would otherwise be reported as the same string twice.
    if (bound !== store) strays.push(`'${binding.name}' to ${source}`);
  }
  return strays;
}


/**
 * The store a model runs against: whatever this profile's deployment target
 * names. No caller names it, so pointing a run at another store is selecting
 * another profile.
 *
 * Fails three ways, each a different question for the reader: the profile
 * names more than one target, so which store is meant is ambiguous; it names
 * none, so there is nothing to run against; or it names one but binds an
 * entity somewhere else, so a write would land in the wrong place.
 */
export function resolveStore(model: SemanticModel, ctx?: context.ApiContext):
    Store|{error: string} {
  const {spanner, alloyDb, bigQuery, malformed} =
      googleDeploymentTargets(model);
  const declared = spanner.length + alloyDb.length + bigQuery.length;

  // Ambiguity is per ROLE, not per backend. A model may publish its graph to
  // BigQuery for analysis and hold its rows in an operational database under
  // one profile, and that pair names one store to run against rather than two:
  // only an operational store takes a write, so it is the one a run resolves to
  // and the BigQuery target is a second destination for the same model.
  //
  // Two targets that could each serve the SAME role is the case nothing can
  // decide -- and with a second operational backend that is no longer only two
  // of a kind. Spanner alongside AlloyDB is as undecidable as Spanner alongside
  // Spanner: both hold rows, both take writes, and nothing in the model says
  // which one this run means. So the check is over the whole operational set
  // rather than over one backend's targets, and it names what it found instead
  // of naming a single backend.
  const operational = [...spanner, ...alloyDb];
  const contenders = operational.length ? operational : bigQuery;
  if (contenders.length > 1) {
    // Several of one backend, or one each of two: the reader has a different
    // thing to look at in each case, so each is said in its own words.
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

  const api = ctx ?? context.ApiContext.default();
  const store = storeFor(spanner[0], alloyDb[0], bigQuery[0], api);

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


// Builds the store from whichever target survived the checks above. Exactly one
// of the three is defined by the time this is called.
//
// Constructing a client opens nothing -- each is a resource name and the means
// to reach it until something calls it -- so this is as cheap for AlloyDB,
// whose client does eventually hold a connection pool, as it is for the other
// two.
function storeFor(
    spanner: {project: string; instance: string; database: string}|undefined,
    alloyDb: {
      project: string; location: string; cluster: string; instance: string;
      database: string
    }|undefined,
    bigQuery: {project: string; dataset: string}|undefined,
    api: context.ApiContext): Store {
  if (spanner) {
    return {
      kind: 'spanner',
      name: `projects/${spanner.project}/instances/${
          spanner.instance}/databases/${spanner.database}`,
      project: spanner.project,
      instance: spanner.instance,
      database: spanner.database,
      client: new SpannerDataClient(
          api, spanner.project, spanner.instance, spanner.database),
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
      client: new AlloyDbDataClient(
          api, alloyDb.project, alloyDb.location, alloyDb.cluster,
          alloyDb.instance, alloyDb.database),
    };
  }
  return {
    kind: 'bigquery',
    name: `projects/${bigQuery!.project}/datasets/${bigQuery!.dataset}`,
    project: bigQuery!.project,
    dataset: bigQuery!.dataset,
    client: new BigQueryClient(api),
  };
}


/**
 * The client an action or a lookup runs statements on, or why this store
 * cannot supply one.
 *
 * Two of the three stores can: Spanner and AlloyDB both hold rows and both take
 * a write. A BigQuery store is one this path cannot use -- which is a different
 * answer from having no store at all, and is worth saying differently.
 *
 * What comes back is a client, not a backend. The caller runs statements
 * through it without asking which database answered, and that is what keeps a
 * cross-database deployment from being a second copy of the runtime.
 */
/**
 * Releases whatever the store is holding open, so a process that is finished
 * with it can end.
 *
 * Only AlloyDB holds anything. Spanner and BigQuery are reached with `fetch`,
 * which keeps nothing between calls, but AlloyDB's data plane is a pool of
 * PostgreSQL connections -- and an open socket keeps the event loop alive, so a
 * program that simply stops doing work does not exit. `kcmd` never noticed
 * because every command ends in `process.exit`; a program embedding the runtime
 * would, which is what this is for.
 *
 * Safe to call on any store, and safe to call twice.
 */
export async function closeStore(store: Store): Promise<void> {
  if (store.kind === 'alloydb') await store.client.close();
}


/**
 * How a store is written down for a reader: the resource it addresses, with
 * the backend named ahead of it for everything but Spanner, which is the one
 * an unprefixed line has always meant.
 *
 * Here rather than in whichever caller needed it first, because more than one
 * now answers "where would this land" -- the listing a person reads, the
 * `--print-store` line a script reads, and the section a generated skill writes
 * into a file that outlives the run. Two of those disagreeing is a reader sent
 * to the wrong database.
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


export function dataClientFor(store: Store): DataClient|{error: string} {
  if (store.kind === 'spanner' || store.kind === 'alloydb') return store.client;
  return {
    error: `This profile deploys to the BigQuery dataset ${store.name}, and ` +
        `an action's statements run against an operational database. Select ` +
        `a profile whose deployment target is a Spanner or AlloyDB database.`,
  };
}
