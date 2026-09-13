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

import {actionTools, callableTools, describeOutcome, entityTools, modelTools} from '../../../src/libts/semantic/agent_tools';
import {Action, Constraint, Entity, SemanticModel} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';
import * as spanner from '../../../src/libts/gcp/spanner';

const FIXTURES = path.join(__dirname, 'fixtures');

// The tools never touch it: every test here reads the derivation, not a call.
const NO_CLIENT = {} as any;


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
  const tools = actionTools({model, client: NO_CLIENT});

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
    expect(actionTools({model: readOnly, client: NO_CLIENT})).toEqual([]);
  });

  test('a tool offers no way to approve anything', () => {
    // The caller that needs approving is not the party that grants it, so a
    // tool exposes no approval. Guard the shape rather than the wording: a
    // parameter that took approvals would show up.
    const names = tools[0].parameters.map(p => p.name.toLowerCase());
    expect(names.some(n => n.includes('approv'))).toBe(false);
    expect(Object.keys(tools[0])).not.toContain('approvals');
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
        {model: withExecutor(model, RUNNABLE), client: NO_CLIENT});
    expect(tool.runnable).toBe(true);
    expect(tool.unavailable).toBeUndefined();
    expect(tool.description).not.toContain('will not work');
  });

  test('a guarded action is not runnable while nothing checks the guard', () => {
    const guarded = withExecutor(
        model, {...RUNNABLE, guards: ['RequestedQuantityIsPositive']});
    const [tool] = actionTools({model: guarded, client: NO_CLIENT});
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('RequestedQuantityIsPositive');
    expect(tool.unavailable).toContain('refused rather than run unchecked');
  });

  test('a remote executor is not runnable without a handler', () => {
    // The fixture's own action: MCP commits outside the transaction.
    const [tool] = actionTools({model, client: NO_CLIENT});
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('MCP');
    expect(tool.unavailable).toContain('rolled back');
  });

  test('a handler makes a remote executor runnable again', () => {
    const handler = async () => ({statements: []});
    const ungated = withExecutor(model, {guards: []});
    const [tool] =
        actionTools({model: ungated, client: NO_CLIENT, handler});
    expect(tool.runnable).toBe(true);
  });

  test('an action with no executor blames the binding, not the action', () => {
    // An executor is a physical facet. The action is fine; this binding
    // simply does not perform it.
    const unbound = withExecutor(model, {executor: undefined, guards: []});
    const [tool] = actionTools({model: unbound, client: NO_CLIENT});
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('no executor');
    expect(tool.unavailable).toContain('somewhere else');
  });

  test('the reason reaches the description, where a caller will read it', () => {
    const [tool] = actionTools({model, client: NO_CLIENT});
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
      expression: 'quantity > 1000',
      onViolation: 'warn',
    };
    const [tool] =
        actionTools({model: guardedBy(advisory, 'AmountIsLarge'), client: NO_CLIENT});
    expect(tool.runnable).toBe(true);
    expect(tool.unavailable).toBeUndefined();
  });

  test('a guard naming nothing the model declares still withholds it', () => {
    // The runtime refuses this: a name it cannot resolve is not something to
    // guess about. A tool that called it anyway would fail every time.
    const other: Constraint = {name: 'SomethingElse', expression: 'x > 0'};
    const [tool] =
        actionTools({model: guardedBy(other, 'NoSuchRule'), client: NO_CLIENT});
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('NoSuchRule');
  });
});


// A refusal the model alone decides is a refusal every call would meet. Asking
// it once, before the tool is offered, is the difference between an agent that
// never sees a dead tool and one that spends a turn -- and a transaction --
// finding out. These are the answers that were previously reached only where
// the runtime binds, which is inside the transaction.
describe('a binding this runtime cannot fill is refused before the store', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  test('an object reference to a composite-keyed entity', () => {
    // `customer` is the type of PlaceOrder's entity-typed parameter. Give it a
    // two-part key and no single statement parameter can carry the reference,
    // so binding refuses -- whatever row the caller named.
    const composite = {
      ...model,
      entities: model.entities.map(
          e => e.name === 'customer' ?
              {...e, keys: ['c_custkey', 'c_nationkey']} :
              e),
    };
    const [tool] = actionTools(
        {model: withExecutor(composite, RUNNABLE), client: NO_CLIENT});
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('2 parts');
  });

  test('a generated key the statement binds, for an integer-keyed entity', () => {
    // `orders` is keyed by o_orderkey, an Integer, and the runtime generates a
    // UUID. The statement asks for one, so this can never be filled.
    const creates = withExecutor(model, {
      ...RUNNABLE,
      affects: [{concept: 'orders', operation: 'create'}],
      executor: {
        kind: 'sql',
        sql: {
          statements: ['INSERT INTO orders (o_orderkey) VALUES (@newordersKey)'],
        },
      },
    });
    const typed = {
      ...creates,
      entities: creates.entities.map(
          e => e.name === 'orders' ?
              {
                ...e,
                fields: e.fields.map(
                    f => f.name === 'o_orderkey' ? {...f, type: 'Integer' as const} : f),
              } :
              e),
    };
    const [tool] = actionTools({model: typed, client: NO_CLIENT});
    expect(tool.runnable).toBe(false);
    expect(tool.unavailable).toContain('UUID');
  });

  test('a generated key no statement binds is not held against the action',
       () => {
         // The same integer-keyed entity, but the DML supplies its own key.
         // Refusing over a value the action never reads would withhold a tool
         // that works.
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
         const [tool] = actionTools({model: creates, client: NO_CLIENT});
         expect(tool.runnable).toBe(true);
       });

  test('a handler is not held to either, because it writes its own DML', () => {
    // A handler is given `refs` whole and may spell a composite key across as
    // many parameters as it likes. Neither question is the handler's to answer.
    const composite = {
      ...model,
      entities: model.entities.map(
          e => e.name === 'customer' ?
              {...e, keys: ['c_custkey', 'c_nationkey']} :
              e),
    };
    const [tool] = actionTools({
      model: withExecutor(composite, {guards: []}),
      client: NO_CLIENT,
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
      expression: 'quantity > 1000',
      onViolation: 'warn',
    };
    const base = withExecutor(model, {...RUNNABLE, guards: ['AmountIsLarge']});
    const [tool] = actionTools(
        {model: {...base, constraints: [advisory]}, client: NO_CLIENT});
    expect(tool.runnable).toBe(true);
    expect(tool.description).not.toContain('gated by');
  });

  test('a guard that does stop the call is', () => {
    const blocking: Constraint = {
      name: 'QuantityIsSane',
      expression: 'quantity > 0',
      onViolation: 'reject',
    };
    const base = withExecutor(model, {...RUNNABLE, guards: ['QuantityIsSane']});
    const [tool] = actionTools(
        {model: {...base, constraints: [blocking]}, client: NO_CLIENT});
    expect(tool.description).toContain('gated by QuantityIsSane');
  });
});


// The read side owes the same answer the write side owes, for the same reason.
describe('a lookup that could not return a row says so up front', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  function lookupFor(entities: Entity[], name: string) {
    return entityTools({model: {...model, entities}, client: NO_CLIENT})
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
      model: withExecutor(model, RUNNABLE),
      client: store.client,
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
           model: withExecutor(model, {guards: []}),
           client: store.client,
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
  const tools = entityTools({model, client: NO_CLIENT});

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
  const [lineItem] = entityTools({model, client: NO_CLIENT});

  test("the field's own description leads", () => {
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
    const [tool] = entityTools({model: typedOrders(), client: store.client});
    await tool.invoke({o_orderkey: '12345'});

    const [stmt] = store.statements;
    expect(stmt.sql).toContain('WHERE o_orderkey = @f_0');
    expect(stmt.sql).not.toContain('CAST(o_orderkey AS STRING) =');
    expect(stmt.paramTypes!['f_0']).toEqual({code: 'INT64'});
  });

  test('a value the field\'s type has no room for is reported, not matched',
       async () => {
         const store = new FakeStore();
         const [tool] = entityTools({model: typedOrders(), client: store.client});
         const rows = await tool.invoke({o_orderkey: 'not-a-number'});
         expect(rows.problem).toContain('Integer');
         expect(rows.problem).toContain('No orders has o_orderkey');
         // Nothing was asked of the store: there is no row it could mean.
         expect(store.statements).toHaveLength(0);
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
    const [tool] = entityTools({model: bound(), client: store.client});
    const rows = await tool.invoke({});
    expect(rows.problem).toContain('Could not read orders');
    expect(rows.problem).toContain('spanner.databases.select');
    expect(rows.rows).toEqual([]);
  });

  test('a session that cannot be opened is reported too', async () => {
    const store = new FakeStore();
    store.sessionThrows = true;
    const [tool] = entityTools({model: bound(), client: store.client});
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
    const {lookups, actions} = modelTools({model: clashing, client: NO_CLIENT});
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
    const {actions} = modelTools({model: twins, client: NO_CLIENT});
    expect(actions.map(t => t.name)).toEqual(['issue_credit', 'issue_credit_2']);
  });

  test('nothing is renamed when nothing collides', () => {
    const {lookups, actions} = modelTools({model, client: NO_CLIENT});
    expect(actions.map(t => t.name)).toEqual(['place_order']);
    expect(lookups.map(t => t.name)).toEqual(['find_orders', 'find_customer']);
  });
});


describe('sorting the tools an adapter can actually offer', () => {
  const model = loadFixtureModel('actions_place_order.yaml');
  const runnable = withExecutor(model, RUNNABLE);

  test('everything runnable is offered, lookups before actions', () => {
    const {callable, withheld} =
        callableTools(modelTools({model: runnable, client: NO_CLIENT}));
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
        expression: 'quantity < 25',
        onViolation: 'escalate',
      }] as Constraint[],
    };
    const {callable, withheld} =
        callableTools(modelTools({model: guarded, client: NO_CLIENT}));
    expect(callable.map(t => t.name)).toEqual(['find_orders', 'find_customer']);
    expect(withheld.map(t => t.name)).toEqual(['place_order']);
    expect(withheld[0].unavailable).toContain('UnderReview');
  });

  test('the instruction is carried through untouched', () => {
    const tools = modelTools({model: runnable, client: NO_CLIENT});
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
    const {instruction} = modelTools({model: stated, client: NO_CLIENT});
    expect(instruction.startsWith('You work a returns desk for this business.'))
        .toBe(true);
  });

  test('how to use the tools is supplied whether or not the model speaks',
       () => {
         // The half that describes the tools is the derivation's to state: it
         // is a contract this module defines, and a model that says nothing
         // has not thereby withdrawn it.
         const {instruction} = modelTools({model, client: NO_CLIENT});
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
    const {instruction} = modelTools({model: stated, client: NO_CLIENT});
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

  test('a refusal is a failure the caller can read and act on', () => {
    const result =
        describeOutcome({status: 'error', message: "No Order matches 'xyz'."});
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
