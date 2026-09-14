// Behavior specification for the store a judge reads through.
//
// Two claims are under test. The first is that what a judge can see is the
// model under its binding profile and nothing else: the schema it is shown
// lists the declared entities' bound columns, and an abstract entity or a
// field bound to an expression is not in it. The second is that what a judge
// can DO is read: a statement that is not a query is refused before it is
// sent, and every statement that is sent goes out wrapped as a subquery, which
// is what makes the refusal a property of the server rather than of a keyword
// list here.
//
// Nothing here reaches a database. The fake client records the statement it
// was asked for, which is the thing worth pinning down.

import {describe, expect, test} from 'bun:test';

import * as spanner from '../../../../src/libts/gcp/spanner';
import {Entity, SemanticModel} from '../../../../src/libts/semantic/ir';
import {modelJudgeStore, readOnly} from '../../../../src/libts/semantic/runtime/judge_store';
import {SemanticRuntime} from '../../../../src/libts/semantic/runtime/runtime';


// Records what it was asked and answers with whatever was set on it.
class FakeClient {
  readonly statements: string[] = [];
  status = 200;
  message: string|undefined = undefined;
  rows: Array<Array<string|null>> = [];
  columns: string[]|undefined = undefined;
  sessionThrows = false;

  async withSession<T>(fn: (s: string) => Promise<T>): Promise<T> {
    if (this.sessionThrows) throw new Error('no session to be had');
    return await fn('sessions/1');
  }
  async executeQuery(_s: string, stmt: {sql: string}) {
    this.statements.push(stmt.sql);
    if (this.status !== 200) return {status: this.status, message: this.message};
    return {
      status: 200,
      result: {
        rows: this.rows,
        ...(this.columns ?
                {metadata: {rowType: {fields: this.columns.map(name => ({
                                        name
                                      }))}}} :
                {}),
      },
    };
  }
  async beginReadWrite() {
    return {status: 200, result: {id: 't'}};
  }
  async executeSql() {
    return {status: 200, result: {rows: []}};
  }
  async commit() {
    return {status: 200, result: {}};
  }
  async rollback() {
    return {status: 200, result: {}};
  }
  get asClient(): spanner.SpannerDataClient {
    return this as unknown as spanner.SpannerDataClient;
  }
}


const ORDER: Entity = {
  name: 'Order',
  description: 'A customer order.\nIts total is the sum of its lines.',
  dataSource: 'orders',
  keys: ['orderId'],
  fields: [
    {name: 'orderId', expression: 'order_id', type: 'Integer'},
    {
      name: 'total',
      expression: 'order_total',
      type: 'Decimal',
      description: 'What the customer owes.',
    },
    // Bound to an expression rather than a column, so not readable.
    {name: 'netTotal', expression: 'order_total - discount', type: 'Decimal'},
    // Bound to nothing at all.
    {name: 'notes', type: 'String'},
  ],
};

const PARTY: Entity = {
  name: 'Party',
  dataSource: '',
  keys: [],
  abstract: true,
  fields: [{name: 'partyId', expression: 'party_id', type: 'Integer'}],
};

const MODEL: SemanticModel = {
  name: 'commerce',
  entities: [ORDER, PARTY],
  relationships: [],
  metrics: [],
};


function runtime(client: FakeClient, kind: 'spanner'|'alloydb' = 'spanner'):
    SemanticRuntime {
  const store = kind === 'spanner' ? {
    kind: 'spanner' as const,
    name: 'projects/p/instances/i/databases/d',
    project: 'p',
    instance: 'i',
    database: 'd',
    client: client.asClient,
  } :
                                     {
                                       kind: 'alloydb' as const,
                                       name: 'alloydb://c/i/d',
                                       project: 'p',
                                       location: 'us-central1',
                                       cluster: 'c',
                                       instance: 'i',
                                       database: 'd',
                                       client: client.asClient as any,
                                     };
  return {
    model: MODEL,
    document: 'commerce',
    store: store as any,
    profile: 'default',
    entryGroup: 'eg',
  };
}


function built(client: FakeClient, kind: 'spanner'|'alloydb' = 'spanner') {
  const store = modelJudgeStore(runtime(client, kind));
  if ('error' in store) throw new Error(store.error);
  return store;
}


describe('what a judge is told it may read', () => {
  test('names the bound table and column of every declared entity', () => {
    const {schema} = built(new FakeClient());
    expect(schema).toContain('table orders');
    expect(schema).toContain('order_id is Order.orderId, Integer');
    expect(schema).toContain('order_total is Order.total, Decimal');
  });

  test('carries what the model says a column holds', () => {
    // The description is the only written-down account of what is in there,
    // and a judge that has to infer it from the name will sometimes infer
    // wrong.
    const {schema} = built(new FakeClient());
    expect(schema).toContain('What the customer owes.');
    // Folded to one line, because the schema is a list and a description that
    // wraps reads as another entry.
    expect(schema).toContain('A customer order. Its total is the sum');
  });

  test('leaves out a field bound to an expression and one bound to nothing',
       () => {
         // Neither is a column, and a judge that writes them into a statement
         // spends a read learning that.
         const {schema} = built(new FakeClient());
         expect(schema).not.toContain('netTotal');
         expect(schema).not.toContain('notes');
       });

  test('leaves out an abstract entity, which has no table', () => {
    const {schema} = built(new FakeClient());
    expect(schema).not.toContain('Party');
  });

  test('names the dialect the judge has to write', () => {
    expect(built(new FakeClient()).schema).toContain('Write GoogleSQL');
    expect(built(new FakeClient(), 'alloydb').schema)
        .toContain('Write PostgreSQL');
  });

  test('quotes the columns the way the dialect requires', () => {
    // An unquoted PostgreSQL identifier is folded to lower case, so a judge
    // copying a mixed-case name out of an unquoted schema would read a column
    // the server says does not exist.
    expect(built(new FakeClient(), 'alloydb').schema)
        .toContain('"order_total" is Order.total');
  });
});


describe('what a judge may send', () => {
  test('a query is sent wrapped as a subquery, under a row cap', async () => {
    // The wrap is the guarantee. A keyword check can be talked round; a server
    // asked for a subquery that is not a query refuses it.
    const client = new FakeClient();
    await built(client).read('SELECT order_total FROM orders WHERE order_id=1');
    expect(client.statements).toHaveLength(1);
    expect(client.statements[0])
        .toBe(
            'SELECT * FROM (\nSELECT order_total FROM orders WHERE order_id=1\n' +
            ') AS judge_read LIMIT 21');
  });

  test('a write is refused without reaching the store', async () => {
    const client = new FakeClient();
    for (const sql of [
           `UPDATE orders SET order_total = 0`,
           `DELETE FROM orders`,
           `INSERT INTO orders VALUES (1)`,
           `DROP TABLE orders`,
           `CALL something()`,
         ]) {
      const result = await built(client).read(sql);
      expect(result.problem).toContain('begins with SELECT or WITH');
      expect(result.rows).toEqual([]);
    }
    expect(client.statements).toEqual([]);
  });

  test('a second command is refused, whatever it is', async () => {
    const client = new FakeClient();
    const result =
        await built(client).read('SELECT 1; DROP TABLE orders');
    expect(result.problem).toContain('more than one statement');
    expect(client.statements).toEqual([]);
  });

  test('a semicolon inside a literal is not a second command', async () => {
    const client = new FakeClient();
    const result = await built(client).read(
        `SELECT order_id FROM orders WHERE status = 'a;b'`);
    expect(result.problem).toBeUndefined();
    expect(client.statements[0]).toContain(`'a;b'`);
  });

  test('a semicolon inside a comment is not a second command', async () => {
    const client = new FakeClient();
    const result =
        await built(client).read('-- totals; and lines\nSELECT 1 FROM orders');
    expect(result.problem).toBeUndefined();
  });

  test('a trailing semicolon is dropped rather than refused', async () => {
    // It would otherwise land in the middle of the wrap and come back as a
    // syntax error, which tells the judge nothing about what to do instead.
    const client = new FakeClient();
    await built(client).read('SELECT 1 FROM orders;');
    expect(client.statements[0]).toBe(
        'SELECT * FROM (\nSELECT 1 FROM orders\n) AS judge_read LIMIT 21');
  });

  test('a data-modifying CTE passes the keyword check and is sent wrapped',
       async () => {
         // PostgreSQL allows `WITH x AS (DELETE ... RETURNING *) SELECT`, and
         // it begins with WITH, so nothing here catches it. What catches it is
         // the wrap: such a clause is legal only at the top level of a
         // statement, and this one is inside a subquery, so the server
         // refuses it. That is the whole reason the wrap exists.
         const client = new FakeClient();
         const sql = 'WITH gone AS (DELETE FROM orders RETURNING *) ' +
             'SELECT * FROM gone';
         const result = await built(client, 'alloydb').read(sql);
         expect(result.problem).toBeUndefined();
         expect(client.statements[0]).toContain('SELECT * FROM (\nWITH gone');
         expect(client.statements[0]).toContain(') AS judge_read LIMIT 21');
       });

  test('a leading comment does not hide the first word', async () => {
    const client = new FakeClient();
    const result = await built(client).read(
        '/* which order */\n  select order_total from orders');
    expect(result.problem).toBeUndefined();
  });
});


describe('what a judge reads back', () => {
  test('rows and column names, as text', async () => {
    const client = new FakeClient();
    client.columns = ['order_total'];
    client.rows = [['145.85']];
    const result = await built(client).read('SELECT order_total FROM orders');
    expect(result).toEqual({
      columns: ['order_total'],
      rows: [['145.85']],
      truncated: false,
    });
  });

  test('reports no column names rather than a partial list', async () => {
    // Not every backend supplies them. A list that does not line up with the
    // rows is worse than none, because it is read positionally.
    const client = new FakeClient();
    client.columns = ['order_total'];
    client.rows = [['1', '2']];
    const result = await built(client).read('SELECT a, b FROM orders');
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([['1', '2']]);
  });

  test('caps the rows and says that it did', async () => {
    const client = new FakeClient();
    client.rows = Array.from({length: 21}, (_, i) => [`${i}`]);
    const result = await built(client).read('SELECT order_id FROM orders');
    expect(result.rows).toHaveLength(20);
    expect(result.truncated).toBe(true);
  });

  test('clips a long value rather than sending the whole of it', async () => {
    const client = new FakeClient();
    client.rows = [['x'.repeat(500)]];
    const result = await built(client).read('SELECT memo FROM orders');
    expect(result.rows[0][0]).toHaveLength(203);
    expect(result.rows[0][0]).toEndWith('...');
  });

  test('a store that refuses the read answers rather than throwing', async () => {
    // The thing asking is a language model that can read the sentence and
    // write a different statement. A thrown error reaches it as a crashed
    // guard instead.
    const client = new FakeClient();
    client.status = 400;
    client.message = 'Table not found: ordres';
    const result = await built(client).read('SELECT 1 FROM ordres');
    expect(result.problem).toBe('Table not found: ordres');
    expect(result.rows).toEqual([]);
  });

  test('a store that cannot be reached answers too', async () => {
    const client = new FakeClient();
    client.sessionThrows = true;
    const result = await built(client).read('SELECT 1 FROM orders');
    expect(result.problem).toBe('no session to be had');
  });
});


describe('when there is no store to give a judge', () => {
  test('says so at setup rather than at every read', () => {
    const store = modelJudgeStore({
      model: MODEL,
      document: 'commerce',
      storeError: 'Model has no store under profile x.',
      profile: 'x',
      entryGroup: 'eg',
    });
    expect(store).toEqual({error: 'Model has no store under profile x.'});
  });

  test('a model with nothing bound is an error, not an empty schema', () => {
    const client = new FakeClient();
    const bare = modelJudgeStore(
        {...runtime(client), model: {...MODEL, entities: [PARTY]}});
    expect('error' in bare).toBe(true);
    expect((bare as {error: string}).error).toContain('nothing to read');
  });
});


describe('reading a statement before it is sent', () => {
  test('accepts a query however it is cased', () => {
    expect(readOnly('select 1')).toEqual({sql: 'select 1'});
    expect(readOnly('  WITH a AS (SELECT 1) SELECT * FROM a'))
        .toHaveProperty('sql');
  });

  test('refuses anything else by what it begins with', () => {
    const refused = readOnly('GRANT ALL ON orders TO PUBLIC');
    expect(refused).toHaveProperty('problem');
    expect((refused as {problem: string}).problem).toContain(`'GRANT'`);
  });

  test('reports an empty statement as beginning with nothing', () => {
    const refused = readOnly('   ');
    expect((refused as {problem: string}).problem).toContain('nothing');
  });

  test('accepts a read whose first word is inside parentheses', () => {
    // A union of two reads is written this way, and the parenthesis is not
    // the word the check is looking for.
    expect(readOnly('(SELECT 1) UNION ALL (SELECT 2)')).toHaveProperty('sql');
    expect(readOnly('(SELECT total FROM orders)')).toHaveProperty('sql');
  });

  test('accepts a keyword written against its operand', () => {
    expect(readOnly('SELECT*FROM orders')).toHaveProperty('sql');
  });

  test('refuses a word that merely starts like one of the two', () => {
    const refused = readOnly('SELECTED FROM orders');
    expect(refused).toHaveProperty('problem');
  });

  test('reads a hash comment as a comment, which GoogleSQL does', () => {
    expect(readOnly('SELECT 1 # ;\nFROM orders')).toHaveProperty('sql');
  });

  test('a hash comment cannot hide a second command behind an apostrophe',
     () => {
       // An unrecognised `#` comment is worse than a missed comment: the
       // apostrophe opens a quoted run that blanks everything after it, and
       // the semicolon stops being visible to the check above.
       const refused = readOnly("SELECT 1 # it's\n; DELETE FROM orders");
       expect((refused as {problem: string}).problem)
           .toContain('more than one statement');
     });
});
