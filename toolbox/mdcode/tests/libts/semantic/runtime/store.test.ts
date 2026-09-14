// Behavior specification for resolving a model's store.
//
// The claim under test is that a model says where it lives and nothing else
// does. A caller -- the CLI, an agent, a setup script -- asks the model and
// gets one answer, and a model whose bindings disagree with its deployment
// target gets a refusal rather than a write into whichever database happened
// to be named last.
//
// Nothing here opens a connection. Deciding where to write is pure.

import {describe, expect, test} from 'bun:test';

import {SemanticModel} from '../../../../src/libts/semantic/ir';
import {loadModels} from '../../../../src/libts/semantic/loader';
import {dataClientFor, resolveStore} from '../../../../src/libts/semantic/runtime/store';

const DB = '//spanner.googleapis.com/projects/p/instances/i/databases/d';
const DATASET = '//bigquery.googleapis.com/projects/p/datasets/s';
const PG =
    '//alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c/instances/i/databases/d';

function model(body: string): SemanticModel {
  const loaded = loadModels(
      `version: "0.2.0.dev0/google"\nsemantic_model:\n  - name: m\n${body}`,
      {bindingOptional: true});
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
    expect(store.client.database).toBe('projects/p/instances/i/databases/d');
  });

  // A dataset is somewhere the model's data really is, so it resolves. What
  // it is not is somewhere an action can write, and saying that at the point
  // a caller asks for a client keeps "no store" and "not this kind of store"
  // as the two different answers they are.
  test('a BigQuery target is a store, and not one an action can write to',
       () => {
         const store = resolveStore(bound(
             `${DATASET}/propertyGraphs/g`, `${DATASET}/tables/Customer`));
         if ('error' in store) throw new Error(store.error);
         expect(store.kind).toBe('bigquery');
         expect(store.name).toBe('projects/p/datasets/s');

         const client = dataClientFor(store);
         expect('error' in client).toBe(true);
         if (!('error' in client)) return;
         expect(client.error).toContain('projects/p/datasets/s');
         expect(client.error).toContain('Spanner');
       });

  // The same three questions asked of the other operational backend. That they
  // have the same answers is the claim the cross-database demo rests on: a
  // model says where it lives, and AlloyDB is one of the places it can say.
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
    expect(store.name).toBe(
        'projects/p/locations/us-central1/clusters/c/instances/i/databases/d');
    expect(store.client.database).toBe(store.name);

    // And unlike BigQuery, it hands back a client rather than a reason.
    const client = dataClientFor(store);
    expect('error' in client).toBe(false);
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
    expect(store.error).toContain('no deployment target');
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
});


// A model may name more than one destination: the same graph published to
// BigQuery for analysis and to Spanner for operations is one model deployed
// twice, not two models. Which of those is the store an action runs against is
// not in doubt -- only Spanner accepts a write -- so the pair resolves. Two
// destinations of the SAME backend is the case nothing here can decide.
describe('a model that declares more than one deployment target', () => {
  function targets(uris: string[], source: string): SemanticModel {
    return {
      ...bound(`${DB}/propertyGraphs/g`, source),
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
         expect(store.error).toContain('Give each its own profile.');
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
    expect(store.error).toContain('Give each its own profile.');
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
});
