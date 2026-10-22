// Behavior spec for the push-time validation gate
// (src/libts/semantic/validate.ts).

import {describe, expect, test} from 'bun:test';

import {Action, CustomExtension, Entity, Field, Metric, SemanticModel} from '../../../src/libts/semantic/ir';
import {listed, LoadedModel, loadModels} from '../../../src/libts/semantic/loader';
import {mergeProfileOntoDoc} from '../../../src/libts/semantic/resolve_profiles';
import {isColumnName} from '../../../src/libts/semantic/sql_expr_utils';
import {inlineBindingWarnings, validateBigQueryActionStatements, validateBigQueryDataSources, validateDeployments, validateExpressionReferences, validateInlineDialects, validatePushRequirements, validateSpannerActionStatements} from '../../../src/libts/semantic/validate';
import {BigQueryClientMock, mockSchema, SpannerClientMock} from '../mocks';

// A parsed BigQuery Graph deployment target the strict matcher accepts.
const BQ_TARGET =
    'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';

// A parsed Spanner Graph deployment target the strict matcher accepts.
const SPANNER_TARGET =
    'spanner.googleapis.com/projects/p/instances/i/databases/db/graphs/g';

// A parsed AlloyDB deployment target. Not a graph target: it names a database
// to run against, which is the whole reason a push has to say something other
// than "typo" about it.
const ALLOYDB_TARGET =
    'alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c/instances/i/databases/db';

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
        "; list 'deployments' in a GOOGLE custom_extensions block on the " +
        "model, or set version: '0.2.0.dev0/google' and use 'deployments:'");
    expect(vanillaErrs[0]).not.toContain("under 'deployments'");
  });

  // A vanilla model that lists deployments has them in its GOOGLE block, so
  // the message says where they are instead of how to declare them.
  test('a vanilla model is told its GOOGLE block holds its deployments', () => {
    const twice = model({
      version: '0.2.0.dev0',
      deployments: [
        {name: 'a', target: BQ_TARGET},
        {name: 'b', target: SPANNER_TARGET},
      ],
    });
    expect(validatePushRequirements([loaded(twice)])[0]).toEndWith(
        'with a BigQuery Graph or Spanner Graph target under ' +
        "'deployments' in its GOOGLE custom_extensions block.");
    const alloy = model({
      version: '0.2.0.dev0',
      deployments: [{name: 'a', target: ALLOYDB_TARGET}],
    });
    expect(validatePushRequirements([loaded(alloy)])[0]).toContain(
        "Declare a BigQuery or Spanner Graph target (under 'deployments' in " +
        'its GOOGLE custom_extensions block; push uses exactly one ' +
        'deployment for now)');
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
        {}, [googleExt(['dataplex.googleapis.com/projects/p/locations/us'])]);
    const errs = validatePushRequirements([loaded(m)]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain(
        "target 'dataplex.googleapis.com/projects/p/locations/us', which is " +
        'not a BigQuery graph, a Spanner graph or an AlloyDB database');
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
        "Declare a BigQuery or Spanner Graph target (list 'deployments' in " +
        "a GOOGLE custom_extensions block on the model, or set version: " +
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
        'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g2';
    const m = model({}, [googleExt([BQ_TARGET, other])]);
    const errs = validatePushRequirements([loaded(m)]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain(
        'declares 2 deployments; push uses exactly one deployment for now, ' +
        "with a BigQuery Graph or Spanner Graph target under 'deployments'.");
  });

  test('more than one target in a vanilla model ends with the version hint', () => {
    const other =
        'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g2';
    const m = model({version: '0.2.0.dev0'}, [googleExt([BQ_TARGET, other])]);
    const errs = validatePushRequirements([loaded(m)]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toEndWith(
        "with a BigQuery Graph or Spanner Graph target; list 'deployments' " +
        "in a GOOGLE custom_extensions block on the model, or set version: " +
        "'0.2.0.dev0/google' and use 'deployments:'");
  });

  // The entry to fix is named, rather than the count of targets.
  test('a target in no accepted form beside a valid one is named', () => {
    const typo = model({}, [googleExt([BQ_TARGET, 'bq-typo'])]);
    const errors = validatePushRequirements([loaded(typo)]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toStartWith(
        "model 'm' (doc) target 'bq-typo', which is not a BigQuery graph, a " +
        'Spanner graph or an AlloyDB database.');
    const nonString = model({version: '0.2.0.dev0'}, [{
      vendorName: 'GOOGLE',
      data: JSON.stringify({deploymentTargets: [BQ_TARGET, 42]}),
    }]);
    const errs = validatePushRequirements([loaded(nonString)]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain(
        "target '42', which is not a BigQuery graph, a Spanner graph or an " +
        'AlloyDB database');
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

  // A target in no accepted form is rejected on every push, a KC-only one too,
  // and the error names what to write instead.
  test('a target in no accepted form is rejected on every push', () => {
    const legacy = 'alloydb.googleapis.com/projects/p/locations/l/clusters/c/instances/i/databases/db';
    for (const [target, rest] of [
      [`//${BQ_TARGET}`,
       `which is a resource URI; write its GCP resource name, without the ` +
           `leading '//': '${BQ_TARGET}'.`],
      [`//${legacy}`,
       `the instance-based AlloyDB name, which names no real resource. An ` +
           `AlloyDB database belongs to its cluster; write ` +
           `'alloydb.googleapis.com/projects/p/locations/l/clusters/c/databases/db'.`],
      [SPANNER_TARGET.replace('/graphs/', '/propertyGraphs/'),
       `which names a Spanner graph by 'propertyGraphs'; write its Dataplex ` +
           `name: '${SPANNER_TARGET}'.`],
      ['bigquery:graph:p.d.g',
       `which is a Knowledge Catalog name. Write the GCP resource name ` +
           `instead: 'bigquery.googleapis.com/projects/<p>/datasets/<d>/propertyGraphs/<g>'.`],
      ['example.com/not/a/graph',
       `which is not a BigQuery graph, a Spanner graph or an AlloyDB database.`],
    ]) {
      const m = model({}, [googleExt([target])]);
      for (const targetOptional of [false, true]) {
        const errs = validatePushRequirements([loaded(m)], {targetOptional});
        expect(errs).toHaveLength(1);
        expect(errs[0]).toStartWith(`model 'm' (doc) target '${target}', ${rest}`);
      }
    }
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
    // more than one distinct target is accepted, where a graph push rejects
    // it. (Zero targets is covered
    // above.) A repeated target URI is still rejected so a vanilla file obeys
    // the same uniqueness rule as `deployments:`.
    const dup = model({}, [googleExt([BQ_TARGET, BQ_TARGET])]);
    for (const targetOptional of [false, true]) {
      const errs = validatePushRequirements([loaded(dup)], {targetOptional});
      expect(errs.some(e => e.includes(`duplicate deployment target '${BQ_TARGET}'`))).toBe(true);
    }
    const other =
        'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g2';
    const many = model({}, [googleExt([BQ_TARGET, other])]);
    expect(validatePushRequirements([loaded(many)], {targetOptional: true}))
        .toEqual([]);
    expect(validatePushRequirements([loaded(many)]).length).toBe(1);
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
        source: bigquery.googleapis.com/projects/p/datasets/d/tables/customer
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

  test('a key field\'s column is read without its comment, as the generators read it', () => {
    // The generators emit `KEY(cust_id)` for this field, so a join on
    // `cust_id` covers the key.
    const commented = ent('customer', {
      fields: [{name: 'id', expression: 'cust_id -- the customer number'}],
    });
    expect(check(commented, ['cust_id'])).toEqual([]);
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
        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders
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
      expect(validatePushRequirements([loaded(m)], {targetOptional: true}))
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
      expect(validatePushRequirements([loaded(m)], {targetOptional: true}))
          .toEqual(expected);
      // The BigQuery metric check reports each metric once.
      const graph = model({...m, customExtensions: [googleExt([BQ_TARGET])]});
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

      // A function namespace matching an entity name trips the BQ regex. A comment naming a second entity
      // passes on every push, because the generator reads the expression without its comments.
      const commentMetric: Metric = {
        name: 'rev', expression: 'SUM(orders.net_amount) -- customer.id', entity: 'orders',
      };
      expect(bqPush([orders(), customer()], commentMetric)).toBe('');
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
      })).toContain(
          "references multiple entities (NET, orders); the BigQuery generator reads every '<entity>.' " +
          "outside comments as a qualifier, including a function namespace such as 'NET.'");

      // Vanilla `COUNT(*)` anchored via a GOOGLE custom_extensions block loads with `metric.entity` set
      // from the block, so a KC-only push and a BigQuery graph push both accept it.
      const vanillaDoc = loadModels(`version: "0.2.0.dev0"
semantic_model:
  - name: sales
    custom_extensions:
      - vendor_name: GOOGLE
        data: '${JSON.stringify({deploymentTargets: [BQ_TARGET]})}'
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
      expect(validatePushRequirements([loaded(vanillaDoc)], {targetOptional: true})).toEqual([]);
      expect(validatePushRequirements([loaded(vanillaDoc)])).toEqual([]);

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
          "single entity; the BigQuery generator reads '<entity>.' qualifiers in the expression " +
          "or 'entity' in a GOOGLE custom_extensions block on the metric.");
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
          '        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders\n',
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
          '        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders\n',
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
        // `expression` is not the text of any dialect entry here. Knowledge
        // Catalog stores `expression` when push runs with --emit-expressions.
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
      expect(validatePushRequirements([loaded(kcOnly)], {targetOptional: true}))
          .toEqual(expected);
      const graph =
          model({entities: [{...orders(), fields}]}, [googleExt([BQ_TARGET])]);
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
      expect(validatePushRequirements([loaded(m)], {targetOptional: true}))
          .toEqual(expected);
      // `expression` is not the text of the dialect entry here. Knowledge
      // Catalog stores `expression` when push runs with --emit-expressions.
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
                 [loaded(model({entities: [stale, sub]}))],
                 {targetOptional: true}))
          .toEqual(expected);
      // A catalog-only push lifts a profile's exclusions to publish every
      // field. A field the profile excludes on `sub` is not read there.
      expect(validatePushRequirements([loaded(m)], {
        targetOptional: true,
        liftedExclusions: [{model: 'm', entity: 'sub', field: 'label'}],
      })).toEqual([]);
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
      expect(validatePushRequirements([loaded(m)], {targetOptional: true}))
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
                 [loaded(model({entities: [base, sub]}))],
                 {targetOptional: true}))
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
                 [loaded(model({entities: [base, sub('a'), sub('b')]}))],
                 {targetOptional: true}))
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
                 [loaded(model({entities: [base, a]}))],
                 {targetOptional: true}))
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
          validatePushRequirements([loaded(m)], {targetOptional: true});
      expect(errors.join('\n')).toContain("extends unknown entity 'gone'");
      for (const e of expected) expect(errors).toContain(e);
      // The BigQuery metric check reports each metric once.
      const graph = model({...m, customExtensions: [googleExt([BQ_TARGET])]});
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
          [googleExt([BQ_TARGET])]);
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
          [loaded(m)], {targetOptional: true, warnings});
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


// Push checks names again, for a model built in memory and a profile that
// reaches `model.profiles` without the loader, and is the only place the
// description limit, link IDs and metric-field collisions are checked.
describe('push checks names and description lengths', () => {
  const withNames = (over: Partial<SemanticModel> = {}) => model({
    entities: [{
      name: 'orders', dataSource: 'p.d.o', keys: ['id'],
      fields: [{name: 'id', expression: 'id'}],
    }],
    ...over,
  });
  const errorsOf = (m: SemanticModel) =>
      validatePushRequirements([loaded(m)], {targetOptional: true});

  test('a valid model passes', () => {
    expect(errorsOf(withNames())).toEqual([]);
  });

  test('each name a model built in memory carries is checked', () => {
    const m = withNames({
      name: 'sales/orders',
      entities: [{
        name: 'my-entity', dataSource: 'p.d.o', keys: ['id'],
        fields: [{name: 'order date', expression: 'id'}],
      }],
      metrics: [{name: '2024_orders', expression: 'COUNT(*)'} as Metric],
      relationships: [{
        name: 'placed-by', source: {entity: 'my-entity', columns: []},
        destination: {entity: 'my-entity', columns: []},
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
      }],
      metrics: [{
        name: 'order_count', expression: 'COUNT(orders.id)', entity: 'orders',
        description: 'x'.repeat(length),
      } as Metric],
      relationships: [{
        name: 'self_ref', source: {entity: 'orders', columns: ['id']},
        destination: {entity: 'orders', columns: ['id']},
        description: 'r'.repeat(length),
      }],
    });
    expect(errorsOf(described(2000))).toEqual([]);
    const errors = errorsOf(described(2001));
    for (const what of [
           "model 'm'", "entity 'orders'", "metric 'order_count'",
           "relationship 'self_ref'",
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

  // Normalising a name to a link ID loses information: `__` reads as `-`, and
  // everything past 63 characters is cut, which a long model name makes
  // likely.
  test('rejects two relationships whose names give one Knowledge Catalog link ID', () => {
    const rel = (name: string) => ({
      name,
      source: {entity: 'orders', columns: ['id']},
      destination: {entity: 'orders', columns: ['id']},
    });
    const longModel = `m_${'a'.repeat(50)}`;
    const cases: Array<[model: string, a: string, b: string, linkId: string]> = [
      ['retail', 'order_customer', 'order__customer', 'retail-order-customer'],
      [longModel, 'rel_shared_prefix_one', 'rel_shared_prefix_two',
       `m-${'a'.repeat(50)}-rel-shared`],
    ];
    for (const [name, a, b, linkId] of cases) {
      expect(errorsOf(withNames({name, relationships: [rel(a), rel(b)]})))
          .toEqual([
            `Relationships '${a}' and '${b}' in model '${name}' (doc) collide ` +
            `on Knowledge Catalog link ID '${linkId}'; rename one of them.`,
          ]);
    }
  });
});

// Loads model `name` from the YAML of its lists, with bindings optional.
const loadOne = (name: string, lists: string) => loadModels(
    `version: "0.2.0.dev0/google"\nsemantic_model:\n  - name: ${name}\n${lists}`,
    {bindingOptional: true}).models[0];
const BQ_TABLE = (t: string) =>
    `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
// One target of each engine.
const TARGET = {
  bigquery: BQ_TARGET,
  spanner: SPANNER_TARGET,
  alloydb:
      'alloydb.googleapis.com/projects/p/locations/us-central1/clusters/c/databases/db',
};

// Every deployment is held to the rules of its engine on the model file's own
// bindings, whatever profile it names.
describe('validateDeployments', () => {
  type Engine = keyof typeof TARGET;
  // A deployment entry named after its engine.
  const deployment = (engine: Engine, profile?: string) =>
      `      - name: ${engine}\n        target: ${TARGET[engine]}\n` +
      (profile ? `        profile: ${profile}\n` : '');
  const BQ = deployment('bigquery');
  // Purchases join customers, with the customer table and the join bound
  // unless `customer` or `join` is false. `deployments` holds deployment
  // entries and `metric` one metric, as YAML.
  const commerce =
      ({customer = true, join = true, deployments = '', metric = ''} = {}) =>
          loadOne('commerce', `${deployments && `    deployments:\n${deployments}`}\
    entities:
      - name: customer
${customer ? `        source: ${BQ_TABLE('customer')}\n` : ''}\
        primary_key: [c_id]
        fields: [{ name: c_id, expression: c_id }, { name: c_name }]
      - name: purchase
        source: ${BQ_TABLE('purchase')}
        primary_key: [p_id]
        fields:
          - { name: p_id, expression: p_id }
          - { name: amount, expression: amt }
          - { name: note }
          - { name: noted, expression: "purchase.note || '!'" }
    relationships:
      - { name: placed_by, from: purchase, to: customer${
          join ? ', from_columns: [p_customer], to_columns: [c_id]' : ''} }
${metric && `    metrics:\n      - ${metric}\n`}`);
  const check = (m: SemanticModel,
                 opts: Parameters<typeof validateDeployments>[2] = {}) =>
      validateDeployments(m, 'commerce', opts);
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
    expect(check(commerce({deployments: all, metric: notes}))).toEqual([
      READS(['bigquery', 'alloydb'], 'm', 'purchase.note'),
    ]);
    const noted = '{ name: m, expression: "COUNT(purchase.noted)" }';
    expect(check(commerce({deployments: BQ, metric: noted})))
        .toEqual([READS('bigquery', 'm', 'purchase.noted', false)]);
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
    const bigQueryOnly = [READS('bigquery', 'm', 'customer.note')];
    expect(check(alloyDb(noteInBigQuery))).toEqual([]);
    expect(check(alloyDb(noteInBigQuery, {shop: true}))).toEqual(bigQueryOnly);
    expect(check(alloyDb(texts(['BIGQUERY', NOTE], ['ANSI_SQL', C_ID]))))
        .toEqual([]);
    expect(check(alloyDb(both(C_ID, NOTE))))
        .toEqual([READS(['alloydb', 'bigquery'], 'm', 'customer.note')]);
    // A field the metric reads is read the same way. A field reads a sibling
    // field as `entity.field`.
    const viaLabel = '"COUNT(customer.label)"';
    expect(check(alloyDb(viaLabel, {label: both('customer.note', 'c_id')})))
        .toEqual([]);
    expect(check(alloyDb(viaLabel, {label: both('c_id', 'customer.note')})))
        .toEqual(
            [READS(['alloydb', 'bigquery'], 'm', 'customer.label', false)]);
  });

  test('names every concrete entity and relationship left unbound, and leaves out the relationships under joinsChecked', () => {
    const m = commerce(
        {customer: false, join: false, deployments: deployment('alloydb')});
    m.entities[1].dataSource = '';
    m.relationships.push({...m.relationships[0], name: 'billed_to'});
    expect(check(m)).toEqual([UNBOUND(
        'alloydb',
        "entities 'customer' and 'purchase' without a source and " +
            "relationships 'placed_by' and 'billed_to' without join columns")]);
    // The caller reports a relationship with no join columns itself.
    const noJoin = (customer: boolean) => check(
        commerce({customer, join: false, deployments: BQ}),
        {joinsChecked: true});
    expect(noJoin(true)).toEqual([]);
    expect(noJoin(false)).toEqual([UNBOUND('bigquery')]);
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

  test('incomplete inline bindings give one warning when the model declares no deployment', () => {
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
           commerce(), commerce({deployments: BQ}),
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

  // A BigQuery graph turns each metric into a measure: one aggregate on the
  // node table of a keyed entity.
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

    test('rejects a metric that is not one aggregate or whose entity has no key, on BigQuery only, and passes one aggregate', () => {
      for (const e of [
             'SUM(purchase.amount) / 2', 'COUNTIF(purchase.amount > 0)',
             'SUM(purchase.amount) OVER ()', 'MIN(purchase.amount, purchase.p_id)',
           ]) {
        expect({e, errors: bigQuery(anchored(e))}).toEqual({e, errors: [
          MEASURE('it is not SUM, AVG, COUNT, MIN or MAX over one operand'),
        ]});
      }
      // Two BigQuery deployments, on graphs g and g2, get one message that
      // names both.
      expect(check(commerce({
        deployments: `${BQ}      - name: dev\n        target: ${BQ_TARGET}2\n`,
        metric: anchored('SUM(purchase.amount) / 2'),
      }))).toEqual([
        "model 'commerce' (commerce) deployments 'bigquery' and 'dev' target " +
        "BigQuery, where metric 'm' cannot be a measure: it is not SUM, AVG, " +
        'COUNT, MIN or MAX over one operand.',
      ]);
      expect(check(commerce({
        deployments: deployment('spanner') + deployment('alloydb'),
        metric: '{ name: m, expression: "SUM(purchase.amount) / 2" }',
      }))).toEqual([]);
      for (const e of [
             'SUM(purchase.amount)', 'COUNT(DISTINCT purchase.p_id)',
             '(MAX(purchase.amount)) -- top',
           ]) {
        expect({e, errors: bigQuery(`{ name: m, expression: "${e}" }`)})
            .toEqual({e, errors: []});
      }
      expect(bigQuery(anchored('COUNT(*)'))).toEqual([]);
      // A graph builds no node table for an entity with no key.
      for (const e of ['SUM(purchase.amount)', 'COUNT(*)']) {
        expect({e, errors: bigQuery(anchored(e), {keys: []})}).toEqual({e, errors: [
          MEASURE("it belongs to entity 'purchase', which has no primary key " +
                  'or unique key, so the graph has no node table for it'),
        ]});
        expect({e, errors: bigQuery(anchored(e), {keys: [], uniqueKeys: [['p_id']]})})
            .toEqual({e, errors: []});
      }
    });

    // Each metric is reported once.
    test('leaves a metric another check reports to it', () => {
      // The rule that a metric resolves to exactly one entity: two entities,
      // as the parser or that rule's patterns read them, or two that no
      // relationship connects, so that pruning drops the metric first.
      const two =
          onBigQuery(anchored('SUM(purchase.amount + customer.c_id) / 2'));
      const safe = onBigQuery(anchored('safe.divide(SUM(purchase.amount), 2)'));
      safe.entities.push({...safe.entities[0], name: 'safe'});
      const apart =
          onBigQuery(anchored('SUM(purchase.amount * shop.c_id) / 2'));
      apart.entities.push({...apart.entities[0], name: 'shop'});
      for (const [m, read] of [[two, 'purchase, customer'], [safe, 'safe, purchase'],
                               [apart, 'purchase, shop']] as const) {
        expect(check(m)).toEqual([]);
        expect(validatePushRequirements([loaded(m, 'commerce')])
                   .filter(e => e.includes("metric 'm'")))
            .toEqual([expect.stringContaining(
                `references multiple entities (${read})`)]);
      }
      // The reference rules: a field the entity does not declare.
      expect(bigQuery(anchored('SUM(purchase.amt) / 2'))).toEqual([]);
      // The binding rule: a field with no expression.
      expect(bigQuery('{ name: m, expression: "SUM(purchase.note) / 2" }'))
          .toEqual([READS('bigquery', 'm', 'purchase.note')]);
      // The inheritance rules: an abstract entity, and one that another extends.
      expect(bigQuery(anchored('SUM(purchase.amount) / 2'), {abstract: true}))
          .toEqual([]);
      const extended = onBigQuery(
          '{ name: m, entity: customer, expression: "SUM(customer.c_id) / 2" }');
      extended.entities.push(
          {...extended.entities[0], name: 'vip', extends: ['customer']});
      expect(check(extended)).toEqual([]);
    });
  });
});

describe('validateInlineDialects', () => {
  const SPANNER_TABLE =
      'spanner.googleapis.com/projects/p/instances/i/databases/db/tables/t';
  // A model whose entity `e` reads `source` and has field `f` with
  // `expression`, written as YAML. `extra` is the YAML of more entities.
  const withField = (source: string, expression: string, extra = '') =>
      loadOne('m', `    entities:
      - name: e
        source: ${source}
        primary_key: [id]
        fields:
          - { name: id, expression: id }
          - { name: f, expression: ${expression} }
${extra}`);
  const dialects = (...entries: string[]) =>
      `{ dialects: [${entries.map(e => `{ dialect: ${e}, expression: x }`)}] }`;
  const check = (m: SemanticModel, transpiled = false) =>
      validateInlineDialects(m, 'doc', {transpiled});
  // The error for field `f` of `entity`, whose source has `dialect`, ending
  // in `hint`. `a` is the article before the dialect.
  const MISSING = (entity: string, dialect: string, hint = '', a = 'a') =>
      `field '${entity}.f' in model 'm' (doc) has no expression for ${
          dialect} or ANSI_SQL, and the model file binds entity '${
          entity}' to ${a} ${dialect} source${hint}.`;
  const HINT = '; give it one, or pass --transpile';

  // A bound field needs a text for its source's dialect, an ANSI_SQL text, or
  // the string form. An inherited field is judged by the source of the entity
  // that inherits it.
  test('holds each bound field to the dialect of its own entity\'s source, and suggests --transpile only for a text it translates', () => {
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
                        errors: string[], transpiled?: boolean]> = [
      [SPANNER_TABLE, bigQueryText, '', [MISSING('e', 'SPANNER')]],
      [SPANNER_TABLE, dialects('SPANNER'), '', []],
      [SPANNER_TABLE, dialects('BIGQUERY', 'ANSI_SQL'), '', []],
      [SPANNER_TABLE, 'x', '', []],
      [BQ_TABLE('t'), bigQueryText, other, [MISSING('other', 'SPANNER')]],
      [BQ_TABLE('t'), bigQueryText, leaf, [MISSING('leaf', 'SPANNER')]],
      [BQ_TABLE('t'), dialects('SNOWFLAKE'), other,
       [MISSING('e', 'BIGQUERY', HINT), MISSING('other', 'SPANNER')]],
      // The message reads "an" before a dialect that starts with a vowel.
      [alloyDb, bigQueryText, '', [MISSING('e', 'ALLOYDB', '', 'an')]],
      // With --transpile, push translates a Snowflake text into BigQuery SQL.
      // It translates no Spanner or AlloyDB text.
      [BQ_TABLE('t'), dialects('SNOWFLAKE'), '', [MISSING('e', 'BIGQUERY', HINT)]],
      [BQ_TABLE('t'), dialects('SNOWFLAKE'), '', [], true],
      [SPANNER_TABLE, dialects('SNOWFLAKE'), '', [MISSING('e', 'SPANNER')], true],
      [BQ_TABLE('t'), dialects('SPANNER'), '', [MISSING('e', 'BIGQUERY')]],
      [BQ_TABLE('t'), dialects('SPANNER'), '', [MISSING('e', 'BIGQUERY')], true],
      [BQ_TABLE('t'), dialects('ALLOYDB'), '', [MISSING('e', 'BIGQUERY')]],
      [BQ_TABLE('t'), dialects('ALLOYDB'), '', [MISSING('e', 'BIGQUERY')], true],
    ];
    for (const [source, expression, extra, errors, transpiled] of cases) {
      const actual = check(withField(source, expression, extra), transpiled);
      expect({source, expression, extra, transpiled, errors: actual})
          .toEqual({source, expression, extra, transpiled, errors});
    }
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
