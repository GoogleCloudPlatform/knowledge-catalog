// Behavior specification for the link between an action and the constraints
// that gate it: the action's `guards` list.
//
// `guards` is the only thing that gives a constraint effect. A constraint the
// model declares and no action names is published, browsable and inert -- it
// gates nothing, because nothing references it. So what these tests pin down is
// the naming: it resolves, or fails to resolve, at push time, and it survives
// every round trip the model makes.

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
        [{name: 'PositiveQuantity', judgment: 'The quantity must be positive.'}]);
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
        () => withGuards(
            ['C', 'C'], [{name: 'C', judgment: 'The quantity must be positive.'}]))
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
      constraints: constraintNames.map(name => ({
                                         name,
                                         judgment:
                                             'The customer.balance must not go below zero.',
                                         onViolation: 'reject' as const,
                                       })),
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
          'OrderWithinCustomerCredit'
        ]);
        expect(model.constraints!.map(c => c.name))
            .toContain('OrderWithinCustomerCredit');
      });

  test('OSI serialize -> reload', () => {
    const {yaml} = serializeModel(model);
    expect(loadModels(yaml).models[0].actions![0].guards).toEqual([
      'OrderWithinCustomerCredit'
    ]);
  });

  test('Knowledge Catalog publish -> pull', () => {
    const {entries} = generateCatalogResources(model, OPTS);
    const pulled = modelsFromCatalogResources(entries).models[0];
    expect(pulled.actions![0].guards).toEqual(['OrderWithinCustomerCredit']);
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
    data.guards = ['OrderWithinCustomerCredit', 'OrderWithinCustomerCredit'];
    const {models, warnings} = modelsFromCatalogResources(entries);
    expect(models[0].actions![0].guards).toEqual([
      'OrderWithinCustomerCredit'
    ]);
    expect(warnings.some(
               w => w.includes('repeats guard') &&
                   w.includes('OrderWithinCustomerCredit')))
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
      'OrderWithinCustomerCredit'
    ]);
    const w = warnings.find(x => x.includes('no constraint of that name'));
    expect(w).toBeDefined();
    expect(w).toContain(`action 'PlaceOrder'`);
    expect(w).toContain(`'OrderWithinCustomerCredit'`);
  });
});


// Every constraint states its rule as prose a judge settles, so a guard names
// one of those and nothing else. What is left to check is that the link holds
// and that the loader concludes nothing further from the prose.
describe('a judgment as a guard', () => {
  const judged = (name: string) => ({
    name,
    judgment: 'The request must be defensible.',
    on_violation: 'escalate',
  });

  test('a constraint can guard an action', () => {
    const {models, warnings} =
        withGuards(['Defensible'], [judged('Defensible')]);
    expect(models[0].actions![0].guards).toEqual(['Defensible']);
    expect(warnings.some(w => w.includes('no constraint of that name')))
        .toBe(false);
  });

  test('two actions can guard on the same constraint', () => {
    // A rule is declared once and referenced wherever it applies; nothing
    // about naming it on one action spends it.
    const {models, warnings} =
        withTwoActions(['Defensible'], [judged('Defensible')]);
    expect(models[0].actions![0].guards).toEqual(['Defensible']);
    expect(warnings.some(w => w.includes('Defensible'))).toBe(false);
  });

  test('a constraint no action names loads without complaint', () => {
    // Declared and inert is a legitimate state: a model may publish a rule for
    // a reader, or for an action nobody has written yet. The loader has no
    // basis for reading prose and deciding which action ought to have named
    // it, and a guess here would train an author to ignore the warning.
    const {models, warnings} = withGuards(undefined, [{
                         name: 'Defensible',
                                 judgment:
                                     'The requested quantity must be defensible.',
                         on_violation: 'warn',
                       }]);
    expect(models[0].constraints!.map(c => c.name)).toEqual(['Defensible']);
        expect(warnings.some(w => w.includes(`'Defensible'`))).toBe(false);
      });
});
