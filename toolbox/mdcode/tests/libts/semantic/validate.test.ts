// Behavior spec for the push-time validation gate
// (src/libts/semantic/validate.ts).

import {describe, expect, test} from 'bun:test';

import {Action, Entity, Field, Metric, ProfileSpec, SemanticModel, SqlDialect} from '../../../src/libts/semantic/ir';
import {listed, LoadedModel, LoadOptions, loadModels} from '../../../src/libts/semantic/loader';
import {applyProfile, applyProfileFile} from '../../../src/libts/semantic/resolve_profiles';
import {isColumnName} from '../../../src/libts/semantic/sql_expr_utils';
import {inlineBindingWarnings, validateBigQueryActionStatements, validateBigQueryDataSources, validateDeployments, validateExpressionReferences, validateInheritedColumns, validateInlineDialects, validatePushRequirements, validateSpannerActionStatements} from '../../../src/libts/semantic/validate';
import {BigQueryClientMock, mockSchema, SpannerClientMock} from '../mocks';

// A parsed BigQuery Graph deployment target the strict matcher accepts.
const BQ_TARGET =
    'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';

// A parsed Spanner Graph deployment target the strict matcher accepts.
const SPANNER_TARGET =
    'spanner.googleapis.com/projects/p/instances/i/databases/db/graphs/g';

function loaded(model: SemanticModel, document = 'doc'): LoadedModel {
  return {document, model};
}

function model(over: Partial<SemanticModel> = {}, targets?: string[]):
    SemanticModel {
  const deployments = over.deployments ??
      targets?.map((target, i) => ({
                     name: targets.length === 1 ? 'default' :
                                                  `deployment_${i + 1}`,
                     target,
                   }));
  return {
    name: 'm',
    entities: [],
    relationships: [],
    metrics: [],
    ...over,
    ...(deployments ? {deployments} : {}),
  };
}

describe('validatePushRequirements', () => {
  test('refuses a field whose BigQuery text calls a window function only on a BigQuery deployment', () => {
    const windowed = (targets?: string[]) => model({
      entities: [{
        name: 'o', dataSource: 'p.d.o', keys: ['p'],
        fields: [
          {name: 'p', expression: 'p'},
          {name: 'rank_in_day', dialects: [{dialect: 'BIGQUERY', expression: 'RANK() OVER (PARTITION BY d ORDER BY p)'}]},
        ],
      }],
    }, targets);

    expect(validatePushRequirements([loaded(windowed([BQ_TARGET]))])).toEqual([
      "field 'o.rank_in_day' in model 'm' (doc): its BigQuery expression calls a window function, " +
          'which a BigQuery graph property cannot hold; write the field without one.',
    ]);
    expect(validatePushRequirements([loaded(windowed())])).toEqual([]);
    expect(validatePushRequirements([loaded(windowed([SPANNER_TARGET]))])).toEqual([]);
  });

  test('refuses a window field that names its entity by a word BigQuery reads otherwise', () => {
    const m = model({
      entities: [{
        name: 'Date', dataSource: 'p.d.o', keys: ['p'],
        fields: [{name: 'p', expression: 'p'}, {name: 'r', dialects: [{dialect: 'BIGQUERY', expression: 'SUM(Date.p) OVER ()'}]}],
      }],
    }, [BQ_TARGET]);

    expect(validatePushRequirements([loaded(m)])).toEqual([
      "field 'Date.r' in model 'm' (doc): its BigQuery expression calls a window function, " +
          'which a BigQuery graph property cannot hold; write the field without one.',
    ]);
  });

  test('accepts a window field of an entity another extends, which has no node table', () => {
    const fields = (rank: string) => [{name: 'p', expression: 'p'}, {name: 'r', dialects: [{dialect: 'BIGQUERY' as const, expression: rank}]}];
    const m = model({
      entities: [
        {name: 'o', dataSource: 'p.d.o', keys: ['p'], fields: fields('RANK() OVER (ORDER BY p)')},
        {name: 'c', dataSource: 'p.d.c', keys: ['p'], extends: ['o'], fields: fields('r_col')},
      ],
    }, [BQ_TARGET]);

    expect(validatePushRequirements([loaded(m)])).toEqual([]);
  });

  test('names the field that writes a window text the leaves inherit', () => {
    const m = model({
      entities: [
        {name: 'o', dataSource: 'p.d.o', keys: ['p'], fields: [
          {name: 'p', expression: 'p'},
          {name: 'r', dialects: [{dialect: 'BIGQUERY', expression: 'ROW_NUMBER() OVER ()'}]},
        ]},
        {name: 'c1', dataSource: 'p.d.c1', keys: ['p'], extends: ['o'], fields: [{name: 'p', expression: 'p'}]},
        {name: 'c2', dataSource: 'p.d.c2', keys: ['p'], extends: ['o'], fields: [{name: 'p', expression: 'p'}]},
      ],
    }, [BQ_TARGET]);

    expect(validatePushRequirements([loaded(m)])).toEqual([
      "field 'o.r' in model 'm' (doc): its BigQuery expression calls a window function, which a " +
          "BigQuery graph property cannot hold, and entities 'c1' and 'c2' inherit it; write the " +
          'field without one.',
    ]);
  });

  test('a model with a deployment target and resolved metrics passes', () => {
    const m = model(
        {
          entities: [{
            name: 'o',
            dataSource: 'p.d.o',
            keys: ['p'],
            fields: [{name: 'p', expression: 'p'}],
          }],
          metrics:
              [{name: 'rev', expression: 'SUM(o.p)', entity: 'o'} as Metric]
        },
        [BQ_TARGET]);
    expect(validatePushRequirements([loaded(m)])).toEqual([]);
  });

  test(
      'a BigQuery-target metric that resolves to no entity is rejected', () => {
        const m = model(
            {metrics: [{name: 'cnt', expression: 'COUNT(*)'} as Metric]},
            [BQ_TARGET]);
        const errs = validatePushRequirements([loaded(m)]);
        expect(errs.length).toBe(1);
        expect(errs[0]).toContain('metric \'cnt\'');
        expect(errs[0]).toContain('single entity');
      });

  test('a model with a Spanner Graph deployment target passes', () => {
    const m = model(
        {
          entities: [{name: 'o', dataSource: 'o', keys: ['id'], fields: []}],
          metrics: [{
            name: 'cnt',
            expression: 'COUNT(*)',
            entity: 'o',
            authoredEntity: 'o',
          } as Metric],
        },
        [SPANNER_TARGET]);
    expect(validatePushRequirements([loaded(m)])).toEqual([]);
  });

  test('errors accumulate across models', () => {
    const unresolved = (name: string) => loaded(
        model(
            {name, metrics: [{name: 'cnt', expression: 'COUNT(*)'} as Metric]},
            [BQ_TARGET]),
        name);
    expect(validatePushRequirements([unresolved('a'), unresolved('b')]))
        .toHaveLength(2);
  });
});

// Helpers for the live data-source check.
function entity(name: string, dataSource: string): Entity {
  return {name, dataSource, keys: [], fields: []} as Entity;
}

function mockTable(project: string, dataset: string, tableId: string) {
  return {
    id: tableId,
    tableReference: {projectId: project, datasetId: dataset, tableId}
  };
}

describe('validateBigQueryDataSources', () => {
  test('passes when every entity source table is reachable', async () => {
    const bq = new BigQueryClientMock();
    bq.addMockTable(mockTable('p', 'd', 'orders'));
    bq.addMockTable(mockTable('p', 'd', 'customer'));
    const m = model({
      entities:
          [entity('orders', 'p.d.orders'), entity('customer', 'p.d.customer')]
    });
    expect(await validateBigQueryDataSources([loaded(m)], bq, 'p')).toEqual([]);
  });

  test(
      'reports a missing source table, naming the entity/model/document',
      async () => {
        const bq = new BigQueryClientMock();
        bq.addMockTable(mockTable('p', 'd', 'orders'));
        const m = model({
          entities:
              [entity('orders', 'p.d.orders'), entity('gone', 'p.d.ghost')],
        });
        const errs = await validateBigQueryDataSources([loaded(m)], bq, 'p');
        expect(errs.length).toBe(1);
        expect(errs[0]).toContain('p.d.ghost');
        expect(errs[0]).toContain('does not exist');
        expect(errs[0]).toContain('entity \'gone\'');
        expect(errs[0]).toContain('doc');
      });

  test('covers a four-part REST-catalog / Iceberg source', async () => {
    // A federated REST-catalog table (e.g. Iceberg via BigLake) is a four-part
    // name that tables.get cannot address; the dry-run resolves it as the
    // deploy will. A reachable one passes; a missing one is reported by name.
    const bq = new BigQueryClientMock();
    bq.addMockSource('ice_cat.db.sales.orders');
    const ok = model({entities: [entity('orders', 'ice_cat.db.sales.orders')]});
    expect(await validateBigQueryDataSources([loaded(ok)], bq, 'p'))
        .toEqual([]);

    const missing =
        model({entities: [entity('lost', 'ice_cat.db.sales.ghost')]});
    const errs = await validateBigQueryDataSources([loaded(missing)], bq, 'p');
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('ice_cat.db.sales.ghost');
    expect(errs[0]).toContain('does not exist');
  });

  test('reports a permission-denied source table', async () => {
    const bq = new BigQueryClientMock();
    bq.query =
        (async () =>
             ({status: 403, message: 'Access Denied: no permission'})) as any;
    const m = model({entities: [entity('o', 'p.d.o')]});
    const errs = await validateBigQueryDataSources([loaded(m)], bq, 'p');
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('permission denied');
  });

  test('probes a table name that contains spaces (from a backtick-quoted catalog name)', async () => {
    const bq = new BigQueryClientMock();
    bq.addMockSource('acme.sales.order items');
    const ok = model({entities: [entity('o', 'acme.sales.order items')]});
    expect(await validateBigQueryDataSources([loaded(ok)], bq, 'p')).toEqual([]);

    const missing = model({entities: [entity('o', 'acme.sales.missing items')]});
    const errs = await validateBigQueryDataSources([loaded(missing)], bq, 'p');
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('acme.sales.missing items');
  });

  test(
      'probes each distinct table once across entities and models',
      async () => {
        const bq = new BigQueryClientMock();
        bq.addMockTable(mockTable('p', 'd', 'shared'));
        let calls = 0;
        const orig = bq.query.bind(bq);
        bq.query = ((p: string, sql: string, loc?: string, dry?: boolean) => {
                     calls++;
                     return orig(p, sql, loc, dry);
                   }) as any;
        const m1 = model({name: 'm1', entities: [entity('a', 'p.d.shared')]});
        const m2 = model({name: 'm2', entities: [entity('b', 'p.d.shared')]});
        const errs = await validateBigQueryDataSources(
            [loaded(m1, 'd1'), loaded(m2, 'd2')], bq, 'p');
        expect(errs).toEqual([]);
        expect(calls).toBe(1);
      });

  test('in the graph dataset\'s location, gives the probe\'s own error unless the retry finds another location', async () => {
    // Probes table p.x.t with a BigQuery that answers `located` to a probe
    // that names a location and `anywhere` to one that names none, and gives
    // each probe's location, or null for none.
    async function probe(located: unknown, anywhere: unknown) {
      const bq = new BigQueryClientMock();
      const locations: unknown[] = [];
      bq.query = (async (_p: string, _sql: string, location?: string) => {
                   locations.push(location ?? null);
                   return location ? located : anywhere;
                 }) as any;
      const errors = await validateBigQueryDataSources(
          [loaded(model({entities: [entity('o', 'p.x.t')]}))], bq, 'p',
          {at: "[doc] deployment 'g'", dataset: 'p.d',
           location: 'us-central1'});
      return {errors, locations};
    }
    const missing = {status: 404, message: 'Not found: Table'};
    expect(await probe(missing, missing)).toEqual({
      errors: [expect.stringContaining(
          "BigQuery table 'p.x.t', which does not exist")],
      locations: ['us-central1', null],
    });
    const there = await probe({status: 503, message: 'Backend error'},
        {status: 200, result: {jobReference: {location: 'us-central1'}}});
    expect(there.errors).toEqual([expect.stringContaining(
        'which could not be verified (Backend error)')]);
  });
});

describe('action parameters', () => {
  // Both of these turn on WHETHER THE CONCEPT TABLE WAS BUILT. It is built
  // lazily -- walking inheritance is not free, and most models declare no
  // action that needs it -- so what asks for it decides which message an
  // author gets, and asking for it too rarely is invisible until you read the
  // message the author actually sees.
  const order = (): Entity => ({
    name: 'Order',
    dataSource: 'p.d.orders',
    keys: ['id'],
    fields: [{name: 'id', type: 'Integer', expression: 'id'}],
  });

  test('an entity named as a `type` is told to project a field instead', () => {
    // The migration case, and the one model that gets nothing else wrong: no
    // `affects`, nothing projected, just an entity where a datatype belongs.
    // Nothing else in the action asks for the concept table, so the lookup has
    // to be triggered by the bad `type` itself -- otherwise the author is told
    // only "not a scalar datatype" and is left to work out that the fix is a
    // projection.
    const m = model(
        {
          entities: [order()],
          actions: [{
            name: 'Close',
            parameters: [{name: 'target', type: 'Order'}],
          }],
        },
        [BQ_TARGET]);
    const errs = validatePushRequirements([loaded(m)]);
    expect(errs.some(e => e.includes('which is an entity'))).toBe(true);
    expect(errs.some(e => e.includes('{concept: Order, field: <field>}')))
        .toBe(true);
  });

  test('a dangling `extends` does not get blamed on the projected field', () => {
    // Resolving inheritance throws here, so the concept table is unavailable
    // and the parameter arrives with no type -- for a reason that has nothing
    // to do with the field it projects from. Blaming the field would send the
    // author to one that is correctly typed and away from the `extends` that
    // is the actual fault, which IS reported, on its own line.
    const savings: Entity = {
      name: 'Savings',
      dataSource: 'p.d.savings',
      keys: ['id'],
      fields: [],
      extends: ['Order', 'NoSuchEntity'],
    };
    const m = model(
        {
          entities: [order(), savings],
          actions: [{
            name: 'Close',
            parameters: [{name: 'acct', concept: 'Savings', field: 'id'}],
          }],
        },
        [BQ_TARGET]);
    const errs = validatePushRequirements([loaded(m)]);
    expect(errs.some(e => e.includes('NoSuchEntity'))).toBe(true);
    expect(errs.some(e => e.includes('declares no datatype'))).toBe(false);
  });
});


// The push-time live DML pre-flight. What these specify is the validator's own
// behavior -- which statements it sends, where, with what parameter types, how
// it reports a refusal and that it cleans up -- against a fake store that
// answers from a declared schema. Whether the REAL backends refuse the same
// statements is a question only a live run can settle; see the e2e tests.
describe('action statement pre-flight', () => {
  const ACCOUNT = {account: ['account_id', 'balance', 'memo']};

  // An action whose sql executor runs `statements`, with three declared
  // parameters the statements may reference.
  function sqlAction(statements: string[], name = 'Transfer'): Action {
    return {
      name,
      parameters: [
        {name: 'amount', type: 'Float'},
        {name: 'id', type: 'Integer'},
        {name: 'note', type: 'Opaque'},
        {name: 'at', type: 'DateTime'},
        {name: 'tz', type: 'DateTimeTz'},
      ],
      executor: {kind: 'sql', sql: {statements}},
    } as Action;
  }

  function spannerModel(actions: Action[]): LoadedModel {
    return loaded(model({actions}, [SPANNER_TARGET]));
  }

  function bqModel(actions: Action[]): LoadedModel {
    return loaded(model({actions}, [BQ_TARGET]));
  }

  const GOOD = 'UPDATE account SET balance = @amount WHERE account_id = @id';

  describe('validateSpannerActionStatements', () => {
    test('a statement the database accepts passes', async () => {
      const spanner = new SpannerClientMock();
      spanner.schema = mockSchema(ACCOUNT);
      expect(await validateSpannerActionStatements(
                 [spannerModel([sqlAction([GOOD])])], spanner))
          .toEqual([]);
      expect(spanner.planned.length).toBe(1);
    });

    test('plans against the database the profile deploys to', async () => {
      const spanner = new SpannerClientMock();
      spanner.schema = mockSchema(ACCOUNT);
      await validateSpannerActionStatements(
          [spannerModel([sqlAction([GOOD])])], spanner);
      // SPANNER_TARGET names projects/p/instances/i/databases/db: the action's
      // rows live in the same database the graph is published to.
      expect(spanner.createdSessions[0])
          .toContain('projects/p/instances/i/databases/db/sessions/');
    });

    test('a table the database does not have fails the push', async () => {
      const spanner = new SpannerClientMock();
      spanner.schema = mockSchema(ACCOUNT);
      const errs = await validateSpannerActionStatements(
          [spannerModel([sqlAction(['DELETE FROM accounts WHERE 1=1'])])],
          spanner);
      expect(errs.length).toBe(1);
      expect(errs[0]).toContain('action \'Transfer\'');
      expect(errs[0]).toContain('statement 1');
      expect(errs[0]).toContain('doc');
      expect(errs[0]).toContain('Not found: Table accounts');
    });

    // The whole reason to ask the store rather than compare names here: its
    // answer names the column the author meant. A message assembled locally
    // would say only that `accountId` is not bound.
    test('passes the store\'s did-you-mean through to the author', async () => {
      const spanner = new SpannerClientMock();
      spanner.schema = mockSchema(ACCOUNT);
      const errs = await validateSpannerActionStatements(
          [spannerModel([sqlAction([
            'UPDATE account SET balance = @amount WHERE accountId = @id'
          ])])],
          spanner);
      expect(errs.length).toBe(1);
      expect(errs[0]).toContain('Did you mean account_id?');
    });

    // Sending the types is what makes the action's DECLARED parameter types a
    // claim the store checks, rather than a comment.
    test.each([
      ['each referenced parameter', GOOD],
      ['parameters written with a space or in backticks',
       'UPDATE account SET balance = @ amount WHERE account_id = @`id`'],
      ['parameters written in another case',
       'UPDATE account SET balance = @AMOUNT WHERE account_id = @Id'],
    ])('sends the declared type of %s', async (_, statement) => {
      const spanner = new SpannerClientMock();
      spanner.schema = mockSchema(ACCOUNT);
      await validateSpannerActionStatements(
          [spannerModel([sqlAction([statement])])], spanner);
      expect(spanner.planned[0].paramTypes)
          .toEqual({amount: {code: 'FLOAT64'}, id: {code: 'INT64'}});
    });

    // Spanner has no DATETIME type.
    test('sends TIMESTAMP for a DateTime parameter', async () => {
      const spanner = new SpannerClientMock();
      spanner.schema = mockSchema(ACCOUNT);
      await validateSpannerActionStatements(
          [spannerModel(
              [sqlAction(['UPDATE account SET memo = @at WHERE account_id = @id'])])],
          spanner);
      expect(spanner.planned[0].paramTypes)
          .toEqual({at: {code: 'TIMESTAMP'}, id: {code: 'INT64'}});
    });

    test('omits a parameter the statement does not reference', async () => {
      const spanner = new SpannerClientMock();
      spanner.schema = mockSchema(ACCOUNT);
      await validateSpannerActionStatements(
          [spannerModel(
              [sqlAction(['DELETE FROM account WHERE account_id = @id'])])],
          spanner);
      expect(Object.keys(spanner.planned[0].paramTypes ?? {})).toEqual(['id']);
    });

    test('omits a parameter named only inside a comment', async () => {
      const spanner = new SpannerClientMock();
      spanner.schema = mockSchema(ACCOUNT);
      const errs = await validateSpannerActionStatements(
          [spannerModel([sqlAction([
            'DELETE FROM account WHERE account_id = @id -- @amount is untouched',
            'DELETE FROM account WHERE account_id = @id /* @amount */',
            '# @amount is untouched\nDELETE FROM account WHERE account_id = @id',
          ])])],
          spanner);
      expect(errs).toEqual([]);
      expect(spanner.planned.map(p => p.paramTypes)).toEqual([
        {id: {code: 'INT64'}},
        {id: {code: 'INT64'}},
        {id: {code: 'INT64'}},
      ]);
    });

    // An Opaque parameter means the model does not know the type. Asserting one
    // would invent a constraint the author never wrote, so it is left for the
    // store to infer.
    test('omits an Opaque parameter rather than guessing a type', async () => {
      const spanner = new SpannerClientMock();
      spanner.schema = mockSchema(ACCOUNT);
      await validateSpannerActionStatements(
          [spannerModel(
              [sqlAction(['UPDATE account SET memo = @note WHERE 1=1'])])],
          spanner);
      expect(spanner.planned[0].paramTypes).toEqual({});
    });

    // PLAN mode has to begin a read-write transaction, which is never
    // committed; deleting the session is what discards it.
    test('deletes the session even when a statement is refused', async () => {
      const spanner = new SpannerClientMock();
      spanner.schema = mockSchema(ACCOUNT);
      const errs = await validateSpannerActionStatements(
          [spannerModel([sqlAction(['DELETE FROM ghost WHERE 1=1'])])],
          spanner);
      expect(errs.length).toBe(1);
      expect(spanner.deletedSessions).toEqual(spanner.createdSessions);
    });

    // deleteSession goes over the wire, and a transport failure REJECTS rather
    // than returning a status. Letting that escape would discard the statement
    // errors already collected and surface a cleanup problem as an unhandled
    // rejection out of push -- reporting nothing about the statements that are
    // actually wrong.
    test('reports statement errors even when the cleanup throws', async () => {
      const spanner = new SpannerClientMock();
      spanner.schema = mockSchema(ACCOUNT);
      spanner.deleteSession = async () => {
        throw new Error('ECONNRESET');
      };
      const errs = await validateSpannerActionStatements(
          [spannerModel([sqlAction(['DELETE FROM ghost WHERE 1=1'])])],
          spanner);
      expect(errs.length).toBe(1);
      expect(errs[0]).toContain('statement 1');
    });

    test('reports the diagnosis without the statement echo', async () => {
      const spanner = new SpannerClientMock();
      // The message the client gives for a live PLAN of a bad statement: the
      // diagnosis, the statement echoed back, and a caret under the token.
      spanner.planDml = (async () => ({
                           status: 400,
                           message: 'Unrecognized name: accountId; Did you ' +
                               'mean account_id? [at 1:54]\n' +
                               'UPDATE account SET balance = @amount\n     ^',
                         })) as any;
      const errs = await validateSpannerActionStatements(
          [spannerModel([sqlAction([GOOD])])], spanner);
      expect(errs.length).toBe(1);
      expect(errs[0]).toContain('Did you mean account_id? [at 1:54].');
      // The echoed statement and its caret say nothing the author cannot see in
      // their own profile, and the caret misaligns once the message sits inside
      // a longer sentence.
      expect(errs[0]).not.toContain('UPDATE account SET balance');
      expect(errs[0]).not.toContain('^');
    });

    // Spanner's top-level `error.message` escapes its newlines, so the client
    // gives this form when the body has no LocalizedMessage detail.
    test(
        'reports the first line of a message whose newlines are escaped',
        async () => {
          const spanner = new SpannerClientMock();
          spanner.planDml =
              (async () => ({
                 status: 404,
                 message: 'Not found: Table orders was not found\\n' +
                     'UPDATE orders SET x = 1',
               })) as any;
          const errs = await validateSpannerActionStatements(
              [spannerModel([sqlAction([GOOD])])], spanner);
          expect(errs[0]).toContain('Not found: Table orders was not found.');
          expect(errs[0]).not.toContain('UPDATE orders');
        });

    test('shows a long message whole', async () => {
      const spanner = new SpannerClientMock();
      const long = `Syntax error: ${'x'.repeat(2500)}`;
      spanner.planDml = (async () => ({status: 400, message: long})) as any;
      const errs = await validateSpannerActionStatements(
          [spannerModel([sqlAction([GOOD])])], spanner);
      expect(errs[0]).toContain(`${long}.`);
    });

    test('shows a non-JSON body rather than swallowing it', async () => {
      const spanner = new SpannerClientMock();
      spanner.planDml = (async () => ({
                           status: 502,
                           message: 'Bad Gateway',
                         })) as any;
      const errs = await validateSpannerActionStatements(
          [spannerModel([sqlAction([GOOD])])], spanner);
      expect(errs[0]).toContain('Bad Gateway');
    });

    test('opens one session for every statement on a database', async () => {
      const spanner = new SpannerClientMock();
      spanner.schema = mockSchema(ACCOUNT);
      const a = spannerModel([sqlAction([GOOD, GOOD], 'A')]);
      const b = spannerModel([sqlAction([GOOD], 'B')]);
      expect(await validateSpannerActionStatements([a, b], spanner))
          .toEqual([]);
      expect(spanner.planned.length).toBe(3);
      expect(spanner.createdSessions.length).toBe(1);
    });

    // A push that could not verify its statements must not proceed as though it
    // had -- an unreachable database is a failed check, not an absent one.
    test('reports a database it could not open a session on', async () => {
      const spanner = new SpannerClientMock();
      spanner.sessionError = 'PERMISSION_DENIED: spanner.sessions.create';
      const errs = await validateSpannerActionStatements(
          [spannerModel([sqlAction([GOOD])])], spanner);
      expect(errs.length).toBe(1);
      expect(errs[0]).toContain('could not open a session');
      expect(errs[0]).toContain('spanner.sessions.create');
      expect(spanner.planned.length).toBe(0);
    });

    test('a model with no sql executor sends nothing', async () => {
      const spanner = new SpannerClientMock();
      const m = spannerModel([{
        name: 'Notify',
        parameters: [],
        executor: {kind: 'mcp', mcp: {server: 's', tool: 't'}},
      } as unknown as Action]);
      expect(await validateSpannerActionStatements([m], spanner)).toEqual([]);
      expect(spanner.createdSessions).toEqual([]);
    });

    // A blank statement has already failed the push in
    // validatePushRequirements; sending it would earn a second, less useful
    // complaint from the store.
    test('skips a blank statement', async () => {
      const spanner = new SpannerClientMock();
      spanner.schema = mockSchema(ACCOUNT);
      const errs = await validateSpannerActionStatements(
          [spannerModel([sqlAction(['  ', GOOD])])], spanner);
      expect(errs).toEqual([]);
      expect(spanner.planned.length).toBe(1);
    });
  });

  describe('validateBigQueryActionStatements', () => {
    test('a statement BigQuery accepts passes', async () => {
      const bq = new BigQueryClientMock();
      bq.dmlSchema = mockSchema(ACCOUNT);
      expect(await validateBigQueryActionStatements(
                 [bqModel([sqlAction([GOOD])])], bq, 'other'))
          .toEqual([]);
      expect(bq.dryRunDml.length).toBe(1);
    });

    test('bills the dry run to the model\'s own project', async () => {
      const bq = new BigQueryClientMock();
      bq.dmlSchema = mockSchema(ACCOUNT);
      await validateBigQueryActionStatements(
          [bqModel([sqlAction([GOOD])])], bq, 'fallback');
      // BQ_TARGET names projects/p; the default is only used when the model
      // declares no BigQuery target.
      expect(bq.dryRunDml[0].project).toBe('p');
    });

    test('a column BigQuery does not have fails the push', async () => {
      const bq = new BigQueryClientMock();
      bq.dmlSchema = mockSchema(ACCOUNT);
      const errs = await validateBigQueryActionStatements(
          [bqModel([sqlAction([
            'UPDATE account SET balance = @amount WHERE accountId = @id'
          ])])],
          bq, 'p');
      expect(errs.length).toBe(1);
      expect(errs[0]).toContain('action \'Transfer\'');
      expect(errs[0]).toContain('Did you mean account_id?');
      expect(errs[0]).toContain('BigQuery');
    });

    // BigQuery infers parameter types only when a request declares none.
    test.each([
      ['the declared type of each referenced parameter', GOOD,
       {amount: 'FLOAT64', id: 'INT64'}],
      ['no types for a statement that reads an Opaque parameter',
       'UPDATE account SET memo = @note WHERE account_id = @id', {}],
      ['DATETIME for a DateTime parameter',
       'UPDATE account SET memo = @at WHERE account_id = @id',
       {at: 'DATETIME', id: 'INT64'}],
      ['TIMESTAMP for a DateTimeTz parameter',
       'UPDATE account SET memo = @tz WHERE account_id = @id',
       {tz: 'TIMESTAMP', id: 'INT64'}],
      ['the types of parameters written with a space or in backticks',
       'UPDATE account SET balance = @ amount WHERE account_id = @`id`',
       {amount: 'FLOAT64', id: 'INT64'}],
      ['the declared types of parameters written in another case',
       'UPDATE account SET balance = @AMOUNT WHERE account_id = @Id',
       {amount: 'FLOAT64', id: 'INT64'}],
    ])('sends %s', async (_, statement, types) => {
      const bq = new BigQueryClientMock();
      bq.dmlSchema = mockSchema(ACCOUNT);
      await validateBigQueryActionStatements(
          [bqModel([sqlAction([statement])])], bq, 'p');
      expect(bq.dryRunDml[0].parameterTypes).toEqual(types);
    });

    test('omits a parameter named only inside a comment', async () => {
      const bq = new BigQueryClientMock();
      bq.dmlSchema = mockSchema(ACCOUNT);
      const errs = await validateBigQueryActionStatements(
          [bqModel([sqlAction([
            'DELETE FROM account WHERE account_id = @id -- @amount is untouched',
            'DELETE FROM account WHERE account_id = @id /* @amount */',
            '# @amount is untouched\nDELETE FROM account WHERE account_id = @id',
          ])])],
          bq, 'p');
      expect(errs).toEqual([]);
      expect(bq.dryRunDml.map(d => d.parameterTypes))
          .toEqual([{id: 'INT64'}, {id: 'INT64'}, {id: 'INT64'}]);
    });

    test('checks every statement of every action', async () => {
      const bq = new BigQueryClientMock();
      bq.dmlSchema = mockSchema(ACCOUNT);
      const m = bqModel([
        sqlAction([GOOD, 'DELETE FROM ghost WHERE 1=1'], 'A'),
        sqlAction(['DELETE FROM alsoghost WHERE 1=1'], 'B'),
      ]);
      const errs = await validateBigQueryActionStatements([m], bq, 'p');
      expect(errs.length).toBe(2);
      expect(errs[0]).toContain('action \'A\'');
      expect(errs[0]).toContain('statement 2');
      expect(errs[1]).toContain('action \'B\'');
      expect(errs[1]).toContain('statement 1');
    });
  });
});


describe('inheritance rules', () => {
  function ent(name: string, over: Partial<Entity> = {}): Entity {
    return {
      name,
      dataSource: `p.d.${name}`,
      keys: [`${name}_id`],
      fields: [{name: `${name}_id`, expression: `${name}_id`}],
      ...over,
    };
  }
  function check(over: Partial<SemanticModel>): string[] {
    return validatePushRequirements(
        [loaded(model(over))]);
  }
  const customer = ent('customer', {
    fields: [{name: 'name', expression: 'name', type: 'String',
              description: 'Display name'}],
  });

  test('a subtype rebinding an inherited field passes', () => {
    expect(check({
      entities: [
        customer,
        ent('vip', {extends: ['customer'],
                    fields: [{name: 'name', expression: 'c_name'}]}),
      ],
    })).toEqual([]);
  });

  test('a subtype redefining an inherited field is rejected, even with a binding', () => {
    for (const extra of [
      {type: 'Integer' as const}, {label: 'L'}, {dimension: {}},
      {description: 'd'}, {aiContext: {instructions: 'i'}},
      {customExtensions: [{vendorName: 'ACME', data: '{}'}]},
    ]) {
      const errors = check({
        entities: [
          customer,
          ent('vip', {extends: ['customer'],
                      fields: [{name: 'name', expression: 'c_name', ...extra}]}),
        ],
      });
      expect(errors.join('\n')).toContain(
          "field 'name' is inherited, so it may only be rebound to a column");
    }
  });

  // A redeclaration sets `expression` and nothing else.
  test('a subtype redeclaring an inherited field with no expression is rejected', () => {
    for (const f of [{name: 'name'}, {name: 'name', stringForm: true},
                     {name: 'name', importedDialect: 'SNOWFLAKE'},
                     {name: 'name', type: 'Integer' as const}]) {
      expect(check({
        entities: [customer, ent('vip', {extends: ['customer'], fields: [f]})],
      }).join('\n')).toContain(
          "field 'name' is inherited from 'customer'; restate it only to " +
          "rebind it with 'expression', or remove the line.");
    }
  });

  test('name-only redeclarations on both sides of a diamond are rejected', () => {
    const party = ent('party', {
      abstract: true, dataSource: undefined, keys: [],
      fields: [{name: 'id', type: 'String'}],
    });
    const side = (name: string) => ent(name, {
      abstract: true, dataSource: undefined, keys: [], extends: ['party'],
      fields: [{name: 'id'}],
    });
    const errors = check({
      entities: [
        party, side('customer'), side('account'),
        ent('vip', {extends: ['customer', 'account'], keys: ['id'],
                    fields: [{name: 'id', expression: 'vip_id'}]}),
      ],
    }).join('\n');
    expect(errors).toContain("entity 'customer' in model");
    expect(errors).toContain("entity 'account' in model");
    expect(errors).toContain("field 'id' is inherited from 'party'");
  });

  test(
      'a profile file binds an inherited field the model does not redeclare',
      () => {
        const logical = `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    entities:
      - name: party
        abstract: true
        fields:
          - { name: name, datatype: String }
      - name: customer
        extends: [party]
        primary_key: [id]
        fields:
          - { name: id, datatype: Integer }
`;
        const profile = `name: analytical
entities:
  - name: customer
    source: bigquery.googleapis.com/projects/p/datasets/d/tables/customer
    fields:
      - { name: id, expression: c_custkey }
      - { name: name, expression: c_name }
`;
        const [base] = loadModels(logical, {bindingOptional: true}).models;
        // The catalog leg validates the logical model unpruned.
        expect(validatePushRequirements([loaded(base, 'sales.yaml')]))
            .toEqual([]);
        const applied = applyProfileFile(base, profile, 'analytical');
        if ('error' in applied) throw new Error(applied.error);
        expect(validatePushRequirements([loaded(applied.model, 'sales.yaml')]))
            .toEqual([]);
      });

  test('a cycle or an ambiguous field is still reported on a pruned model', () => {
    const cyclic = model({
      entities: [ent('a', {extends: ['b']}), ent('b', {extends: ['a']})],
    });
    const ambiguous = model({
      entities: [
        ent('x', {fields: [{name: 'id', expression: 'id'}]}),
        ent('y', {fields: [{name: 'id', expression: 'id'}]}),
        ent('z', {extends: ['x', 'y']}),
      ],
    });
    for (const [m, want] of [[cyclic, /must not form a cycle/],
                             [ambiguous, /declare or rebind 'id'/]] as const) {
      const errors = validatePushRequirements(
          [loaded(m)], {fieldsPruned: true});
      expect(errors.join('\n')).toMatch(want);
    }
    // Pruning never drops an entity, so an unknown parent is reported on a
    // pruned model too.
    expect(validatePushRequirements(
               [loaded(model({entities: [ent('a', {extends: ['gone']})]}))],
               {fieldsPruned: true}).join('\n'))
        .toContain("extends unknown entity 'gone'");
  });

  test('an abstract entity is rejected for a source, keys or a bound field', () => {
    const base = {abstract: true, keys: [], fields: [], dataSource: ''};
    expect(check({entities: [ent('party', {...base, dataSource: 'p.d.party'})]})
               .join('\n')).toContain('cannot declare a source');
    expect(check({entities: [ent('party', {...base, keys: ['id']})]}).join('\n'))
        .toContain('cannot declare a primary key or unique keys');
    expect(check({entities: [ent('party', {...base, uniqueKeys: [['id']]})]})
               .join('\n')).toContain('cannot declare a primary key or unique keys');
    expect(check({entities: [ent('party', {...base, fields: [{name: 'id', expression: 'id'}]})]})
               .join('\n')).toContain("its field 'id' cannot carry an expression");
    expect(check({entities: [ent('party', {...base, authoredSource: 'bigquery.googleapis.com/projects/p/datasets/d/tables/party'})]})
               .join('\n')).toContain('cannot declare a source');
  });

  test('an abstract entity with no subtypes and nothing physical passes', () => {
    expect(check({
      entities: [ent('party', {abstract: true, dataSource: '', keys: [],
                               fields: [{name: 'id', type: 'String'}]})],
    })).toEqual([]);
  });

  describe('concrete leaves', () => {
    const party = ent('party', {abstract: true, dataSource: '', keys: [], fields: []});
    const person = ent('person');
    const employee = ent('employee', {extends: ['person']});
    const order = ent('order');
    // Each join reaches the target's key, `<name>_id`.
    const rel = (to: string) => ({
      name: `order_${to}`,
      source: {entity: 'order', columns: ['c']},
      destination: {entity: to, columns: [`${to}_id`]},
    });
    const metric = (m: Partial<Metric>): Metric =>
        ({name: 'm1', expression: 'COUNT(*)', ...m} as Metric);

    test('a relationship to an abstract entity is rejected', () => {
      expect(check({entities: [party, order], relationships: [rel('party')]})
                 .join('\n')).toContain("connects 'party', which is abstract");
    });
    test('a relationship to an extended entity is rejected', () => {
      expect(check({entities: [person, employee, order], relationships: [rel('person')]})
                 .join('\n'))
          .toContain("connects 'person', which is extended by another entity");
    });
    test('a relationship between leaves passes', () => {
      expect(check({entities: [person, employee, order], relationships: [rel('employee')]}))
          .toEqual([]);
    });
    test('a metric anchored to an abstract or extended entity is rejected', () => {
      expect(check({entities: [party, order], metrics: [metric({authoredEntity: 'party', entity: 'party'})]})
                 .join('\n')).toContain("belongs to 'party', which is abstract");
      expect(check({entities: [person, employee], metrics: [metric({authoredEntity: 'person', entity: 'person'})]})
                 .join('\n'))
          .toContain("belongs to 'person', which is extended by another entity");
    });
    test('a metric whose inferred entity is abstract is rejected', () => {
      expect(check({entities: [party, order], metrics: [metric({entity: 'party'})]})
                 .join('\n')).toContain("belongs to 'party', which is abstract");
    });
    // It is rejected as a relationship to itself, and once as a non-leaf.
    test('a relationship from an extended entity to itself is reported once as a non-leaf', () => {
      expect(check({
        entities: [person, employee],
        relationships: [{
          name: 'knows',
          source: {entity: 'person', columns: ['c']},
          destination: {entity: 'person', columns: ['person_id']},
        }],
      })).toEqual([
        "relationship 'knows' in model 'm' (doc) connects 'person', which is " +
            'extended by another entity; a relationship may connect only ' +
            'concrete leaf entities.',
        "relationship 'knows' in model 'm' (doc) runs from 'person' to " +
            'itself; a relationship joins two different entities.',
      ]);
    });
    test('the rules also run on a pruned model, as a graph push validates', () => {
      const errors = validatePushRequirements(
          [loaded(model({entities: [person, employee, order],
                         relationships: [rel('person')]}))],
          {fieldsPruned: true});
      expect(errors.join('\n'))
          .toContain("connects 'person', which is extended by another entity");
    });
    test('a metric whose inferred entity is extended is rejected', () => {
      expect(check({entities: [person, employee], metrics: [metric({entity: 'person'})]})
                 .join('\n'))
          .toContain("belongs to 'person', which is extended by another entity");
    });
    test('a metric on a leaf passes, anchored or inferred', () => {
      expect(check({entities: [person, employee], metrics: [metric({authoredEntity: 'employee', entity: 'employee'})]}))
          .toEqual([]);
      expect(check({
               entities: [person, employee],
               metrics: [metric({
                 entity: 'employee',
                 expression: 'COUNT(employee.employee_id)',
               })],
             }))
          .toEqual([]);
    });
  });
});


// A relationship is many-to-one or one-to-one only when its to_columns cover a
// key, so a join that covers no key is rejected on every push, a catalog-only
// one included.
describe('a relationship joins on a key of its target', () => {
  const ent = (name: string, over: Partial<Entity> = {}): Entity => ({
    name, dataSource: `p.d.${name}`, keys: ['id'], fields: [], ...over,
  });
  const join = (to: string[]) => ({
    name: 'placed_by',
    source: {entity: 'orders', columns: to.map(c => `o_${c.replace(/`/g, '')}`)},
    destination: {entity: 'customer', columns: to},
  });
  const check = (customer: Entity, to: string[]) => validatePushRequirements(
      [loaded(model({entities: [ent('orders'), customer], relationships: [join(to)]}))]);

  test('a join on a key, a unique key or a superset of one passes', () => {
    expect(check(ent('customer'), ['id'])).toEqual([]);
    expect(check(ent('customer', {uniqueKeys: [['email']]}), ['email'])).toEqual([]);
    expect(check(ent('customer'), ['id', 'tenant'])).toEqual([]);
  });

  test('column names compare ignoring case and backticks', () => {
    expect(check(ent('customer'), ['ID'])).toEqual([]);
    expect(check(ent('customer'), ['`id`'])).toEqual([]);
  });

  test('a field named like a key does not change the column the key names', () => {
    // The generators emit `KEY(id)` whatever field `id` reads, so only a join
    // on `id` covers the key.
    const named = ent('customer', {
      fields: [{name: 'id', expression: 'cust_id -- the customer number'}],
    });
    expect(check(named, ['id'])).toEqual([]);
    expect(check(named, ['ID'])).toEqual([]);
    expect(check(named, ['cust_id']).join('\n'))
        .toContain("cover no primary or unique key of 'customer'");
  });

  test('a join that covers no key is rejected', () => {
    expect(check(ent('customer'), ['name']).join('\n')).toContain(
        "relationship 'placed_by' in model 'm' (doc): its to_columns [\"name\"] " +
        "cover no primary or unique key of 'customer'");
  });

  test('a target with no key cannot be joined to', () => {
    expect(check(ent('customer', {keys: []}), ['id']).join('\n'))
        .toContain("cover no primary or unique key of 'customer'");
  });

  test('a relationship with no join columns yet is not checked', () => {
    expect(check(ent('customer', {keys: []}), [])).toEqual([]);
  });
});


describe('a relationship key check compares names as written', () => {
  const join = (toEntity: string, to: string[]) => ({
    name: 'placed_by',
    source: {entity: 'orders', columns: to.map(c => `o_${c.replace(/`/g, '')}`)},
    destination: {entity: toEntity, columns: to},
  });
  const orders: Entity = {name: 'orders', dataSource: 'p.d.o', keys: ['o_id'], fields: []};
  const check = (entities: Entity[], rel: any) => validatePushRequirements(
      [loaded(model({entities: [orders, ...entities], relationships: [rel]}))]);

  // A key is a physical column, so `customerId` is not read as the column
  // the field of that name is bound to.
  test('a key that names a field does not cover a join on that field\'s column', () => {
    const customer: Entity = {
      name: 'customer', dataSource: 'p.d.c', keys: ['customerId'],
      fields: [{name: 'customerId', expression: 'customer_id'}],
    };
    expect(check([customer], join('customer', ['customer_id'])).join('\n'))
        .toContain("cover no primary or unique key of 'customer'");
    expect(check([customer], join('customer', ['customerId']))).toEqual([]);
  });

  test('a key that names an unbound field is judged as the column it names', () => {
    const customer: Entity = {
      name: 'customer', dataSource: 'p.d.c', keys: ['customerId'],
      fields: [{name: 'customerId'}],
    };
    expect(check([customer], join('customer', ['customer_id'])).join('\n'))
        .toContain("cover no primary or unique key of 'customer'");
  });

  test('a relationship through a junction table is not checked', () => {
    const customer: Entity = {name: 'customer', dataSource: 'p.d.c', keys: ['id'], fields: []};
    expect(check([customer], {...join('customer', ['not_a_key']),
                              association: {dataSource: 'p.d.oc'}}))
        .toEqual([]);
  });

  test('a relationship to an abstract entity gets only the concrete-leaf error', () => {
    const party: Entity = {name: 'party', abstract: true, dataSource: '', keys: [], fields: []};
    const errors = check([party], join('party', ['id'])).join('\n');
    expect(errors).toContain("connects 'party', which is abstract");
    expect(errors).not.toContain('cover no primary or unique key');
  });

  test('skips the key-coverage check only when its own inputs are invalid', () => {
    const customer: Entity = {name: 'customer', dataSource: 'p.d.c', keys: ['id'], fields: []};
    // Invalid to_columns entry -> skipped.
    const badToCol = check([customer], {
      name: 'placed_by',
      source: {entity: 'orders', columns: ['o_id']},
      destination: {entity: 'customer', columns: ['LOWER(id)']},
    });
    expect(badToCol.length).toBe(1);
    expect(badToCol[0]).toContain('to_columns');
    expect(badToCol[0]).not.toContain('cover no primary or unique key');

    // Undeclared to entity -> skipped.
    const badToEntity = check([customer], join('ghost', ['id']));
    expect(badToEntity.length).toBe(1);
    expect(badToEntity[0]).toContain("'to' entity 'ghost' is not defined in the model");

    // Invalid target primary_key or unique_keys -> skipped.
    const badPk = check(
        [{...customer, keys: ['LOWER(id)']}],
        join('customer', ['not_a_key']));
    expect(badPk.length).toBe(1);
    expect(badPk[0]).toContain('primary_key');
    expect(badPk[0]).not.toContain('cover no primary or unique key');

    const badUk = check(
        [{...customer, uniqueKeys: [['LOWER(email)']]}],
        join('customer', ['not_a_key']));
    expect(badUk.length).toBe(1);
    expect(badUk[0]).toContain('unique_keys');
    expect(badUk[0]).not.toContain('cover no primary or unique key');
  });

  test('reports an uncovered to_columns alongside an unrelated from-side or length error', () => {
    const customer: Entity = {name: 'customer', dataSource: 'p.d.c', keys: ['id'], fields: []};
    const badFromCol = check([customer], {
      name: 'placed_by',
      source: {entity: 'orders', columns: ['LOWER(o_id)']},
      destination: {entity: 'customer', columns: ['not_a_key']},
    });
    expect(badFromCol.length).toBe(2);
    expect(badFromCol.join('\n')).toContain('from_columns');
    expect(badFromCol.join('\n')).toContain("cover no primary or unique key of 'customer'");

    const badFromEntity = check([customer], {
      name: 'placed_by',
      source: {entity: 'ghost', columns: ['o_id']},
      destination: {entity: 'customer', columns: ['not_a_key']},
    });
    expect(badFromEntity.length).toBe(2);
    expect(badFromEntity.join('\n')).toContain("'from' entity 'ghost' is not defined in the model");
    expect(badFromEntity.join('\n')).toContain("cover no primary or unique key of 'customer'");

    const badLength = check([customer], {
      name: 'placed_by',
      source: {entity: 'orders', columns: ['o_id', 'extra']},
      destination: {entity: 'customer', columns: ['not_a_key']},
    });
    expect(badLength.length).toBe(2);
    expect(badLength.join('\n')).toContain('from_columns (2) and to_columns (1)');
    expect(badLength.join('\n')).toContain("cover no primary or unique key of 'customer'");
  });
});


describe('physical column names and relationship shape', () => {
  const validColumns = ['o_id', '`order date`'];
  // Rejected values that could be a column name written without backticks.
  // Their error suggests backticks as a condition, because only a parser could
  // tell a value made of words, such as `a AND b`, from a column name.
  const hintedColumns = [
    'order date',
    'order-date',
    'a-',
    'margin%',
    'growth %',
    'R&D cost',
    'a AND b',
    'o_id IS NULL',
    'CASE WHEN a THEN b END',
  ];
  // Rejected values whose error gives no backtick hint.
  const unhintedColumns = [
    '',
    '   ',
    ' o_id',
    'o_id ',
    'customers.id',
    'LOWER(cust_id)',
    'a || b',
    'a,b',
    'a`b',
    '``',
    'amount - discount',
    'x % 2',
    'cost + tax',
    'a = b',
    '-1',
    'a\t-\tb',
    'price $ usd',
    'amount €',
    '"order date"',
    '[order date]',
  ];
  const invalidColumns = [...hintedColumns, ...unhintedColumns];
  const backtickHint =
      'if it names a column with spaces or special characters, wrap it in backticks, for example `order date`';
  // The whole error for a rejected column, with or without the backtick hint.
  const columnError =
      (owner: string, slot: string, value: string, hint: boolean) =>
          `${owner} in model 'm' (doc): ${slot} column '${value}' is not a ` +
          'physical column name; keys and join columns must name physical ' +
          'table columns, not expressions or field references' +
          (hint ? ` (${backtickHint})` : '') + '.';

  const baseOrders = (over: Partial<Entity> = {}): Entity => ({
    name: 'orders',
    dataSource: 'p.d.orders',
    keys: ['o_id'],
    fields: [],
    ...over,
  });
  const baseCustomers = (over: Partial<Entity> = {}): Entity => ({
    name: 'customers',
    dataSource: 'p.d.customers',
    keys: ['c_id'],
    fields: [],
    ...over,
  });

  test('accepts bare and backtick-quoted physical column names in all four slots', () => {
    for (const col of validColumns) {
      const m = model({
        entities: [
          baseOrders({keys: [col], uniqueKeys: [[col]]}),
          baseCustomers({keys: [col]}),
        ],
        relationships: [{
          name: 'placed_by',
          source: {entity: 'orders', columns: [col]},
          destination: {entity: 'customers', columns: [col]},
        }],
      });
      expect(validatePushRequirements([loaded(m)]))
          .toEqual([]);
    }
  });

  test('rejects expressions, qualified names, unquoted whitespace, and empty strings in all four slots, printing the backtick hint only for a value that could be a column name', () => {
    for (const bad of invalidColumns) {
      const expectHint = hintedColumns.includes(bad);

      const pkErrs = validatePushRequirements(
          [loaded(model({entities: [baseOrders({keys: [bad]})]}))]);
      expect(pkErrs).toEqual(
          [columnError("entity 'orders'", 'primary_key', bad, expectHint)]);

      const ukErrs = validatePushRequirements(
          [loaded(model({entities: [baseOrders({uniqueKeys: [[bad]]})]}))]);
      expect(ukErrs).toEqual(
          [columnError("entity 'orders'", 'unique_keys', bad, expectHint)]);

      const fromErrs = validatePushRequirements(
          [loaded(model({
            entities: [baseOrders(), baseCustomers()],
            relationships: [{
              name: 'placed_by',
              source: {entity: 'orders', columns: [bad]},
              destination: {entity: 'customers', columns: ['c_id']},
            }],
          }))]);
      expect(fromErrs).toEqual([columnError(
          "relationship 'placed_by'", 'from_columns', bad, expectHint)]);

      const toErrs = validatePushRequirements(
          [loaded(model({
            entities: [baseOrders(), baseCustomers()],
            relationships: [{
              name: 'placed_by',
              source: {entity: 'orders', columns: ['o_id']},
              destination: {entity: 'customers', columns: [bad]},
            }],
          }))]);
      expect(toErrs).toEqual([columnError(
          "relationship 'placed_by'", 'to_columns', bad, expectHint)]);
    }
  });

  test('gives no backtick hint for an operator at the start of a value or next to whitespace', () => {
    const operators =
        ['+', '-', '*', '/', '%', '=', '<', '>', '!', '|', '&', '^', '~'];
    for (const op of operators) {
      for (const bad of [`${op}a`, `a ${op}b`, `a${op} b`]) {
        const errs = validatePushRequirements(
            [loaded(model({entities: [baseOrders({keys: [bad]})]}))]);
        expect(errs).toEqual(
            [columnError("entity 'orders'", 'primary_key', bad, false)]);
      }
    }
  });

  test('gives the backtick hint for a rejected a<c>b or a<c>b c only when BigQuery allows c in a column name', () => {
    // The ASCII characters BigQuery allows in a column name.
    const allowedAscii = /^[A-Za-z0-9_ &%=+:'<>#|-]$/;
    // Whitespace, then a letter, a numeric character, connector punctuation,
    // a dash and a mark, each allowed.
    const allowedOther =
        ['\t', '\n', '\u00a0', '\u3000', 'ñ', '\u0663', '\u203f', '\u2013',
         '\u0301'];
    // A currency sign, a symbol, an emoji and a zero-width space, each
    // forbidden.
    const forbiddenOther = ['€', '°', '\u{1F600}', '\u200b'];
    const chars = [...Array(95)]
                      .map((_, i) => String.fromCharCode(32 + i))
                      .concat(allowedOther, forbiddenOther);
    for (const c of chars) {
      const hint = allowedAscii.test(c) || allowedOther.includes(c);
      // isColumnName rejects a<c>b only for some c. It rejects every a<c>b c,
      // because of the space.
      for (const bad of [`a${c}b`, `a${c}b c`]) {
        if (isColumnName(bad)) continue;
        const errs = validatePushRequirements(
            [loaded(model({entities: [baseOrders({keys: [bad]})]}))]);
        expect(errs).toEqual(
            [columnError("entity 'orders'", 'primary_key', bad, hint)]);
      }
    }
  });

  test('rejects a model loaded from YAML whose key is not a physical column name', () => {
    const [parsed] = loadModels(`version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    datasets:
      - name: orders
        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders
        primary_key: ["LOWER(o_id)"]
        fields:
          - { name: o_id, expression: o_id }
`).models;
    const errs =
        validatePushRequirements([loaded(parsed)]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain(
        "entity 'orders' in model 'sales' (doc): primary_key column 'LOWER(o_id)' is not a physical column name");
    expect(errs[0]).not.toContain('backticks');
  });

  test('an abstract entity with an invalid key gets only the abstract-entity key error', () => {
    const party: Entity = {
      name: 'party',
      abstract: true,
      dataSource: '',
      keys: ['LOWER(id)'],
      fields: [],
    };
    const errs = validatePushRequirements(
        [loaded(model({entities: [party]}))]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('cannot declare a primary key or unique keys');
  });

  test('a relationship to an abstract entity whose join column is an expression reports both the abstract endpoint and the bad join column', () => {
    const party: Entity = {
      name: 'party',
      abstract: true,
      dataSource: '',
      keys: [],
      fields: [],
    };
    const errs = validatePushRequirements(
        [loaded(model({
          entities: [baseOrders(), party],
          relationships: [{
            name: 'placed_by',
            source: {entity: 'orders', columns: ['o_id']},
            destination: {entity: 'party', columns: ['LOWER(id)']},
          }],
        }))]);
    expect(errs).toHaveLength(2);
    expect(errs.join('\n')).toContain("connects 'party', which is abstract");
    expect(errs.join('\n')).toContain(
        "to_columns column 'LOWER(id)' is not a physical column name");
    expect(errs.join('\n')).not.toContain('cover no primary or unique key');
  });

  test('skips direct-FK join column and length checks for an association relationship', () => {
    const errs = validatePushRequirements(
        [loaded(model({
          entities: [baseOrders(), baseCustomers()],
          relationships: [{
            name: 'orders_customers',
            source: {entity: 'orders', columns: ['LOWER(o_id)', 'extra']},
            destination: {entity: 'customers', columns: ['c_id']},
            association: {
              dataSource: 'p.d.order_customers',
              keys: ['id'],
              sourceColumns: ['o_id'],
              destinationColumns: ['c_id'],
            },
          }],
        }))]);
    expect(errs).toEqual([]);
  });

  test('checks the endpoints of an association relationship', () => {
    const errs = validatePushRequirements(
        [loaded(model({
          entities: [baseOrders()],
          relationships: [{
            name: 'orders_ghosts',
            source: {entity: 'orders', columns: []},
            destination: {entity: 'ghost', columns: []},
            association: {
              dataSource: 'p.d.orders_ghosts',
              keys: ['id'],
              sourceColumns: ['o_id'],
              destinationColumns: ['g_id'],
            },
          }],
        }))]);
    expect(errs).toEqual([
      "relationship 'orders_ghosts' in model 'm' (doc): 'to' entity 'ghost' is not defined in the model.",
    ]);
  });

  test('rejects an undeclared from or to entity on a relationship, and relationships both ways between two entities', () => {
    const badFrom = validatePushRequirements(
        [loaded(model({
          entities: [baseCustomers()],
          relationships: [{
            name: 'placed_by',
            source: {entity: 'ghost', columns: ['c_id']},
            destination: {entity: 'customers', columns: ['c_id']},
          }],
        }))]);
    expect(badFrom.length).toBe(1);
    expect(badFrom[0]).toContain("relationship 'placed_by'");
    expect(badFrom[0]).toContain("'from' entity 'ghost' is not defined in the model.");

    const badTo = validatePushRequirements(
        [loaded(model({
          entities: [baseOrders()],
          relationships: [{
            name: 'placed_by',
            source: {entity: 'orders', columns: ['o_id']},
            destination: {entity: 'ghost', columns: ['o_id']},
          }],
        }))]);
    expect(badTo.length).toBe(1);
    expect(badTo[0]).toContain("relationship 'placed_by'");
    expect(badTo[0]).toContain("'to' entity 'ghost' is not defined in the model.");

    const bothWays = validatePushRequirements(
        [loaded(model({
          entities: [baseOrders(), baseCustomers()],
          relationships: [
            {
              name: 'placed_by',
              source: {entity: 'orders', columns: ['c_id']},
              destination: {entity: 'customers', columns: ['c_id']},
            },
            {
              name: 'placed',
              source: {entity: 'customers', columns: ['o_id']},
              destination: {entity: 'orders', columns: ['o_id']},
            },
          ],
        }))]);
    expect(bothWays).toEqual([
      "relationship 'placed' in model 'm' (doc) runs from 'customers' to " +
          "'orders', and relationship 'placed_by' runs the other way; keep " +
          'the relationships between two entities in one direction.',
    ]);
  });

  test('rejects mismatched from_columns and to_columns lengths on KC-only and graph pushes, calls one bound side a half-bound join, and accepts both empty on KC-only push', () => {
    const fromLonger = validatePushRequirements(
        [loaded(model({
          entities: [baseOrders(), baseCustomers()],
          relationships: [{
            name: 'placed_by',
            source: {entity: 'orders', columns: ['o_id', 'extra_id']},
            destination: {entity: 'customers', columns: ['c_id']},
          }],
        }))]);
    expect(fromLonger).toEqual([
      "relationship 'placed_by' in model 'm' (doc): from_columns (2) and to_columns (1) have different lengths; the join keys are mismatched.",
    ]);

    const toLonger = validatePushRequirements(
        [loaded(model({
          entities: [baseOrders(), baseCustomers()],
          relationships: [{
            name: 'placed_by',
            source: {entity: 'orders', columns: ['o_id']},
            destination: {entity: 'customers', columns: ['c_id', 'extra_id']},
          }],
        }))]);
    expect(toLonger).toEqual([
      "relationship 'placed_by' in model 'm' (doc): from_columns (1) and to_columns (2) have different lengths; the join keys are mismatched.",
    ]);

    const oneSideEmptyOnGraph = validatePushRequirements([loaded(model(
        {
          entities: [baseOrders(), baseCustomers()],
          relationships: [{
            name: 'placed_by',
            source: {entity: 'orders', columns: ['o_id']},
            destination: {entity: 'customers', columns: []},
          }],
        },
        [BQ_TARGET]))]);
    const halfBound =
        "relationship 'placed_by' in model 'm' (doc): from_columns and to_columns must be given together (both bind the edge) or both omitted (a logical edge); one without the other is a half-bound join.";
    expect(oneSideEmptyOnGraph).toEqual([halfBound]);

    const onlyToBound = validatePushRequirements(
        [loaded(model({
          entities: [baseOrders(), baseCustomers()],
          relationships: [{
            name: 'placed_by',
            source: {entity: 'orders', columns: []},
            destination: {entity: 'customers', columns: ['c_id']},
          }],
        }))]);
    expect(onlyToBound).toEqual([halfBound]);

    const unbound = validatePushRequirements(
        [loaded(model({
          entities: [baseOrders(), baseCustomers()],
          relationships: [{
            name: 'placed_by',
            source: {entity: 'orders', columns: []},
            destination: {entity: 'customers', columns: []},
          }],
        }))]);
    expect(unbound).toEqual([]);
  });
});


describe('field and metric expression references', () => {
  const orders = (): Entity => ({
    name: 'orders',
    dataSource: 'p.d.orders',
    keys: ['id'],
    fields: [
      {name: 'id', expression: 'o_id'},
      {name: 'net_amount', expression: 'o_net_amount'},
      {name: 'order_date', expression: 'o_order_date'},
      {name: 'end_date', expression: 'o_end_date'},
      {name: 'url', expression: 'o_url'},
      {name: 'status', expression: 'o_status'},
      {name: 'items', expression: 'o_items'},
      {name: 'shipping_address', expression: 'o_shipping_address'},
    ],
  });
  const customer = (): Entity => ({
    name: 'customer',
    dataSource: 'p.d.customer',
    keys: ['id'],
    fields: [
      {name: 'id', expression: 'c_id'},
      {name: 'amount', expression: 'c_amount'},
    ],
  });

  describe('metrics', () => {
    test('rejects an unanchored metric that reaches no entity or multiple entities on BigQuery, Spanner, and pruned pushes', () => {
      const noEntity = (target: string) => model(
          {
            entities: [orders()],
            metrics: [{name: 'cnt', expression: 'COUNT(*)'}],
          },
          [target]);
      expect(validatePushRequirements([loaded(noEntity(BQ_TARGET))]).join('\n'))
          .toContain("metric 'cnt'");
      expect(validatePushRequirements([loaded(noEntity(SPANNER_TARGET))])
                 .join('\n'))
          .toContain("metric 'cnt'");
      expect(validatePushRequirements(
                 [loaded(noEntity(SPANNER_TARGET))], {fieldsPruned: true})
                 .join('\n'))
          .toContain("metric 'cnt'");

      const multiEntity = model({
        entities: [orders(), customer()],
        metrics: [{
          name: 'ratio',
          expression: 'SUM(orders.net_amount) / COUNT(customer.id)',
        }],
      });
      expect(validatePushRequirements(
                 [loaded(multiEntity)], {fieldsPruned: true})
                 .join('\n'))
          .toContain('reaches multiple entities (orders, customer)');

      const vanillaNoEntity = model({
        version: '0.2.0.dev0',
        entities: [orders()],
        metrics: [{name: 'cnt', expression: 'COUNT(*)'}],
      });
      expect(validatePushRequirements(
                 [loaded(vanillaNoEntity)])
                 .join('\n'))
          .toContain("set 'entity' in a GOOGLE custom_extensions block on the metric");
    });

    // An anchor does not make up for missing SQL: the graph would drop the
    // metric.
    test('rejects a metric with no SQL, with or without an entity anchor', () => {
      const message = (name: string) =>
          `metric '${name}' in model 'm' (doc) has no SQL in 'expression'; ` +
          "write the metric's SQL.";
      const m = model({
        entities: [orders()],
        metrics: [
          {name: 'empty_metric'},
          {name: 'anchored', entity: 'orders', authoredEntity: 'orders'},
          {name: 'blank', expression: '  '},
          {name: 'comment', expression: '-- todo', entity: 'orders'},
        ],
      });
      expect(validatePushRequirements([loaded(m)]))
          .toEqual([
            message('empty_metric'),
            message('anchored'),
            message('blank'),
            message('comment'),
          ]);
    });

    // A model built in memory skips the loader, which rejects these.
    test('rejects a metric with no SQL in one of its texts in a model built in memory, as the loader does', () => {
      const m = model({
        entities: [orders()],
        metrics: [
          {
            name: 'vendor',
            expression: 'SUM(orders.net_amount)',
            dialects: [
              {dialect: 'BIGQUERY', expression: 'SUM(orders.net_amount)'},
              {dialect: 'POSTGRES', expression: '-- todo'},
            ],
          },
          // The graph generator writes `expression`, which here is not the
          // text of the dialect entry.
          {
            name: 'stale',
            expression: '',
            entity: 'orders',
            dialects: [
              {dialect: 'POSTGRES', expression: 'SUM(orders.net_amount)'},
            ],
          },
        ],
      });
      const expected = [
        "metric 'vendor' in model 'm' (doc): the POSTGRES entry of " +
            "'expression' is only a comment; write the metric's SQL.",
        "metric 'stale' in model 'm' (doc): 'expression' is blank; write " +
            "the metric's SQL.",
      ];
      expect(validatePushRequirements([loaded(m)]))
          .toEqual(expected);
      // The BigQuery metric check reports each metric once.
      const graph = model(m, [BQ_TARGET]);
      expect(validatePushRequirements([loaded(graph)], {fieldsPruned: true})
                 .filter(e => e.startsWith('metric ')))
          .toEqual(expected);
    });

    test('rejects a metric whose anchor names an undeclared entity before and after pruning', () => {
      const m = model({
        entities: [orders()],
        metrics: [{
          name: 'cnt',
          expression: 'SUM(ghost.amount)',
          entity: 'ghost',
          authoredEntity: 'ghost',
        }],
      });
      expect(validatePushRequirements([loaded(m)]))
          .toEqual([
            "metric 'cnt' in model 'm' (doc): entity 'ghost' is not declared in the model.",
          ]);
      expect(validatePushRequirements(
                 [loaded(m)], {fieldsPruned: true}))
          .toEqual([
            "metric 'cnt' in model 'm' (doc): entity 'ghost' is not declared in the model.",
          ]);
      expect(validateExpressionReferences([loaded(m)], false).join('\n'))
          .toContain("entity 'ghost' is not declared");
    });

    test('rejects a metric whose anchor is contradicted by its expression, including subtype vs supertype', () => {
      const wrongAnchor = model({
        entities: [orders(), customer()],
        metrics: [{
          name: 'rev',
          expression: 'SUM(orders.net_amount)',
          entity: 'customer',
          authoredEntity: 'customer',
        }],
      });
      expect(validatePushRequirements(
                 [loaded(wrongAnchor)])
                 .join('\n'))
          .toContain("anchored to entity 'customer', but its expression only references 'orders'");

      // `vip` extends `customer`, so a metric anchored to `vip` that reads
      // `customer.amount` contradicts its anchor; it must read `vip.amount`.
      const baseCustomer: Entity = {
        name: 'customer',
        abstract: true,
        dataSource: '',
        keys: [],
        fields: [{name: 'amount', type: 'Decimal'}],
      };
      const vip: Entity = {
        name: 'vip',
        extends: ['customer'],
        dataSource: 'p.d.vip',
        keys: ['id'],
        fields: [
          {name: 'id', expression: 'v_id'},
          {name: 'amount', expression: 'v_amount'},
        ],
      };
      const subtypeMismatch = model({
        entities: [baseCustomer, vip],
        metrics: [{
          name: 'vip_spend',
          expression: 'SUM(customer.amount)',
          entity: 'vip',
          authoredEntity: 'vip',
        }],
      });
      expect(validatePushRequirements(
                 [loaded(subtypeMismatch)])
                 .join('\n'))
          .toContain("anchored to entity 'vip', but its expression only references 'customer'");

      const subtypeMatches = model({
        entities: [baseCustomer, vip],
        metrics: [{
          name: 'vip_spend',
          expression: 'SUM(vip.amount)',
          entity: 'vip',
          authoredEntity: 'vip',
        }],
      });
      expect(validatePushRequirements(
                 [loaded(subtypeMatches)]))
          .toEqual([]);
    });

    test('rejects a metric referencing a field that does not exist on the entity', () => {
      const m = model({
        entities: [orders()],
        metrics: [{
          name: 'bad_rev',
          expression: 'SUM(orders.o_totalprice)',
          entity: 'orders',
        }],
      });
      expect(validatePushRequirements([loaded(m)])
                 .join('\n'))
          .toContain("entity 'orders' has no field 'o_totalprice'");
    });

    test('accepts an anchored metric referencing one entity and real fields, including struct paths', () => {
      const m = model({
        entities: [orders(), customer()],
        metrics: [
          {
            name: 'net_rev',
            expression: 'SUM(orders.net_amount)',
            entity: 'orders',
            authoredEntity: 'orders',
          },
          {
            name: 'cities',
            expression: 'COUNT(DISTINCT orders.shipping_address.city)',
            entity: 'orders',
          },
        ],
      });
      expect(validatePushRequirements([loaded(m)]))
          .toEqual([]);
    });

    test('checks BigQuery generator metric placement rules only when pushing to a BigQuery graph', () => {
      const bqPush = (entities: Entity[], metric: Metric, version?: SemanticModel['version']) =>
          validatePushRequirements(
              [loaded(model({version, entities, metrics: [metric]}, [BQ_TARGET]))])
              .join('\n');

      // A comment naming a second entity passes on every push, because the generator reads the
      // expression without its comments.
      const commentMetric: Metric = {
        name: 'rev', expression: 'SUM(orders.net_amount) -- customer.id', entity: 'orders',
      };
      expect(bqPush([orders(), customer()], commentMetric)).toBe('');
      expect(validatePushRequirements(
                 [loaded(model({entities: [orders(), customer()], metrics: [commentMetric]}, [BQ_TARGET]))]))
          .toEqual([]);
      expect(validatePushRequirements(
                 [loaded(model({entities: [orders(), customer()], metrics: [commentMetric]}, [SPANNER_TARGET]))]))
          .toEqual([]);

      const netEntity: Entity = {
        name: 'NET', dataSource: 'p.d.net', keys: ['id'], fields: [{name: 'id', expression: 'n_id'}],
      };
      // A function namespace that matches an entity name reads no entity, as the SQL parser reads
      // it, so the generator places the metric on orders and the push passes.
      expect(bqPush([orders(), netEntity], {
        name: 'hosts', expression: 'COUNT(DISTINCT NET.HOST(orders.url))', entity: 'orders',
      })).toBe('');

      // An anchor settles SQL that reads two entities for the reference rules, but a BigQuery measure
      // belongs to one entity's table, so only a BigQuery graph push rejects it.
      const twoEntities: Metric = {
        name: 'mixed', expression: 'SUM(orders.net_amount + customer.amount)',
        entity: 'orders', authoredEntity: 'orders',
      };
      expect(bqPush([orders(), customer()], twoEntities)).toContain(
          "metric 'mixed' in model 'm' (doc) targets a BigQuery graph and its BigQuery SQL reads " +
          "several entities (orders, customer); a BigQuery measure belongs to one entity's node " +
          'table, so scope its expression to one entity.');
      expect(validatePushRequirements(
                 [loaded(model({entities: [orders(), customer()], metrics: [twoEntities]}, [SPANNER_TARGET]))]))
          .toEqual([]);

      // Vanilla `COUNT(*)` anchored via a GOOGLE custom_extensions block loads with `metric.entity` set
      // from the block, so a KC-only push and a BigQuery graph push both accept it.
      const vanillaDoc = loadModels(`version: "0.2.0.dev0"
semantic_model:
  - name: sales
    custom_extensions:
      - vendor_name: GOOGLE
        data: '${JSON.stringify({deployments: [{name: 'bq', target: BQ_TARGET}]})}'
    datasets:
      - name: orders
        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders
        primary_key: [id]
        fields:
          - name: id
            expression:
              dialects: [{ dialect: BIGQUERY, expression: o_id }]
    metrics:
      - name: cnt
        custom_extensions:
          - vendor_name: GOOGLE
            data: '{"entity": "orders"}'
        expression:
          dialects: [{ dialect: BIGQUERY, expression: "COUNT(*)" }]
`).models[0];
      expect(vanillaDoc.metrics[0].entity).toBe('orders');
      expect(validatePushRequirements([loaded(vanillaDoc)])).toEqual([]);

      // Metric with only a non-BigQuery dialect expression is rejected, and
      // the error names kcmd import --transpile when it translates the text.
      const pg = (expression: string) => bqPush([orders()], {
        name: 'pg_rev',
        importedExpression: expression,
        importedDialect: 'POSTGRES',
        entity: 'orders',
        authoredEntity: 'orders',
        dialects: [{dialect: 'POSTGRES', expression}],
      });
      const onlyPg = "targets a BigQuery graph with only a 'POSTGRES' " +
          "expression; supply a 'BIGQUERY' or 'ANSI_SQL' expression";
      expect(pg('SUM("orders"."net_amount")')).toContain(
          `${onlyPg}, or add one with 'kcmd import <file> --input ` +
          "first-party --flavor <ossie|google> --transpile'.");
      expect(pg(`MAX(TO_CHAR("orders"."net_amount", '9'))`))
          .toContain(`${onlyPg}.`);
    });

    test('the BigQuery placement error offers the anchor the flavor writes', () => {
      // The generator reads no entity from this expression, so only an anchor
      // places the metric.
      const vanilla = (metricBlock: string) => loadModels(`version: "0.2.0.dev0"
semantic_model:
  - name: sales
    custom_extensions:
      - vendor_name: GOOGLE
        data: '${JSON.stringify({deployments: [{name: 'g', target: BQ_TARGET}]})}'
    datasets:
      - name: orders
        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders
        primary_key: [id]
        fields:
          - name: id
            expression:
              dialects: [{ dialect: BIGQUERY, expression: o_id }]
    metrics:
      - name: n
        expression:
          dialects: [{ dialect: BIGQUERY, expression: "COUNT(o.id) FROM orders o" }]
${metricBlock}`).models[0];
      expect(validatePushRequirements([loaded(vanilla(''))])).toContain(
          "metric 'n' in model 'sales' (doc) targets a BigQuery graph but does not resolve to a " +
          'single entity; the BigQuery generator places a measure on the entity its BigQuery SQL ' +
          "reads, or on 'entity' in a GOOGLE custom_extensions block on the metric.");
      // The block anchor the error offers places the metric.
      expect(validatePushRequirements([loaded(vanilla(`        custom_extensions:
          - vendor_name: GOOGLE
            data: '{"entity": "orders"}'
`))])).toEqual([]);
    });
  });

  describe('unqualified fields in metrics', () => {
    test('rejects an unqualified column in an anchored metric whether or not a field of that name exists', () => {
      for (const col of ['net_amount', 'raw_col']) {
        const m = model({
          entities: [orders()],
          metrics: [{
            name: 'net_revenue',
            expression: `SUM(${col})`,
            entity: 'orders',
            authoredEntity: 'orders',
          }],
        });
        const errs =
            validatePushRequirements([loaded(m)]);
        expect(errs).toEqual([
          `metric 'net_revenue' in model 'm' (doc): '${col}' must be written ` +
          `as 'entity.field'; a metric reads fields, never columns.`,
        ]);
      }
    });

    // [the metric's name, its expression, the message, its entity when not
    // orders]. Metric 'revenue' is anchored on orders. 'amount' is a metric on
    // orders and a field of customer.
    const at = (name: string) => `metric '${name}' in model 'm' (doc)`;
    test.each<[string, string, string | undefined, string?]>([
      ['avg_order', 'revenue / COUNT(*)', `${at('avg_order')}: 'revenue' is a metric, and a ` +
       'metric over other metrics is not supported in this version; write the expression ' +
       "of 'revenue' in its place."],
      ['avg_order', 'orders.revenue / COUNT(*)', `${at('avg_order')}: 'revenue' is a metric, ` +
       'and a metric over other metrics is not supported in this version; write the ' +
       "expression of 'revenue' in its place."],
      // A bare metric name reads that metric, even when another entity has a
      // field of that name, and reads a field of the metric's own entity.
      ['avg_order', 'SUM(amount) / COUNT(*)', `${at('avg_order')}: 'amount' is a metric, and a ` +
       'metric over other metrics is not supported in this version; write the expression ' +
       "of 'amount' in its place."],
      ['avg_cust', 'SUM(amount)', `${at('avg_cust')}: 'amount' must be written as ` +
       "'entity.field'; a metric reads fields, never columns.", 'customer'],
      // A metric that reads its own name reads a column or a missing field.
      ['total', 'SUM(total)', `${at('total')}: 'total' must be written as 'entity.field'; a ` +
       'metric reads fields, never columns.'],
      ['total', 'SUM(orders.total)', `${at('total')}: expression references 'orders.total', ` +
       "but entity 'orders' has no field 'total'; metric expressions must reference declared " +
       'fields, not physical columns.'],
      // A metric's name on another entity or under an unknown qualifier is
      // no read of that metric.
      ['avg_order', 'SUM(orders.net_amount) / SUM(customer.revenue)', `${at('avg_order')}: ` +
       "expression references 'customer.revenue', but entity 'customer' has no field " +
       "'revenue'; metric expressions must reference declared fields, not physical columns."],
      ['avg_order', 'ordrs.revenue / COUNT(*)', `${at('avg_order')}: 'ordrs.revenue' has ` +
       "qualifier 'ordrs', which is not a declared entity in model 'm'; write 'entity.field' " +
       'starting with a declared entity.'],
      ['avg_order', 'SUM(orders.net_amount) / COUNT(*)', undefined],
    ])('a metric %s over %s gets the message for what it reads', (name, expression, message, entity = 'orders') => {
      const m = model({
        entities: [orders(), customer()],
        metrics: [
          {name: 'revenue', expression: 'SUM(orders.net_amount)', entity: 'orders'},
          {name: 'amount', expression: 'SUM(orders.net_amount)', entity: 'orders'},
          {name, expression, entity, authoredEntity: entity},
        ],
      });
      expect(validatePushRequirements([loaded(m)])).toEqual(message ? [message] : []);
    });

    test('rejects a dotted reference whose qualifier is not a declared entity or differs in case without emitting Rule 1', () => {
      for (const [expr, qual] of [
             ['shipping_address.city', 'shipping_address'],
             ['ordres.net_amount', 'ordres'],
           ] as const) {
        const m = model({
          entities: [orders()],
          metrics: [{
            name: 'net_revenue',
            expression: `COUNT(${expr})`,
          }],
        });
        expect(validatePushRequirements([loaded(m)]))
            .toEqual([
              `metric 'net_revenue' in model 'm' (doc): '${expr}' has qualifier ` +
              `'${qual}', which is not a declared entity in model 'm'; write ` +
              `'entity.field' starting with a declared entity.`,
            ]);
      }

      // A field gets the same message.
      const caseMismatch = model({
        entities: [{
          ...orders(),
          fields: [...orders().fields, {name: 'net', expression: 'Orders.net_amount'}],
        }],
        metrics: [{
          name: 'net_revenue',
          expression: 'SUM(Orders.net_amount)',
        }],
      });
      expect(validatePushRequirements([loaded(caseMismatch)]))
          .toEqual(["field 'orders.net'", "metric 'net_revenue'"].map(
              what => `${what} in model 'm' (doc): 'Orders.net_amount' ` +
                  "uses qualifier 'Orders', which differs in case from " +
                  "entity 'orders'; entity names are case-sensitive."));
    });

    test('accepts function names, date parts, leading date units, NET.HOST namespaces, UNNEST/subquery/lambda bindings, and COUNT(*)', () => {
      const m = model({
        entities: [orders()],
        metrics: [
          {name: 'months', expression: 'COUNT(DISTINCT DATE_TRUNC(orders.order_date, month))', entity: 'orders'},
          {name: 'cnt_id', expression: 'count(orders.id)', entity: 'orders'},
          {name: 'hosts', expression: 'COUNT(DISTINCT NET.HOST(orders.url))', entity: 'orders'},
          {name: 'cnt_star', expression: 'COUNT(*)', entity: 'orders', authoredEntity: 'orders'},
          {
            name: 'days_diff',
            entity: 'orders',
            authoredEntity: 'orders',
            dialects: [
              {dialect: 'DATABRICKS', expression: 'AVG(DATEDIFF(DAY, orders.order_date, orders.end_date))'},
              {dialect: 'DATABRICKS', expression: 'AVG(DATE_DIFF(DAY, orders.order_date, orders.end_date))'},
              {dialect: 'DATABRICKS', expression: 'AVG(DATE_ADD(DAY, 1, orders.order_date))'},
              {dialect: 'MYSQL', expression: 'AVG(TIMESTAMPDIFF(DAY, orders.order_date, orders.end_date))'},
              {dialect: 'ANSI_SQL', expression: 'AVG(DATEADD(DAY, 1, orders.order_date))'},
            ],
          },
          {name: 'unnest_sum', expression: '(SELECT SUM(s.x) FROM UNNEST(orders.items) AS s)', entity: 'orders'},
          {name: 'unnest_unaliased', expression: '(SELECT SUM(x) FROM UNNEST(orders.items))', entity: 'orders'},
          {
            name: 'lambda_sum',
            entity: 'orders',
            authoredEntity: 'orders',
            dialects: [{dialect: 'DATABRICKS', expression: 'SUM(AGGREGATE(orders.items, 0, (acc, e) -> acc + e.price))'}],
          },
        ],
      });
      expect(validatePushRequirements([loaded(m)])).toEqual([]);

      // BigQuery `DATE_DIFF(end_col, start_col, DAY)` still checks its first argument as a column.
      const bqDateDiffBadCol = model({
        entities: [orders()],
        metrics: [{
          name: 'bad_diff',
          expression: 'AVG(DATE_DIFF(end_date, orders.order_date, DAY))',
          entity: 'orders',
          authoredEntity: 'orders',
        }],
      });
      expect(validatePushRequirements([loaded(bqDateDiffBadCol)]))
          .toEqual([
            "metric 'bad_diff' in model 'm' (doc): 'end_date' must be written as 'entity.field'; a metric reads fields, never columns.",
          ]);
    });

    test('reads short-form ANSI_SQL metrics in the sources dialect and falls back when sourceless', () => {
      const yamlFor = (sourceLine: string, extraMetric = '') => `version: 0.2.0.dev0/google
semantic_model:
  - name: sales
    datasets:
      - name: orders
${sourceLine}        primary_key: [id]
        fields:
          - { name: id, expression: o_id }
          - { name: order_date, expression: o_order_date }
          - { name: status, expression: o_status }
          - { name: net_amount, expression: o_net_amount }
    metrics:
      - { name: months, expression: "COUNT(DISTINCT DATE_TRUNC(orders.order_date, MONTH))" }
${extraMetric}`;
      const bqLoaded = loadModels(yamlFor(
          '        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders\n',
          '      - { name: done_rev, expression: \'SUM(IF(orders.status = "done", orders.net_amount, 0))\' }\n' +
          '      - { name: recent_cnt, expression: \'COUNTIF(orders.order_date >= DATE "2024-01-01")\' }\n'));
      const bqWarnings: string[] = [];
      expect(validatePushRequirements(
                 bqLoaded.models.map(m => loaded(m, 'sales.yaml')),
                 {warnings: bqWarnings}))
          .toEqual([]);
      expect(bqWarnings).toEqual([]);

      // Reading `ANSI_SQL` in the BigQuery source dialect catches a bad field inside BigQuery-only syntax
      // (`DATE "2024-01-01"` does not parse in generic ANSI_SQL).
      const bqBadLoaded = loadModels(yamlFor(
          '        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders\n',
          '      - { name: bad_recent, expression: \'COUNTIF(orders.missing_date >= DATE "2024-01-01")\' }\n'));
      expect(validatePushRequirements(
                 bqBadLoaded.models.map(m => loaded(m, 'sales.yaml')))
                 .join('\n'))
          .toContain("entity 'orders' has no field 'missing_date'");

      const sourcelessLoaded = loadModels(yamlFor(''), {bindingOptional: true});
      expect(validateExpressionReferences(
                 sourcelessLoaded.models.map(m => loaded(m, 'unbind.yaml')), false))
          .toEqual([]);
    });

    test('skips an expression the SQL parser cannot read, emits a warning naming the dialect when only some fail, and does not trigger Rule 1 when unanchored', () => {
      const m = model({
        entities: [orders()],
        metrics: [
          {name: 'unparseable_anchored', expression: 'SUM(orders.net_amount', entity: 'orders', authoredEntity: 'orders'},
          {name: 'unparseable_unanchored', expression: 'SUM(orders.net_amount'},
          {
            name: 'partial_unparseable',
            entity: 'orders',
            authoredEntity: 'orders',
            dialects: [
              {dialect: 'BIGQUERY', expression: 'COUNT(*)'},
              {dialect: 'SNOWFLAKE', expression: 'SUM(orders.net_amount'},
            ],
          },
        ],
      });
      const warnings: string[] = [];
      expect(validatePushRequirements([loaded(m)], {warnings})).toEqual([]);
      expect(warnings).toEqual([
        "metric 'unparseable_anchored' in model 'm' (doc): kcmd could not read its SQL, so the fields it reads were not checked.",
        "metric 'unparseable_unanchored' in model 'm' (doc): kcmd could not read its SQL, so the fields it reads were not checked.",
        "metric 'partial_unparseable' in model 'm' (doc): kcmd could not read its 'SNOWFLAKE' SQL, so the fields that entry reads were not checked.",
      ]);
    });
  });

  describe('fields', () => {
    test('rejects a field expression that references another declared entity', () => {
      const m = model({
        entities: [
          {
            ...orders(),
            fields: [
              ...orders().fields,
              {name: 'bad_cross', expression: 'customer.amount + 1'},
            ],
          },
          customer(),
        ],
      });
      expect(validatePushRequirements(
                 [loaded(m)], {fieldsPruned: true})
                 .join('\n'))
          .toContain("field 'orders.bad_cross' in model 'm' (doc) references entity 'customer'");
    });

    test('accepts a field expression whose CTE gives an entity\'s name in another letter case', () => {
      const m = model({
        entities: [
          {
            ...orders(),
            fields: [
              ...orders().fields,
              {
                name: 'probe',
                dialects: [{
                  dialect: 'BIGQUERY',
                  expression: '(WITH Customer AS (SELECT 7 AS id) SELECT MAX(customer.id) FROM Customer)',
                }],
              },
            ],
          },
          customer(),
        ],
      });
      expect(validatePushRequirements([loaded(m)], {fieldsPruned: true})).toEqual([]);
    });

    test('rejects a field expression that references a missing sibling field on its own entity', () => {
      const m = model({
        entities: [{
          ...orders(),
          fields: [
            ...orders().fields,
            {name: 'taxed', expression: 'orders.missing_field * 1.1'},
          ],
        }],
      });
      expect(validatePushRequirements([loaded(m)])
                 .join('\n'))
          .toContain("field 'orders.taxed' in model 'm' (doc) references 'orders.missing_field'");
    });

    test('accepts a field expression referencing a declared, inherited, or excluded-from-inheritance sibling field before pruning, and warns on unparseable SQL', () => {
      const party: Entity = {
        name: 'party',
        abstract: true,
        dataSource: '',
        keys: [],
        fields: [{name: 'base_score', type: 'Float'}, {name: 'internal_score', type: 'Float'}],
      };
      const member: Entity = {
        name: 'member',
        extends: ['party'],
        excludedFields: ['internal_score'],
        dataSource: 'p.d.member',
        keys: ['id'],
        fields: [
          {name: 'id', expression: 'm_id'},
          {name: 'base_score', expression: 'm_base_score'},
          {name: 'boosted_score', expression: 'member.base_score * 2'},
          {name: 'legacy_ref', expression: 'member.internal_score + 1'},
          {name: 'broken', expression: 'member.base_score + ('},
        ],
      };
      const m = model({
        entities: [
          {
            ...orders(),
            fields: [
              ...orders().fields,
              {name: 'gross', expression: 'orders.net_amount * 1.1'},
              {name: 'cust_id', expression: 'details.customer.id'},
            ],
          },
          customer(),
          party,
          member,
        ],
      });
      const warnings: string[] = [];
      expect(validateExpressionReferences([loaded(m)], false, warnings)).toEqual([]);
      expect(warnings).toEqual([
        "field 'member.broken' in model 'm' (doc): kcmd could not read its SQL, so the fields it reads were not checked.",
      ]);
    });

    // A model built in memory skips the loader, which rejects these.
    test('rejects a field with no SQL in a model built in memory, as the loader does', () => {
      const message = (field: string, problem: string) =>
          `field 'orders.${field}' in model 'm' (doc): ${problem}; write ` +
          "the field's SQL, or remove 'expression' to leave the field unbound.";
      const fields = [
        ...orders().fields,
        {name: 'notes', expression: ''},
        {name: 'memo', expression: '-- todo'},
        {name: 'own', expression: 'orders.'},
        {
          name: 'vendor',
          expression: 'o_vendor',
          dialects: [
            {dialect: 'BIGQUERY' as const, expression: 'o_vendor'},
            {dialect: 'POSTGRES' as const, expression: ' '},
          ],
        },
        // `expression` is not the text of any dialect entry here, as it can
        // be in a model built in memory.
        {
          name: 'stale',
          expression: '/* old */',
          dialects: [{dialect: 'BIGQUERY' as const, expression: 'o_stale'}],
        },
        {name: 'pg_note', importedExpression: '-- todo', importedDialect: 'POSTGRES'},
        // PostgreSQL reads `#` as an operator, so this text holds SQL there.
        {name: 'pg_points', importedExpression: '# path', importedDialect: 'POSTGRES'},
      ];
      const expected = [
        message('notes', "'expression' is blank"),
        message('memo', "'expression' is only a comment"),
        message('own', "'expression' is only the qualifier 'orders.'"),
        message('vendor', "the POSTGRES entry of 'expression' is blank"),
        message('stale', "'expression' is only a comment"),
        message('pg_note', "the POSTGRES entry of 'expression' is only a comment"),
      ];
      const kcOnly = model({entities: [{...orders(), fields}]});
      expect(validatePushRequirements([loaded(kcOnly)]))
          .toEqual(expected);
      const graph =
          model({entities: [{...orders(), fields}]}, [BQ_TARGET]);
      const errors =
          validatePushRequirements([loaded(graph)], {fieldsPruned: true});
      for (const e of expected) expect(errors).toContain(e);
    });

    test('rejects a field an entity inherits when it has no SQL on that entity', () => {
      // On `base` the text reads the column `sub`. On `sub`, inheritance
      // removes `base.` and leaves only the qualifier `sub.`.
      const base: Entity = {
        name: 'base',
        dataSource: 'p.d.base',
        keys: ['id'],
        fields: [
          {name: 'id', expression: 'b_id'},
          {name: 'label', expression: 'base.sub.'},
        ],
      };
      const sub: Entity = {
        name: 'sub',
        extends: ['base'],
        dataSource: 'p.d.sub',
        keys: ['id'],
        fields: [],
      };
      const expected = [
        "model 'm' (doc): entity 'sub' inherits field 'label': read on " +
            "'sub', 'expression' is only the qualifier 'sub.'; write the " +
            "field's SQL.",
      ];
      const m = model({entities: [base, sub]});
      expect(validatePushRequirements([loaded(m)]))
          .toEqual(expected);
      // `expression` is not the text of the dialect entry here, as it can be
      // in a model built in memory.
      const stale: Entity = {
        ...base,
        fields: [
          {name: 'id', expression: 'b_id'},
          {
            name: 'label',
            expression: 'base.sub.',
            dialects: [{dialect: 'BIGQUERY', expression: 'b_label'}],
          },
        ],
      };
      expect(validatePushRequirements(
                 [loaded(model({entities: [stale, sub]}))]))
          .toEqual(expected);
      // A field a profile excludes on `sub` is not read there.
      const profiled = applyProfile(m, {
        name: 'p',
        entities: [{name: 'sub', fieldsExclude: ['label']}],
        relationships: [],
      });
      expect(validatePushRequirements([loaded(profiled)])).toEqual([]);
    });

    // serializeModel writes both texts, and the loader rejects either one with
    // no SQL, so push reads both.
    test('rejects an imported text with no SQL beside a target text in a model built in memory', () => {
      const fieldMessage = (field: string, problem: string) =>
          `field 'orders.${field}' in model 'm' (doc): ${problem}; write ` +
          "the field's SQL, or remove 'expression' to leave the field unbound.";
      const fields = [
        ...orders().fields,
        {
          name: 'notes',
          expression: 'o_notes',
          importedExpression: '-- todo',
          importedDialect: 'POSTGRES',
        },
        {name: 'memo', expression: 'o_memo', importedExpression: '/* todo */'},
        {
          name: 'tag',
          expression: 'o_tag',
          dialects: [{dialect: 'BIGQUERY' as const, expression: 'o_tag'}],
          importedExpression: ' ',
          importedDialect: 'POSTGRES',
        },
        // PostgreSQL reads `#` as an operator, so this text holds SQL there.
        {
          name: 'points',
          expression: 'o_points',
          importedExpression: '# path',
          importedDialect: 'POSTGRES',
        },
      ];
      const m = model({
        entities: [{...orders(), fields}],
        metrics: [{
          name: 'revenue',
          expression: 'SUM(orders.net_amount)',
          importedExpression: '-- todo',
          importedDialect: 'POSTGRES',
        }],
      });
      expect(validatePushRequirements([loaded(m)]))
          .toEqual([
            fieldMessage(
                'notes', "the POSTGRES entry of 'expression' is only a comment"),
            fieldMessage('memo', "'importedExpression' is only a comment"),
            fieldMessage('tag', "'importedExpression' is blank"),
            "metric 'revenue' in model 'm' (doc): the POSTGRES entry of " +
                "'expression' is only a comment; write the metric's SQL.",
          ]);
    });

    // A field an entity binds itself is reported where it is declared, and
    // every field an entity inherits is read on it, whatever else is wrong.
    test('rejects every inherited field with no SQL beside a field rejected where it is declared', () => {
      const base: Entity = {
        name: 'base',
        dataSource: 'p.d.base',
        keys: ['id'],
        fields: [
          {name: 'id', expression: 'b_id'},
          {name: 'label', expression: 'base.sub.'},
          {name: 'tag', expression: 'base.sub.'},
          {name: 'memo', expression: 'b_memo'},
        ],
      };
      const sub: Entity = {
        name: 'sub',
        extends: ['base'],
        dataSource: 'p.d.sub',
        keys: ['id'],
        fields: [
          {name: 'own', expression: '-- todo'},
          {name: 'memo', expression: '/* todo */'},
        ],
      };
      const own = (field: string) =>
          `field 'sub.${field}' in model 'm' (doc): 'expression' is only a ` +
          "comment; write the field's SQL, or remove 'expression' to leave " +
          'the field unbound.';
      const inherited = (field: string) =>
          `model 'm' (doc): entity 'sub' inherits field '${field}': read on ` +
          "'sub', 'expression' is only the qualifier 'sub.'; write the " +
          "field's SQL.";
      expect(validatePushRequirements(
                 [loaded(model({entities: [base, sub]}))]))
          .toEqual([
            own('own'),
            own('memo'),
            inherited('label'),
            inherited('tag'),
          ]);
    });

    // Inheritance removes only the ancestor's qualifier, so a text with no
    // SQL where it is declared has none on any entity that inherits it.
    test('rejects a field with no SQL where it is declared, and not again on each entity that inherits it', () => {
      const base: Entity = {
        name: 'base',
        dataSource: 'p.d.base',
        keys: ['id'],
        fields: [
          {name: 'id', expression: 'b_id'},
          {name: 'memo', expression: '-- todo'},
          {name: 'own', expression: 'base.'},
          // Its imported text holds SQL on `base` and on `b`, and is only
          // the qualifier `a.` on `a`.
          {
            name: 'mixed',
            expression: '-- todo',
            importedExpression: 'base.a.',
            importedDialect: 'POSTGRES',
          },
        ],
      };
      const sub = (name: string): Entity => ({
        name,
        extends: ['base'],
        dataSource: `p.d.${name}`,
        keys: ['id'],
        fields: [],
      });
      expect(validatePushRequirements(
                 [loaded(model({entities: [base, sub('a'), sub('b')]}))]))
          .toEqual([
            "field 'base.memo' in model 'm' (doc): 'expression' is only a " +
                "comment; write the field's SQL, or remove 'expression' to " +
                'leave the field unbound.',
            "field 'base.own' in model 'm' (doc): 'expression' is only the " +
                "qualifier 'base.'; write the field's SQL, or remove " +
                "'expression' to leave the field unbound.",
            "field 'base.mixed' in model 'm' (doc): the BIGQUERY entry of " +
                "'expression' is only a comment; write the field's SQL, or " +
                "remove 'expression' to leave the field unbound.",
            "model 'm' (doc): entity 'a' inherits field 'mixed': read on " +
                "'a', the BIGQUERY entry of 'expression' is only a comment " +
                "and the POSTGRES entry of 'expression' is only the " +
                "qualifier 'a.'; write the field's SQL.",
          ]);
    });

    // A dialect list cannot hold an imported text with no imported dialect,
    // or one marked BIGQUERY beside a target text, and a model built in
    // memory can carry an imported text beside its list. Such a text is read
    // also when the target text has no SQL.
    test('rejects an inherited field whose imported text outside the dialect list is only the qualifier, beside a target text with no SQL', () => {
      // Each imported text holds SQL on `base` and is only the qualifier
      // `a.` on `a`.
      const base: Entity = {
        name: 'base',
        dataSource: 'p.d.base',
        keys: ['id'],
        fields: [
          {name: 'id', expression: 'b_id'},
          {name: 'loose', expression: '-- todo', importedExpression: 'base.a.'},
          {
            name: 'marked',
            expression: '-- todo',
            importedExpression: 'base.a.',
            importedDialect: 'BIGQUERY',
          },
          {
            name: 'listed',
            dialects: [{dialect: 'BIGQUERY', expression: '-- todo'}],
            expression: '-- todo',
            importedExpression: 'base.a.',
            importedDialect: 'POSTGRES',
          },
        ],
      };
      const a: Entity = {
        name: 'a',
        extends: ['base'],
        dataSource: 'p.d.a',
        keys: ['id'],
        fields: [{name: 'id', expression: 'a_id'}],
      };
      const target = (field: string) =>
          field === 'listed' ? "the BIGQUERY entry of 'expression'" :
                               "'expression'";
      expect(validatePushRequirements(
                 [loaded(model({entities: [base, a]}))]))
          .toEqual([
            ...['loose', 'marked', 'listed'].map(
                f => `field 'base.${f}' in model 'm' (doc): ${
                         target(f)} is only a comment; write the field's ` +
                    "SQL, or remove 'expression' to leave the field unbound."),
            ...['loose', 'marked', 'listed'].map(
                f => `model 'm' (doc): entity 'a' inherits field '${
                         f}': read on 'a', ${target(f)} is only a comment ` +
                    "and 'importedExpression' is only the qualifier 'a.'; " +
                    "write the field's SQL."),
          ]);
    });

    // Neither check needs inheritance resolved, so neither waits for the
    // author to fix it.
    test('rejects a field and a metric with no SQL when inheritance does not resolve', () => {
      const m = model({
        entities: [{
          ...orders(),
          extends: ['gone'],
          fields: [...orders().fields, {name: 'memo', expression: '-- todo'}],
        }],
        metrics: [
          {name: 'k', expression: '-- x', entity: 'orders'},
          {
            name: 'total',
            expression: 'SUM(orders.net_amount)',
            dialects: [
              {dialect: 'BIGQUERY', expression: 'SUM(orders.net_amount)'},
              {dialect: 'POSTGRES', expression: '-- todo'},
            ],
          },
        ],
      });
      const expected = [
        "field 'orders.memo' in model 'm' (doc): 'expression' is only a " +
            "comment; write the field's SQL, or remove 'expression' to leave " +
            'the field unbound.',
        "metric 'k' in model 'm' (doc) has no SQL in 'expression'; write " +
            "the metric's SQL.",
        "metric 'total' in model 'm' (doc): the POSTGRES entry of " +
            "'expression' is only a comment; write the metric's SQL.",
      ];
      const errors =
          validatePushRequirements([loaded(m)]);
      expect(errors.join('\n')).toContain("extends unknown entity 'gone'");
      for (const e of expected) expect(errors).toContain(e);
      // The BigQuery metric check reports each metric once.
      const graph = model(m, [BQ_TARGET]);
      expect(validatePushRequirements([loaded(graph)], {fieldsPruned: true})
                 .filter(e => e.startsWith('metric ')))
          .toEqual(expected.slice(1));
    });

    test('rejects an association field with no SQL, which the graph writes as an edge property', () => {
      const m = model(
          {
            entities: [orders(), customer()],
            relationships: [{
              name: 'bought',
              source: {entity: 'orders', columns: []},
              destination: {entity: 'customer', columns: []},
              association: {
                dataSource: 'p.d.bought',
                keys: ['k'],
                sourceColumns: ['order_id'],
                destinationColumns: ['customer_id'],
                fields: [
                  {name: 'qty', expression: 'b_qty'},
                  {name: 'note', expression: '# todo'},
                  {name: 'tag', expression: 'bought.'},
                ],
              },
            }],
          },
          [BQ_TARGET]);
      const errors = validatePushRequirements([loaded(m)]);
      expect(errors).toContain(
          "relationship 'bought' field 'note' in model 'm' (doc): " +
          "'expression' is only a comment; write the field's SQL.");
      expect(errors).toContain(
          "relationship 'bought' field 'tag' in model 'm' (doc): " +
          "'expression' is only the qualifier 'bought.'; write the field's " +
          'SQL.');
      expect(errors.join('\n')).not.toContain("field 'qty'");
    });

    // The error says what is wrong. The warning would say kcmd could not read
    // SQL that is not there.
    test('a field or metric rejected for no SQL gets no warning that its SQL could not be read', () => {
      const m = model({
        entities: [{
          ...orders(),
          fields: [
            ...orders().fields,
            {name: 'memo', expression: '-- todo'},
            {name: 'own', expression: 'orders.'},
            {
              name: 'vendor',
              expression: 'o_vendor',
              dialects: [
                {dialect: 'BIGQUERY', expression: 'o_vendor'},
                {dialect: 'POSTGRES', expression: '/* todo */'},
              ],
            },
          ],
        }],
        metrics: [
          {name: 'k', expression: '-- x', entity: 'orders'},
          {
            name: 'total',
            expression: 'SUM(orders.net_amount)',
            dialects: [
              {dialect: 'BIGQUERY', expression: 'SUM(orders.net_amount)'},
              {dialect: 'POSTGRES', expression: '-- todo'},
            ],
          },
        ],
      });
      const warnings: string[] = [];
      const errors = validatePushRequirements(
          [loaded(m)], {warnings});
      expect(errors.map(e => e.slice(0, e.indexOf(' in model'))))
          .toEqual([
            "field 'orders.memo'",
            "field 'orders.own'",
            "field 'orders.vendor'",
            "metric 'k'",
            "metric 'total'",
          ]);
      expect(warnings).toEqual([]);
    });

    // The graph renders a field that names a sibling from the sibling's SQL,
    // so a field that names itself, directly or through siblings, has none.
    test('rejects a field that names itself, directly or through sibling fields, in any dialect', () => {
      const m = model({
        entities: [{
          ...orders(),
          fields: [
            ...orders().fields,
            {name: 'a', expression: 'orders.b + 1'},
            {name: 'b', expression: 'orders.a - 1'},
            {name: 'total', expression: 'orders.total * 2'},
            {
              name: 'c',
              expression: 'o_c',
              dialects: [{dialect: 'BIGQUERY', expression: 'orders.c + 1'}],
            },
          ],
        }],
      });
      const errors = validatePushRequirements([loaded(m)]);
      expect(errors).toEqual([
        "field 'orders.a' in model 'm' (doc) names itself through " +
            "'orders.b'; a field expression may name other fields of its " +
            'entity, but not itself, directly or through other fields.',
        "field 'orders.b' in model 'm' (doc) names itself through " +
            "'orders.a'; a field expression may name other fields of its " +
            'entity, but not itself, directly or through other fields.',
        "field 'orders.total' in model 'm' (doc) names itself; a field " +
            'expression may name other fields of its entity, but not ' +
            'itself, directly or through other fields; to read the column ' +
            "of that name, write it without the qualifier: 'total'.",
        "field 'orders.c' in model 'm' (doc) names itself; a field " +
            'expression may name other fields of its entity, but not ' +
            'itself, directly or through other fields; to read the column ' +
            "of that name, write it without the qualifier: 'c'.",
      ]);
    });

    // A profile's exclusion leaves the field off the entity's table, but a
    // subtype that inherits the binding runs it, so it must still render
    // there.
    test('rejects a field that names itself on an entity that excludes it', () => {
      const m = model({
        entities: [{
          ...orders(),
          excludedFields: ['total'],
          fields: [
            ...orders().fields,
            {name: 'total', expression: 'orders.total * 2'},
          ],
        }, {...orders(), name: 'web_orders', extends: ['orders']}],
      });
      expect(validatePushRequirements([loaded(m)]))
          .toEqual([
            "field 'orders.total' in model 'm' (doc) names itself; a field " +
                'expression may name other fields of its entity, but not ' +
                'itself, directly or through other fields; to read the ' +
                "column of that name, write it without the qualifier: " +
                "'total'.",
          ]);
    });

    // The parser reserves `Date`, so it reads `Date.a` only with the qualifier
    // renamed, as the graph generators read it.
    test('rejects a field that names itself on an entity whose name the parser reserves', () => {
      const m = model({
        entities: [{
          name: 'Date',
          dataSource: 'p.d.dates',
          keys: ['id'],
          fields: [
            {name: 'id', expression: 'id'},
            {name: 'a', expression: 'Date.b + 1'},
            {name: 'b', expression: 'Date.a - 1'},
          ],
        }],
      });
      expect(validatePushRequirements([loaded(m)])
                 .map(e => e.slice(0, e.indexOf(';'))))
          .toEqual([
            "field 'Date.a' in model 'm' (doc) names itself through 'Date.b'",
            "field 'Date.b' in model 'm' (doc) names itself through 'Date.a'",
          ]);
    });

    // The cycle is in the subtype's own binding, so it is the subtype's error;
    // a cycle the supertype holds alone is reported on the supertype only.
    test('rejects a field that names itself through a field it inherits, on the entity that binds it', () => {
      const m = model({
        entities: [
          {
            name: 'party',
            dataSource: 'p.d.party',
            keys: ['id'],
            fields: [
              {name: 'id', expression: 'id'},
              {name: 'a', expression: 'party.b + 1'},
              {name: 'b', expression: 'b'},
              {name: 'total', expression: 'party.total * 2'},
            ],
          },
          {
            name: 'customer',
            dataSource: 'p.d.customer',
            keys: ['id'],
            extends: ['party'],
            fields: [
              {name: 'id', expression: 'id'},
              {name: 'b', expression: 'customer.a - 1'},
            ],
          },
        ],
      });
      const errors = validatePushRequirements([loaded(m)]);
      expect(errors).toEqual([
        "field 'party.total' in model 'm' (doc) names itself; a field " +
            'expression may name other fields of its entity, but not ' +
            'itself, directly or through other fields; to read the column ' +
            "of that name, write it without the qualifier: 'total'.",
        "field 'customer.b' in model 'm' (doc) names itself through " +
            "'customer.a'; a field expression may name other fields of its " +
            'entity, but not itself, directly or through other fields.',
        "field 'customer.a' in model 'm' (doc) names itself through " +
            "'customer.b'; a field expression may name other fields of its " +
            'entity, but not itself, directly or through other fields.',
      ]);
    });

    // An inherited text is read in its tables' dialect: `#>>` is an operator
    // in PostgreSQL, and `#` starts a comment in BigQuery, Spanner and MySQL.
    const CLOUDSQL = 'cloudsql.googleapis.com/projects/p/locations/l/instances/i/databases/d';
    const ALLOYDB = (t: string) => `alloydb.googleapis.com/projects/p/locations/l/clusters/c/databases/d/schemas/public/tables/${t}`;
    const POSTGRES_CLOUDSQL = (t: string) => `${CLOUDSQL}/schemas/public/tables/${t}`;
    const SPANNER = (t: string) => `spanner.googleapis.com/projects/p/instances/i/databases/d/tables/${t}`;
    const BIGQUERY = (t: string) => `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
    // Party, with `label`, and Customer, which inherits it and binds `code`.
    const inheriting = (
        table: (t: string) => string, sourceDialect: string|undefined,
        label: Partial<Field>, code: Partial<Field>) => {
      const entity = (name: string, fields: Field[], extended?: string[]) => ({
        name, authoredSource: table(name), dataSource: table(name),
        ...(sourceDialect ? {sourceDialect} : {}), keys: ['id'],
        ...(extended ? {extends: extended} : {}),
        fields: [{name: 'id', expression: 'id'}, ...fields],
      });
      return model({
        entities: [
          entity('party', [
            {name: 'data', expression: 'data'},
            {name: 'code', expression: 'code'},
            {name: 'label', ...label},
          ]),
          entity('customer', [{name: 'code', ...code}], ['party']),
        ],
      });
    };
    const cycles = (m: SemanticModel, load = {}) =>
        validatePushRequirements([loaded(m)], {load})
            .filter(e => e.includes('names itself'))
            .map(e => e.slice(0, e.indexOf(';')));
    test.each([
      ['AlloyDB', ALLOYDB, undefined, 2],
      ['PostgreSQL Cloud SQL', POSTGRES_CLOUDSQL, 'POSTGRES', 2],
      ['MySQL Cloud SQL', (t: string) => `${CLOUDSQL}/tables/${t}`, 'MYSQL', 0],
      ['PostgreSQL-dialect Spanner', SPANNER, 'POSTGRES', 2],
      ['GoogleSQL Spanner', SPANNER, 'SPANNER', 0],
      ['BigQuery', BIGQUERY, undefined, 0],
    ])('reads an inherited text with #>> on %s tables in their dialect', (_, table, sourceDialect, count) => {
      const m = inheriting(
          table, sourceDialect,
          {expression: "party.data #>> '{tier}' || party.code"},
          {expression: 'customer.label'});
      expect(cycles(m)).toHaveLength(count);
    });

    // A field gives the text its tables' database runs: its entry for their
    // dialect, else its ANSI_SQL one. Here only the ANSI_SQL entries name
    // each other, and only when read as PostgreSQL.
    test('reads no ANSI_SQL entry that an AlloyDB entry overrides on AlloyDB tables', () => {
      const m = inheriting(
          ALLOYDB, undefined,
          {dialects: [
            {dialect: 'ALLOYDB', expression: "'ok'"},
            {dialect: 'ANSI_SQL', expression: 'party.data # GoogleSQL comment: was party.code'},
          ]},
          {dialects: [
            {dialect: 'ALLOYDB', expression: 'c_code'},
            {dialect: 'ANSI_SQL', expression: 'customer.label'},
          ]});
      expect(cycles(m)).toEqual([]);
    });

    // A Spanner database runs the SPANNER or the POSTGRES entry. With no
    // lookup of the tables' dialect, the text it runs is not known, so no
    // text is read, also when push reads an ANSI_SQL text without the dialect.
    test.each([{}, {readWithoutDialect: true}])('reads no text on Spanner tables whose dialect no lookup read: %o', load => {
      const m = inheriting(
          SPANNER, undefined,
          {dialects: [{dialect: 'POSTGRES', expression: 'label'}]},
          {dialects: [
            {dialect: 'SPANNER', expression: 'c_code'},
            {dialect: 'ANSI_SQL', expression: 'customer.code + 1'},
          ]});
      expect(cycles(m, load)).toEqual([]);
    });

    // The running entries form the cycle. The other entry of `code` names
    // `code` itself when read as PostgreSQL, but no database of these tables
    // runs it.
    test.each<[string, (t: string) => string, string|undefined, SqlDialect, SqlDialect]>([
      ['AlloyDB', ALLOYDB, undefined, 'ALLOYDB', 'ANSI_SQL'],
      ['PostgreSQL Cloud SQL', POSTGRES_CLOUDSQL, 'POSTGRES', 'POSTGRES', 'ANSI_SQL'],
      ['PostgreSQL-dialect Spanner', SPANNER, 'POSTGRES', 'POSTGRES', 'ANSI_SQL'],
      ['BigQuery', BIGQUERY, undefined, 'ANSI_SQL', 'ALLOYDB'],
    ])('reads only the text that runs on %s tables', (_, table, sourceDialect, runs, other) => {
      const m = inheriting(
          table, sourceDialect,
          {dialects: [{dialect: runs, expression: "party.code || 'x'"}]},
          {dialects: [
            {dialect: runs, expression: 'customer.label'},
            {dialect: other, expression: 'customer.data # customer.code'},
          ]});
      expect(cycles(m)).toEqual([
        "field 'customer.code' in model 'm' (doc) names itself through 'customer.label'",
        "field 'customer.label' in model 'm' (doc) names itself through 'customer.code'",
      ]);
    });

    test('accepts an inherited field that names its supertype\'s siblings', () => {
      const m = model({
        entities: [
          {
            name: 'party',
            dataSource: 'p.d.party',
            keys: ['id'],
            fields: [
              {name: 'id', expression: 'id'},
              {name: 'gross', expression: 'g_amt'},
              {name: 'net', expression: 'party.gross - 1'},
            ],
          },
          {
            name: 'customer',
            dataSource: 'p.d.customer',
            keys: ['id'],
            extends: ['party'],
            fields: [
              {name: 'id', expression: 'id'},
              {name: 'gross', expression: 'g_amt'},
            ],
          },
        ],
      });
      expect(validatePushRequirements([loaded(m)]))
          .toEqual([]);
    });

    test('accepts a chain of fields that name their siblings', () => {
      const m = model({
        entities: [{
          ...orders(),
          fields: [
            ...orders().fields,
            {name: 'a', expression: 'x + y'},
            {name: 'b', expression: 'orders.a * 2'},
            {name: 'c', expression: 'orders.b + orders.a + orders.net_amount'},
          ],
        }],
      });
      expect(validatePushRequirements([loaded(m)]))
          .toEqual([]);
    });
  });

  describe('across dialects', () => {
    test('rejects a metric whose second dialect entry references a non-existent field', () => {
      const m = model({
        entities: [orders()],
        metrics: [{
          name: 'rev',
          expression: 'SUM(orders.net_amount)',
          entity: 'orders',
          dialects: [
            {dialect: 'BIGQUERY', expression: 'SUM(orders.net_amount)'},
            {dialect: 'SNOWFLAKE', expression: 'SUM("orders"."no_such_field")'},
          ],
        }],
      });
      expect(validatePushRequirements([loaded(m)])
                 .join('\n'))
          .toContain("entity 'orders' has no field 'no_such_field'");
    });

    // An OSSIE_SQL_2026 text is read like a text in any other dialect: a
    // qualified name in a field names a field of its entity, and a metric
    // names each field as 'entity.field'. Table orders names no database, so
    // every text is read.
    const ossie = (expression: string) =>
        [{dialect: 'OSSIE_SQL_2026' as const, expression}];
    test.each<[string, Field[], Metric[], string]>([
      ['a field that names a field its entity does not have',
       [{name: 'net', dialects: ossie('orders.o_net')}], [],
       "field 'orders.net' in model 'm' (doc) references 'orders.o_net', which " +
           "is not a declared or inherited field of 'orders'."],
      ['a metric that names a field without its entity',
       [], [{name: 'rev', entity: 'orders', authoredEntity: 'orders', dialects: ossie('SUM(net_amount)')}],
       "metric 'rev' in model 'm' (doc): 'net_amount' must be written as " +
           "'entity.field'; a metric reads fields, never columns."],
    ])('checks an OSSIE_SQL_2026 text in %s', (_, fields, metrics, expected) => {
      const m = model({
        entities: [{...orders(), dataSource: 'orders', fields: [...orders().fields, ...fields]}],
        metrics,
      });
      expect(validatePushRequirements([loaded(m)])).toEqual([expected]);
    });
  });
});


// Push checks names again, for a model built in memory and a profile that
// reaches `model.profiles` without the loader, and is the only place the
// description limit and metric-field collisions are checked.
describe('push checks names and description lengths', () => {
  const customer: Entity =
      {name: 'customer', dataSource: 'p.d.c', keys: ['id'], fields: []};
  const withNames = (over: Partial<SemanticModel> = {}) => model({
    entities: [{
      name: 'orders', dataSource: 'p.d.o', keys: ['id'],
      fields: [{name: 'id', expression: 'id'}],
    }, customer],
    ...over,
  });
  const errorsOf = (m: SemanticModel) => validatePushRequirements([loaded(m)]);

  test('a valid model passes', () => {
    expect(errorsOf(withNames())).toEqual([]);
  });

  test('each name a model built in memory carries is checked', () => {
    const m = withNames({
      name: 'sales/orders',
      entities: [{
        name: 'my-entity', dataSource: 'p.d.o', keys: ['id'],
        fields: [{name: 'order date', expression: 'id'}],
      }, customer],
      metrics: [{name: '2024_orders', expression: 'COUNT(*)'} as Metric],
      relationships: [{
        name: 'placed-by', source: {entity: 'my-entity', columns: []},
        destination: {entity: 'customer', columns: []},
      }],
      deployments: [{name: 'prod,us', target: BQ_TARGET}],
      profiles: [{name: 'eu west', entities: [], relationships: []}],
    });
    const errors = errorsOf(m).join('\n');
    for (const message of [
           "model 'sales/orders' (doc): Model name 'sales/orders' is not valid",
           "Entity name 'my-entity' is not valid",
           "Field name 'order date' is not valid",
           "Metric name '2024_orders' is not valid",
           "Relationship name 'placed-by' is not valid",
           "Deployment name 'prod,us' is not valid",
           "Profile name 'eu west' is not valid",
         ]) {
      expect(errors).toContain(message);
    }
  });

  test('a profile may not be named default, in any case', () => {
    for (const name of ['default', 'Default', 'DEFAULT']) {
      expect(errorsOf(withNames({profiles: [{name, entities: [], relationships: []}]})))
          .toEqual([
            `[doc] a binding profile may not be named 'default' -- that name ` +
            `refers to the model's inline bindings. Rename the profile.`,
          ]);
    }
    expect(errorsOf(withNames({
      profiles: [{name: 'default_eu', entities: [], relationships: []}],
    }))).toEqual([]);
  });

  test('a description may have 2,000 characters on the model, an entity, a metric or a relationship', () => {
    const described = (length: number) => withNames({
      description: 'm'.repeat(length),
      entities: [{
        name: 'orders', dataSource: 'p.d.o', keys: ['id'],
        fields: [{name: 'id', expression: 'id', description: 'f'.repeat(length)}],
        description: 'e'.repeat(length),
      }, customer],
      metrics: [{
        name: 'order_count', expression: 'COUNT(orders.id)', entity: 'orders',
        description: 'x'.repeat(length),
      } as Metric],
      relationships: [{
        name: 'placed_by', source: {entity: 'orders', columns: ['id']},
        destination: {entity: 'customer', columns: ['id']},
        description: 'r'.repeat(length),
      }],
    });
    expect(errorsOf(described(2000))).toEqual([]);
    const errors = errorsOf(described(2001));
    for (const what of [
           "model 'm'", "entity 'orders'", "metric 'order_count'",
           "relationship 'placed_by'",
         ]) {
      expect(errors).toContain(
          `model 'm' (doc): the description of ${what} is 2001 characters ` +
          `long; a Knowledge Catalog entry's description holds at most 2000.`);
    }
    // A field's description is not stored as an entry's description, so it
    // has no limit.
    expect(errors).toHaveLength(4);
  });

  // Metrics and fields on one entity share a namespace, ignoring case. The
  // check runs before pruning, so a field pruning drops still counts.
  describe('a metric and a field on one entity', () => {
    const party: Entity = {
      name: 'party', abstract: true, dataSource: '', keys: [],
      fields: [{name: 'Customer_ID', type: 'String'}],
    };
    const customers = (fields: Field[] = []): Entity => ({
      name: 'customers', extends: ['party'], dataSource: 'p.d.c', keys: ['id'],
      fields: [{name: 'id', expression: 'id'}, ...fields],
    });
    const COLLIDES = (metric: string, field: string) =>
        `Metric '${metric}' in model 'm' (doc) collides with field '${
            field}' on entity 'customers'; metrics and fields on the same ` +
        `entity share a namespace.`;
    const withMetric = (name: string, fields?: Field[]) => withNames({
      entities: [party, customers(fields)],
      metrics: [{
        name, expression: 'COUNT(customers.id)', entity: 'customers',
      } as Metric],
    });

    test('collide when the field is declared or inherited', () => {
      expect(errorsOf(withMetric('status', [{name: 'Status', expression: 's'}])))
          .toEqual([COLLIDES('status', 'Status')]);
      expect(errorsOf(withMetric('customer_id')))
          .toEqual([COLLIDES('customer_id', 'Customer_ID')]);
      expect(errorsOf(withMetric('order_count'))).toEqual([]);
    });

    test('collide before pruning drops an unbound field', () => {
      const m = withMetric('revenue', [{name: 'revenue'}]);
      expect(validateExpressionReferences([loaded(m)], false))
          .toEqual([COLLIDES('revenue', 'revenue')]);
    });
  });
});

// Loads model `name` from the YAML of its lists, with bindings optional.
const loadOne = (name: string, lists: string, opts: LoadOptions = {}) => loadModels(
    `version: "0.2.0.dev0/google"\nsemantic_model:\n  - name: ${name}\n${lists}`,
    {bindingOptional: true, ...opts}).models[0];
const BQ_TABLE = (t: string) =>
    `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
// One target of each engine.
const TARGET = {
  bigquery: BQ_TARGET,
  spanner: SPANNER_TARGET,
  alloydb:
      'alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c/databases/db',
};

// Every deployment is held to the rules of its engine, under the profile it
// names or the model file's own bindings.
describe('validateDeployments', () => {
  type Engine = keyof typeof TARGET;
  // A deployment entry named after its engine.
  const deployment = (engine: Engine, profile?: string) =>
      `      - name: ${engine}\n        target: ${TARGET[engine]}\n` +
      (profile ? `        profile: ${profile}\n` : '');
  const BQ = deployment('bigquery');
  // Purchases join customers, with the customer table and the join bound
  // unless `customer` or `join` is false, and fields c_name and note bound
  // unless `unbound` is true. `deployments` holds deployment entries and
  // `metric` one metric, as YAML.
  const commerce = ({
    customer = true, join = true, unbound = false, deployments = '',
    metric = '',
  } = {}) => {
    const field = (name: string) =>
        `{ name: ${name}${unbound ? '' : `, expression: ${name}`} }`;
    return loadOne('commerce', `${deployments && `    deployments:\n${deployments}`}\
    entities:
      - name: customer
${customer ? `        source: ${BQ_TABLE('customer')}\n` : ''}\
        primary_key: [c_id]
        fields: [{ name: c_id, expression: c_id }, ${field('c_name')}]
      - name: purchase
        source: ${BQ_TABLE('purchase')}
        primary_key: [p_id]
        fields:
          - { name: p_id, expression: p_id }
          - { name: amount, expression: amt }
          - ${field('note')}
          - { name: noted, expression: "purchase.note || '!'" }
    relationships:
      - { name: placed_by, from: purchase, to: customer${
          join ? ', from_columns: [p_customer], to_columns: [c_id]' : ''} }
${metric && `    metrics:\n      - ${metric}\n`}`);
  };
  const check = (m: SemanticModel) => validateDeployments(m, 'commerce', {});
  // The start of the error saying deployment `engine` uses the model file's
  // own bindings. A list of engines gives the plural form that names each.
  const OWN = (engine: Engine|Engine[]) => typeof engine === 'string' ?
      `model 'commerce' (commerce) deployment '${engine}' uses the model ` +
          `file's own bindings, ` :
      `model 'commerce' (commerce) deployments ${
          listed(engine.map(e => `'${e}'`))} use the model file's own ` +
          `bindings, `;
  const UNBOUND =
      (engine: Engine|Engine[], left = "entity 'customer' without a source") =>
          `${OWN(engine)}which leave ${left}; a deployment needs every ` +
      'entity and relationship bound.';
  // The error for metric `metric` reading `field`. The field has no
  // expression, or with `direct` false, reads a field that has none.
  const READS =
      (engine: Engine|Engine[], metric: string, field: string, direct = true) =>
          `${OWN(engine)}under which metric '${metric}' reads field '${
              field}', which ${
              direct ? 'has no expression' :
                       'reads a field with no expression, directly or ' +
                           'through other fields'}; a deployment needs ` +
      'every field its metrics read bound.';
  // The error for deployment `engine` leaving `fields` without an expression.
  // With several fields, `each` and `them` give the plural advice.
  const NO_EXPRESSION = (engine: Engine|Engine[], fields: string,
                         each = 'the field', them = 'it') =>
      `${OWN(engine)}which leave ${fields} without an expression; a graph ` +
      'deployment needs every field of a concrete leaf entity bound. Give ' +
      `${each} an expression, or use a named profile that lists ${them} in ` +
      "'fields_exclude'.";
  // The error for fields c_name and note, which commerce leaves unbound.
  const NAME_AND_NOTE = (engine: Engine|Engine[]) => NO_EXPRESSION(
      engine, "fields 'customer.c_name' and 'purchase.note'", 'each field',
      'them');

  // Every engine needs the bindings complete. A Spanner deployment of the
  // model file's own bindings deploys no metric, so only the others need the
  // fields a metric reads, directly or through another field.
  test('holds a deployment of each engine to its own rules, and passes a model with no deployments', () => {
    expect(check(commerce({customer: false, join: false}))).toEqual([]);
    const all = BQ + deployment('spanner') + deployment('alloydb');
    expect(check(commerce({customer: false, deployments: all}))).toEqual([
      UNBOUND(['bigquery', 'spanner', 'alloydb']),
    ]);
    expect(check(commerce(
               {customer: false, deployments: deployment('bigquery', 'default')})))
        .toEqual([UNBOUND('bigquery')]);
    const notes = '{ name: m, expression: "COUNT(purchase.note)" }';
    expect(check(commerce({unbound: true, deployments: all, metric: notes})))
        .toEqual([
          NAME_AND_NOTE(['bigquery', 'spanner']),
          READS(['bigquery', 'alloydb'], 'm', 'purchase.note'),
        ]);
    const noted = '{ name: m, expression: "COUNT(purchase.noted)" }';
    expect(check(commerce({unbound: true, deployments: BQ, metric: noted})))
        .toEqual([
          NAME_AND_NOTE('bigquery'),
          READS('bigquery', 'm', 'purchase.noted', false),
        ]);
  });

  // A graph gives a node table only to a concrete leaf entity, so a BigQuery
  // or Spanner deployment of the model file's own bindings needs an
  // expression for each of its fields, inherited ones included. A field that
  // reads one with no expression, such as noted, is bound once that one is.
  test('names every field of a concrete leaf entity with no expression, on a graph deployment of the model file\'s own bindings', () => {
    const all = BQ + deployment('spanner') + deployment('alloydb');
    expect(check(commerce({unbound: true, deployments: all})))
        .toEqual([NAME_AND_NOTE(['bigquery', 'spanner'])]);
    // A named profile accounts for each field itself.
    const named =
        commerce({unbound: true, deployments: deployment('bigquery', 'ops')});
    named.profiles = [{name: 'ops', entities: [], relationships: []}];
    expect(check(named)).toEqual([]);
    // An abstract entity that nothing extends has no table either.
    const lone = commerce({deployments: BQ});
    lone.entities.push({
      name: 'party', abstract: true, dataSource: '', keys: [],
      fields: [{name: 'label'}],
    });
    expect(check(lone)).toEqual([]);
    // Vip extends party and states `vip` among its fields. Party is abstract
    // when `abstract`, and otherwise has a table.
    const parties = (abstract: boolean, vip = '') =>
        loadOne('commerce', `    deployments:\n${BQ}\
    entities:
      - name: party
${abstract ? '        abstract: true\n' : `        source: ${BQ_TABLE('party')}
        primary_key: [id]\n`}\
        fields:
          - { name: id${abstract ? '' : ', expression: id'} }
          - { name: label }
      - name: vip
        extends: [party]
        source: ${BQ_TABLE('vip')}
        primary_key: [id]
        fields: [{ name: id, expression: id }${vip}]
`);
    const LABEL = NO_EXPRESSION('bigquery', "field 'vip.label'");
    expect(check(parties(true))).toEqual([LABEL]);
    expect(check(parties(false))).toEqual([LABEL]);
    expect(check(parties(true, ', { name: label, expression: v_label }')))
        .toEqual([]);
  });

  // An AlloyDB database runs a metric's ALLOYDB text, or its ANSI_SQL one,
  // and holds no graph. A BigQuery deployment counts the text a graph push's
  // pruning reads, the one the sources' dialect selects.
  test('an AlloyDB deployment checks only the fields that a metric\'s ALLOYDB or ANSI_SQL text reads', () => {
    // `metric` is the expression of metric `m`, and `label` that of field
    // `label`. With `shop`, a BigQuery table joins the bindings, so they span
    // systems.
    const alloyDb = (metric: string, {label = 'c_id', shop = false} = {}) =>
        loadOne('commerce', `    deployments:\n${deployment('alloydb')}${BQ}\
    entities:
      - name: customer
        source: ${TARGET.alloydb}/schemas/public/tables/customer
        primary_key: [c_id]
        fields:
          - { name: c_id, expression: c_id }
          - { name: note }
          - { name: label, expression: ${label} }
${shop ? `      - { name: shop, source: ${BQ_TABLE('shop')}, primary_key: [s_id],
          fields: [{ name: s_id, expression: s_id }] }\n` : ''}\
    metrics:
      - { name: m, expression: ${metric} }
`);
    // A dialect list with one text per [dialect, text] entry.
    const texts = (...entries: Array<[string, string]>) => `{ dialects: [${
        entries.map(([d, e]) => `{ dialect: ${d}, expression: "${e}" }`)
            .join(', ')}] }`;
    const both = (bigQuery: string, alloyDbText: string) =>
        texts(['BIGQUERY', bigQuery], ['ALLOYDB', alloyDbText]);
    const [NOTE, C_ID] = ['COUNT(customer.note)', 'COUNT(customer.c_id)'];
    const noteInBigQuery = both(NOTE, C_ID);
    // The BigQuery deployment also needs field note bound.
    const NO_NOTE = NO_EXPRESSION('bigquery', "field 'customer.note'");
    expect(check(alloyDb(noteInBigQuery))).toEqual([NO_NOTE]);
    expect(check(alloyDb(noteInBigQuery, {shop: true})))
        .toEqual([NO_NOTE, READS('bigquery', 'm', 'customer.note')]);
    expect(check(alloyDb(texts(['BIGQUERY', NOTE], ['ANSI_SQL', C_ID]))))
        .toEqual([NO_NOTE]);
    expect(check(alloyDb(both(C_ID, NOTE)))).toEqual([
      READS(['alloydb', 'bigquery'], 'm', 'customer.note'), NO_NOTE,
    ]);
    // A field the metric reads is read the same way. A field reads a sibling
    // field as `entity.field`.
    const viaLabel = '"COUNT(customer.label)"';
    expect(check(alloyDb(viaLabel, {label: both('customer.note', 'c_id')})))
        .toEqual([NO_NOTE]);
    expect(check(alloyDb(viaLabel, {label: both('c_id', 'customer.note')})))
        .toEqual([
          READS(['alloydb', 'bigquery'], 'm', 'customer.label', false), NO_NOTE,
        ]);
  });

  test('names every concrete entity and relationship left unbound', () => {
    const m = commerce(
        {customer: false, join: false, deployments: deployment('alloydb')});
    m.entities[1].dataSource = '';
    m.relationships.push({...m.relationships[0], name: 'billed_to'});
    expect(check(m)).toEqual([UNBOUND(
        'alloydb',
        "entities 'customer' and 'purchase' without a source and " +
            "relationships 'placed_by' and 'billed_to' without join columns")]);
    // An abstract entity has no table, so it needs no source.
    const exempt = commerce({deployments: BQ});
    exempt.entities.push(
        {name: 'party', dataSource: '', keys: [], fields: [], abstract: true});
    expect(check(exempt)).toEqual([]);
    // A concrete entity that another extends has a table of its own, so it
    // needs a source too.
    const hierarchy = (abstract: boolean) => loadOne('commerce', `    deployments:
${BQ}${deployment('spanner')}\
    entities:
      - name: customer
${abstract ? '        abstract: true\n' : '        primary_key: [c_id]\n'}\
        fields: [{ name: c_id${abstract ? '' : ', expression: c_id'} }]
      - name: vip
        extends: [customer]
        source: ${BQ_TABLE('vip')}
        primary_key: [c_id]
        fields: [{ name: c_id, expression: c_id }]
`);
    expect(check(hierarchy(false)))
        .toEqual([UNBOUND(['bigquery', 'spanner'])]);
    expect(check(hierarchy(true))).toEqual([]);
  });

  test('incomplete inline bindings give one warning when no deployment uses them', () => {
    const warned = (m: SemanticModel, named = false) =>
        inlineBindingWarnings(m, 'commerce', named);
    const NON_EXECUTABLE = (left: string) =>
        `model 'commerce' (commerce) is non-executable: the model file leaves ${
            left}, and the model declares no named profile. It cannot be ` +
        'queried until it is bound.';
    const NO_DEFAULT = "model 'commerce' (commerce) has an unbound 'default' " +
        "profile: the model file leaves entity 'customer' without a source " +
        "and relationship 'placed_by' without join columns. It cannot be " +
        "queried through 'default'.";
    // Complete bindings give nothing, and fields without an expression do not
    // count. Neither do incomplete bindings a deployment uses, which the
    // deployment rules reject.
    for (const [i, m] of [
           commerce({unbound: true}), commerce({deployments: BQ}),
           commerce({customer: false, deployments: BQ}),
         ].entries()) {
      expect({i, warnings: [...warned(m), ...warned(m, true)]})
          .toEqual({i, warnings: []});
    }
    for (const [m, left] of [
           [commerce({customer: false}), "entity 'customer' without a source"],
           [
             commerce({join: false}),
             "relationship 'placed_by' without join columns",
           ],
    ] as const) {
      expect(warned(m)).toEqual([NON_EXECUTABLE(left)]);
    }
    // Beside named profiles.
    expect(warned(commerce({customer: false, join: false}), true))
        .toEqual([NO_DEFAULT]);
  });

  // A BigQuery graph turns each metric into a measure on the node table of a
  // keyed entity: aggregates of the five, with every field inside one.
  describe('BigQuery', () => {
    // The model with metric `metric` on a BigQuery deployment, with
    // `purchase` merged into entity purchase. bigQuery gives its errors.
    const onBigQuery = (metric: string, purchase?: Partial<Entity>) => {
      const m = commerce({deployments: BQ, metric});
      Object.assign(m.entities[1], purchase);
      return m;
    };
    const bigQuery = (metric: string, purchase?: Partial<Entity>) =>
        check(onBigQuery(metric, purchase));
    const MEASURE = (why: string) => `model 'commerce' (commerce) deployment ` +
        `'bigquery' targets BigQuery, where metric 'm' cannot be a measure: ${
            why}.`;
    const anchored = (e: string) =>
        `{ name: m, entity: purchase, expression: "${e}" }`;

    test('rejects a metric that cannot be a measure, on BigQuery only, and adds no measure error for an entity that lacks primary_key', () => {
      const STDDEV = 'it uses STDDEV, which BigQuery does not allow in a ' +
          'measure (SUM, AVG, COUNT, MIN, MAX)';
      for (const [e, why] of [
             ['purchase.amount - SUM(purchase.p_id)',
              "it reads field 'amount' outside an aggregate"],
             ['STDDEV(purchase.amount)', STDDEV],
             ['COUNTIF(purchase.amount > 0)',
              'it uses COUNTIF, which BigQuery does not allow in a measure ' +
                  '(SUM, AVG, COUNT, MIN, MAX)'],
             ['SUM(MAX(purchase.amount))',
              'it nests an aggregate, a window or a subquery'],
             ['SUM(purchase.amount) OVER ()', 'it uses a window or a subquery'],
             ['MIN(purchase.amount, purchase.p_id)',
              'it calls MIN with 2 operands, where an aggregate in a measure ' +
                  'takes one'],
             ['purchase.amount * 2',
              'it holds no aggregate (SUM, AVG, COUNT, MIN, MAX)'],
             ['`p.ds.safe_ratio`(SUM(purchase.amount), COUNT(purchase.p_id))',
              "it calls user-defined function 'p.ds.safe_ratio' outside an " +
                  'aggregate, which BigQuery cannot read in a measure'],
             ['ds.f(SUM(purchase.amount))',
              "it calls user-defined function 'ds.f' outside an aggregate, " +
                  'which BigQuery cannot read in a measure'],
           ]) {
        expect({e, errors: bigQuery(anchored(e))})
            .toEqual({e, errors: [MEASURE(why)]});
      }
      // Two BigQuery deployments, on graphs g and g2, get one message that
      // names both.
      expect(check(commerce({
        deployments: `${BQ}      - name: dev\n        target: ${BQ_TARGET}2\n`,
        metric: anchored('STDDEV(purchase.amount)'),
      }))).toEqual([
        "model 'commerce' (commerce) deployments 'bigquery' and 'dev' target " +
        `BigQuery, where metric 'm' cannot be a measure: ${STDDEV}.`,
      ]);
      expect(check(commerce({
        deployments: deployment('spanner') + deployment('alloydb'),
        metric: '{ name: m, expression: "STDDEV(purchase.amount)" }',
      }))).toEqual([]);
      for (const e of [
             'SUM(purchase.amount)', 'COUNT(DISTINCT purchase.p_id)',
             '(MAX(purchase.amount)) -- top',
             'SUM(purchase.amount) / COUNT(purchase.p_id)',
             'SUM(purchase.amount) / 2',
             "SAFE_DIVIDE(SUM(IF(purchase.note = 'F', purchase.amount, 0)), " +
                 'SUM(purchase.amount))',
             'CASE WHEN COUNT(purchase.p_id) = 0 THEN NULL ' +
                 'ELSE SUM(purchase.amount) / COUNT(purchase.p_id) END',
           ]) {
        expect({e, errors: bigQuery(`{ name: m, expression: "${e}" }`)})
            .toEqual({e, errors: []});
      }
      expect(bigQuery(anchored('COUNT(*)'))).toEqual([]);
      // An entity without primary_key, even one with unique_keys, gets only
      // the entity primary_key error and no second error per metric.
      const KEYLESS_PURCHASE =
          `${OWN('bigquery')}which leave entity 'purchase' without a ` +
          'primary_key; a BigQuery graph deployment needs a primary_key on ' +
          'every concrete leaf entity. Declare primary_key on the entity, or ' +
          'use a named profile that states one.';
      for (const e of ['SUM(purchase.amount)', 'COUNT(*)']) {
        expect({e, errors: bigQuery(anchored(e), {keys: []})})
            .toEqual({e, errors: [KEYLESS_PURCHASE]});
        expect({
          e,
          errors: bigQuery(anchored(e), {keys: [], uniqueKeys: [['p_id']]}),
        }).toEqual({e, errors: [KEYLESS_PURCHASE]});
      }
      // A metric that cannot be a measure is still reported beside the
      // missing primary_key, so both are fixed in one pass.
      expect(bigQuery(anchored('STDDEV(purchase.amount)'), {keys: []}))
          .toEqual([KEYLESS_PURCHASE, MEASURE(STDDEV)]);
    });

    // The parser reserves `Date`, so it reads a metric on entity Date only with
    // the qualifier renamed, as the generator reads it.
    test('reads a metric on an entity named like a word the parser reserves', () => {
      const onDate = (e: string) => {
        const m = onBigQuery(`{ name: m, expression: "${e}" }`);
        m.entities.push({...m.entities[1], name: 'Date'});
        return check(m);
      };
      expect(onDate('SUM(Date.amount) / COUNT(Date.p_id)')).toEqual([]);
      expect(onDate('STDDEV(Date.amount)')).toEqual([
        MEASURE('it uses STDDEV, which BigQuery does not allow in a measure ' +
                '(SUM, AVG, COUNT, MIN, MAX)'),
      ]);
      expect(onDate('Date.amount - SUM(Date.amount)')).toEqual([
        MEASURE("it reads field 'amount' outside an aggregate"),
      ]);
    });

    // Each metric is reported once.
    test('leaves a metric another check reports to it', () => {
      // The rule that a metric resolves to exactly one entity: two entities,
      // or two that no relationship connects, so that pruning drops the
      // metric first.
      // A metric whose aggregates read one entity each reads both too.
      const two =
          onBigQuery(anchored('STDDEV(purchase.amount + customer.c_id)'));
      const ratio = onBigQuery(
          anchored('SUM(purchase.amount) / COUNT(customer.c_id)'));
      const apart =
          onBigQuery(anchored('STDDEV(purchase.amount * shop.c_id)'));
      apart.entities.push({...apart.entities[0], name: 'shop'});
      for (const [m, read] of [[two, 'purchase, customer'],
                               [ratio, 'purchase, customer'],
                               [apart, 'purchase, shop']] as const) {
        expect(check(m)).toEqual([]);
        expect(validatePushRequirements([loaded(m, 'commerce')])
                   .filter(e => e.includes("metric 'm'")))
            .toEqual([expect.stringContaining(
                `its BigQuery SQL reads several entities (${read})`)]);
      }
      // A function namespace named like an entity reads no entity, so that
      // rule passes the metric, and this one reports it.
      const safe =
          onBigQuery(anchored('safe.divide(STDDEV(purchase.amount), 2)'));
      safe.entities.push({...safe.entities[0], name: 'safe'});
      expect(check(safe)).toEqual([
        MEASURE('it uses STDDEV, which BigQuery does not allow in a measure ' +
                '(SUM, AVG, COUNT, MIN, MAX)'),
      ]);
      expect(validatePushRequirements([loaded(safe, 'commerce')])
                 .filter(e => e.includes("metric 'm'")))
          .toEqual([]);
      // The reference rules: a field the entity does not declare.
      expect(bigQuery(anchored('STDDEV(purchase.amt)'))).toEqual([]);
      // The binding rule: a field with no expression.
      expect(check(commerce({
        unbound: true,
        deployments: BQ,
        metric: '{ name: m, expression: "STDDEV(purchase.note)" }',
      }))).toEqual([
        NAME_AND_NOTE('bigquery'), READS('bigquery', 'm', 'purchase.note'),
      ]);
      // The inheritance rules: an abstract entity, and one that another extends.
      expect(bigQuery(anchored('STDDEV(purchase.amount)'), {abstract: true}))
          .toEqual([]);
      const extended = onBigQuery(
          '{ name: m, entity: customer, expression: "STDDEV(customer.c_id)" }');
      extended.entities.push(
          {...extended.entities[0], name: 'vip', extends: ['customer']});
      expect(check(extended)).toEqual([]);
    });
  });

  // A deployment that names a profile reads it from `model.profiles`: its
  // metrics_exclude, the metrics it prunes and the keys it states.
  describe('under a named profile', () => {
    // The errors for metric `metric` on deployment `engine`, which names
    // profile ops, with ops set to `ops` and purchase keyed by `keys`.
    const underOps = (engine: Engine, metric: string,
                      ops: Partial<ProfileSpec> = {}, keys = ['p_id']) => {
      const m = commerce({deployments: deployment(engine, 'ops'), metric});
      m.entities[1].keys = keys;
      m.profiles = [{name: 'ops', entities: [], relationships: [], ...ops}];
      return check(m);
    };
    const SUM =
        '{ name: m, entity: purchase, expression: "SUM(purchase.amount)" }';

    test('a Spanner deployment fails while its profile leaves a metric available', () => {
      expect(underOps('spanner', SUM, {metricsExclude: '*'})).toEqual([]);
      // The completeness check reports a profile that does not apply.
      expect(underOps('spanner', SUM, {metricsExclude: ['m', 'other']}))
          .toEqual([]);
      expect(underOps('spanner', SUM)).toEqual([
        "model 'commerce' (commerce) deployment 'spanner' targets Spanner, " +
            "which has no measures, and profile 'ops' leaves metric(s) 'm' " +
            "available; name them in its 'metrics_exclude', or set it to \"*\".",
      ]);
    });

    test('a BigQuery deployment holds each metric its profile leaves to the measure rules, with the keys the profile states', () => {
      const spread = '{ name: m, entity: purchase, ' +
          'expression: "STDDEV(purchase.amount)" }';
      // A metric the profile excludes, or prunes for a field it excludes, is
      // held to none of this.
      expect(underOps('bigquery', spread, {metricsExclude: ['m']})).toEqual([]);
      const noAmount =
          {entities: [{name: 'purchase', fieldsExclude: ['amount']}]};
      expect(underOps('bigquery', spread, noAmount)).toEqual([]);
      expect(underOps('bigquery', spread)).toEqual([
        "model 'commerce' (commerce) deployment 'bigquery' targets BigQuery, " +
            "where metric 'm' cannot be a measure: it uses STDDEV, which " +
            'BigQuery does not allow in a measure (SUM, AVG, COUNT, MIN, MAX).',
      ]);
      // Purchase has no key in the model file, and profile ops states one.
      const keyed = {entities: [{name: 'purchase', primaryKey: ['p_id']}]};
      expect(underOps('bigquery', SUM, keyed, [])).toEqual([]);
      expect(underOps('bigquery', SUM, {}, [])).toEqual([
        "model 'commerce' (commerce) deployment 'bigquery' targets BigQuery, " +
        "and profile 'ops' leaves entity 'purchase' without a primary_key; a " +
        'BigQuery graph deployment needs a primary_key on every concrete ' +
        "leaf entity, so state primary_key for the entity in profile 'ops'.",
      ]);
    });

    test('a deployment whose profile is a legacy wrapper is left out', () => {
      const m = commerce(
          {customer: false, deployments: deployment('bigquery', 'old')});
      expect(check(m)).toEqual([]);
    });
  });

  // The names a BigQuery or Spanner graph holds once, and the OPTIONS BigQuery
  // limits on each label and property kcmd writes.
  describe('graph names and BigQuery OPTIONS', () => {
    const x = (n: number) => 'x'.repeat(n);
    const synonyms = (n: number) => [...Array(n).keys()].map(String);
    // The errors of the model with metric revenue on `deployments`, after
    // `change`.
    const errorsAfter =
        (change: (m: SemanticModel) => void, deployments = BQ) => {
          const m = commerce({
            deployments,
            metric: '{ name: revenue, entity: purchase, expression: ' +
                '"SUM(purchase.amount)" }',
          });
          change(m);
          return check(m);
        };
    const IN = (problem: string, engine = 'BigQuery',
                deployment = engine.toLowerCase()) =>
        `model 'commerce' (commerce) deployment '${deployment}' targets ` +
        `${engine}, where ${problem}`;
    const NINE = "field 'purchase.amount' has 9 synonyms; a label or " +
        'property holds at most 8.';

    test('rejects an entity and a relationship named alike ignoring case on a BigQuery or Spanner graph', () => {
      expect(errorsAfter(m => m.relationships[0].name = 'Customer',
                          BQ + deployment('spanner') + deployment('alloydb')))
          .toEqual(['BigQuery', 'Spanner'].map(
              engine => IN("entity 'customer' and relationship 'Customer' " +
                               'cannot both name a table: node and edge ' +
                               'tables share one set of names, compared ' +
                               'ignoring case; rename one.',
                           engine)));
    });

    // A field of the metric's own entity is left to another check. A field
    // the deployment's profile excludes, or one of an entity with no key, is
    // not in the graph.
    test('rejects on BigQuery a metric named like a field of another entity', () => {
      // Under profile ops, which excludes `excluded` from customer, when
      // `excluded` is given.
      const named =
          (name: string, customerKeys = ['c_id'], excluded?: string[]) =>
              errorsAfter(m => {
                m.metrics![0].name = name;
                m.entities[0].keys = customerKeys;
                m.profiles = [{
                  name: 'ops', relationships: [],
                  entities: [{name: 'customer', fieldsExclude: excluded}],
                }];
              }, excluded ? deployment('bigquery', 'ops') : BQ);
      const SHARED = (metric: string, field: string) => IN(
          `metric '${metric}' cannot share its name with field '${field}': ` +
          "a measure's name must differ from every property name in the " +
          'graph, compared ignoring case; rename one.');
      expect(named('C_ID')).toEqual([SHARED('C_ID', 'customer.c_id')]);
      expect(named('C_NAME', ['c_id'], []))
          .toEqual([SHARED('C_NAME', 'customer.c_name')]);
      for (const [name, keys, excluded] of [
             ['Amount'], ['C_NAME', ['c_id'], ['c_name']],
           ] as Array<[string, string[]?, string[]?]>) {
        expect({name, errors: named(name, keys, excluded)})
            .toEqual({name, errors: []});
      }
      // An entity with no primary_key is not in the graph, so it gets only the
      // missing-primary_key error and no property-name collision.
      expect(named('C_ID', [])).toEqual([
        `${OWN('bigquery')}which leave entity 'customer' without a ` +
        'primary_key; a BigQuery graph deployment needs a primary_key on ' +
        'every concrete leaf entity. Declare primary_key on the entity, or ' +
        'use a named profile that states one.',
      ]);
    });

    // With the catalog check's errors after the graph checks'.
    const withCatalog = (change: (m: SemanticModel) => void) => {
      let model: SemanticModel;
      const errors = errorsAfter(m => change(model = m));
      return [
        ...errors, ...validatePushRequirements([loaded(model!, 'commerce')]),
      ];
    };
    const LONG = (what: string, n = 1025) => IN(
        `the description kcmd writes for ${what} is ${n} characters long; ` +
        "a label or property's description holds at most 1024.");
    const timeField = {dimension: {isTime: true}, description: x(1000)};
    test.each<[string, (m: SemanticModel) => void, string[]]>([
      ['past 1024 characters, counting what kcmd adds to a field', m => {
        m.entities[0].description = x(1025);
        Object.assign(
            m.entities[1].fields[1], {label: 'Amount', description: x(1017)});
        m.relationships[0].description = x(1025);
        m.metrics![0].description = x(1025);
      }, [
        "entity 'customer'", "field 'purchase.amount'",
        "relationship 'placed_by'", "metric 'revenue'",
      ].map(what => LONG(what))],
      ['at 1024 characters alongside instructions and examples', m => {
        Object.assign(m.entities[0], {
          description: x(1024),
          aiContext: {instructions: 'Exclude test accounts.', examples: ['a']},
        });
        Object.assign(m.entities[1].fields[1], {
          label: 'Amount',
          description: x(1016),
          aiContext: {instructions: 'Net of tax.', examples: ['100.00']},
        });
        Object.assign(m.relationships[0], {
          description: x(1024),
          aiContext: {instructions: 'Join key.', examples: ['placed by']},
        });
        Object.assign(m.metrics![0], {
          description: x(1024),
          aiContext: {instructions: 'Completed only.', examples: ['revenue?']},
        });
      }, []],
      ['of a field with a label and a time role', m => {
        Object.assign(m.entities[1].fields[1], {...timeField, label: 'Amount'});
      }, [LONG("field 'purchase.amount'")]],
      ['of a field with a time role and no label', m => {
        Object.assign(m.entities[1].fields[1], timeField);
      }, []],
      ['of 2001 characters, which Knowledge Catalog rejects too', m => {
        m.entities[0].description = x(2001);
      }, [
        LONG("entity 'customer'", 2001),
        "model 'commerce' (commerce): the description of entity 'customer' " +
            "is 2001 characters long; a Knowledge Catalog entry's " +
            'description holds at most 2000.',
      ]],
    ])('a description %s', (_, change, errors) =>
        expect(withCatalog(change)).toEqual(errors));

    test('rejects too many, too long, empty, repeated and self-naming synonyms', () => {
      expect(errorsAfter(m => {
        m.entities[0].aiContext = {synonyms: ['Customer']};
        m.entities[1].fields[1].aiContext = {synonyms: synonyms(9)};
        m.relationships[0].aiContext = {synonyms: ['Placed_By']};
        m.metrics![0].aiContext =
            {synonyms: [x(301), '', 'sales', 'Revenue', 'SALES']};
      })).toEqual([
        "entity 'customer' has the synonym 'Customer', which BigQuery treats " +
            "as the entity's own name; remove it.",
        NINE,
        "relationship 'placed_by' has the synonym 'Placed_By', which " +
            "BigQuery treats as the relationship's own name; remove it.",
        "a synonym of metric 'revenue' is 301 characters long; a synonym " +
            'holds at most 300.',
        "metric 'revenue' has an empty synonym; remove it.",
        "metric 'revenue' has the synonym 'Revenue', which BigQuery treats " +
            "as the metric's own name; remove it.",
        "metric 'revenue' has the synonyms 'sales' and 'SALES', which " +
            'BigQuery treats as one; remove one.',
      ].map(p => IN(p)));
    });

    const LONG_EXT = (key: 'instructions'|'examples', what: string, n = 1025) =>
        IN(`the ${key} kcmd writes for ${what}${
               key === 'examples' ? ', as a JSON array,' : ''} is ${
               n} characters long; an extension value of a label or property ` +
           'holds at most 1024.');
    const ELEMENTS = [
      "entity 'customer'", "field 'purchase.amount'",
      "relationship 'placed_by'", "metric 'revenue'",
    ];
    const setAiOnEveryKind =
        (m: SemanticModel, aiContext: Entity['aiContext']) => {
          m.entities[0].aiContext = aiContext;
          m.entities[1].fields[1].aiContext = aiContext;
          m.relationships[0].aiContext = aiContext;
          m.metrics![0].aiContext = aiContext;
        };
    test.each<[string, Entity['aiContext'], string[]]>([
      ['of instructions past 1024 characters', {instructions: x(1025)},
       ELEMENTS.map(what => LONG_EXT('instructions', what))],
      // Two 510-character items serialize to `["...","..."]`, 1,027 characters.
      ['of examples past 1024 characters as a JSON array',
       {examples: [x(510), x(510)]},
       ELEMENTS.map(what => LONG_EXT('examples', what, 1027))],
      ['of examples at 1024 characters as a JSON array', {examples: [x(1020)]},
       []],
      ['of padded instructions that fit within 1024 characters after trimming',
       {instructions: `  ${x(1024)}\n`}, []],
    ])('an extension value %s', (_, aiContext, errors) =>
        expect(errorsAfter(m => setAiOnEveryKind(m, aiContext)))
            .toEqual(errors));

    test("checks the description, synonyms and extensions of a many-to-many edge's fields", () => {
      expect(errorsAfter(m => {
        m.relationships[0].association = {
          dataSource: 'p.d.customer_purchases',
          keys: ['id'],
          sourceColumns: ['p_id'],
          destinationColumns: ['c_id'],
          fields: [
            {
              name: 'tier',
              expression: 'tier',
              label: 'Tier',
              description: x(1019),
              aiContext: {
                synonyms: ['Tier', ...synonyms(8)],
                instructions: x(1025),
                examples: [x(1023)],
              },
            },
            // An unbound association field renders as a bare column with its
            // OPTIONS, while a vendor-only field is omitted from the edge.
            {name: 'role', description: x(1025)},
            {
              name: 'sf',
              dialects: [{dialect: 'SNOWFLAKE', expression: 'x'}],
              aiContext: {instructions: x(1025), synonyms: synonyms(9)},
            },
          ],
        };
      })).toEqual([
        LONG("field 'placed_by.tier'"),
        IN("field 'placed_by.tier' has 9 synonyms; a label or property holds " +
           'at most 8.'),
        IN("field 'placed_by.tier' has the synonym 'Tier', which BigQuery " +
           "treats as the field's own name; remove it."),
        LONG_EXT('instructions', "field 'placed_by.tier'"),
        LONG_EXT('examples', "field 'placed_by.tier'", 1027),
        LONG("field 'placed_by.role'"),
      ]);
    });

    // An abstract entity has no node table, a label another entity extends
    // carries no OPTIONS, and a field with no BigQuery text is left out. An
    // entity another extends has no node table even when its only subtype is
    // abstract, so neither its description nor its fields reach the graph.
    test('passes values at the limits and elements the graph writes no OPTIONS for', () => {
      expect(errorsAfter(m => {
        m.relationships[0].description = x(1024);
        m.entities[1].fields[1].aiContext = {synonyms: synonyms(8)};
        m.metrics![0].aiContext = {synonyms: [x(300)]};
        m.entities.push({
          name: 'party', abstract: true, dataSource: '', keys: [], fields: [],
          description: x(2000), aiContext: {instructions: x(1025)},
        }, {...m.entities[0], name: 'vip', extends: ['customer']}, {
          name: 'region', dataSource: 'p.d.region', keys: ['id'],
          description: x(2000), aiContext: {instructions: x(1025)},
          fields: [
            {name: 'id', expression: 'id'},
            {name: 'revenue', expression: 'revenue', description: x(2000)},
          ],
        }, {
          name: 'area', abstract: true, dataSource: '', keys: [], fields: [],
          extends: ['region'],
        });
        m.entities[0].description = x(2000);
        m.entities[0].aiContext = {instructions: x(1025)};
        m.entities[1].fields.push({
          name: 'sf', dialects: [{dialect: 'SNOWFLAKE', expression: 'x'}],
          aiContext: {synonyms: synonyms(9), instructions: x(1025)},
        });
      })).toEqual([]);
    });

    test('checks only BigQuery deployments, each without the fields its profile excludes', () => {
      const nine = (m: SemanticModel) => {
        m.entities[1].fields[1].aiContext = {synonyms: synonyms(9)};
        m.profiles = [{
          name: 'ops', relationships: [],
          entities: [{name: 'purchase', fieldsExclude: ['amount']}],
        }];
      };
      expect(errorsAfter(nine, '')).toEqual([]);
      expect(errorsAfter(nine, deployment('spanner'))).toEqual([]);
      expect(errorsAfter(
                 nine, deployment('bigquery', 'ops') +
                     `      - name: dev\n        target: ${BQ_TARGET}2\n`))
          .toEqual([IN(NINE, 'BigQuery', 'dev')]);
    });
  });

  describe('graph primary_key and BigQuery join-key rules', () => {
    const allEngines = BQ + deployment('spanner') + deployment('alloydb');
    const otherEngines = deployment('spanner') + deployment('alloydb');
    const KEYLESS =
        (engine: 'bigquery'|'spanner', entities: string, each = 'the entity') =>
            `${OWN(engine)}which leave ${entities} without a primary_key; a ` +
        `${engine === 'bigquery' ? 'BigQuery' : 'Spanner'} graph deployment ` +
        'needs a primary_key on every concrete leaf entity. Declare ' +
        `primary_key on ${each}, or use a named profile that states one.`;
    const NAMED_KEYLESS =
        (engine: 'BigQuery'|'Spanner', entities = "entity 'purchase'",
         each = 'the entity') =>
            `model 'commerce' (commerce) deployment '${engine.toLowerCase()}' ` +
        `targets ${engine}, and profile 'ops' leaves ${entities} without a ` +
        `primary_key; a ${engine} graph deployment needs a primary_key on ` +
        `every concrete leaf entity, so state primary_key for ${each} in ` +
        "profile 'ops'.";
    // The end of the error for a join that does not match `pk`, the
    // primary_key of customer.
    const MISMATCH = (pk = '["c_id"]') =>
        `do not match primary_key ${pk} of 'customer'; a BigQuery graph edge ` +
        "must join on its target's primary_key columns, in any order, and " +
        'not on a unique key or extra columns.';
    // The errors for relationship placed_by joining on `to`, which does not
    // match `pk`: under the model file's own bindings of deployments `engine`,
    // and under profile ops on BigQuery.
    const INLINE_JOIN = (engine: Engine|Engine[], to: string, pk?: string) =>
        `${OWN(engine)}under which relationship 'placed_by' joins on ` +
        `to_columns ${to}, which ${MISMATCH(pk)}`;
    const NAMED_JOIN = (to: string) =>
        "model 'commerce' (commerce) deployment 'bigquery' targets BigQuery, " +
        "and profile 'ops' joins relationship 'placed_by' on to_columns " +
        `${to}, which ${MISMATCH()}`;

    // Customer has primary_key, and purchase has no primary_key. BigQuery and
    // Spanner reject purchase; AlloyDB and a catalog-only push accept it.
    test.each([
      ['neither key', {keys: [] as string[]}],
      ['an empty unique key', {keys: [] as string[], uniqueKeys: [[]]}],
      ['only unique_keys', {keys: [] as string[], uniqueKeys: [['p_id']]}],
    ])('rejects a concrete leaf entity with %s on BigQuery and Spanner, and ' +
           'allows it on AlloyDB and catalog-only',
       (_, over) => {
         const deployed = commerce({deployments: allEngines});
         Object.assign(deployed.entities[1], over);
         expect(check(deployed)).toEqual([
           KEYLESS('bigquery', "entity 'purchase'"),
           KEYLESS('spanner', "entity 'purchase'"),
         ]);

         for (const deployments of ['', deployment('alloydb')]) {
           const m = commerce({deployments});
           Object.assign(m.entities[1], over);
           expect(check(m)).toEqual([]);
           expect(validatePushRequirements([loaded(m, 'commerce')]))
               .toEqual([]);
         }
       });

    test('names every keyless concrete leaf entity on BigQuery and Spanner, ' +
             'and skips abstract entities and concrete supertypes',
         () => {
           const multi = commerce({deployments: allEngines});
           multi.entities[0].keys = [];
           multi.entities[0].uniqueKeys = [['c_id']];
           multi.entities[1].keys = [];
           multi.entities.push(
               {
                 name: 'party',
                 abstract: true,
                 dataSource: '',
                 keys: [],
                 fields: [],
               },
               {
                 name: 'account',
                 dataSource: BQ_TABLE('account'),
                 keys: [],
                 fields: [{name: 'id', expression: 'id'}],
               },
               {
                 name: 'premium',
                 extends: ['account'],
                 dataSource: BQ_TABLE('premium'),
                 keys: ['id'],
                 fields: [{name: 'id', expression: 'id'}],
               });
           expect(check(multi)).toEqual([
             KEYLESS(
                 'bigquery', "entities 'customer' and 'purchase'",
                 'each entity'),
             KEYLESS(
                 'spanner', "entities 'customer' and 'purchase'",
                 'each entity'),
           ]);

           multi.entities[0].keys = ['c_id'];
           multi.entities[1].keys = ['p_id'];
           expect(check(multi)).toEqual([]);
         });

    test('rejects a relationship joining onto unique_keys on BigQuery only, ' +
             'and allows it on Spanner, AlloyDB and catalog-only',
         () => {
           const withUkJoin = (deployments = '') => {
             const m = commerce({deployments});
             m.entities[0].uniqueKeys = [['c_email']];
             m.relationships[0].destination.columns = ['c_email'];
             return m;
           };
           expect(check(withUkJoin(allEngines))).toEqual([
             INLINE_JOIN('bigquery', '["c_email"]'),
           ]);

           for (const deployments of ['', otherEngines]) {
             const m = withUkJoin(deployments);
             expect(check(m)).toEqual([]);
             expect(validatePushRequirements([loaded(m, 'commerce')]))
                 .toEqual([]);
           }

           const profiledUk = commerce({
             deployments: deployment('bigquery', 'ops') +
                 deployment('spanner', 'ops') + deployment('alloydb', 'ops'),
           });
           profiledUk.entities[0].uniqueKeys = [['c_email']];
           profiledUk.profiles = [{
             name: 'ops',
             entities: [],
             relationships: [{
               name: 'placed_by',
               fromColumns: ['p_customer'],
               toColumns: ['c_email'],
             }],
           }];
           expect(check(profiledUk)).toEqual([NAMED_JOIN('["c_email"]')]);
         });

    test('enforces primary_key on concrete leaf entities under named ' +
             'profiles on BigQuery and Spanner, allows AlloyDB, and skips ' +
             'concrete supertypes',
         () => {
           const m = commerce({
             deployments: deployment('bigquery', 'ops') +
                 deployment('spanner', 'ops') + deployment('alloydb', 'ops'),
           });
           m.entities[1].keys = [];
           m.profiles = [{
             name: 'ops',
             entities: [{name: 'purchase', uniqueKeys: [['p_id']]}],
             relationships: [],
           }];
           expect(check(m)).toEqual([
             NAMED_KEYLESS('BigQuery'),
             NAMED_KEYLESS('Spanner'),
           ]);

           const alloyOnly =
               commerce({deployments: deployment('alloydb', 'ops')});
           alloyOnly.entities[1].keys = [];
           alloyOnly.profiles = m.profiles;
           expect(check(alloyOnly)).toEqual([]);

           // When another entity extends purchase, purchase is not a leaf and
           // needs no primary_key on BigQuery or Spanner.
           const withChild = commerce({
             deployments: deployment('bigquery', 'ops') +
                 deployment('spanner', 'ops') + deployment('alloydb', 'ops'),
           });
           withChild.entities[1].keys = [];
           withChild.entities.push({
             ...withChild.entities[1],
             name: 'online_purchase',
             extends: ['purchase'],
             keys: ['p_id'],
           });
           withChild.profiles = m.profiles;
           expect(check(withChild)).toEqual([]);

           m.profiles = [{
             name: 'ops',
             entities: [{name: 'purchase', primaryKey: ['p_id']}],
             relationships: [],
           }];
           expect(check(m)).toEqual([]);
         });

    // A superset of a key covers it, so every non-BigQuery target accepts the
    // join, while a BigQuery graph edge must join on its target's primary_key
    // alone.
    test('rejects to_columns that add a column to primary_key on BigQuery ' +
             'only, inline and under a named profile, and allows them on ' +
             'Spanner, AlloyDB and catalog-only',
         () => {
           const TO = '["c_id","c_region"]';
           const withSuperset = (deployments = '') => {
             const m = commerce({deployments});
             m.relationships[0].source.columns = ['p_customer', 'p_region'];
             m.relationships[0].destination.columns = ['c_id', 'c_region'];
             return m;
           };
           expect(check(withSuperset(allEngines)))
               .toEqual([INLINE_JOIN('bigquery', TO)]);

           // A primary_key column named twice, ignoring case, is no match
           // either.
           const repeated = commerce({deployments: BQ});
           repeated.relationships[0].source.columns = ['p_customer', 'p_buyer'];
           repeated.relationships[0].destination.columns = ['c_id', 'C_ID'];
           expect(check(repeated))
               .toEqual([INLINE_JOIN('bigquery', '["c_id","C_ID"]')]);

           for (const m of [withSuperset(), withSuperset(otherEngines)]) {
             expect(check(m)).toEqual([]);
             expect(validatePushRequirements([loaded(m, 'commerce')]))
                 .toEqual([]);
           }

           const profiled = commerce({
             deployments: deployment('bigquery', 'ops') +
                 deployment('spanner', 'ops') + deployment('alloydb', 'ops'),
           });
           profiled.profiles = [{
             name: 'ops',
             entities: [],
             relationships: [{
               name: 'placed_by',
               fromColumns: ['p_customer', 'p_region'],
               toColumns: ['c_id', 'c_region'],
             }],
           }];
           expect(check(profiled)).toEqual([NAMED_JOIN(TO)]);
         });

    // Customer is keyed by c_id and c_region, and c_email is unique.
    test('accepts to_columns that name a composite primary_key in another ' +
             'order, and rejects ones that cover a unique key and part of it ' +
             'on BigQuery only',
         () => {
           const PK = '["c_id","c_region"]';
           const joined = (from: string[], to: string[], deployments = '') => {
             const m = commerce({deployments});
             m.entities[0].keys = ['c_id', 'c_region'];
             m.entities[0].uniqueKeys = [['c_email']];
             m.relationships[0].source.columns = from;
             m.relationships[0].destination.columns = to;
             return m;
           };
           const reordered = [['p_region', 'p_customer'], ['c_region', 'C_ID']];
           const partial = [['p_email', 'p_customer'], ['c_email', 'c_id']];
           expect(check(joined(reordered[0], reordered[1], allEngines)))
               .toEqual([]);
           expect(check(joined(partial[0], partial[1], allEngines))).toEqual([
             INLINE_JOIN('bigquery', '["c_email","c_id"]', PK),
           ]);
           expect(check(joined(partial[0], partial[1], otherEngines)))
               .toEqual([]);
         });

    // Keys are not inherited: each node table is keyed by its own leaf
    // entity's primary_key.
    test('rejects a keyless concrete leaf subtype of a keyed concrete ' +
             'supertype or of an abstract one on BigQuery and Spanner',
         () => {
           const withSubtypes = (deployments: string) => {
             const m = commerce({deployments});
             m.entities.push(
                 {
                   name: 'person', dataSource: BQ_TABLE('person'), keys: ['id'],
                   fields: [{name: 'id', expression: 'id'}],
                 },
                 {
                   name: 'employee', dataSource: BQ_TABLE('employee'), keys: [],
                   extends: ['person'],
                   fields: [{name: 'id', expression: 'e_id'}],
                 },
                 {
                   name: 'party', abstract: true, dataSource: '', keys: [],
                   fields: [{name: 'code'}],
                 },
                 {
                   name: 'member', dataSource: BQ_TABLE('member'), keys: [],
                   extends: ['party'],
                   fields: [{name: 'code', expression: 'code'}],
                 });
             return m;
           };
           const m = withSubtypes(allEngines);
           expect(check(m)).toEqual([
             KEYLESS(
                 'bigquery', "entities 'employee' and 'member'", 'each entity'),
             KEYLESS(
                 'spanner', "entities 'employee' and 'member'", 'each entity'),
           ]);

           expect(check(withSubtypes(deployment('alloydb')))).toEqual([]);
           m.entities.find(e => e.name === 'employee')!.keys = ['e_id'];
           m.entities.find(e => e.name === 'member')!.keys = ['code'];
           expect(check(m)).toEqual([]);
         });
  });

  // Spanner compares names ignoring case.
  describe('Spanner graphs', () => {
    const table = (t: string) =>
        SPANNER_TARGET.replace(/graphs\/g$/, `tables/${t}`);
    // Entities employee and purchase on tables employees and Order, each with
    // a field of the name, datatype and expression `fields` gives, in a graph
    // named `graph`. The expression is `c` unless given.
    const graphOf =
        (graph: string, fields = [['code', 'String'], ['code', 'String']]) =>
            check(loadOne('commerce', `    deployments:
      - { name: sp, target: ${SPANNER_TARGET.replace(/g$/, graph)} }
    entities:
${['employee', 'purchase'].map((e, i) => `      - name: ${e}
        source: ${table(['employees', 'Order'][i])}
        primary_key: [id]
        fields:
          - { name: id, datatype: Integer, expression: id }
          - { name: ${fields[i][0]}, datatype: ${fields[i][1]}, expression: ${
              JSON.stringify(fields[i][2] ?? 'c')} }
`).join('')}`));
    const IN = (problem: string) =>
        `model 'commerce' (commerce) deployment 'sp' targets Spanner${problem}`;

    test('refuses a graph name Spanner does not accept or that names a table the graph reads, ignoring case', () => {
      const name = (g: string) => IN(
          ` graph '${g}', but a Spanner graph name starts with a letter, ` +
          'holds only letters, digits and underscores, and is at most 128 ' +
          'characters long; rename the graph in the target.');
      const long = `g${'x'.repeat(128)}`;
      for (const g of ['my-graph', '1graph', '_g', long]) {
        expect(graphOf(g)).toEqual([name(g)]);
      }
      expect(graphOf('ORDER')).toEqual([IN(
          " graph 'ORDER', which has the name of table 'Order' that entity " +
          "'purchase' reads; a graph cannot share its name with a table of " +
          'its database, compared ignoring case. Rename the graph in the ' +
          'target.')]);
      for (const g of ['g_1', 'select', long.slice(1)]) {
        expect({g, errors: graphOf(g)}).toEqual({g, errors: []});
      }
    });

    // Spanner types a property by its expression, which the live check reads.
    test('accepts a property that two tables declare with different datatypes', () => {
      expect(graphOf('g', [['score', 'Decimal'], ['score', 'Float']]))
          .toEqual([]);
    });

    test('refuses a property expression that holds a subquery', () => {
      const subquery = (owners: string) => IN(
          `, where property 'code' of ${owners} holds a subquery, which ` +
          'Spanner refuses in a property expression; write the expression ' +
          'without a subquery.');
      for (const [expression, other, errors] of [
             ['(SELECT MAX(c) FROM t)', 'c', [subquery("entity 'employee'")]],
             ['EXISTS (SELECT 1 FROM t)', 'c', [subquery("entity 'employee'")]],
             ['c IN (SELECT c FROM t)', 'c', [subquery("entity 'employee'")]],
             ['ARRAY(SELECT c FROM t)', 'c', [subquery("entity 'employee'")]],
             // A property of one SQL in two tables is reported once.
             ['(SELECT 1)', '(SELECT 1)',
              [subquery("entity 'employee' and entity 'purchase'")]],
             ['c IN (1, 2)', 'c', []],
           ] as Array<[string, string, string[]]>) {
        expect({expression, errors: graphOf('g', [
                  ['code', 'String', expression], ['code', 'String', other],
                ])}).toEqual({expression, errors});
      }
    });
  });
});

describe('validateInlineDialects', () => {
  const SPANNER_DB = 'spanner.googleapis.com/projects/p/instances/i/databases/db';
  const SPANNER_TABLE = `${SPANNER_DB}/tables/t`;
  // A model whose entity `e` reads `source` and has field `f` with
  // `expression`, written as YAML. `extra` is the YAML of more entities. The
  // load has the dialect a lookup gave the Spanner database, or none, and the
  // dialects `looked` gives other sources.
  const withField = (source: string, expression: string, extra = '',
                     spanner: string|null = 'SPANNER',
                     looked: Array<[string, string]> = []) =>
      loadOne('m', `    entities:
      - name: e
        source: ${source}
        primary_key: [id]
        fields:
          - { name: id, expression: id }
          - { name: f, expression: ${expression} }
${extra}`, {sourceDialects: new Map([
        ...spanner ? [[SPANNER_DB, spanner] as [string, string]] : [], ...looked])});
  const dialects = (...entries: string[]) =>
      `{ dialects: [${entries.map(e => `{ dialect: ${e}, expression: x }`)}] }`;
  const check = (m: SemanticModel) => validateInlineDialects(m, 'doc', {});
  // The error for field `f` of `entity`, whose source has `dialect`, ending
  // in `hint`. `a` is the article before the dialect.
  const MISSING =
      (entity: string, dialect: string, hint = '; give it one', a = 'a') =>
      `field '${entity}.f' in model 'm' (doc) has no expression for ${
          dialect} or ANSI_SQL, and the model file binds entity '${
          entity}' to ${a} ${dialect} source${hint}.`;
  const HINT = "; give it one, or add one with 'kcmd import <file> " +
      "--input first-party --flavor google --transpile'";
  // The error for a model file whose entities `a` and `b` are in two
  // databases.
  const TWO_DATABASES = (a: string, b: string) => expect.stringContaining(
      `binds entities in more than one database ('${a}', '${b}')`);
  // The YAML of entity `c` on `source`.
  const second = (source: string) => `      - { name: c, source: ${source},
          primary_key: [id], fields: [{ name: id, expression: id }] }\n`;
  const entry = (group: string) =>
      `projects/p/locations/l/entryGroups/${group}/entries/t`;
  // A Snowflake table and a Databricks table, each looked up.
  const thirdParty: Array<[string, string]> =
      [[entry('sf'), 'SNOWFLAKE'], [entry('dbx'), 'DATABRICKS']];

  // A bound field needs a text for its source's dialect, an ANSI_SQL text, or
  // the string form. An inherited field is judged by the source of the entity
  // that inherits it. The model file's tables are all in one database, as a
  // profile's are, and a model file in two databases gets only that error.
  test('holds each bound field to the dialect of its own entity\'s source, suggests kcmd import --transpile only for a text it translates, and holds the tables to one database', () => {
    const bigQueryText = dialects('BIGQUERY');
    // Entity `other` on Spanner has field `f` with only a BigQuery text, and
    // entity `leaf` on Spanner inherits `f` from `e`.
    const other = `      - { name: other, source: ${SPANNER_TABLE},
          primary_key: [id], fields: [{ name: id, expression: id },
            { name: f, expression: ${bigQueryText} }] }\n`;
    const leaf = `      - { name: leaf, extends: [e], source: ${SPANNER_TABLE},
          primary_key: [id], fields: [{ name: id, expression: id }] }\n`;
    const alloyDb = `${TARGET.alloydb}/schemas/s/tables/t`;
    const cases: Array<[source: string, expression: string, extra: string,
                        errors: string[], looked?: Array<[string, string]>]> = [
      [SPANNER_TABLE, bigQueryText, '', [MISSING('e', 'SPANNER')]],
      [SPANNER_TABLE, dialects('SPANNER'), '', []],
      [SPANNER_TABLE, dialects('BIGQUERY', 'ANSI_SQL'), '', []],
      [SPANNER_TABLE, 'x', '', []],
      [SPANNER_TABLE, bigQueryText, leaf,
       [MISSING('e', 'SPANNER'), MISSING('leaf', 'SPANNER')]],
      [BQ_TABLE('t'), dialects('SNOWFLAKE'), other, [TWO_DATABASES('e', 'other')]],
      // The message reads "an" before a dialect that starts with a vowel.
      [alloyDb, bigQueryText, '', [MISSING('e', 'ALLOYDB', undefined, 'an')]],
      // kcmd import --transpile translates a Snowflake, Spanner or AlloyDB
      // text into BigQuery SQL, so only a BigQuery source gets the hint.
      [BQ_TABLE('t'), dialects('SNOWFLAKE'), '', [MISSING('e', 'BIGQUERY', HINT)]],
      [SPANNER_TABLE, dialects('SNOWFLAKE'), '', [MISSING('e', 'SPANNER')]],
      [BQ_TABLE('t'), dialects('SPANNER'), '', [MISSING('e', 'BIGQUERY', HINT)]],
      [BQ_TABLE('t'), dialects('ALLOYDB'), '', [MISSING('e', 'BIGQUERY', HINT)]],
      // BigQuery and BigLake are one database. A Snowflake table and a
      // Databricks table are in two.
      [BQ_TABLE('t'), 'x',
       second('biglake.googleapis.com/projects/p/catalogs/c/namespaces/n/tables/t'),
       []],
      [entry('sf'), 'x', second(entry('dbx')), [TWO_DATABASES('e', 'c')], thirdParty],
    ];
    for (const [source, expression, extra, errors, looked] of cases) {
      const actual =
          check(withField(source, expression, extra, undefined, looked));
      expect({source, expression, extra, errors: actual})
          .toEqual({source, expression, extra, errors});
    }
    // A Spanner table takes its database's dialect, and one no lookup read is
    // not judged.
    expect(check(withField(SPANNER_TABLE, dialects('SPANNER'), '', 'POSTGRES')))
        .toEqual([MISSING('e', 'POSTGRES')]);
    expect(check(withField(SPANNER_TABLE, bigQueryText, '', null))).toEqual([]);
    // An unsupported dialect on an in-memory model is not translated.
    const unsupported = withField(BQ_TABLE('t'), dialects('SNOWFLAKE'));
    unsupported.entities[0].fields[1] = {
      name: 'f',
      importedExpression: 'x',
      importedDialect: 'TERADATA',
    };
    expect(check(unsupported)).toEqual([MISSING('e', 'BIGQUERY')]);
    // An unbound field and an entity with no source are skipped.
    const unbound = withField(SPANNER_TABLE, bigQueryText);
    unbound.entities[0].fields[1] = {name: 'f'};
    expect(check(unbound)).toEqual([]);
    const noSource = withField(SPANNER_TABLE, bigQueryText);
    noSource.entities[0].dataSource = '';
    delete noSource.entities[0].authoredSource;
    expect(check(noSource)).toEqual([]);
  });
});

// Customer inherits field `label`, which reads the double-quoted column
// "p_name", from Party on another table of one PostgreSQL-dialect database.
// An entity with no source leaves the model file's dialect to the others.
test('validateInheritedColumns reads an inherited field in the dialect of the tables the model file binds', () => {
  const cloudSql = (t: string) =>
      `cloudsql.googleapis.com/projects/p/locations/l/instances/i/databases/d/schemas/public/tables/${t}`;
  const spanner = 'spanner.googleapis.com/projects/p/instances/i/databases/db';
  const entry = (t: string) => `projects/p/locations/l/entryGroups/g/entries/${t}`;
  const sourceless = '      - {name: Order, primary_key: [id], fields: [{name: id, expression: id}]}\n';
  // [label, table of each entity, key of each table's looked-up POSTGRES dialect, Order]
  const cases: Array<[string, (t: string) => string, (t: string) => string|undefined, string]> = [
    ['Cloud SQL', cloudSql, cloudSql, sourceless],
    ['AlloyDB', t => `${TARGET.alloydb}/schemas/public/tables/${t}`, () => undefined, sourceless],
    ['Spanner', t => `${spanner}/tables/${t}`, () => spanner, sourceless],
    ['third-party', entry, entry, sourceless],
    ['Cloud SQL, abstract Order', cloudSql, cloudSql,
     '      - {name: Order, abstract: true, fields: [{name: id}]}\n'],
  ];
  for (const [label, table, key, order] of cases) {
    const looked = ['party', 'customer'].flatMap(
        t => key(t) ? [[key(t)!, 'POSTGRES'] as [string, string]] : []);
    const m = loadOne('shop', `    datasets:
      - {name: Party, source: ${table('party')}, primary_key: [id],
         fields: [{name: id, expression: id}, {name: label, expression: '"p_name"'}]}
      - {name: Customer, extends: [Party], source: ${table('customer')},
         primary_key: [id], fields: [{name: id, expression: id}]}
${order}`, {sourceDialects: new Map(looked)});
    expect({label, errors: validateInheritedColumns(m, 'shop')}).toEqual({label, errors: [
      "entity 'Customer' in model 'shop' (shop): field 'label' is inherited from 'Party', whose " +
          "expression reads column 'p_name' of that entity's table; restate it with an " +
          "expression for this entity's table."]});
  }
});

// The tables' database runs the inherited field's entry for its dialect, so
// only that text's column counts: here Spanner's, beside a BIGQUERY text that
// reads p_name.
test.each([
  ["'x'", []],
  ['p_sp', ["entity 'Customer' in model 'shop' (shop): field 'label' is inherited from " +
            "'Party', whose expression reads column 'p_sp' of that entity's table; " +
            "restate it with an expression for this entity's table."]],
])('validateInheritedColumns on Spanner tables reads the SPANNER text %s', (text, errors) => {
  const spanner = 'spanner.googleapis.com/projects/p/instances/i/databases/db';
  const label = `{dialects: [{dialect: BIGQUERY, expression: p_name}, {dialect: SPANNER, expression: "${text}"}]}`;
  const m = loadOne('shop', `    entities:
      - {name: Party, source: ${spanner}/tables/party, primary_key: [id],
         fields: [{name: id, expression: id}, {name: label, expression: ${label}}]}
      - {name: Customer, extends: [Party], source: ${spanner}/tables/customer,
         primary_key: [id], fields: [{name: id, expression: id}]}
`, {sourceDialects: new Map([[spanner, 'SPANNER']])});
  expect(validateInheritedColumns(m, 'shop')).toEqual(errors);
});
