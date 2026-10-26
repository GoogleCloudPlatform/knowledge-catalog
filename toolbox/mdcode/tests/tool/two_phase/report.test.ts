// Tests of what `kcmd profiles` prints for a scope whose plain push runs in
// two phases (src/tool/commands.ts, profiles). Each case runs
// `kcmd push --validate-only` and then the report.

import {expect} from 'bun:test';

import {bqGraph, bqTable, Case, has, modelFile, pushed, ReportStep, Scope, scenarios, SPANNER, spannerGraph} from './harness';

const graph = (name: string, profile?: string) =>
    ({name, target: bqGraph(`commerce_${name}`, 'prod'), profile});
const entities = (at = (e: string) => bqTable(e, 'dev')) =>
    ['customer', 'purchase'].map(e => ({
      name: e,
      source: at(e),
      primary_key: [`${e[0]}_id`],
      fields: [{name: `${e[0]}_id`, expression: `${e[0]}_id`}],
    }));
const COLUMNS = {from_columns: ['p_customer'], to_columns: ['c_id']};
const MODEL: Scope = {
  entities: entities(),
  relationships:
      [{name: 'placed_by', from: 'purchase', to: 'customer', ...COLUMNS}],
};
// customer and purchase bound to their tables in `dataset`, by name.
const boundIn = (dataset: string) => Object.fromEntries(
    entities(e => bqTable(e, dataset)).map(e => [e.name, e]));
const PROD = {
  entities: boundIn('prod'),
  relationships: [{name: 'placed_by', ...COLUMNS}],
};
const UNKNOWN_ACTION =
    [{name: 'nothing', executor: {sql: {statements: ['SELECT 1']}}}];
const legacy = (entity = 'customer', more = '') =>
    `semantic_model:\n  - name: commerce\n    entities:\n      - name: ` +
    `${entity}\n${more}        source: ${bqTable(entity, 'prod')}\n`;

const SHARED = {...MODEL, deployments: [graph('prod')], code: 1,
                flags: {validateOnly: true}};

scenarios('kcmd profiles reports what push rejects', [
  {
    // Deployment qa deploys the model file's Spanner tables, which fails
    // since the model declares a metric, but push stops at prod first.
    name: "prints a deployment's error under the profile it names, only for the first deployment that fails",
    deployments: [
      graph('prod', 'prod'), {name: 'qa', target: spannerGraph('commerce')},
    ],
    entities: entities(e => `${SPANNER}/tables/${e}`),
    metrics: [{name: 'customers', expression: 'COUNT(customer.c_id)'}],
    profiles: {prod: {...PROD, actions: UNKNOWN_ACTION}},
    rejects: [has("action 'nothing' is not in the logical model")],
    report: {flags: {profile: 'prod'}, code: 1, rejects: {prod: [pushed()]}},
  },
  ...([
    ['a profile file overrides an action the model lacks',
     {profiles: {prod: {...PROD, actions: UNKNOWN_ACTION}}},
     ["[commerce.profile.prod.yaml] profile 'prod': action 'nothing' is not " +
      'in the logical model']],
    ['the model lists no deployments and a profile file overrides an action',
     {deployments: [], profiles: {prod: {...PROD, actions: UNKNOWN_ACTION}}},
     ["[commerce.profile.prod.yaml] profile 'prod': action 'nothing' is not " +
      'in the logical model']],
    ['a legacy wrapper gives a model that does not load',
     {legacy: {prod: legacy('customer', '        primary_key: 5\n')}},
     ["Model document 'commerce': Semantic model load error: [", '  {']],
  ] as Array<[string, Scope, string[]]>).map(([label, scope, reason]): Case => ({
    name: `says why it shows nothing for a profile push stores when ${label}`,
    ...scope,
    code: 0,
    rejects: [],
    report: {
      code: 0,
      check: (lines, errors) => {
        expect(errors).toEqual([]);
        const [, header, ...shown] = lines;
        expect([header, ...shown.slice(0, reason.length)]).toEqual([
          "  profile 'prod'", `    not shown: ${reason[0]}`,
          ...reason.slice(1).map(line => `      ${line}`),
        ]);
        for (const line of shown.slice(1)) expect(line).toStartWith('      ');
      },
    },
  })),
  {
    // An error in qa's entry skips prod's checks.
    name: 'prints no not-shown line when push stops before the deployment that uses the profile',
    deployments:
        [graph('prod', 'prod'), {name: 'qa', target: 'bigquery:acme.qa'}],
    profiles: {prod: {...PROD, actions: UNKNOWN_ACTION}},
    rejects: [has("deployment 'qa' targets 'bigquery:acme.qa'")],
    then: [{
      deployments: [graph('prod', 'prod'), graph('qa')],
      code: 1,
      rejects: [has("action 'nothing' is not in the logical model")],
    }],
    report: {
      code: 1,
      rejects: {model: [pushed(0)], prod: []},
      check: lines => expect(lines.slice(lines.indexOf("  profile 'prod'")))
                          .toEqual(["  profile 'prod'"]),
    },
  },
  {
    // The legacy wrapper merged into the model file gives no second error.
    name: 'prints a model file that does not load once, above the models',
    files: {
      'commerce.yaml': modelFile({...MODEL, deployments: [graph('prod')]})
          .replace('    entities:\n', '    bogus_key: 1\n    entities:\n'),
    },
    legacy: {staging: legacy()},
    rejects: [has('bogus_key')],
    report: {
      code: 1,
      rejects: {'': [pushed()], staging: []},
      check: lines => {
        expect(lines.filter(l => l.includes('load error'))).toHaveLength(1);
        const model = "Model 'commerce' (commerce_eg):";
        expect(lines.slice(lines.indexOf(model)))
            .toEqual([model, "  profile 'staging'"]);
      },
    },
  },
  {
    name: "prints none of push's warnings",
    profiles: {prod: PROD},
    defaultProfile: 'prod',
    code: 0,
    check: r => expect(r.warnings).toContainEqual(
        has("catalog.yaml sets default_profile 'prod'")),
    report: {code: 0, rejects: {'prod (default)': []}},
  },
  ...([
    ['a default_profile the model does not declare', {defaultProfile: 'nope'},
     "unknown binding profile 'nope'", {model: [pushed()], 'no profiles': []}],
    ['a profile file named default', {legacy: {Default: legacy()}},
     "may not be named 'default'", {model: [pushed()]}],
    ['a deployment profile the model does not declare',
     {deployments: [graph('prod', 'nope')]}, "names unknown binding profile",
     {model: [pushed()], 'no profiles': []}],
    ['a join that covers no key', {
      relationships: [{name: 'placed_by', from: 'purchase', to: 'customer',
                       from_columns: ['p_c'], to_columns: ['c_x']}],
    }, 'placed_by', {model: [pushed()], 'no profiles': []}],
    ['a default_profile that does not apply',
     {defaultProfile: 'prod', legacy: {prod: legacy('ghost')}},
     "profile 'prod': entity 'ghost' is not in the logical model",
     {'prod (default)': [pushed()]}],
    ['a file too large to store',
     {files: {'commerce.profile.big.yaml': `#${'x'.repeat(125e3)}\nname: big`}},
     'too large to store', {'': [pushed()], big: []}],
    ['a malformed overview sidecar', {v2Aspects: true, files: {
       'commerce.overview.md': '---\ncontentType: markdown\n---\nOrders.\n',
     }}, "not 'markdown'", {'': [pushed()], 'no profiles': []}],
    ['a model file that does not load beside a misnamed profile file', {files: {
       'commerce.yaml': modelFile(MODEL)
           .replace('    entities:\n', '    bogus_key: 1\n    entities:\n'),
       'commerce.profile.prod.yaml': 'name: staging\n',
     }}, 'bogus_key', {'': [pushed()]}],
    ['a vanilla model file that does not load beside a GOOGLE block that ' +
         'does not load', {files: {
       'commerce.yaml': modelFile({google: {deployments: [graph('prod')]}})
           .replace('    datasets:\n', "      - vendor_name: GOOGLE\n" +
                    "        data: '[]'\n    datasets:\n")
           .replace('        primary_key:', '        bogus_key: 1\n        primary_key:'),
     }}, 'bogus_key', {'': [pushed()]}],
    ['a repeated metrics_exclude name the model lacks',
     {profiles: {prod: {...PROD, metrics_exclude: ['nope', 'nope']}}},
     "metric 'nope' in 'metrics_exclude'", {prod: [pushed()]}],
    ['a metric a Spanner deployment\'s profile leaves available', {
      deployments: [{name: 'sp', target: spannerGraph('g'), profile: 'prod'},
                    graph('qa')],
      metrics: [{name: 'n', expression: 'COUNT(customer.c_id)'}],
      profiles: {prod: PROD},
    }, "leaves metric(s) 'n' available", {prod: [pushed()]}],
  ] as Array<[string, Scope, string, ReportStep['rejects']]>).map(
      ([label, scope, part, rejects]): Case => ({
        name: `prints ${label} once`,
        ...scope,
        rejects: [has(part)],
        report: {code: 1, rejects},
      })),
  {
    name: 'prints only push\'s error for two models when one lists deployments',
    deployments: [graph('prod', 'prod')],
    profiles: {prod: PROD},
    files: {
      'shop.yaml': modelFile(MODEL).replace('name: commerce', 'name: shop'),
    },
    rejects: [has('would receive 2 models')],
    report: {code: 1,
             rejects: {'': [pushed()], prod: [], 'shop: no profiles': []}},
  },
  {
    name: 'fails under --profile when another profile leaves an entity without a source',
    deployments: [graph('prod', 'prod')],
    profiles: {
      prod: PROD,
      staging: {entities: {customer: boundIn('staging').customer}},
    },
    rejects: [has("profile 'staging': entity"),
              has("profile 'staging': relationship")],
    report: {flags: {profile: 'prod'}, code: 1,
             rejects: {model: [pushed()], prod: []}},
  },
  {
    name: 'prints a profile file that does not load once, under the profile',
    deployments: [graph('prod', 'prod'), graph('qa')],
    profiles: {prod: {entities: {customer: {bogus: 1}}}},
    rejects: [has('[commerce.profile.prod.yaml]')],
    report: {
      code: 1,
      rejects: {prod: [pushed()]},
      check: (_, errors) => {
        expect(errors.filter(l => l.includes('bogus'))).toHaveLength(1);
        expect(errors.filter(l => l.includes('prod'))).toHaveLength(1);
      },
    },
  },
], SHARED);
