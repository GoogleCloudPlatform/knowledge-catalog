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

const DB = '//spanner.googleapis.com/projects/p/instances/i/databases/d';
const DATASET = '//bigquery.googleapis.com/projects/p/datasets/s';
const PG =
    '//alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c/instances/i/databases/d';

function model(body: string): SemanticModel {
  const loaded = loadModels(
      `version: "0.2.0.dev0/google"\nsemantic_model:\n  - name: m\n${body}`,
      {bindingOptional: true, allowLegacyBareSource: true});
  return loaded.models[0];
}

function bound(target: string, source: string): SemanticModel {
  return model(
      `    deployment_target: ${target}\n` +
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
        resolveStore(bound(`${DB}/propertyGraphs/g`, `${DB}/tables/Customer`));
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
    const store = resolveStore(bound(PG, `${PG}/tables/customer`));
    if ('error' in store) throw new Error(store.error);
    expect(store.kind).toBe('alloydb');
    if (store.kind !== 'alloydb') return;
    expect(store.project).toBe('p');
    expect(store.location).toBe('us-central1');
    expect(store.cluster).toBe('c');
    expect(store.instance).toBe('i');
    expect(store.database).toBe('d');
    // The instance-based URI names the same database as the cluster-based
    // one, so the store takes the same name.
    expect(store.name).toBe(
        'projects/p/locations/us-central1/clusters/c/databases/d');
  });

  // The instance-based URI names the instance to connect through, so it is
  // kept in either order.
  test('one AlloyDB database named by both of its URIs is one store', () => {
    const byInstance = `      - {name: by_instance, target: "${PG}"}\n`;
    const byCluster =
        `      - {name: by_cluster, target: "//alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c/databases/d"}\n`;
    for (const listed of [byInstance + byCluster, byCluster + byInstance]) {
      const store = resolveStore(model(
          `    deployments:\n` + listed +
          `    entities:\n` +
          `      - name: Customer\n` +
          `        primary_key: [id]\n` +
          `        source: ${PG}/tables/customer\n` +
          `        fields:\n` +
          `          - {name: id, datatype: Integer, expression: id}\n`));
      if ('error' in store) throw new Error(store.error);
      expect(store.kind === 'alloydb' && store.instance).toBe('i');
    }
  });

  // Two profiles that name one AlloyDB database describe one store, whichever
  // URI each uses.
  test('one AlloyDB database has one store name in every profile', () => {
    const m = model(
        `    deployments:\n` +
        `      - {name: old, target: "${PG}", profile: legacy}\n` +
        `      - {name: new, target: "//alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c/databases/d"}\n` +
        `    entities:\n` +
        `      - name: Customer\n` +
        `        primary_key: [id]\n` +
        `        source: ${PG}/tables/customer\n` +
        `        fields:\n` +
        `          - {name: id, datatype: Integer, expression: id}\n`);
    const byInstance = resolveStore(m, 'legacy');
    const byCluster = resolveStore(m, 'default');
    if ('error' in byInstance) throw new Error(byInstance.error);
    if ('error' in byCluster) throw new Error(byCluster.error);
    expect(byInstance.name)
        .toBe('projects/p/locations/us-central1/clusters/c/databases/d');
    expect(byCluster.name).toBe(byInstance.name);
  });

  // An AlloyDB target names a DATABASE, not a graph, because AlloyDB has no
  // property-graph DDL to address. A URI carrying the graph segment the other
  // two backends use names nothing that could be created, so it is not quietly
  // accepted.
  test('an AlloyDB target with a graph segment is not a target at all', () => {
    const store =
        resolveStore(bound(`${PG}/propertyGraphs/g`, `${PG}/tables/customer`));
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
             '//spanner.googleapis.com/projects/p/instances/i/databases/other';
         const store = resolveStore(
             bound(`${DB}/propertyGraphs/g`, `${other}/tables/Customer`));
         expect('error' in store).toBe(true);
         if (!('error' in store)) return;
         expect(store.error).toContain('databases/other');
         expect(store.error).toContain('deployment target is projects/p');
       });

  test('an entity bound to another system is refused for the same reason',
       () => {
         const store = resolveStore(bound(
             `${DB}/propertyGraphs/g`, `${DATASET}/tables/Customer`));
         expect('error' in store).toBe(true);
         if (!('error' in store)) return;
         expect(store.error).toContain("'Customer' to p.s.Customer");
         expect(store.error)
             .toContain('projects/p/instances/i/databases/d');
       });

  test('an entity this profile binds to nothing is not a mis-binding', () => {
    // Declared and unbound is a model that has not been given a table yet.
    // The statements report that themselves, naming the table they could not
    // find; refusing here would refuse a logical model for being logical.
    const store = resolveStore(model(
        `    deployment_target: ${DB}/propertyGraphs/g\n` +
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
             '//bigquery.googleapis.com/projects/p/datasets/raw/tables/customer'));
         expect(store).toEqual({
           error: expect.stringContaining("binds 'Customer' to p.raw.customer"),
         });
       });
});


// A model may name more than one destination: the same graph published to
// BigQuery for analysis and to Spanner for operations is one model deployed
// twice, not two models. Which of those is the store an action runs against is
// not in doubt -- only Spanner accepts a write -- so the pair resolves. Two
// destinations of the SAME backend is the case nothing here can decide.
describe('a model that declares more than one deployment target', () => {
  // A vanilla model, whose targets sit in a GOOGLE block.
  function targets(uris: string[], source: string): SemanticModel {
    return {
      ...bound(`${DB}/propertyGraphs/g`, source),
      version: '0.2.0.dev0',
      deployments: undefined,
      customExtensions: [{
        vendorName: 'GOOGLE',
        data: JSON.stringify({deploymentTargets: uris}),
      }],
    };
  }

  test('Spanner alongside BigQuery resolves to the Spanner store', () => {
    const store = resolveStore(targets(
        [`${DB}/propertyGraphs/g`, `${DATASET}/propertyGraphs/g`],
        `${DB}/tables/Customer`));
    if ('error' in store) throw new Error(store.error);
    expect(store.kind).toBe('spanner');
    expect(store.name).toBe('projects/p/instances/i/databases/d');
  });

  test('two Spanner targets is ambiguous, and the message says which backend',
       () => {
         const store = resolveStore(targets(
             [`${DB}/propertyGraphs/g`, `//spanner.googleapis.com/projects/p/instances/i/databases/d2/propertyGraphs/g`],
             `${DB}/tables/Customer`));
         expect('error' in store).toBe(true);
         if (!('error' in store)) return;
         expect(store.error).toContain('2 Spanner deployment targets');
         expect(store.error)
             .toContain("in its GOOGLE block's 'deploymentTargets'");
         expect(store.error).toContain('the runtime uses exactly one deployment for now.');
       });

  // Ambiguity is about ROLE, not about backend. Spanner alongside AlloyDB is
  // two targets that could each serve the same one -- both hold the rows, both
  // take the write -- so it is as undecidable as two of either, and the message
  // has to name both rather than reporting "2 Spanner" or picking a winner.
  test('Spanner alongside AlloyDB is ambiguous, and both are named', () => {
    const store = resolveStore(
        targets([`${DB}/propertyGraphs/g`, PG], `${DB}/tables/Customer`));
    expect('error' in store).toBe(true);
    if (!('error' in store)) return;
    expect(store.error).toContain('1 Spanner and 1 AlloyDB');
    expect(store.error).toContain('two operational backends');
    expect(store.error)
        .toContain("in its GOOGLE block's 'deploymentTargets'");
    expect(store.error).toContain('the runtime uses exactly one deployment for now.');
  });

  test('AlloyDB alongside BigQuery resolves to the AlloyDB store', () => {
    const store = resolveStore(
        targets([PG, `${DATASET}/propertyGraphs/g`], `${PG}/tables/customer`));
    if ('error' in store) throw new Error(store.error);
    expect(store.kind).toBe('alloydb');
  });

  test('two BigQuery targets is ambiguous in the same way', () => {
    const store = resolveStore(targets(
        [`${DATASET}/propertyGraphs/g`, `//bigquery.googleapis.com/projects/p/datasets/s2/propertyGraphs/g`],
        `${DATASET}/tables/Customer`));
    expect('error' in store).toBe(true);
    if (!('error' in store)) return;
    expect(store.error).toContain('2 BigQuery deployment targets');
  });

  // Only the two URIs of one AlloyDB database are merged. A target listed
  // twice in a GOOGLE block is a duplicate, which every push refuses.
  test('one Spanner graph listed twice is a duplicate target', () => {
    const store = resolveStore(targets(
        [`${DB}/propertyGraphs/g`, `${DB}/propertyGraphs/g`],
        `${DB}/tables/Customer`));
    expect('error' in store && store.error)
        .toContain(`declares duplicate deployment target '${DB}/propertyGraphs/g'`);
  });

  test('one AlloyDB URI listed twice is a duplicate target', () => {
    const store = resolveStore(targets([PG, PG], `${PG}/tables/customer`));
    expect('error' in store && store.error)
        .toContain(`declares duplicate deployment target '${PG}'`);
  });

  test('two instances of one AlloyDB database are ambiguous', () => {
    const store = resolveStore(targets(
        [PG, PG.replace('/instances/i/', '/instances/i2/')],
        `${PG}/tables/customer`));
    expect('error' in store && store.error)
        .toContain('2 AlloyDB deployment targets');
  });

  // A vanilla model cannot write 'deployments', so the message names the
  // GOOGLE block and gives no advice about 'deployments'.
  test('a GOOGLE block with no target names the block', () => {
    expect(resolveStore(targets([], `${DB}/tables/Customer`))).toEqual({
      error: "Model 'm' declares no deployment target in its GOOGLE block's " +
          "'deploymentTargets', so there is no store to run against.",
    });
  });

  // A GOOGLE block names no deployment, so the message names the block. Push
  // rejects each of these models, so the store fails rather than being none.
  test('a GOOGLE block target in no accepted form is reported, alone or beside one that gives a store',
       () => {
         const typo =
             '//spanner.googleapis.com/projects/p/instance/i/databases/d/propertyGraphs/g';
         const notAccepted = {
           error: `Model 'm': the GOOGLE custom_extension's ` +
               `'deploymentTargets' lists '${typo}', which is not a BigQuery ` +
               `graph, a Spanner graph or an AlloyDB database. Write a ` +
               `resource URI: ` +
               `'//bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>', ` +
               `'//spanner.googleapis.com/projects/<p>/instances/<i>/databases/<db>/propertyGraphs/<g>' ` +
               `or '//alloydb.googleapis.com/projects/<p>/locations/<l>/clusters/<c>/databases/<db>'.`,
           named: true,
           rejected: true,
         };
         expect(resolveStore(targets(
                    [`${DB}/propertyGraphs/g`, typo], `${DB}/tables/Customer`)))
             .toEqual(notAccepted);
         expect(resolveStore(targets([typo], `${DB}/tables/Customer`)))
             .toEqual(notAccepted);
         expect(resolveStore(targets(
                    ['spanner:graph:p.regional-us.i.d.g'],
                    `${DB}/tables/Customer`)))
             .toEqual({
               error: `Model 'm': the GOOGLE custom_extension's ` +
                   `'deploymentTargets' lists 'spanner:graph:p.regional-us.i.d.g', ` +
                   `which is a Knowledge Catalog name. Write the resource URI ` +
                   `instead: ` +
                   `'//spanner.googleapis.com/projects/<p>/instances/<i>/databases/<db>/propertyGraphs/<g>'.`,
               named: true,
               rejected: true,
             });
       });

  // Push reports the same JSON error.
  test('a GOOGLE block whose data is not valid JSON is reported, not thrown',
       () => {
         const broken: SemanticModel = {
           ...bound(`${DB}/propertyGraphs/g`, `${DB}/tables/Customer`),
           deployments: undefined,
           customExtensions: [{vendorName: 'GOOGLE', data: '{not-json'}],
         };
         expect(resolveStore(broken)).toEqual({
           error: "Model 'm': GOOGLE custom_extension 'data' is not valid JSON.",
           named: true,
           rejected: true,
         });
       });
});


// A model names its stores in `deployments:`, each for the profile it names or
// for `default` when it names none. The runtime asks for one profile's store.
describe('the store a profile uses', () => {
  const BQ_GRAPH = `${DATASET}/propertyGraphs/g`;
  const SPANNER_GRAPH = `${DB}/propertyGraphs/g`;
  const CLUSTER_DB =
      '//alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c/databases/d';

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
    expect(store.instance).toBeUndefined();
    expect(store.name).toBe('projects/p/locations/us-central1/clusters/c/databases/d');
  });

  test('a profile no deployment uses has no store', () => {
    const store = resolveStore(threeProfiles, 'staging');
    expect('error' in store && store.error)
        .toBe(
            "binding profile 'staging' is a profile file, which names no " +
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
            `      - {name: spanner_b, target: "${DB}2/propertyGraphs/g", profile: operational}\n` +
            `      - {name: spanner_c, target: "${DB}3/propertyGraphs/g"}\n`),
        'operational');
    expect('error' in store && store.error)
        .toContain(
            "declares 2 Spanner deployment targets in 'deployments' for " +
            "profile 'operational' (spanner_a, spanner_b), so which store it " +
            'runs against is ambiguous');
  });

  test('a deployment that names no destination is reported beside one that does',
       () => {
         const typo =
             '//spanner.googleapis.com/projects/p/instance/i/databases/d/propertyGraphs/g';
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
          `Knowledge Catalog name. Write the resource URI instead: ` +
          `'//bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>'.`,
      named: true,
      rejected: true,
    });
  });

  // Every AlloyDB target pushed before the cluster form holds the
  // instance-based URI, so the runtime still reads it in a list.
  test('an instance-based AlloyDB target in a list is still read', () => {
    const store = resolveStore(
        deployed(
            `      - {name: alloy_old, target: "${PG}"}\n`,
            '//alloydb.googleapis.com/projects/p/locations/us-central1/' +
                'clusters/c/databases/d/schemas/public/tables/customer'),
        'default');
    if ('error' in store) throw new Error(store.error);
    expect(store.kind === 'alloydb' && store.instance).toBe('i');
  });

  // A vanilla model keeps its targets in a GOOGLE block, which names no
  // profile, so they are for the model's own bindings.
  test('a GOOGLE block gives no store to a named profile', () => {
    const vanilla: SemanticModel = {
      ...deployed(`      - {name: x, target: "${SPANNER_GRAPH}"}\n`),
      version: '0.2.0.dev0',
      deployments: undefined,
    };
    expect(resolveStore(vanilla, 'prod'))
        .toEqual({
          error: "binding profile 'prod' is a profile file, which names no " +
              'deployment target, so there is no database to run it against',
        });
    const store = resolveStore(vanilla, 'default');
    if ('error' in store) throw new Error(store.error);
    expect(store.kind).toBe('spanner');
  });

  // A legacy wrapper merged into a model with no deployments has no target.
  test('a legacy wrapper over a model with no deployments has no store', () => {
    const noTarget: SemanticModel = {
      ...deployed(`      - {name: x, target: "${SPANNER_GRAPH}"}\n`),
      deployments: undefined,
      customExtensions: undefined,
    };
    expect(resolveStore(noTarget, 'prod', {legacyWrapper: true}))
        .toEqual({
          error: "Model 'm' declares no deployment target in 'deployments', " +
              'so there is no store to run against. Declare a deployment in ' +
              "'deployments' whose target names a database.",
        });
  });

  // An empty list names no deployment, the same as no list.
  test('an empty deployments list gives no store to a named profile', () => {
    const emptyDeployments: SemanticModel = {...threeProfiles, deployments: []};
    expect(resolveStore(emptyDeployments, 'prod'))
        .toEqual({
          error: "binding profile 'prod' is a profile file, which names no " +
              'deployment target, so there is no database to run it against',
        });
  });

  // A legacy wrapper is merged into the model file, and push deploys it to
  // the model file's deployments when none names it.
  test('a legacy wrapper no deployment names takes the unprofiled ones', () => {
    const twoProfiles = deployed(
        `      - {name: bq_prod, target: "${BQ_GRAPH}", profile: analytical}\n` +
            `      - {name: spanner_prod, target: "${SPANNER_GRAPH}"}\n`,
        `${DB}/tables/Customer`);
    const store = resolveStore(twoProfiles, 'staging', {legacyWrapper: true});
    if ('error' in store) throw new Error(store.error);
    expect(store.name).toBe('projects/p/instances/i/databases/d');
    expect('error' in resolveStore(twoProfiles, 'staging')).toBe(true);
    // A deployment that names the wrapper is its own; this one is BigQuery.
    const analytical =
        resolveStore(twoProfiles, 'analytical', {legacyWrapper: true});
    expect('error' in analytical && analytical.error)
        .toContain('deployment target is projects/p/datasets/s');
  });

  // A blank `deployment_target` names no target, as push reads it, so the
  // loader makes no deployment of it.
  test('an empty deployment_target names no target', () => {
    for (const blank of ['""', '"   "']) {
      const store = resolveStore(
          model(
              `    deployment_target: ${blank}\n` +
              `    entities:\n` +
              `      - name: Customer\n` +
              `        primary_key: [id]\n` +
              `        fields:\n` +
              `          - {name: id, datatype: Integer}\n`),
          'prod', {legacyWrapper: true});
      expect(store).toEqual({
        error: expect.stringContaining('declares no deployment target'),
      });
    }
  });
});


// The loader keeps a Spanner or AlloyDB source written as a catalog name as
// it was written, and the store reads it.
describe('a catalog-name source', () => {
  function sourced(target: string, source: string): SemanticModel {
    return model(
        `    deployments:\n` +
        `      - {name: prod, target: "${target}"}\n` +
        `    entities:\n` +
        `      - name: Customer\n` +
        `        primary_key: [id]\n` +
        `        source: ${source}\n` +
        `        fields:\n` +
        `          - {name: id, datatype: Integer, expression: id}\n`);
  }

  const CLUSTER_DB =
      '//alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c/databases/d';

  test('in Spanner matches a Spanner target', () => {
    const store = resolveStore(sourced(
        `${DB}/propertyGraphs/g`, 'spanner:p.regional-us-central1.i.d.Customer'));
    if ('error' in store) throw new Error(store.error);
    expect(store.name).toBe('projects/p/instances/i/databases/d');
  });

  test('in AlloyDB matches an AlloyDB target', () => {
    const store = resolveStore(
        sourced(CLUSTER_DB, 'alloydb:p.us-central1.c.d.public.customer'));
    if ('error' in store) throw new Error(store.error);
    expect(store.kind).toBe('alloydb');
  });

  test('in another database is refused', () => {
    const store = resolveStore(sourced(
        CLUSTER_DB, 'alloydb:p.us-central1.c.other.public.customer'));
    expect('error' in store && store.error)
        .toContain("'Customer' to alloydb:p.us-central1.c.other.public.customer");
  });
});


describe('an AlloyDB source', () => {
  const CLUSTER =
      '//alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c';

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

  test('written as a table URI, matches a target with the same cluster and database',
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

  // The instance is compute. The database belongs to the cluster, so a legacy
  // source's instance takes no part in the match.
  test('written as a legacy instance URI, matches on cluster and database', () => {
    const store = resolveStore(alloyModel(
        `${CLUSTER}/databases/d`,
        `${CLUSTER}/instances/any/databases/d/tables/customer`));
    if ('error' in store) throw new Error(store.error);
    expect(store.kind).toBe('alloydb');
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
      message: JSON.stringify(
          {error: {code: 404, message: "Resource 'clusters/c' was not found"}}),
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
        .mockResolvedValueOnce({
          status: 403,
          message: JSON.stringify({error: {message: 'Permission denied'}}),
        });
    expect(await withPrimaryInstance(store, client))
        .toEqual({
          error: `Could not list the instances of AlloyDB cluster '${
              CLUSTER}': 403 Permission denied`,
        });
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

  test('a store that names its instance is not looked up', async () => {
    const client = clientListing({status: 500});
    const legacy = {...store, instance: 'i'};
    expect(await withPrimaryInstance(legacy, client)).toEqual(legacy);
    expect(client.listInstances).not.toHaveBeenCalled();
  });
});
