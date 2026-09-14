// Behavior specification for the link between an action and the constraints
// that gate it: the action's `guards` list.
//
// A constraint that quantifies over data alone holds for every write and is
// enforced without being named anywhere. A constraint that reads an action's
// parameters describes the call instead, so the only moment it can be checked
// is before that call runs -- which happens only when the action names it. That
// asymmetry is what these tests pin down: naming resolves (or fails to resolve)
// at push time, and an unnamed parameter-reading constraint is reported at load
// time as text nothing will evaluate.

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

// Two actions that both take a `quantity` parameter, the first guarded by
// `guardOnFirst`. Used to check that being guarded by ONE action settles the
// constraint for the whole model.
function withTwoActions(guardOnFirst: string[]|undefined, constraints: any[]) {
  return fromDocument({
    version: '0.2.0.dev0/google',
    semantic_model: [{
      name: 'm',
      datasets: [{
        name: 'customer',
        source: 'p.d.c',
        primary_key: ['id'],
        fields: [{
          name: 'balance',
          expression:
              {dialects: [{dialect: 'ANSI_SQL', expression: 'balance'}]},
        }],
      }],
      actions: [
        {
          name: 'PlaceOrder',
          executor: MCP_EXECUTOR,
          parameters: [{name: 'quantity', type: 'Integer'}],
          ...(guardOnFirst ? {guards: guardOnFirst} : {}),
        },
        {
          name: 'CancelOrder',
          executor: MCP_EXECUTOR,
          parameters: [{name: 'quantity', type: 'Integer'}],
        },
      ],
      constraints,
    }],
  });
}

// One entity, one action, and whatever constraints a test needs. `guards` is
// passed through verbatim so a test can name a constraint that does not exist.
function withGuards(
    guards: string[]|undefined, constraints: any[] = [],
    parameters: any[] = [{name: 'quantity', type: 'Integer'}]) {
  return fromDocument({
    version: '0.2.0.dev0/google',
    semantic_model: [{
      name: 'm',
      datasets: [{
        name: 'customer',
        source: 'p.d.c',
        primary_key: ['id'],
        fields: [{
          name: 'balance',
          expression:
              {dialects: [{dialect: 'ANSI_SQL', expression: 'balance'}]},
        }],
      }],
      actions: [{
        name: 'PlaceOrder',
        executor: MCP_EXECUTOR,
        parameters,
        ...(guards ? {guards} : {}),
      }],
      constraints,
    }],
  });
}


describe('loader parses an action\'s guards', () => {
  test('carries the constraint names onto the action', () => {
    const {models} = withGuards(
        ['PositiveQuantity'],
        [{name: 'PositiveQuantity', expression: 'quantity > 0'}]);
    expect(models[0].actions![0].guards).toEqual(['PositiveQuantity']);
  });

  test('omits guards entirely when the action names none', () => {
    const {models} = withGuards(undefined);
    expect(models[0].actions![0].guards).toBeUndefined();
  });

  test('a repeated guard is a hard load error', () => {
    // Checking one constraint twice reads as two rules, so it is rejected the
    // way every other duplicate name is.
    expect(
        () => withGuards(['C', 'C'], [{name: 'C', expression: 'quantity > 0'}]))
        .toThrow(/duplicate guard 'C'/);
  });

  test(
      'guards are rejected under vanilla Ossie, as actions themselves are',
      () => {
        expect(
            () => fromDocument({
              version: '0.2.0.dev0',
              semantic_model: [{
                name: 'm',
                datasets: [{
                  name: 'c',
                  source: 'p.d.c',
                  primary_key: ['id'],
                  fields: [{
                    name: 'balance',
                    expression: {
                      dialects: [{dialect: 'ANSI_SQL', expression: 'balance'}]
                    },
                  }],
                }],
                actions: [{
                  name: 'PlaceOrder',
                  executor: MCP_EXECUTOR,
                  guards: ['C'],
                }],
              }],
            }))
            .toThrow(/actions/);
      });
});


describe('validatePushRequirements resolves every guard', () => {
  const googleExt = {
    vendorName: 'GOOGLE',
    data: JSON.stringify({
      deploymentTargets:
          ['//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g']
    }),
  };

  function loaded(guards: string[], constraintNames: string[]): LoadedModel {
    const model: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'customer',
        dataSource: 'p.d.c',
        keys: ['id'],
        fields: [{name: 'balance'}],
      }],
      relationships: [],
      metrics: [],
      actions: [{
        name: 'PlaceOrder',
        executor: {kind: 'mcp', mcp: {server: 's', tool: 't'}},
        parameters: [{name: 'quantity', type: 'Integer', isEntityRef: false}],
        guards,
      }],
      constraints: constraintNames.map(
          name => ({name, expression: 'customer.balance >= 0'})),
      customExtensions: [googleExt],
    };
    return {document: 'doc', model};
  }

  test('a guard naming a declared constraint passes', () => {
    expect(validatePushRequirements([loaded(['C'], ['C'])])).toEqual([]);
  });

  test('a guard naming no constraint is a hard error', () => {
    // The author believes the write is checked; nothing checks it. Failing the
    // push is the only way that belief gets corrected.
    const errs = validatePushRequirements([loaded(['Typo'], ['C'])]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain(`action 'PlaceOrder'`);
    expect(errs[0]).toContain(`guarded by 'Typo'`);
    expect(errs[0]).toContain('declares no constraint');
  });

  test(
      'a model that declares no constraints at all still reports the guard',
      () => {
        const errs = validatePushRequirements([loaded(['C'], [])]);
        expect(errs).toHaveLength(1);
        expect(errs[0]).toContain(`guarded by 'C'`);
      });

  test('one error per unresolved guard', () => {
    const errs = validatePushRequirements([loaded(['A', 'B'], [])]);
    expect(errs).toHaveLength(2);
  });
});


describe(
    'an unguarded parameter-reading constraint is reported at load', () => {
      test('warns when a constraint reads a parameter no action guards', () => {
        const {warnings} = withGuards(
            undefined,
            [{name: 'PositiveQuantity', expression: 'quantity > 0'}]);
        const w = warnings.find(x => x.includes('PositiveQuantity'));
        expect(w).toBeDefined();
        expect(w).toContain(`reads 'quantity'`);
        expect(w).toContain(`parameter of action 'PlaceOrder'`);
        expect(w).toContain('guards');
      });

      test('stays silent once the action names it', () => {
        const {warnings} = withGuards(
            ['PositiveQuantity'],
            [{name: 'PositiveQuantity', expression: 'quantity > 0'}]);
        expect(warnings.some(w => w.includes('PositiveQuantity'))).toBe(false);
      });

      test('a qualified name is not a parameter read', () => {
        // `OrderedAs.quantity` is a field of something in the ontology that
        // happens to share the parameter's name. Warning here would train an
        // author to ignore the warning, so the scan consumes a qualified name
        // whole.
        const {warnings} = withGuards(
            undefined,
            [{name: 'PositiveQuantity', expression: 'OrderedAs.quantity > 0'}]);
        expect(warnings.some(w => w.includes('PositiveQuantity'))).toBe(false);
      });

      test(
          'a constraint over data alone needs no guard and draws no warning',
          () => {
            const {warnings} = withGuards(
                undefined,
                [{name: 'NonNegative', expression: 'customer.balance >= 0'}]);
            expect(warnings.some(w => w.includes('NonNegative'))).toBe(false);
          });

      test('the parameter must belong to the action being reported', () => {
        // `quantity` is not a parameter of an action that takes only a
        // customer, so that action is not the one told to guard the constraint.
        const {warnings} = withGuards(
            undefined, [{name: 'PositiveQuantity', expression: 'quantity > 0'}],
            [{name: 'customer', type: 'customer'}]);
        expect(warnings.some(w => w.includes('PositiveQuantity'))).toBe(false);
      });

      test('a string literal is not a parameter read', () => {
        // `'quantity'` here is a value the expression compares against, not a
        // reference to the parameter that shares its spelling.
        const {warnings} = withGuards(undefined, [{
                                        name: 'OpenOnly',
                                        expression:
                                            "customer.balance > 0 AND customer.status = 'quantity'",
                                      }]);
        expect(warnings.some(w => w.includes('OpenOnly'))).toBe(false);
      });

      test('one action guarding it settles it for every action', () => {
        // `CancelOrder` also takes a `quantity`, and deliberately does not
        // guard the constraint -- the same rule may gate one action and leave
        // another alone. The constraint still runs, as PlaceOrder's guard, so
        // reporting it as text nothing evaluates would be false.
        const {warnings} = withTwoActions(
            ['PositiveQuantity'],
            [{name: 'PositiveQuantity', expression: 'quantity > 0'}]);
        expect(warnings.some(w => w.includes('PositiveQuantity'))).toBe(false);
      });

      test('no action guarding it reports every action that could', () => {
        const {warnings} = withTwoActions(
            undefined, [{name: 'PositiveQuantity', expression: 'quantity > 0'}]);
        const reported =
            warnings.filter(w => w.includes(`constraint 'PositiveQuantity'`));
        expect(reported).toHaveLength(2);
        expect(reported.some(w => w.includes(`action 'PlaceOrder'`))).toBe(true);
        expect(reported.some(w => w.includes(`action 'CancelOrder'`)))
            .toBe(true);
      });
    });


describe('guards survive every round trip', () => {
  const model = (() => {
    const text = fs.readFileSync(
        path.join(FIXTURES, 'actions_place_order.yaml'), 'utf8');
    return loadModels(text).models[0];
  })();

  test(
      'the fixture action is guarded by a constraint the model declares',
      () => {
        expect(model.actions![0].guards).toEqual([
          'RequestedQuantityIsPositive'
        ]);
        expect(model.constraints!.map(c => c.name))
            .toContain('RequestedQuantityIsPositive');
      });

  test('OSI serialize -> reload', () => {
    const {yaml} = serializeModel(model);
    expect(loadModels(yaml).models[0].actions![0].guards).toEqual([
      'RequestedQuantityIsPositive'
    ]);
  });

  test('Knowledge Catalog publish -> pull', () => {
    const {entries} = generateCatalogResources(model, OPTS);
    const pulled = modelsFromCatalogResources(entries).models[0];
    expect(pulled.actions![0].guards).toEqual(['RequestedQuantityIsPositive']);
  });

  test('an action with no guards publishes no guards field', () => {
    const bare: SemanticModel = {
      ...model,
      actions: [{...model.actions![0], guards: undefined}],
    };
    const {entries} = generateCatalogResources(bare, OPTS);
    const action =
        entries.find(e => e.entrySource?.displayName === 'PlaceOrder')!;
    const data = Object.values(action.aspects!)[0].data!;
    expect(Object.keys(data)).not.toContain('guards');
  });

  test('a repeated guard in the aspect is dropped, with a warning', () => {
    // The loader rejects a repeated guard outright, so keeping both would hand
    // back a document the author cannot reload.
    const {entries} = generateCatalogResources(model, OPTS);
    const entry = entries.find(e => e.entrySource?.displayName === 'PlaceOrder')!;
    const data = Object.values(entry.aspects!)[0].data! as any;
    data.guards = ['RequestedQuantityIsPositive', 'RequestedQuantityIsPositive'];
    const {models, warnings} = modelsFromCatalogResources(entries);
    expect(models[0].actions![0].guards).toEqual([
      'RequestedQuantityIsPositive'
    ]);
    expect(warnings.some(
               w => w.includes('repeats guard') &&
                   w.includes('RequestedQuantityIsPositive')))
        .toBe(true);
  });

  test('a guard whose constraint the pull did not recover is reported', () => {
    // The name is kept on purpose, so the report has to come from the pull:
    // otherwise the author meets the failure on the next push instead.
    const {entries} = generateCatalogResources(model, OPTS);
    const withoutConstraints =
        entries.filter(e => !e.entryType?.includes('semantic-constraint'));
    const {models, warnings} = modelsFromCatalogResources(withoutConstraints);
    expect(models[0].actions![0].guards).toEqual([
      'RequestedQuantityIsPositive'
    ]);
    const w = warnings.find(x => x.includes('no constraint of that name'));
    expect(w).toBeDefined();
    expect(w).toContain(`action 'PlaceOrder'`);
    expect(w).toContain(`'RequestedQuantityIsPositive'`);
  });
});


// A judged constraint states its rule as prose a language model settles. It
// links to an action the way an expression does, and the two places the loader
// treats it differently are both about what a warning can conclude.
describe('judged constraints as guards', () => {
  const judged = (name: string) => ({
    name,
    judgment: 'The request must be defensible.',
    on_violation: 'escalate',
  });

  test('a judged constraint can guard an action', () => {
    const {models, warnings} =
        withGuards(['Defensible'], [judged('Defensible')]);
    expect(models[0].actions![0].guards).toEqual(['Defensible']);
    expect(warnings.some(w => w.includes('no constraint of that name')))
        .toBe(false);
  });

  test('an action guarded only by judged constraints is warned about', () => {
    // Nothing deterministic gates the write: no guard can lower to a store
    // check, and none can refuse on its own.
    const {warnings} = withGuards(['Defensible'], [judged('Defensible')]);
    const w = warnings.find(x => x.includes('no deterministic gate'));
    expect(w).toBeDefined();
    expect(w).toContain(`action 'PlaceOrder'`);
  });

  test('one deterministic guard among them is enough to stay quiet', () => {
    const {warnings} = withGuards(['Defensible', 'PositiveQuantity'], [
      judged('Defensible'),
      {name: 'PositiveQuantity', expression: 'quantity > 0'}
    ]);
    expect(warnings.some(w => w.includes('no deterministic gate'))).toBe(false);
  });

  test('an action naming no guards is not warned about', () => {
    // The message is about the guards an action chose. An action that chose
    // none raises a different question, which this does not answer.
    const {warnings} = withGuards(undefined, [judged('Defensible')]);
    expect(warnings.some(w => w.includes('no deterministic gate'))).toBe(false);
  });

  test(
      'a judged constraint naming a parameter is not reported as unguarded',
      () => {
        // The unguarded-parameter scan looks for a bare identifier matching a
        // parameter name. A judgment is prose, so `quantity` in it is as
        // likely to be an ordinary noun as a reference, and concluding
        // anything from the match would report rules that are well guarded.
        const {warnings} =
            withGuards(undefined, [{
                         name: 'Defensible',
                         judgment: 'The requested quantity must be defensible.',
                         on_violation: 'warn',
                       }]);
        expect(warnings.some(w => w.includes(`'Defensible'`))).toBe(false);
      });
});
