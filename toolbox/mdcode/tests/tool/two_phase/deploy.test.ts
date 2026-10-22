// Tests that push checks every destination before it writes, then writes the
// catalog and deploys each deployment in order, with its own target and
// profile, and tests what push prints for each deployment
// (src/tool/commands.ts, checkBeforeWrites, liveErrors and pushInTwoPhases).

import {expect} from 'bun:test';

import {ALLOYDB, at, boundAt, boundTo, bqGraph, bqTable, Case, CUSTOMER, deploymentNames, err, has, kcResult, modelFile, msg, PREPARED, profileFile, PushRun, REAL, refused, scenarios, Scope, SNOWFLAKE_METRIC, SPANNER_CUSTOMER, spannerGraph, TRANSPILE_WARNING, when} from './harness';

const header = (d: string) => `\n-- Deployment '${d}' --`;

const sales = (s: Scope) =>
    modelFile(s).replace('name: commerce', 'name: sales');
const vanilla = (g: string) => ({google: {deploymentTargets: [bqGraph(g)]}});
const stops = (error: unknown, flags = {}) =>
    ({...refused(flags, error), log: []});
const NO_TARGET = has("model 'sales' (sales) declares 0 deployments");
const ONE_MODEL = err(
    "entry group 'commerce_eg' would receive 2 models, but only one model " +
    'per entry group is supported; split them into separate entry groups.');
const spannerAnswers =
    (what: string, status: number, body: string, error: string): Case => ({
      name: `a Spanner deployment whose database ${what} writes nothing`,
      deployments: [{name: 'sp', target: spannerGraph('g'), profile: 'ops'}],
      profiles: {ops: boundAt(SPANNER_CUSTOMER)},
      services: {getDatabase: {status, message: body}},
      errors: [err(`${at('sp')}: database test-project/i/db ${error}`)],
      called: {spannerDml: 0},
    });
const DISABLED = {code: 403, message: 'Cloud Spanner API is disabled.'};
const DENIED = {getDataset: {status: 403, message: 'Access Denied'}};
const NO_LOCATION = (project: string) =>
    `Warning: could not read location of dataset ${project}.d (Access ` +
    'Denied); letting BigQuery infer the query location';

scenarios('push writes nothing when a check fails', [
  {
    name: 'a push whose catalog leg fails its checks deploys no graph, and a ' +
        '--validate-only push reports the error before any live check',
    ...vanilla('g'),
    files: {'sales.yaml': sales({})},
    ...stops(NO_TARGET),
    then: [stops(NO_TARGET, {validateOnly: true})],
  },
  {
    name: 'a push of two model files whose GOOGLE block names the graph ' +
        'prints only the one-model error and checks no graph, as do a ' +
        '--validate-only, a catalog-only and a --no-deployment push',
    ...vanilla('g'),
    files: {'sales.yaml': sales(vanilla('h'))},
    ...stops(ONE_MODEL),
    then: [
      stops(ONE_MODEL, {validateOnly: true}),
      stops(ONE_MODEL, {validateOnly: true, profile: false}),
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
        "[commerce.profile.p.yaml] profile 'p': action 'refund' sets " +
        "'bogus', which a profile may not set; a profile carries only " +
        'physical bindings, and the logical model owns everything else')],
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
    }],
  },
  spannerAnswers('does not exist', 404, 'Not found', 'not found'),
  spannerAnswers(
      'answers 403', 403, JSON.stringify({error: DISABLED}),
      `could not be read: ${DISABLED.message}`),
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
      expect(r.fake.getDataset.mock.calls).toEqual([['graph-project', 'd']]);
      expect(r.fake.query.mock.calls
                 .filter(c => c[3] === true && c[1].includes('PROPERTY GRAPH'))
                 .map(c => [c[0], c[2]]))
          .toEqual([['graph-project', 'US']]);
    },
    // A dataset whose location cannot be read prints that warning too.
    then: [{services: DENIED, warnings: [NO_LOCATION('graph-project')]}],
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
// A graph deploy that fails outside --validate-only.
const failedDeploy = when(
    (_m: unknown, _c: unknown, o: any) => !o?.validateOnly,
    {success: false, details: 'boom', ddl: [], warnings: []});

const WITH_LTV = {...CUSTOMER, fields: [...CUSTOMER.fields, {name: 'ltv'}]};
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
// Relationships of `names` from Orders to Customer, and profile prod, which
// gives each its join columns.
const placedBy = (...names: string[]) => ({
  relationships: names.map(name => ({name, from: 'Orders', to: 'Customer'})),
  profiles: {
    prod: {
      entities: {
        Customer: {...CUSTOMER, source: bqTable('customer', 'prod')},
        Orders: {...ORDERS, source: bqTable('orders', 'prod')},
      },
      relationships: names.map(
          name => ({name, from_columns: ['customer_key'], to_columns: ['key']})),
    },
  },
});
const ALLOYDB_NOTE = "Note: deployment 'ad' targets an AlloyDB database, " +
    'which has no property graph, so push deploys no graph there. The model ' +
    'runs against that database as published to Knowledge Catalog.';

scenarios('how push deploys each deployment in order, and what it prints', [
  {
    name: 'deploys each deployment after the catalog write, in declared order or the order --deployment gives, with only its own deployment entry, its own profile and a header when there are several',
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
      const [[models, , opts]] = r.fake.preflight.mock.calls;
      expect(models).toHaveLength(1);
      const published = r.published;
      expect(published.entities[0].dataSource).toBe('test-project.d.customer');
      expect(published.profiles!.map(p => p.name).sort())
          .toEqual(['sp', 'x']);
      expect(published.deployments!.map(d => d.name))
          .toEqual(['c', 'a', 'b']);
      expect(opts.v2Aspects).toBe(false);
      expect(opts.sourceFiles).toHaveLength(3);
      expect(Object.fromEntries(opts.sourceFiles.map(
                 (f: any) => [f.fileName, f.content])))
          .toEqual({
            'commerce.yaml': modelFile(THREE),
            'commerce.profile.sp.yaml': profileFile('sp', THREE.profiles.sp),
            'commerce.profile.x.yaml': profileFile('x', THREE.profiles.x),
          });
    },
    then: [
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
    name: 'a failed catalog write, or a Spanner or BigQuery deployment that fails to deploy, stops the push',
    ...THREE,
    services: {spanner: failedDeploy},
    code: 1,
    events: ['preflight', 'apply', 'deploy c', 'deploy a'],
    errors: ['Error pushing semantic model to Spanner: boom'],
    then: [{
      services: {bq: failedDeploy},
      code: 1,
      events: ['preflight', 'apply', 'deploy c'],
      errors: ['Error pushing semantic model to BigQuery: boom'],
    }, {
      services: {apply: kcResult({success: false, details: 'x'})},
      code: 1,
      events: ['preflight', 'apply'],
    }],
  },
  {
    name: 'a profile that gives the join columns deploys, and with KC_V2_ASPECTS=1 so do relationships whose link IDs collide',
    deployments: [{name: 'g', profile: 'prod'}],
    entities: [CUSTOMER, ORDERS],
    ...placedBy('placed_by'),
    events: ['preflight', 'apply', 'deploy g'],
    then: [{
      v2Aspects: true,
      ...placedBy('placed_by', 'placed__by'),
      events: ['preflight', 'apply', 'deploy g'],
    }],
  },
  {
    name: 'an AlloyDB deployment deploys no graph and prints a note naming it, under its own header, and under --validate-only prints nothing',
    deployments: [
      {name: 'bq', target: bqGraph('g')},
      {name: 'ad', target: ALLOYDB, profile: 'pg'},
    ],
    profiles: {pg: boundAt(`${ALLOYDB}/schemas/public/tables/customer`)},
    events: ['preflight', 'apply', 'deploy bq'],
    calls: ['generate bq', 'getDataset', 'bqDml bq', 'deploy bq'],
    warnings: [ALLOYDB_NOTE],
    check: r => expect(r.printed.filter(
                           l => l.includes('-- Deployment') || l === ALLOYDB_NOTE))
                    .toEqual([header('bq'), header('ad'), ALLOYDB_NOTE]),
    then: [{
      flags: {validateOnly: true},
      log: [header('bq'), msg.VALIDATED],
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
      // and a push that deploys prints it with each graph.
      {
        flags: {validateOnly: true},
        services: DENIED,
        warnings: [
          NO_LOCATION('test-project'), 'Warning: ddl warning g1',
          'Warning: ddl warning g2',
        ],
      },
      {
        services: DENIED,
        warnings: [
          NO_LOCATION('test-project'), 'Warning: ddl warning g1',
          NO_LOCATION('test-project'), 'Warning: ddl warning g2',
        ],
      },
    ],
  },
  {
    name: 'prints once a pruning note that two deployments give, and a warning the catalog\'s model gave',
    entities: [WITH_LTV],
    metrics: [{name: 'broken', entity: 'Customer', expression: 'SUM((x'}],
    warnings: [
      "Warning: metric 'broken' in model 'commerce' (commerce): kcmd could " +
          'not read its SQL, so the fields it reads were not checked.',
      "Note: profile 'default' leaves 1 field(s) unbound.",
    ],
  },
  {
    // The model file binds no table, and g1's profile leaves field ltv unbound.
    name: 'prints no pruning note when a later deployment fails a local check, and names the profile in the note once every check passes',
    deployments: [{name: 'g1', profile: 'prod'}, {name: 'g2', profile: 'p2'}],
    entities: [{...WITH_LTV, source: undefined}],
    profiles: {
      prod: NO_LTV,
      // Push reads a profile's actions only when it applies the profile.
      p2: {...NO_LTV, actions: [{name: 'refund', bogus: 1}]},
    },
    code: 1,
    errors: [has("action 'refund'")],
    warnings: [],
    nothingWritten: true,
    then: [{
      flags: {deployment: ['g1']},
      code: 0,
      warnings: ["Note: profile 'prod' leaves 1 field(s) unbound."],
    }],
  },
  {
    name: '--transpile transpiles the catalog\'s model and each deployment\'s model, with the SQL its profile sets, and prints each warning once',
    deployments: ['g1', {name: 'g2', profile: 'p'}],
    entities: [WITH_SCORE],
    profiles: {p: scoreSql('p', 'SNOWFLAKE', 'IFF(score > 0, score, 0)')},
    metrics: [SNOWFLAKE_METRIC],
    flags: {validateOnly: true, transpile: true},
    calls: ['generate g1', 'generate g2'],
    warnings: [
      TRANSPILE_WARNING,
      "Warning: [commerce, deployment 'g2'] field 'Customer.score': " +
          "transpiled 'SNOWFLAKE' -> 'BIGQUERY'",
    ],
    check: r => {
      for (const models of [...r.fake.bq.mock.calls.map(c => c[0]),
                            r.fake.preflight.mock.calls[0][0]]) {
        expect(models[0].model.metrics?.[0]?.expression).toBeDefined();
      }
    },
  },
  {
    name: 'each deployment prints its own warning about the SQL its profile sets',
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
    warnings: [
      has("Warning: [commerce] note: no 'BIGQUERY' dialect"),
      ...['a', 'b'].map(
          d => "Warning: field 'Customer.score' in model 'commerce' " +
              `(commerce, deployment '${d}'): kcmd could not read its SQL, ` +
              'so the fields it reads were not checked.'),
    ],
  },
], {deployments: ['g1', 'g2'], code: 0});
