// The two-phase push tests' harness: scopes, service fakes and checks.

import {describe, expect, Mock, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as YAML from 'yaml';

import {BigQueryClient} from '../../../src/libts/gcp/bigquery';
import {ApiContext} from '../../../src/libts/gcp/context';
import {CatalogClient} from '../../../src/libts/gcp/dataplex';
import * as bqLeg from '../../../src/libts/semantic/deploy_bigquery';
import * as kc from '../../../src/libts/semantic/deploy_knowledge_catalog';
import * as spannerLeg from '../../../src/libts/semantic/deploy_spanner';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {LoadedModel} from '../../../src/libts/semantic/loader';
import * as validateMod from '../../../src/libts/semantic/validate';
import * as commands from '../../../src/tool/commands';

export const CTX = new ApiContext('test-project', 'us', 'test-token');
const BQ = 'bigquery.googleapis.com/projects/test-project/datasets';
export const bqGraph = (name: string, dataset = 'd') =>
    `${BQ}/${dataset}/propertyGraphs/${name}`;
export const bqTable = (name: string, dataset = 'd') =>
    `${BQ}/${dataset}/tables/${name}`;

// Entity Customer of the default scope, bound to table customer in dataset d.
export const CUSTOMER = {
  name: 'Customer',
  source: bqTable('customer'),
  primary_key: ['key'],
  fields: [{name: 'key', expression: 'c_key'}],
};
// A metric with only Snowflake SQL, and the warning --transpile gives for it.
export const SNOWFLAKE_METRIC = {
  name: 'positive_keys',
  expression: {
    dialects: [{
      dialect: 'SNOWFLAKE',
      expression: 'SUM(IFF(Customer.key > 0, 1, 0))',
    }],
  },
};
export const TRANSPILE_WARNING =
    "Warning: [commerce] metric 'positive_keys': transpiled 'SNOWFLAKE' -> " +
    "'BIGQUERY'";
export const boundTo = (dataset: string) => ({
  entities: {Customer: {...CUSTOMER, source: bqTable('customer', dataset)}},
});
// Customer bound to table customer in dataset prod, keyed by an expression.
export const EXPRESSION_KEY = {
  ...CUSTOMER, source: bqTable('customer', 'prod'), primary_key: ['UPPER(c_key)'],
};

// A deployment, by default a BigQuery graph of its name in dataset d.
export type Deployment =
    string|{name: string; target?: string; profile?: string};
// A profile file's keys. `entities` maps each entity to a source or binding.
type Profile =
    {entities?: Record<string, string|object>; [key: string]: unknown};

// What a case changes in the default scope: entry group commerce_eg with a
// Google-flavor commerce.yaml for model commerce, whose one entity is CUSTOMER.
export interface Scope {
  deployments?: Deployment[];
  entities?: object[];
  relationships?: object[];
  metrics?: object[];
  // A vanilla model file's GOOGLE block data. The keys above are then ignored.
  google?: object;
  // Profile files commerce.profile.<name>.yaml, by name.
  profiles?: Record<string, Profile>;
  // Legacy profile files commerce.profiles/<name>.yaml, by name.
  legacy?: Record<string, string>;
  defaultProfile?: string;
  // Other files of the entry group by path, such as a second model file.
  files?: Record<string, string>;
}

export function modelFile(s: Scope = {}): string {
  const ansi = {dialects: [{dialect: 'ANSI_SQL', expression: 'c_key'}]};
  const model = s.google ? {
    custom_extensions:
        [{vendor_name: 'GOOGLE', data: JSON.stringify(s.google)}],
    datasets: [{...CUSTOMER, fields: [{name: 'key', expression: ansi}]}],
  } : {
    deployments: s.deployments?.length ?
        s.deployments.map(d => typeof d === 'string' ?
                              {name: d, target: bqGraph(d)} :
                              {target: bqGraph(d.name), ...d}) :
        undefined,
    entities: s.entities ?? [CUSTOMER],
    relationships: s.relationships,
    metrics: s.metrics,
  };
  return YAML.stringify({
    version: s.google ? '0.2.0.dev0' : '0.2.0.dev0/google',
    semantic_model: [{name: 'commerce', ...model}],
  });
}

export function profileFile(name: string, p: Profile): string {
  const {entities, ...rest} = p;
  const bound = entities && Object.entries(entities).map(
      ([n, b]) => typeof b === 'string' ? {name: n, source: b} :
                                          {name: n, ...b});
  return YAML.stringify({name, ...(bound ? {entities: bound} : {}), ...rest});
}

// Writes catalog.yaml and the entry group's files, replacing earlier ones.
export function writeScope(dir: string, s: Scope): void {
  fs.writeFileSync(
      path.join(dir, 'catalog.yaml'),
      'scope: semantic-model.test-project.us.commerce_eg\n' +
          (s.defaultProfile ? `default_profile: ${s.defaultProfile}\n` : ''));
  const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
  fs.rmSync(eg, {recursive: true, force: true});
  fs.mkdirSync(eg, {recursive: true});
  const files = {
    'commerce.yaml': modelFile(s),
    ...Object.fromEntries(Object.entries(s.profiles ?? {}).map(
        ([n, p]) => [`commerce.profile.${n}.yaml`, profileFile(n, p)])),
    ...Object.fromEntries(Object.entries(s.legacy ?? {}).map(
        ([n, text]) => [`commerce.profiles/${n}.yaml`, text])),
    ...s.files,
  };
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(eg, name)), {recursive: true});
    fs.writeFileSync(path.join(eg, name), text);
  }
}

export const kcResult = (more: Partial<kc.KcDeployResult> = {}) => ({
  success: true, warnings: [], created: 0, updated: 0, deleted: 0, linked: 0,
  unlinked: 0, plan: [], ...more,
});

// The deployment names each model in `models` lists, as `a,b;c`.
export const deploymentNames = (models: LoadedModel[]) =>
    models.map(m => (m.model.deployments ?? []).map(d => d.name).join(','))
        .join(';');

type Call = any[];
type Fallback = (a: Call, real: () => unknown) => unknown;
const ok = (result: object) => () => ({status: 200, result});
const none = () => [];
const DEPLOYED = {success: true, ddl: [], warnings: [], deployed: 1};
export const PREPARED = {emitted: [], existing: [], warnings: [], plan: []};
// The method the fake replaces for each service, and its default answer.
const SERVICES = {
  preflight: [kc, 'preflightKnowledgeCatalog',
              (a, real) => a[2]?.validateOnly ? real() : {prepared: PREPARED}],
  apply: [kc, 'applyKnowledgeCatalog', () => kcResult()],
  deployKc: [kc, 'deployKnowledgeCatalog', () => kcResult()],
  bq: [bqLeg, 'deployBigQuery',
       (a, real) => a[2]?.validateOnly ? real() : DEPLOYED],
  spanner: [spannerLeg, 'deploySpanner',
            (a, real) => a[2]?.validateOnly ? real() : DEPLOYED],
  sources: [validateMod, 'validateBigQueryDataSources', none],
  bqDml: [validateMod, 'validateBigQueryActionStatements', none],
  spannerDml: [validateMod, 'validateSpannerActionStatements', none],
  query: [BigQueryClient.prototype, 'query', ok({jobComplete: true})],
  getEntryType: [CatalogClient.prototype, 'getEntryType', ok({})],
  getAspectType: [CatalogClient.prototype, 'getAspectType', ok({})],
  fetch: [globalThis, 'fetch', () => {
    throw new Error('a test made a network call');
  }],
} satisfies Record<string, [object, string, Fallback]>;
type Service = keyof typeof SERVICES;
// Read before any spy replaces them.
const REAL = Object.fromEntries(Object.entries(SERVICES).map(
    ([name, [owner, method]]) => [name, (owner as any)[method] as Function]));

// A call's log entry, such as `apply`, `sources g1` or `deploy g1`.
const entry = (service: Service, a: Call) =>
    /^(bq|spanner)$/.test(service) ?
    `${a[2]?.validateOnly ? 'generate' : 'deploy'} ${deploymentNames(a[0])}` :
    /^(sources|bqDml|spannerDml)$/.test(service) ?
    `${service} ${deploymentNames(a[0])}` : service;

// A case's answers by service: a value, or a function of the call's arguments.
export type Services = Partial<Record<Service, unknown>>;
// Each service's spy, and the call log, an entry per call in order.
type Fake = Record<Service, Mock<(...a: Call) => any>>&{calls: string[]};

function installFake(services: Services): Fake {
  const fake = {calls: [] as string[]} as Fake;
  for (const name of Object.keys(SERVICES) as Service[]) {
    const [owner, method, fallback]: [object, string, Fallback] =
        SERVICES[name];
    const given: unknown = services[name];
    const answer = (self: unknown, a: Call) =>
        (typeof given === 'function' ? given(...a) : given) ??
        fallback(a, () => REAL[name].apply(self, a));
    fake[name] = spyOn(owner as any, method as any)
                     .mockImplementation(async function(this: any, ...a: Call) {
                       fake.calls.push(entry(name, a));
                       return answer(this, a);
                     });
  }
  return fake;
}

export type PushRun = Awaited<ReturnType<typeof runPush>>;

// A push of a scope, and the outcomes it checks. A `then` push checks only the
// outcomes it sets.
interface PushStep extends Scope {
  flags?: commands.PushOptions;
  services?: Services;
  code?: number;
  // Every line push prints with console.error, exactly.
  errors?: unknown[];
  warnings?: unknown[];
  log?: unknown[];
  // The catalog preflight, the catalog write and each graph deploy, in order.
  events?: string[];
  called?: Partial<Record<Service, number>>;
  nothingWritten?: boolean;
  noNetwork?: boolean;
  check?: (r: PushRun) => unknown;
}

// A push with `flags` refused with `error` alone, before any network call.
export const refused = (flags: commands.PushOptions, error: unknown) =>
    ({flags, code: 1, errors: [error], noNetwork: true});

// A push, then each push in `then` with what it changes.
export interface Case extends PushStep {
  name: string;
  then?: PushStep[];
}

export const has = (text: string) => expect.stringContaining(text);
export const err = (message: string) => `Error: ${message}`;

type Line = {stream: 'log'|'error'|'warn'; text: string};
const texts = (out: Line[], ...streams: Line['stream'][]) =>
    out.filter(l => streams.includes(l.stream)).map(l => l.text);

// Replaces every spy, and returns the lines the command prints and the fake.
function installRun(services: Services): {out: Line[]; fake: Fake} {
  mock.restore();
  const out: Line[] = [];
  for (const stream of ['log', 'error', 'warn'] as const) {
    spyOn(console, stream).mockImplementation((...a: unknown[]) => {
      out.push({stream, text: a.map(String).join(' ')});
    });
  }
  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  return {out, fake: installFake(services)};
}

// What one push printed and called.
async function runPush(services: Services, flags: commands.PushOptions) {
  const {out, fake} = installRun(services);
  const code = await commands.push(flags);
  return {
    code,
    log: texts(out, 'log'),
    errors: texts(out, 'error'),
    warnings: texts(out, 'warn'),
    fake,
    published: fake.preflight.mock.calls.at(-1)?.[0][0].model as SemanticModel,
  };
}

const kindOf = (call: string) => call.split(' ')[0];
// The kinds of call the `events` outcome lists.
const EVENTS = new Set(['preflight', 'apply', 'deployKc', 'deploy']);

async function checkPush(r: PushRun, step: PushStep) {
  const same = (actual: unknown, expected?: unknown[]) => {
    if (expected) expect(actual).toEqual(expected);
  };
  if (step.code !== undefined) expect(r.code).toBe(step.code);
  same(r.errors, step.errors);
  same(r.warnings, step.warnings);
  same(r.log, step.log);
  same(r.fake.calls.filter(c => EVENTS.has(kindOf(c))), step.events);
  for (const [service, times] of Object.entries(step.called ?? {})) {
    expect(r.fake[service as Service]).toHaveBeenCalledTimes(times);
  }
  // No catalog write, no deploy, and no BigQuery query but a dry run.
  if (step.nothingWritten) {
    expect(r.fake.apply).not.toHaveBeenCalled();
    expect(r.fake.deployKc).not.toHaveBeenCalled();
    expect(r.fake.calls.filter(c => c.startsWith('deploy '))).toEqual([]);
    expect(r.fake.query.mock.calls.filter(c => c[3] !== true)).toEqual([]);
  }
  if (step.noNetwork) expect(r.fake.calls).toEqual([]);
  await step.check?.(r);
}

async function runCase(c: Case): Promise<void> {
  const cwd = process.cwd();
  const saved = process.env.KC_V2_ASPECTS;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-two-phase-'));
  process.chdir(dir);
  delete process.env.KC_V2_ASPECTS;
  try {
    for (const step of [c, ...c.then ?? []]) {
      const own = step === c ? {} : step;
      writeScope(dir, {...c, ...own});
      const services = {...c.services, ...own.services};
      await checkPush(await runPush(services, step.flags ?? {}), step);
    }
  } finally {
    mock.restore();
    process.chdir(cwd);
    if (saved === undefined) delete process.env.KC_V2_ASPECTS;
    else process.env.KC_V2_ASPECTS = saved;
    fs.rmSync(dir, {recursive: true, force: true});
  }
}

// A case overrides `shared` key by key, and `services` and `flags` entry by
// entry. A push in `then` adds its flags to `shared`'s.
export function scenarios(
    title: string, cases: Case[], shared: Omit<Case, 'name'> = {}): void {
  const merged = <T extends PushStep>(c: T) =>
      ({...c, flags: {...shared.flags, ...c.flags}});
  describe(title, () => {
    for (const c of cases) {
      test(c.name, () => runCase({
        ...shared,
        ...merged(c),
        services: {...shared.services, ...c.services},
        then: c.then?.map(merged),
      }));
    }
  });
}

// The two-phase push's messages, without the `Error: ` prefix.
const ownProfile = 'does not apply to a push that uses deployments, since ' +
    'each deployment names its own profile.';
export const msg = {
  VALIDATED: 'Validation complete; no changes applied.',
  // The refusal of a push flag the two-phase path does not take.
  flag: {
    noKc: "'--no-kc' is not supported; every push publishes the model to " +
        'Knowledge Catalog.',
    profile: `'--profile' ${ownProfile}`,
    allProfiles: `'--all-profiles' ${ownProfile}`,
    noProfile: "'--no-profile' does not apply to a push that uses " +
        "deployments. Use '--no-deployment' to publish to Knowledge Catalog " +
        'only.',
  },
  // A deployment that names a profile the model does not declare.
  unknownProfile: (d: string, profile: string, defined: string[] = []) =>
      `[commerce] model 'commerce': deployment '${d}' names unknown binding ` +
      `profile '${profile}'; ` +
      (defined.length ? `defined profiles: ${defined.join(', ')}.` :
                        'no profiles are defined for this model.'),
};
