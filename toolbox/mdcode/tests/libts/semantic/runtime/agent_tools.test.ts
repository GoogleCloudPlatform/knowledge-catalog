// Behavior specification for deriving agent tools from a model.
//
// The claim under test is that a model already carries what an agent needs, so
// an agent framework adapter has nothing left to invent: the tool's name, its
// description, its parameter types and the guidance a caller should follow all
// come out of the model. These tests read those out and check them, and check
// the outcome mapping an agent reads after a call.
//
// Nothing here opens a Spanner transaction. Deriving the tools is pure, which
// is the point: what an agent is offered can be checked without a database.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import * as spanner from '../../../../src/libts/gcp/spanner';
import {Action, Constraint, Entity, SemanticModel} from '../../../../src/libts/semantic/ir';
import {loadModels} from '../../../../src/libts/semantic/loader';
import {actionTools, callableTools, describeOutcome, entityTools, modelTools} from '../../../../src/libts/semantic/runtime/agent_tools';
import {Judge} from '../../../../src/libts/semantic/runtime/judge';
import {SemanticRuntime} from '../../../../src/libts/semantic/runtime/runtime';

const FIXTURES = path.join(__dirname, '..', 'fixtures');

// The tools never touch it: every test here reads the derivation, not a call.
const NO_CLIENT = {} as any;

// A model paired with a store, which is what the derivations take. The store
// is real enough to be there -- a runtime carrying none yields tools that
// refuse, which is its own test below -- and its client answers only the
// tests that make a call.
function rt(model: SemanticModel, client: unknown = NO_CLIENT): SemanticRuntime {
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


// A store that records the statements it is asked for and answers nothing.
// What these tests check is the QUESTION -- which SQL, which parameters, bound
// as what -- so the answer does not have to be interesting.
class FakeStore {
  readonly database = 'projects/p/instances/i/databases/d';
  readonly statements: spanner.Statement[] = [];
  queryStatus = 200;
  queryMessage: string|undefined = undefined;
  sessionThrows = false;

  async withSession<T>(fn: (s: string) => Promise<T>): Promise<T> {
    if (this.sessionThrows) {
      throw new Error('could not create a session on d (403).');
    }
    return await fn('sessions/1');
  }
  async beginReadWrite() {
    return {status: 200, result: {id: 'txn-1'}};
  }
  async executeSql(_s: string, _t: string, stmt: spanner.Statement) {
    this.statements.push(stmt);
    return {status: 200, result: {rows: [['1']]}};
  }
  async executeQuery(_s: string, stmt: spanner.Statement) {
    this.statements.push(stmt);
    if (this.queryStatus !== 200) {
      return {status: this.queryStatus, message: this.queryMessage};
    }
    return {status: 200, result: {rows: []}};
  }
  async commit() {
    return {status: 200, result: {commitTimestamp: '2026-09-12T00:00:00Z'}};
  }
  async rollback() {
    return {status: 200, result: {}};
  }
  get client(): spanner.SpannerDataClient {
    return this as unknown as spanner.SpannerDataClient;
  }
  get sql(): string[] {
    return this.statements.map(s => s.sql);
  }
}

function loadFixtureModel(name: string): SemanticModel {
  return loadModels(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))
      .models[0];
}

// The fixture's action is performed by MCP and gated by a constraint, so it is
// the "cannot run here" case twice over. Several tests below need one the
// runtime WOULD run, which means its own write and no guard.
function withExecutor(model: SemanticModel, over: Partial<Action>):
    SemanticModel {
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
    // A caller learns the shape of a refusal before it hits one.
    for (const guard of model.actions![0].guards ?? []) {
      expect(tools[0].description).toContain(guard);
    }
  });

  test('an entity parameter asks for a reference, a scalar for its type', () => {
    const byName = Object.fromEntries(tools[0].parameters.map(p => [p.name, p]));

    // `customer` is typed by the ontology, so the caller supplies something
    // that identifies one rather than a key it may not have.
    expect(byName['customer'].type).toBe('string');
    expect(byName['customer'].description).toContain('customer');
    expect(byName['customer'].description).toContain('more than one');

    expect(byName['quantity'].type).toBe('integer');
    expect(byName['quantity'].description).toContain('whole number');
  });

  test('every action parameter is required', () => {
    expect(tools[0].parameters.every(p => p.required)).toBe(true);
    expect(tools[0].parameters.map(p => p.name))
        .toEqual(model.actions![0].parameters.map(p => p.name));
  });

  test('a model with no actions yields no write tools', () => {
    const readOnly: SemanticModel = {...model, actions: []};
    expect(actionTools({runtime: rt(readOnly)})).toEqual([]);
  });

  test('a tool offers no way to approve anything', () => {
    // The caller that needs approving is not the party that grants it, so a
    // tool exposes no approval. Guard the shape rather than the wording: a
    // parameter that took approvals would show up.
    const names = tools[0].parameters.map(p => p.name.toLowerCase());
    expect(names.some(n => n.includes('approv'))).toBe(false);
    expect(Object.keys(tools[0])).not.toContain('approvals');
  });

  test('authored parameter descriptions and optional/default flags reach the tool', () => {
    const custom = withExecutor(model, {
      parameters: [
        {
          name: 'source',
          type: 'customer',
          description: 'The account money leaves.',
          isEntityRef: true,
        },
        {
          name: 'currency',
          type: 'String',
          description: 'ISO currency code.',
          default: 'USD',
          isEntityRef: false,
        },
        {
          name: 'memo',
          type: 'String',
          required: false,
          isEntityRef: false,
        },
      ],
    });
    const [tool] = actionTools({runtime: rt(custom)});
    const byName = Object.fromEntries(tool.parameters.map(p => [p.name, p]));

    expect(byName['source'].description).toStartWith('The account money leaves.');
    expect(byName['source'].description).toContain('identifies exactly one customer');
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


// Offering an agent a tool that refuses every call wastes its turn and tells
// it nothing it can act on. The tool is still derived -- an action the model
// declares should not vanish from what the model offers -- but it says up
// front that it will not work, and why.
describe('a tool this runtime would refuse', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  test('an action runnable here is marked so, with no excuse attached', () => {
    const [tool] = actionTools(
        {runtime: rt(withExecutor(model, RUNNABLE))});
    expect(tool.runnable).toBe(true);
    expect(tool.unavailable).toBeUndefined();
    expect(tool.description).not.toContain('will not work');
  });

  test('a guarded action is not runnable while nothing checks the guard', () => {
    const guarded = withExecutor(
        model, {...RUNNABLE, guards: ['OrderWithinCustomerCredit']});
    const [tool] = actionTools({runtime: rt(guarded)});
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('OrderWithinCustomerCredit');
    expect(tool.unavailable).toContain('refused rather than run unchecked');
  });

  test('a remote executor is not runnable without a handler', () => {
    // The fixture's own action: MCP commits outside the transaction.
    const [tool] = actionTools({runtime: rt(model)});
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('MCP');
    expect(tool.unavailable).toContain('rolled back');
  });

  test('a handler makes a remote executor runnable again', () => {
    const handler = async () => ({statements: []});
    const ungated = withExecutor(model, {guards: []});
    const [tool] =
        actionTools({runtime: rt(ungated), handler});
    expect(tool.runnable).toBe(true);
  });

  test('an action with no executor blames the binding, not the action', () => {
    // An executor is a physical facet. The action is fine; this binding
    // simply does not perform it.
    const unbound = withExecutor(model, {executor: undefined, guards: []});
    const [tool] = actionTools({runtime: rt(unbound)});
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('no executor');
    expect(tool.unavailable).toContain('somewhere else');
  });

  test('the reason reaches the description, where a caller will read it', () => {
    const [tool] = actionTools({runtime: rt(model)});
    expect(tool.description).toContain('will not work');
    expect(tool.description).toContain('Report that rather than retrying');
  });
});


// The runtime decides what it will not run. Deriving a tool has to reach the
// same verdict, and the only way to be sure of that is to ask the runtime
// rather than to keep a second copy of the rule here.
describe('what counts as runnable is the runtime\'s answer, not a copy', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  function guardedBy(constraint: Constraint, guard: string): SemanticModel {
    const base = withExecutor(model, {...RUNNABLE, guards: [guard]});
    return {...base, constraints: [constraint]};
  }

  test('a guard that only warns does not withhold the tool', () => {
    // An advisory rule reports and lets the write through, so the runtime
    // runs this action. A tool marked unrunnable would withhold one that
    // works -- and an agent told "this will not work" about a call that would
    // have, has no way to find that out.
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

  test('a guard naming nothing the model declares still withholds it', () => {
    // The runtime refuses this: a name it cannot resolve is not something to
    // guess about. A tool that called it anyway would fail every time.
    const other: Constraint = {
      name: 'SomethingElse',
      judgment: 'Something else must hold.',
      onViolation: 'reject',
    };
    const [tool] = actionTools({runtime: rt(guardedBy(other, 'NoSuchRule'))});
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('NoSuchRule');
  });

  // What the caller holds is half of the verdict. A judged guard is settled by
  // asking, so whether such an action can be offered depends on whether a
  // judge was passed to the derivation -- and the derivation has to say so
  // both ways round, or an adapter either withholds a tool that works or
  // offers one that is refused on its first call.
  const judged: Constraint = {
    name: 'CreditIsJustified',
    judgment: 'The memo must name what went wrong.',
    onViolation: 'reject',
  };

  const neverAsked: Judge = {
    name: 'test judge',
    decide: () => {
      throw new Error('the derivation must not call a judge');
    },
  };

  test('a judged guard withholds the tool when no judge was supplied', () => {
    const [tool] =
        actionTools({runtime: rt(guardedBy(judged, 'CreditIsJustified'))});
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('no judge');
  });

  test('a judge makes an action guarded by a judgment offerable', () => {
    const [tool] = actionTools(
        {runtime: rt(guardedBy(judged, 'CreditIsJustified')),
         judge: neverAsked});
    expect(tool.runnable).toBe(true);
    expect(tool.unavailable).toBeUndefined();
  });

  test('deriving the tools asks the judge nothing', () => {
    // `neverAsked` throws, so this passing is the assertion: a judge settles a
    // rule when an action runs, and listing what an agent is offered runs
    // none. A derivation that spent a model call per guarded action would make
    // `kcmd agent tools` cost money to read.
    const [tool] = actionTools(
        {runtime: rt(guardedBy(judged, 'CreditIsJustified')),
         judge: neverAsked});
    expect(tool.actionName).toBe('PlaceOrder');
  });

  test(
      'a judge does not make a rule out of a constraint that states none',
      () => {
        // Supplying a judge must not widen what is offered past what it
        // settles, and there is nothing to put to a judge here. A caller sent
        // to fetch a judge, who fetched one and was refused again, has been
        // sent the wrong way.
        const bodyless: Constraint = {
      name: 'QuantityIsPositive',
      onViolation: 'reject',
    };
        const [tool] = actionTools({
          runtime: rt(guardedBy(bodyless, 'QuantityIsPositive')),
          judge: neverAsked,
        });
    expect(tool.runnable).toBe(false);
        expect(tool.unavailable).toContain('states no rule to put to a judge');
  });
});


// A refusal the model alone decides is a refusal every call would meet. Asking
// it once, before the tool is offered, is the difference between an agent that
// never sees a dead tool and one that spends a turn -- and a transaction --
// finding out. These are the answers that were previously reached only where
// the runtime binds, which is inside the transaction.
describe(
    'a binding this runtime cannot fill is refused before the store', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  test('an object reference to a composite-keyed entity', () => {
        // `customer` is the type of PlaceOrder's entity-typed parameter. Give
        // it a two-part key and no single statement parameter can carry the
        // reference, so binding refuses -- whatever row the caller named.
    const composite = {
      ...model,
      entities: model.entities.map(
          e => e.name === 'customer' ?
              {...e, keys: ['c_custkey', 'c_nationkey']} :
              e),
    };
        const [tool] =
            actionTools({runtime: rt(withExecutor(composite, RUNNABLE))});
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('2 parts');
  });

      test(
          'an integer-keyed entity the action creates is still offered', () => {
            // `orders` is keyed by o_orderkey, an Integer. The runtime writes
            // no key of its own, so the type of a column it never fills is not
            // a reason to withhold the tool.
    const creates = withExecutor(model, {
      ...RUNNABLE,
      affects: [{concept: 'orders', operation: 'create'}],
      executor: {
        kind: 'sql',
        sql: {
          statements:
              ['INSERT INTO orders (o_orderkey) VALUES (@quantity)'],
        },
      },
    });
    const typed = {
      ...creates,
      entities: creates.entities.map(
                  e => e.name === 'orders' ? {
                ...e,
                fields: e.fields.map(
                        f => f.name === 'o_orderkey' ?
                            {...f, type: 'Integer' as const} :
                            f),
              } :
              e),
    };
    const [tool] = actionTools({runtime: rt(typed)});
    expect(tool.runnable).toBe(true);
  });

  test('a handler is not held to it, because it writes its own DML', () => {
        // A handler is given `refs` whole and may spell a composite key across
        // as many parameters as it likes. The question is not the handler's to
        // answer.
    const composite = {
      ...model,
      entities: model.entities.map(
          e => e.name === 'customer' ?
              {...e, keys: ['c_custkey', 'c_nationkey']} :
              e),
    };
    const [tool] = actionTools({
      runtime: rt(withExecutor(composite, {guards: []})),
      handler: async () => ({statements: []}),
    });
    expect(tool.runnable).toBe(true);
  });
});


// The description tells a caller what it will meet. A rule that stops nothing
// is not something it will meet, and saying otherwise teaches an LLM to expect
// a refusal that never comes -- or to explain one that did not happen.
describe('what a tool says it is gated by', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  test('an advisory guard is not announced as a gate', () => {
    const advisory: Constraint = {
      name: 'AmountIsLarge',
      judgment: 'A quantity over 1000 should be called out.',
      onViolation: 'warn',
    };
    const base = withExecutor(model, {...RUNNABLE, guards: ['AmountIsLarge']});
    const [tool] = actionTools(
        {runtime: rt({...base, constraints: [advisory]})});
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
    const [tool] = actionTools(
        {runtime: rt({...base, constraints: [blocking]})});
    expect(tool.description).toContain('gated by QuantityIsSane');
    expect(tool.description)
        .toContain(
            '- QuantityIsSane: The quantity argument must be positive. ' +
            'Ask finance first.');
  });

  test('authored parameter descriptions normalize terminators and keep temporal format guidance', () => {
    const base = withExecutor(model, {
      ...RUNNABLE,
      parameters: [
        {name: 'customer', type: 'customer', isEntityRef: true, description: 'The buyer'},
        {name: 'settledOn', type: 'Date', isEntityRef: false, description: 'When the transfer settles.'},
      ],
    });
    const [tool] = actionTools({runtime: rt(base)});
    expect(tool.parameters[0].description).toBe(
        'The buyer. Give its key, or text that identifies exactly one ' +
        'customer; the call fails when nothing matches or more than one does.');
    expect(tool.parameters[1].description).toBe(
        'When the transfer settles. As a date, YYYY-MM-DD.');
  });
});


// The read side owes the same answer the write side owes, for the same reason.
describe('a lookup that could not return a row says so up front', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  function lookupFor(entities: Entity[], name: string) {
    return entityTools({runtime: rt({...model, entities})})
        .find(t => t.entityName === name)!;
  }

  test('a bound entity is runnable', () => {
    const tool = lookupFor(model.entities, 'customer');
    expect(tool.runnable).toBe(true);
    expect(tool.unavailable).toBeUndefined();
  });

  test('an abstract entity has no table to read', () => {
    const entities = model.entities.map(
        e => e.name === 'customer' ? {...e, abstract: true} : e);
    const tool = lookupFor(entities, 'customer');
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('abstract');
  });

  test('an entity with no field bound to a column has nothing to read', () => {
    const entities = model.entities.map(
        e => e.name === 'customer' ?
            {...e, fields: e.fields.map(f => ({...f, expression: undefined}))} :
            e);
    const tool = lookupFor(entities, 'customer');
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('binding profile');
  });

  test('the reason a call reports is the reason the tool advertised',
       async () => {
         const entities = model.entities.map(
             e => e.name === 'customer' ? {...e, abstract: true} : e);
         const tool = lookupFor(entities, 'customer');
         const rows = await tool.invoke({});
         expect(rows.problem).toBe(tool.unavailable);
       });
});


// A `sql` executor's claim is that what runs is what the catalog published. A
// handler exists for the executors this runtime cannot call, and it is one
// function for the whole model -- so passing it everywhere would retract that
// claim for every action at once, and nothing would say so.
describe('a handler does not displace an action\'s own statements', () => {
  const model = loadFixtureModel('actions_place_order.yaml');
  const HANDLER_SQL = 'UPDATE orders SET o_totalprice = 999 WHERE 1 = 1';

  test('the model\'s DML runs, not the handler\'s', async () => {
    const store = new FakeStore();
    const [tool] = actionTools({
      runtime: rt(withExecutor(model, RUNNABLE), store.client),
      handler: async () => ({statements: [{sql: HANDLER_SQL}]}),
    });
    const result = await tool.invoke({customer: 'Alice', quantity: 2});
    expect(result.applied).toBe(true);
    expect(store.sql).toContain(
        'UPDATE orders SET o_totalprice = 0 WHERE 1 = 0');
    expect(store.sql).not.toContain(HANDLER_SQL);
  });

  test('a remote executor still gets the handler, which is what it is for',
       async () => {
         // The fixture's PlaceOrder is performed by MCP, so without a handler
         // there is nothing this runtime can run.
         const store = new FakeStore();
         const [tool] = actionTools({
           runtime: rt(withExecutor(model, {guards: []}), store.client),
           handler: async () => ({statements: [{sql: HANDLER_SQL}]}),
         });
         expect(tool.runnable).toBe(true);
         const result = await tool.invoke({customer: 'Alice', quantity: 2});
         expect(result.applied).toBe(true);
         expect(store.sql).toContain(HANDLER_SQL);
       });
});


describe('entity tools', () => {
  const model = loadFixtureModel('actions_place_order.yaml');
  const tools = entityTools({runtime: rt(model)});

  test('one lookup tool per entity', () => {
    expect(tools.map(t => t.name)).toEqual(model.entities.map(
        e => `find_${e.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()}`));
  });

  test('the filters are the fields the profile bound to columns', () => {
    const orders = tools.find(t => t.entityName === 'orders')!;
    expect(orders.parameters.map(p => p.name))
        .toEqual(model.entities.find(e => e.name === 'orders')!.fields.map(
            f => f.name));
  });

  test('every filter is optional', () => {
    // Giving none returns the first rows, which is how an agent starts looking.
    for (const tool of tools) {
      expect(tool.parameters.every(p => !p.required)).toBe(true);
    }
  });

  test('the description states what the tool cannot do', () => {
    // An agent that knows the limits asks a question the tool can answer.
    const orders = tools.find(t => t.entityName === 'orders')!;
    expect(orders.description).toContain('exact match');
    expect(orders.description).toContain('cannot join');
  });
});


// A coded field's allowed values are written in exactly one place -- the
// field's description -- and a caller that does not get them has to guess one.
// The action side already passes a parameter's description through; this is the
// read side agreeing.
describe('what a lookup filter says it matches', () => {
  const model = loadModels(`version: "0.2.0.dev0/google"
semantic_model:
  - name: m
    entities:
      - name: LineItem
        primary_key: [lineItemId]
        source: //spanner.googleapis.com/projects/p/instances/i/databases/d/tables/LineItem
        fields:
          - {name: lineItemId, datatype: String, expression: line_item_id}
          - name: type
            datatype: String
            description: item, tax, fee, or credit.
            expression: type
          - {name: amount, datatype: Decimal, expression: amount}
`).models[0];
  const [lineItem] = entityTools({runtime: rt(model)});

  test('the field\'s own description leads', () => {
    const type = lineItem.parameters.find(p => p.name === 'type')!;
    expect(type.description.startsWith('item, tax, fee, or credit.'))
        .toBe(true);
  });

  test('how the filter behaves is still said, after it', () => {
    // The two halves are owed by different authors: what the field holds is
    // the model's, that the match is exact is the derivation's.
    const type = lineItem.parameters.find(p => p.name === 'type')!;
    expect(type.description).toContain('Match LineItem.type exactly');
    expect(type.description).toContain('Omit to leave it unfiltered');
  });

  test('a field the model says nothing about gets only the behavior', () => {
    const amount = lineItem.parameters.find(p => p.name === 'amount')!;
    expect(amount.description).toBe(
        'Match LineItem.amount exactly. Omit to leave it unfiltered.');
  });
});


// A filter has to be bound as the type its field declares. Casting the column
// to STRING would let one predicate shape serve every type, and no index can
// answer it -- a lookup on a primary key would scan the table.
describe('how a lookup filter reaches the store', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  // The fixture declares no field types, so every field travels as text. This
  // one gives `orders` a typed key, which is the case worth checking.
  function typedOrders(): SemanticModel {
    const orders = model.entities.find(e => e.name === 'orders')!;
    const typed: Entity = {
      ...orders,
      dataSource:
          '//spanner.googleapis.com/projects/p/instances/i/databases/d/tables/Orders',
      fields: orders.fields.map(
          f => f.name === 'o_orderkey' ? {...f, type: 'Integer'} : f),
    };
    return {...model, entities: [typed]};
  }

  test('the column is compared as itself, not cast to text', async () => {
    const store = new FakeStore();
    const [tool] = entityTools({runtime: rt(typedOrders(), store.client)});
    await tool.invoke({o_orderkey: '12345'});

    const [stmt] = store.statements;
    expect(stmt.sql).toContain('WHERE o_orderkey = @f_0');
    expect(stmt.sql).not.toContain('CAST(o_orderkey AS STRING) =');
    expect(stmt.paramTypes!['f_0']).toEqual({code: 'INT64'});
  });

  test('a value the field\'s type has no room for is reported, not matched',
       async () => {
         const store = new FakeStore();
         const [tool] = entityTools({runtime: rt(typedOrders(), store.client)});
         const rows = await tool.invoke({o_orderkey: 'not-a-number'});
         expect(rows.problem).toContain('Integer');
         expect(rows.problem).toContain('No orders has o_orderkey');
         // Nothing was asked of the store: there is no row it could mean.
         expect(store.statements).toHaveLength(0);
       });

  test('an empty string filters on the empty string', async () => {
    // The dangerous reading is the other one. Dropping '' as though the filter
    // were absent turns a lookup meant to find one row into an unfiltered read
    // of the first rows, which comes back to the agent looking like an answer.
    // `bindScalar` draws the line in the same place for the write path.
    const store = new FakeStore();
    const [tool] = entityTools({runtime: rt(model, store.client)});
    await tool.invoke({o_orderkey: ''});

    const [stmt] = store.statements;
    expect(stmt.sql).toContain('WHERE o_orderkey = @f_0');
    expect(stmt.params!['f_0']).toBe('');
  });

  test('an omitted filter is not a filter', async () => {
    const store = new FakeStore();
    const [tool] = entityTools({runtime: rt(model, store.client)});
    await tool.invoke({o_orderkey: undefined});

    const [stmt] = store.statements;
    expect(stmt.sql).not.toContain('WHERE');
  });
});


// Every other failure in a lookup comes back as something the agent can read
// out. A store that refuses the read is not a different kind of thing, and a
// thrown error reaches an adapter as a crashed tool call instead.
describe('a lookup the store will not answer', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  function bound(): SemanticModel {
    const orders = model.entities.find(e => e.name === 'orders')!;
    return {
      ...model,
      entities: [{
        ...orders,
        dataSource:
            '//spanner.googleapis.com/projects/p/instances/i/databases/d/tables/Orders',
      }],
    };
  }

  test('a refused read is reported rather than thrown', async () => {
    const store = new FakeStore();
    store.queryStatus = 403;
    store.queryMessage = 'caller lacks spanner.databases.select';
    const [tool] = entityTools({runtime: rt(bound(), store.client)});
    const rows = await tool.invoke({});
    expect(rows.problem).toContain('Could not read orders');
    expect(rows.problem).toContain('spanner.databases.select');
    expect(rows.rows).toEqual([]);
  });

  test('a session that cannot be opened is reported too', async () => {
    const store = new FakeStore();
    store.sessionThrows = true;
    const [tool] = entityTools({runtime: rt(bound(), store.client)});
    const rows = await tool.invoke({});
    expect(rows.problem).toContain('Could not read orders');
    expect(rows.problem).toContain('403');
  });
});


// Both halves land in one name space at the adapter, and a duplicate name
// there is the framework's to resolve however it likes. Deriving them together
// is the only place that can see the collision at all.
describe('one name space for everything a model offers', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  test('an action keeps its name and the lookup takes the longer form', () => {
    // `customer` the entity yields `find_customer`; an action named
    // `FindCustomer` wants the same tool name, and it is the author's own.
    const clashing = {
      ...model,
      actions: [{...model.actions![0], name: 'FindCustomer'}],
    };
    const {lookups, actions} = modelTools({runtime: rt(clashing)});
    expect(actions.map(t => t.name)).toEqual(['find_customer']);
    expect(lookups.map(t => t.name)).toEqual(['find_orders', 'lookup_customer']);
  });

  test('two actions that snake-case alike are still told apart', () => {
    const twins = {
      ...model,
      actions: [
        {...model.actions![0], name: 'IssueCredit'},
        {...model.actions![0], name: 'issue-credit'},
      ],
    };
    const {actions} = modelTools({runtime: rt(twins)});
    expect(actions.map(t => t.name)).toEqual(['issue_credit', 'issue_credit_2']);
  });

  test('nothing is renamed when nothing collides', () => {
    const {lookups, actions} = modelTools({runtime: rt(model)});
    expect(actions.map(t => t.name)).toEqual(['place_order']);
    expect(lookups.map(t => t.name)).toEqual(['find_orders', 'find_customer']);
  });
});


describe('sorting the tools an adapter can actually offer', () => {
  const model = loadFixtureModel('actions_place_order.yaml');
  const runnable = withExecutor(model, RUNNABLE);

  test('everything runnable is offered, lookups before actions', () => {
    const {callable, withheld} =
        callableTools(modelTools({runtime: rt(runnable)}));
    expect(callable.map(t => t.name)).toEqual([
      'find_orders', 'find_customer', 'place_order'
    ]);
    expect(withheld).toEqual([]);
  });

  test('a guarded action is withheld, and says why', () => {
    // A guard is the case that matters: the model says this write must be
    // checked, no checker exists, so the tool must not be offered as callable.
    const guarded = {
      ...withExecutor(model, {...RUNNABLE, guards: ['UnderReview']}),
      constraints: [{
        name: 'UnderReview',
                     judgment: 'The quantity must be under 25.',
        onViolation: 'escalate',
      }] as Constraint[],
    };
    const {callable, withheld} =
        callableTools(modelTools({runtime: rt(guarded)}));
    expect(callable.map(t => t.name)).toEqual(['find_orders', 'find_customer']);
    expect(withheld.map(t => t.name)).toEqual(['place_order']);
    expect(withheld[0].unavailable).toContain('UnderReview');
  });

  test('the instruction is carried through untouched', () => {
    const tools = modelTools({runtime: rt(runnable)});
    expect(callableTools(tools).instruction).toBe(tools.instruction);
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

  test('how to use the tools is supplied whether or not the model speaks',
       () => {
         // The half that describes the tools is the derivation's to state: it
         // is a contract this module defines, and a model that says nothing
         // has not thereby withdrawn it.
         const {instruction} = modelTools({runtime: rt(model)});
         expect(model.aiContext?.instructions).toBeUndefined();
         expect(instruction).toContain('Never invent an identifier');
         expect(instruction).toContain('lookup tools');
         expect(instruction).toContain('did not happen');
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


describe('what a caller is told about an outcome', () => {
  test('a commit reports when, and what it acted on', () => {
    // The rows, not the arguments: an agent that said "Alice" should report
    // the customer it actually wrote to.
    const result = describeOutcome({
      status: 'committed',
      commitTimestamp: '2026-09-11T00:00:00Z',
      refs: {buyer: {entity: 'customer', keys: ['42'], input: 'Alice'}},
    });
    expect(result.applied).toBe(true);
    expect(result.committedAt).toBe('2026-09-11T00:00:00Z');
    expect(result.actedOn).toEqual({buyer: ['42']});
    expect(result.unknown).toBeUndefined();
  });

  test('a commit carries what a rule reported without stopping it', () => {
    // An advisory guard that did not hold, or one nothing could put to a
    // judge, still committed. An agent shown only `applied: true` would report
    // a write that met every rule the model states.
    const result = describeOutcome({
      status: 'committed',
      refs: {},
      warnings: ['\'CreditIsJustified\' was not checked: no judge to ask.'],
    });
    expect(result.applied).toBe(true);
    expect(result.warnings).toEqual([
      '\'CreditIsJustified\' was not checked: no judge to ask.'
    ]);
  });

  test('a commit with nothing to report carries no warnings key', () => {
    const result = describeOutcome({status: 'committed', refs: {}});
    expect(result.warnings).toBeUndefined();
  });

  test('a refusal is a failure the caller can read and act on', () => {
    const result = describeOutcome(
        {status: 'error', message: 'No Order matches \'xyz\'.'});
    expect(result.applied).toBe(false);
    expect(result.reason).toContain('No Order matches');
    expect(result.whatToDo).toContain('Nothing was written');
    expect(result.unknown).toBeUndefined();
  });

  test('a commit nothing can establish is not reported as a failure', () => {
    // `applied: false` alone would invite a retry, and the write may already
    // have landed. This is the one outcome where retrying is the wrong move.
    const result = describeOutcome({
      status: 'error',
      message: 'The commit did not answer.',
      indeterminate: true,
    });
    expect(result.applied).toBe(false);
    expect(result.unknown).toBe(true);
    expect(result.whatToDo).toContain('Do NOT retry');
    expect(result.whatToDo).toContain('read the data back');
  });

  test('no outcome hands the caller an approval', () => {
    // Whatever comes back, the party that needs approving cannot grant it.
    for (const result
             of [describeOutcome(
                     {status: 'committed', refs: {}, commitTimestamp: 't'}),
                 describeOutcome({status: 'error', message: 'no'}),
    ]) {
      expect(Object.keys(result).join(' ').toLowerCase())
          .not.toContain('approv');
    }
  });
});


// `fieldBinding` is ir.ts's stated single source of truth for whether a field
// is bound, and a field awaiting transpilation carries only the vendor
// expression it was imported with. `createSemanticRuntimes` transpiles nothing,
// so that is exactly the state a vendor-imported model reaches these tools in.
// Consulting `expression` alone reported every one of its entities as having
// no column to read, and told the caller to push the model with a binding
// profile -- which is not the problem and would not fix it.
describe('an entity whose fields await transpilation', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  function untranspiled(name: string): Entity[] {
    return model.entities.map(entity => {
      if (entity.name !== name) return entity;
      return {
        ...entity,
        fields: entity.fields.map(
            field => ({
              ...field,
              expression: undefined,
              importedExpression: field.expression,
              importedDialect: 'SNOWFLAKE',
            })),
      };
    });
  }

  test('is readable, because the imported expression names a real column',
       () => {
         const tool =
             entityTools({runtime: rt({...model, entities: untranspiled('customer')})})
                 .find(t => t.entityName === 'customer')!;
         expect(tool.runnable).toBe(true);
         expect(tool.unavailable).toBeUndefined();
       });

  test('offers the same filters it would after transpilation', () => {
    const before = entityTools({runtime: rt(model)})
                       .find(t => t.entityName === 'customer')!;
    const after =
        entityTools({runtime: rt({...model, entities: untranspiled('customer')})})
            .find(t => t.entityName === 'customer')!;
    expect(after.parameters.map(p => p.name))
        .toEqual(before.parameters.map(p => p.name));
  });
});
