// The store a model's data lives in, and a client on it.
//
// A binding profile supplies a deployment target; this module turns that
// declaration into something callable. Which backend it is belongs in the
// answer rather than in the caller's assumptions: a profile may deploy to
// Spanner or to BigQuery, and what may be done with the result differs by
// which. `kind` is the discriminant, so a caller that needs to write asks for
// a Spanner store instead of discovering at its first statement that it holds
// a dataset.
//
// Identity is `name`, the resource the store addresses. Two profiles naming
// the same database describe ONE store; the profile is how a caller found it,
// not what it is.

import {BigQueryClient} from '../../gcp/bigquery';
import * as context from '../../gcp/context';
import {SpannerDataClient} from '../../gcp/spanner';

import {googleDeploymentTargets} from '../deployment_target';
import {SemanticModel} from '../ir';


/** A Spanner database. The only backend an action can write to today. */
export interface SpannerStore {
  kind: 'spanner';
  /** `projects/<p>/instances/<i>/databases/<d>`. The store's identity. */
  name: string;
  project: string;
  instance: string;
  database: string;
  client: SpannerDataClient;
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


export type Store = SpannerStore|BigQueryStore;


// A Spanner table an entity is bound to.
const SPANNER_TABLE_SOURCE =
    /^\/\/spanner\.googleapis\.com\/projects\/([A-Za-z0-9_-]+)\/instances\/([A-Za-z0-9_-]+)\/databases\/([A-Za-z0-9_-]+)\/tables\/.+$/;

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
  const {spanner, bigQuery, malformed} = googleDeploymentTargets(model);
  const declared = spanner.length + bigQuery.length;

  // Ambiguity is per backend, not across them. A model may publish its graph
  // to BigQuery for analysis and to Spanner for operations under one profile,
  // and that pair names one store to run against rather than two: Spanner is
  // the only backend an action writes to, so it is the operational store and
  // the BigQuery target is a second destination for the same model. Two
  // targets of the SAME backend is the case nothing can decide.
  const operational = spanner.length ? spanner : bigQuery;
  if (operational.length > 1) {
    const backend = spanner.length ? 'Spanner' : 'BigQuery';
    return {
      error: `Model '${model.name}' declares ${operational.length} ${
          backend} deployment targets under this profile, so which store it ` +
          `runs against is ambiguous. Give each its own profile.`,
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
  const store: Store = spanner.length ? {
    kind: 'spanner',
    name: `projects/${spanner[0].project}/instances/${
        spanner[0].instance}/databases/${spanner[0].database}`,
    project: spanner[0].project,
    instance: spanner[0].instance,
    database: spanner[0].database,
    client: new SpannerDataClient(
        api, spanner[0].project, spanner[0].instance, spanner[0].database),
  } :
                                        {
                                          kind: 'bigquery',
                                          name: `projects/${
                                              bigQuery[0].project}/datasets/${
                                              bigQuery[0].dataset}`,
                                          project: bigQuery[0].project,
                                          dataset: bigQuery[0].dataset,
                                          client: new BigQueryClient(api),
                                        };

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


/**
 * The Spanner client an action or a lookup needs, or why this store cannot
 * supply one. Both are executed as GoogleSQL inside a Spanner transaction, so
 * a BigQuery store is a store this path cannot use -- which is a different
 * answer from having no store at all, and is worth saying differently.
 */
export function spannerClientFor(store: Store): SpannerDataClient|
    {error: string} {
  if (store.kind === 'spanner') return store.client;
  return {
    error: `This profile deploys to the BigQuery dataset ${store.name}, and ` +
        `an action's statements run against Spanner. Select a profile whose ` +
        `deployment target is a Spanner database.`,
  };
}
