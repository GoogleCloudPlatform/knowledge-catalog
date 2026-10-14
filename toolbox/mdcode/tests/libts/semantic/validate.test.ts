// Behavior spec for the push-time validation gate
// (src/libts/semantic/validate.ts).

import {describe, expect, test} from 'bun:test';

import {Action, CustomExtension, Entity, Metric, SemanticModel} from '../../../src/libts/semantic/ir';
import {LoadedModel, loadModels} from '../../../src/libts/semantic/loader';
import {mergeProfileOntoDoc} from '../../../src/libts/semantic/resolve_profiles';
import {isColumnName} from '../../../src/libts/semantic/sql_expr_utils';
import {validateBigQueryActionStatements, validateBigQueryDataSources, validateExpressionReferences, validatePushRequirements, validateSpannerActionStatements} from '../../../src/libts/semantic/validate';
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
          entities: [{
            name: 'o',
            dataSource: 'p.d.o',
            keys: ['p'],
            fields: [{name: 'p', expression: 'p'}],
          }],
          metrics:
              [{name: 'rev', expression: 'SUM(o.p)', entity: 'o'} as Metric]
        },
        [googleExt([BQ_TARGET])]);
    expect(validatePushRequirements([loaded(m)])).toEqual([]);
  });

  test('a model with no deployment target is rejected', () => {
    const errs = validatePushRequirements([loaded(model())]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain(
        'declares 0 deployments; push uses exactly one deployment for now, ' +
        "with a BigQuery Graph or Spanner Graph target under 'deployments'.");
    expect(errs[0]).toContain('doc');

    const vanillaErrs =
        validatePushRequirements([loaded(model({version: '0.2.0.dev0'}))]);
    expect(vanillaErrs).toHaveLength(1);
    expect(vanillaErrs[0]).toEndWith(
        "; set version: '0.2.0.dev0/google' and use 'deployments:'");
    expect(vanillaErrs[0]).not.toContain("under 'deployments'");
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
        "target '//dataplex.googleapis.com/projects/p/locations/us' is not " +
        'a valid BigQuery Graph or Spanner Graph URI');
    expect(errs[0]).not.toContain('deploymentTarget');
  });

  // An AlloyDB target parses and is supported, and a push still cannot use it:
  // AlloyDB has no property-graph DDL, so there is no graph to publish. The
  // message has to separate that from the malformed case above, because the
  // fix is a different command rather than a corrected URI.
  test('an AlloyDB target is rejected as a store, not as a typo', () => {
    const m = model({}, [googleExt([ALLOYDB_TARGET])]);
    const errs = validatePushRequirements([loaded(m)]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain(`target '${ALLOYDB_TARGET}' is an AlloyDB database`);
    expect(errs[0]).toContain('runs against rather than deploys to');
    expect(errs[0]).toContain(
        "Declare a BigQuery or Spanner Graph target (under 'deployments'; " +
        "push uses exactly one deployment for now), or run 'kcmd push " +
        "--no-profile' to publish to Knowledge Catalog only.");
    expect(errs[0]).not.toContain('deploymentTarget');
    expect(errs[0]).not.toContain('is not a valid');

    const vanilla =
        model({version: '0.2.0.dev0'}, [googleExt([ALLOYDB_TARGET])]);
    const vanillaErrs = validatePushRequirements([loaded(vanilla)]);
    expect(vanillaErrs).toHaveLength(1);
    // The version hint goes with the graph target it enables, not with the
    // catalog-only option.
    expect(vanillaErrs[0]).toContain(
        "Declare a BigQuery or Spanner Graph target (set version: " +
        "'0.2.0.dev0/google' and use 'deployments:'; push uses exactly one " +
        "deployment for now), or run 'kcmd push --no-profile' to publish to " +
        "Knowledge Catalog only.");
    expect(vanillaErrs[0]).not.toContain("under 'deployments'");
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
    expect(errs[0]).toContain(
        'declares 2 deployments; push uses exactly one deployment for now, ' +
        "with a BigQuery Graph or Spanner Graph target under 'deployments'.");
  });

  test('more than one target in a vanilla model ends with the version hint', () => {
    const other =
        '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g2';
    const m = model({version: '0.2.0.dev0'}, [googleExt([BQ_TARGET, other])]);
    const errs = validatePushRequirements([loaded(m)]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toEndWith(
        "with a BigQuery Graph or Spanner Graph target; set version: " +
        "'0.2.0.dev0/google' and use 'deployments:'");
  });

  // A padded target is the same target, so a blank one is dropped and a padded
  // copy is caught as a repeat, on a catalog-only push too.
  test('GOOGLE-block targets are trimmed and blank ones dropped before the repeat check', () => {
    const padded = model({version: '0.2.0.dev0'},
                         [googleExt([BQ_TARGET, '  ', ` ${BQ_TARGET} `])]);
    expect(validatePushRequirements([loaded(padded)], {targetOptional: true}))
        .toEqual([
          `model 'm' (doc) declares duplicate deployment target '${
              BQ_TARGET}'; each deployment must target a distinct resource.`,
        ]);
    const blank = model({version: '0.2.0.dev0'},
                        [googleExt(['', ` ${BQ_TARGET} `])]);
    expect(validatePushRequirements([loaded(blank)])).toEqual([]);
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

  test('targetOptional ignores the deployment target count and kind (KC-only), but still rejects duplicate targets', () => {
    // A KC-only push deploys no graph, so its deployment target is irrelevant:
    // more than one distinct target -- and even a single malformed one -- is
    // accepted, where a graph push rejects both. (Zero targets is covered
    // above.) A repeated target URI is still rejected so a vanilla file obeys
    // the same uniqueness rule as `deployments:`.
    const dup = model({}, [googleExt([BQ_TARGET, BQ_TARGET])]);
    for (const targetOptional of [false, true]) {
      const errs = validatePushRequirements([loaded(dup)], {targetOptional});
      expect(errs.some(e => e.includes(`duplicate deployment target '${BQ_TARGET}'`))).toBe(true);
    }
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
        loadModels(text, {bindingOptional, allowLegacyBareSource: true})
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
    expect(badToEntity[0]).toContain("'to' dataset 'ghost' is not defined in the model");

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
    expect(badFromEntity.join('\n')).toContain("'from' dataset 'ghost' is not defined in the model");
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
      expect(validatePushRequirements([loaded(m)], {targetOptional: true}))
          .toEqual([]);
    }
  });

  test('rejects expressions, qualified names, unquoted whitespace, and empty strings in all four slots, printing the backtick hint only for a value that could be a column name', () => {
    for (const bad of invalidColumns) {
      const expectHint = hintedColumns.includes(bad);

      const pkErrs = validatePushRequirements(
          [loaded(model({entities: [baseOrders({keys: [bad]})]}))],
          {targetOptional: true});
      expect(pkErrs).toEqual(
          [columnError("entity 'orders'", 'primary_key', bad, expectHint)]);

      const ukErrs = validatePushRequirements(
          [loaded(model({entities: [baseOrders({uniqueKeys: [[bad]]})]}))],
          {targetOptional: true});
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
          }))],
          {targetOptional: true});
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
          }))],
          {targetOptional: true});
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
            [loaded(model({entities: [baseOrders({keys: [bad]})]}))],
            {targetOptional: true});
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
            [loaded(model({entities: [baseOrders({keys: [bad]})]}))],
            {targetOptional: true});
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
        source: bigquery:p.d.orders
        primary_key: ["LOWER(o_id)"]
        fields:
          - { name: o_id, expression: o_id }
`).models;
    const errs =
        validatePushRequirements([loaded(parsed)], {targetOptional: true});
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
        [loaded(model({entities: [party]}))],
        {targetOptional: true});
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
        }))],
        {targetOptional: true});
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
        }))],
        {targetOptional: true});
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
        }))],
        {targetOptional: true});
    expect(errs).toEqual([
      "relationship 'orders_ghosts' in model 'm' (doc): 'to' dataset 'ghost' is not defined in the model.",
    ]);
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
    expect(badFrom[0]).toContain("'from' dataset 'ghost' is not defined in the model.");

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
    expect(badTo[0]).toContain("'to' dataset 'ghost' is not defined in the model.");
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
        }))],
        {targetOptional: true});
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
        }))],
        {targetOptional: true});
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
        [googleExt([BQ_TARGET])]))]);
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
        }))],
        {targetOptional: true});
    expect(onlyToBound).toEqual([halfBound]);

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
          [googleExt([target])]);
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
                 [loaded(multiEntity)], {targetOptional: true, fieldsPruned: true})
                 .join('\n'))
          .toContain('reaches multiple entities (orders, customer)');

      const vanillaNoEntity = model({
        version: '0.2.0.dev0',
        entities: [orders()],
        metrics: [{name: 'cnt', expression: 'COUNT(*)'}],
      });
      expect(validatePushRequirements(
                 [loaded(vanillaNoEntity)], {targetOptional: true})
                 .join('\n'))
          .toContain("set 'entity' in a GOOGLE custom_extensions block on the metric");
    });

    test('rejects a metric with no expression and no entity anchor with a dedicated message', () => {
      const m = model({
        entities: [orders()],
        metrics: [{name: 'empty_metric'}],
      });
      expect(validatePushRequirements([loaded(m)], {targetOptional: true}))
          .toEqual([
            "metric 'empty_metric' in model 'm' (doc) has no expression and " +
            "no 'entity' anchor; supply an expression or set 'entity' on the metric.",
          ]);
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
      expect(validatePushRequirements([loaded(m)], {targetOptional: true}))
          .toEqual([
            "metric 'cnt' in model 'm' (doc): entity 'ghost' is not declared in the model.",
          ]);
      expect(validatePushRequirements(
                 [loaded(m)], {targetOptional: true, fieldsPruned: true}))
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
                 [loaded(wrongAnchor)], {targetOptional: true})
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
                 [loaded(subtypeMismatch)], {targetOptional: true})
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
                 [loaded(subtypeMatches)], {targetOptional: true}))
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
      expect(validatePushRequirements([loaded(m)], {targetOptional: true})
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
      expect(validatePushRequirements([loaded(m)], {targetOptional: true}))
          .toEqual([]);
    });

    test('checks BigQuery generator metric placement rules only when pushing to a BigQuery graph', () => {
      const bqPush = (entities: Entity[], metric: Metric, version?: SemanticModel['version']) =>
          validatePushRequirements(
              [loaded(model({version, entities, metrics: [metric]}, [googleExt([BQ_TARGET])]))])
              .join('\n');

      // Comment naming a second entity or function namespace matching an entity name trips the BQ regex,
      // and passes on a KC-only push or Spanner graph push.
      const commentMetric: Metric = {
        name: 'rev', expression: 'SUM(orders.net_amount) -- customer.id', entity: 'orders',
      };
      expect(bqPush([orders(), customer()], commentMetric))
          .toContain("references multiple entities (orders, customer); the BigQuery generator scans raw expression text");
      expect(validatePushRequirements(
                 [loaded(model({entities: [orders(), customer()], metrics: [commentMetric]}, [googleExt([BQ_TARGET])]))],
                 {targetOptional: true}))
          .toEqual([]);
      expect(validatePushRequirements(
                 [loaded(model({entities: [orders(), customer()], metrics: [commentMetric]}, [googleExt([SPANNER_TARGET])]))]))
          .toEqual([]);

      const netEntity: Entity = {
        name: 'NET', dataSource: 'p.d.net', keys: ['id'], fields: [{name: 'id', expression: 'n_id'}],
      };
      expect(bqPush([orders(), netEntity], {
        name: 'hosts', expression: 'COUNT(DISTINCT NET.HOST(orders.url))', entity: 'orders',
      })).toContain('references multiple entities (NET, orders)');

      // Vanilla `COUNT(*)` anchored via a GOOGLE custom_extensions block loads with `metric.entity` unset:
      // KC-only push accepts it, while BigQuery graph push rejects it naming what the BigQuery generator reads.
      const vanillaDoc = loadModels(`version: "0.2.0.dev0"
semantic_model:
  - name: sales
    custom_extensions:
      - vendor_name: GOOGLE
        data: '${JSON.stringify({deploymentTargets: [BQ_TARGET]})}'
    datasets:
      - name: orders
        source: bigquery:p.d.orders
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
      expect(validatePushRequirements([loaded(vanillaDoc)], {targetOptional: true})).toEqual([]);
      expect(validatePushRequirements([loaded(vanillaDoc)]).join('\n'))
          .toContain("the BigQuery generator reads '<entity>.' qualifiers in the expression or top-level 'entity'");

      // Metric with only a non-BigQuery dialect expression is rejected without --transpile.
      expect(bqPush([orders()], {
        name: 'pg_rev',
        importedExpression: 'SUM("orders"."net_amount")',
        importedDialect: 'POSTGRES',
        entity: 'orders',
        authoredEntity: 'orders',
        dialects: [{dialect: 'POSTGRES', expression: 'SUM("orders"."net_amount")'}],
      })).toContain("targets a BigQuery graph with only a 'POSTGRES' expression");
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
            validatePushRequirements([loaded(m)], {targetOptional: true});
        expect(errs).toEqual([
          `metric 'net_revenue' in model 'm' (doc): '${col}' must be written ` +
          `as 'entity.field'; a metric reads fields, never columns.`,
        ]);
      }
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
        expect(validatePushRequirements([loaded(m)], {targetOptional: true}))
            .toEqual([
              `metric 'net_revenue' in model 'm' (doc): '${expr}' has qualifier ` +
              `'${qual}', which is not a declared entity in model 'm'; write ` +
              `'entity.field' starting with a declared entity.`,
            ]);
      }

      const caseMismatch = model({
        entities: [orders()],
        metrics: [{
          name: 'net_revenue',
          expression: 'SUM(Orders.net_amount)',
        }],
      });
      expect(validatePushRequirements([loaded(caseMismatch)], {targetOptional: true}))
          .toEqual([
            "metric 'net_revenue' in model 'm' (doc): 'Orders.net_amount' " +
            "uses qualifier 'Orders', which differs in case from entity " +
            "'orders'; entity names are case-sensitive.",
          ]);
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
      expect(validatePushRequirements([loaded(m)], {targetOptional: true})).toEqual([]);

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
      expect(validatePushRequirements([loaded(bqDateDiffBadCol)], {targetOptional: true}))
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
          '        source: bigquery:p.d.orders\n',
          '      - { name: done_rev, expression: \'SUM(IF(orders.status = "done", orders.net_amount, 0))\' }\n' +
          '      - { name: recent_cnt, expression: \'COUNTIF(orders.order_date >= DATE "2024-01-01")\' }\n'));
      const bqWarnings: string[] = [];
      expect(validatePushRequirements(
                 bqLoaded.models.map(m => loaded(m, 'sales.yaml')),
                 {targetOptional: true, warnings: bqWarnings}))
          .toEqual([]);
      expect(bqWarnings).toEqual([]);

      // Reading `ANSI_SQL` in the BigQuery source dialect catches a bad field inside BigQuery-only syntax
      // (`DATE "2024-01-01"` does not parse in generic ANSI_SQL).
      const bqBadLoaded = loadModels(yamlFor(
          '        source: bigquery:p.d.orders\n',
          '      - { name: bad_recent, expression: \'COUNTIF(orders.missing_date >= DATE "2024-01-01")\' }\n'));
      expect(validatePushRequirements(
                 bqBadLoaded.models.map(m => loaded(m, 'sales.yaml')),
                 {targetOptional: true})
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
      expect(validatePushRequirements([loaded(m)], {targetOptional: true, warnings})).toEqual([]);
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
                 [loaded(m)], {targetOptional: true, fieldsPruned: true})
                 .join('\n'))
          .toContain("field 'orders.bad_cross' in model 'm' (doc) references entity 'customer'");
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
      expect(validatePushRequirements([loaded(m)], {targetOptional: true})
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
      expect(validatePushRequirements([loaded(m)], {targetOptional: true})
                 .join('\n'))
          .toContain("entity 'orders' has no field 'no_such_field'");
    });
  });
});
