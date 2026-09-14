// Behavior spec for the Spanner data client's transaction surface. Spies on the
// low-level _post so it pins the exact request bodies without a live Spanner.
//
// The seqno is the reason this file exists. Spanner requires a monotonically
// increasing per-transaction sequence number on DML, and reuses it to recognize
// a retried statement; getting it wrong does not fail at compile time or in a
// single-statement test -- it fails on the SECOND statement of a transaction,
// against the real service, with "Previously received a different request with
// this seqno". That is exactly the kind of thing a client should handle once so
// no caller ever meets it.
//

import {describe, expect, spyOn, test} from 'bun:test';

import {ApiContext} from '../../../src/libts/gcp/context';
import {SpannerDataClient} from '../../../src/libts/gcp/spanner';

const CTX = new ApiContext('test-project', 'us', 'test-token');
const SESSION =
    'projects/test-project/instances/i/databases/d/sessions/s1';

function client() {
  const c = new SpannerDataClient(CTX, 'test-project', 'i', 'd');
  const posts: Array<{path: string; body: any}> = [];
  const spy = spyOn(c, '_post').mockImplementation(
      async (path: string, body: any) => {
        posts.push({path, body});
        return {status: 200, result: {name: SESSION, id: 'txn-1'}} as never;
      });
  return {c, posts, spy};
}


describe('SpannerDataClient addressing', () => {
  test('scopes every call to one database', () => {
    const c = new SpannerDataClient(CTX, 'proj', 'inst', 'db');
    expect(c.database).toBe('projects/proj/instances/inst/databases/db');
  });

  test('creates a session under the database', async () => {
    const {c, posts} = client();
    await c.createSession();
    expect(posts[0].path).toBe(
        'projects/test-project/instances/i/databases/d/sessions');
  });

  test('begins a READ-WRITE transaction, not a read-only one', async () => {
    const {c, posts} = client();
    await c.beginReadWrite(SESSION);
    expect(posts[0].path).toBe(`${SESSION}:beginTransaction`);
    expect(posts[0].body).toEqual({options: {readWrite: {}}});
  });
});


describe('the per-transaction statement sequence number', () => {
  test('starts at 1 and increases with each statement', async () => {
    const {c, posts} = client();
    await c.executeSql(SESSION, 'txn-1', {sql: 'DELETE FROM T WHERE TRUE'});
    await c.executeSql(SESSION, 'txn-1', {sql: 'INSERT INTO T (a) VALUES (1)'});
    await c.executeSql(SESSION, 'txn-1', {sql: 'INSERT INTO T (a) VALUES (2)'});
    expect(posts.map(p => p.body.seqno)).toEqual(['1', '2', '3']);
  });

  test('is tracked per transaction, so two transactions do not share a counter',
       async () => {
         const {c, posts} = client();
         await c.executeSql(SESSION, 'txn-a', {sql: 'INSERT INTO T (a) VALUES (1)'});
         await c.executeSql(SESSION, 'txn-b', {sql: 'INSERT INTO T (a) VALUES (2)'});
         await c.executeSql(SESSION, 'txn-a', {sql: 'INSERT INTO T (a) VALUES (3)'});
         expect(posts.map(p => p.body.seqno)).toEqual(['1', '1', '2']);
       });

  test('restarts after a commit, since the next transaction is a new one',
       async () => {
         const {c, posts} = client();
         await c.executeSql(SESSION, 'txn-1', {sql: 'INSERT INTO T (a) VALUES (1)'});
         await c.commit(SESSION, 'txn-1');
         await c.executeSql(SESSION, 'txn-1', {sql: 'INSERT INTO T (a) VALUES (2)'});
         expect(posts.filter(p => p.body.seqno).map(p => p.body.seqno))
           .toEqual(['1', '1']);
       });

  test('restarts after a rollback too', async () => {
    const {c, posts} = client();
    await c.executeSql(SESSION, 'txn-1', {sql: 'INSERT INTO T (a) VALUES (1)'});
    await c.rollback(SESSION, 'txn-1');
    await c.executeSql(SESSION, 'txn-1', {sql: 'INSERT INTO T (a) VALUES (2)'});
    expect(posts.filter(p => p.body.seqno).map(p => p.body.seqno))
      .toEqual(['1', '1']);
  });
});


describe('executeSql request shape', () => {
  test('carries the transaction id, the SQL, and its parameters', async () => {
    const {c, posts} = client();
    await c.executeSql(SESSION, 'txn-1', {
      sql: 'SELECT x FROM T WHERE k = @k',
      params: {k: 'abc'},
      paramTypes: {k: {code: 'STRING'}},
    });
    expect(posts[0].path).toBe(`${SESSION}:executeSql`);
    expect(posts[0].body).toEqual({
      transaction: {id: 'txn-1'},
      sql: 'SELECT x FROM T WHERE k = @k',
      params: {k: 'abc'},
      paramTypes: {k: {code: 'STRING'}},
      seqno: '1',
    });
  });
});


describe('withSession', () => {
  test('deletes the session it created', async () => {
    const c = new SpannerDataClient(CTX, 'test-project', 'i', 'd');
    spyOn(c, '_post').mockImplementation(
        async () => ({status: 200, result: {name: SESSION}}) as never);
    const deleted: string[] = [];
    spyOn(c, '_delete').mockImplementation(async (path: string) => {
      deleted.push(path);
      return {status: 200, result: {}} as never;
    });
    await c.withSession(async name => name);
    expect(deleted).toEqual([SESSION]);
  });

  test('deletes the session even when the body throws, so none is leaked',
       async () => {
         const c = new SpannerDataClient(CTX, 'test-project', 'i', 'd');
         spyOn(c, '_post').mockImplementation(
             async () => ({status: 200, result: {name: SESSION}}) as never);
         const deleted: string[] = [];
         spyOn(c, '_delete').mockImplementation(async (path: string) => {
           deleted.push(path);
           return {status: 200, result: {}} as never;
         });
         await expect(c.withSession(async () => {
           throw new Error('boom');
         })).rejects.toThrow('boom');
         expect(deleted).toEqual([SESSION]);
       });

  test('a delete that fails does not become the caller\'s result', async () => {
    // The session delete runs after the body has already decided the outcome,
    // including after a commit. If its failure escaped, a caller reading the
    // rejection as "the write did not happen" would apply it a second time.
    const c = new SpannerDataClient(CTX, 'test-project', 'i', 'd');
    spyOn(c, '_post').mockImplementation(
        async () => ({status: 200, result: {name: SESSION}}) as never);
    spyOn(c, '_delete').mockImplementation(async () => {
      throw new Error('network reset');
    });
    expect(await c.withSession(async () => 'committed')).toBe('committed');
  });

  test('a delete that fails does not hide why the body threw', async () => {
    const c = new SpannerDataClient(CTX, 'test-project', 'i', 'd');
    spyOn(c, '_post').mockImplementation(
        async () => ({status: 200, result: {name: SESSION}}) as never);
    spyOn(c, '_delete').mockImplementation(async () => {
      throw new Error('network reset');
    });
    await expect(c.withSession(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');
  });

  test('reports a session that could not be created, naming the database',
       async () => {
         const c = new SpannerDataClient(CTX, 'test-project', 'i', 'd');
         spyOn(c, '_post').mockImplementation(
             async () => ({status: 403, message: 'denied'}) as never);
         await expect(c.withSession(async () => 1))
           .rejects.toThrow(/could not create a session on projects\/test-project/);
       });
});
