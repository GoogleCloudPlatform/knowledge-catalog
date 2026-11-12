// Tests that push checks every destination before it writes, then writes the
// catalog and deploys each deployment in order, with its own target and
// profile, and tests what push prints for each deployment
// (src/tool/commands.ts, checkBeforeWrites, liveErrors and pushInTwoPhases).

import {expect} from 'bun:test';

import {BigQueryClient} from '../../../src/libts/gcp/bigquery';
import {REGIONAL_INSTANCE} from '../../libts/gcp/location_responses';

import {ALLOYDB, at, boundAt, boundTo, bqGraph, bqTable, Case, CTX, CUSTOMER, deploymentNames, err, EXPRESSION_KEY, has, kcResult, modelFile, msg, PREPARED, pushed, PushRun, REAL, refused, scenarios, Scope, SNOWFLAKE_METRIC, SPANNER_CUSTOMER, spannerGraph, when} from './harness';

const header = (d: string) => `\n-- Deployment '${d}' --`;
// What push adds when deployment `d` fails after the catalog write.
const written = (d: string) =>
    `Knowledge Catalog already holds the new model, but deployment '${d}' ` +
    'did not deploy its graph. Fix the cause and push again to finish the ' +
    'deploy.';

const sales = (s: Scope) =>
    modelFile(s).replace('name: commerce', 'name: sales');
const vanilla = (g: string) =>
    ({google: {deployments: [{name: g, target: bqGraph(g)}]}});
const stops = (error: unknown, flags = {}) =>
    ({...refused(flags, error), log: []});
const ONE_MODEL = err(
    "entry group 'commerce_eg' would receive 2 models, but only one model " +
    'per entry group is supported; split them into separate entry groups.');
// A Spanner deployment of database test-project/i/db.
const SPANNER_DEPLOYMENT = {
  deployments: [{name: 'sp', target: spannerGraph('g'), profile: 'ops'}],
  profiles: {ops: boundAt(SPANNER_CUSTOMER)},
};
// The dialect lookup reads the database before any other check does. With
// `error`, only the deployment's own read, the second, gets the answer.
const spannerAnswers = (
    what: string, status: number, message: string, error?: string): Case => {
  let reads = 0;
  return {
    name: `a Spanner deployment whose database ${what} writes nothing`,
    ...SPANNER_DEPLOYMENT,
    services: {
      getDatabase: () => !error || reads++ ? {status, message} : undefined,
    },
    errors: [err(error ? `${at('sp')}: database test-project/i/db ${error}` :
        `source '${SPANNER_CUSTOMER}': kcmd reads its Spanner database's ` +
        `SQL dialect, and could not read database test-project/i/db: ${message}`)],
    called: {spannerDml: 0},
  };
};
const DISABLED = 'Cloud Spanner API is disabled.';
// Every dataset's location is unreadable. The source check reads tables, not
// datasets, so it still passes.
const DENIED = {getDataset: {status: 403, message: 'Access Denied'}};
const NO_LOCATION = (project: string) =>
    `Warning: could not read location of dataset ${project}.d (Access ` +
    'Denied); letting BigQuery infer the query location';
// The instance read answers REGIONAL_INSTANCE with `fields` changed.
const instanceIs = (fields: object) =>
    ({getInstance: {status: 200, result: {...REGIONAL_INSTANCE, ...fields}}});
// Answers `answer` to each read of the database after the first, which is the
// dialect lookup's.
const afterDialectLookup = (answer: object) => {
  let reads = 0;
  return when(() => reads++ > 0, answer);
};
const STANDARD_REFUSED = err(
    `${at('sp')}: instance test-project/i is a Standard edition instance, ` +
    'and Spanner Graph needs an Enterprise or Enterprise Plus edition ' +
    'instance. Upgrade the instance (gcloud spanner instances update i ' +
    '--edition=ENTERPRISE --project=test-project). To publish the model to ' +
    'Knowledge Catalog without this graph, leave the deployment out with ' +
    '--deployment or --no-deployment, or remove it.');

scenarios('push writes nothing when a check fails', [
  {
    name: 'a push of two model files whose GOOGLE block names the graph ' +
        'prints only the one-model error and checks no graph, as do a ' +
        '--validate-only and a --no-deployment push',
    ...vanilla('g'),
    files: {'sales.yaml': sales(vanilla('h'))},
    ...stops(ONE_MODEL),
    then: [
      stops(ONE_MODEL, {validateOnly: true}),
      stops(ONE_MODEL, {deployment: false}),
    ],
  },
  {
    name: 'a live source check that fails on the second deployment stops the push before the first graph deploys',
    services: {
      sources: when(
          models => deploymentNames(models) === 'g2',
          ["table 'test-project.d.customer' is not reachable from g2"]),
    },
    errors: [err("table 'test-project.d.customer' is not reachable from g2")],
    calls: ['generate g1', 'generate g2', 'sources g1', 'sources g2'],
    called: {preflight: 1},
  },
  {
    name: 'a deployment whose BigQuery dataset does not exist writes nothing',
    deployments: ['g1', {name: 'g2', target: bqGraph('g2', 'missing')}],
    services: {
      getDataset: when(
          (_project, dataset) => dataset === 'missing',
          {status: 404, message: 'Not found'}),
    },
    errors: [err(`${at('g2')}: dataset test-project.missing not found`)],
  },
  {
    name: 'a deployment whose profile does not apply with its actions writes nothing',
    deployments: [{name: 'g', profile: 'p'}],
    profiles: {p: {...boundTo('p'), actions: [{name: 'refund', bogus: 1}]}},
    errors: [err(
        "[commerce.profile.p.yaml] profile 'p': action 'refund': unknown " +
        "key 'bogus'; it takes 'name' and 'executor'")],
    called: {preflight: 0},
    then: [{
      profiles: {p: boundTo('p')},
      actions: [{
        name: 'refund',
        executor: {sql: {statements: ['UPDATE t SET a = 1 WHERE TRUE']}},
      }],
      code: 1,
      nothingWritten: true,
      errors: [err(
          `${at('g')}: profile 'p': action 'refund' in model 'commerce' ` +
          "declares a 'sql' executor. A statement names one database's " +
          'own tables and columns, so it belongs in the profile that ' +
          'binds them, not in the model. Move the executor into each ' +
          'profile that performs this write as DML.')],
    }, {
      actions: [{name: 'refund', executor: {mcp: {server: 's', tool: 't'}}}],
      profiles: {p: {...boundTo('p'), actions: [
        {name: 'refund', executor: {mcp: {server: 's', tool: ' '}}},
      ]}},
      code: 1,
      nothingWritten: true,
      errors: [err(
          "action 'refund' in model 'commerce' (commerce, deployment 'g') has " +
          "an mcp executor whose 'tool' is missing or blank.")],
    }],
  },
  spannerAnswers('does not exist', 404, 'Database not found.'),
  spannerAnswers('answers 403', 403, DISABLED),
  spannerAnswers('is gone at the second read', 404, 'Not found', 'not found'),
  spannerAnswers(
      'answers 403 at the second read', 403, DISABLED,
      `could not be read: ${DISABLED}`),
  {
    name: 'a graph DDL that fails a BigQuery dry run stops the push before the catalog write',
    deployments: [{
      name: 'g',
      target: bqGraph('g').replace('test-project', 'graph-project'),
    }],
    services: {
      query: when(
          (_project, sql) => sql.includes('PROPERTY GRAPH'),
          {status: 400, message: "Column 'c_key' not found"}),
    },
    errors: [err(
        `${at('g')}: the graph's DDL fails a BigQuery dry run: Column ` +
        "'c_key' not found.")],
    // The dry run runs in the dataset's project and location.
    check: r => {
      // The source check reads table customer; the dry run, the graph's
      // dataset.
      expect(r.fake.getTable.mock.calls)
          .toEqual([['test-project', 'd', 'customer']]);
      expect(r.fake.getDataset.mock.calls).toEqual([['graph-project', 'd']]);
      expect(r.fake.query.mock.calls
                 .filter(c => c[3] === true && c[1].includes('PROPERTY GRAPH'))
                 .map(c => [c[0], c[2]]))
          .toEqual([['graph-project', 'US']]);
    },
    // A dataset whose location cannot be read prints that warning too.
    then: [{
      flags: {}, services: DENIED, warnings: [NO_LOCATION('graph-project')],
    }],
  },
  {
    name: 'a Spanner deployment on a Standard edition instance writes nothing and checks no DML, also under --validate-only or --skip-source-check, and a missing database is reported first',
    ...SPANNER_DEPLOYMENT,
    services: instanceIs({edition: 'STANDARD'}),
    errors: [STANDARD_REFUSED],
    called: {spannerDml: 0},
    then: [
      {flags: {validateOnly: true}, errors: [STANDARD_REFUSED]},
      {flags: {skipSourceCheck: true}, errors: [STANDARD_REFUSED]},
      {
        services: {getDatabase: afterDialectLookup({status: 404})},
        errors: [err(`${at('sp')}: database test-project/i/db not found`)],
      },
    ].map(step => ({code: 1, nothingWritten: true, called: {spannerDml: 0}, ...step})),
  },
], {
  deployments: ['g1', 'g2'],
  code: 1,
  nothingWritten: true,
});

const THREE = {
  deployments: [
    {name: 'c', target: bqGraph('gc')},
    {name: 'a', target: spannerGraph('ga'), profile: 'sp'},
    {name: 'b', target: bqGraph('gb'), profile: 'x'},
  ],
  profiles: {
    sp: boundAt(SPANNER_CUSTOMER),
    x: boundTo('x'),
  },
};
const IN_ORDER = ['preflight', 'apply', 'deploy c', 'deploy a', 'deploy b'];
// Each deployment of THREE, the service that deploys it, its target and the
// source it gives Customer.
const THREE_DEPLOYED = [
  ['c', 'bq', bqGraph('gc'), 'test-project.d.customer'],
  ['a', 'spanner', spannerGraph('ga'), `//${SPANNER_CUSTOMER}`],
  ['b', 'bq', bqGraph('gb'), 'test-project.x.customer'],
] as const;
const headers = (r: PushRun) => r.log.filter(l => l.includes('-- Deployment'));
// BigQuery's answer to a graph over a limit, shaped as a live push got it, with
// a stack trace in its two debug fields.
const LIMIT = '[BigQueryPropertyGraphUserError]: Property graph label ' +
    '[customer] has description length [1025] which exceeds the maximum ' +
    'allowed length [1024].';
const STACK = '\tat com.google.Frame.call(Frame.java:1)\n'.repeat(500);
const REJECTED = JSON.stringify({
  error: {
    code: 400,
    message: LIMIT,
    errors: [{message: LIMIT, reason: 'invalid', debugInfo: STACK}],
    status: 'INVALID_ARGUMENT',
    details: [{'@type': 'google.rpc.DebugInfo', detail: STACK}],
  },
}, null, 2);
// A graph deploy that fails outside --validate-only.
const failedDeploy = when(
    (_m: unknown, _c: unknown, o: any) => !o?.validateOnly,
    {success: false, details: 'boom', ddl: [], warnings: []});

const WITH_LTV = {...CUSTOMER, fields: [...CUSTOMER.fields, {name: 'ltv'}]};
const LTV2 = {name: 'ltv2', expression: 'Customer.ltv * 2'};
const NO_LTV = {
  entities: {
    Customer: {
      ...CUSTOMER,
      source: bqTable('customer', 'prod'),
      fields_exclude: ['ltv'],
    },
  },
};
const WITH_SCORE = {
  ...CUSTOMER,
  fields: [...CUSTOMER.fields, {name: 'score', expression: 'score'}],
};
// The warning about the SQL profile `p` writes for field score.
const unreadScore = (p: string) =>
    `Warning: [commerce.profile.${p}.yaml] profile '${p}': kcmd could not ` +
    "read the SQL of field 'Customer.score', so the fields it reads were not " +
    'checked';
// Binds field score to `expression`, written in `dialect`.
const scoreSql = (name: string, dialect: string, expression: string) => ({
  entities: {
    Customer: {
      ...CUSTOMER,
      source: bqTable('customer', name),
      fields: [
        ...CUSTOMER.fields,
        {name: 'score', expression: {dialects: [{dialect, expression}]}},
      ],
    },
  },
});
// Entity Orders, bound to table orders in dataset d.
const ORDERS = {
  name: 'Orders',
  source: bqTable('orders'),
  primary_key: ['id'],
  fields: [{name: 'id', expression: 'o_id'}],
};
// Relationship placed_by from Orders to Customer, and profile prod, which
// gives it its join columns.
const PLACED_BY = {
  relationships: [{name: 'placed_by', from: 'Orders', to: 'Customer'}],
  profiles: {
    prod: {
      entities: {
        Customer: {...CUSTOMER, source: bqTable('customer', 'prod')},
        Orders: {...ORDERS, source: bqTable('orders', 'prod')},
      },
      relationships: [
        {name: 'placed_by', from_columns: ['customer_key'], to_columns: ['key']},
      ],
    },
  },
};
const SP_DEPLOYED = ['preflight', 'apply', 'deploy sp'];
const ALLOYDB_NOTE = "Note: deployment 'ad' targets an AlloyDB database, " +
    'which has no property graph, so push deploys no graph there. The model ' +
    'runs against that database as published to Knowledge Catalog.';

scenarios('how push deploys each deployment in order, and what it prints', [
  {
    name: 'deploys each deployment after the catalog write, also under a bare --profile, in declared order or the order --deployment gives, with only its own deployment entry, its own profile and a header when there are several',
    ...THREE,
    events: IN_ORDER,
    called: {preflight: 1, bqDml: 2, spannerDml: 1},
    check: r => {
      expect(r.fake.apply.mock.calls[0][0]).toBe(PREPARED);
      expect(headers(r)).toEqual(['c', 'a', 'b'].map(header));
      for (const [name, service, target, source] of THREE_DEPLOYED) {
        const model = r.deployed(name, service)!;
        expect(model.deployments!.map(d => [d.name, d.target])).toEqual([
          [name, target],
        ]);
        expect(model.entities[0].dataSource).toBe(source);
        expect(model.profiles!.map(p => p.name).sort()).toEqual(['sp', 'x']);
      }
      const [[models]] = r.fake.preflight.mock.calls;
      expect(models).toHaveLength(1);
      const published = r.published;
      expect(published.entities[0].dataSource).toBe('test-project.d.customer');
      expect(published.profiles!.map(p => p.name).sort())
          .toEqual(['sp', 'x']);
      expect(published.deployments!.map(d => d.name))
          .toEqual(['c', 'a', 'b']);
    },
    then: [
      // cac gives `true` for a bare --profile and for no --profile alike.
      {flags: {profile: true}, code: 0, events: IN_ORDER},
      {
        flags: {deployment: ['b,a']},
        code: 0,
        events: ['preflight', 'apply', 'deploy b', 'deploy a'],
      },
      {
        deployments: [THREE.deployments[0]],
        code: 0,
        check: r => expect(headers(r)).toEqual([]),
      },
    ],
  },
  {
    name: 'a failed catalog write, or a Spanner or BigQuery deployment that fails to deploy, stops the push, and a failed deploy says the catalog already holds the model',
    ...THREE,
    services: {spanner: failedDeploy},
    code: 1,
    events: ['preflight', 'apply', 'deploy c', 'deploy a'],
    errors: ['Error pushing semantic model to Spanner: boom', written('a')],
    then: [{
      services: {bq: failedDeploy},
      code: 1,
      events: ['preflight', 'apply', 'deploy c'],
      errors: ['Error pushing semantic model to BigQuery: boom', written('c')],
    }, {
      services: {apply: kcResult({success: false, details: 'x'})},
      code: 1,
      events: ['preflight', 'apply'],
    }],
  },
  {
    name: 'a graph BigQuery rejects prints the message of its error body alone',
    deployments: ['g'],
    services: {
      bq: (...a: any[]) => REAL.bq(...a),
      query: (...a: any[]) =>
          a[3] ? undefined : REAL.query.apply(new BigQueryClient(CTX), a),
      fetch: async () => new Response(REJECTED, {status: 400}),
    },
    code: 1,
    errors: [
      `Error pushing semantic model to BigQuery: Failed to deploy 'g': ${LIMIT}`,
      written('g'),
    ],
  },
  {
    name: 'a Spanner deployment deploys on an Enterprise or Enterprise Plus edition instance, and under --skip-source-check when its instance cannot be read',
    ...SPANNER_DEPLOYMENT,
    services: instanceIs({edition: 'ENTERPRISE'}),
    events: SP_DEPLOYED,
    warnings: [],
    then: [
      {services: instanceIs({edition: 'ENTERPRISE_PLUS'})},
      // The source check fails when it cannot read the instance.
      {
        flags: {skipSourceCheck: true},
        services: {getInstance: {status: 403}},
        warnings: [
          'Warning: could not read the edition of instance test-project/i ' +
          '(403); Spanner Graph needs an Enterprise or Enterprise Plus ' +
          'edition instance',
        ],
      },
      {
        flags: {skipSourceCheck: true},
        services: {getInstance: {status: 403, message: 'Access Denied'}},
        warnings: [
          'Warning: could not read the edition of instance test-project/i ' +
          '(Access Denied); Spanner Graph needs an Enterprise or Enterprise ' +
          'Plus edition instance',
        ],
      },
    ].map(step => ({code: 0, events: SP_DEPLOYED, warnings: [], ...step})),
  },
  {
    name: 'a Spanner deployment on a Standard edition instance lets the model publish when push leaves it out with --no-deployment or --deployment, or when it is removed',
    ...SPANNER_DEPLOYMENT,
    services: instanceIs({edition: 'STANDARD'}),
    flags: {deployment: false},
    events: ['preflight', 'apply'],
    then: [
      {
        deployments: [...SPANNER_DEPLOYMENT.deployments, 'g'],
        flags: {deployment: ['g']},
        events: ['preflight', 'apply', 'deploy g'],
      },
      {deployments: [], events: ['preflight', 'apply']},
    ].map(step => ({code: 0, ...step})),
  },
  {
    name: 'a profile that gives the join columns deploys',
    deployments: [{name: 'g', profile: 'prod'}],
    entities: [CUSTOMER, ORDERS],
    ...PLACED_BY,
    events: ['preflight', 'apply', 'deploy g'],
  },
  {
    name: 'an AlloyDB deployment says a field it leaves out, and one that reads it, is unavailable there',
    deployments: [{name: 'ad', target: ALLOYDB}],
    entities: [{
      ...WITH_LTV, source: `${ALLOYDB}/schemas/public/tables/customer`,
      fields: [...WITH_LTV.fields, LTV2],
    }],
    flags: {validateOnly: true},
    warnings: [
      "Warning: field 'Customer.ltv' in model 'commerce' (commerce, " +
          "deployment 'ad') has no expression, so it is unavailable there.",
      "Warning: field 'Customer.ltv2' in model 'commerce' (commerce, " +
          "deployment 'ad') reads Customer.ltv, which is unavailable, so it " +
          'is unavailable there.',
    ],
  },
  {
    // Vip extends Customer and binds ltv, so Customer is no leaf.
    name: 'a BigQuery deployment says the graph omits a field with no expression of an entity another entity extends',
    deployments: ['g'],
    entities: [WITH_LTV, {
      ...CUSTOMER, name: 'Vip', extends: ['Customer'], source: bqTable('vip'),
      fields: [...CUSTOMER.fields, {name: 'ltv', expression: 'ltv'}],
    }],
    flags: {validateOnly: true},
    warnings: [
      "Warning: field 'Customer.ltv' in model 'commerce' (commerce, " +
          "deployment 'g') has no expression, so the graph omits it.",
    ],
  },
  {
    name: 'an AlloyDB deployment deploys no graph and prints a note naming it, under its own header, and under --validate-only prints nothing',
    deployments: [
      {name: 'bq', target: bqGraph('g')},
      {name: 'ad', target: ALLOYDB, profile: 'pg'},
    ],
    profiles: {pg: boundAt(`${ALLOYDB}/schemas/public/tables/customer`)},
    events: ['preflight', 'apply', 'deploy bq'],
    // The source check reads table customer, then push reads the graph's
    // dataset.
    calls: ['generate bq', 'getTable', 'getDataset', 'bqDml bq', 'deploy bq'],
    warnings: [ALLOYDB_NOTE],
    check: r => expect(r.printed.filter(
                           l => l.includes('-- Deployment') || l === ALLOYDB_NOTE))
                    .toEqual([header('bq'), header('ad'), ALLOYDB_NOTE]),
    // A header prints only above what prints under it.
    then: [{
      flags: {validateOnly: true},
      log: [msg.VALIDATED],
      warnings: [],
    }],
  },
  {
    name: 'prints each deployment\'s DDL warnings once, and its DDL only under --print, and one completion line',
    flags: {validateOnly: true},
    services: {
      bq: async (...a: any[]) => {
        const r = await REAL.bq(...a);
        return {
          ...r,
          warnings: [...r.warnings, `ddl warning ${deploymentNames(a[0])}`],
        };
      },
    },
    warnings: ['Warning: ddl warning g1', 'Warning: ddl warning g2'],
    log: [header('g1'), header('g2'), msg.VALIDATED],
    events: ['preflight'],
    nothingWritten: true,
    then: [
      {
        flags: {validateOnly: true, print: true},
        check: r => expect(r.log.slice(0, 6)).toEqual([
          header('g1'), '-- BigQuery Graph --',
          expect.stringContaining('PROPERTY GRAPH `test-project.d.g1`'),
          header('g2'), '-- BigQuery Graph --',
          expect.stringContaining('PROPERTY GRAPH `test-project.d.g2`'),
        ]),
      },
      // A push that deploys prints them once too.
      {warnings: ['Warning: ddl warning g1', 'Warning: ddl warning g2']},
      // A dataset whose location cannot be read prints that warning once,
      // and a push that deploys prints every warning before it writes.
      {
        flags: {validateOnly: true},
        services: DENIED,
        warnings: [
          NO_LOCATION('test-project'), 'Warning: ddl warning g1',
          'Warning: ddl warning g2',
        ],
      },
      {
        flags: {},
        services: DENIED,
        warnings: [
          NO_LOCATION('test-project'), 'Warning: ddl warning g1',
          'Warning: ddl warning g2',
        ],
        check: r => expect(r.printed.indexOf(
                               'Pushing semantic model (Knowledge Catalog)...'))
                        .toBe(r.printed.indexOf('Warning: ddl warning g2') + 1),
      },
    ],
  },
  {
    name: 'rejects before any write, also in the report, deployments of the model file\'s own bindings that leave a field of a concrete leaf entity without an expression, and deploys once the field has one or the deployment uses a profile that excludes it',
    entities: [WITH_LTV],
    code: 1,
    errors: [err(
        "model 'commerce' (commerce) deployments 'g1' and 'g2' use the model " +
        "file's own bindings, which leave field 'Customer.ltv' without an " +
        'expression; a graph deployment needs every field of a concrete leaf ' +
        'entity bound. Give the field an expression, or use a named profile ' +
        "that lists it in 'fields_exclude'.")],
    warnings: [],
    nothingWritten: true,
    then: [{
      entities: [{
        ...CUSTOMER,
        fields: [...CUSTOMER.fields, {name: 'ltv', expression: 'ltv'}],
      }],
      code: 0,
      warnings: [],
    }, {
      deployments: [{name: 'g1', profile: 'prod'}],
      profiles: {prod: NO_LTV},
      code: 0,
      warnings: ["Note: model 'commerce' (commerce, deployment 'g1') " +
                 "excludes field 'Customer.ltv'."],
    }],
    report: {code: 1, rejects: {'no profiles': [pushed()]}},
  },
  {
    // Both deployments deploy a graph named g, in datasets d and s.
    name: 'prints once a warning the catalog\'s model gave and one both graphs give',
    deployments: [
      {name: 'g1', target: bqGraph('g')},
      {name: 'g2', target: bqGraph('g', 's')},
    ],
    metrics: [{name: 'broken', entity: 'Customer', expression: 'SUM((x'}],
    warnings: [
      "Warning: metric 'broken' in model 'commerce' (commerce): kcmd could " +
          'not read its SQL, so the fields it reads were not checked.',
      "Warning: [commerce -> g] metric 'broken' expression 'SUM((x' cannot " +
          'be a measure: the SQL parser cannot read it as one expression; ' +
          'skipped',
    ],
  },
  {
    // The model file binds no table, and g1's profile leaves field ltv unbound.
    name: 'prints no pruning note when a later deployment fails a local check, also when push does not select it, and prints the note once every check passes',
    deployments: [{name: 'g1', profile: 'prod'}, {name: 'g2', profile: 'p2'}],
    entities: [{...WITH_LTV, source: undefined}],
    profiles: {
      prod: NO_LTV,
      p2: {...NO_LTV, actions: [{name: 'refund', bogus: 1}]},
    },
    code: 1,
    errors: [has("action 'refund'")],
    warnings: [has("unbound 'default' profile")],
    nothingWritten: true,
    then: [{
      flags: {deployment: ['g1']},
      code: 1,
      errors: [has("action 'refund'")],
      nothingWritten: true,
    }, {
      profiles: {prod: NO_LTV, p2: NO_LTV},
      flags: {deployment: ['g1']},
      code: 0,
      warnings: [has("unbound 'default' profile"),
                 "Note: model 'commerce' (commerce, deployment 'g1') " +
                     "excludes field 'Customer.ltv'."],
    }],
  },
  {
    name: 'names in a note what a profile excludes and leaves unavailable',
    deployments: [{name: 'g1', profile: 'prod'}],
    entities: [{...WITH_LTV, fields: [...WITH_LTV.fields, LTV2]}],
    metrics: ['total', 'top'].map(
        name => ({name, entity: 'Customer', expression: 'SUM(Customer.ltv)'})),
    actions: [{name: 'refund'}],
    profiles: {
      prod: {
        entities: {Customer: {
          ...NO_LTV.entities.Customer, fields_exclude: ['ltv', 'ltv2'],
        }},
        metrics_exclude: '*',
      },
    },
    flags: {validateOnly: true},
    warnings: [
      has('1 action(s) published as semantic-action entries'),
      "Note: model 'commerce' (commerce, deployment 'g1') excludes fields " +
          "'Customer.ltv' and 'Customer.ltv2'. It leaves metrics 'total' and " +
          "'top', and action 'refund' unavailable.",
    ],
    then: [{
      metrics:
          [{name: 'total', entity: 'Customer', expression: 'SUM(Customer.ltv)'}],
      flags: {validateOnly: true},
      warnings: [
        has('1 action(s) published as semantic-action entries'),
        "Note: model 'commerce' (commerce, deployment 'g1') excludes fields " +
            "'Customer.ltv' and 'Customer.ltv2'. It leaves metric 'total' and " +
            "action 'refund' unavailable.",
      ],
    }, {
      deployments: ['g'],
      entities: [CUSTOMER],
      metrics: undefined,
      profiles: undefined,
      code: 0,
      warnings: ["Note: model 'commerce' (commerce, deployment 'g') leaves " +
                 "action 'refund' unavailable."],
    }],
  },
  {
    name: 'each profile prints its own warning about the SQL it sets, also ' +
        'when --deployment stops at another profile',
    deployments: [
      {name: 'a', target: bqGraph('ga'), profile: 'pa'},
      {name: 'b', target: bqGraph('gb'), profile: 'pb'},
    ],
    entities: [WITH_SCORE],
    profiles: {
      pa: scoreSql('pa', 'ANSI_SQL', '((pa'),
      pb: scoreSql('pb', 'ANSI_SQL', '((pb'),
    },
    flags: {validateOnly: true},
    warnings: ['pa', 'pb'].map(unreadScore),
    then: [{
      profiles: {
        pa: scoreSql('pa', 'ANSI_SQL', '((pa'),
        pb: {entities: {Customer: EXPRESSION_KEY}},
      },
      flags: {deployment: ['a']},
      code: 1,
      warnings: [unreadScore('pa')],
    }],
  },
  {
    name: 'push accepts @name inside SQL comments of a profile action, ' +
        'omits commented parameters from BigQuery dry-run, and still catches ' +
        'an undeclared binding after # on AlloyDB',
    deployments: [
      {name: 'bq', target: bqGraph('g'), profile: 'bigquery'},
      {name: 'sp', target: spannerGraph('g'), profile: 'spanner'},
      {name: 'pg', target: ALLOYDB, profile: 'alloydb'},
    ],
    actions: [{
      name: 'refund',
      parameters: [
        {name: 'id', type: 'Integer', description: 'The customer key.'},
        {name: 'note', type: 'String', description: 'Optional note.'},
      ],
    }],
    profiles: {
      bigquery: {
        ...boundTo('d'),
        actions: [{
          name: 'refund',
          executor: {
            sql: {
              statements: [
                'UPDATE `test-project.d.customer` SET c_key = c_key WHERE c_key = @id -- @note (@undeclared)',
              ],
            },
          },
        }],
      },
      spanner: {
        ...boundAt(SPANNER_CUSTOMER),
        actions: [{
          name: 'refund',
          executor: {
            sql: {
              statements: [
                'UPDATE Customer SET c_key = c_key WHERE c_key = @id -- @undeclared',
                'UPDATE Customer SET c_key = c_key WHERE c_key = @id /* @undeclared */',
                '# @undeclared\rUPDATE Customer SET c_key = c_key WHERE c_key = @id',
              ],
            },
          },
        }],
      },
      alloydb: {
        ...boundAt(`${ALLOYDB}/schemas/public/tables/customer`),
        actions: [{
          name: 'refund',
          executor: {
            sql: {
              statements: [
                '/* outer /* inner */ @undeclared */ UPDATE customer SET c_key = c_key WHERE c_key = @id -- @other',
                'WITH s AS (SELECT doc #>> \'{k}\' AS k FROM customer) UPDATE customer SET note = s.k FROM s WHERE c_key = @id',
              ],
            },
          },
        }],
      },
    },
    services: {
      bqDml: (...a: any[]) => REAL.bqDml(...a),
    },
    code: 0,
    check: r => {
      const dmlCalls = r.fake.query.mock.calls.filter(
          c => c[3] === true && String(c[1]).startsWith('UPDATE'));
      expect(dmlCalls.map(c => c[4])).toEqual([{id: 'INT64'}]);
    },
    then: [{
      profiles: {
        bigquery: boundTo('d'),
        spanner: boundAt(SPANNER_CUSTOMER),
        alloydb: {
          ...boundAt(`${ALLOYDB}/schemas/public/tables/customer`),
          actions: [{
            name: 'refund',
            executor: {
              sql: {
                statements: [
                  'UPDATE customer SET c_key = c_key #- \'{draft}\' WHERE c_key = @missing',
                ],
              },
            },
          }],
        },
      },
      code: 1,
      nothingWritten: true,
      errors: [err(
          "action 'refund' in model 'commerce' (commerce, deployment 'pg') " +
          "has a sql executor whose statement 1 binds '@missing', but action " +
          "'refund' declares no parameter of that name.")],
    }, {
      deployments: [{name: 'pg', target: ALLOYDB}],
      entities: [{
        name: 'Customer',
        abstract: true,
        fields: [{name: 'key', datatype: 'Integer'}],
      }],
      profiles: undefined,
      actions: [{
        name: 'refund',
        parameters: [{name: 'id', type: 'Integer', description: 'The customer key.'}],
        executor: {
          sql: {
            statements: [
              'WITH s AS (SELECT doc #>> \'{k}\' AS k FROM customer) UPDATE customer SET note = s.k FROM s WHERE c_key = @id',
              '/* outer /* inner */ @undeclared */ UPDATE customer SET c_key = c_key WHERE c_key = @id',
            ],
          },
        },
      }],
      code: 0,
    }, {
      deployments: [{name: 'pg', target: ALLOYDB}],
      entities: [{
        name: 'Customer',
        abstract: true,
        fields: [{name: 'key', datatype: 'Integer'}],
      }],
      profiles: undefined,
      actions: [{
        name: 'refund',
        parameters: [],
        executor: {
          sql: {
            statements: [
              'UPDATE customer SET doc = doc #- \'{a}\' WHERE c_key = @missing',
            ],
          },
        },
      }],
      code: 1,
      nothingWritten: true,
      errors: [has("binds '@missing'")],
    }],
  },
], {deployments: ['g1', 'g2'], code: 0});

// A deployment push does not select fails the push as a selected one does,
// also under --no-deployment.
const unselected = (name: string, scope: Scope, selected: string,
                    ...errors: unknown[]): Case => ({
  name, ...scope, flags: {deployment: [selected]}, code: 1, errors,
  nothingWritten: true,
  then: [{flags: {deployment: false}, code: 1, errors, nothingWritten: true}],
});
const AB = [{name: 'a', expression: 'c_a'}, {name: 'b', expression: 'c_b'}];

scenarios('a deployment push does not select gets every local check of a selected one', [
  unselected('a profile whose fields name each other', {
    deployments: ['g', {name: 'x', profile: 'x'}],
    entities: [{...CUSTOMER, fields: [...CUSTOMER.fields, ...AB]}],
    profiles: {x: {entities: {Customer: {
      ...CUSTOMER, source: bqTable('customer', 'x'),
      fields: [...CUSTOMER.fields, {name: 'a', expression: 'Customer.b'},
               {name: 'b', expression: 'Customer.a'}],
    }}}},
  }, 'g',
  ...['a', 'b'].map(f => has("[commerce.profile.x.yaml] profile 'x': " +
                            `field 'Customer.${f}' names itself`))),
  unselected('a profile action the model does not declare', {
    deployments: ['g', {name: 'x', profile: 'x'}],
    profiles: {x: {...boundTo('x'), actions: [
      {name: 'ghost', executor: {sql: {statements: ['UPDATE t SET a = 1']}}},
    ]}},
  }, 'g', err(`${at('x')}: profile 'x': action 'ghost' is not in the logical model`)),
  unselected('a profile action whose statement is a query', {
    deployments: ['g', {name: 'x', profile: 'x'}],
    actions: [{name: 'refund'}],
    profiles: {x: {...boundTo('x'), actions: [
      {name: 'refund', executor: {sql: {statements: ['SELECT 1']}}},
    ]}},
  }, 'g', has("has a sql executor whose statement 1 starts with 'SELECT'")),
  unselected('a metric with only Snowflake SQL on a BigQuery deployment of the model file\'s bindings', {
    deployments: ['g', {name: 'x', profile: 'x'}],
    metrics: [{...SNOWFLAKE_METRIC, entity: 'Customer'}],
    profiles: {x: {...boundTo('x'), metrics_exclude: '*'}},
  }, 'x', has("deployment 'g') targets a BigQuery graph with only a 'SNOWFLAKE' expression")),
  {
    name: 'a graph with no node table',
    deployments: ['g'],
    entities: [{name: 'Party', abstract: true, fields: [{name: 'key'}]}],
    flags: {deployment: false}, code: 1, nothingWritten: true,
    errors: [has(`${at('g')}: cannot generate a property graph`)],
  },
]);
