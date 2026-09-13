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
import {resolveStore, spannerClientFor} from '../../../../src/libts/semantic/runtime/store';

const DB = '//spanner.googleapis.com/projects/p/instances/i/databases/d';
const DATASET = '//bigquery.googleapis.com/projects/p/datasets/s';

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

         const client = spannerClientFor(store);
         expect('error' in client).toBe(true);
         if (!('error' in client)) return;
         expect(client.error).toContain('projects/p/datasets/s');
         expect(client.error).toContain('Spanner');
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

  test('two BigQuery targets is ambiguous in the same way', () => {
    const store = resolveStore(targets(
        [`${DATASET}/propertyGraphs/g`, `//bigquery.googleapis.com/projects/p/datasets/s2/propertyGraphs/g`],
        `${DATASET}/tables/Customer`));
    expect('error' in store).toBe(true);
    if (!('error' in store)) return;
    expect(store.error).toContain('2 BigQuery deployment targets');
  });
});
