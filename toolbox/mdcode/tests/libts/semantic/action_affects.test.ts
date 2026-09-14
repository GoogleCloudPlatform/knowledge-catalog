// Behavior specification for an action's `affects`: the concepts a call
// changes, its blast radius.
//
// Nothing in the model can derive this. An executor is an opaque handle to an
// MCP tool or an HTTP endpoint, and no reader can see what that tool writes, so
// the blast radius is declared or it is unknown. That makes `affects` unlike
// every other cross-reference in the model: it is the author's claim, and the
// only thing checking it is the check written here.
//
// Two authored shapes reach the same IR. A bare name is the coarse claim the
// proposal document uses -- this concept is touched, in some way not spelled
// out. A record adds an operation and the fields it writes. One key and one set
// of verbs cover entities and relationships alike: an edge with properties of
// its own is modified exactly the way a row is, and nothing downstream branches
// on which kind a name turned out to be.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {fromDocument, LoadedModel, loadModels} from '../../../src/libts/semantic/loader';
import {serializeModel} from '../../../src/libts/semantic/osi_converter';
import {validatePushRequirements} from '../../../src/libts/semantic/validate';

const FIXTURES = path.join(__dirname, 'fixtures');
const OPTS = {
  project: 'dest',
  location: 'us',
  entryGroup: 'eg'
};

const MCP_EXECUTOR = {
  mcp: {server: '//agentregistry.googleapis.com/x', tool: 'place_order'},
};

// Two entities and the edge between them, so a test can name a concept of each
// kind. `affects` is passed through verbatim: a test names something that does
// not exist by writing it, exactly as an author would.
function withAffects(affects: any[]|undefined, version = '0.2.0.dev0/google') {
  return fromDocument({
    version,
    semantic_model: [{
      name: 'm',
      datasets: [
        {
          name: 'orders',
          source: 'p.d.o',
          primary_key: ['id'],
          fields: [
            {
              name: 'id',
              expression: {dialects: [{dialect: 'ANSI_SQL', expression: 'id'}]},
            },
            {
              name: 'total',
              expression:
                  {dialects: [{dialect: 'ANSI_SQL', expression: 'total'}]},
            },
          ],
        },
        {
          name: 'customer',
          source: 'p.d.c',
          primary_key: ['cid'],
          fields: [{
            name: 'cid',
            expression: {dialects: [{dialect: 'ANSI_SQL', expression: 'cid'}]},
          }],
        },
      ],
      relationships: [{
        name: 'orders_to_customer',
        from: 'orders',
        to: 'customer',
        from_columns: ['id'],
        to_columns: ['cid'],
      }],
      actions: [{
        name: 'PlaceOrder',
        executor: MCP_EXECUTOR,
        parameters: [{name: 'quantity', type: 'Integer'}],
        ...(affects ? {affects} : {}),
      }],
    }],
  });
}


describe('the loader normalizes both authored shapes', () => {
  test('a bare name is the whole entry', () => {
    // The coarse form the proposal document uses. It says only that the
    // concept is touched, in a way the model does not spell out.
    const {models, warnings} = withAffects(['orders']);
    expect(models[0].actions![0].affects).toEqual([{concept: 'orders'}]);
    expect(warnings.some(w => w.includes('affects'))).toBe(false);
  });

  test('a record keeps its operation and fields', () => {
    const {models} = withAffects([
      {concept: 'orders', operation: 'create', fields: ['id', 'total']},
    ]);
    expect(models[0].actions![0].affects).toEqual([{
      concept: 'orders',
      operation: 'create',
      fields: ['id', 'total'],
    }]);
  });

  test('an entry on a relationship uses the same key and the same verbs',
       () => {
         // The point of the single vocabulary: nothing about this entry
         // differs from one on an entity, and the IR records nothing that says
         // which kind `orders_to_customer` turned out to be.
         const {models, warnings} =
             withAffects([{concept: 'orders_to_customer', operation: 'create'}]);
         expect(models[0].actions![0].affects).toEqual([{
           concept: 'orders_to_customer',
           operation: 'create',
         }]);
         expect(warnings.some(w => w.includes('affects'))).toBe(false);
       });

  test('the two shapes mix freely in one list', () => {
    const {models} = withAffects([
      {concept: 'orders', operation: 'create'},
      'customer',
    ]);
    expect(models[0].actions![0].affects!.map(e => e.concept)).toEqual([
      'orders', 'customer'
    ]);
  });

  test('an action that declares nothing carries no affects', () => {
    expect(withAffects(undefined).models[0].actions![0].affects)
        .toBeUndefined();
  });

  test('an empty list carries no affects either', () => {
    expect(withAffects([]).models[0].actions![0].affects).toBeUndefined();
  });

  test('a concept that resolves to nothing is kept, with a warning', () => {
    // Kept rather than dropped: the push is where an unresolvable name fails,
    // and dropping it here would make that failure impossible to reach.
    const {models, warnings} = withAffects(['Shipment']);
    expect(models[0].actions![0].affects).toEqual([{concept: 'Shipment'}]);
    const w = warnings.find(x => x.includes('Shipment'));
    expect(w).toBeDefined();
    expect(w).toContain('neither an entity nor a relationship');
  });
});


describe('the loader rejects an entry that states no single fact', () => {
  test('the old `entity:` key, now that one key covers both kinds', () => {
    expect(() => withAffects([{entity: 'orders'}])).toThrow();
  });

  test('a record naming no concept', () => {
    expect(() => withAffects([{operation: 'create'}])).toThrow();
  });

  test('an unknown operation', () => {
    // The vocabulary is closed. A consumer routing on the operation cannot be
    // handed a verb it has no case for.
    expect(() => withAffects([{concept: 'orders', operation: 'upsert'}]))
        .toThrow();
  });

  test('`add`, which an edge once had and no longer does', () => {
    expect(() => withAffects([{
             concept: 'orders_to_customer',
             operation: 'add',
           }])).toThrow();
  });

  test('an unknown key in the record', () => {
    expect(() => withAffects([{concept: 'orders', opration: 'create'}]))
        .toThrow();
  });

  test('the same concept and operation twice', () => {
    expect(
        () => withAffects([
          {concept: 'orders', operation: 'create'},
          {concept: 'orders', operation: 'create'},
        ]))
        .toThrow(/duplicate affected concept 'orders\/create'/);
  });

  test('the same bare concept twice', () => {
    expect(() => withAffects(['orders', 'orders']))
        .toThrow(/duplicate affected concept/);
  });

  test('a field named twice in one entry', () => {
    expect(
        () => withAffects(
            [{concept: 'orders', operation: 'modify', fields: ['id', 'id']}]))
        .toThrow(/duplicate affected field 'id'/);
  });

  test('two operations on one concept are two distinct facts', () => {
    const {models} = withAffects([
      {concept: 'orders', operation: 'create'},
      {concept: 'orders', operation: 'modify'},
    ]);
    expect(models[0].actions![0].affects).toHaveLength(2);
  });

  test('a bare concept beside a specific one warns about the mix', () => {
    // Not contradictory, so it loads -- but it says both "in some unstated
    // way" and "in this exact way", which is almost always a half-finished
    // edit.
    const {warnings} = withAffects(['orders', {
                                     concept: 'orders',
                                     operation: 'create',
                                   }]);
    const w = warnings.find(x => x.includes('both with an operation'));
    expect(w).toBeDefined();
    expect(w).toContain(`'orders'`);
  });

  test('affects is rejected under vanilla Ossie, as actions themselves are',
       () => {
         expect(() => withAffects(['orders'], '0.2.0.dev0')).toThrow(/actions/);
       });
});


describe('validatePushRequirements checks every affected concept', () => {
  const googleExt = {
    vendorName: 'GOOGLE',
    data: JSON.stringify({
      deploymentTargets:
          ['//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g']
    }),
  };

  // One entity, one plain foreign-key edge, and one many-to-many edge with a
  // property of its own -- the three things an entry can name.
  function loaded(affects: any[]): LoadedModel {
    const model: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'orders',
        dataSource: 'p.d.o',
        keys: ['id'],
        fields: [{name: 'id'}, {name: 'total'}],
      }],
      relationships: [
        {
          name: 'orders_to_customer',
          source: {entity: 'orders', columns: ['id']},
          destination: {entity: 'orders', columns: ['id']},
        },
        {
          name: 'OrderedAs',
          source: {entity: 'orders', columns: ['id']},
          destination: {entity: 'orders', columns: ['id']},
          association: {
            dataSource: 'p.d.lineitem',
            keys: ['lid'],
            sourceColumns: ['oid'],
            destinationColumns: ['pid'],
            fields: [{name: 'quantity'}],
          },
        },
      ],
      metrics: [],
      actions: [{
        name: 'PlaceOrder',
        executor: {kind: 'mcp', mcp: {server: 's', tool: 't'}},
        parameters: [],
        affects,
      }],
      customExtensions: [googleExt],
    };
    return {document: 'doc', model};
  }

  test('an entry naming a declared entity and its own fields passes', () => {
    expect(validatePushRequirements([loaded([{
             concept: 'orders',
             operation: 'create',
             fields: ['id', 'total'],
           }])]))
        .toEqual([]);
  });

  test('modifying a property of a many-to-many edge passes', () => {
    // The change the split vocabulary could not express: a junction table has
    // fields of its own, so an edge is modified exactly the way a row is.
    expect(validatePushRequirements([loaded([{
             concept: 'OrderedAs',
             operation: 'modify',
             fields: ['quantity'],
           }])]))
        .toEqual([]);
  });

  test('a concept the model does not declare is a hard error', () => {
    // The author believes the blast radius is described; it names a concept
    // that does not exist, so anything routing on it routes on nothing.
    const errs = validatePushRequirements([loaded([{concept: 'Shipment'}])]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain(`action 'PlaceOrder'`);
    expect(errs[0]).toContain(`affects 'Shipment'`);
    expect(errs[0]).toContain('neither an entity nor a relationship');
  });

  test('fields on a delete are a hard error', () => {
    const errs = validatePushRequirements([loaded([{
      concept: 'orders',
      operation: 'delete',
      fields: ['total'],
    }])]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('takes the whole instance');
  });

  test('a field the concept does not declare is a hard error', () => {
    const errs = validatePushRequirements([loaded([{
      concept: 'orders',
      operation: 'modify',
      fields: ['total', 'shipped_at'],
    }])]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain(`affects 'orders.shipped_at'`);
    expect(errs[0]).toContain(`entity 'orders' declares no field 'shipped_at'`);
  });

  test('naming fields on a plain foreign-key edge is always an error', () => {
    // Only a many-to-many junction carries properties of its own, so a field
    // on any other edge cannot resolve to anything.
    const errs = validatePushRequirements([loaded([{
      concept: 'orders_to_customer',
      operation: 'modify',
      fields: ['quantity'],
    }])]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain(
        `relationship 'orders_to_customer' declares no field 'quantity'`);
  });

  test('each entry reports one problem, not a cascade', () => {
    // A concept that does not resolve makes every later check about it
    // meaningless, so that is the only thing said about it.
    const errs = validatePushRequirements([loaded(
        [{concept: 'Shipment', operation: 'modify', fields: ['a', 'b']}])]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('neither an entity nor a relationship');
  });

  test('one error per bad entry', () => {
    const errs = validatePushRequirements(
        [loaded([{concept: 'Shipment'}, {concept: 'Invoice'}])]);
    expect(errs).toHaveLength(2);
  });

  test('an entity wins a name that is also a relationship', () => {
    // Resolution has to be a total function of the model, and the loader's
    // warning indexes entities first for the same reason: the two must agree,
    // or a model would load clean and be checked against the other concept.
    // `id` is a field of the entity and of no edge, so this passes only if the
    // entity won.
    const {document, model} =
        loaded([{concept: 'dual', operation: 'modify', fields: ['id']}]);
    model.entities.push({
      name: 'dual',
      dataSource: 'p.d.x',
      keys: ['id'],
      fields: [{name: 'id'}],
    });
    model.relationships!.push({
      name: 'dual',
      source: {entity: 'orders', columns: ['id']},
      destination: {entity: 'orders', columns: ['id']},
    });
    expect(validatePushRequirements([{document, model}])).toEqual([]);
  });

  test('a profile push stands down on everything that reads the ontology',
       () => {
         // pruneUnavailable drops whole entities and whole relationships, not
         // only unbound fields, and leaves actions untouched -- so under a
         // profile an entry naming a missing field OR a missing concept is
         // the profile's doing, not the author's. An action reaches no graph
         // in any case, so failing the deploy over either would fail it for no
         // reason.
         const field = [{
           concept: 'orders',
           operation: 'modify',
           fields: ['not_bound_here'],
         }];
         const concept = [{concept: 'Shipment'}];
         expect(validatePushRequirements([loaded(field)])).toHaveLength(1);
         expect(validatePushRequirements([loaded(concept)])).toHaveLength(1);
         expect(validatePushRequirements([loaded(field)], {fieldsPruned: true}))
             .toEqual([]);
         expect(
             validatePushRequirements([loaded(concept)], {fieldsPruned: true}))
             .toEqual([]);
       });

  test('a profile push still rejects fields on a delete', () => {
    // The one check that reads only the entry, so pruning cannot excuse it.
    expect(validatePushRequirements(
               [loaded([{
                 concept: 'orders',
                 operation: 'delete',
                 fields: ['total'],
               }])],
               {fieldsPruned: true}))
        .toHaveLength(1);
  });

  // A model whose `extends` names an entity it does not declare. The loader
  // does not check that, and a KC-only push runs no graph leg that would, so
  // such a model reaches this gate intact -- and resolving its inheritance
  // throws. The gate exists to PRINT problems, so it must not die with a stack
  // trace on a model it has nothing to say about.
  function withDanglingSupertype(affects: any[]): LoadedModel {
    const m = loaded(affects);
    m.model.entities.push({
      name: 'RushOrder',
      extends: ['PriorityOrder'],
      dataSource: 'p.d.r',
      keys: ['id'],
      fields: [{name: 'id'}],
    });
    return m;
  }

  test('a dangling extends is reported, not crashed on or ignored', () => {
    // Nothing here reads the ontology, so nothing may resolve inheritance to
    // answer a question. The model is still broken, and no other leg of a
    // Knowledge-Catalog-only push would say so, so the gate reports it.
    const errs = validatePushRequirements([withDanglingSupertype([])]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('extends unknown entity');
  });

  test('a dangling extends does not crash a profile push', () => {
    // Pruning can create the dangling `extends` itself, by dropping a concrete
    // supertype whole when the profile leaves its key unbound. So the standdown
    // has to come before the index is built, not inside the loop over entries.
    const m = withDanglingSupertype([{concept: 'orders', operation: 'modify'}]);
    expect(validatePushRequirements([m], {fieldsPruned: true})).toEqual([]);
  });
});


describe('publishing says when a blast radius outruns the push', () => {
  // An action is published whole while entities are not: an abstract one has no
  // table to publish, and a binding profile drops any concept it cannot bind.
  // `affects` is left untouched by both, so the catalog can end up recording a
  // change to a concept it holds no entry for. That is the right entry to
  // publish -- the action does change it -- but it is a divergence, and pulling
  // the model back and pushing it unpruned fails hard on the same name. So it
  // is reported where it is created.
  function published(affects: any[]) {
    const model: SemanticModel = {
      name: 'm',
      entities: [
        {
          name: 'orders',
          dataSource: 'p.d.o',
          keys: ['id'],
          fields: [{name: 'id'}],
        },
        // No physical table, so no dataSource or keys -- exactly what
        // the entity loop skips.
        {
          name: 'Party',
          abstract: true,
          dataSource: '',
          keys: [],
          fields: [{name: 'id'}],
        },
      ],
      relationships: [{
        name: 'orders_to_customer',
        source: {entity: 'orders', columns: ['id']},
        destination: {entity: 'orders', columns: ['id']},
      }],
      metrics: [],
      actions: [{
        name: 'PlaceOrder',
        executor: {kind: 'mcp', mcp: {server: 's', tool: 't'}},
        parameters: [],
        affects,
      }],
    };
    return generateCatalogResources(model, OPTS).warnings;
  }

  test('a concept this push publishes draws no warning', () => {
    // Including a relationship, which is never in publishedEntities and would
    // warn on every well-formed model if that were the only set consulted.
    const w = published([{concept: 'orders'}, {concept: 'orders_to_customer'}]);
    expect(w.filter(x => x.includes('affects'))).toEqual([]);
  });

  test('an abstract concept is published, with a warning', () => {
    const w = published([{concept: 'Party', operation: 'modify'}]);
    const about = w.filter(x => x.includes(`affects 'Party'`));
    expect(about).toHaveLength(1);
    expect(about[0]).toContain('has no entry for');
  });
});


describe('affects survives every round trip', () => {
  const model = (() => {
    const text = fs.readFileSync(
        path.join(FIXTURES, 'actions_place_order.yaml'), 'utf8');
    return loadModels(text).models[0];
  })();

  const EXPECTED = [
    {
      concept: 'orders',
      operation: 'create',
      fields: ['o_orderkey', 'o_totalprice'],
    },
    {concept: 'orders_to_customer', operation: 'create'},
    {concept: 'customer'},
  ];

  test('the fixture action declares all three shapes', () => {
    expect(model.actions![0].affects).toEqual(EXPECTED as any);
  });

  test('OSI serialize -> reload', () => {
    const {yaml} = serializeModel(model);
    expect(loadModels(yaml).models[0].actions![0].affects)
        .toEqual(EXPECTED as any);
  });

  test('the emitted document is a fixed point after one pass', () => {
    // The emitter normalizes rather than reproducing what was authored: a
    // record with nothing but a concept comes back as a bare name. Reloading
    // and re-emitting therefore has to change nothing more.
    const once = serializeModel(model).yaml;
    const twice = serializeModel(loadModels(once).models[0]).yaml;
    expect(twice).toBe(once);
  });

  test('an authored record with no operation emits as a bare name', () => {
    const {models} = withAffects([{concept: 'orders'}]);
    const {yaml} = serializeModel(models[0]);
    expect(yaml).toContain('affects:\n          - orders\n');
  });

  test('Knowledge Catalog publish -> pull', () => {
    const {entries} = generateCatalogResources(model, OPTS);
    const pulled = modelsFromCatalogResources(entries).models[0];
    expect(pulled.actions![0].affects).toEqual(EXPECTED as any);
  });

  test('a pull that recovers no relationships still round-trips the edge', () =>
       {
         // Relationships reach the catalog as `schema-join` entry LINKS, and a
         // pull that did not fetch them recovers none -- which is also the
         // permanent state of a many-to-many edge, since those are never
         // published. The entry on the edge still comes back untouched and in
         // silence, because nothing about it was ever resolved against the
         // model. That is what dropping the derived kind bought.
         const {entries} = generateCatalogResources(model, OPTS);
         const {models, warnings} = modelsFromCatalogResources(entries);
         expect(models[0].relationships).toEqual([]);
         expect(models[0].actions![0].affects).toEqual(EXPECTED as any);
         expect(warnings.some(w => w.includes('orders_to_customer')))
             .toBe(false);
       });

  test('an action with no entries publishes no affects field', () => {
    const bare: SemanticModel = {
      ...model,
      actions: [{...model.actions![0], affects: undefined}],
    };
    const {entries} = generateCatalogResources(bare, OPTS);
    const action =
        entries.find(e => e.entrySource?.displayName === 'PlaceOrder')!;
    const data = Object.values(action.aspects!)[0].data!;
    expect(Object.keys(data)).not.toContain('affects');
  });

  // The aspect an author edits by hand in the catalog console can carry
  // anything, so the read side is written not to trust it.
  function pullWithAspect(mutate: (data: any) => void) {
    const {entries} = generateCatalogResources(model, OPTS);
    const entry =
        entries.find(e => e.entrySource?.displayName === 'PlaceOrder')!;
    mutate(Object.values(entry.aspects!)[0].data! as any);
    return modelsFromCatalogResources(entries);
  }

  test('a repeated entry in the aspect is dropped, with a warning', () => {
    // The loader rejects the repeat outright, so keeping both would hand back
    // a document the author cannot reload.
    const {models, warnings} = pullWithAspect(data => {
      data.affects = [data.affects[0], data.affects[0]];
    });
    expect(models[0].actions![0].affects).toHaveLength(1);
    expect(warnings.some(w => w.includes('repeats the entry'))).toBe(true);
  });

  test('an unknown operation is dropped and the entry kept', () => {
    // The blast radius is still true even when the verb is not one we know,
    // and dropping the whole entry would lose that.
    const {models, warnings} = pullWithAspect(data => {
      data.affects[0].operation = 'upsert';
    });
    const affected = models[0].actions![0].affects![0];
    expect(affected.concept).toBe('orders');
    expect(affected.operation).toBeUndefined();
    expect(warnings.some(w => w.includes('unknown operation'))).toBe(true);
  });

  test('a record naming no concept is dropped', () => {
    const {models} = pullWithAspect(data => {
      data.affects.push({operation: 'create'});
    });
    expect(models[0].actions![0].affects).toHaveLength(EXPECTED.length);
  });
});
