// Behavior specification for deriving action tools and schema metadata from a
// model.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as spanner from '../../../../src/libts/gcp/spanner';
import {Action, Constraint, Entity, SemanticModel} from '../../../../src/libts/semantic/ir';
import {loadModels} from '../../../../src/libts/semantic/loader';
import {actionTools, modelTools, readableEntities} from '../../../../src/libts/semantic/runtime/agent_tools';
import {dialectFor} from '../../../../src/libts/semantic/runtime/dialect';
import {SemanticRuntime} from '../../../../src/libts/semantic/runtime/runtime';

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const NO_CLIENT = {} as any;

function rt(
    model: SemanticModel, client: unknown = NO_CLIENT): SemanticRuntime {
  return {
    model,
    document: 'test',
    store: {
      kind: 'spanner',
      name: 'projects/p/instances/i/databases/d',
      project: 'p',
      instance: 'i',
      database: 'd',
      client: client as spanner.SpannerDataClient,
    },
    profile: 'default',
    entryGroup: 'eg',
  };
}

function loadFixtureModel(name: string): SemanticModel {
  return loadModels(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))
      .models[0];
}

function withExecutor(
    model: SemanticModel, over: Partial<Action>): SemanticModel {
  const [action] = model.actions!;
  return {...model, actions: [{...action, ...over}]};
}

const RUNNABLE: Partial<Action> = {
  executor: {
    kind: 'sql',
    sql: {statements: ['UPDATE orders SET o_totalprice = 0 WHERE 1 = 0']},
  },
  guards: [],
};


describe('action tools', () => {
  const model = loadFixtureModel('actions_place_order.yaml');
  const tools = actionTools({runtime: rt(model)});

  test('one tool per action, named the way tool APIs expect', () => {
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('place_order');
    expect(tools[0].actionName).toBe('PlaceOrder');
  });

  test('the description carries what the action says it does', () => {
    const action = model.actions![0];
    expect(action.description).toBeTruthy();
    expect(tools[0].description).toContain(action.description!.trim());
  });

  test('the description carries the guidance for AI callers', () => {
    const instructions = model.actions![0].aiContext?.instructions;
    expect(instructions).toBeTruthy();
    expect(tools[0].description).toContain(instructions!.trim());
  });

  test('the description names the rules that gate the call', () => {
    for (const guard of model.actions![0].guards ?? []) {
      expect(tools[0].description).toContain(guard);
    }
  });

  test(
      'every parameter asks for a scalar, whichever way it was written', () => {
        const byName =
            Object.fromEntries(tools[0].parameters.map(p => [p.name, p]));

        expect(byName['customer'].type).toBe('integer');
        expect(byName['customer'].description)
            .toBe('The customer\'s account number.');

        expect(byName['quantity'].type).toBe('integer');
        expect(byName['quantity'].description).toContain('whole number');
      });

  test('every action parameter is required by default', () => {
    expect(tools[0].parameters.every(p => p.required)).toBe(true);
    expect(tools[0].parameters.map(p => p.name))
        .toEqual(model.actions![0].parameters.map(p => p.name));
  });

  test('a model with no actions yields no write tools', () => {
    const readOnly: SemanticModel = {...model, actions: []};
    expect(actionTools({runtime: rt(readOnly)})).toEqual([]);
  });

  test('a tool offers no way to approve anything', () => {
    const names = tools[0].parameters.map(p => p.name.toLowerCase());
    expect(names.some(n => n.includes('approv'))).toBe(false);
    expect(Object.keys(tools[0])).not.toContain('approvals');
  });

  test(
      'authored parameter descriptions and optional/default flags reach the tool',
      () => {
        const custom = withExecutor(model, {
          parameters: [
            {
              name: 'source',
              type: 'Integer',
              concept: 'customer',
              field: 'id',
              description: 'The account money leaves.',
            },
            {
              name: 'currency',
              type: 'String',
              description: 'ISO currency code.',
              default: 'USD',
            },
            {
              name: 'memo',
              type: 'String',
              required: false,
            },
          ],
        });
        const [tool] = actionTools({runtime: rt(custom)});
        const byName =
            Object.fromEntries(tool.parameters.map(p => [p.name, p]));

        expect(byName['source'].description).toBe('The account money leaves.');
        expect(byName['source'].type).toBe('integer');
        expect(byName['source'].required).toBe(true);

        expect(byName['currency'].description).toBe('ISO currency code.');
        expect(byName['currency'].required).toBe(false);
        expect(byName['currency'].default).toBe('USD');

        expect(byName['memo'].required).toBe(false);
      });

  test('the tool description includes the gating constraint rule text', () => {
    expect(tools[0].description)
        .toContain(
            'OrderWithinCustomerCredit: The resulting ' +
            'orders.o_totalprice must not exceed the credit this customer ' +
            'has on record. That figure is not stated in the arguments, so ' +
            'read it before answering. An order cannot exceed the credit on ' +
            'record for this customer.');
  });
});


describe('what counts as runnable under a profile', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  function guardedBy(constraint: Constraint, guard: string): SemanticModel {
    const base = withExecutor(model, {...RUNNABLE, guards: [guard]});
    return {...base, constraints: [constraint]};
  }

  test('an action runnable here is marked so, with no excuse attached', () => {
    const [tool] = actionTools({runtime: rt(withExecutor(model, RUNNABLE))});
    expect(tool.runnable).toBe(true);
    expect(tool.unavailable).toBeUndefined();
    expect(tool.description).not.toContain('will not work');
  });

  test('a remote executor is not runnable directly', () => {
    const [tool] = actionTools({runtime: rt(model)});
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('MCP');
    expect(tool.unavailable).toContain('Declare the action with a \'sql\'');
  });

  test('an action with no executor blames the binding, not the action', () => {
    const unbound = withExecutor(model, {executor: undefined, guards: []});
    const [tool] = actionTools({runtime: rt(unbound)});
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('no executor');
    expect(tool.unavailable).toContain('somewhere else');
  });

  test(
      'the reason reaches the description, where a caller will read it', () => {
        const [tool] = actionTools({runtime: rt(model)});
        expect(tool.description).toContain('will not work');
        expect(tool.description).toContain('Report that rather than retrying');
      });

  test('a guard that only warns does not withhold the tool', () => {
    const advisory: Constraint = {
      name: 'AmountIsLarge',
      judgment: 'A quantity over 1000 should be called out.',
      onViolation: 'warn',
    };
    const [tool] =
        actionTools({runtime: rt(guardedBy(advisory, 'AmountIsLarge'))});
    expect(tool.runnable).toBe(true);
    expect(tool.unavailable).toBeUndefined();
  });

  test('a well-formed judged guard is runnable', () => {
    const judged: Constraint = {
      name: 'CreditIsJustified',
      judgment: 'The memo must name what went wrong.',
      onViolation: 'reject',
    };
    const [tool] =
        actionTools({runtime: rt(guardedBy(judged, 'CreditIsJustified'))});
    expect(tool.runnable).toBe(true);
    expect(tool.unavailable).toBeUndefined();
  });

  test('a guard naming nothing the model declares withholds the tool', () => {
    const other: Constraint = {
      name: 'SomethingElse',
      judgment: 'Something else must hold.',
      onViolation: 'reject',
    };
    const [tool] = actionTools({runtime: rt(guardedBy(other, 'NoSuchRule'))});
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('NoSuchRule');
  });

  test('a guard whose constraint states no rule text withholds the tool', () => {
    const bodyless: Constraint = {
      name: 'QuantityIsPositive',
      onViolation: 'reject',
    };
    const [tool] =
        actionTools({runtime: rt(guardedBy(bodyless, 'QuantityIsPositive'))});
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('states no rule to put to a judge');
  });
});


describe('the shape of an entity key withholds no tool', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  test('a key in two parts is offered like any other', () => {
    const composite = {
      ...model,
      entities: model.entities.map(
          e => e.name === 'customer' ?
              {...e, keys: ['c_custkey', 'c_nationkey']} :
              e),
    };
    const [tool] =
        actionTools({runtime: rt(withExecutor(composite, RUNNABLE))});
    expect(tool.runnable).toBe(true);
    expect(tool.unavailable).toBeUndefined();
  });

  test('a caller names each part of it as an ordinary parameter', () => {
    const twoPart = withExecutor(model, {
      ...RUNNABLE,
      parameters: [
        {
          name: 'custkey',
          type: 'Integer',
          concept: 'customer',
          field: 'c_custkey'
        },
        {
          name: 'nationkey',
          type: 'Integer',
          concept: 'customer',
          field: 'c_nationkey'
        },
      ],
    });
    const [tool] = actionTools({runtime: rt(twoPart)});
    expect(tool.parameters.map(p => [p.name, p.type])).toEqual([
      ['custkey', 'integer'],
      ['nationkey', 'integer'],
    ]);
  });
});


describe('what a tool says it is gated by', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  test('an advisory guard is not announced as a gate', () => {
    const advisory: Constraint = {
      name: 'AmountIsLarge',
      judgment: 'A quantity over 1000 should be called out.',
      onViolation: 'warn',
    };
    const base = withExecutor(model, {...RUNNABLE, guards: ['AmountIsLarge']});
    const [tool] =
        actionTools({runtime: rt({...base, constraints: [advisory]})});
    expect(tool.runnable).toBe(true);
    expect(tool.description).not.toContain('gated by');
  });

  test('a guard that does stop the call is', () => {
    const blocking: Constraint = {
      name: 'QuantityIsSane',
      judgment: 'The quantity argument must be positive.',
      description: 'Ask finance first.',
      onViolation: 'reject',
    };
    const base = withExecutor(model, {...RUNNABLE, guards: ['QuantityIsSane']});
    const [tool] =
        actionTools({runtime: rt({...base, constraints: [blocking]})});
    expect(tool.description).toContain('gated by QuantityIsSane');
    expect(tool.description)
        .toContain(
            '- QuantityIsSane: The quantity argument must be positive. ' +
            'Ask finance first.');
  });

  test(
      'authored parameter descriptions normalize terminators and keep temporal format guidance',
      () => {
        const base = withExecutor(model, {
          ...RUNNABLE,
          parameters: [
            {
              name: 'customer',
              type: 'Integer',
              concept: 'customer',
              field: 'id',
              description: 'The buyer'
            },
            {
              name: 'settledOn',
              type: 'Date',
              description: 'When the transfer settles.'
            },
          ],
        });
        const [tool] = actionTools({runtime: rt(base)});
        expect(tool.parameters[0].description).toBe('The buyer.');
        expect(tool.parameters[1].description)
            .toBe('When the transfer settles. As a date, YYYY-MM-DD.');
      });
});


describe('one name space for everything a model offers', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  test('two actions that snake-case alike are still told apart', () => {
    const twins = {
      ...model,
      actions: [
        {...model.actions![0], name: 'IssueCredit'},
        {...model.actions![0], name: 'issue-credit'},
      ],
    };
    const {actions} = modelTools({runtime: rt(twins)});
    expect(actions.map(t => t.name)).toEqual([
      'issue_credit', 'issue_credit_2'
    ]);
  });

  test('nothing is renamed when nothing collides', () => {
    const {actions} = modelTools({runtime: rt(model)});
    expect(actions.map(t => t.name)).toEqual(['place_order']);
  });
});


describe('the instruction an agent is given comes from the model', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  test('the model\'s own words come first, verbatim', () => {
    const stated = {
      ...model,
      aiContext: {instructions: 'You work a returns desk for this business.'},
    };
    const {instruction} = modelTools({runtime: rt(stated)});
    expect(instruction.startsWith('You work a returns desk for this business.'))
        .toBe(true);
  });

  test(
      'how to use the tools is supplied whether or not the model speaks',
      () => {
        const {instruction} = modelTools({runtime: rt(model)});
        expect(model.aiContext?.instructions).toBeUndefined();
        expect(instruction).toContain('Never invent an identifier');
        expect(instruction).toContain('must not happen');
      });

  test('the two parts are separated, not run together', () => {
    const stated = {
      ...model,
      aiContext: {instructions: 'You work a returns desk.'},
    };
    const {instruction} = modelTools({runtime: rt(stated)});
    expect(instruction).toContain('You work a returns desk.\n\nNever invent');
  });
});


describe('an entity whose fields await transpilation', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  function untranspiled(name: string): Entity[] {
    return model.entities.map(entity => {
      if (entity.name !== name) return entity;
      return {
        ...entity,
        fields: entity.fields.map(field => ({
                                    ...field,
                                    expression: undefined,
                                    importedExpression: field.expression,
                                    importedDialect: 'SNOWFLAKE',
                                  })),
      };
    });
  }

  test('yields the same readable schema it would after transpilation', () => {
    const baseRuntime = rt(model);
    const dialect = dialectFor(baseRuntime.store);
    const before = readableEntities(baseRuntime, dialect)
                       .find(r => r.entity.name === 'customer')!;
    const after =
        readableEntities(
            rt({...model, entities: untranspiled('customer')}), dialect)
            .find(r => r.entity.name === 'customer')!;
    expect(after.fields).toEqual(before.fields);
  });
});
