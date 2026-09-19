// Running an action against a store.
//
// The store is faked here rather than mocked at the HTTP layer: the fake
// records the statements it is given, answers queries from a programmable
// table, and tracks whether the transaction ended in a commit or a rollback.
// That is exactly the surface the runtime's guarantees are stated in -- "a
// failed statement rolls back", "a refused action never opens a transaction"
// -- so the assertions can be about those guarantees rather than about wire
// format.
//

import {describe, expect, test} from 'bun:test';

import * as spanner from '../../../../src/libts/gcp/spanner';
import {Action, Constraint, Field, SemanticModel} from '../../../../src/libts/semantic/ir';
import {Judge, JudgeRequest, JudgeVerdict} from '../../../../src/libts/semantic/runtime/judge';
import {ActionPlan, runAction, RunActionOptions, whyRefusedWithoutRunning} from '../../../../src/libts/semantic/runtime/run_action';
import {SemanticRuntime} from '../../../../src/libts/semantic/runtime/runtime';


// `runAction` takes a runtime: a model paired with the store it runs against.
// What these tests vary is those two independently -- this model against that
// fake store -- so they go on naming them separately and are paired here.
// Whether the pairing itself is right is `store.test.ts`'s question.
type ActArgs = Omit<RunActionOptions, 'runtime'>&
    {model: SemanticModel; client: spanner.SpannerDataClient};

function rt(model: SemanticModel, client: spanner.SpannerDataClient):
    SemanticRuntime {
  return {
    model,
    document: 'test',
    store: {
      kind: 'spanner',
      name: 'projects/p/instances/i/databases/d',
      project: 'p',
      instance: 'i',
      database: 'd',
      client,
    },
    profile: 'default',
    entryGroup: 'eg',
  };
}

function act(o: ActArgs) {
  const {model, client, ...rest} = o;
  return runAction({runtime: rt(model, client), ...rest});
}


// A query the fake knows how to answer: rows returned when `match` is found in
// the statement's SQL.
interface Answer {
  match: string;
  rows: string[][];
}


class FakeSpanner {
  readonly database = 'projects/p/instances/i/databases/d';
  readonly statements: spanner.Statement[] = [];
  committed = false;
  rolledBack = false;
  sessionsOpen = 0;
  sessionsOpened = 0;
  beginFails = false;
  commitFails = false;
  // A commit that REJECTS rather than returning a status, and a session that
  // cannot be created: the two failures that reach the runtime as a thrown
  // error rather than as a response, which is what makes them interesting.
  commitThrows = false;
  sessionFails = false;
  // A commit the store REFUSES, by status. Spanner's routine one is 409
  // ABORTED under lock contention, which guarantees nothing was applied.
  commitRefused = 0;
  // Statements whose SQL contains one of these fragments fail, so a store-level
  // error can be provoked at a chosen point.
  failOn: string[] = [];
  // Statements whose SQL contains one of these never get an answer at all:
  // the request itself throws, the way a dropped socket or a DNS failure
  // reaches the runtime. A refusal and a silence are different news.
  throwOn: string[] = [];

  constructor(private readonly answers: Answer[] = []) {}

  async withSession<T>(fn: (s: string) => Promise<T>): Promise<T> {
    if (this.sessionFails) {
      throw new Error('Spanner: could not create a session on d (503).');
    }
    this.sessionsOpen++;
    this.sessionsOpened++;
    try {
      return await fn('sessions/1');
    } finally {
      this.sessionsOpen--;
    }
  }

  async beginReadWrite() {
    return this.beginFails ? {status: 400, message: 'nope'} :
                             {status: 200, result: {id: 'txn-1'}};
  }

  async executeSql(_s: string, _t: string, stmt: spanner.Statement) {
    this.statements.push(stmt);
    if (this.throwOn.some(f => stmt.sql.includes(f))) {
      throw new TypeError('fetch failed');
    }
    if (this.failOn.some(f => stmt.sql.includes(f))) {
      return {status: 400, message: 'statement rejected'};
    }
    const answer = this.answers.find(a => stmt.sql.includes(a.match));
    return {status: 200, result: {rows: answer?.rows ?? []}};
  }

  async commit() {
    // What a socket hang-up, a DNS failure or an abort looks like from here.
    if (this.commitThrows) throw new TypeError('fetch failed');
    if (this.commitRefused) {
      return {status: this.commitRefused, message: 'Transaction was aborted'};
    }
    if (this.commitFails) return {status: 500, message: 'commit failed'};
    this.committed = true;
    return {status: 200, result: {commitTimestamp: '2026-09-06T00:00:00Z'}};
  }

  async rollback() {
    this.rolledBack = true;
    return {status: 200, result: {}};
  }

  get client(): spanner.SpannerDataClient {
    return this as unknown as spanner.SpannerDataClient;
  }

  // The SQL of every statement run, for asserting what did and did not happen.
  get sql(): string[] {
    return this.statements.map(s => s.sql);
  }
}


const transfer: Action = {
  name: 'Transfer',
  description: 'Move funds between two accounts.',
  executor: {
    kind: 'mcp',
    mcp: {server: '//example/servers/payments', tool: 'transfer'},
  },
  parameters: [
    {name: 'source', type: 'Account', isEntityRef: true},
    {name: 'target', type: 'Account', isEntityRef: true},
    {name: 'amount', type: 'Float', isEntityRef: false},
  ],
};

// The base model states no constraint, so every action in it is safe to run
// unchecked and the tests below are about the write itself. The refusal rules
// get their own model further down.
function model(overrides: Partial<SemanticModel> = {}): SemanticModel {
  return {
    name: 'payments',
    entities: [
      {
        name: 'Account',
        dataSource: 'demo.payments.Account',
        keys: ['accountId'],
        fields: [
          {name: 'accountId', expression: 'account_id'},
          {name: 'balance', expression: 'balance'},
          {name: 'name', expression: 'name', type: 'String'},
        ],
      },
    ],
    relationships: [],
    metrics: [],
    actions: [transfer],
    ...overrides,
  };
}


const debitAndCredit = async (): Promise<ActionPlan> => ({
  statements: [{
    sql: 'UPDATE Account SET balance = balance - 100 WHERE account_id = 1',
  }],
});

// Answers that resolve 'A1' and 'A2' to account 1.
function resolvingFake(extra: Answer[] = []) {
  return new FakeSpanner([
    {
      match: 'FROM Account WHERE account_id = @ref0',
      rows: [['1']],
    },
    ...extra,
  ]);
}

// The payments model with Account's key field declared as `type`. Only the
// declared type of a key decides whether the SELECT that reads it back is cast,
// so that is the one thing these vary.
function keyedBy(type: Field['type']): SemanticModel {
  const base = model();
  return {
    ...base,
    entities: [{
      ...base.entities![0],
      fields: base.entities![0].fields.map(
          f => f.name === 'accountId' ? {...f, type} : f),
    }],
  };
}


function run(
    fake: FakeSpanner, over: Partial<ActArgs> = {}) {
  return act({
    model: model(),
    actionName: 'Transfer',
    args: {source: 'A1', target: 'A2', amount: 100},
    client: fake.client,
    handler: debitAndCredit,
    ...over,
  });
}


describe('resolving an entity-typed argument', () => {
  test('matches on the key', async () => {
    const fake = resolvingFake();
    const outcome = await run(fake);
    if (outcome.status !== 'committed') throw new Error(outcome.message);
    expect(outcome.refs.source).toEqual({
      entity: 'Account',
      keys: ['1'],
      input: 'A1',
    });
  });

  test('also matches on an identifying name column', async () => {
    // An agent saying "Alice" should reach the same row as one saying "7".
    const fake = resolvingFake();
    await run(fake);
    const lookup = fake.statements[0];
    expect(lookup.sql).toContain('account_id = @ref0');
    expect(lookup.sql).toContain('name = @ref');
  });

  test(
      'compares each column as itself, so an index can answer the lookup',
       async () => {
         // This SELECT runs inside the action's read-write transaction. Casting
         // the columns to STRING would make one predicate shape fit every key
         // type, at the price of a scan holding read locks over the whole table
         // for the length of the write.
         const fake = resolvingFake();
         await run(fake);
         const where = fake.statements[0].sql.split(' WHERE ')[1];
         expect(where).toBeDefined();
         expect(where).not.toContain('CAST');
       });

  test(
      'reads a date key back as text, which the predicate is not', async () => {
        // The other half of the same decision. A key value read here is carried
        // in an EntityRef and re-bound as a parameter later, so it has to come
        // back in the form the runtime parses from -- which on PostgreSQL a
        // DATE does not: it arrives as a full ISO instant rather than a plain
        // day. Casting the OUTPUT costs no index, so this side is cast and the
        // WHERE above is not.
    const fake = new FakeSpanner([{match: 'FROM Account', rows: [['1']]}]);
    await run(fake, {model: keyedBy('Date')});
    const select = fake.statements[0].sql.split(' FROM ')[0];
    expect(select).toContain('CAST(account_id AS STRING)');
  });

  test(
      'leaves a timestamp key alone, which the cast would corrupt',
      async () => {
        // Only a date needs it. Both backends already hand a timestamp back in
        // RFC 3339, which is the form the runtime re-binds from; the SQL
        // rendering a cast would produce instead -- '2026-09-07 00:00:00+00', a
        // two-digit offset -- is not. Casting every key type would fix the date
        // and break this.
    const fake = new FakeSpanner([{match: 'FROM Account', rows: [['1']]}]);
    await run(fake, {model: keyedBy('DateTime')});
    const select = fake.statements[0].sql.split(' FROM ')[0];
    expect(select).not.toContain('CAST');
    expect(select).toContain('account_id');
  });

  test('leaves an untyped key alone', async () => {
    const fake = resolvingFake();
    await run(fake);
    const select = fake.statements[0].sql.split(' FROM ')[0];
    expect(select).not.toContain('CAST');
  });

  test('drops a key predicate the input cannot possibly match', async () => {
    // 'A1' is not an Integer, so no INT64 key equals it. Comparing anyway
    // would mean casting the column, which is the scan this avoids.
    const fake = new FakeSpanner([{match: 'FROM Account', rows: [['1']]}]);
    await run(fake, {
      model: model({
        entities: [{
          name: 'Account',
          dataSource: 'demo.payments.Account',
          keys: ['accountId'],
          fields: [
            {name: 'accountId', expression: 'account_id', type: 'Integer'},
            {name: 'name', expression: 'name', type: 'String'},
          ],
        }],
      }),
    });
    // The key column is still SELECTed -- it is what a match returns -- but
    // nothing compares it.
    expect(fake.statements[0].sql).toContain('WHERE name = @ref LIMIT');
    expect(fake.statements[0].sql).not.toContain('account_id =');
  });

  test('does not query at all when nothing could match the input', async () => {
    // An Integer key, no identifying text field, and a reference that is not a
    // number: there is no row this could denote, and no predicate left to ask.
    const fake = new FakeSpanner([]);
    const outcome = await run(fake, {
      model: model({
        entities: [{
          name: 'Account',
          dataSource: 'demo.payments.Account',
          keys: ['accountId'],
          fields: [
            {name: 'accountId', expression: 'account_id', type: 'Integer'},
          ],
        }],
      }),
    });
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toBe('No Account matches \'A1\'.');
    expect(fake.statements).toHaveLength(0);
  });

  test('rejects a reference that matches nothing', async () => {
    const fake = new FakeSpanner([]);
    const outcome = await run(fake);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toBe('No Account matches \'A1\'.');
    expect(fake.rolledBack).toBe(true);
  });

  test('rejects an ambiguous reference and lists the candidates', async () => {
    const fake =
        new FakeSpanner([{match: 'FROM Account WHERE', rows: [['1'], ['2']]}]);
    const outcome = await run(fake);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('matches more than one Account (1, 2)');
  });

  test('rejects a missing required reference', async () => {
    // The message alone does not pin this. `resolveArguments` says the same
    // sentence from inside the transaction, so the assertion below holds with
    // the pre-flight deleted. What the pre-flight buys is saying it before a
    // session is opened.
    const fake = resolvingFake();
    const outcome = await run(fake, {args: {target: 'A2', amount: 100}});
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message)
        .toContain('requires \'source\', a reference to a Account');
    expect(fake.sessionsOpened).toBe(0);
  });

  test('leaves scalar arguments alone', async () => {
    const outcome = await run(resolvingFake());
    if (outcome.status !== 'committed') throw new Error(outcome.message);
    expect(Object.keys(outcome.refs)).toEqual(['source', 'target']);
  });
});


describe('failures that stop the write', () => {
  test('an unknown action is refused before any store call', async () => {
    const fake = resolvingFake();
    const outcome = await run(fake, {actionName: 'Refund'});
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('declares no action \'Refund\'');
    expect(fake.statements).toHaveLength(0);
  });

  test('a transaction that will not begin is reported, not retried',
       async () => {
         const fake = resolvingFake();
         fake.beginFails = true;
         const outcome = await run(fake);
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message).toContain('Could not begin a transaction');
       });

  test('a rejected statement rolls the transaction back', async () => {
    const fake = resolvingFake();
    fake.failOn = ['UPDATE Account'];
    const outcome = await run(fake);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('statement rejected');
    expect(outcome.message).toContain('failed and was rolled back');
    expect(fake.rolledBack).toBe(true);
    expect(fake.committed).toBe(false);
  });

  test('a store that stops answering is the store failing, not this code',
       async () => {
         // A statement the store REFUSES comes back as a status; a dropped
         // socket, a DNS failure or a TLS error throws instead. Both are the
         // store, and reporting the second as a fault inside the runtime
         // sends the reader to look for a bug where there is only a network
         // worth retrying.
         const fake = resolvingFake();
         fake.throwOn = ['UPDATE Account'];
         const outcome = await run(fake);
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message).toContain('fetch failed');
         expect(outcome.message).toContain('failed and was rolled back');
         expect(outcome.message).not.toContain('inside the runtime');
         expect(fake.rolledBack).toBe(true);
         expect(fake.committed).toBe(false);
       });

  test('a handler that throws rolls the transaction back', async () => {
    const fake = resolvingFake();
    const outcome = await run(fake, {
      handler: async () => {
        throw new Error('handler blew up');
      },
    });
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('handler blew up');
    expect(fake.rolledBack).toBe(true);
  });

  test('a bug in a handler is not reported as a rejected write', async () => {
    // A statement the store refused and a TypeError out of the caller's own
    // code both land in the same catch. Reporting the second as a rejected
    // write sends the reader to the data to look for a problem in the code.
    const fake = resolvingFake();
    const outcome = await run(fake, {
      handler: async () => {
        throw new TypeError('x.map is not a function');
      },
    });
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('not on the store\'s account');
    expect(fake.rolledBack).toBe(true);
  });

  test('a commit that fails is reported as a commit failure', async () => {
    const fake = resolvingFake();
    fake.commitFails = true;
    const outcome = await run(fake);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('committing it failed');
    expect(fake.committed).toBe(false);
  });

  test(
      'a commit that fails is reported as an UNKNOWN outcome, not a rollback',
       async () => {
         // The one failure this runtime cannot call: Spanner returns a deadline
         // or a 5xx on commit for a commit that landed as readily as for one
         // that did not, and nothing can undo it from here. Saying "rolled
         // back" would be a guess, and a caller acting on it would apply the
         // write twice.
         const fake = resolvingFake();
         fake.commitFails = true;
         const outcome = await run(fake);
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.indeterminate).toBe(true);
        expect(outcome.message)
            .toContain('Whether the write landed is unknown');
         expect(fake.rolledBack).toBe(false);
       });

  test(
      'a rollback that fails does not replace the reason the action stopped',
       async () => {
         // The reason is what the caller acts on. An abandoned transaction is
         // aborted by the server on its own.
         const fake = new FakeSpanner([]);
         fake.rollback = async () => {
           throw new Error('rollback unreachable');
         };
         const outcome = await run(fake);
         if (outcome.status !== 'error') throw new Error('expected an error');
        expect(outcome.message).toBe('No Account matches \'A1\'.');
       });

  test(
      'a rollback that fails after a thrown statement keeps the store error',
       async () => {
         const fake = resolvingFake();
         fake.failOn = ['UPDATE Account'];
         fake.rollback = async () => {
           throw new Error('rollback unreachable');
         };
         const outcome = await run(fake);
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message).toContain('statement rejected');
       });

  test('the session is closed even when the action fails', async () => {
    const fake = resolvingFake();
    fake.failOn = ['UPDATE Account'];
    await run(fake);
    expect(fake.sessionsOpen).toBe(0);
  });

  test('the session is closed on the happy path too', async () => {
    const fake = resolvingFake();
    await run(fake);
    expect(fake.sessionsOpen).toBe(0);
    expect(fake.sessionsOpened).toBe(1);
  });
});


describe('an executor the runtime cannot roll back', () => {
  test('is refused when the caller supplies no handler', async () => {
    // An MCP tool commits inside a system this transaction does not control,
    // so a rollback here would leave the two out of step.
    const fake = resolvingFake();
    const outcome = await run(fake, {handler: undefined});
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('could not be rolled back');
    expect(fake.statements).toHaveLength(0);
  });
});


// An executor is a physical binding, so an action can reach the runtime with
// none at all -- a profile that never mentioned it, or one that withdrew it
// with `executor: null`. That is a legitimate state, not a malformed model,
// and it is the binding that has to change to fix it.
describe('an action with no executor under this binding', () => {
  const unbound: Action = {
    name: 'Transfer',
    parameters: [
      {name: 'source', type: 'Account', isEntityRef: true},
      {name: 'target', type: 'Account', isEntityRef: true},
      {name: 'amount', type: 'Float', isEntityRef: false},
    ],
  };

  test('is refused without touching the store', async () => {
    const fake = resolvingFake();
    const outcome = await run(
        fake, {model: model({actions: [unbound]}), handler: undefined});
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('no executor under this binding');
    expect(fake.statements).toHaveLength(0);
  });

  test('points at the profile rather than at the action', async () => {
    // The action itself is fine. Saying "declare a sql executor" would send
    // the author to change a logical declaration that was never the problem.
    const fake = resolvingFake();
    const outcome = await run(
        fake, {model: model({actions: [unbound]}), handler: undefined});
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('profile');
    expect(outcome.message).toContain('still declared');
  });

  test('is refused even when a handler is supplied', async () => {
    // A handler substitutes for a remote executor's write. It does not
    // substitute for the binding deciding this action runs here at all.
    const fake = resolvingFake();
    const outcome = await run(fake, {model: model({actions: [unbound]})});
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('no executor under this binding');
    expect(fake.statements).toHaveLength(0);
  });
});


// A second model, for the half of the runtime the payments model cannot reach:
// an action whose write is declared in the model rather than performed by a
// handler.
const credit: Action = {
  name: 'Credit',
  description: 'Credit an account and record the entry.',
  executor: {
    kind: 'sql',
    sql: {
      statements: [
        'INSERT INTO Entry (entry_id, account_id, amount) ' +
            'VALUES (GENERATE_UUID(), @account, @amount)',
        'UPDATE Account SET balance = balance - @amount ' +
            'WHERE account_id = @account',
      ],
    },
  },
  parameters: [
    {name: 'account', type: 'Account', isEntityRef: true},
    {name: 'amount', type: 'Float', isEntityRef: false},
  ],
  affects: [
    {concept: 'Entry', operation: 'create', fields: ['amount']},
    {concept: 'Account', operation: 'modify', fields: ['balance']},
  ],
};

function creditModel(overrides: Partial<SemanticModel> = {}): SemanticModel {
  const base = model();
  return {
    ...base,
    entities: [
      ...base.entities,
      {
        name: 'Entry',
        dataSource: 'demo.payments.Entry',
        keys: ['entryId'],
        fields: [
          {name: 'entryId', expression: 'entry_id'},
          {name: 'amount', expression: 'amount'},
        ],
      },
    ],
    actions: [credit],
    ...overrides,
  };
}

function runCredit(
    fake: FakeSpanner, over: Partial<ActArgs> = {}) {
  return act({
    model: creditModel(),
    actionName: 'Credit',
    args: {account: 'A1', amount: 100},
    client: fake.client,
    ...over,
  });
}


describe('an action whose write is declared in the model', () => {
  test('runs the executor statements in order, with no handler involved',
       async () => {
         const fake = resolvingFake();
         const outcome = await runCredit(fake);
         if (outcome.status !== 'committed') throw new Error(outcome.message);
         expect(fake.sql.filter(s => s.startsWith('INSERT'))).toHaveLength(1);
         expect(fake.sql.filter(s => s.startsWith('UPDATE'))).toHaveLength(1);
         expect(fake.sql.indexOf('INSERT INTO Entry (entry_id, account_id, ' +
                                 'amount) VALUES (GENERATE_UUID(), @account, ' +
                                 '@amount)'))
             .toBeLessThan(fake.sql.findIndex(s => s.startsWith('UPDATE')));
       });

  test('binds every caller value as a parameter, interpolating nothing',
       async () => {
         const fake = resolvingFake();
         await runCredit(fake);
         const insert = fake.statements.find(s => s.sql.startsWith('INSERT'))!;
         expect(insert.sql).not.toContain('100');
         expect(insert.params?.amount).toBe(100);
         expect(insert.paramTypes?.amount).toEqual({code: 'FLOAT64'});
       });

  test('binds only the parameters a given statement mentions', async () => {
    // The UPDATE names both; a statement naming one would carry one.
    const fake = resolvingFake();
    await runCredit(fake);
    const update = fake.statements.find(s => s.sql.startsWith('UPDATE'))!;
    expect(Object.keys(update.params ?? {}).sort()).toEqual([
      'account',
      'amount',
    ]);
  });

  test('resolves an entity-typed argument to its key before binding it',
       async () => {
         const fake = resolvingFake();
         await runCredit(fake);
         const update = fake.statements.find(s => s.sql.startsWith('UPDATE'))!;
         expect(update.params?.account).toBe('1');
       });

  test('commits once every statement has run', async () => {
    const fake = resolvingFake();
    await runCredit(fake);
    expect(fake.committed).toBe(true);
    expect(fake.rolledBack).toBe(false);
  });
});


// A guard is settled by a judge, so a run that was handed no judge cannot
// settle one -- and an action that says it is checked before it runs must not
// run unchecked. `guards` is what says that, and it is the only thing that
// does: a constraint takes effect where something references it.
describe('a guarded action is refused, not run unchecked', () => {
  const balance: Constraint = {
    name: 'NonNegativeBalance',
    judgment: 'The resulting Account.balance must not be negative.',
    onViolation: 'reject',
    description: 'An account cannot go negative.',
  };

  const runWith = (over: Partial<SemanticModel>, fake = resolvingFake()) =>
      act({
        model: creditModel(over),
        actionName: 'Credit',
        args: {account: 'A1', amount: 100},
        client: fake.client,
      });

  test('an action that names a guard is refused', async () => {
    const outcome = await runWith({
      actions: [{...credit, guards: ['NonNegativeBalance']}],
      constraints: [balance],
    });
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('guarded by \'NonNegativeBalance\'');
    expect(outcome.message).toContain('was given no judge to ask');
  });

  test('a refused action never opens a transaction', async () => {
    // The point of deciding before the store is touched: there is nothing to
    // roll back, and no session to leak.
    const fake = resolvingFake();
    await runWith(
        {
          actions: [{...credit, guards: ['NonNegativeBalance']}],
          constraints: [balance],
        },
        fake);
    expect(fake.statements).toHaveLength(0);
    expect(fake.sessionsOpened).toBe(0);
    expect(fake.rolledBack).toBe(false);
  });

  test(
      'an action writing data a constraint reads runs, if it names no guard',
       async () => {
         // Credit affects Account and NonNegativeBalance reads Account.balance.
         // That overlap is not what gives the rule effect over this call, and
         // refusing on it would mean publishing a rule silently stopped calls
         // that worked the day before -- the thing a constraint's reference
         // rule exists to prevent.
         const outcome = await runWith({constraints: [balance]});
         if (outcome.status !== 'committed') throw new Error(outcome.message);
       });

  test(
      'an action that declares no affects runs, constraints or not',
       async () => {
         // `affects` describes the blast radius; it is not a switch that turns
         // checking on, and its absence is not a reason to refuse. The same
         // DML runs either way, down to the row it inserts.
         const outcome = await runWith({
           actions: [{...credit, affects: undefined}],
           constraints: [balance],
         });
         if (outcome.status !== 'committed') throw new Error(outcome.message);
       });

  test(
      'a guard is refused even when the model states no such constraint',
       async () => {
         // An unresolved guard fails the push, so this model should not exist.
         // If one reaches the runtime anyway, the action still claims to be
         // checked, and running it would still be running it unchecked.
         const outcome = await runWith({
           actions: [{...credit, guards: ['NoSuchRule']}],
           constraints: [],
         });
         if (outcome.status !== 'error') throw new Error('expected an error');
        expect(outcome.message).toContain('guarded by \'NoSuchRule\'');
       });

  test('several guards are all named', async () => {
    const outcome = await runWith({
      actions: [{...credit, guards: ['ZBalance', 'AEntry']}],
      constraints: [
        {
          name: 'ZBalance',
          judgment: 'The resulting Account.balance must not be negative.',
          onViolation: 'reject',
        },
        {
          name: 'AEntry',
          judgment: 'The resulting Entry.amount must be positive.',
          onViolation: 'reject',
        },
      ],
    });
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('\'ZBalance\' and \'AEntry\'');
  });
});


describe('a guard settled by judgment', () => {
  class ScriptedJudge implements Judge {
    readonly name = 'scripted';
    readonly asked: JudgeRequest[] = [];

    constructor(private readonly answer: JudgeVerdict|Error) {}

    async decide(request: JudgeRequest): Promise<JudgeVerdict> {
      this.asked.push(request);
      if (this.answer instanceof Error) throw this.answer;
      return this.answer;
    }
  }

  const holds = () => new ScriptedJudge({holds: true, reason: 'It names one.'});
  const doesNot = () => new ScriptedJudge(
      {holds: false, reason: 'The memo names no service failure.'});
  const unreachable = () =>
      new ScriptedJudge(new Error('Vertex AI returned 503'));

  const justified: Constraint = {
    name: 'CreditIsJustified',
    judgment: 'The memo must name a specific service failure.',
    description: 'A credit needs a stated reason.',
    onViolation: 'reject',
  };
  const advisory: Constraint = {...justified, onViolation: 'warn'};
  const approvable: Constraint = {...justified, onViolation: 'escalate'};

  const guarding = (constraints: Constraint[]) => creditModel({
    actions: [{...credit, guards: constraints.map(c => c.name)}],
    constraints,
  });

  const runWith =
      (constraints: Constraint[], judge?: Judge, fake = resolvingFake()) =>
          act({
            model: guarding(constraints),
            actionName: 'Credit',
            args: {account: 'A1', amount: 100},
            client: fake.client,
            judge,
          });

  test('a verdict that holds lets the write through', async () => {
    const judge = holds();
    const fake = resolvingFake();
    const outcome = await runWith([justified], judge, fake);
    if (outcome.status !== 'committed') throw new Error(outcome.message);
    // Asked, rather than assumed to hold. A judge that was never called and a
    // judge that said yes produce the same outcome, and only one of the two is
    // the runtime working.
    expect(judge.asked).toHaveLength(1);
    expect(fake.committed).toBe(true);
    expect(outcome.warnings).toBeUndefined();
  });

  test('the judge is given the rule as the author wrote it', async () => {
    const judge = holds();
    await runWith([justified], judge);
    expect(judge.asked[0].rule)
        .toBe('The memo must name a specific service failure.');
    expect(judge.asked[0].constraint).toBe('CreditIsJustified');
    expect(judge.asked[0].action).toBe('Credit');
    expect(judge.asked[0].actionDescription)
        .toBe('Credit an account and record the entry.');
  });

  test(
      'the judge is given the arguments as the caller stated them',
       async () => {
         // Before resolution, which is the point of asking here: 'A1' is what
         // the caller said, and the key it resolves to would tell a judge
         // nothing.
         const judge = holds();
         await runWith([justified], judge);
         expect(judge.asked[0].arguments).toEqual({account: 'A1', amount: 100});
       });

  test(
      'a verdict that does not hold refuses before anything opens',
       async () => {
         // Why a judgment settles here at all: a refused call costs the store
         // no session, no transaction, and no write locks held across a call
         // that takes seconds.
         const fake = resolvingFake();
         const outcome = await runWith([justified], doesNot(), fake);
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(fake.sessionsOpened).toBe(0);
         expect(fake.statements).toHaveLength(0);
         expect(fake.committed).toBe(false);
         expect(fake.rolledBack).toBe(false);
       });

  test(
      'the refusal carries the author words and the judge reason', async () => {
         const outcome = await runWith([justified], doesNot());
         if (outcome.status !== 'error') throw new Error('expected an error');
        expect(outcome.message).toContain('\'CreditIsJustified\'');
         expect(outcome.message)
             .toContain('The memo must name a specific service failure.');
         expect(outcome.message).toContain('A credit needs a stated reason.');
        expect(outcome.message).toContain('The memo names no service failure.');
         // A caller told a transaction rolled back goes looking for a write
         // that never reached the store.
         expect(outcome.message).toContain('No transaction was opened');
         expect(outcome.message).not.toContain('rolled back');
       });

  test('an escalation says an approver may allow it', async () => {
    // `escalate` states that an approver exists. Nothing here is one, and a
    // refusal that did not say so would read as the end of the matter.
    const outcome = await runWith([approvable], doesNot());
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('escalate');
    expect(outcome.message).toContain('an approver may allow it');
  });

  test(
      'an advisory verdict that does not hold still commits, and is reported',
       async () => {
         const fake = resolvingFake();
         const outcome = await runWith([advisory], doesNot(), fake);
         if (outcome.status !== 'committed') throw new Error(outcome.message);
         expect(fake.committed).toBe(true);
         // A caller that never sees this has been told the write was clean
         // when the model said it was not.
         expect(outcome.warnings).toHaveLength(1);
         expect(outcome.warnings?.[0]).toContain('CreditIsJustified');
         expect(outcome.warnings?.[0])
             .toContain('The memo names no service failure.');
       });

  test(
      'a judge that cannot be reached stops a rule that stops things',
       async () => {
         // Nothing here knows whether the rule holds, and a rule whose word is
         // `reject` routes that the way it routes a breach.
         const fake = resolvingFake();
         const outcome = await runWith([justified], unreachable(), fake);
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message).toContain('Vertex AI returned 503');
         expect(fake.sessionsOpened).toBe(0);
         expect(fake.committed).toBe(false);
       });

  test(
      'a judge that cannot be reached does not stop an advisory rule',
       async () => {
         const fake = resolvingFake();
         const outcome = await runWith([advisory], unreachable(), fake);
         if (outcome.status !== 'committed') throw new Error(outcome.message);
         expect(fake.committed).toBe(true);
         // Reported rather than dropped: the model asked for a check it did
         // not get, which is the part a caller can act on.
         expect(outcome.warnings?.[0]).toContain('was not checked');
         expect(outcome.warnings?.[0]).toContain('Vertex AI returned 503');
       });

  test(
      'with no judge the action is refused, and the refusal says why',
       async () => {
         const fake = resolvingFake();
         const outcome = await runWith([justified], undefined, fake);
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message).toContain('no judge to ask');
         expect(fake.sessionsOpened).toBe(0);
       });

  test(
      'a call missing an argument is answered before a judge is asked',
       async () => {
         // A judge handed an incomplete call answers about the rule, so the
         // caller would be told the rule was broken rather than that an
         // argument was never supplied -- and a model call would be spent
         // saying it.
         const judge = holds();
         const fake = resolvingFake();
         const outcome = await act({
           model: guarding([justified]),
           actionName: 'Credit',
           args: {account: 'A1'},
           client: fake.client,
           judge,
         });
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(judge.asked).toHaveLength(0);
         expect(fake.sessionsOpened).toBe(0);
         expect(outcome.message).toContain('amount');
         expect(outcome.message).toContain('was not given a value');
       });

  test('a guard stating no rule at all is reported as unchecked', async () => {
    // A constraint may reach the runtime with no body at all through the
    // library entry point, which does not validate the model. An advisory one
    // never stops the call, so a caller shown no line for it reads the commit
         // as having met every rule the model states.
         const bodyless: Constraint = {name: 'NoRule', onViolation: 'warn'};
         const fake = resolvingFake();
         const outcome = await runWith([bodyless], holds(), fake);
         if (outcome.status !== 'committed') throw new Error(outcome.message);
         expect(fake.committed).toBe(true);
         expect(outcome.warnings?.[0]).toContain('NoRule');
    expect(outcome.warnings?.[0])
        .toContain('states no words to put to a judge');
       });

  test(
      'a judgment with no words refuses rather than asking about nothing',
       async () => {
         // An empty rule put to a judge comes back "not enough to tell", so
         // every call would be refused and the citation could not quote what
         // was broken.
         const judge = holds();
         const blank: Constraint = {...justified, judgment: '   '};
         const outcome = await runWith([blank], judge);
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(judge.asked).toHaveLength(0);
         expect(outcome.message).toContain('CreditIsJustified');
         expect(outcome.message)
             .toContain(
                `'CreditIsJustified', which states no rule to put to a judge.`);
       });

  test(
      'an advisory judgment with no words is reported, never asked',
       async () => {
         // An advisory guard is never refused, so this is the one path on
         // which an empty rule could still have reached a judge.
         const judge = holds();
         const blank: Constraint = {...advisory, judgment: ''};
         const outcome = await runWith([blank], judge);
         if (outcome.status !== 'committed') throw new Error(outcome.message);
         expect(judge.asked).toHaveLength(0);
         expect(outcome.warnings?.[0]).toContain('states no words');
       });

  test('a verdict missing its answer is reported, not thrown', async () => {
    // `Judge` is a seam a caller implements, so a verdict can arrive without
    // the fields its type promises. runAction states that it returns an
    // outcome for every expected failure, and a TypeError escaping it would
    // reach the CLI as a stack trace and an agent tool as a rejection.
    const malformed = new ScriptedJudge({} as unknown as JudgeVerdict);
    const outcome = await runWith([justified], malformed);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('did not say whether the rule holds');
    expect(outcome.message).toContain('nothing was written');
  });

  test(
      'a verdict that does not hold and states no reason still refuses',
       async () => {
         const terse = new ScriptedJudge(
             {holds: false, reason: undefined as unknown as string});
         const outcome = await runWith([justified], terse);
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message).toContain('does not hold for this call');
       });

  test(
      'an advisory guard nobody could ask about is reported, not dropped',
       async () => {
         // A warn rule does not stop the call, so the call runs with no judge.
         // Committing in silence would tell the caller every rule passed, when
         // one of them was never put to anybody.
         const fake = resolvingFake();
         const outcome = await runWith([advisory], undefined, fake);
         if (outcome.status !== 'committed') throw new Error(outcome.message);
         expect(fake.committed).toBe(true);
         expect(outcome.warnings?.[0]).toContain('CreditIsJustified');
         expect(outcome.warnings?.[0]).toContain('was not checked');
         expect(outcome.warnings?.[0]).toContain('no judge');
       });

  test(
      'a guard stating no rule is refused whatever judge is given',
       async () => {
        // Supplying a judge does not give a bodyless constraint something to
        // put to it, and a message about a missing judge would send a caller
        // who already supplied one the wrong way.
         const outcome = await runWith(
            [{name: 'UnderCeiling', onViolation: 'reject'}], holds());
         if (outcome.status !== 'error') throw new Error('expected an error');
        expect(outcome.message).toContain('states no rule to put to a judge');
        expect(outcome.message).not.toContain('was given no judge to ask');
       });

  test('what a run does and what a tool advertises agree', async () => {
    // agent_tools.ts asks this before offering the action. A tool advertised
    // as runnable and then refused mid-call spends the caller's turn and
    // teaches it nothing.
    const guarded = guarding([justified]);
    const action = guarded.actions![0];
    expect(whyRefusedWithoutRunning(guarded, action))
        .toContain('no judge to ask');
    expect(whyRefusedWithoutRunning(guarded, action, undefined, holds()))
        .toBeNull();
  });
});


describe('the pre-flight over an incomplete call', () => {
  test('leaves a scalar alone when a handler supplies the write', async () => {
    // A handler is handed the arguments whole and decides for itself which of
    // them it needs, so binding every declared scalar on its behalf would
    // refuse a call it can perform. Only the entity references are the
    // runtime's business here, because the runtime resolves those itself.
    const fake = resolvingFake();
    const outcome = await run(fake, {args: {source: 'A1', target: 'A2'}});
    if (outcome.status !== 'committed') throw new Error(outcome.message);
    expect(fake.committed).toBe(true);
  });

  test('still refuses a missing entity reference under a handler',
       async () => {
         // The runtime resolves references itself, whoever performs the write.
         const fake = resolvingFake();
         const outcome = await run(fake, {args: {source: 'A1', amount: 100}});
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message).toContain('target');
         expect(fake.sessionsOpened).toBe(0);
       });
});


describe('an action whose write comes from a handler', () => {
  test('is not held to a binding pass its plan never uses', async () => {
    // The bindings exist to fill the model's OWN statements. A handler is
    // handed the resolved refs whole, so a two-part key it can write perfectly
    // well must not be refused on the way in.
    //
    // The entity carries an identifying column because that is the only way a
    // composite-keyed row can be named by one value at all -- see the
    // resolution tests below.
    const fake = new FakeSpanner([{match: 'FROM Account', rows: [['eu', '1']]}]);
    const outcome = await run(fake, {
      model: model({
        entities: [{
          name: 'Account',
          dataSource: 'demo.payments.Account',
          keys: ['region', 'accountId'],
          fields: [
            {name: 'region', expression: 'region', type: 'String'},
            {name: 'accountId', expression: 'account_id', type: 'String'},
            {name: 'name', expression: 'name', type: 'String'},
          ],
        }],
      }),
    });
    if (outcome.status !== 'committed') throw new Error(outcome.message);
    expect(outcome.refs.source.keys).toEqual(['eu', '1']);
  });

  test('a composite key is still refused when the MODEL supplies the write',
       async () => {
         // Here the key has to become one statement parameter, and one value
         // cannot carry two columns.
         const fake =
             new FakeSpanner([{match: 'FROM Account', rows: [['eu', '1']]}]);
         const outcome = await runCredit(fake, {
           model: creditModel({
             entities: [
               {
                 name: 'Account',
                 dataSource: 'demo.payments.Account',
                 keys: ['region', 'accountId'],
                 fields: [
                   {name: 'region', expression: 'region', type: 'String'},
                   {name: 'accountId', expression: 'account_id', type: 'String'},
                   {name: 'name', expression: 'name', type: 'String'},
                 ],
               },
               {
                 name: 'Entry',
                 dataSource: 'demo.payments.Entry',
                 keys: ['entryId'],
                 fields: [{name: 'entryId', expression: 'entry_id'}],
               },
             ],
           }),
         });
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.message).toContain('a composite key cannot be passed');
       });
});


// A row the statement inserts needs a primary key, and the statement decides
// where that key comes from. The runtime writes none of its own, so the type
// the entity declares for its key never decides whether the action runs.
describe('the key of a row the action creates', () => {
  function creditWith(
      statements: string[], parameters = credit.parameters,
      keyType?: 'Integer'|'String') {
    return creditModel({
      actions: [
        {...credit, parameters, executor: {kind: 'sql', sql: {statements}}},
      ],
      entities: [
        ...model().entities,
        {
          name: 'Entry',
          dataSource: 'demo.payments.Entry',
          keys: ['entryId'],
          fields: [
            {name: 'entryId', expression: 'entry_id', type: keyType},
            {name: 'amount', expression: 'amount'},
          ],
        },
      ],
    });
  }

  test('is whatever SQL the statement writes, and binds nothing', async () => {
    const fake = resolvingFake();
    const outcome = await runCredit(fake, {
      model: creditWith([
        'INSERT INTO Entry (entry_id, amount) ' +
            'VALUES (GENERATE_UUID(), @amount)',
      ]),
    });
    if (outcome.status !== 'committed') throw new Error(outcome.message);
    const insert = fake.statements.find(s => s.sql.startsWith('INSERT'))!;
    expect(insert.sql).toContain('GENERATE_UUID()');
    expect(Object.keys(insert.params ?? {})).toEqual(['amount']);
  });

  test('can be an integer the store computes', async () => {
    // Entry declares an Integer key here, and the INSERT reads the next one.
    // A UUID would not fit that column, and nothing offers one.
    const fake = resolvingFake();
    const outcome = await runCredit(fake, {
      model: creditWith(
          [
            'INSERT INTO Entry (entry_id, amount) ' +
                'SELECT MAX(entry_id) + 1, @amount FROM Entry',
          ],
          credit.parameters, 'Integer'),
    });
    if (outcome.status !== 'committed') throw new Error(outcome.message);
  });

  test('can come from the caller, bound like any other value', async () => {
    // Nothing reserves a parameter name for a key, so an action that wants
    // the caller to choose one declares a parameter and binds it.
    const fake = resolvingFake();
    const outcome = await runCredit(fake, {
      model: creditWith(
          ['INSERT INTO Entry (entry_id, amount) VALUES (@entry, @amount)'],
          [
            ...credit.parameters,
            {name: 'entry', type: 'String', isEntityRef: false},
          ]),
      args: {account: 'A1', amount: 100, entry: 'E7'},
    });
    if (outcome.status !== 'committed') throw new Error(outcome.message);
    const insert = fake.statements.find(s => s.sql.startsWith('INSERT'))!;
    expect(insert.params?.entry).toBe('E7');
  });
});


// A commit is the one step whose failure cannot be undone from here, so what
// the runtime SAYS about it is the whole of what a caller has to go on.
describe('a commit whose outcome the runtime cannot know', () => {
  test('a commit that rejects is indeterminate, not a rollback', async () => {
    // The request throws rather than returning a status -- a socket hang-up, a
    // DNS failure, an abort. That is exactly the shape a commit deadline takes
    // from the client, and the case where the write is likeliest to have
    // landed anyway. Reporting a rollback would invite the retry that applies
    // it twice.
    const fake = resolvingFake();
    fake.commitThrows = true;
    const outcome = await runCredit(fake);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.indeterminate).toBe(true);
    expect(outcome.message).toContain('Whether the write landed is unknown');
    expect(outcome.message).not.toContain('rolled back');
    expect(fake.rolledBack).toBe(false);
  });
});


describe('a failure before any transaction exists', () => {
  test('is not reported as a rollback', async () => {
    // Nothing was opened, so nothing was rolled back. Saying otherwise tells
    // the caller a transaction was undone that never began.
    const fake = resolvingFake();
    fake.sessionFails = true;
    const outcome = await runCredit(fake);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('could not start');
    expect(outcome.message).not.toContain('rolled back');
  });
});


// `onViolation` says what a violation DOES. A rule that only reports one can
// never refuse a write, so it cannot be the reason a write is refused.
describe('a constraint that only warns', () => {
  const advisory: Constraint = {
    name: 'BalanceIsLow',
    judgment: 'Account.balance must not go negative.',
    description: 'Flag an account that has gone negative.',
    onViolation: 'warn',
  };

  test('does not gate the action that guards it', async () => {
    const outcome = await act({
      model: creditModel({
        actions: [{...credit, guards: ['BalanceIsLow']}],
        constraints: [advisory],
      }),
      actionName: 'Credit',
      args: {account: 'A1', amount: 100},
      client: resolvingFake().client,
    });
    if (outcome.status !== 'committed') throw new Error(outcome.message);
  });

  test(
      'but a guard naming nothing the model declares still refuses',
      async () => {
        // Validation makes that a hard error and `kcmd action run` now runs
        // validation -- but a library caller reaching runAction directly gets
        // no such pass, and a guard this cannot account for is not something
        // to wave through on the grounds that it was not found.
        const outcome = await act({
          model: creditModel({
            actions: [{...credit, guards: ['NoSuchRule']}],
            constraints: [advisory],
          }),
          actionName: 'Credit',
          args: {account: 'A1', amount: 100},
          client: resolvingFake().client,
        });
        if (outcome.status !== 'error') throw new Error('expected an error');
        expect(outcome.message).toContain('\'NoSuchRule\'');
      });
});


describe('a commit the store refuses outright', () => {
  test('is a rollback, not an unknown outcome', async () => {
    // `409 ABORTED` is what Spanner returns under lock contention, and it
    // guarantees the transaction applied nothing. Reporting it as
    // indeterminate -- "the write may have landed, read the data before
    // retrying" -- would turn the commonest routine failure there is into an
    // investigation, every time two writers meet.
    const fake = resolvingFake();
    fake.commitRefused = 409;
    const outcome = await runCredit(fake);
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.indeterminate).toBeUndefined();
    expect(outcome.message).toContain('nothing was written');
    expect(outcome.message).toContain('can be run again');
    expect(fake.committed).toBe(false);
  });

  test('but a 5xx is still unknown, because that one may have landed',
       async () => {
         // The distinction is the whole point: a definite refusal is definite,
         // and everything else is not.
         const fake = resolvingFake();
         fake.commitRefused = 503;
         const outcome = await runCredit(fake);
         if (outcome.status !== 'error') throw new Error('expected an error');
         expect(outcome.indeterminate).toBe(true);
         expect(outcome.message).toContain('Whether the write landed is unknown');
         expect(fake.rolledBack).toBe(false);
       });
});


// A temporal argument is checked from the model like every other scalar. The
// alternative is that the store checks it -- after a transaction is open and
// the reference lookups have run -- and answers with a parse error that names
// neither the parameter nor the type it was declared as.
describe('a date or a timestamp argument', () => {
  const schedule: Action = {
    name: 'Schedule',
    executor: {
      kind: 'sql',
      sql: {
        statements: [
          'UPDATE Account SET review_on = @day, seen_at = @at ' +
              'WHERE account_id = @account',
        ],
      },
    },
    parameters: [
      {name: 'account', type: 'Account', isEntityRef: true},
      {name: 'day', type: 'Date', isEntityRef: false},
      {name: 'at', type: 'DateTimeTz', isEntityRef: false},
    ],
  };

  function scheduling(over: Record<string, unknown> = {}) {
    const fake = resolvingFake();
    return {
      fake,
      outcome: act({
        model: model({actions: [schedule]}),
        actionName: 'Schedule',
        args: {
          account: 'A1',
          day: '2026-03-04',
          at: '2026-03-04T10:00:00Z',
          ...over,
        },
        client: fake.client,
      }),
    };
  }

  test('a well-formed pair binds as DATE and TIMESTAMP', async () => {
    const {fake, outcome} = scheduling();
    const result = await outcome;
    if (result.status !== 'committed') throw new Error(result.message);
    const write = fake.statements[fake.statements.length - 1];
    expect(write.paramTypes!['day']).toEqual({code: 'DATE'});
    expect(write.paramTypes!['at']).toEqual({code: 'TIMESTAMP'});
    expect(write.params!['day']).toBe('2026-03-04');
  });

  test(
      'a date in some other order is refused, naming the parameter',
       async () => {
         // '03/04/2026' is the fourth of March to one reader and the third of
         // April to another, so it is not a date this can accept.
         const {fake, outcome} = scheduling({day: '03/04/2026'});
         const result = await outcome;
         if (result.status !== 'error') throw new Error('expected an error');
        expect(result.message).toContain('\'day\' is a Date');
         expect(result.message).toContain('YYYY-MM-DD');
         expect(fake.committed).toBe(false);
       });

  test('a date with the right shape and no such day is refused', async () => {
    const {outcome} = scheduling({day: '2026-02-30'});
    const result = await outcome;
    if (result.status !== 'error') throw new Error('expected an error');
    expect(result.message).toContain('\'day\' is a Date');
  });

  test('a timestamp with no zone is refused rather than assumed', async () => {
    // Filling in the missing zone would write a different instant for every
    // caller, and each of them would be sure it was the one they meant.
    const {outcome} = scheduling({at: '2026-03-04T10:00:00'});
    const result = await outcome;
    if (result.status !== 'error') throw new Error('expected an error');
    expect(result.message).toContain('\'at\' is a DateTimeTz');
    expect(result.message).toContain('with the zone');
  });

  test('an offset counts as a zone', async () => {
    const {outcome} = scheduling({at: '2026-03-04T10:00:00-07:00'});
    const result = await outcome;
    expect(result.status).toBe('committed');
  });
});


describe('an entity whose key has more than one column', () => {
  test('is not resolved by matching one part of the key', async () => {
    // `region = @ref OR account_id = @ref` accepts a row matching one PART of
    // the key as though it were the row meant, and can match several rows that
    // agree on that part and differ in the rest. One value cannot name a
    // two-column key, and guessing which column it names is not resolution.
    const fake =
        new FakeSpanner([{match: 'FROM Account', rows: [['eu', '1']]}]);
    const outcome = await run(fake, {
      model: model({
        entities: [{
          name: 'Account',
          dataSource: 'demo.payments.Account',
          keys: ['region', 'accountId'],
          fields: [
            {name: 'region', expression: 'region', type: 'String'},
            {name: 'accountId', expression: 'account_id', type: 'String'},
          ],
        }],
      }),
    });
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('its key has 2 columns');
    // Nothing was asked of the store: there was no question to ask.
    expect(fake.statements).toEqual([]);
  });
});


describe('an argument given as empty text', () => {
  test('is a value for a String parameter', async () => {
    // `--arg memo=` says the memo is blank, which is a different statement
    // from not passing one.
    const fake = resolvingFake();
    const outcome = await act({
      model: creditModel({
        actions: [{
          ...credit,
          executor: {
            kind: 'sql',
            sql: {
              statements: [
                'UPDATE Account SET memo = @memo WHERE account_id = @account',
              ],
            },
          },
          parameters: [
            {name: 'account', type: 'Account', isEntityRef: true},
            {name: 'memo', type: 'String', isEntityRef: false},
          ],
          affects: [{
            concept: 'Account',
            operation: 'modify',
            fields: ['balance'],
          }],
        }],
      }),
      actionName: 'Credit',
      args: {account: 'A1', memo: ''},
      client: fake.client,
    });
    if (outcome.status !== 'committed') throw new Error(outcome.message);
  });

  test('keeps the caller\'s spacing, because a String is not parsed',
       async () => {
         // The trim on the way in exists to read a number or a date off a
         // command line. A String parameter is not being parsed -- it IS the
         // value -- so trimming it would store text the caller did not write.
         const fake = resolvingFake();
         const outcome = await act({
           model: creditModel({
             actions: [{
               ...credit,
               executor: {
                 kind: 'sql',
                 sql: {
                   statements: [
                     'UPDATE Account SET memo = @memo WHERE account_id = @account',
                   ],
                 },
               },
               parameters: [
                 {name: 'account', type: 'Account', isEntityRef: true},
                 {name: 'memo', type: 'String', isEntityRef: false},
               ],
               affects: [{
                 concept: 'Account',
                 operation: 'modify',
                 fields: ['balance'],
               }],
             }],
           }),
           actionName: 'Credit',
           args: {account: 'A1', memo: '  see ticket 42  '},
           client: fake.client,
         });
         if (outcome.status !== 'committed') throw new Error(outcome.message);
         const write = fake.statements.find(s => s.sql.includes('SET memo'));
         expect(write?.params?.['memo']).toBe('  see ticket 42  ');
       });

  test('is still not a value for a numeric one', async () => {
    // There is no Float that empty text could be.
    const outcome =
        await runCredit(resolvingFake(), {args: {account: 'A1', amount: ''}});
    if (outcome.status !== 'error') throw new Error('expected an error');
    expect(outcome.message).toContain('was not given a value');
  });
});


// The write side reads a binding the same way the read side does. A key field
// carrying only its imported vendor expression still names a real column, so
// resolving a reference against it is a lookup rather than a refusal.
describe('an entity key that awaits transpilation', () => {
  test('resolves against the imported column', async () => {
    const fake = new FakeSpanner([{match: 'FROM Account', rows: [['1']]}]);
    const outcome = await run(fake, {
      model: model({
        entities: [{
          name: 'Account',
          dataSource: 'demo.payments.Account',
          keys: ['accountId'],
          fields: [
            {
              name: 'accountId',
              importedExpression: 'account_id',
              importedDialect: 'SNOWFLAKE',
              type: 'String',
            },
          ],
        }],
      }),
    });
    expect(fake.statements[0].sql).toContain('account_id = @ref0');
    if (outcome.status === 'error') {
      throw new Error(`expected a resolved reference: ${outcome.message}`);
    }
  });
});


describe('optional and defaulted parameters', () => {
  test('substitutes a parameter default when omitted', async () => {
    const fake = new FakeSpanner();
    const outcome = await run(fake, {
      actionName: 'CreateAccount',
      args: {name: 'Alice'},
      handler: undefined,
      model: model({
        actions: [{
          name: 'CreateAccount',
          executor: {
            kind: 'sql',
            sql: {
              statements: [
                'INSERT INTO Account (account_id, name, status) VALUES (GENERATE_UUID(), @name, @status)',
              ],
            },
          },
          parameters: [
            {name: 'name', type: 'String', isEntityRef: false},
            {name: 'status', type: 'String', default: 'open', isEntityRef: false},
          ],
        }],
      }),
    });
    expect(outcome.status).toBe('committed');
    expect(fake.statements[0].params).toEqual({name: 'Alice', status: 'open'});
  });

  test('binds null when a required: false parameter is omitted', async () => {
    const fake = new FakeSpanner();
    const outcome = await run(fake, {
      actionName: 'CreateAccount',
      args: {name: 'Alice'},
      handler: undefined,
      model: model({
        actions: [{
          name: 'CreateAccount',
          executor: {
            kind: 'sql',
            sql: {
              statements: [
                'INSERT INTO Account (account_id, name, memo) VALUES (GENERATE_UUID(), @name, @memo)',
              ],
            },
          },
          parameters: [
            {name: 'name', type: 'String', isEntityRef: false},
            {name: 'memo', type: 'String', required: false, isEntityRef: false},
          ],
        }],
      }),
    });
    expect(outcome.status).toBe('committed');
    expect(fake.statements[0].params).toEqual({name: 'Alice', memo: null});
  });

  test(
      'explicit null clears a defaulted field rather than restoring the default',
      async () => {
    const fake = new FakeSpanner();
    const outcome = await run(fake, {
      actionName: 'CreateAccount',
      args: {name: 'Alice', status: null},
      handler: undefined,
      model: model({
        actions: [{
          name: 'CreateAccount',
          executor: {
            kind: 'sql',
            sql: {
              statements: [
                'INSERT INTO Account (account_id, name, status) VALUES (GENERATE_UUID(), @name, @status)',
              ],
            },
          },
          parameters: [
            {name: 'name', type: 'String', isEntityRef: false},
                {
                  name: 'status',
                  type: 'String',
                  default: 'open',
                  isEntityRef: false
                },
          ],
        }],
      }),
    });
    expect(outcome.status).toBe('committed');
        expect(fake.statements[0].params)
            .toEqual({name: 'Alice', status: null});
  });
});
