// Behavior spec for the push-time validation gate
// (src/libts/semantic/validate.ts).

import {describe, expect, test} from 'bun:test';

import {Action, CustomExtension, Entity, Metric, SemanticModel} from '../../../src/libts/semantic/ir';
import {LoadedModel} from '../../../src/libts/semantic/loader';
import {validateBigQueryActionStatements, validateBigQueryDataSources, validatePushRequirements, validateSpannerActionStatements} from '../../../src/libts/semantic/validate';
import {BigQueryClientMock, mockSchema, SpannerClientMock} from '../mocks';

// A parsed BigQuery Graph deployment target the strict matcher accepts.
const BQ_TARGET =
    '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';

// A parsed Spanner Graph deployment target the strict matcher accepts.
const SPANNER_TARGET =
    '//spanner.googleapis.com/projects/p/instances/i/databases/db/propertyGraphs/g';

// A parsed AlloyDB deployment target. Not a graph target: it names a database
// to run against, which is the whole reason a push has to say something other
// than "typo" about it.
const ALLOYDB_TARGET =
    '//alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c/instances/i/databases/db';

function googleExt(targets: string[]): CustomExtension {
  return {
    vendorName: 'GOOGLE',
    data: JSON.stringify({deploymentTargets: targets})
  };
}

function loaded(model: SemanticModel, document = 'doc'): LoadedModel {
  return {document, model};
}

function model(over: Partial<SemanticModel> = {}, exts?: CustomExtension[]):
    SemanticModel {
  return {
    name: 'm',
    entities: [],
    relationships: [],
    metrics: [],
    ...(exts ? {customExtensions: exts} : {}),
    ...over,
  };
}

describe('validatePushRequirements', () => {
  test('a model with a deployment target and resolved metrics passes', () => {
    const m = model(
        {
          metrics:
              [{name: 'rev', expression: 'SUM(o.p)', entity: 'o'} as Metric]
        },
        [googleExt([BQ_TARGET])]);
    expect(validatePushRequirements([loaded(m)])).toEqual([]);
  });

  test('a model with no deployment target is rejected', () => {
    const errs = validatePushRequirements([loaded(model())]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('exactly one');
    expect(errs[0]).toContain('doc');
  });

  test(
      'a BigQuery-target metric that resolves to no entity is rejected', () => {
        const m = model(
            {metrics: [{name: 'cnt', expression: 'COUNT(*)'} as Metric]},
            [googleExt([BQ_TARGET])]);
        const errs = validatePushRequirements([loaded(m)]);
        expect(errs.length).toBe(1);
        expect(errs[0]).toContain('metric \'cnt\'');
        expect(errs[0]).toContain('single entity');
      });

  test('a model with a Spanner Graph deployment target passes', () => {
    // Spanner Graph has no MEASURE, so a metric that does not resolve to one
    // entity is NOT required to (unlike a BigQuery target); the model is valid
    // with only a Spanner target declared.
    const m = model(
        {metrics: [{name: 'cnt', expression: 'COUNT(*)'} as Metric]},
        [googleExt([SPANNER_TARGET])]);
    expect(validatePushRequirements([loaded(m)])).toEqual([]);
  });

  test('an unsupported deployment target is rejected as malformed', () => {
    // A single, otherwise well-formed URI that is neither a BigQuery nor a
    // Spanner Graph target fails because it does not parse as either.
    const m = model(
        {}, [googleExt(['//dataplex.googleapis.com/projects/p/locations/us'])]);
    const errs = validatePushRequirements([loaded(m)]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain(
        'not a valid BigQuery Graph or Spanner Graph URI');
  });

  // An AlloyDB target parses and is supported, and a push still cannot use it:
  // AlloyDB has no property-graph DDL, so there is no graph to publish. The
  // message has to separate that from the malformed case above, because the
  // fix is a different command rather than a corrected URI.
  test('an AlloyDB target is rejected as a store, not as a typo', () => {
    const m = model({}, [googleExt([ALLOYDB_TARGET])]);
    const errs = validatePushRequirements([loaded(m)]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('is an AlloyDB database');
    expect(errs[0]).toContain('runs against rather than deploys to');
    expect(errs[0]).toContain(ALLOYDB_TARGET);
    expect(errs[0]).not.toContain('is not a valid');
  });

  // A Knowledge-Catalog-only push deploys no graph at all, so it has no opinion
  // about the target -- including this one.
  test('an AlloyDB target passes when no graph is being deployed', () => {
    const m = model({}, [googleExt([ALLOYDB_TARGET])]);
    expect(validatePushRequirements([loaded(m)], {targetOptional: true}))
        .toEqual([]);
  });

  test('more than one deployment target is rejected', () => {
    const other =
        '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g2';
    const m = model({}, [googleExt([BQ_TARGET, other])]);
    const errs = validatePushRequirements([loaded(m)]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('exactly one');
  });

  test('malformed GOOGLE extension JSON is reported, not thrown', () => {
    const m = model({}, [{vendorName: 'GOOGLE', data: '{not json'}]);
    const errs = validatePushRequirements([loaded(m)]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('not valid JSON');
  });

  test('errors accumulate across models', () => {
    const a = loaded(model({name: 'a'}), 'a');
    const b = loaded(model({name: 'b'}), 'b');
    const errs = validatePushRequirements([a, b]);
    expect(errs.length).toBe(2);
  });

  test(
      'targetOptional accepts a model with no deployment target (KC-only)',
      () => {
        // A Knowledge-Catalog-only push governs the logical model and deploys
        // no graph, so it needs no deployment target. The same model without
        // the option is rejected (proving the option is what relaxed it).
        const m = model();
        expect(validatePushRequirements([loaded(m)], {
          targetOptional: true
        })).toEqual([]);
        expect(validatePushRequirements([loaded(m)]).length).toBe(1);
      });

  test('targetOptional ignores the deployment target entirely (KC-only)', () => {
    // A KC-only push deploys no graph, so its deployment target is irrelevant:
    // more than one target -- and even a single malformed one -- is accepted,
    // where a graph push rejects both. (Zero targets is covered above.)
    const other =
        '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g2';
    const many = model({}, [googleExt([BQ_TARGET, other])]);
    expect(validatePushRequirements([loaded(many)], {targetOptional: true}))
        .toEqual([]);
    expect(validatePushRequirements([loaded(many)]).length).toBe(1);

    const malformed = model({}, [googleExt(['//example.com/not/a/graph'])]);
    expect(validatePushRequirements([loaded(malformed)], {targetOptional: true}))
        .toEqual([]);
    expect(validatePushRequirements([loaded(malformed)]).length).toBe(1);
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

  test('skips a source that is a query, not a table', async () => {
    // A query source (contains whitespace) is not a table and cannot be probed,
    // so it is not checked (nothing is mocked for it).
    const bq = new BigQueryClientMock();
    const m = model({entities: [entity('q', 'SELECT * FROM x')]});
    expect(await validateBigQueryDataSources([loaded(m)], bq, 'p')).toEqual([]);
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
        [googleExt([BQ_TARGET])]);
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
        [googleExt([BQ_TARGET])]);
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
  const ACCOUNT = {account: ['account_id', 'balance']};

  // An action whose sql executor runs `statements`, with three declared
  // parameters the statements may reference.
  function sqlAction(statements: string[], name = 'Transfer'): Action {
    return {
      name,
      parameters: [
        {name: 'amount', type: 'Float'},
        {name: 'id', type: 'Integer'},
        {name: 'note', type: 'Opaque'},
      ],
      executor: {kind: 'sql', sql: {statements}},
    } as Action;
  }

  function spannerModel(actions: Action[]): LoadedModel {
    return loaded(model({actions}, [googleExt([SPANNER_TARGET])]));
  }

  function bqModel(actions: Action[]): LoadedModel {
    return loaded(model({actions}, [googleExt([BQ_TARGET])]));
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
    test('sends the declared type of each referenced parameter', async () => {
      const spanner = new SpannerClientMock();
      spanner.schema = mockSchema(ACCOUNT);
      await validateSpannerActionStatements(
          [spannerModel([sqlAction([GOOD])])], spanner);
      expect(spanner.planned[0].paramTypes)
          .toEqual({amount: {code: 'FLOAT64'}, id: {code: 'INT64'}});
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

    // An Opaque parameter means the model does not know the type. Asserting one
    // would invent a constraint the author never wrote, so it is left for the
    // store to infer.
    test('omits an Opaque parameter rather than guessing a type', async () => {
      const spanner = new SpannerClientMock();
      spanner.schema = mockSchema({account: ['account_id', 'balance', 'memo']});
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

    // Spanner's error body, shaped after a live PLAN of a bad statement. Two
    // things about it are load-bearing and neither is obvious. The top-level
    // `message` is DOUBLY escaped -- one round of JSON escaping survives the
    // parse, so its newlines arrive as a literal backslash and an n, and a
    // statement it quotes back reads `Unexpected \"$1\"`. The LocalizedMessage
    // detail carries the same text with nothing escaped.
    function spannerErrorBody(diagnosis: string, echo: string): string {
      const plain = `${diagnosis}\n${echo}\n     ^`;
      return JSON.stringify({
        error: {
          code: 400,
          // JSON.stringify minus its surrounding quotes is exactly the extra
          // round of escaping Spanner applies.
          message: JSON.stringify(plain).slice(1, -1),
          status: 'INVALID_ARGUMENT',
          details: [{
            '@type': 'type.googleapis.com/google.rpc.LocalizedMessage',
            locale: 'en-US',
            message: plain,
          }],
        },
      });
    }

    test('reports the diagnosis without the statement echo', async () => {
      const spanner = new SpannerClientMock();
      spanner.planDml = (async () => ({
                           status: 400,
                           message: spannerErrorBody(
                               'Unrecognized name: accountId; Did you mean ' +
                                   'account_id? [at 1:54]',
                               'UPDATE account SET balance = @amount'),
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

    test('unescapes a statement the store quotes back', async () => {
      const spanner = new SpannerClientMock();
      spanner.planDml = (async () => ({
                           status: 400,
                           message: spannerErrorBody(
                               'Syntax error: Unexpected "$1" [at 1:40]',
                               'UPDATE account SET balance = $1'),
                         })) as any;
      const errs = await validateSpannerActionStatements(
          [spannerModel([sqlAction([GOOD])])], spanner);
      expect(errs[0]).toContain('Syntax error: Unexpected "$1" [at 1:40].');
      expect(errs[0]).not.toContain('\\"');
    });

    // BigQuery sends no LocalizedMessage, so the top-level message is the
    // normal path there rather than a fallback.
    test(
        'falls back to the top-level message when there is no detail',
        async () => {
          // What BigQuery sends: no LocalizedMessage, and the escaped newline
          // Spanner uses at the top level, which is why the first line has to
          // be found in both forms rather than by splitting on a real one.
          const spanner = new SpannerClientMock();
          spanner.planDml =
              (async () => ({
                 status: 404,
                 message: JSON.stringify({
                   error: {
                     message: 'Not found: Table orders was not found\\n' +
                         'UPDATE orders SET x = 1',
                   },
                 }),
               })) as any;
          const errs = await validateSpannerActionStatements(
              [spannerModel([sqlAction([GOOD])])], spanner);
          expect(errs[0]).toContain('Not found: Table orders was not found.');
          expect(errs[0]).not.toContain('UPDATE orders');
        });

    test('shows a non-JSON body rather than swallowing it', async () => {
      const spanner = new SpannerClientMock();
      spanner.planDml = (async () => ({
                           status: 502,
                           message: '<html>Bad Gateway</html>',
                         })) as any;
      const errs = await validateSpannerActionStatements(
          [spannerModel([sqlAction([GOOD])])], spanner);
      expect(errs[0]).toContain('<html>Bad Gateway</html>');
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

    test('sends the declared type of each referenced parameter', async () => {
      const bq = new BigQueryClientMock();
      bq.dmlSchema = mockSchema(ACCOUNT);
      await validateBigQueryActionStatements(
          [bqModel([sqlAction([GOOD])])], bq, 'p');
      expect(bq.dryRunDml[0].parameterTypes)
          .toEqual({amount: 'FLOAT64', id: 'INT64'});
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
