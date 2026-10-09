// Behavior spec for the push-time validation gate
// (src/libts/semantic/validate.ts).

import {describe, expect, test} from 'bun:test';

import {Action, CustomExtension, Entity, Metric, SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {LoadedModel, loadModels} from '../../../src/libts/semantic/loader';
import {mergeProfileOntoDoc} from '../../../src/libts/semantic/resolve_profiles';
import {transpileModel} from '../../../src/libts/semantic/transpile';
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
        [loaded(model(over))], {targetOptional: true});
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
  test('a subtype redeclaring an inherited field with nothing set is rejected', () => {
    for (const f of [{name: 'name'}, {name: 'name', stringForm: true},
                     {name: 'name', importedDialect: 'SNOWFLAKE'}]) {
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

  test('a legacy profile binds an inherited field the model does not redeclare', () => {
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
    const profile = `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    entities:
      - name: customer
        source: p.d.customer
        fields:
          - { name: id, expression: c_custkey }
          - { name: name, expression: c_name }
`;
    const docs = (text: string, bindingOptional: boolean) =>
        loadModels(text, {bindingOptional})
            .models.map(m => loaded(m, 'sales.yaml'));
    // The catalog leg validates the logical model unpruned.
    expect(validatePushRequirements(docs(logical, true), {targetOptional: true}))
        .toEqual([]);
    const merged = mergeProfileOntoDoc(logical, profile, 'analytical');
    if ('error' in merged) throw new Error(merged.error);
    expect(validatePushRequirements(
               docs(merged.text, false), {targetOptional: true}))
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
          [loaded(m)], {targetOptional: true, fieldsPruned: true});
      expect(errors.join('\n')).toMatch(want);
    }
    // Pruning never drops an entity, so an unknown parent is reported on a
    // pruned model too.
    expect(validatePushRequirements(
               [loaded(model({entities: [ent('a', {extends: ['gone']})]}))],
               {targetOptional: true, fieldsPruned: true}).join('\n'))
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
    expect(check({entities: [ent('party', {...base, authoredSource: 'bigquery:p.d.party'})]})
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
    test('a relationship from an extended entity to itself is reported once', () => {
      const errors = check({
        entities: [person, employee],
        relationships: [{
          name: 'knows',
          source: {entity: 'person', columns: ['c']},
          destination: {entity: 'person', columns: ['person_id']},
        }],
      });
      expect(errors.filter(e => e.includes("relationship 'knows'")).length).toBe(1);
    });
    test('the rules also run on a pruned model, as a graph push validates', () => {
      const errors = validatePushRequirements(
          [loaded(model({entities: [person, employee, order],
                         relationships: [rel('person')]}))],
          {targetOptional: true, fieldsPruned: true});
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
      expect(check({entities: [person, employee], metrics: [metric({entity: 'employee'})]}))
          .toEqual([]);
    });
  });
});


// A relationship's cardinality comes from the key its to_columns cover, so a
// join that covers no key is rejected on every push, a catalog-only one
// included.
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
      [loaded(model({entities: [ent('orders'), customer], relationships: [join(to)]}))],
      {targetOptional: true});

  test('a join on a key, a unique key or a superset of one passes', () => {
    expect(check(ent('customer'), ['id'])).toEqual([]);
    expect(check(ent('customer', {uniqueKeys: [['email']]}), ['email'])).toEqual([]);
    expect(check(ent('customer'), ['id', 'tenant'])).toEqual([]);
  });

  test('column names compare ignoring case and backticks', () => {
    expect(check(ent('customer'), ['ID'])).toEqual([]);
    expect(check(ent('customer'), ['`id`'])).toEqual([]);
  });

  test('a join name matches a field exactly, as the generators read it', () => {
    // The generators read `ID` as a column, not as field `id`, so the join
    // does not reach the key they emit, `cust_id`.
    const named = ent('customer', {fields: [{name: 'id', expression: 'cust_id'}]});
    expect(check(named, ['ID']).join('\n'))
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


describe('a relationship key check reads names as columns', () => {
  const join = (toEntity: string, to: string[]) => ({
    name: 'placed_by',
    source: {entity: 'orders', columns: to.map(c => `o_${c.replace(/`/g, '')}`)},
    destination: {entity: toEntity, columns: to},
  });
  const orders: Entity = {name: 'orders', dataSource: 'p.d.o', keys: ['o_id'], fields: []};
  const check = (entities: Entity[], rel: any) => validatePushRequirements(
      [loaded(model({entities: [orders, ...entities], relationships: [rel]}))],
      {targetOptional: true});

  test('a key that names a field covers a join on that field\'s column', () => {
    const customer: Entity = {
      name: 'customer', dataSource: 'p.d.c', keys: ['customerId'],
      fields: [{name: 'customerId', expression: 'customer_id'}],
    };
    expect(check([customer], join('customer', ['customer_id']))).toEqual([]);
  });

  // The column is bound only in a profile, so this binding cannot tell which
  // column the key is; the profile's binding is checked instead.
  test('a key that names a field with no column yet is not judged', () => {
    const customer: Entity = {
      name: 'customer', dataSource: 'p.d.c', keys: ['customerId'],
      fields: [{name: 'customerId'}],
    };
    expect(check([customer], join('customer', ['customer_id']))).toEqual([]);
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
});


describe('physical column names and relationship shape', () => {
  const validColumns = ['o_id', '`order date`'];
  const invalidColumns = [
    'order date',
    'LOWER(cust_id)',
    'a || b',
    'customers.id',
    '',
  ];

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
      expect(validatePushRequirements([loaded(m)], {targetOptional: true}))
          .toEqual([]);
    }
  });

  test('rejects expressions, qualified names, unquoted whitespace, and empty strings in all four slots', () => {
    for (const bad of invalidColumns) {
      const pkErrs = validatePushRequirements(
          [loaded(model({entities: [baseOrders({keys: [bad]})]}))],
          {targetOptional: true});
      expect(pkErrs.length).toBe(1);
      expect(pkErrs[0]).toContain("entity 'orders'");
      expect(pkErrs[0]).toContain('primary_key');
      expect(pkErrs[0]).toContain(`'${bad}'`);

      const ukErrs = validatePushRequirements(
          [loaded(model({entities: [baseOrders({uniqueKeys: [[bad]]})]}))],
          {targetOptional: true});
      expect(ukErrs.length).toBe(1);
      expect(ukErrs[0]).toContain("entity 'orders'");
      expect(ukErrs[0]).toContain('unique_keys');
      expect(ukErrs[0]).toContain(`'${bad}'`);

      const fromErrs = validatePushRequirements(
          [loaded(model({
            entities: [baseOrders(), baseCustomers()],
            relationships: [{
              name: 'placed_by',
              source: {entity: 'orders', columns: [bad]},
              destination: {entity: 'customers', columns: ['c_id']},
            }],
          }))],
          {targetOptional: true});
      expect(fromErrs.length).toBe(1);
      expect(fromErrs[0]).toContain("relationship 'placed_by'");
      expect(fromErrs[0]).toContain('from_columns');
      expect(fromErrs[0]).toContain(`'${bad}'`);

      const toErrs = validatePushRequirements(
          [loaded(model({
            entities: [baseOrders(), baseCustomers()],
            relationships: [{
              name: 'placed_by',
              source: {entity: 'orders', columns: ['o_id']},
              destination: {entity: 'customers', columns: [bad]},
            }],
          }))],
          {targetOptional: true});
      expect(toErrs.length).toBe(1);
      expect(toErrs[0]).toContain("relationship 'placed_by'");
      expect(toErrs[0]).toContain('to_columns');
      expect(toErrs[0]).toContain(`'${bad}'`);
    }
  });

  test('rejects an undeclared from or to entity on a relationship', () => {
    const badFrom = validatePushRequirements(
        [loaded(model({
          entities: [baseCustomers()],
          relationships: [{
            name: 'placed_by',
            source: {entity: 'ghost', columns: ['c_id']},
            destination: {entity: 'customers', columns: ['c_id']},
          }],
        }))],
        {targetOptional: true});
    expect(badFrom.length).toBe(1);
    expect(badFrom[0]).toContain("relationship 'placed_by'");
    expect(badFrom[0]).toContain("'from' entity 'ghost'");

    const badTo = validatePushRequirements(
        [loaded(model({
          entities: [baseOrders()],
          relationships: [{
            name: 'placed_by',
            source: {entity: 'orders', columns: ['o_id']},
            destination: {entity: 'ghost', columns: ['o_id']},
          }],
        }))],
        {targetOptional: true});
    expect(badTo.length).toBe(1);
    expect(badTo[0]).toContain("relationship 'placed_by'");
    expect(badTo[0]).toContain("'to' entity 'ghost'");
  });

  test('rejects mismatched from_columns and to_columns lengths, and accepts both empty on KC-only push', () => {
    const mismatch = validatePushRequirements(
        [loaded(model({
          entities: [baseOrders(), baseCustomers()],
          relationships: [{
            name: 'placed_by',
            source: {entity: 'orders', columns: ['o_id', 'extra_id']},
            destination: {entity: 'customers', columns: ['c_id']},
          }],
        }))],
        {targetOptional: true});
    expect(mismatch.length).toBe(1);
    expect(mismatch[0]).toContain("relationship 'placed_by'");
    expect(mismatch[0]).toContain('from_columns (2) and to_columns (1)');

    const unbound = validatePushRequirements(
        [loaded(model({
          entities: [baseOrders(), baseCustomers()],
          relationships: [{
            name: 'placed_by',
            source: {entity: 'orders', columns: []},
            destination: {entity: 'customers', columns: []},
          }],
        }))],
        {targetOptional: true});
    expect(unbound).toEqual([]);
  });
});


describe('struct paths in metric entity inference and transpilation', () => {
  test('loader infers metric entity from the leading qualifier of a struct path', () => {
    for (const expr of [
           'COUNT(orders.shipping_address.city)',
           'COUNT(`orders`.`shipping_address`.city)',
           'COUNT(orders.`shipping_address`.city)',
         ]) {
      const yaml = `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    datasets:
      - name: orders
        source: p.d.orders
        primary_key: [o_id]
        fields:
          - { name: shipping_address, expression: orders.shipping_address }
      - name: shipping_address
        source: p.d.shipping_address
        primary_key: [addr_id]
        fields:
          - { name: city, expression: shipping_address.city }
    metrics:
      - name: city_count
        expression: "${expr}"
`;
      const {models, warnings} = loadModels(yaml);
      expect(models[0].metrics[0].entity).toBe('orders');
      expect(warnings).toEqual([]);
    }
  });

  test('pull (kc_converter) infers metric entity from the leading qualifier of a struct path', () => {
    const m: SemanticModel = {
      name: 'sales',
      entities: [
        {
          name: 'orders',
          dataSource: 'p.d.orders',
          keys: ['o_id'],
          fields: [{name: 'shipping_address', expression: 'orders.shipping_address'}],
        },
        {
          name: 'shipping_address',
          dataSource: 'p.d.shipping_address',
          keys: ['addr_id'],
          fields: [{name: 'city', expression: 'shipping_address.city'}],
        },
      ],
      relationships: [],
      metrics: [{
        name: 'city_count',
        expression: 'COUNT(orders.shipping_address.city)',
        entity: 'orders',
      }],
    };
    const kc = generateCatalogResources(m, {
      project: 'p',
      location: 'us',
      entryGroup: 'eg',
      emitExpressions: true,
    });
    const pulled = modelsFromCatalogResources(kc.entries, kc.entryLinks);
    expect(pulled.models[0].metrics[0].entity).toBe('orders');
    expect(pulled.warnings).toEqual([]);
  });

  test('transpile qualifier guard does not mistake a struct subfield for a re-cased entity qualifier', async () => {
    const m: SemanticModel = {
      name: 'sales',
      entities: [
        {
          name: 'orders',
          dataSource: 'p.d.orders',
          keys: ['o_id'],
          fields: [{name: 'customer', expression: 'orders.customer'}],
        },
        {
          name: 'customer',
          dataSource: 'p.d.customer',
          keys: ['c_id'],
          fields: [{name: 'id', expression: 'customer.c_id'}],
        },
      ],
      relationships: [],
      metrics: [{
        name: 'cust_count',
        importedExpression: 'COUNT(orders.Customer.id)',
        importedDialect: 'SNOWFLAKE',
        entity: 'orders',
      }],
    };
    const {model: out, warnings} = await transpileModel(m, {
      transpiler: async reqs =>
          reqs.map(r => ({id: r.id, sql: 'COUNT(orders.Customer.id)'})),
    });
    expect(out.metrics[0].expression).toBe('COUNT(orders.Customer.id)');
    expect(warnings.some(w => w.includes('re-cased'))).toBe(false);
  });
});
