// Tests for `kcmd push --no-deployment`, which publishes the model to
// Knowledge Catalog and deploys nothing, and for the local checks that refuse
// a scope before any network call (src/tool/commands.ts, checkBeforeWrites).

import {expect, mock, spyOn} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {createSemanticRuntimes} from '../../../src/libts/semantic/runtime/runtime';

import {ALLOYDB, boundAt, boundTo, bqGraph, bqTable, Case, CTX, CUSTOMER, err, EXPRESSION_KEY, has, kcResult, modelFile, msg, PREPARED, profileFile, pushed, scenarios, Scope, SNOWFLAKE_METRIC, SPANNER_CUSTOMER, writeScope} from './harness';

const PROD = boundTo('prod');
const PLAN = ['-- Knowledge Catalog --', 'PLAN LINE'];
// The warning that BigQuery reads field key's ANSI_SQL "c_key" as text, after
// `label`.
const quotedKey = (label: string) => `Warning: ${label}[commerce] field ` +
    `'Customer.key': BigQuery reads "c_key" in its 'ANSI_SQL' expression as ` +
    `text; if you meant a column or a field, give it a 'BIGQUERY' expression ` +
    `that names a column alone, in backticks if it needs quoting, and a field ` +
    `of the entity whose fields list holds this expression as ` +
    `'<entity>.<field>'`;
const NOTE = has("Warning: [commerce] note: no 'BIGQUERY' dialect");
// Customer on `source`, its key field given as `text` in `dialect`.
const keyAt = (source: string, text: string, dialect = 'ANSI_SQL') => ({
  ...CUSTOMER, source,
  fields: [{name: 'key', expression: {dialects: [{dialect, expression: text}]}}],
});
// A profile that binds Customer to table customer in dataset `name`.
const keyIn = (name: string, text: string, dialect?: string) =>
    ({entities: {Customer: keyAt(bqTable('customer', name), text, dialect)}});

// A catalog preflight that plans one line and gives `result`.
const planned = (result = {}) =>
    ({preflight: {result: kcResult({plan: ['PLAN LINE'], ...result})}});

scenarios('push --no-deployment', [
  {
    name: '--no-deployment passes the catalog a deployment that names a profile file, with that profile attached',
    deployments: [{name: 'g', profile: 'prod'}],
    profiles: {prod: PROD},
    flags: {validateOnly: true},
    code: 0, log: [msg.VALIDATED],
    called: {preflight: 1, sources: 0, query: 0},
    check: r => {
      expect(r.published.deployments?.map(d => [d.name, d.profile]))
          .toEqual([['g', 'prod']]);
      expect(r.published.profiles?.map(p => p.name)).toEqual(['prod']);
    },
  },
  {
    name: '--no-deployment publishes to Knowledge Catalog, printing the preflight\'s warnings, and deploys nothing, also when only the deployment\'s profile gives a join its columns',
    deployments: ['g1', 'g2'],
    // cac gives `profile: true` when --profile is absent.
    flags: {profile: true},
    services: {preflight: {prepared: {...PREPARED, warnings: ['w']}}},
    code: 0,
    events: ['preflight', 'apply'],
    // Push generates each deployment's graph offline, and deploys none.
    calls: ['generate g1', 'generate g2'],
    called: {spanner: 0, sources: 0},
    warnings: ['Warning: w'],
    then: [{
      deployments: [{name: 'g1', profile: 'prod'}],
      entities: [CUSTOMER, {...CUSTOMER, name: 'Order', source: bqTable('o')}],
      relationships: [{name: 'refers', from: 'Order', to: 'Customer'}],
      profiles: {prod: {
        entities: {
          ...PROD.entities,
          Order: {...CUSTOMER, name: 'Order', source: bqTable('o', 'prod')},
        },
        relationships: [
          {name: 'refers', from_columns: ['key'], to_columns: ['key']},
        ],
      }},
      code: 0,
    }],
  },
  {
    // Push translates nothing; kcmd import --transpile does.
    name: 'a vendor-only metric and an ANSI_SQL metric that double-quotes a name reach Knowledge Catalog as written, each with the loader\'s warning',
    metrics: [SNOWFLAKE_METRIC, {
      name: 'quoted_keys', entity: 'Customer',
      expression: {dialects: [{dialect: 'ANSI_SQL', expression: 'SUM("key")'}]},
    }],
    flags: {validateOnly: true},
    code: 0,
    warnings: [
      has('needs transpilation'),
      has("metric 'quoted_keys': BigQuery reads \"key\" in its 'ANSI_SQL' expression as text"),
    ],
    then: [{
      // Push checks no model-file metric against a Spanner table's dialect,
      // so the load's warning is the only message.
      entities: [{...CUSTOMER, source: SPANNER_CUSTOMER}],
      metrics: [SNOWFLAKE_METRIC],
      code: 0,
      warnings: [has("metric 'positive_keys': no 'SPANNER' or 'ANSI_SQL' dialect")],
    }, {
      // Push rejects a model-file field its Spanner table cannot run, with
      // no warning beside the error, with and without --no-deployment.
      entities: [keyAt(SPANNER_CUSTOMER, 'c_key', 'BIGQUERY')], metrics: [],
      code: 1, warnings: [],
    }, {
      entities: [keyAt(SPANNER_CUSTOMER, 'c_key', 'BIGQUERY')], metrics: [],
      flags: {deployment: undefined, validateOnly: true}, code: 1, warnings: [],
    }, {
      // Push's errors are the only messages about profile ops on Spanner. The
      // one warning is the model file's own.
      profiles: {ops: {entities: {Customer: keyAt(SPANNER_CUSTOMER, 'c_key', 'SNOWFLAKE')}}},
      metrics: [SNOWFLAKE_METRIC],
      flags: {deployment: undefined, validateOnly: true},
      code: 1,
      errors: [
        has("profile 'ops': field 'Customer.key' has no expression for SPANNER"),
        has("profile 'ops': metric 'positive_keys' has no expression for SPANNER"),
      ],
      warnings: [has('needs transpilation')],
    }],
    check: r => expect(r.published.metrics![0].dialects).toEqual([
      {dialect: 'SNOWFLAKE', expression: 'SUM(IFF(Customer.key > 0, 1, 0))'},
    ]),
  },
  {
    // Knowledge Catalog receives every profile file, applied or not. The
    // model file and profile dev give the same ANSI_SQL note, which prints
    // once.
    name: 'prints the warnings of each profile file once, labelled with its name, whether or not a selected deployment applies it, and none for a profile push rejects',
    deployments: [{name: 'g', profile: 'prod'}, {name: 'h', profile: 'dev'}],
    entities: [keyAt(bqTable('customer'), 'c_key')],
    profiles: {dev: keyIn('dev', 'c_key'), prod: keyIn('prod', '"c_key"')},
    flags: {validateOnly: true},
    code: 0,
    warnings: [NOTE, quotedKey("profile 'prod': ")],
    then: [{flags: {deployment: 'h', validateOnly: true}, code: 0,
            warnings: [NOTE, quotedKey("profile 'prod': ")]},
           {flags: {deployment: 'g', validateOnly: true}, code: 0,
            warnings: [NOTE, quotedKey("profile 'prod': ")]},
           // A GOOGLE block profile's field gets the same warning.
           {google: {profiles: [{name: 'prod', entities: [keyIn('prod', '"c_key"').entities.Customer]}]},
            profiles: {}, flags: {validateOnly: true}, code: 0,
            warnings: [NOTE, quotedKey("profile 'prod': ")]},
           // Push's error for the Snowflake-only key is prod's only message.
           {profiles: {dev: keyIn('dev', 'c_key'), prod: keyIn('prod', 'c_key', 'SNOWFLAKE')},
            flags: {validateOnly: true}, code: 1, warnings: [NOTE],
            rejects: [has("field 'Customer.key' has no expression for BIGQUERY or ANSI_SQL")]}],
    report: {code: 0},
  },
  {
    // Push publishes a profile without its actions, so it prints the
    // warnings of one whose actions do not apply: an action the model file
    // does not declare, an action setting a key a profile may not set, and a
    // model file action with a sql executor.
    name: 'prints the warnings of a profile file whose actions do not apply, and so does the report, beside its not-shown line',
    entities: [keyAt(bqTable('customer'), 'c_key')],
    profiles: {prod: {...keyIn('prod', '"c_key"'), actions: [{name: 'refund', executor: null}]}},
    flags: {validateOnly: true},
    code: 0,
    warnings: [NOTE, quotedKey("profile 'prod': ")],
    then: [{
      profiles: {prod: {...keyIn('prod', '"c_key"'), actions: [{name: 'refund', description: 'd'}]}},
      flags: {validateOnly: true}, code: 0, warnings: [NOTE, quotedKey("profile 'prod': ")],
    }, {
      actions: [{
        name: 'refund', parameters: [{name: 'k', type: 'Integer'}],
        executor: {sql: {statements: ['UPDATE customer SET c_key = c_key WHERE c_key = @k']}},
      }],
      flags: {validateOnly: true}, code: 0,
      warnings: [NOTE, quotedKey("profile 'prod': "), has('1 action(s) published')],
    }],
    report: {code: 0, check: (lines, _, warnings) => {
      expect(lines).toContain("    not shown: [commerce.profile.prod.yaml] profile 'prod': " +
          "action 'refund' is not in the logical model");
      expect(warnings).toContain(
          quotedKey('').replace('Warning: ', "  profile 'prod': warning: "));
    }},
  },
  {
    // The model file binds no table, so only the profiles warn about metric
    // m, deployment d's dev among them.
    name: 'a warning that an applied and an unapplied profile both give prints once for each, under its name',
    deployments: [{name: 'd', profile: 'dev'}],
    entities: [{...CUSTOMER, source: undefined}],
    metrics: [{name: 'm', entity: 'Customer',
               expression: {dialects: [{dialect: 'ANSI_SQL', expression: 'COUNT("key")'}]}}],
    profiles: {dev: boundTo('dev'), prod: PROD},
    flags: {deployment: undefined, validateOnly: true},
    code: 0,
    warnings: [has("unbound 'default' profile"), ...['prod', 'dev'].map(p => has(
        `Warning: profile '${p}': [commerce] metric 'm': BigQuery reads "key"`))],
  },
  {
    name: '--validate-only --print prints the catalog plan first',
    flags: {validateOnly: true, print: true},
    services: planned(),
    code: 0, log: [...PLAN, msg.VALIDATED], errors: [], called: {apply: 0},
  },
  {
    name: 'a failed catalog preflight under --print still prints the plan and its warnings',
    flags: {print: true},
    services: planned(
        {success: false, details: 'permission denied', warnings: ['w']}),
    code: 1, log: PLAN, called: {apply: 0},
    errors: [
      'Error pushing semantic model to Knowledge Catalog: permission denied',
    ],
    warnings: ['Warning: w'],
  },
], {flags: {deployment: false}});

// The error the runtime gives when it opens scope `s`.
async function runtimeError(s: Scope): Promise<string|undefined> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-runtime-'));
  spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('a test made a network call'));
  try {
    writeScope(dir, s);
    const opened = await createSemanticRuntimes(
        {path: dir, ctx: CTX, onWarning: () => {}});
    return 'error' in opened ? opened.error : undefined;
  } finally {
    mock.restore();
    fs.rmSync(dir, {recursive: true, force: true});
  }
}
// A refusal whose error is also the runtime's when it opens the scope.
const sameAsRuntime = (c: Case): Case => ({
  ...c,
  check: async r =>
      expect(r.errors).toEqual([`Error: ${await runtimeError(c)}`]),
});

// Action purge, with the sql executor `executor` when it is set.
const purge = (executor?: object) => ({
  name: 'purge', parameters: [{name: 'k', type: 'Integer'}], executor,
});
const ONE_STATEMENT = {sql: {statements: ['STATEMENT']}};
// `text` with its one statement replaced by `lines`, written as is.
const withStatementLines = (text: string, ...lines: string[]) => {
  const [line, indent] = /^( *)- STATEMENT$/m.exec(text)!;
  return text.replace(line, lines.map(l => indent + l).join('\n'));
};
// The model file of `scope` with action purge, whose one statement is written
// as `lines`.
const modelWriting = (lines: string[], scope: Scope = {}) => withStatementLines(
    modelFile({...scope, actions: [purge(ONE_STATEMENT)]}), ...lines);
const COMMENTED = "UPDATE customer SET doc = doc #- '{draft}' WHERE c_key = @k";

scenarios('push --no-deployment refuses a scope before any network call', [
  {
    name: '--no-deployment refuses a target a vanilla GOOGLE block lists twice',
    google: {deployments: [{name: 'a', target: bqGraph('g')}, {name: 'b', target: bqGraph('g')}]},
    errors: [has(`deployments 'a' and 'b' target the same resource '${bqGraph('g')}'`)],
  },
  {
    name: '--no-deployment refuses a deployment whose target is in no accepted form',
    deployments: [{name: 'g', target: 'bigquery:graph:test-project.d.g'}],
    errors: [has(
        "deployment 'g' targets 'bigquery:graph:test-project.d.g', which is " +
        'a Knowledge Catalog name')],
  },
  sameAsRuntime({
    name: 'the undeclared-profile message lists GOOGLE block profiles in sorted order',
    google: {
      profiles: ['zeta', 'alpha'].map(name => ({
        name,
        entities: [{name: 'Customer', source: bqTable('customer', name)}],
      })),
      deployments: [{name: 'dev', target: bqGraph('g'), profile: 'prdo'}],
    },
    errors: [err(msg.unknownProfile('dev', 'prdo', ['alpha', 'zeta']))],
  }),
  sameAsRuntime({
    name: 'the declared-profile check runs before the named profiles are checked, and every broken profile file is reported',
    deployments: [{name: 'g', profile: 'prd'}],
    profiles: {
      dev: {version: '0.2.0.dev0/google'},
      prod: {entities: {Customer: EXPRESSION_KEY}},
    },
    errors: [err(msg.unknownProfile('g', 'prd', ['dev', 'prod']))],
    then: [{
      deployments: [{name: 'g', profile: 'prod'}],
      errors: [
        err("[commerce.profile.dev.yaml] profile 'dev' sets 'version'; a " +
            'profile file takes its version from the model file beside it, ' +
            'so remove the line'),
        err("[commerce.profile.prod.yaml] profile 'prod': entity " +
            "'Customer' key column 'UPPER(c_key)' is not a physical " +
            'column name'),
      ],
    }],
  }),
  {
    name: '--no-deployment refuses a model file that does not load',
    entities: [{...CUSTOMER, colour: 'red'}],
    errors: [has('Semantic model load error')],
  },
  {
    name: 'refuses an unquoted action statement with a comment on the same line',
    files: {'commerce.yaml': modelWriting([`- ${COMMENTED}`])},
    errors: [err(
        "action 'purge' in model 'commerce' (commerce) has a sql executor " +
        'whose statement 1 has a comment on the same line, so YAML reads the ' +
        "statement as 'UPDATE customer SET doc = doc'. If the text after ' #' " +
        "is part of the statement, write it as a block scalar with '|'. If it " +
        "is a YAML comment, move it to the '-' column or above the statement.")],
    then: [{
      files: {'commerce.yaml': modelWriting([
        '- UPDATE customer SET doc = doc WHERE c_key = @k',
        '# a comment on its own line',
        `- "${COMMENTED}" # a note`,
        '- |', `  ${COMMENTED}`,
      ])},
      code: 0,
    }, {
      actions: [purge()],
      files: {'commerce.profile.p.yaml': withStatementLines(
          profileFile('p', {...boundTo('p'), actions: [{name: 'purge', executor: ONE_STATEMENT}]}),
          `- ${COMMENTED}`)},
      errors: [has("(commerce.profile.p.yaml) has a sql executor whose statement 1")],
    }, {
      files: {'commerce.yaml': modelWriting([`- &cut ${COMMENTED}`, '- *cut'])},
      errors: [has('whose statement 1 has a comment'), has('whose statement 2 has a comment')],
    }],
    report: {code: 1, rejects: {'': [pushed()], 'no profiles': []}},
  },
  {
    name: 'refuses an unquoted action statement followed by a comment line indented under it',
    files: {'commerce.yaml': modelWriting(
        ['- UPDATE customer SET doc = doc', "  #- '{draft}' WHERE c_key = @k"])},
    errors: [err(
        "action 'purge' in model 'commerce' (commerce) has a sql executor " +
        'whose statement 1 is followed by a comment line indented under it, ' +
        "so YAML reads the statement as 'UPDATE customer SET doc = doc'. If " +
        'the comment line is part of the statement, write it as a block ' +
        "scalar with '|'. If it is a YAML comment, move it to the '-' column " +
        'or above the statement.')],
    then: [{
      files: {'commerce.yaml': modelWriting(
          ['- |', '  UPDATE customer SET doc = doc', "  #- '{draft}' WHERE c_key = @k"])},
      code: 0,
    }, {
      files: {'commerce.yaml': modelWriting(
          ['- UPDATE customer SET doc = doc', "#- '{draft}' WHERE c_key = @k"])},
      code: 0,
    }, {
      files: {'commerce.yaml': modelWriting([
        '- &cut UPDATE customer SET doc = doc', '',
        "  #- '{draft}' WHERE c_key = @k", '- *cut',
      ])},
      errors: [has('statement 1 is followed by a comment line'),
               has('statement 2 is followed by a comment line')],
    }],
  },
  {
    name: 'refuses an unquoted action statement in a flow list followed by a comment line',
    files: {'commerce.yaml': modelWriting(
        ['[UPDATE customer SET doc = doc', "  #- '{draft}' WHERE c_key = @k", ']'])},
    errors: [err(
        "action 'purge' in model 'commerce' (commerce) has a sql executor " +
        "whose statement 1 is followed by a comment line before the next ',' " +
        "or ']', so YAML reads the statement as 'UPDATE customer SET doc = " +
        "doc'. If the comment line is part of the statement, write the " +
        "statements as a block list, with this one as a block scalar with " +
        "'|'. If it is a YAML comment, move it after the ',' or ']' that " +
        'follows the statement.')],
    then: [{
      files: {'commerce.yaml': modelWriting(
          ['- |', '  UPDATE customer SET doc = doc', "  #- '{draft}' WHERE c_key = @k"])},
      code: 0,
    }, {
      files: {'commerce.yaml': modelWriting([
        '[UPDATE customer SET doc = doc WHERE c_key = @k, # a note',
        '  DELETE FROM customer WHERE c_key = @k',
        ']  # a note',
      ])},
      code: 0,
    }],
  },
  {
    // With no deployment, only `--` is a SQL comment. On BigQuery `#` is one
    // too, and on AlloyDB it is an operator.
    name: 'refuses a SQL comment on a line YAML joins to the next one, as the statement\'s database reads it',
    files: {'commerce.yaml': modelWriting(
        ['- UPDATE customer SET doc = doc -- every row?', '  WHERE c_key = @k'])},
    errors: [err(
        "action 'purge' in model 'commerce' (commerce) has a sql executor " +
        'whose statement 1 has a SQL comment on a line YAML joins to the ' +
        'next one, so the comment also covers the lines after it. Write it ' +
        "as a block scalar with '|', which keeps its line breaks.")],
    then: [{
      files: {'commerce.yaml': modelWriting([
        '- |', '  UPDATE customer SET doc = doc -- every row?', '  WHERE c_key = @k',
        // A line break written as '\' joins the name back together.
        '- "UPDATE cust\\', '  omer SET doc = doc WHERE c_key = @k"',
      ])},
      code: 0,
    }, {
      files: {'commerce.yaml': modelWriting([
        '- "UPDATE customer SET doc = doc -- every row?', '  WHERE c_key = @k"',
        "- 'UPDATE customer SET doc = doc -- every row?", "  WHERE c_key = @k'",
        '- "UPDATE customer SET doc = doc -- every row? \\', '  WHERE c_key = @k"',
        // The comment covers the opening quote or '/*' of text on a later line.
        '- >', '  UPDATE customer SET doc = doc -- every row?', "  WHERE doc = 'a", '', "  b' AND c_key = @k",
        '- >', '  UPDATE customer SET doc = doc -- every row?', '  /* a', '', '  b */ WHERE c_key = @k',
      ])},
      errors: [1, 2, 3, 4, 5].map(n => has(`statement ${n} has a SQL comment`)),
    }, {
      files: {'commerce.yaml': modelWriting([
        '- >', '  UPDATE customer SET doc = doc # every row?', '  WHERE c_key = @k',
        '- UPDATE customer SET doc = doc#every row?', '  WHERE c_key = @k',
      ], {deployments: ['g']})},
      errors: [has('statement 1 has a SQL comment'), has('statement 2 has a SQL comment')],
    }, {
      // Profile p deploys to AlloyDB alone.
      deployments: ['g', {name: 'pg', target: ALLOYDB, profile: 'p'}],
      actions: [purge()],
      files: {'commerce.profile.p.yaml': withStatementLines(
          profileFile('p', {
            ...boundAt(`${ALLOYDB}/schemas/public/tables/customer`),
            actions: [{name: 'purge', executor: ONE_STATEMENT}],
          }),
          '- >', "  UPDATE customer SET doc = doc #- '{draft}'", '  WHERE c_key = @k')},
      code: 0,
    }],
  },
], {flags: {deployment: false}, code: 1, noNetwork: true});
