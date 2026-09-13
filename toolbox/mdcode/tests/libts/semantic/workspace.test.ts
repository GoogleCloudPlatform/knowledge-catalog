// Behavior specification for opening a workspace's store.
//
// The claim under test is that a model says where it lives and nothing else
// does. A caller -- the CLI, an agent, a setup script -- asks the model and
// gets one answer, and a model whose bindings disagree with its deployment
// target gets a refusal rather than a write into whichever database happened
// to be named last.
//
// Nothing here opens a connection. Deciding where to write is pure.

import {describe, expect, test} from 'bun:test';

import {loadModels} from '../../../src/libts/semantic/loader';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {spannerStore} from '../../../src/libts/semantic/workspace';

const DB = '//spanner.googleapis.com/projects/p/instances/i/databases/d';

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
    const store = spannerStore(
        bound(`${DB}/propertyGraphs/g`, `${DB}/tables/Customer`));
    if ('error' in store) throw new Error(store.error);
    expect(store.project).toBe('p');
    expect(store.instance).toBe('i');
    expect(store.database).toBe('d');
    expect(store.client.database).toBe(
        'projects/p/instances/i/databases/d');
  });

  test('a model with no Spanner target has no store, and is told which way ' +
           'out',
       () => {
         const store = spannerStore(bound(
             '//bigquery.googleapis.com/projects/p/datasets/s/propertyGraphs/g',
             '//bigquery.googleapis.com/projects/p/datasets/s/tables/Customer'));
         expect('error' in store).toBe(true);
         if (!('error' in store)) return;
         expect(store.error).toContain('no Spanner deployment target');
         expect(store.error).toContain('BigQuery');
       });
});


describe('a binding that disagrees with the target', () => {
  // An action's statements name a table and drop the qualifier, so a write
  // against a stray binding still runs -- against whatever table of that name
  // the TARGET database holds. Nothing downstream would report it, which is
  // why it is refused here.
  test('an entity bound to another database is refused, and both are named',
       () => {
         const other =
             '//spanner.googleapis.com/projects/p/instances/i/databases/other';
         const store = spannerStore(
             bound(`${DB}/propertyGraphs/g`, `${other}/tables/Customer`));
         expect('error' in store).toBe(true);
         if (!('error' in store)) return;
         expect(store.error).toContain('databases/other');
         expect(store.error).toContain('deployment target is projects/p');
       });

  test('an entity bound to another system is refused for the same reason',
       () => {
         const store = spannerStore(bound(
             `${DB}/propertyGraphs/g`,
             '//bigquery.googleapis.com/projects/p/datasets/s/tables/Customer'));
         expect('error' in store).toBe(true);
         if (!('error' in store)) return;
         expect(store.error).toContain('not a table in this database');
       });

  test('an entity this profile binds to nothing is not a mis-binding', () => {
    // Declared and unbound is a model that has not been given a table yet.
    // The statements report that themselves, naming the table they could not
    // find; refusing here would refuse a logical model for being logical.
    const store = spannerStore(model(
        `    deployment_target: ${DB}/propertyGraphs/g\n` +
        `    entities:\n` +
        `      - name: Customer\n` +
        `        primary_key: [id]\n` +
        `        fields:\n` +
        `          - {name: id, datatype: Integer}\n`));
    expect('error' in store).toBe(false);
  });
});
