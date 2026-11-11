// Behavior specification for resolving a model's store.
//
// The claim under test is that a model says where it lives and nothing else
// does. A caller -- the CLI, an agent, a setup script -- asks the model and
// gets one answer, and a model whose bindings disagree with its deployment
// target gets a refusal rather than a write into whichever database happened
// to be named last.
//
// Nothing here opens a connection. Deciding where to write is pure, and the
// AlloyDB instance listing is mocked.

import {describe, expect, spyOn, test} from 'bun:test';

import {AlloyDbClient, Instance} from '../../../../src/libts/gcp/alloydb';
import * as api from '../../../../src/libts/gcp/api';
import {ApiContext} from '../../../../src/libts/gcp/context';
import {SemanticModel} from '../../../../src/libts/semantic/ir';
import {loadModels} from '../../../../src/libts/semantic/loader';
import {AlloyDbDatabase, resolveStore, storeLine, withPrimaryInstance} from '../../../../src/libts/semantic/runtime/store';

const DB = 'spanner.googleapis.com/projects/p/instances/i/databases/d';
const DATASET = 'bigquery.googleapis.com/projects/p/datasets/s';
const PG =
    'alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c/databases/d';
const PG_TABLE = `${PG}/schemas/public/tables/customer`;

function model(body: string): SemanticModel {
  const loaded = loadModels(
      `version: "0.2.0.dev0/google"\nsemantic_model:\n  - name: m\n${body}`,
      {bindingOptional: true});
  return loaded.models[0];
}

function bound(target: string, source: string): SemanticModel {
  return model(
      `    deployments:\n      - {name: default, target: "${target}"}\n` +
      `    entities:\n` +
      `      - name: Customer\n` +
      `        primary_key: [id]\n` +
      `        source: ${source}\n` +
      `        fields:\n` +
      `          - {name: id, datatype: Integer, expression: id}\n`);
}


describe('where a model says it lives', () => {
  test('the deployment target is the store, split into its parts', () => {
    const store =
        resolveStore(bound(`${DB}/graphs/g`, `${DB}/tables/Customer`));
    if ('error' in store) throw new Error(store.error);
    expect(store.kind).toBe('spanner');
    if (store.kind !== 'spanner') return;
    expect(store.project).toBe('p');
    expect(store.instance).toBe('i');
    expect(store.database).toBe('d');
    expect(store.name).toBe('projects/p/instances/i/databases/d');
  });

  test('a BigQuery target is a store like any other', () => {
    const store = resolveStore(
        bound(`${DATASET}/propertyGraphs/g`, `${DATASET}/tables/Customer`));
    if ('error' in store) throw new Error(store.error);
    expect(store.kind).toBe('bigquery');
    if (store.kind !== 'bigquery') return;
    expect(store.project).toBe('p');
    expect(store.dataset).toBe('s');
    expect(store.name).toBe('projects/p/datasets/s');
  });

  test('an AlloyDB target is a store, down to the database', () => {
    const store = resolveStore(bound(PG, PG_TABLE));
    if ('error' in store) throw new Error(store.error);
    expect(store.kind).toBe('alloydb');
    if (store.kind !== 'alloydb') return;
    expect(store.project).toBe('p');
    expect(store.location).toBe('us-central1');
    expect(store.cluster).toBe('c');
    expect(store.database).toBe('d');
    expect(store.name).toBe(
        'projects/p/locations/us-central1/clusters/c/databases/d');
  });

  // An AlloyDB target names a DATABASE, not a graph, because AlloyDB has no
  // property-graph DDL to address. A URI carrying a graph segment names
  // nothing that could be created, so it is not quietly accepted.
  test('an AlloyDB target with a graph segment is not a target at all', () => {
    const store =
        resolveStore(bound(`${PG}/propertyGraphs/g`, PG_TABLE));
    expect('error' in store).toBe(true);
    if (!('error' in store)) return;
    expect(store.error).toContain(
        'which is not a BigQuery graph, a Spanner graph or an AlloyDB database');
    expect(store.error).toContain('propertyGraphs/g');
  });

  test('a model with no deployment target has no store', () => {
    const store = resolveStore(model(
        `    entities:\n` +
        `      - name: Customer\n` +
        `        primary_key: [id]\n` +
        `        fields:\n` +
        `          - {name: id, datatype: Integer, expression: id}\n`));
    expect('error' in store).toBe(true);
    if (!('error' in store)) return;
    expect(store.error).toContain('no deployment target');
  });
});


describe('a binding that disagrees with the target', () => {
  // An action's statements name a table and drop the qualifier, so a write
  // against a stray binding still runs -- against whatever table of that name
  // the TARGET store holds. Nothing downstream would report it, which is why
  // it is refused here.
  test('an entity bound to another database is refused, and both are named',
       () => {
         const other =
             'spanner.googleapis.com/projects/p/instances/i/databases/other';
         const store = resolveStore(
             bound(`${DB}/graphs/g`, `${other}/tables/Customer`));
         expect('error' in store).toBe(true);
         if (!('error' in store)) return;
         expect(store.error).toContain('databases/other');
         expect(store.error).toContain('deployment target is projects/p');
       });

  test('an entity bound to another system is refused for the same reason',
       () => {
         const store = resolveStore(bound(
             `${DB}/graphs/g`, `${DATASET}/tables/Customer`));
         expect('error' in store).toBe(true);
         if (!('error' in store)) return;
         expect(store.error).toContain(`'Customer' to ${DATASET}/tables/Customer`);
         expect(store.error)
             .toContain('projects/p/instances/i/databases/d');
       });

  test('an entity this profile binds to nothing is not a mis-binding', () => {
    // Declared and unbound is a model that has not been given a table yet.
    // The statements report that themselves, naming the table they could not
    // find; refusing here would refuse a logical model for being logical.
    const store = resolveStore(model(
        `    deployments:\n      - {name: default, target: "${DB}/graphs/g"}\n` +
        `    entities:\n` +
        `      - name: Customer\n` +
        `        primary_key: [id]\n` +
        `        fields:\n` +
        `          - {name: id, datatype: Integer}\n`));
    expect('error' in store).toBe(false);
  });

  // A BigQuery graph may read tables in another dataset, and push accepts
  // that, so the store gives none and does not fail.
  test('a BigQuery table in another dataset gives no store and does not fail it',
       () => {
         const store = resolveStore(bound(
             `${DATASET}/propertyGraphs/g`,
             'bigquery.googleapis.com/projects/p/datasets/raw/tables/customer'));
         expect(store).toEqual({
           error: expect.stringContaining(
               "binds 'Customer' to bigquery.googleapis.com/projects/p/datasets/raw/tables/customer"),
         });
       });
});


// A model may name more than one destination: the same graph published to
// BigQuery for analysis and to Spanner for operations is one model deployed
// twice, not two models. Which of those is the store an action runs against is
// not in doubt -- only Spanner accepts a write -- so the pair resolves. Two
// destinations of the SAME backend is the case nothing here can decide.
describe('a model that declares more than one deployment target', () => {
  // A vanilla model, whose deployments sit in a GOOGLE block.
  function targets(uris: string[], source: string): SemanticModel {
    return {
      ...bound(`${DB}/graphs/g`, source),
      version: '0.2.0.dev0',
      deployments: uris.length ?
          uris.map((target, i) => ({name: `d_${i + 1}`, target})) :
          undefined,
    };
  }

  test('Spanner alongside BigQuery resolves to the Spanner store', () => {
    const store = resolveStore(targets(
        [`${DB}/graphs/g`, `${DATASET}/propertyGraphs/g`],
        `${DB}/tables/Customer`));
    if ('error' in store) throw new Error(store.error);
    expect(store.kind).toBe('spanner');
    expect(store.name).toBe('projects/p/instances/i/databases/d');
  });

  test('two Spanner targets is ambiguous, and the message says which backend',
       () => {
         const store = resolveStore(targets(
             [`${DB}/graphs/g`, `spanner.googleapis.com/projects/p/instances/i/databases/d2/graphs/g`],
             `${DB}/tables/Customer`));
         expect('error' in store).toBe(true);
         if (!('error' in store)) return;
         expect(store.error).toContain('2 Spanner deployment targets');
         expect(store.error)
             .toContain('in its GOOGLE block\'s \'deployments\'');
         expect(store.error).toContain('the runtime uses exactly one deployment for now.');
       });

  // Ambiguity is about ROLE, not about backend. Spanner alongside AlloyDB is
  // two targets that could each serve the same one -- both hold the rows, both
  // take the write -- so it is as undecidable as two of either, and the message
  // has to name both rather than reporting "2 Spanner" or picking a winner.
  test('Spanner alongside AlloyDB is ambiguous, and both are named', () => {
    const store = resolveStore(
        targets([`${DB}/graphs/g`, PG], `${DB}/tables/Customer`));
    expect('error' in store).toBe(true);
    if (!('error' in store)) return;
    expect(store.error).toContain('1 Spanner and 1 AlloyDB');
    expect(store.error).toContain('two operational backends');
    expect(store.error).toContain('in its GOOGLE block\'s \'deployments\'');
    expect(store.error).toContain('the runtime uses exactly one deployment for now.');
  });

  test('AlloyDB alongside BigQuery resolves to the AlloyDB store', () => {
    const store = resolveStore(
        targets([PG, `${DATASET}/propertyGraphs/g`], PG_TABLE));
    if ('error' in store) throw new Error(store.error);
    expect(store.kind).toBe('alloydb');
  });

  test('two BigQuery targets is ambiguous in the same way', () => {
    const store = resolveStore(targets(
        [`${DATASET}/propertyGraphs/g`, `bigquery.googleapis.com/projects/p/datasets/s2/propertyGraphs/g`],
        `${DATASET}/tables/Customer`));
    expect('error' in store).toBe(true);
    if (!('error' in store)) return;
    expect(store.error).toContain('2 BigQuery deployment targets');
  });

  // A vanilla model with no target is told how to list a deployment in a
  // GOOGLE block.
  test('a vanilla model with no target is told about deployments', () => {
    expect(resolveStore(targets([], `${DB}/tables/Customer`))).toEqual({
      error: "Model 'm' declares no deployment target in 'deployments', so " +
          'there is no store to run against. In a GOOGLE custom_extensions ' +
          "block on the model, declare a deployment in 'deployments' whose " +
          'target names a database.',
    });
  });

  // Push rejects each of these models, so the store fails rather than being
  // none.
  test('a target in no accepted form is reported, alone or beside one that gives a store',
       () => {
         const typo =
             'spanner.googleapis.com/projects/p/instance/i/databases/d/graphs/g';
         const notAccepted = (name: string) => ({
           error: `Model 'm': deployment '${name}' targets '${typo}', which ` +
               `is not a BigQuery graph, a Spanner graph or an AlloyDB ` +
               `database. Write a GCP resource name: ` +
               `'bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>', ` +
               `'spanner.googleapis.com/projects/<p>/instances/<i>/databases/<db>/graphs/<g>' ` +
               `or 'alloydb.googleapis.com/projects/<p>/locations/<l>/clusters/<c>/databases/<db>'.`,
           named: true,
           rejected: true,
         });
         expect(resolveStore(targets(
                    [`${DB}/graphs/g`, typo], `${DB}/tables/Customer`)))
             .toEqual(notAccepted('d_2'));
         expect(resolveStore(targets([typo], `${DB}/tables/Customer`)))
             .toEqual(notAccepted('d_1'));
         expect(resolveStore(targets(
                    ['spanner:graph:p.regional-us.i.d.g'],
                    `${DB}/tables/Customer`)))
             .toEqual({
               error: `Model 'm': deployment 'd_1' targets ` +
                   `'spanner:graph:p.regional-us.i.d.g', which is a Knowledge ` +
                   `Catalog name. Write the GCP resource name instead: ` +
                   `'spanner.googleapis.com/projects/<p>/instances/<i>/databases/<db>/graphs/<g>'.`,
               named: true,
               rejected: true,
             });
       });
});


// A model names its stores in `deployments:`, each for the profile it names or
// for `default` when it names none. The runtime asks for one profile's store.
describe('the store a profile uses', () => {
  const BQ_GRAPH = `${DATASET}/propertyGraphs/g`;
  const SPANNER_GRAPH = `${DB}/graphs/g`;
  const CLUSTER_DB =
      'alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c/databases/d';

  function deployed(entries: string, source = ''): SemanticModel {
    return model(
        `    deployments:\n${entries}` +
        `    entities:\n` +
        `      - name: Customer\n` +
        `        primary_key: [id]\n` +
        (source ? `        source: ${source}\n` : '') +
        `        fields:\n` +
        `          - {name: id, datatype: Integer, expression: id}\n`);
  }

  const threeProfiles = deployed(
      `      - {name: bq_prod, target: "${BQ_GRAPH}", profile: analytical}\n` +
      `      - {name: spanner_prod, target: "${SPANNER_GRAPH}", profile: operational}\n` +
      `      - {name: alloy_prod, target: "${CLUSTER_DB}"}\n`);

  test('each profile takes the deployment that names it', () => {
    const operational = resolveStore(threeProfiles, 'operational');
    if ('error' in operational) throw new Error(operational.error);
    expect(operational.name).toBe('projects/p/instances/i/databases/d');
    const analytical = resolveStore(threeProfiles, 'analytical');
    if ('error' in analytical) throw new Error(analytical.error);
    expect(analytical.name).toBe('projects/p/datasets/s');
  });

  test('default takes the deployment that names no profile', () => {
    const store = resolveStore(threeProfiles, 'default');
    if ('error' in store) throw new Error(store.error);
    expect(store.kind).toBe('alloydb');
    if (store.kind !== 'alloydb') return;
    // A cluster target names no instance; the runtime finds it.
    expect('instance' in store).toBe(false);
    expect(store.name).toBe('projects/p/locations/us-central1/clusters/c/databases/d');
  });

  test('a profile no deployment uses has no store', () => {
    const store = resolveStore(threeProfiles, 'staging');
    expect('error' in store && store.error)
        .toBe(
            "binding profile 'staging' is a named profile, which names no " +
            "deployment target, and no deployment in 'deployments' uses it, so " +
            'there is no database to run it against');
  });

  test('default has no store when every deployment names a profile', () => {
    const store = resolveStore(
        deployed(
            `      - {name: bq_prod, target: "${BQ_GRAPH}", profile: analytical}\n`),
        'default');
    expect('error' in store && store.error)
        .toContain(
            "Model 'm' declares no deployment without a 'profile' in " +
            "'deployments'");
  });

  test('of several, the single operational store is taken', () => {
    const store = resolveStore(
        deployed(
            `      - {name: bq_prod, target: "${BQ_GRAPH}"}\n` +
                `      - {name: spanner_prod, target: "${SPANNER_GRAPH}"}\n`,
            `${DB}/tables/Customer`),
        'default');
    if ('error' in store) throw new Error(store.error);
    expect(store.kind).toBe('spanner');
  });

  test('several with no single operational store fail, naming them', () => {
    const store = resolveStore(
        deployed(
            `      - {name: spanner_a, target: "${SPANNER_GRAPH}", profile: operational}\n` +
            `      - {name: spanner_b, target: "${DB}2/graphs/g", profile: operational}\n` +
            `      - {name: spanner_c, target: "${DB}3/graphs/g"}\n`),
        'operational');
    expect('error' in store && store.error)
        .toContain(
            "declares 2 Spanner deployment targets in 'deployments' for " +
            "profile 'operational' (spanner_a, spanner_b), so which store it " +
            'runs against is ambiguous');
  });

  // A vanilla model whose GOOGLE block holds `data`.
  function vanillaModel(data: object): SemanticModel {
    return loadModels(
        `version: "0.2.0.dev0"\nsemantic_model:\n  - name: m\n` +
        `    custom_extensions:\n` +
        `      - vendor_name: GOOGLE\n` +
        `        data: '${JSON.stringify(data)}'\n` +
        `    datasets:\n` +
        `      - name: Customer\n` +
        `        source: ${DB}/tables/Customer\n` +
        `        primary_key: [id]\n` +
        `        fields:\n` +
        `          - name: id\n` +
        `            expression: {dialects: [{dialect: SPANNER, expression: id}]}\n`)
        .models[0];
  }

  // A vanilla model lists its deployments in its GOOGLE block, and the
  // messages say so, as push's do.
  test('several block deployments of a vanilla model fail, naming the block', () => {
    const vanilla = vanillaModel({
      deployments: [
        {name: 'spanner_a', target: SPANNER_GRAPH},
        {name: 'spanner_b', target: `${DB}2/graphs/g`},
      ],
    });
    const store = resolveStore(vanilla, 'default');
    expect('error' in store && store.error)
        .toContain(
            "declares 2 Spanner deployment targets in its GOOGLE block's " +
            "'deployments' for profile 'default' (spanner_a, spanner_b), so " +
            'which store it runs against is ambiguous');
  });

  test('default has no store when every block deployment names a profile, naming the block', () => {
    const vanilla = vanillaModel({
      profiles: [{name: 'operational'}],
      deployments: [{name: 'spanner_a', target: SPANNER_GRAPH, profile: 'operational'}],
    });
    const store = resolveStore(vanilla, 'default');
    expect('error' in store && store.error)
        .toBe(
            "Model 'm' declares no deployment without a 'profile' in its " +
            "GOOGLE block's 'deployments', so there is no store to run " +
            "against under binding profile 'default'.");
  });

  test('a block profile no block deployment uses has no store, naming the block', () => {
    const vanilla = vanillaModel({
      profiles: [{name: 'operational'}, {name: 'staging'}],
      deployments: [{name: 'spanner_a', target: SPANNER_GRAPH, profile: 'operational'}],
    });
    const store = resolveStore(vanilla, 'staging');
    expect('error' in store && store.error)
        .toBe(
            "binding profile 'staging' is a named profile, which names no " +
            "deployment target, and no deployment in its GOOGLE block's " +
            "'deployments' uses it, so there is no database to run it against");
  });

  test('a deployment that names no destination is reported beside one that does',
       () => {
         const typo =
             'spanner.googleapis.com/projects/p/instance/i/databases/d/graphs/g';
         const store = resolveStore(
             deployed(
                 `      - {name: good, target: "${SPANNER_GRAPH}"}\n` +
                     `      - {name: bad, target: "${typo}"}\n`,
                 `${DB}/tables/Customer`),
             'default');
         expect('error' in store && store.error)
             .toContain(
                 `Model 'm': deployment 'bad' targets '${typo}', which is ` +
                 'not a BigQuery graph, a Spanner graph or an AlloyDB database');
       });

  test('a lone deployment in no accepted form is reported the same way', () => {
    const target = 'bigquery:graph:p.s.g';
    const store = resolveStore(
        deployed(`      - {name: prod, target: "${target}"}\n`), 'default');
    expect(store).toEqual({
      error: `Model 'm': deployment 'prod' targets '${target}', which is a ` +
          `Knowledge Catalog name. Write the GCP resource name instead: ` +
          `'bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>'.`,
      named: true,
      rejected: true,
    });
  });

  // A vanilla model keeps its deployments in a GOOGLE block, and one that
  // names no profile is for the model's own bindings.
  test('a GOOGLE block deployment with no profile gives no store to a named profile', () => {
    const vanilla: SemanticModel = {
      ...deployed(`      - {name: x, target: "${SPANNER_GRAPH}"}\n`),
      version: '0.2.0.dev0',
    };
    expect(resolveStore(vanilla, 'prod'))
        .toEqual({
          error: "binding profile 'prod' is a named profile, which names no " +
              "deployment target, and no deployment in its GOOGLE block's " +
              "'deployments' uses it, so there is no database to run it " +
              'against',
        });
    const store = resolveStore(vanilla, 'default');
    if ('error' in store) throw new Error(store.error);
    expect(store.kind).toBe('spanner');
  });

  // An empty list names no deployment, the same as no list.
  test('an empty deployments list gives no store to a named profile', () => {
    const emptyDeployments: SemanticModel = {...threeProfiles, deployments: []};
    expect(resolveStore(emptyDeployments, 'prod'))
        .toEqual({
          error: "binding profile 'prod' is a named profile, which names no " +
              'deployment target, so there is no database to run it against',
        });
  });
});


describe('an AlloyDB source', () => {
  const CLUSTER =
      'alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c';

  function alloyModel(target: string, source: string): SemanticModel {
    return model(
        `    deployments:\n` +
        `      - {name: alloy_prod, target: "${target}"}\n` +
        `    entities:\n` +
        `      - name: Customer\n` +
        `        primary_key: [id]\n` +
        `        source: ${source}\n` +
        `        fields:\n` +
        `          - {name: id, datatype: Integer, expression: id}\n`);
  }

  test('written as a table resource name, matches a target with the same cluster and database',
       () => {
         const store = resolveStore(alloyModel(
             `${CLUSTER}/databases/d`,
             `${CLUSTER}/databases/d/schemas/public/tables/customer`));
         if ('error' in store) throw new Error(store.error);
         expect(store.kind).toBe('alloydb');
       });

  test('in another database of the cluster is refused', () => {
    const store = resolveStore(alloyModel(
        `${CLUSTER}/databases/d`,
        `${CLUSTER}/databases/other/schemas/public/tables/customer`));
    expect('error' in store && store.error)
        .toContain("'Customer' to " + `${CLUSTER}/databases/other`);
  });
});


// A connection to an AlloyDB database goes through an instance, and a cluster
// target names none. The cluster's primary instance is the one to use.
describe('the instance an AlloyDB store connects through', () => {
  const CTX = new ApiContext('test-project', 'us', 'test-token');
  const CLUSTER = 'projects/p/locations/us-central1/clusters/c';
  const store: AlloyDbDatabase = {
    kind: 'alloydb',
    name: `${CLUSTER}/databases/d`,
    project: 'p',
    location: 'us-central1',
    cluster: 'c',
    database: 'd',
  };

  function clientListing(result: api.ApiResult<Instance[]>): AlloyDbClient {
    const client = new AlloyDbClient(CTX);
    spyOn(client, 'listInstances').mockResolvedValue(result);
    return client;
  }

  test('is the cluster\'s primary instance', async () => {
    const client = clientListing({
      status: 200,
      result: [
        {name: `${CLUSTER}/instances/reader`, instanceType: 'READ_POOL'},
        {
          name: `${CLUSTER}/instances/main`,
          instanceType: 'PRIMARY',
          state: 'READY',
        },
      ],
    });
    const found = await withPrimaryInstance(store, client);
    if ('error' in found) throw new Error(found.error);
    expect(found.kind === 'alloydb' && found.instance).toBe('main');
    expect(storeLine(found)).toBe('alloydb:p/us-central1/c/main/d');
    expect(client.listInstances).toHaveBeenCalledWith('p', 'us-central1', 'c');
  });

  test('a cluster with no primary instance fails, naming the cluster',
       async () => {
         const found = await withPrimaryInstance(
             store, clientListing({
               status: 200,
               result: [{
                 name: `${CLUSTER}/instances/reader`,
                 instanceType: 'READ_POOL',
               }],
             }));
         expect('error' in found && found.error)
             .toBe(
                 `AlloyDB cluster '${CLUSTER}' has no primary instance, so ` +
                 `there is no instance to connect to database 'd' through.`);
       });

  test('a primary instance that is not READY fails, naming its state',
       async () => {
         const found = await withPrimaryInstance(store, clientListing({
           status: 200,
           result: [{
             name: `${CLUSTER}/instances/main`,
             instanceType: 'PRIMARY',
             state: 'STOPPED',
           }],
         }));
         expect('error' in found && found.error)
             .toBe(
                 `AlloyDB cluster '${CLUSTER}' has primary instance 'main' in ` +
                 `state STOPPED; it must be READY to connect to database 'd' ` +
                 `through it.`);
       });

  test('a failed listing says why', async () => {
    const found = await withPrimaryInstance(store, clientListing({
      status: 404,
      message: "Resource 'clusters/c' was not found",
    }));
    expect('error' in found && found.error)
        .toBe(
            `Could not list the instances of AlloyDB cluster '${CLUSTER}': ` +
            `404 Resource 'clusters/c' was not found`);
  });

  test('a listing that cannot be sent says why', async () => {
    const client = new AlloyDbClient(CTX);
    spyOn(client, 'listInstances').mockRejectedValue(new Error('fetch failed'));
    expect(await withPrimaryInstance(store, client))
        .toEqual({
          error: `Could not list the instances of AlloyDB cluster '${
              CLUSTER}': fetch failed`,
        });
  });

  test('every page of the listing is read', async () => {
    const client = new AlloyDbClient(CTX);
    const get = spyOn(client as any, '_get')
                    .mockResolvedValueOnce({
                      status: 200,
                      result: {
                        instances: [{
                          name: `${CLUSTER}/instances/reader`,
                          instanceType: 'READ_POOL',
                        }],
                        nextPageToken: 'T',
                      },
                    })
                    .mockResolvedValueOnce({
                      status: 200,
                      result: {
                        instances: [{
                          name: `${CLUSTER}/instances/main`,
                          instanceType: 'PRIMARY',
                          state: 'READY',
                        }],
                      },
                    });
    const found = await withPrimaryInstance(store, client);
    if ('error' in found) throw new Error(found.error);
    expect(found.kind === 'alloydb' && found.instance).toBe('main');
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[0][0]).toBe(`${CLUSTER}/instances`);
    expect((get.mock.calls[1][1] as any).pageToken).toBe('T');
  });

  test('a failed page of the listing says why', async () => {
    const client = new AlloyDbClient(CTX);
    spyOn(client as any, '_get')
        .mockResolvedValueOnce({
          status: 200,
          result: {
            instances: [
              {name: `${CLUSTER}/instances/reader`, instanceType: 'READ_POOL'},
            ],
            nextPageToken: 'T',
          },
        })
        .mockResolvedValueOnce({status: 403, message: 'Permission denied'});
    expect(await withPrimaryInstance(store, client))
        .toEqual({
          error: `Could not list the instances of AlloyDB cluster '${
              CLUSTER}': 403 Permission denied`,
        });
  });

  test('a failed listing gives its message whole', async () => {
    const message = `Invalid cluster: ${'x'.repeat(2500)}`;
    const found = await withPrimaryInstance(
        store, clientListing({status: 400, message}));
    expect('error' in found && found.error)
        .toBe(`Could not list the instances of AlloyDB cluster '${
            CLUSTER}': 400 ${message}`);
  });

  test('a failed page comes back with its body', async () => {
    const client = new AlloyDbClient(CTX);
    const failed = {status: 403, message: 'Permission denied', body: '{}'};
    spyOn(client as any, '_get').mockResolvedValue(failed);
    expect(await client.listInstances('p', 'us-central1', 'c')).toEqual(failed);
  });

  test('a listing that repeats a page token stops and says why', async () => {
    const client = new AlloyDbClient(CTX);
    let calls = 0;
    // Gives up after ten pages, so a listing that does not stop fails here
    // and does not hang.
    spyOn(client as any, '_get').mockImplementation(async () => {
      calls++;
      return {
        status: 200,
        result: {
          instances: [],
          ...(calls < 10 ? {nextPageToken: 'same'} : {}),
        },
      };
    });
    expect(await withPrimaryInstance(store, client))
        .toEqual({
          error: `Could not list the instances of AlloyDB cluster '${
              CLUSTER}': the AlloyDB API returned page token 'same' twice`,
        });
    expect(calls).toBe(2);
  });
});
