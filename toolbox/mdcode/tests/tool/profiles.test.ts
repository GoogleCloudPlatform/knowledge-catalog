// Tests for `kcmd profiles` (src/tool/commands.ts, profiles()) and the
// catalog.yaml `default_profile` it reads (src/libts/manifest.ts). The command
// is read-only -- it applies and prunes each profile the way push does but
// deploys nothing, and its one network call, the Cloud SQL lookup, is stubbed
// -- so it runs in a temp working directory with a pinned context, mirroring
// init_semantic_model.test.ts.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {BigQueryClient} from '../../src/libts/gcp/bigquery';
import {ApiContext} from '../../src/libts/gcp/context';
import {CatalogClient} from '../../src/libts/gcp/dataplex';
import {CatalogManifest} from '../../src/libts/manifest';
import * as bigQueryDeploy from '../../src/libts/semantic/deploy_bigquery';
import {createSemanticRuntimes} from '../../src/libts/semantic/runtime/runtime';
import * as sqlParser from '../../src/libts/semantic/sql_parser';
import {profiles, push} from '../../src/tool/commands';
import {passGraphChecks, stubCloudSqlEntry} from '../libts/mocks';

import {modelFile} from './two_phase/harness';

const CTX = new ApiContext('test-project', 'us', 'test-token');

const LOGICAL = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        primary_key: [key]
        fields:
          - { name: key, label: Customer ID }
          - { name: lifetimeValue }
          - { name: availableCredit }
      - name: Order
        primary_key: [key]
        fields:
          - { name: key }
    metrics:
      - name: order_count
        expression: COUNT(Order.key)
      - name: avg_lifetime_value
        expression: AVG(Customer.lifetimeValue)
`;

const ANALYTICAL = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployment_target: bigquery.googleapis.com/projects/acme-analytics/datasets/sales/propertyGraphs/commerce
    entities:
      - name: Customer
        source: bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/customer
        fields:
          - { name: key, expression: c_custkey }
          - { name: lifetimeValue, expression: c_ltv }
          - { name: availableCredit }
      - name: Order
        source: bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/orders
        fields:
          - { name: key, expression: o_orderkey }
`;

const OPERATIONAL = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployment_target: spanner.googleapis.com/projects/acme-ops/instances/prod/databases/commerce/graphs/commerce
    entities:
      - name: Customer
        source: spanner.googleapis.com/projects/acme-ops/instances/prod/databases/commerce/tables/Customer
        fields:
          - { name: key, expression: CustomerId }
          - { name: availableCredit, expression: AvailableCredit }
          - { name: lifetimeValue }
      - name: Order
        source: spanner.googleapis.com/projects/acme-ops/instances/prod/databases/commerce/tables/Orders
        fields:
          - { name: key, expression: OrderId }
`;

let dir = '';
let cwd = '';
let logs: string[] = [];
// The lines printed to stderr, which are in `logs` too.
let errs: string[] = [];
let savedV2Aspects: string|undefined;

function catalogYaml(defaultProfile?: string): string {
  return `scope: semantic-model.test-project.us.commerce_eg\n` +
      (defaultProfile ? `default_profile: ${defaultProfile}\n` : '');
}

function writeWorkspace(defaultProfile?: string): void {
  fs.writeFileSync(path.join(dir, 'catalog.yaml'), catalogYaml(defaultProfile));
  const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
  fs.mkdirSync(path.join(eg, 'commerce.profiles'), {recursive: true});
  fs.writeFileSync(path.join(eg, 'commerce.yaml'), LOGICAL);
  fs.writeFileSync(
      path.join(eg, 'commerce.profiles', 'analytical.yaml'), ANALYTICAL);
  fs.writeFileSync(
      path.join(eg, 'commerce.profiles', 'operational.yaml'), OPERATIONAL);
}

// A model whose bindings are inline: it declares no profile documents, so
// `profileDocuments` is empty and 'default' is the only binding there is.
function writeInlineOnlyWorkspace(): void {
  fs.writeFileSync(path.join(dir, 'catalog.yaml'), catalogYaml(undefined));
  const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
  fs.mkdirSync(eg, {recursive: true});
  fs.writeFileSync(path.join(eg, 'commerce.yaml'), LOGICAL);
}

beforeEach(() => {
  cwd = process.cwd();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-profiles-'));
  process.chdir(dir);
  logs = [];
  errs = [];
  // Each test starts with KC_V2_ASPECTS off, whatever the shell sets.
  savedV2Aspects = process.env.KC_V2_ASPECTS;
  delete process.env.KC_V2_ASPECTS;
  // No test may reach the network.
  spyOn(globalThis, 'fetch').mockImplementation((() => {
    throw new Error('a test made a network call');
  }) as any);
  passGraphChecks();
  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  spyOn(console, 'log').mockImplementation((...a: any[]) => {
    logs.push(a.join(' '));
  });
  spyOn(console, 'error').mockImplementation((...a: any[]) => {
    logs.push(a.join(' '));
    errs.push(a.join(' '));
  });
  spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  if (savedV2Aspects === undefined) {
    delete process.env.KC_V2_ASPECTS;
  } else {
    process.env.KC_V2_ASPECTS = savedV2Aspects;
  }
  process.chdir(cwd);
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
  mock.restore();
});


describe('a vanilla model with a legacy profile directory', () => {
  test('is rejected, since a vanilla model keeps its profiles in its GOOGLE block', async () => {
    fs.writeFileSync(path.join(dir, 'catalog.yaml'), catalogYaml(undefined));
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(path.join(eg, 'commerce.profiles'), {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    datasets:
      - name: Customer
        source: bigquery.googleapis.com/projects/acme/datasets/sales/tables/customer
        primary_key: [key]
        fields:
          - name: key
            expression: {dialects: [{dialect: ANSI_SQL, expression: c_key}]}
`);
    fs.writeFileSync(path.join(eg, 'commerce.profiles', 'prod.yaml'), `name: prod
entities:
  - name: Customer
    source: bigquery.googleapis.com/projects/acme/datasets/prod/tables/customer
`);
    await expect(profiles()).rejects.toThrow(
        "Profile directory 'commerce.profiles/' sits beside 'commerce.yaml', " +
        "which is a 0.2.0.dev0 document");
  });
});


// A profile file is applied to the model file loaded on its own, so the model
// file must load by itself. The YAML merge loaded the merged text instead.
describe('kcmd profiles applies a profile file to the loaded model file', () => {
  function writeModel(model: string, profile: string): void {
    fs.writeFileSync(path.join(dir, 'catalog.yaml'), catalogYaml(undefined));
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), model);
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'), profile);
  }
  const BQ = (t: string) => `bigquery.googleapis.com/projects/acme/datasets/sales/tables/${t}`;

  test('a model file that does not load alone is reported, though the profile completes it', async () => {
    writeModel(`version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: ${BQ('customer')}
        primary_key: [key]
        fields:
          - { name: key, expression: c_key }
      - name: Order
        source: ${BQ('orders')}
        primary_key: [key]
        fields:
          - { name: key, expression: o_key }
    relationships:
      - name: placed_by
        from: Order
        to: Customer
        from_columns: [o_cust]
`, `name: prod
relationships:
  - name: placed_by
    to_columns: [c_key]
`);
    // A second profile file meets the same broken model file.
    fs.writeFileSync(
        path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg',
                  'commerce.profile.staging.yaml'),
        'name: staging\n');
    // A plain push loads the model file alone first, so the report gives
    // its error once, above the models.
    expect(await profiles()).toBe(1);
    const out = logs.join('\n');
    expect(out).toContain(
        "relationship 'placed_by': from_columns and to_columns must be given " +
        'together');
    expect(out.split("Model document 'commerce'").length - 1).toBe(1);
  });

  // A legacy wrapper that fails to load fails the command too.
  test('a legacy wrapper that does not load fails the command', async () => {
    fs.writeFileSync(path.join(dir, 'catalog.yaml'), catalogYaml(undefined));
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(path.join(eg, 'commerce.profiles'), {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), LOGICAL);
    fs.writeFileSync(path.join(eg, 'commerce.profiles', 'legacy.yaml'), `semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: SELECT * FROM customer
`);
    expect(await profiles()).toBe(1);
    expect(logs.join('\n')).toContain("profile 'legacy': Model document 'commerce'");
  });

  // Applying a profile file warns as push does, under the profile's name.
  test('the warnings applying a profile file gives are printed', async () => {
    writeModel(`version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: ${BQ('customer')}
        fields:
          - { name: key, expression: c_key }
`, `name: prod
entities:
  - name: Customer
    source: ${BQ('customer_prod')}
    fields: [{ name: key, expression: c_key }]
`);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    expect(await profiles()).toBe(0);
    expect(warnSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain("profile 'prod': warning: [commerce] dataset 'Customer': no primary_key");
  });

  test('the runtime reports a model file that does not load alone', async () => {
    writeModel(`version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: ${BQ('customer')}
        primary_key: [key]
        fields:
          - { name: key, expression: c_key }
      - name: Order
        source: ${BQ('orders')}
        primary_key: [key]
        fields:
          - { name: key, expression: o_key }
    relationships:
      - name: placed_by
        from: Order
        to: Customer
        from_columns: [o_cust]
`, `name: prod
relationships:
  - name: placed_by
    to_columns: [c_key]
`);
    const runtimes = await createSemanticRuntimes(
        {path: dir, profile: 'prod', ctx: CTX, onWarning: () => {}});
    expect('error' in runtimes && runtimes.error).toContain(
        "relationship 'placed_by': from_columns and to_columns must be given " +
        'together');
    // The loader's error names the model document itself, and says why the
    // profile does not complete it.
    expect('error' in runtimes && runtimes.error)
        .toStartWith("Model document 'commerce'");
    expect('error' in runtimes && runtimes.error).toContain(
        "(under profile 'prod', the model file must load on its own before " +
        'the profile applies)');
  });

  test('the runtime names the profile file that cannot apply', async () => {
    writeModel(LOGICAL, 'name: prod\nentities:\n  - name: Ghost\n');
    const runtimes = await createSemanticRuntimes(
        {path: dir, profile: 'prod', ctx: CTX, onWarning: () => {}});
    expect('error' in runtimes && runtimes.error)
        .toBe("[commerce.profile.prod.yaml] profile 'prod': entity 'Ghost' is not in the logical model");
    // `kcmd profiles` names the profile once, since the error already does.
    logs.length = 0;
    expect(await profiles()).toBe(1);
    const out = logs.join('\n');
    expect(out).toContain("profile 'prod': entity 'Ghost' is not in the logical model");
    expect(out).not.toContain("profile 'prod': profile 'prod'");
  });

  // A legacy wrapper's merged text warns as a load does, under the profile.
  test('kcmd profiles prints the warnings of a legacy wrapper\'s load', async () => {
    fs.writeFileSync(path.join(dir, 'catalog.yaml'), catalogYaml(undefined));
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(path.join(eg, 'commerce.profiles'), {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), LOGICAL.replace(
        '      - name: Order\n        primary_key: [key]\n', '      - name: Order\n'));
    fs.writeFileSync(path.join(eg, 'commerce.profiles', 'legacy.yaml'), `semantic_model:
  - name: commerce
    entities:
      - name: Customer
        source: bigquery.googleapis.com/projects/acme/datasets/sales/tables/customer
      - name: Order
        source: bigquery.googleapis.com/projects/acme/datasets/sales/tables/orders
`);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    expect(await profiles()).toBe(0);
    expect(warnSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain("profile 'legacy': warning: [commerce] dataset 'Order': no primary_key");
  });

  // A named profile binds every concrete entity, whether or not a push
  // deploys it, so `kcmd profiles` shows the entity unbound and rejects it.
  test('a concrete entity with a source in neither file is rejected beside a model with no graph target', async () => {
    writeModel(`version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Customer
        primary_key: [key]
        fields:
          - { name: key, expression: c_key }
`, `name: prod
entities:
  - name: Customer
    primary_key: [cust_key]
    fields:
      - { name: key, expression: cust_key }
`);
    const error = "[commerce.profile.prod.yaml] profile 'prod': entity " +
        "'Customer' has no source in this profile";
    expect(await profiles()).toBe(1);
    expect(logs).toContain('      Customer -> (unbound)');
    expect(errs).toContain(`      ${error}`);
    // Push checks that the file-copy type exists; that lookup passes.
    spyOn(CatalogClient.prototype, 'getEntryType')
        .mockResolvedValue({status: 200, result: {}} as any);
    spyOn(CatalogClient.prototype, 'getAspectType')
        .mockResolvedValue({status: 200, result: {}} as any);
    errs.length = 0;
    expect(await push({validateOnly: true, profile: 'prod'})).toBe(1);
    expect(errs).toEqual([`Error: ${error}`]);
  });
});


describe('a runtime over a sibling profile file', () => {
  test('applies the profile to the model file', async () => {
    fs.writeFileSync(path.join(dir, 'catalog.yaml'), catalogYaml(undefined));
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), LOGICAL);
    fs.writeFileSync(path.join(eg, 'commerce.profile.analytical.yaml'), `name: analytical
entities:
  - name: Customer
    source: bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/customer
    fields:
      - { name: key, expression: c_custkey }
      - { name: lifetimeValue, expression: c_ltv }
    fields_exclude: [availableCredit]
  - name: Order
    source: bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/orders
    fields:
      - { name: key, expression: o_orderkey }
`);
    const warnings: string[] = [];
    const runtimes = await createSemanticRuntimes(
        {path: dir, profile: 'analytical', ctx: CTX, onWarning: w => warnings.push(w)});
    if ('error' in runtimes) throw new Error(runtimes.error);
    const customer = runtimes[0].model.entities.find(e => e.name === 'Customer')!;
    expect(customer.dataSource).toBe('acme-analytics.sales.customer');
    expect(customer.fields.map(f => f.name)).toEqual(['key', 'lifetimeValue']);
    expect(customer.fields[0].expression).toBe('c_custkey');
    expect(warnings).toEqual([]);
  });

  // The model file's own load warnings survive, and an excluded metric is not
  // available under the profile.
  test('keeps the model file\'s warnings and drops an excluded metric', async () => {
    fs.writeFileSync(path.join(dir, 'catalog.yaml'), catalogYaml(undefined));
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), LOGICAL.replace(
        '      - name: Order\n        primary_key: [key]\n',
        '      - name: Order\n'));
    fs.writeFileSync(path.join(eg, 'commerce.profile.analytical.yaml'), `name: analytical
entities:
  - name: Customer
    source: bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/customer
    fields:
      - { name: key, expression: c_custkey }
      - { name: lifetimeValue, expression: c_ltv }
    fields_exclude: [availableCredit]
  - name: Order
    source: bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/orders
    fields:
      - { name: key, expression: o_orderkey }
metrics_exclude: [order_count]
`);
    const warnings: string[] = [];
    const runtimes = await createSemanticRuntimes(
        {path: dir, profile: 'analytical', ctx: CTX, onWarning: w => warnings.push(w)});
    if ('error' in runtimes) throw new Error(runtimes.error);
    expect(warnings.join('\n')).toContain("dataset 'Order': no primary_key");
    expect((runtimes[0].model.metrics ?? []).map(m => m.name))
        .toEqual(['avg_lifetime_value']);
  });
});


describe('a runtime over a scope that mixes the two profile forms', () => {
  test('warns in document order', async () => {
    fs.writeFileSync(path.join(dir, 'catalog.yaml'), catalogYaml(undefined));
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(path.join(eg, 'a.profiles'), {recursive: true});
    const BQ = (t: string) =>
        `bigquery.googleapis.com/projects/acme/datasets/raw/tables/${t}`;
    const keyless = (name: string) => `version: "0.2.0.dev0/google"
semantic_model:
  - name: ${name}
    entities:
      - name: X
        source: ${BQ(name)}
        fields:
          - { name: id, expression: id }
`;
    fs.writeFileSync(path.join(eg, 'a.yaml'), keyless('a'));
    fs.writeFileSync(path.join(eg, 'b.yaml'), keyless('b'));
    fs.writeFileSync(path.join(eg, 'a.profiles', 'prod.yaml'), `semantic_model:
  - name: a
    entities:
      - name: X
        source: ${BQ('a2')}
`);
    fs.writeFileSync(path.join(eg, 'b.profile.prod.yaml'),
                     `name: prod\nentities:\n  - name: X\n    source: ${BQ('b2')}\n`);
    const warnings: string[] = [];
    await createSemanticRuntimes(
        {path: dir, profile: 'prod', ctx: CTX, onWarning: w => warnings.push(w)});
    const at = (doc: string) =>
        warnings.findIndex(w => w.includes(`[${doc}] dataset 'X': no primary_key`));
    expect(at('a')).toBeGreaterThan(-1);
    expect(at('a')).toBeLessThan(at('b'));
  });
});


describe('kcmd profiles', () => {
  test('reads a sibling profile file', async () => {
    fs.writeFileSync(path.join(dir, 'catalog.yaml'), catalogYaml(undefined));
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), LOGICAL);
    fs.writeFileSync(path.join(eg, 'commerce.profile.analytical.yaml'), `name: analytical
entities:
  - name: Customer
    source: bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/customer
    primary_key: [c_custkey]
    fields:
      - { name: key, expression: c_custkey }
      - { name: lifetimeValue, expression: c_ltv }
    fields_exclude: [availableCredit]
  - name: Order
    source: bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/orders
    primary_key: [o_orderkey]
    fields:
      - { name: key, expression: o_orderkey }
`);
    expect(await profiles()).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain("profile 'analytical'");
    expect(out).toContain(
        'target: (none; no deployment names this profile)');
    expect(out).toContain('Customer -> bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/customer');
    expect(out).toContain('field Customer.availableCredit (excluded)');
  });

  test(
      'lists each profile with its target, sources, and withheld coverage',
      async () => {
        writeWorkspace('analytical');
        const code = await profiles();
        expect(code).toBe(0);
        const out = logs.join('\n');

        // Both profiles listed; the default one is marked.
        expect(out).toContain('profile \'analytical\' (default)');
        expect(out).toContain('profile \'operational\'');
        expect(out).not.toContain('profile \'operational\' (default)');

        // Resolved targets and normalized sources.
        expect(out).toContain(
            'target: bigquery.googleapis.com/projects/acme-analytics/datasets/sales/propertyGraphs/commerce');
        expect(out).toContain('Customer -> bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/customer');
        expect(out).toContain(
            'Customer -> spanner.googleapis.com/projects/acme-ops/instances/prod/databases/commerce/tables/Customer');

        // Withheld coverage: availableCredit only under analytical,
        // lifetimeValue (and the metric on it) only under operational.
        expect(out).toContain('field Customer.availableCredit (unbound)');
        expect(out).toContain('field Customer.lifetimeValue (unbound)');
        expect(out).toContain('metric avg_lifetime_value');
      });

  test('marks no profile default when none is configured', async () => {
    writeWorkspace(undefined);
    const code = await profiles();
    expect(code).toBe(0);
    expect(logs.join('\n')).not.toContain('(default)');
  });

  test('`--profile` reports only the profile it names', async () => {
    writeWorkspace('analytical');
    const code = await profiles({profile: 'operational'});
    expect(code).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain('profile \'operational\'');
    expect(out).not.toContain('profile \'analytical\'');
  });

  // An empty report would read as "this profile withholds nothing", which is
  // the opposite of what a misspelled name means.
  test('`--profile` naming an undeclared profile is an error', async () => {
    writeWorkspace('analytical');
    const code = await profiles({profile: 'operatonal'});
    expect(code).toBe(1);
    const out = logs.join('\n');
    expect(out).toContain('no profile \'operatonal\'');
    expect(out).toContain('\'analytical\', \'operational\'');
  });

  // The typo has to be caught whether or not the model declares any profile
  // documents. This used to report the inline binding and exit 0, because the
  // "no binding profiles" line returned before the name was ever checked --
  // so a script keying off the exit code read a misspelling as success.
  test(
      '`--profile` naming an undeclared profile is an error with inline bindings',
      async () => {
        writeInlineOnlyWorkspace();
        const code = await profiles({profile: 'operatonal'});
        expect(code).toBe(1);
        const out = logs.join('\n');
        expect(out).toContain('no profile \'operatonal\'');
        // Says what this model does have, which is not a list of names.
        expect(out).toContain('inline bindings');
        expect(out).not.toContain('no binding profiles;');
      });

  // 'default' is the sentinel for the inline bindings, so it is valid against
  // every model and a push rejects a profile file that claims the name. The
  // typo check above must not treat the one always-correct name as a
  // misspelling just because no profile document declares it -- which it did,
  // for both a model with profiles and one without.
  for (const [label, write] of [
           ['profiles declared', writeWorkspace],
           ['inline bindings only', writeInlineOnlyWorkspace],
  ] as const) {
    test(
        `\`--profile default\` reports the inline bindings (${label})`,
        async () => {
          write();
          const code = await profiles({profile: 'default'});
          expect(code).toBe(0);
          const out = logs.join('\n');
          expect(out).toContain('profile \'default\'');
          expect(out).toContain('inline');
          expect(out).not.toContain('no profile \'default\'');
        });
  }

  // A bare `--profile` reaches cac as `true` and `--no-profile` as `false`.
  // Neither names a profile, so neither may narrow the report -- filtering on
  // one would report zero profiles for a flag the caller left blank.
  for (const profile of [true, false]) {
    test(`\`--profile ${profile}\` narrows nothing`, async () => {
      writeWorkspace('analytical');
      const code = await profiles({profile});
      expect(code).toBe(0);
      const out = logs.join('\n');
      expect(out).toContain('profile \'analytical\'');
      expect(out).toContain('profile \'operational\'');
    });
  }

  test(
      'accepts a legacy wrapper profile with a bare source across profiles, push --validate-only, and createSemanticRuntimes',
      async () => {
        spyOn(BigQueryClient.prototype, 'query')
            .mockResolvedValue({status: 200, result: {}});
        // The push checks that the file-copy type exists.
        spyOn(globalThis, 'fetch').mockImplementation((async () => {
          throw new Error('a test made a network call');
        }) as any);
        spyOn(CatalogClient.prototype, 'getEntryType')
            .mockResolvedValue({status: 200, result: {}} as any);
        spyOn(CatalogClient.prototype, 'getAspectType')
            .mockResolvedValue({status: 200, result: {}} as any);
        fs.writeFileSync(path.join(dir, 'catalog.yaml'), catalogYaml(undefined));
        const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
        fs.mkdirSync(path.join(eg, 'orders.profiles'), {recursive: true});
        fs.writeFileSync(path.join(eg, 'orders.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: orders_model
    entities:
      - name: Order
        source: bigquery.googleapis.com/projects/acme/datasets/dev/tables/orders
        primary_key: [id]
        fields:
          - { name: id, expression: o_id }
`);
        fs.writeFileSync(
            path.join(eg, 'orders.profiles', 'prod.yaml'),
            `version: "0.2.0.dev0/google"
semantic_model:
  - name: orders_model
    deployment_target: bigquery.googleapis.com/projects/acme/datasets/prod/propertyGraphs/orders_model
    entities:
      - name: Order
        source: acme.prod.orders
`);

        expect(await profiles({profile: 'prod'})).toBe(0);
        expect(logs.join('\n')).toContain('Order -> acme.prod.orders');

        expect(await push({validateOnly: true, profile: 'prod'})).toBe(0);

        const rt = await createSemanticRuntimes({path: dir, profile: 'prod', ctx: CTX});
        expect(Array.isArray(rt)).toBe(true);
        if (Array.isArray(rt)) {
          expect(rt).toHaveLength(1);
          expect(rt[0].model.entities[0].dataSource).toBe('acme.prod.orders');
        }
      });
});


// `kcmd profiles` runs the local checks `kcmd push --profile <name>` runs, so
// an author can tell from its report alone whether push accepts a profile.
describe('kcmd profiles reports what push rejects', () => {
  const BQ = (dataset: string, table: string) =>
      `bigquery.googleapis.com/projects/acme/datasets/${dataset}/tables/${table}`;
  const GRAPH =
      'bigquery.googleapis.com/projects/acme/datasets/prod/propertyGraphs/commerce';
  const SPANNER_DB =
      'spanner.googleapis.com/projects/acme/instances/prod/databases/commerce';
  const INLINE = "  profile 'default': the model document's own inline " +
      'bindings, as authored -- nothing merged, nothing withheld.';
  const NO_PROFILES = "  no binding profiles; the model document is its own " +
      "inline 'default' binding.";

  // Purchases join customers on the customer's key, c_id. `targets` is how
  // many graph deployments the model declares. `joined: false` leaves the join
  // without columns, which push rejects for a model with a graph target.
  function commerce({targets = 0, joined = true} = {}): string {
    const deployments = ['prod'].slice(0, targets).map(
        d => `      - name: ${d}\n        target: ${GRAPH}_${d}\n`);
    return `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
${targets ? `    deployments:\n${deployments.join('')}` : ''}\
    entities:
      - name: customer
        source: ${BQ('dev', 'customer')}
        primary_key: [c_id]
        fields:
          - { name: c_id, expression: c_id }
      - name: purchase
        source: ${BQ('dev', 'purchase')}
        primary_key: [p_id]
        fields:
          - { name: p_id, expression: p_id }
    relationships:
      - name: placed_by
        from: purchase
        to: customer
${joined ? '        from_columns: [p_customer]\n        to_columns: [c_id]\n' : ''}`;
  }

  // `model` with unique keys in place of primary keys. A graph generator
  // builds a node only from a primary key.
  const uniqueKeysOnly = (model: string) =>
      model.replace(/primary_key: \[(\w+)\]/g, 'unique_keys: [[$1]]');

  // `model` with no source on customer.
  const customerUnbound = (model: string) =>
      model.replace(`        source: ${BQ('dev', 'customer')}\n`, '');

  // `text` with the join on c_email in place of c_id.
  const joinOnEmail = (text: string) =>
      text.replace('to_columns: [c_id]', 'to_columns: [c_email]');

  // The profile comparison's error for a join of `who` on `to` that covers no
  // key of customer.
  const compared = (who: string, to: string) =>
      `[commerce] relationship 'placed_by': ${who} joins on to_columns ` +
      `["${to}"], which cover no primary or unique key of 'customer'`;

  // Push's own error for a join on `to` in `binding` that covers no key.
  const own = (binding: string, to: string) =>
      `relationship 'placed_by' in model 'commerce' (${binding}): its ` +
      `to_columns ["${to}"] cover no primary or unique key of 'customer'; ` +
      "join on every column of one of its keys, and declare that key if " +
      "'customer' has none.";

  // A profile file that binds both entities to the prod tables and the join
  // between them. It states each entity's key, customer's as `key`, and
  // restates each field.
  function profileFile(name: string, key = 'c_id'): string {
    return `name: ${name}
entities:
  - name: customer
    source: ${BQ('prod', 'customer')}
    primary_key: ["${key}"]
    fields: [{ name: c_id, expression: c_id }]
  - name: purchase
    source: ${BQ('prod', 'purchase')}
    primary_key: [p_id]
    fields: [{ name: p_id, expression: p_id }]
relationships:
  - name: placed_by
    from_columns: [p_customer]
    to_columns: [c_id]
`;
  }

  // A field that reads `expression`, by default the column `name`.
  const col = (name: string, expression = name) =>
      `{ name: ${name}, expression: ${expression} }`;
  // A profile entity bound to its prod table, with key `key` and `fields`.
  const prodEntity = (name: string, key: string, ...fields: string[]) =>
      `  - name: ${name}\n    source: ${BQ('prod', name)}\n    primary_key: [${key}]\n` +
      (fields.length ? `    fields: [${fields.join(', ')}]\n` : '');

  // A legacy profile that binds customer to the prod table, or purchase when
  // `entity` says so. With `target` it names a graph, so push deploys one for
  // it.
  function legacyProfile(target: boolean, entity = 'customer'): string {
    return `semantic_model:
  - name: commerce
${target ? `    deployment_target: ${GRAPH}\n` : ''}\
    entities:
      - name: ${entity}
        source: ${BQ('prod', entity)}
`;
  }

  // Writes catalog.yaml, and each file under the entry group's directory.
  function writeScope(
      files: Record<string, string>, defaultProfile?: string): void {
    fs.writeFileSync(
        path.join(dir, 'catalog.yaml'), catalogYaml(defaultProfile));
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    for (const [name, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(eg, name)), {recursive: true});
      fs.writeFileSync(path.join(eg, name), text);
    }
  }

  // The exit code of `kcmd push --validate-only` for profile `opts` when it is
  // a name, or with options `opts` otherwise, and the errors it prints. An
  // error push throws counts as one, as the command line prints it and exits 1.
  async function pushResult(opts: string|Parameters<typeof push>[0] = {}):
      Promise<{code: number; errors: string[]}> {
    logs.length = 0;
    errs.length = 0;
    let code: number;
    const thrown: string[] = [];
    try {
      code = await push({
        validateOnly: true,
        ...(typeof opts === 'string' ? {profile: opts} : opts),
      });
    } catch (err: any) {
      code = 1;
      thrown.push(err.message);
    }
    const leg = /^Error pushing semantic model to [^:]*: /;
    expect(errs.filter(e => !e.startsWith('Error: ') && !leg.test(e)))
        .toEqual([]);
    const errors = [
      ...logs.filter(l => l.startsWith('Error: '))
          .map(l => l.slice('Error: '.length)),
      ...logs.filter(l => leg.test(l)).map(l => l.replace(leg, '')),
      ...thrown,
    ];
    logs.length = 0;
    errs.length = 0;
    return {code, errors};
  }

  // The lines of the report from the line `header` to the next line indented
  // two spaces or less.
  function section(header: string): string[] {
    const start = logs.indexOf(header);
    if (start < 0) return [];
    const end = logs.findIndex((l, i) => i > start && /^ {0,2}\S/.test(l));
    return logs.slice(start, end < 0 ? undefined : end);
  }
  const profileSection = (name: string) => section(`  profile '${name}'`);

  // The errors under the `push rejects:` heading at `indent` in `lines`, each
  // rebuilt from its first line and the lines indented further after it. The
  // heading and every error line are on stderr.
  function rejects(lines: string[], indent = '    '): string[] {
    const at = lines.indexOf(`${indent}push rejects:`);
    if (at < 0) return [];
    const out: string[] = [];
    for (const l of lines.slice(at + 1)) {
      if (l.startsWith(`${indent}    `)) {
        out[out.length - 1] += `\n${l.slice(indent.length + 4)}`;
      } else if (l.startsWith(`${indent}  `)) {
        out.push(l.slice(indent.length + 2));
      } else {
        break;
      }
      expect(errs).toContain(l);
    }
    expect(errs).toContain(lines[at]);
    return out;
  }
  // The errors under every `push rejects:` heading of the report, in order.
  const allRejects = () => logs.flatMap(
      (l, i) => l.trim() === 'push rejects:' ?
          rejects(logs.slice(i), l.replace('push rejects:', '')) :
          []);

  // Each push in `pushes` fails with exactly its errors, or passes with none,
  // and `kcmd profiles` shows them under that binding. A key names the profile
  // the push applies, or 'default' for none.
  async function expectPushes(pushes: Record<string, string[]>, label = '') {
    for (const [profile, errors] of Object.entries(pushes)) {
      expect({label, profile, ...await pushResult(profile)})
          .toEqual({label, profile, code: errors.length ? 1 : 0, errors});
    }
    expect(await profiles()).toBe(1);
    const inline = logs.includes(INLINE) ? INLINE : NO_PROFILES;
    for (const [profile, errors] of Object.entries(pushes)) {
      const lines =
          profile === 'default' ? section(inline) : profileSection(profile);
      expect({label, profile, errors: rejects(lines)})
          .toEqual({label, profile, errors});
    }
  }

  // A plain push fails with exactly the errors in `sections`, or passes with
  // none, and `kcmd profiles` shows each under its key: a profile, 'default'
  // for the model file's own bindings, or 'model' above the profiles.
  async function expectReport(sections: Record<string, string[]>, label = '') {
    const errors = Object.values(sections).flat();
    const {code, errors: pushed} = await pushResult();
    expect({label, code, errors: [...pushed].sort()}).toEqual(
        {label, code: errors.length ? 1 : 0, errors: [...errors].sort()});
    expect(await profiles()).toBe(errors.length ? 1 : 0);
    for (const [key, want] of Object.entries(sections)) {
      const got = key === 'model' ? rejects(logs, '  ') :
          rejects(key === 'default' ? section(INLINE) : profileSection(key));
      expect({label, key, errors: got}).toEqual({label, key, errors: want});
    }
    expect(allRejects()).toHaveLength(errors.length);
  }

  // The model file's error for field `name`, written 'entity.field', with no
  // text for the `dialect` of its entity's source.
  const modelNoText = (name: string, dialect = 'BIGQUERY') =>
      `field '${name}' in model 'commerce' (commerce) has no expression for ` +
      `${dialect} or ANSI_SQL, and the model file binds entity '${
          name.split('.')[0]}' to a ${dialect} source`;
  // The end of the error for a field whose text --transpile can translate.
  const HINT = '; give it one, or pass --transpile.';
  // Field amount, whose one text is `text` in `dialect`.
  const amount = (dialect: string, text: string) =>
      `{ name: amount, expression: { dialects: [{ dialect: ${dialect}, ` +
      `expression: ${text} }] } }`;

  beforeEach(() => {
    // Push probes BigQuery before it generates a graph; that probe passes.
    spyOn(BigQueryClient.prototype, 'query')
        .mockResolvedValue({status: 200, result: {}});
    // Push checks that the file-copy type exists; that lookup passes.
    spyOn(CatalogClient.prototype, 'getEntryType')
        .mockResolvedValue({status: 200, result: {}} as any);
    spyOn(CatalogClient.prototype, 'getAspectType')
        .mockResolvedValue({status: 200, result: {}} as any);
  });

  test('a profile push accepts keeps its report and exits 0', async () => {
    writeScope({
      'commerce.yaml': commerce(),
      'commerce.profile.prod.yaml': profileFile('prod'),
    });
    expect(await pushResult('prod')).toEqual({code: 0, errors: []});
    expect(await pushResult()).toEqual({code: 0, errors: []});
    expect(await profiles()).toBe(0);
    expect(logs).toEqual([
      "Model 'commerce' (commerce_eg):",
      "  profile 'prod'",
      '    target: (none; no deployment names this profile)',
      '    sources:',
      '      customer -> bigquery.googleapis.com/projects/acme/datasets/prod/tables/customer',
      '      purchase -> bigquery.googleapis.com/projects/acme/datasets/prod/tables/purchase',
      '    cannot answer: nothing withheld.',
    ]);
  });

  // Push accepts each of these profiles, so `kcmd profiles` must too.
  const accepted: Array<[string, Record<string, string>]> = [
    [
      'a legacy profile with no graph target leaves an entity without a source',
      {
        'commerce.yaml': customerUnbound(commerce()),
        'commerce.profiles/prod.yaml': legacyProfile(false, 'purchase'),
      },
    ],
  ];
  for (const [label, files] of accepted) {
    test(`exits 0 when ${label}`, async () => {
      writeScope(files);
      expect(await pushResult('prod')).toEqual({code: 0, errors: []});
      expect(await profiles()).toBe(0);
      expect(profileSection('prod')).toContain('      customer -> (unbound)');
      expect(errs).toEqual([]);
    });
  }

  // On `customer`, inheritance removes `party.` from `party.customer.` and
  // leaves only the qualifier `customer.`.
  const PARTIES = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: party
        source: ${BQ('dev', 'party')}
        primary_key: [id]
        fields:
          - { name: id, expression: id }
          - { name: notes }
      - name: customer
        extends: [party]
        source: ${BQ('dev', 'customer')}
        primary_key: [id]
        fields: [{ name: id, expression: id }]
`;
  const partiesProfile = (exclude: boolean) => `name: prod\nentities:\n` +
      prodEntity('party', 'id', col('id'), col('notes', '"party.customer."')) +
      prodEntity('customer', 'id', col('id')) + (exclude ? '    fields_exclude: [notes]\n' : '');
  const NOTES_INHERITED = "entity 'customer' inherits field 'notes': read " +
      "on 'customer', 'expression' is only the qualifier 'customer.'; write " +
      "the field's SQL";

  // A catalog-only push publishes every field, exclusions lifted. The check
  // that an inherited field holds SQL still leaves out a field the profile
  // excludes on the entity, as applying the profile does.
  test('exits 0 when a profile file excludes an inherited field that holds no SQL on the entity', async () => {
    writeScope({
      'commerce.yaml': PARTIES,
      'commerce.profile.prod.yaml': partiesProfile(true),
    });
    expect(await pushResult('prod')).toEqual({code: 0, errors: []});
    expect(await profiles()).toBe(0);
    expect(profileSection('prod')).toContain('      customer -> bigquery.googleapis.com/projects/acme/datasets/prod/tables/customer');
    expect(errs).toEqual([]);
    writeScope({'commerce.profile.prod.yaml': partiesProfile(false)});
    const {code, errors} = await pushResult('prod');
    expect(code).toBe(1);
    expect(errors.join('\n')).toContain(NOTES_INHERITED);
  });

  // The text merged from a legacy wrapper cannot say what the wrapper
  // excludes, so the load is told.
  test('exits 0 when a legacy profile excludes an inherited field that holds no SQL on the entity', async () => {
    const legacy = (exclude: boolean, target: boolean) => `semantic_model:
  - name: commerce
${target ? `    deployment_target: ${GRAPH}\n` : ''}\
    entities:
      - name: party
        source: ${BQ('prod', 'party')}
        fields:
          - { name: notes, expression: "party.customer." }
      - name: customer
        source: ${BQ('prod', 'customer')}
${exclude ? '        fields_exclude: [notes]\n' : ''}`;
    for (const target of [false, true]) {
      writeScope({
        'commerce.yaml': PARTIES,
        'commerce.profiles/prod.yaml': legacy(true, target),
      });
      expect(await pushResult('prod')).toEqual({code: 0, errors: []});
      expect(await profiles()).toBe(0);
      expect(profileSection('prod')).toContain('      customer -> bigquery.googleapis.com/projects/acme/datasets/prod/tables/customer');
      expect(errs).toEqual([]);
      const runtimes = await createSemanticRuntimes(
          {path: dir, profile: 'prod', ctx: CTX, onWarning: () => {}});
      if ('error' in runtimes) throw new Error(runtimes.error);
      writeScope({'commerce.profiles/prod.yaml': legacy(false, target)});
      const {code, errors} = await pushResult('prod');
      expect(code).toBe(1);
      expect(errors.join('\n')).toContain(NOTES_INHERITED);
    }
  });

  // Each scope makes `kcmd push --profile prod` fail. A new check push gains
  // needs only a new row here.
  const rejected: Array<[string, Record<string, string>]> = [
    [
      'a profile file leaves an entity without a source beside a model with ' +
          'no graph target',
      {
        'commerce.yaml': customerUnbound(commerce()),
        'commerce.profile.prod.yaml':
            `name: prod\nentities:\n  - name: purchase\n    source: ${
                BQ('prod', 'purchase')}\n`,
      },
    ],
    [
      'a profile file sets a primary key the join does not cover',
      {
        'commerce.yaml': commerce(),
        'commerce.profile.prod.yaml': profileFile('prod', 'LOWER(c_id)'),
      },
    ],
    [
      'a profile file also leaves customer without a source',
      {
        'commerce.yaml': customerUnbound(commerce()),
        'commerce.profile.prod.yaml':
            'name: prod\nentities:\n  - name: customer\n    primary_key: ["LOWER(c_id)"]\n',
      },
    ],
    [
      'a legacy profile names a graph and the join has no columns',
      {
        'commerce.yaml': commerce({joined: false}),
        'commerce.profiles/prod.yaml': legacyProfile(true),
      },
    ],
    [
      'a legacy profile names a graph and no entity has a primary key',
      {
        'commerce.yaml': uniqueKeysOnly(commerce()),
        'commerce.profiles/prod.yaml': legacyProfile(true),
      },
    ],
    [
      'a legacy profile sets a key a profile may not set',
      {
        'commerce.yaml': commerce(),
        'commerce.profiles/prod.yaml':
            'semantic_model:\n  - name: commerce\n    entities:\n' +
            '      - name: customer\n        bogus_key: x\n',
      },
    ],
    [
      'the model file does not load on its own',
      {
        'commerce.yaml': commerce().replace('        to_columns: [c_id]\n', ''),
        'commerce.profile.prod.yaml':
            'name: prod\nrelationships:\n  - name: placed_by\n    to_columns: [c_id]\n',
      },
    ],
    [
      'another model in the scope does not declare the profile',
      {
        'commerce.yaml': commerce(),
        'commerce.profile.prod.yaml': profileFile('prod'),
        'shop.yaml': commerce().replace('name: commerce', 'name: shop'),
      },
    ],
  ];
  // A plain push of a model with a sibling profile file runs in two phases,
  // and the report gives its errors instead.
  for (const [label, files] of rejected) {
    test(`prints only push's errors when ${label}`, async () => {
      writeScope(files);
      const twoPhase = Object.keys(files).some(f => f.includes('.profile.'));
      const pushed = await pushResult(twoPhase ? {} : 'prod');
      expect(pushed.code).toBe(1);
      expect(pushed.errors).not.toEqual([]);
      expect(await profiles()).toBe(1);
      expect(allRejects()).toEqual(pushed.errors);
    });
  }

  // Push applies the profile a deployment names, but it only stores a legacy
  // profile, so a deployment cannot use one. The report gives push's error
  // under that profile, and none under the model file's own bindings.
  test('push refuses a deployment that names a legacy profile, and the report gives the error under that profile', async () => {
    writeScope({
      'commerce.yaml': commerce({targets: 1})
                           .replace(/(target: \S+)\n/, '$1\n        profile: prod\n'),
      'commerce.profiles/prod.yaml': legacyProfile(false),
    });
    const legacy = "[commerce] deployment 'prod' names profile 'prod', which " +
        "is in the legacy 'semantic_model:' form; a deployment can use only " +
        'a profile file.';
    expect(await pushResult()).toEqual({code: 1, errors: [legacy]});
    expect(await profiles()).toBe(1);
    expect(rejects(profileSection('prod'))).toEqual([legacy]);
    expect(section(INLINE)).toEqual([]);
  });

  test('prints push\'s errors at the profile\'s indent, under a heading', async () => {
    writeScope({
      'commerce.yaml': commerce(),
      'commerce.profile.prod.yaml': profileFile('prod', 'LOWER(c_id)'),
    });
    const pushed = await pushResult();
    expect(pushed.errors).toHaveLength(1);
    expect(await profiles()).toBe(1);
    expect(logs).toEqual([
      "Model 'commerce' (commerce_eg):",
      "  profile 'prod'",
      '    target: (none; no deployment names this profile)',
      '    sources:',
      '      customer -> bigquery.googleapis.com/projects/acme/datasets/prod/tables/customer',
      '      purchase -> bigquery.googleapis.com/projects/acme/datasets/prod/tables/purchase',
      '    cannot answer: nothing withheld.',
      '    push rejects:',
      `      ${pushed.errors[0]}`,
    ]);
    expect(errs).toEqual(['    push rejects:', `      ${pushed.errors[0]}`]);
  });

  test('checks a profile that names a graph as a graph push, and one that does not as a catalog-only push', async () => {
    writeScope({
      'commerce.yaml': commerce({joined: false}),
      'commerce.profiles/graph.yaml': legacyProfile(true),
      'commerce.profiles/logical.yaml': legacyProfile(false),
    });
    const graph = await pushResult('graph');
    expect(graph.errors).toEqual(
        [expect.stringContaining('targets a graph but has no join columns')]);
    expect(await pushResult('logical')).toEqual({code: 0, errors: []});
    expect(await profiles()).toBe(1);
    expect(rejects(profileSection('graph'))).toEqual(graph.errors);
    expect(profileSection('logical')).toEqual([
      "  profile 'logical'",
      '    target: (none)',
      '    sources:',
      '      customer -> bigquery.googleapis.com/projects/acme/datasets/prod/tables/customer',
      '      purchase -> bigquery.googleapis.com/projects/acme/datasets/dev/tables/purchase',
      '    cannot answer: nothing withheld.',
    ]);
  });

  test('prints each failing profile\'s errors under its own name', async () => {
    writeScope({
      'commerce.yaml': commerce(),
      'commerce.profile.a.yaml': profileFile('a', 'LOWER(c_id)'),
      'commerce.profile.b.yaml':
          'name: b\nrelationships:\n  - name: placed_by\n    to_columns: [c_email]\n',
    });
    const {errors} = await pushResult();
    const own = (p: string) =>
        errors.filter(e => e.startsWith(`[commerce.profile.${p}.yaml]`));
    expect(own('a')).not.toEqual([]);
    expect(own('b')).not.toEqual([]);
    expect(await profiles()).toBe(1);
    expect(rejects(profileSection('a'))).toEqual(own('a'));
    expect(rejects(profileSection('b'))).toEqual(own('b'));
  });

  // Push generates each graph's DDL offline, and a generator can fail. Its
  // error names the deployment.
  const DEPLOYMENT_LABEL = "[commerce] deployment 'prod': ";
  const ungenerated: Array<[string, string]> = [
    ['BigQuery', uniqueKeysOnly(commerce({targets: 1}))],
    [
      'Spanner',
      uniqueKeysOnly(commerce({targets: 1}))
          .replace(`${GRAPH}_prod`, `${SPANNER_DB}/graphs/commerce`)
          .replaceAll(BQ('dev', ''), `${SPANNER_DB}/tables/`),
    ],
  ];
  for (const [system, model] of ungenerated) {
    test(`prints the error generating a ${system} graph gives`, async () => {
      writeScope({'commerce.yaml': model});
      const pushed = await pushResult();
      expect(pushed.errors).toEqual([expect.stringContaining(
          `${DEPLOYMENT_LABEL}cannot generate a property graph`)]);
      expect(await profiles()).toBe(1);
      expect(rejects(section(NO_PROFILES))).toEqual(pushed.errors);
    });
  }

  // Under --validate-only, push prints the details of a generator result
  // that reports a failure.
  test('prints the details of a graph generator that fails', async () => {
    writeScope({'commerce.yaml': commerce({targets: 1})});
    spyOn(bigQueryDeploy, 'deployBigQuery').mockResolvedValue({
      success: false,
      details: 'simulated generator failure',
      ddl: [],
      warnings: [],
      deployed: 0,
    });
    const pushed = await pushResult();
    expect(pushed).toEqual({
      code: 1,
      errors: [`${DEPLOYMENT_LABEL}simulated generator failure`],
    });
    expect(await profiles()).toBe(1);
    expect(rejects(section(NO_PROFILES))).toEqual(pushed.errors);
  });

  // A plain push checks the model file's own bindings beside a profile file,
  // whatever `default_profile` names, and the report gives the error above
  // the profiles.
  for (const defaultProfile of [undefined, 'prod']) {
    test(`checks the inline bindings beside a profile file${
             defaultProfile ? ' when default_profile is set' : ''}`,
         async () => {
           writeScope(
               {
                 'commerce.yaml': joinOnEmail(commerce()),
                 'commerce.profile.prod.yaml': profileFile('prod'),
               },
               defaultProfile);
           const pushed = await pushResult();
           expect(pushed).toEqual(
               {code: 1, errors: [own('commerce', 'c_email')]});
           expect(await pushResult({deployment: false})).toEqual(pushed);
           expect(await profiles()).toBe(1);
           expect(rejects(logs, '  ')).toEqual(pushed.errors);
           expect(allRejects()).toEqual(pushed.errors);
           logs.length = 0;
           expect(await profiles({profile: 'default'})).toBe(1);
           expect(rejects(logs, '  ')).toEqual(pushed.errors);
         });
  }

  // A plain push refuses a `default_profile` the model does not declare. The
  // report prints the error above the profiles, under `--profile` too.
  test('prints push\'s error when default_profile names a profile the model does not declare', async () => {
    writeScope(
        {
          'commerce.yaml': commerce(),
          'commerce.profile.prod.yaml': profileFile('prod'),
        },
        'prd');
    const pushed = await pushResult();
    expect(pushed).toEqual({
      code: 1,
      errors: [
        "unknown binding profile 'prd' for model 'commerce'; defined " +
            'profiles: prod.',
      ],
    });
    expect(await profiles()).toBe(1);
    expect(logs[1]).toBe('  push rejects:');
    expect(rejects(logs, '  ')).toEqual(pushed.errors);
    expect(rejects(profileSection('prod'))).toEqual([]);
    logs.length = 0;
    errs.length = 0;
    expect(await profiles({profile: 'prod'})).toBe(1);
    expect(rejects(logs, '  ')).toEqual(pushed.errors);
  });

  // `default_profile: default` names the inline bindings, which every model
  // has.
  test('passes default_profile: default beside a profile file', async () => {
    writeScope(
        {
          'commerce.yaml': commerce(),
          'commerce.profile.prod.yaml': profileFile('prod'),
        },
        'default');
    expect(await pushResult()).toEqual({code: 0, errors: []});
    expect(await profiles()).toBe(0);
    expect(errs).toEqual([]);
  });

  // `text` with a 130 KiB third-party block on the model, which only the
  // second-generation aspects store.
  const bigBlock = (text: string) => text.replace(
      '  - name: commerce\n',
      `  - name: commerce\n    custom_extensions:\n      - {vendor_name: DBT, ` +
          `data: ${'x'.repeat(130 * 1024)}}\n`);
  // Customer's c_id field and 400 more, each reading its own column. A
  // profile file restates them all, so each profile adds 401 expressions to
  // customer's aspect.
  const WIDE = `fields: [{ name: c_id, expression: c_id }, ${
      Array.from({length: 400}, (_, i) => `{ name: f${i}, expression: col_${i} }`)
          .join(', ')}]`;
  // Push gives a scope with two models its one-model error, once, and checks
  // neither the copies nor the aspects.
  for (const [label, model, v2] of [
         ['', commerce(), false],
         [' and a file over the size limit',
          `# ${'x'.repeat(130 * 1024)}\n${commerce()}`, false],
         [' and an aspect over the size limit with KC_V2_ASPECTS on',
          bigBlock(commerce()), true],
       ] as const) {
    test(`prints only push's one-model error for two models${label}`,
         async () => {
           if (v2) process.env.KC_V2_ASPECTS = '1';
           writeScope({
             'commerce.yaml': model,
             'shop.yaml': commerce().replace('name: commerce', 'name: shop'),
           });
           const pushed = await pushResult();
           expect(pushed.errors).toEqual(
               [expect.stringContaining('would receive 2 models')]);
           expect(await profiles()).toBe(1);
           expect(rejects(logs, '')).toEqual(pushed.errors);
           expect(logs.filter(l => l.includes('would receive 2 models')))
               .toHaveLength(1);
           expect(logs.join('\n')).not.toContain('too large');
         });
  }

  // With KC_V2_ASPECTS off, push stores a copy of each model and profile file
  // and checks the copies before any graph deploys, so a copy that fails a
  // check fails every push of the scope.
  const copyCases: Array<[string, () => void, string]> = [
    [
      'a file over the size limit',
      () => writeScope(
          {'commerce.yaml': `# ${'x'.repeat(130 * 1024)}\n${commerce()}`}),
      "file 'commerce.yaml' is too large to store in Knowledge Catalog",
    ],
    [
      'a file that is not valid UTF-8',
      () => {
        writeScope({'commerce.yaml': commerce()});
        fs.writeFileSync(
            path.join(
                dir, 'catalog', 'EntryGroups', 'commerce_eg',
                'commerce.profile.prod.yaml'),
            Buffer.concat([
              Buffer.from('# caf'), Buffer.from([0xe9]),
              Buffer.from(`\n${profileFile('prod')}`)
            ]));
      },
      "File 'commerce.profile.prod.yaml' is not valid UTF-8",
    ],
  ];
  for (const [label, write, error] of copyCases) {
    test(`prints push's error once for ${label}`, async () => {
      write();
      const pushed = await pushResult();
      expect(pushed).toEqual(
          {code: 1, errors: [expect.stringContaining(error)]});
      expect(await profiles()).toBe(1);
      expect(rejects(logs, '')).toEqual(pushed.errors);
      expect(logs.filter(l => l.includes(error))).toHaveLength(1);
    });

    test(`checks no copy for ${label} with KC_V2_ASPECTS on`, async () => {
      write();
      process.env.KC_V2_ASPECTS = '1';
      expect(await pushResult()).toEqual({code: 0, errors: []});
      expect(await profiles()).toBe(0);
      expect(logs).not.toContain('push rejects:');
    });
  }

  // With KC_V2_ASPECTS on, push reads the overview sidecars and checks every
  // aspect the catalog leg writes, before any graph deploys. A malformed
  // sidecar is reported once, for the scope. For a push in two phases, an
  // aspect too large belongs to the model.
  for (const [label, files, error, profile, indent = '    '] of [
         ['an aspect over the size limit in a graph push',
          {'commerce.yaml': bigBlock(commerce({targets: 1}))},
          'too large to store in Knowledge Catalog', undefined, '  '],
         ['an aspect over the size limit beside a profile file', {
           'commerce.yaml': bigBlock(commerce()),
           'commerce.profile.prod.yaml': profileFile('prod'),
         }, 'too large to store in Knowledge Catalog', undefined, '  '],
         ['an aspect only six profile files together make too large', {
           'commerce.yaml': commerce().replace(
               'fields:\n          - { name: c_id, expression: c_id }', WIDE),
           ...Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f'].map(p => [
             `commerce.profile.${p}.yaml`,
             profileFile(p).replace(/fields: \[\{ name: c_id.*/, WIDE),
           ])),
         }, 'too large to store in Knowledge Catalog', undefined, '  '],
         ['a malformed overview sidecar', {
           'commerce.yaml': commerce(),
           'commerce.overview.md':
               '---\ncontentType: markdown\n---\nOrders and customers.\n',
         }, "not 'markdown'", undefined, ''],
       ] as [string, Record<string, string>, string, string?, string?][]) {
    test(`prints push's error for ${label} with KC_V2_ASPECTS on`, async () => {
      process.env.KC_V2_ASPECTS = '1';
      writeScope(files);
      const pushed = await pushResult(profile);
      expect(pushed).toEqual(
          {code: 1, errors: [expect.stringContaining(error)]});
      expect(await profiles()).toBe(1);
      expect(rejects(profile ? profileSection(profile) : logs, indent))
          .toEqual(pushed.errors);
    });
  }

  test('prints push\'s warnings for a custom ai_context member push leaves ' +
           'out and a sidecar that names no entry, with KC_V2_ASPECTS on',
       async () => {
         process.env.KC_V2_ASPECTS = '1';
         const warned: string[] = [];
         spyOn(console, 'warn').mockImplementation((m: any) => {
           warned.push(String(m));
         });
         const model = commerce().replace(
             '  - name: commerce\n',
             '  - name: commerce\n    ai_context: {custom: {cap: .inf}}\n');
         // With the flag on, link IDs are hashes, so push takes `placed__by`
         // beside `placed_by`.
         writeScope({
           'commerce.yaml': `${model}      - {name: placed__by, from: ` +
               'purchase, to: customer, from_columns: [p_customer], ' +
               'to_columns: [c_id]}\n',
           'commerce/metrics/gone.overview.md': 'Old.\n',
         });
         const warning = '[commerce] model \'commerce\': ai_context member ' +
             '\'cap\' is not pushed: its value holds .inf, which Knowledge ' +
             'Catalog cannot store as written';
         const sidecar = '[commerce] sidecar ' +
             '\'commerce/metrics/gone.overview.md\' names no entry of this ' +
             'model; it is not pushed';
         expect(await pushResult()).toEqual({code: 0, errors: []});
         expect(warned.splice(0)).toEqual(expect.arrayContaining(
             [`Warning: ${warning}`, `Warning: ${sidecar}`]));
         expect(await profiles()).toBe(0);
         expect(warned.splice(0)).toEqual(
             [warning, sidecar].map(w => `  profile 'default': warning: ${w}`));
         // A model that lists deployments: the report warns once, as push does.
         const deployed = commerce({targets: 1}).replace(
             '  - name: commerce\n',
             '  - name: commerce\n    ai_context: {custom: {cap: .inf}}\n');
         writeScope({'commerce.yaml': deployed});
         expect(await profiles()).toBe(0);
         expect(warned.splice(0))
             .toEqual([warning, sidecar].map(w => `Warning: ${w}`));
         delete process.env.KC_V2_ASPECTS;
         for (const m of [model, deployed]) {
           writeScope({'commerce.yaml': m});
           expect(await profiles()).toBe(0);
         }
         expect(warned).toEqual([]);
       });

  test('reads each profile file once', async () => {
    writeScope({
      'commerce.yaml': commerce(),
      'commerce.profile.prod.yaml': profileFile('prod'),
    });
    const profilePath = path.join(
        dir, 'catalog', 'EntryGroups', 'commerce_eg',
        'commerce.profile.prod.yaml');
    const readSpy = spyOn(fs, 'readFileSync');

    expect(await profiles()).toBe(0);

    expect(
        readSpy.mock.calls.filter(c => path.resolve(String(c[0])) === profilePath))
        .toHaveLength(1);
  });

  // A graph push reads the profile files before anything else, so a profile
  // file that breaks a layout rule throws before anything prints.
  for (const v2Aspects of [false, true]) {
    test(`throws as push does for a profile file that breaks a layout rule${
             v2Aspects ? ' with KC_V2_ASPECTS on' : ''}`,
         async () => {
           if (v2Aspects) process.env.KC_V2_ASPECTS = '1';
           writeScope({
             'commerce.yaml': commerce(),
             'commerce.profile.prod.yaml': profileFile('other'),
           });
           const pushed = await pushResult('prod');
           expect(pushed).toEqual({
             code: 1,
             errors: [expect.stringContaining("declares name 'other'")],
           });
           await expect(profiles()).rejects.toThrow(pushed.errors[0]);
           expect(logs).toEqual([]);
         });
  }

  // Push reserves the name in any letter case.
  for (const name of ['default', 'Default']) {
    test(`prints push's error for a legacy profile named ${name}`, async () => {
      writeScope({
        'commerce.yaml': commerce(),
        [`commerce.profiles/${name}.yaml`]: legacyProfile(true),
      });
      const pushed = await pushResult();
      expect(pushed.errors).toEqual(
          [expect.stringContaining("may not be named 'default'")]);
      expect(await profiles()).toBe(1);
      expect(logs[1]).toBe('  push rejects:');
      expect(rejects(logs, '  ')).toEqual(pushed.errors);
      expect(profileSection(name)).toEqual([]);
      expect(logs).toEqual([
        "Model 'commerce' (commerce_eg):",
        '  push rejects:',
        `    ${pushed.errors[0]}`,
      ]);
    });
  }

  test('prints only push\'s error for --profile Default beside a legacy Default.yaml', async () => {
    writeScope({
      'commerce.yaml': commerce(),
      'commerce.profiles/Default.yaml': legacyProfile(true),
    });
    const pushed = await pushResult('Default');
    expect(pushed.errors).toEqual(
        [expect.stringContaining("may not be named 'default'")]);
    expect(await profiles({profile: 'Default'})).toBe(1);
    expect(logs).toEqual([
      "Model 'commerce' (commerce_eg):",
      '  push rejects:',
      `    ${pushed.errors[0]}`,
    ]);
  });

  // A push that names no profile stops at the reserved name before it looks
  // for `default_profile`, so that error is the only one.
  test('prints only the reserved-name error when default_profile names the reserved file', async () => {
    writeScope(
        {
          'commerce.yaml': commerce(),
          'commerce.profiles/Default.yaml': legacyProfile(true),
        },
        'Default');
    const pushed = await pushResult();
    expect(pushed.errors).toEqual(
        [expect.stringContaining("may not be named 'default'")]);
    expect(await profiles()).toBe(1);
    expect(logs).toEqual([
      "Model 'commerce' (commerce_eg):",
      '  push rejects:',
      `    ${pushed.errors[0]}`,
    ]);
  });

  // The error for an undeclared default_profile lists the profiles a bare push
  // lists once the reserved file is gone.
  test('leaves the reserved file out of the profiles an unknown default_profile error lists', async () => {
    writeScope(
        {
          'commerce.yaml': commerce(),
          'commerce.profiles/default.yaml': legacyProfile(true),
          'commerce.profiles/prod.yaml': legacyProfile(false),
        },
        'staging');
    const pushed = await pushResult();
    expect(await profiles()).toBe(1);
    const report = rejects(logs, '  ');
    fs.rmSync(path.join(
        dir, 'catalog', 'EntryGroups', 'commerce_eg', 'commerce.profiles',
        'default.yaml'));
    const bare = await pushResult();
    expect(bare.errors).toEqual(
        [expect.stringContaining("unknown binding profile 'staging'")]);
    expect(report).toEqual([...pushed.errors, ...bare.errors]);
  });

  // The reserved name fails every graph push of the model, so its error prints
  // once above the model's profiles, and each other binding is still checked
  // as push checks it once the file is renamed.
  test('when a model has both default.yaml and a valid profile, reports the valid profile and inline errors without merging default.yaml', async () => {
    writeScope({
      'commerce.yaml': commerce().replace(
          'primary_key: [c_id]', 'primary_key: ["LOWER(c_id)"]'),
      'commerce.profiles/default.yaml': legacyProfile(true),
      'commerce.profiles/prod.yaml': legacyProfile(false),
    });
    const pushed = await pushResult('prod');
    expect(pushed.errors).toEqual(
        [expect.stringContaining("may not be named 'default'")]);
    expect(await pushResult()).toEqual(pushed);
    expect(await profiles()).toBe(1);
    const report = [...logs];
    fs.rmSync(path.join(
        dir, 'catalog', 'EntryGroups', 'commerce_eg', 'commerce.profiles',
        'default.yaml'));
    const prod = await pushResult('prod');
    const inline = await pushResult('default');
    expect(prod.errors).toEqual([expect.stringContaining(
        "(commerce, profile 'prod'): primary_key column 'LOWER(c_id)' is " +
        'not a physical column name')]);
    expect(inline.errors).toEqual([expect.stringContaining(
        "(commerce): primary_key column 'LOWER(c_id)' is not a physical " +
        'column name')]);
    expect(report).toEqual([
      "Model 'commerce' (commerce_eg):",
      '  push rejects:',
      `    ${pushed.errors[0]}`,
      "  profile 'prod'",
      '    target: (none)',
      '    sources:',
      '      customer -> bigquery.googleapis.com/projects/acme/datasets/prod/tables/customer',
      '      purchase -> bigquery.googleapis.com/projects/acme/datasets/dev/tables/purchase',
      '    cannot answer: nothing withheld.',
      '    push rejects:',
      `      ${prod.errors[0]}`,
      INLINE,
      '    push rejects:',
      `      ${inline.errors[0]}`,
    ]);
  });

  test('reports a SQL parser that cannot load', async () => {
    writeScope({'commerce.yaml': commerce({targets: 1})});
    spyOn(sqlParser, 'loadSqlEngine').mockRejectedValue(new Error('simulated'));
    expect(await profiles()).toBe(1);
    expect(errs).toContain('Error: the SQL parser could not be loaded: simulated');
  });

  // Push checks every named profile the model declares, whichever binding it
  // deploys.
  describe('push checks every named profile', () => {
    // `profile` with its prod tables on AlloyDB.
    const onAlloy = (profile: string) => profile.replaceAll(
        BQ('prod', ''),
        'alloydb.googleapis.com/projects/acme/locations/us/clusters/c/' +
            'databases/db/schemas/public/tables/');
    const STAGING = `name: staging\nentities:\n  - name: customer\n    source: ${
        BQ('staging', 'customer')}\n    primary_key: [c_id]\n` +
        '    fields: [{ name: c_id, expression: c_id }]\n';
    const incomplete = (file: string) => [
      `[${file}] profile 'staging': entity 'purchase' has no source in this ` +
          'profile',
      `[${file}] profile 'staging': relationship 'placed_by' has no join ` +
          "columns in this profile; a named profile states both " +
          "'from_columns' and 'to_columns' itself",
    ];

    // The report gives a profile's errors under that profile.
    test('when the push deploys another binding', async () => {
      writeScope({
        'commerce.yaml': commerce({targets: 1}),
        'commerce.profile.staging.yaml': STAGING,
      });
      const errors = incomplete('commerce.profile.staging.yaml');
      expect(await pushResult()).toEqual({code: 1, errors});
      expect(await profiles()).toBe(1);
      expect(rejects(profileSection('staging'))).toEqual(errors);
      expect(section(INLINE)).toEqual([]);
    });

    // The completeness check also requires each field a profile binds to hold
    // SQL on each entity that inherits it, as applying the profile does. A
    // plain push reports such a field once, in the words a push of the
    // profile gives, and the report gives it under the profile.
    test('when a profile file leaves an inherited field with no SQL', async () => {
      writeScope({
        'commerce.yaml': PARTIES,
        'commerce.profile.prod.yaml': partiesProfile(false),
      });
      const errors =
          [`[commerce.profile.prod.yaml] profile 'prod': ${NOTES_INHERITED}`];
      expect(await pushResult('prod')).toEqual({code: 1, errors});
      expect(await pushResult()).toEqual({code: 1, errors});
      expect(await profiles()).toBe(1);
      expect(rejects(profileSection('prod'))).toEqual(errors);
      expect(section(INLINE)).toEqual([]);
    });

    // The model file's customer restates each field it inherits whose
    // expression reads a column. Push reports a broken hierarchy alone.
    test('when the model file leaves a subtype reading its parent\'s column', async () => {
      const unrestated = PARTIES.replace(/ {8}fields: .*\n$/, '');
      writeScope({
        'commerce.yaml': unrestated,
        'commerce.profile.prod.yaml': partiesProfile(true),
      });
      const inherited = "entity 'customer' in model 'commerce' (commerce): " +
          "field 'id' is inherited from 'party', whose expression reads " +
          "column 'id' of that entity's table; restate it with an expression " +
          "for this entity's table.";
      expect(await pushResult('prod')).toEqual({code: 1, errors: [inherited]});
      await expectReport({default: [inherited], prod: []});
      expect(await pushResult({deployment: false})).toEqual({code: 1, errors: [inherited]});
      writeScope({'commerce.yaml': unrestated.replace('[party]', '[party, ghost]')});
      expect(await pushResult()).toEqual({code: 1, errors: [expect.stringContaining(
          "entity 'customer' extends unknown entity 'ghost'")]});
      // A customer the model file gives no table has nothing to restate there.
      writeScope({'commerce.yaml': unrestated.replace(/ {8}source: .*\n(?=.*\n$)/, '')});
      expect(await pushResult('prod')).toEqual({code: 0, errors: []});
      // An expression on an abstract party gets only the abstract error.
      writeScope({
        'commerce.yaml': unrestated.replace(/ {8}source: .*\n.*\n/, '        abstract: true\n'),
        'commerce.profile.prod.yaml':
            `name: prod\nentities:\n${prodEntity('customer', 'id')}    fields_exclude: [notes]\n`,
      });
      expect(await pushResult()).toEqual({code: 1, errors: [
        "entity 'party' in model 'commerce' (commerce) is abstract, so its field 'id' cannot " +
            'carry an expression; bind it on each concrete subtype instead.']});
    });

    // The model file's join columns do not stand in for a side a named
    // profile leaves out. A profile that states one side gets the
    // completeness error from a push of any binding, from `kcmd profiles`
    // under each binding, and from the runtime.
    test('when a profile states one side of a join', async () => {
      const oneSide = (columns: string) => profileFile('staging').replace(
          /relationships:[\s\S]*/,
          `relationships:\n  - {name: placed_by, ${columns}}\n`);
      const error = incomplete('commerce.profile.staging.yaml')[1];
      // With the model file's to_columns, two from_columns would be uneven.
      // With no join columns in the model file, one side would be half a
      // join. With the model file's from_columns, to_columns [c_id] alone
      // would complete the join.
      const cases: Array<[string, string]> = [
        [commerce(), 'from_columns: [p_customer, p_region]'],
        [commerce({joined: false}), 'to_columns: [c_id]'],
        [commerce(), 'to_columns: [c_id]'],
      ];
      for (const [model, columns] of cases) {
        writeScope({
          'commerce.yaml': model,
          'commerce.profile.staging.yaml': oneSide(columns),
        });
        const expected = {columns, code: 1, errors: [error]};
        expect({columns, ...await pushResult('staging')}).toEqual(expected);
        expect({columns, ...await pushResult()}).toEqual(expected);
        expect(await profiles()).toBe(1);
        expect(rejects(profileSection('staging'))).toEqual([error]);
        expect(section(INLINE)).toEqual([]);
        logs.length = 0;
        errs.length = 0;
        expect(await createSemanticRuntimes({profile: 'staging', ctx: CTX}))
            .toEqual({error});
      }
    });

    test('in the legacy profiles directory too', async () => {
      writeScope({
        'commerce.yaml': commerce(),
        'commerce.profiles/staging.yaml': STAGING,
      });
      const errors = incomplete('commerce.profiles/staging.yaml');
      expect(await pushResult()).toEqual({code: 1, errors});
      expect(await pushResult('staging')).toEqual({code: 1, errors});
      expect(await profiles()).toBe(1);
      expect(rejects(profileSection('staging'))).toEqual(errors);
    });

    // A push that selects a legacy wrapper checks the other profiles against
    // the model file loaded on its own.
    test('when the push selects a legacy wrapper', async () => {
      writeScope({
        'commerce.yaml': commerce(),
        'commerce.profiles/prod.yaml': legacyProfile(false),
        'commerce.profiles/staging.yaml': STAGING,
      });
      expect(await pushResult('prod')).toEqual(
          {code: 1, errors: incomplete('commerce.profiles/staging.yaml')});
    });

    // No profile file can apply to a model file that loads only with a legacy
    // wrapper merged in, so a push of the wrapper gives each profile file the
    // error a push that selects it gives.
    test('when the pushed wrapper completes the model file', async () => {
      writeScope({
        'commerce.yaml': commerce().replace('        to_columns: [c_id]\n', ''),
        'commerce.profiles/legacy.yaml': `semantic_model:
  - name: commerce
    relationships:
      - name: placed_by
        to_columns: [c_id]
`,
        'commerce.profiles/staging.yaml': profileFile('staging'),
      });
      const staging = await pushResult('staging');
      expect(staging).toEqual({
        code: 1,
        errors: [expect.stringContaining(
            "(under profile 'staging', the model file must load on its own")],
      });
      expect(await pushResult('legacy')).toEqual(staging);
    });

    // A profile file that does not load gives its own error there, as it
    // does beside a model file that loads on its own.
    test('and a profile file there that does not load gives its own error', async () => {
      writeScope({
        'commerce.yaml': commerce().replace('        to_columns: [c_id]\n', ''),
        'commerce.profiles/legacy.yaml': `semantic_model:
  - name: commerce
    relationships:
      - name: placed_by
        to_columns: [c_id]
`,
        'commerce.profiles/staging.yaml': 'name: staging\nbogus: 1\n',
      });
      const error = "[commerce.profiles/staging.yaml] profile 'staging' sets " +
          "'bogus', which a profile may not set; a profile carries only " +
          'physical bindings, and the logical model owns everything else';
      expect(await pushResult('legacy')).toEqual({code: 1, errors: [error]});
      expect(await profiles({profile: 'legacy'})).toBe(1);
      expect(rejects(profileSection('legacy'))).toEqual([error]);
      // The runtime gives the same error under the same profile.
      expect(await createSemanticRuntimes({profile: 'legacy', ctx: CTX}))
          .toEqual({error});
    });

    test('and reports a legacy profile file that does not parse', async () => {
      writeScope({
        'commerce.yaml': commerce(),
        'commerce.profiles/staging.yaml': 'name: [unterminated\n',
      });
      expect(await pushResult()).toEqual({
        code: 1,
        errors: [expect.stringContaining(
            "[commerce.profiles/staging.yaml] profile 'staging' does not parse")],
      });
    });

    // The rules push leaves out for the profile it applies still run on
    // every other profile.
    test('and checks every rule on a profile the push does not apply', async () => {
      writeScope({
        'commerce.yaml': commerce(),
        'commerce.profile.a.yaml': profileFile('a'),
        'commerce.profile.b.yaml': profileFile('b', 'LOWER(c_id)'),
      });
      expect(await pushResult('a')).toEqual({
        code: 1,
        errors: [
          "[commerce.profile.b.yaml] profile 'b': entity 'customer' key " +
              "column 'LOWER(c_id)' is not a physical column name",
        ],
      });
    });

    // leaf extends root directly and through mid, so it inherits mid's
    // binding of b, the one inheritance keeps. Profile prod excludes a on
    // leaf. Only the binding of b given here as `kept` reads a.
    describe('and reads the binding of an inherited field that inheritance keeps', () => {
      const scope = (rootB: string, midB: string) => ({
        'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: root
        source: ${BQ('dev', 'root')}
        primary_key: [r_id]
        fields:
          - { name: a, expression: col_a }
          - { name: b, expression: "${rootB}" }
      - name: mid
        extends: [root]
        source: ${BQ('dev', 'mid')}
        primary_key: [m_id]
        fields:
          - { name: a, expression: mid_a }
          - { name: b, expression: "${midB}" }
      - name: leaf
        extends: [root, mid]
        source: ${BQ('dev', 'leaf')}
        primary_key: [l_id]
        fields:
          - { name: a, expression: leaf_a }
`,
        'commerce.profile.prod.yaml': `name: prod\nentities:\n` +
            prodEntity('root', 'r_id', col('a', 'col_a')) +
            prodEntity('mid', 'm_id', col('a', 'mid_a')) +
            `${prodEntity('leaf', 'l_id')}    fields_exclude: [a]\n`,
      });

      test('when the kept binding reads the excluded field', async () => {
        writeScope(scope('1', 'mid.a + 1'));
        const errors = [
          "[commerce.profile.prod.yaml] profile 'prod': field 'leaf.b' " +
              "depends on 'leaf.a', which this profile excludes; exclude " +
              "'leaf.b' too, or rebind it",
        ];
        expect(await pushResult()).toEqual({code: 1, errors});
        expect(await pushResult('prod')).toEqual({code: 1, errors});
      });

      test('when only a nearer ancestor\'s binding reads it', async () => {
        writeScope(scope('root.a + 1', '1'));
        expect(await pushResult()).toEqual({code: 0, errors: []});
        expect(await pushResult('prod')).toEqual({code: 0, errors: []});
      });
    });

    // Profile b states a key of two columns for purchase, whose key in the
    // model file has one.
    test('and still pushes when they are complete', async () => {
      writeScope({
        'commerce.yaml': commerce({targets: 1}),
        'commerce.profile.a.yaml': profileFile('a'),
        'commerce.profile.b.yaml':
            profileFile('b').replace('[p_id]', '[p_id, p_line]'),
      });
      expect(await pushResult()).toEqual({code: 0, errors: []});
    });

    // An empty unique key counts as none, so a profile need not state unique
    // keys for purchase.
    test('and counts an empty unique key as none', async () => {
      writeScope({
        'commerce.yaml': commerce().replace(
            'primary_key: [p_id]', 'unique_keys: [[]]'),
        'commerce.profile.a.yaml': profileFile('a'),
      });
      for (const profile of [undefined, 'a']) {
        expect(await pushResult(profile)).toEqual({code: 0, errors: []});
      }
    });

    // Push warns about the SQL it cannot read in the model it deploys, so a
    // profile's check warns only about the SQL the profile writes.
    test('and warns once for each SQL text the parser cannot read', async () => {
      writeScope({
        'commerce.yaml': `${commerce()}    metrics:
      - name: bad
        entity: purchase
        expression: "SUM(purchase.p_id"
`,
        'commerce.profile.a.yaml': profileFile('a'),
        'commerce.profile.b.yaml': profileFile('b').replace(
            'expression: c_id }', 'expression: "LOWER(c_id" }'),
      });
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      expect(await pushResult()).toEqual({code: 0, errors: []});
      const unread = warn.mock.calls.map(c => String(c[0]))
                         .filter(w => w.includes('could not read'));
      expect(unread).toEqual([
        expect.stringContaining("profile 'b': kcmd could not read the SQL of " +
                                "field 'customer.c_id'"),
        expect.stringContaining("metric 'bad'"),
      ]);
    });

    // Push reads each dialect entry of the model file in its own dialect, as
    // the check of an AlloyDB profile reads the ALLOYDB one, so push alone
    // warns that it cannot read that entry.
    test('and warns once for a model file entry in another dialect that the parser cannot read', async () => {
      writeScope({
        'commerce.yaml': commerce().replace(
            '          - { name: c_id, expression: c_id }\n',
            '          - { name: c_id, expression: c_id }\n' +
                '          - name: c_name\n' +
                '            expression:\n' +
                '              dialects:\n' +
                '                - { dialect: BIGQUERY, expression: customer.c_id }\n' +
                '                - { dialect: ALLOYDB, expression: "LOWER(customer.c_id" }\n'),
        'commerce.profile.alloy.yaml': onAlloy(profileFile('alloy')),
      });
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      expect(await pushResult()).toEqual({code: 0, errors: []});
      const unread = warn.mock.calls.map(c => String(c[0]))
                         .filter(w => w.includes('could not read'));
      expect(unread).toEqual([
        expect.stringContaining(
            "field 'customer.c_name' in model 'commerce' (commerce): kcmd " +
            "could not read its 'ALLOYDB' SQL"),
      ]);
    });

    // Actions are out of scope for the preview, so a `sql` executor in the
    // model file still fails only a push that applies a profile.
    test('but leaves actions to a push that applies the profile', async () => {
      writeScope({
        'commerce.yaml': `${commerce()}    actions:
      - name: refund
        executor:
          sql:
            statements:
              - UPDATE purchase SET p_id = p_id WHERE p_id = @order
        parameters:
          - {name: order, type: Integer}
        affects:
          - {concept: purchase, operation: modify}
`,
        'commerce.profile.prod.yaml': profileFile('prod'),
      });
      expect(await pushResult()).toEqual({code: 0, errors: []});
      expect((await pushResult('prod')).errors).toEqual(
          [expect.stringContaining("declares a 'sql' executor")]);
    });

    // The comparison skips what push's key check or the completeness check
    // reports, and what push's key check may misread. It compares no join
    // until the hierarchy resolves.
    test('and reports each key and join problem at most once', async () => {
      const model = () => joinOnEmail(commerce());
      const unknown = (binding: string) =>
          `model 'commerce' (${binding}): entity 'customer' extends unknown ` +
          "entity 'nope'; it is not defined in the model. Checks that need " +
          'the resolved model are skipped until this is fixed.';
      const file = 'commerce.profile.staging.yaml';
      const cases: Array<
          [string, Record<string, string>, Record<string, string[]>]> = [
        ['the model file alone', {'commerce.yaml': model()},
         {default: [own('commerce', 'c_email')]}],
        ['a profile with no join, so push checks the model file\'s', {
          'commerce.yaml': model(),
          [file]: profileFile('staging').replace(/relationships:[\s\S]*/, ''),
        }, {
          model: [own('commerce', 'c_email')],
          staging: [incomplete(file)[1]],
        }],
        ['a legacy wrapper that excludes the key field', {
          'commerce.yaml': model(),
          'commerce.profiles/legacy.yaml': legacyProfile(true).replace(
              /source: .*/, 'fields_exclude: [c_id]'),
          'commerce.profiles/staging.yaml': profileFile('staging'),
        }, {legacy: [own("commerce, profile 'legacy'", 'c_email')]}],
        ['profile a\'s own join', {
          'commerce.yaml': commerce(),
          'commerce.profile.a.yaml': profileFile('a').replace(
              'to_columns: [c_id]', 'to_columns: ["`c_name`"]'),
        }, {model: [compared("profile 'a'", '`c_name`')], a: []}],
        ['an AlloyDB key field bound to "c_id", which push may misread', {
          'commerce.yaml': commerce()
              .replace('primary_key: [c_id]', 'primary_key: [c_key]')
              .replace('name: c_id,', 'name: c_key,'),
          'commerce.profile.x.yaml': onAlloy(profileFile('x', 'c_key')).replace(
              '{ name: c_id, expression: c_id }', '{ name: c_key, ' +
                  'expression: {dialects: [{dialect: ALLOYDB, expression: ' +
                  '\'"c_id"\'}]} }'),
        }, {x: []}],
        ['customer extends an unknown entity, so no join is compared', {
          'commerce.yaml': commerce().replace(
              'name: customer\n', 'name: customer\n        extends: [nope]\n'),
          'commerce.profile.a.yaml': profileFile('a'),
          'commerce.profile.b.yaml': joinOnEmail(profileFile('b')),
        }, {model: [unknown('commerce')], a: [], b: []}],
      ];
      for (const [label, files, pushes] of cases) {
        fs.rmSync(path.join(dir, 'catalog'), {recursive: true, force: true});
        writeScope(files);
        // A sibling profile file makes a plain push run in two phases.
        await (Object.keys(files).some(f => f.includes('.profile.')) ?
                   expectReport(pushes, label) :
                   expectPushes(pushes, label));
      }
    });

    // Actions are out of scope for the preview, so the actions of a profile
    // file the push does not apply are not read.
    test('and leaves the actions of a profile it does not apply unread', async () => {
      writeScope({
        'commerce.yaml': commerce(),
        'commerce.profile.a.yaml': profileFile('a') +
            'actions:\n  - name: refund\n    executor: {bogus: {}}\n',
      });
      expect(await pushResult()).toEqual({code: 0, errors: []});
      expect((await pushResult('a')).errors).toEqual(
          [expect.stringContaining("action 'refund'")]);
    });

    // Push reads the SQL of the profile it applies, so it never reads the
    // model file's text of a field that profile rebinds. Another profile's
    // check warns about that text.
    test('and warns about the model file SQL the applied profile replaces', async () => {
      writeScope({
        'commerce.yaml': commerce().replace(
            '          - { name: c_id, expression: c_id }\n',
            '          - { name: c_id, expression: c_id }\n' +
                '          - { name: c_code, expression: "LOWER(c_id" }\n'),
        'commerce.profile.a.yaml': profileFile('a').replace(
            'expression: c_id }', '$&, { name: c_code, expression: c_id }'),
        'commerce.profile.b.yaml': profileFile('b'),
      });
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      expect(await pushResult('a')).toEqual({code: 0, errors: []});
      const unread = warn.mock.calls.map(c => String(c[0]))
                         .filter(w => w.includes('could not read'));
      expect(unread).toEqual([
        expect.stringContaining("profile 'b': kcmd could not read the SQL of " +
                                "field 'customer.c_code'"),
      ]);
    });

    // Applying a profile that excludes a field an entity redeclares drops the
    // redeclaration, so push never reads the model file's text for it.
    test('and warns about the model file SQL of a redeclared field the applied profile excludes', async () => {
      writeScope({
        'commerce.yaml': `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: party
        abstract: true
        fields:
          - { name: id }
          - { name: code }
      - name: customer
        extends: [party]
        source: ${BQ('dev', 'customer')}
        primary_key: [c_id]
        fields:
          - { name: id, expression: c_id }
          - { name: code, expression: "LOWER(c_id" }
`,
        'commerce.profile.a.yaml': `name: a\nentities:\n${
            prodEntity('customer', 'c_id', col('id', 'c_id'))}    fields_exclude: [code]\n`,
        'commerce.profile.b.yaml':
            `name: b\nentities:\n${prodEntity('customer', 'c_id', col('id', 'c_id'))}`,
      });
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      expect(await pushResult('a')).toEqual({code: 0, errors: []});
      const unread = warn.mock.calls.map(c => String(c[0]))
                         .filter(w => w.includes('could not read'));
      expect(unread).toEqual([
        expect.stringContaining("profile 'b': kcmd could not read the SQL of " +
                                "field 'customer.code'"),
      ]);
    });

    // No push deploys a profile named 'default', and a graph push rejects
    // the file by name.
    test('but not a legacy file under the reserved name', async () => {
      writeScope({
        'commerce.yaml': commerce(),
        'commerce.profiles/default.yaml': 'name: default\n',
      });
      expect(await push({validateOnly: true, profile: false})).toBe(0);
      expect(errs).toEqual([]);
      expect(await profiles()).toBe(1);
      expect(errs.join('\n')).toContain("may not be named 'default'");
      expect(errs.join('\n')).not.toContain("profile 'default': entity");
    });

    // A --no-profile push publishes the catalog under default_profile, so it
    // refuses a reserved name there as a graph push does.
    test('and refuses a --no-profile push whose default_profile has the reserved name', async () => {
      writeScope(
          {
            'commerce.yaml': commerce(),
            'commerce.profiles/Default.yaml':
                STAGING.replace('name: staging', 'name: Default'),
          },
          'Default');
      const bare = await pushResult();
      expect(bare.errors).toEqual(
          [expect.stringContaining("may not be named 'default'")]);
      expect(await push({validateOnly: true, profile: false})).toBe(1);
      expect(errs).toEqual(bare.errors.map(e => `Error: ${e}`));
    });

    // A file with a `semantic_model` key is a legacy wrapper only when it
    // carries nothing but `version` and a `semantic_model` list. Any other is
    // no profile a push can apply.
    test('and reports a file that is neither a profile file nor a legacy wrapper', async () => {
      writeScope({
        'commerce.yaml': commerce(),
        'commerce.profile.staging.yaml': 'name: staging\nsemantic_model: []\n',
      });
      expect(await pushResult()).toEqual({
        code: 1,
        errors: [
          "[commerce.profile.staging.yaml] profile 'staging' is not a " +
              'profile file',
        ],
      });
      expect(await pushResult('staging')).toEqual({
        code: 1,
        errors: [
          "[commerce.profile.staging.yaml] profile 'staging': a " +
              "'semantic_model:' profile carries only 'version' and " +
              "'semantic_model', not 'name'",
        ],
      });
      fs.rmSync(path.join(
          dir, 'catalog', 'EntryGroups', 'commerce_eg',
          'commerce.profile.staging.yaml'));
      writeScope({'commerce.profiles/staging.yaml': 'semantic_model: null\n'});
      const errors =
          ["[commerce.profiles/staging.yaml] profile 'staging' is not a " +
           'profile file'];
      expect(await pushResult()).toEqual({code: 1, errors});
      expect(await pushResult('staging')).toEqual({code: 1, errors});
    });

    // A push that selects a file in neither profile form reads the file
    // without loading the model file, so the file's own error comes first.
    test('and reports a file in neither form beside a wrapper the model file needs', async () => {
      writeScope({
        'commerce.yaml': commerce().replace('        to_columns: [c_id]\n', ''),
        'commerce.profiles/legacy.yaml': `semantic_model:
  - name: commerce
    relationships:
      - name: placed_by
        to_columns: [c_id]
`,
        'commerce.profiles/staging.yaml': 'name: staging\nsemantic_model: []\n',
      });
      expect(await pushResult('legacy')).toEqual({
        code: 1,
        errors: [
          "[commerce.profiles/staging.yaml] profile 'staging' is not a " +
              'profile file',
        ],
      });
    });

    // Push prepares each binding --all-profiles names, and each one checks
    // every profile file.
    test('and warns once about a profile when a push prepares several bindings', async () => {
      const wrapper = (graph: string) => legacyProfile(true).replace(
          '/propertyGraphs/commerce', `/propertyGraphs/${graph}`);
      writeScope({
        'commerce.yaml': commerce(),
        'commerce.profiles/w1.yaml': wrapper('w1'),
        'commerce.profiles/w2.yaml': wrapper('w2'),
        'commerce.profiles/b.yaml': profileFile('b').replace(
            'expression: c_id }', 'expression: "LOWER(c_id" }'),
      });
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      expect(await push({validateOnly: true, allProfiles: true})).toBe(0);
      const unread = warn.mock.calls.map(c => String(c[0])).filter(
          w => w.includes("profile 'b': kcmd could not read"));
      expect(unread).toHaveLength(1);
    });

    // Under --no-kc, a model that deploys no graph is checked before any
    // graph deploys, so its profile errors leave every graph as it was.
    test('before any graph deploys, under --no-kc with two models', async () => {
      writeScope({
        'commerce.yaml':
            modelFile({google: {deploymentTargets: [`${GRAPH}_prod`]}}),
        'inventory.yaml': commerce().replace('name: commerce', 'name: inventory'),
        'inventory.profile.staging.yaml': STAGING,
      });
      const deploy = spyOn(bigQueryDeploy, 'deployBigQuery');
      expect(await push({validateOnly: true, kc: false, profile: 'default'}))
          .toBe(1);
      expect(deploy).not.toHaveBeenCalled();
      expect(logs).toEqual(expect.arrayContaining(
          incomplete('inventory.profile.staging.yaml').map(e => `Error: ${e}`)));
    });

    // A model in which customer and supplier extend the abstract party, and
    // supplier binds code. Unless `partner` is false, partner extends both.
    // `more` is added at the end.
    const parties = (more = '', partner = true) => `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: party
        abstract: true
        fields:
          - { name: code, datatype: String }
      - name: customer
        extends: [party]
        source: ${BQ('dev', 'customer')}
        primary_key: [c_id]
        fields:
          - { name: c_id, expression: c_id }
      - name: supplier
        extends: [party]
        source: ${BQ('dev', 'supplier')}
        primary_key: [s_id]
        fields:
          - { name: s_id, expression: s_id }
          - { name: code, expression: supplier.s_id }
${partner ? `      - name: partner
        extends: [customer, supplier]
        source: ${BQ('dev', 'partner')}
        primary_key: [p_id]
        fields:
          - { name: p_id, expression: p_id }
          - { name: c_id, expression: c_id }
          - { name: s_id, expression: s_id }
` : ''}${more}`;
    // Profile prod for parties: customer, which binds code itself, and supplier.
    const PARTIES_PROD = `name: prod\nentities:\n` +
        prodEntity('customer', 'c_id', col('c_id'), col('code', 'c_code')) +
        prodEntity('supplier', 's_id', col('s_id'));
    const PARTNER_PROD = prodEntity('partner', 'p_id', col('p_id'), col('c_id'), col('s_id'));

    // Push reports one broken hierarchy at a time. While the model file's
    // does not resolve, push reports that alone. The break a profile file
    // adds shows once the model file is fixed.
    test('and reports a profile that breaks the hierarchy once the model file resolves', async () => {
      const model = (shopExtends: string) => parties(`      - name: shop
${shopExtends}        source: ${BQ('dev', 'shop')}
        primary_key: [sh_id]
        fields:
          - { name: sh_id, expression: sh_id }
`);
      const prod = PARTIES_PROD + PARTNER_PROD + prodEntity('shop', 'sh_id', col('sh_id'));
      writeScope({
        'commerce.yaml': model('        extends: [ghost]\n'),
        'commerce.profile.prod.yaml': prod,
      });
      expect(await pushResult()).toEqual({
        code: 1,
        errors: [expect.stringContaining(
            "entity 'shop' extends unknown entity 'ghost'")],
      });
      writeScope({'commerce.yaml': model('')});
      expect(await pushResult()).toEqual({
        code: 1,
        errors: [expect.stringContaining(
            "[commerce.profile.prod.yaml] profile 'prod': entity 'partner' " +
            "inherits field 'code' from 'customer' and from 'supplier'")],
      });
    });

    // The error a profile file gets beside a model file that loads only with
    // a legacy wrapper merged in is about the model file. It names the
    // profile, as a push that selects the profile file does, and not the file.
    test('names the profile, not the file, when the model file needs the pushed wrapper', async () => {
      writeScope({
        'commerce.yaml': commerce().replace('        to_columns: [c_id]\n', ''),
        'commerce.profiles/legacy.yaml': `semantic_model:
  - name: commerce
    relationships:
      - name: placed_by
        to_columns: [c_id]
`,
        'commerce.profiles/staging.yaml': profileFile('staging'),
      });
      const {code, errors} = await pushResult('legacy');
      expect(code).toBe(1);
      expect(errors).toEqual([expect.stringMatching(
          /^Model document 'commerce': [^]*\(under profile 'staging', the model file must load on its own before the profile applies\)$/)]);
    });

    // --all-profiles --no-kc deploys each profile's graph and publishes
    // nothing, so a model that deploys no graph and does not declare the
    // default_profile is neither deployed nor checked.
    test('but not a model --all-profiles --no-kc neither deploys nor publishes', async () => {
      writeScope(
          {
            'commerce.yaml': commerce(),
            'commerce.profiles/w.yaml': legacyProfile(true),
            'inventory.yaml': commerce().replace('name: commerce', 'name: inventory'),
            'inventory.profile.staging.yaml': STAGING,
          },
          'w');
      expect(await push({validateOnly: true, allProfiles: true, kc: false}))
          .toBe(0);
      expect(errs).toEqual([]);
    });

    // A profile that binds an inherited field on two unrelated branches
    // breaks the hierarchy. The rest of the profile is still checked.
    test('and checks the rest of a profile that breaks the hierarchy', async () => {
      writeScope({'commerce.yaml': parties(), 'commerce.profile.prod.yaml': PARTIES_PROD});
      const conflict = "entity 'partner' inherits field 'code' from " +
          "'customer' and from 'supplier'";
      const noSource = "[commerce.profile.prod.yaml] profile 'prod': entity " +
          "'partner' has no source in this profile";
      const bare = await pushResult();
      expect(bare).toEqual({
        code: 1,
        errors: [
          expect.stringContaining(
              `[commerce.profile.prod.yaml] profile 'prod': ${conflict}`),
          noSource,
        ],
      });
      const prod = await pushResult('prod');
      expect(prod).toEqual({
        code: 1,
        errors: [
          noSource,
          expect.stringContaining(
              `model 'commerce' (commerce, profile 'prod'): ${conflict}`),
        ],
      });
      expect(await profiles()).toBe(1);
      expect(rejects(profileSection('prod'))).toEqual(bare.errors);
      expect(section(INLINE)).toEqual([]);
    });

    // #516's check that each inherited field holds SQL needs the whole
    // hierarchy. A profile that breaks it gets the hierarchy error, and the
    // inherited field is reported once the hierarchy resolves, by a push of
    // the profile and by every other push alike, once each.
    test('and reports an inherited field with no SQL once, after the hierarchy resolves', async () => {
      // Customer gains memo, and vip, which extends customer, follows it.
      const model = (partner: boolean) => parties('', partner).replace(
          '{ name: c_id, expression: c_id }\n',
          `$&          - { name: memo }\n      - name: vip\n        extends: [customer]\n` +
              `        source: ${BQ('dev', 'vip')}\n        primary_key: [c_id]\n` +
              '        fields:\n          - { name: c_id, expression: c_id }\n');
      const prod = (partner: boolean) => `name: prod\nentities:\n` +
          prodEntity('customer', 'c_id', col('c_id'), col('code', 'c_code'),
                     col('memo', '"customer.vip."')) +
          prodEntity('vip', 'c_id', col('c_id'), col('code', 'c_code')) +
          prodEntity('supplier', 's_id', col('s_id')) + (partner ? PARTNER_PROD : '');
      const inherited = "entity 'vip' inherits field 'memo': read on 'vip', " +
          "'expression' is only the qualifier 'vip.'; write the field's SQL";
      writeScope({'commerce.yaml': model(true), 'commerce.profile.prod.yaml': prod(true)});
      for (const profile of [undefined, 'prod']) {
        const {code, errors} = await pushResult(profile);
        expect({profile, code, errors: errors.filter(e => e.includes("'memo'"))})
            .toEqual({profile, code: 1, errors: []});
        expect({profile, conflict: errors.filter(e => e.includes(
                    "inherits field 'code' from 'customer' and from 'supplier'")).length})
            .toEqual({profile, conflict: 1});
      }
      writeScope({'commerce.yaml': model(false), 'commerce.profile.prod.yaml': prod(false)});
      const errors = [`[commerce.profile.prod.yaml] profile 'prod': ${inherited}`];
      expect(await pushResult('prod')).toEqual({code: 1, errors});
      expect(await pushResult()).toEqual({code: 1, errors});
      expect(await profiles()).toBe(1);
      expect(rejects(profileSection('prod'))).toEqual(errors);
      expect(section(INLINE)).toEqual([]);
    });

    // Push's own check of the SQL it reads stands down when the model file's
    // hierarchy does not resolve. The profile check then reads what the
    // fields of the profile push applies read, and warns about the SQL it
    // cannot read for every profile.
    test('and checks what push leaves out when the hierarchy does not resolve', async () => {
      writeScope({
        'commerce.yaml': `${commerce().replace(
            '      - name: customer\n',
            '      - name: customer\n        extends: [person]\n')}    metrics:
      - name: bad
        entity: purchase
        expression: "SUM(purchase.p_id"
`,
        'commerce.profile.a.yaml': profileFile('a').replace(
            'expression: c_id }', 'expression: purchase.p_id }'),
      });
      const reads = "[commerce.profile.a.yaml] profile 'a': field " +
          "'customer.c_id' reads entity 'purchase'; a field expression reads " +
          'only its own entity';
      const unknown = "entity 'customer' extends unknown entity 'person'";
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      const unread = () => warn.mock.calls.map(c => String(c[0]))
                               .filter(w => w.includes('could not read'));
      for (const profile of [undefined, 'a']) {
        warn.mockClear();
        expect(await pushResult(profile)).toEqual({
          code: 1,
          errors: [reads, expect.stringContaining(unknown)],
        });
        expect(unread()).toEqual([
          "Warning: [commerce.profile.a.yaml] profile 'a': kcmd could not " +
              "read the SQL of metric 'bad', so the fields it reads were " +
              'not checked',
        ]);
      }
    });

    // Push's translator reads Spanner (as BigQuery) and AlloyDB (as
    // PostgreSQL) SQL, so --transpile fills in a BigQuery entry for a BigQuery
    // profile.
    test('and under --transpile translates a metric written only in Spanner or AlloyDB SQL', async () => {
      for (const dialect of ['SPANNER', 'ALLOYDB']) {
        writeScope({
          'commerce.yaml': `${commerce()}    metrics:
      - name: spend
        entity: purchase
        expression:
          dialects:
            - { dialect: ${dialect}, expression: "SUM(purchase.p_id)" }
`,
          'commerce.profile.prod.yaml': profileFile('prod'),
        });
        errs.length = 0;
        expect(await push({validateOnly: true, transpile: true})).toBe(0);
        expect(errs).toEqual([]);
      }
    });

    // Under --transpile, push fills in BigQuery SQL for a text written only
    // in a vendor dialect, so a BigQuery profile can run it.
    test('and lets --transpile fill in a vendor-only metric for a BigQuery profile', async () => {
      writeScope({
        'commerce.yaml': `${commerce()}    metrics:
      - name: positive_spend
        entity: purchase
        expression:
          dialects:
            - { dialect: SNOWFLAKE, expression: "SUM(IFF(purchase.p_id > 0, purchase.p_id, 0))" }
`,
        'commerce.profile.prod.yaml': profileFile('prod'),
      });
      expect(await push({validateOnly: true, transpile: true})).toBe(0);
      expect(await push({validateOnly: true, profile: 'prod', transpile: true}))
          .toBe(0);
      expect(errs).toEqual([]);
      expect(await pushResult()).toEqual({
        code: 1,
        errors: [
          "[commerce.profile.prod.yaml] profile 'prod': metric " +
              "'positive_spend' has no expression for BIGQUERY or ANSI_SQL, " +
              "and this profile's sources are BIGQUERY; give it one, or add " +
              "it to 'metrics_exclude'",
        ],
      });
    });

    // Under --transpile, a BigQuery profile runs the text written only in a
    // vendor dialect, so the check reads what that text reads.
    test('and under --transpile reads what a vendor-only text reads', async () => {
      writeScope({
        'commerce.yaml': commerce().replace(
            '          - { name: p_id, expression: p_id }\n',
            '          - { name: p_id, expression: p_id }\n' +
                '          - { name: p_amount, expression: amount }\n' +
                '          - name: p_tax\n' +
                '            expression:\n' +
                '              dialects:\n' +
                '                - { dialect: SNOWFLAKE, expression: ' +
                '"IFF(purchase.p_amount > 0, purchase.p_amount, 0)" }\n') +
            `    metrics:
      - name: spend
        entity: purchase
        expression:
          dialects:
            - { dialect: SNOWFLAKE, expression: "SUM(purchase.p_amount)" }
`,
        'commerce.profile.prod.yaml': profileFile('prod').replace(
            `    source: ${BQ('prod', 'purchase')}\n`,
            `    source: ${BQ('prod', 'purchase')}\n` +
                '    fields_exclude: [p_amount]\n'),
      });
      const errors = [
        "[commerce.profile.prod.yaml] profile 'prod': field 'purchase.p_tax' " +
            "depends on 'purchase.p_amount', which this profile excludes; " +
            "exclude 'purchase.p_tax' too, or rebind it",
        "[commerce.profile.prod.yaml] profile 'prod': metric 'spend' reaches " +
            "'purchase.p_amount', which this profile excludes; add 'spend' " +
            "to 'metrics_exclude'",
      ].map(e => `Error: ${e}`);
      for (const profile of [undefined, 'prod']) {
        errs.length = 0;
        expect(await push({validateOnly: true, profile, transpile: true}))
            .toBe(1);
        expect(errs).toEqual(errors);
      }
    });

    // A profile file push cannot read gives one error, which names the file,
    // whichever binding the push deploys.
    test('and names the profile file in an error, whichever binding the push deploys', async () => {
      writeScope({
        'commerce.yaml': commerce(),
        'commerce.profile.prod.yaml':
            `version: "0.2.0.dev0/google"\n${profileFile('prod')}`,
      });
      const errors = [
        "[commerce.profile.prod.yaml] profile 'prod' sets 'version'; a " +
            'profile file takes its version from the model file beside it, ' +
            'so remove the line',
      ];
      expect(await pushResult()).toEqual({code: 1, errors});
      expect(await pushResult('prod')).toEqual({code: 1, errors});
      expect(await profiles()).toBe(1);
      expect(rejects(profileSection('prod'))).toEqual(errors);
      expect(section(INLINE)).toEqual([]);
    });

    // The checks of a profile the push does not apply read a source written
    // as a GCP resource name for its database and for its dialect.
    test('and reads a source written as a resource name for its database and dialect', async () => {
      const table = (db: string, name: string) =>
          `spanner.googleapis.com/projects/acme/instances/prod/databases/${
              db}/tables/${name}`;
      const ops = (customer: string, purchase: string) =>
          profileFile('ops')
              .replace(BQ('prod', 'customer'), customer)
              .replace(BQ('prod', 'purchase'), purchase);
      writeScope({
        'commerce.yaml': commerce(),
        'commerce.profile.ops.yaml': ops(
            table('commerce', 'Customer'), table('commerce', 'Purchase')),
      });
      expect(await pushResult()).toEqual({code: 0, errors: []});

      writeScope({
        'commerce.yaml': commerce(),
        'commerce.profile.ops.yaml': ops(
            table('commerce', 'Customer'), table('other', 'Purchase')),
      });
      expect(await pushResult()).toEqual({
        code: 1,
        errors: [
          "[commerce.profile.ops.yaml] profile 'ops' binds entities in more " +
              "than one database ('customer', 'purchase'); a profile reads " +
              'from one system a single query can reach',
        ],
      });

      writeScope({
        'commerce.profile.ops.yaml':
            ops(table('commerce', 'Customer'), table('commerce', 'Purchase'))
                .replace('{ name: c_id, expression: c_id }',
                         '{ name: c_id, expression: { dialects: [{ dialect: ' +
                             'BIGQUERY, expression: c_id }] } }'),
      });
      expect(await pushResult()).toEqual({
        code: 1,
        errors: [
          "[commerce.profile.ops.yaml] profile 'ops': field 'customer.c_id' " +
              "has no expression for SPANNER or ANSI_SQL, and this profile's " +
              'sources are SPANNER',
        ],
      });
    });

    // A source the loader's reader rejects names no database, so its
    // entity's fields are not held to the dialect of the profile's other
    // sources. Push reports the source alone here, as a push that selects
    // the profile does.
    test('and reports a source the reader rejects alone', async () => {
      const spanner = (name: string) =>
          'spanner.googleapis.com/projects/acme/instances/prod/databases/' +
          `commerce/tables/${name}`;
      for (const rejected of ['snowflake:acct.db.public.customer', 'acme.prod.customer']) {
        writeScope({
          'commerce.yaml': commerce(),
          'commerce.profile.ops.yaml':
              profileFile('ops')
                  .replace(BQ('prod', 'customer'), rejected)
                  .replace(BQ('prod', 'purchase'), spanner('Purchase'))
                  .replace('{ name: c_id, expression: c_id }',
                           '{ name: c_id, expression: { dialects: [{ dialect: ' +
                               'BIGQUERY, expression: c_id }] } }'),
        });
        const {code, errors} = await pushResult();
        expect({rejected, code, errors}).toEqual({
          rejected,
          code: 1,
          errors: [expect.stringContaining(
              "[commerce.profile.ops.yaml] profile 'ops': entity 'customer': ")],
        });
      }
    });

    // A vanilla model carries its profiles in a GOOGLE block. Push checks
    // each one as it checks a profile file, and an error names the model
    // document, since a block profile has no file of its own.
    describe('in a vanilla model\'s GOOGLE block', () => {
      // commerce() as a vanilla document named `name`, whose GOOGLE block
      // lists `profiles`.
      function vanilla(profiles: object[], name = 'commerce'): string {
        const sql = (column: string) =>
            `{dialects: [{dialect: ANSI_SQL, expression: ${column}}]}`;
        return `version: "0.2.0.dev0"
semantic_model:
  - name: ${name}
    custom_extensions:
      - vendor_name: GOOGLE
        data: '${JSON.stringify({profiles})}'
    datasets:
      - name: customer
        source: ${BQ('dev', 'customer')}
        primary_key: [c_id]
        fields:
          - name: c_id
            expression: ${sql('c_id')}
      - name: purchase
        source: ${BQ('dev', 'purchase')}
        primary_key: [p_id]
        fields:
          - name: p_id
            expression: ${sql('p_id')}
    relationships:
      - name: placed_by
        from: purchase
        to: customer
        from_columns: [p_customer]
        to_columns: [c_id]
`;
      }
      // A block profile that binds entity `name` to its table in `dataset`,
      // with the entity's key and key field.
      const bound = (name: string, key: string, dataset = 'prod') => ({
        name,
        source: BQ(dataset, name),
        primary_key: [key],
        fields: [{name: key, expression: key}],
      });
      // A block profile that binds both entities to the prod tables and the
      // join between them, as profileFile does.
      const complete = (name: string) => ({
        name,
        entities: [bound('customer', 'c_id'), bound('purchase', 'p_id')],
        relationships: [
          {name: 'placed_by', from_columns: ['p_customer'], to_columns: ['c_id']},
        ],
      });
      // A block profile that binds customer alone, as STAGING does.
      const staging = {
        name: 'staging',
        entities: [bound('customer', 'c_id', 'staging')],
      };

      test('fails a push when one leaves an entity without a source', async () => {
        writeScope({'commerce.yaml': vanilla([staging])});
        const errors = incomplete('commerce');
        expect(await pushResult()).toEqual({code: 1, errors});
        expect(await profiles()).toBe(1);
        expect(rejects(section(INLINE))).toEqual(errors);
      });

      test('still pushes when each is complete', async () => {
        writeScope({'commerce.yaml': vanilla([complete('a'), complete('b')])});
        for (const profile of [undefined, 'a', 'b']) {
          expect(await pushResult(profile)).toEqual({code: 0, errors: []});
        }
      });

      // The model file's error names the text to fix, so a block profile that
      // inherits the field unchanged gets no error of its own.
      test('reports a model file field with only a vendor text once', async () => {
        writeScope({
          'commerce.yaml': vanilla([complete('prod')]).replace(
              'expression: p_id}]}\n',
              p => `${p}          - ${amount('SNOWFLAKE', '"amount +"')}\n`),
        });
        const error = modelNoText('purchase.amount') + HINT;
        await expectPushes({default: [error], prod: [error]});
      });

      // Push's own checks cover part of the profile it applies, so the
      // selected block profile reports each problem once.
      test('reports each problem of the selected one once', async () => {
        writeScope({'commerce.yaml': vanilla([staging])});
        expect(await pushResult('staging'))
            .toEqual({code: 1, errors: incomplete('commerce')});
        expect(await profiles({profile: 'staging'})).toBe(1);
        expect(rejects(profileSection('staging')))
            .toEqual(incomplete('commerce'));

        // A source the reader rejects stops a push that selects the profile
        // before its checks run. A push of another binding gives the same
        // error.
        writeScope({
          'commerce.yaml': vanilla([{
            ...complete('prod'),
            entities: [
              {...bound('customer', 'c_id'), source: 'not a source'},
              bound('purchase', 'p_id'),
            ],
          }]),
        });
        const selected = await pushResult('prod');
        expect(selected).toEqual({
          code: 1,
          errors: [expect.stringContaining(
              "[commerce] profile 'prod': entity 'customer': source " +
              "'not a source'")],
        });
        expect(await pushResult()).toEqual(selected);
      });

      // Actions are out of scope for the preview, so push checks a block
      // profile's actions against the model only when it applies the profile,
      // as for a profile file. The load still reads their shape.
      test('leaves the actions of one it does not apply unchecked', async () => {
        writeScope({
          'commerce.yaml': vanilla(
              [{...complete('a'), actions: [{name: 'refund', executor: null}]}]),
        });
        expect(await pushResult()).toEqual({code: 0, errors: []});
        expect(await pushResult('a')).toEqual({
          code: 1,
          errors: ["[commerce] profile 'a': action 'refund' is not in the " +
                   'logical model'],
        });
      });

      // As for a profile file, the model file's join columns do not stand in
      // for a side the block profile leaves out.
      test('gives one that states one side of a join the completeness error', async () => {
        const error = incomplete('commerce')[1];
        for (const columns of [
          {from_columns: ['p_customer', 'p_region']},
          {to_columns: ['c_id']},
        ]) {
          writeScope({
            'commerce.yaml': vanilla([{
              ...complete('staging'),
              relationships: [{name: 'placed_by', ...columns}],
            }]),
          });
          const expected = {columns, code: 1, errors: [error]};
          expect({columns, ...await pushResult('staging')}).toEqual(expected);
          expect({columns, ...await pushResult()}).toEqual(expected);
          expect(await profiles()).toBe(1);
          expect(rejects(profileSection('staging'))).toEqual([error]);
          expect(rejects(section(INLINE))).toEqual([error]);
          logs.length = 0;
          errs.length = 0;
          expect(await createSemanticRuntimes({profile: 'staging', ctx: CTX}))
              .toEqual({error});
        }
      });

      test('checks one the push does not select', async () => {
        writeScope({'commerce.yaml': vanilla([complete('prod'), staging])});
        expect(await pushResult('prod'))
            .toEqual({code: 1, errors: incomplete('commerce')});
      });

      // Each model in a scope may declare its profiles in either form. A
      // problem is reported once, naming the file or the model document.
      test('checks one beside another model\'s profile file', async () => {
        const cases: Array<[string, object, string[]]> = [
          [profileFile('staging'), staging, incomplete('shop')],
          [
            STAGING, complete('staging'),
            incomplete('commerce.profile.staging.yaml'),
          ],
        ];
        for (const [file, block, expected] of cases) {
          writeScope({
            'commerce.yaml': commerce(),
            'commerce.profile.staging.yaml': file,
            'shop.yaml': vanilla([block], 'shop'),
          });
          logs.length = 0;
          expect(await push({validateOnly: true, kc: false, profile: 'default'}))
              .toBe(1);
          expect(logs.filter(l => l.startsWith('Error: ')))
              .toEqual(expected.map(e => `Error: ${e}`));
        }
      });
    });
  });

  // Push judges each deployment that names no profile on the model file as
  // loaded, and `kcmd profiles` reports what push rejects.
  describe('push holds each deployment to the rules of its engine', () => {
    const OWN = "model 'commerce' (commerce) deployment 'prod' uses the " +
        "model file's own bindings, ";
    const noDeployment = {deployment: false};
    // `model`, a commerce() text, with `fields` added to purchase after p_id.
    const withFields = (model: string, ...fields: string[]) => model.replace(
        '{ name: p_id, expression: p_id }\n',
        p => p + fields.map(f => `          - ${f}\n`).join(''));
    // commerce() with one deployment, `metric`, and `fields` on purchase.
    const withMetric = (metric: string, ...fields: string[]) =>
        `${withFields(commerce({targets: 1}), ...fields)}    metrics:\n` +
        `      - ${metric}\n`;

    // Each unbound entity or relationship is reported once. No warning prints.
    test('rejects a deployment that uses incomplete inline bindings, on every push', async () => {
      const unbound = (left = "entity 'customer' without a source") =>
          `${OWN}which leave ${left}; a deployment needs every entity and ` +
          'relationship bound.';
      writeScope({'commerce.yaml': customerUnbound(commerce({targets: 1}))});
      expect(await pushResult()).toEqual({code: 1, errors: [unbound()]});

      writeScope({'commerce.yaml': commerce({targets: 1, joined: false})});
      const unjoined = await pushResult();
      expect(unjoined).toEqual({
        code: 1,
        errors: [unbound("relationship 'placed_by' without join columns")],
      });
      expect(await profiles()).toBe(1);
      expect(rejects(section(NO_PROFILES))).toEqual(unjoined.errors);

      writeScope({
        'commerce.yaml': customerUnbound(commerce({targets: 1, joined: false})),
        'commerce.profile.prod.yaml': profileFile('prod'),
      });
      expect(await pushResult(noDeployment)).toEqual({
        code: 1,
        errors: [unbound("entity 'customer' without a source and " +
                         "relationship 'placed_by' without join columns")],
      });
      expect(console.warn).not.toHaveBeenCalled();
    });

    // A push that fails this check prints no pruning note. An AlloyDB
    // deployment reads a metric's ALLOYDB or ANSI_SQL text.
    test('rejects a deployment whose metric reads a field with no expression, as its engine reads the metric', async () => {
      // The error for `metric` reading `field`, which has no expression if
      // `direct` and otherwise reads a field with none.
      const reads = (metric: string, field: string, direct = true) =>
          `${OWN}under which metric '${metric}' reads field '${field}', which ${
              direct ? 'has no expression' :
                       'reads a field with no expression, directly or ' +
                           'through other fields'}; a deployment needs every ` +
          'field its metrics read bound.';
      writeScope({
        'commerce.yaml': withMetric(
            '{ name: notes, expression: "COUNT(purchase.note)" }',
            '{ name: note }'),
      });
      const warn = spyOn(console, 'warn').mockImplementation(() => {});
      const pushed = await pushResult();
      expect(warn.mock.calls.filter(c => c.join(' ').startsWith('Note:')))
          .toEqual([]);
      expect(pushed)
          .toEqual({code: 1, errors: [reads('notes', 'purchase.note')]});
      expect(await profiles()).toBe(1);
      expect(rejects(section(NO_PROFILES))).toEqual(pushed.errors);

      writeScope({
        'commerce.yaml': withMetric(
            '{ name: m, expression: "SUM(purchase.total)" }', '{ name: tax }',
            '{ name: net, expression: "purchase.tax + 1" }',
            '{ name: total, expression: "purchase.net * 2" }'),
      });
      expect(await pushResult())
          .toEqual({code: 1, errors: [reads('m', 'purchase.total', false)]});

      // The model on one AlloyDB database, where metric m's BigQuery and
      // AlloyDB texts each count a field of purchase.
      const db = 'alloydb.googleapis.com/projects/acme/locations/' +
          'us-central1/clusters/c/databases/commerce';
      const alloyDb = (bigQueryField: string, alloyDbField: string) =>
          withMetric(
              '{ name: m, expression: { dialects: [{ dialect: BIGQUERY, ' +
                  `expression: "COUNT(purchase.${bigQueryField})" }, ` +
                  '{ dialect: ALLOYDB, ' +
                  `expression: "COUNT(purchase.${alloyDbField})" }] } }`,
              '{ name: note }')
              .replace(`${GRAPH}_prod`, db)
              .replaceAll(BQ('dev', ''), `${db}/schemas/public/tables/`);
      writeScope({'commerce.yaml': alloyDb('note', 'p_id')});
      expect(await pushResult(noDeployment)).toEqual({code: 0, errors: []});
      writeScope({'commerce.yaml': alloyDb('p_id', 'note')});
      expect(await pushResult(noDeployment))
          .toEqual({code: 1, errors: [reads('m', 'purchase.note')]});
    });

    // Each entity's fields are judged by its own source, whether or not a
    // deployment uses them. Push's translator reads Snowflake SQL and no
    // Spanner SQL, so only a Snowflake text gets the --transpile hint, even
    // one the translator cannot parse.
    test('rejects a field with no text for its entity\'s source dialect, and suggests --transpile only when push can translate it', async () => {
      writeScope({
        'commerce.yaml': commerce()
            .replace(BQ('dev', 'purchase'), `${SPANNER_DB}/tables/purchase`)
            .replace('expression: p_id }', 'expression: { dialects: ' +
                     '[{ dialect: BIGQUERY, expression: p_id }] } }'),
      });
      const spanner = `${modelNoText('purchase.p_id', 'SPANNER')}.`;
      for (const opts of [{}, noDeployment]) {
        expect({opts, ...await pushResult(opts)})
            .toEqual({opts, code: 1, errors: [spanner]});
      }
      expect(await profiles()).toBe(1);
      expect(rejects(section(NO_PROFILES))).toEqual([spanner]);

      const missing = modelNoText('purchase.amount');
      for (const targets of [0, 1]) {
        for (const [dialect, text, errors, transpiledErrors] of [
               ['SNOWFLAKE', 'amount', [missing + HINT], []],
               ['SNOWFLAKE', '"amount +"', [missing + HINT], []],
               ['SPANNER', 'amount', [missing + HINT], []],
             ] as Array<[string, string, string[], string[]]>) {
          writeScope({
            'commerce.yaml':
                withFields(commerce({targets}), amount(dialect, text)),
          });
          const label = {targets, dialect, text};
          expect({...label, ...await pushResult()})
              .toEqual({...label, code: 1, errors});
          expect({...label, ...await pushResult({...noDeployment, transpile: true})})
              .toEqual({...label, code: transpiledErrors.length ? 1 : 0,
                        errors: transpiledErrors});
        }
      }
    });

    // A BigQuery graph turns each metric into a measure. A vanilla model
    // anchors a metric in its GOOGLE block.
    test('rejects a BigQuery metric that is not one aggregate, or on an entity with no key, on push and in the report', async () => {
      const MEASURE = "model 'commerce' (commerce) deployment 'prod' targets " +
          'BigQuery, where metric ';
      writeScope({
        'commerce.yaml':
            withMetric('{ name: half, expression: "SUM(purchase.p_id) / 2" }'),
      });
      const half = `${MEASURE}'half' cannot be a measure: it is not SUM, ` +
          'AVG, COUNT, MIN or MAX over one operand.';
      expect(await pushResult()).toEqual({code: 1, errors: [half]});
      expect(await profiles()).toBe(1);
      expect(rejects(section(NO_PROFILES))).toEqual([half]);
      const block = (data: object) =>
          `custom_extensions: [{vendor_name: GOOGLE, data: '${
              JSON.stringify(data)}'}]`;
      writeScope({
        'commerce.yaml': `version: "0.2.0.dev0"
semantic_model:
  - name: commerce
    ${block({deployments: [{name: 'prod', target: `${GRAPH}_prod`}]})}
    datasets:
      - name: purchase
        source: ${BQ('dev', 'purchase')}
        fields: [{name: p_id, expression: {dialects: [{dialect: ANSI_SQL, expression: p_id}]}}]
    metrics:
      - name: n
        ${block({entity: 'purchase'})}
        expression: {dialects: [{dialect: ANSI_SQL, expression: "COUNT(*)"}]}
`,
      });
      expect(await pushResult()).toEqual({
        code: 1,
        errors: [`${MEASURE}'n' cannot be a measure: it belongs to entity ` +
                 "'purchase', which has no primary key or unique key, so the " +
                 'graph has no node table for it.'],
      });
    });

    // Push warns and still pushes when the model file's own bindings are
    // incomplete and the model declares no deployment. `kcmd profiles` prints
    // the warning under the default binding, unless it reports another profile.
    test('warns about incomplete inline bindings when the model declares no deployment, on push and in the report', async () => {
      const warned: string[] = [];
      spyOn(console, 'warn').mockImplementation((m: any) => {
        warned.push(String(m));
      });
      // The warnings printed since the last call.
      const newWarnings = () => warned.splice(0);
      const left = "the model file leaves entity 'customer' without a source";
      const NON_EXECUTABLE = "model 'commerce' (commerce) is non-executable: " +
          `${left}, and the model declares no named profile. It cannot be ` +
          'queried until it is bound.';
      const NO_DEFAULT = "model 'commerce' (commerce) has an unbound " +
          `'default' profile: ${left}. It cannot be queried through 'default'.`;
      const reported = (w: string) => [`  profile 'default': warning: ${w}`];
      writeScope({'commerce.yaml': commerce()});
      expect(await pushResult()).toEqual({code: 0, errors: []});
      expect(await profiles()).toBe(0);
      expect(newWarnings()).toEqual([]);
      writeScope({'commerce.yaml': customerUnbound(commerce())});
      for (const opts of [{}, noDeployment]) {
        expect(await pushResult(opts)).toEqual({code: 0, errors: []});
        expect(newWarnings()).toEqual([`Warning: ${NON_EXECUTABLE}`]);
      }
      expect(await profiles()).toBe(0);
      expect(newWarnings()).toEqual(reported(NON_EXECUTABLE));
      writeScope({'commerce.profile.prod.yaml': profileFile('prod')});
      for (const opts of [undefined, 'prod', noDeployment]) {
        expect(await pushResult(opts)).toEqual({code: 0, errors: []});
        expect(newWarnings()).toEqual([`Warning: ${NO_DEFAULT}`]);
      }
      for (const profile of [undefined, 'default']) {
        expect(await profiles({profile})).toBe(0);
        expect(newWarnings()).toEqual(reported(NO_DEFAULT));
      }
      expect(await profiles({profile: 'prod'})).toBe(0);
      expect(newWarnings()).toEqual([]);

      // A deployment that names a profile gets no warning, in push or in the
      // report.
      writeScope({
        'commerce.yaml': customerUnbound(commerce({targets: 1}))
            .replace(/(target: \S+)\n/, '$1\n        profile: prod\n'),
      });
      expect(await pushResult()).toEqual({code: 0, errors: []});
      expect(await profiles()).toBe(0);
      expect(newWarnings()).toEqual([]);
    });

    // A named profile that keeps the field unchanged gets no error of its
    // own when push's own check names it. A profile that rebinds it or is on
    // another database, or whose field that check skips, keeps its own error.
    test('reports a model file field with only a vendor text once beside a named profile', async () => {
      // The error of profile 'prod' for field amount, with no text for the
      // `dialect` of its sources.
      const profileError = (dialect = 'BIGQUERY') =>
          "[commerce.profile.prod.yaml] profile 'prod': field " +
          `'purchase.amount' has no expression for ${dialect} or ANSI_SQL, ` +
          `and this profile's sources are ${dialect}`;
      const hinted = modelNoText('purchase.amount') + HINT;
      const spannerProfile = profileFile('prod').replaceAll(
          BQ('prod', ''), `${SPANNER_DB}/tables/`);
      // Profile prod rebinds purchase's amount to another SNOWFLAKE text.
      const rebound = profileFile('prod').replace(
          '{ name: p_id, expression: p_id }', `$&, ${amount('SNOWFLAKE', '"amount -"')}`);
      // The profile rebinds the parent's amount, and purchase keeps its own.
      const child = commerce().replace(
          '      - name: purchase\n',
          `      - name: item\n        source: ${BQ('dev', 'item')}\n` +
              '        primary_key: [i_id]\n        fields:\n' +
              '          - { name: amount, expression: amount }\n' +
              '      - name: purchase\n        extends: [item]\n');
      const childProfile = profileFile('prod').replace(
          '  - name: purchase\n',
          `  - name: item\n    source: ${BQ('prod', 'item')}\n` +
              '    primary_key: [i_id]\n    fields:\n' +
              '      - { name: amount, expression: amount2 }\n' +
              '  - name: purchase\n');
      const cases: Array<[label: string, model: string, profile: string,
                          errors: string[]]> = [
        ['inherited', commerce(), profileFile('prod'), [hinted]],
        ['rebound', commerce(), rebound, [profileError(), hinted]],
        ['on Spanner', commerce(), spannerProfile,
         [profileError('SPANNER'), hinted]],
        ['declared on the child, rebound on its parent', child, childProfile,
         [hinted]],
        ['no source in the model file',
         commerce().replace(`        source: ${BQ('dev', 'purchase')}\n`, ''),
         profileFile('prod'), [profileError()]],
      ];
      for (const [label, model, profile, errors] of cases) {
        writeScope({
          'commerce.yaml': withFields(model, amount('SNOWFLAKE', '"amount +"')),
          'commerce.profile.prod.yaml': profile,
        });
        for (const binding of [undefined, 'prod']) {
          expect({label, binding, ...await pushResult(binding)})
              .toEqual({label, binding, code: 1, errors});
        }
        // The report gives the model file's error under its own bindings.
        expect(await profiles()).toBe(1);
        expect({
          label,
          prod: rejects(profileSection('prod')),
          own: rejects(section(INLINE)),
        }).toEqual({
          label,
          prod: errors.filter(e => e !== hinted),
          own: errors.filter(e => e === hinted),
        });
      }
    });
  });
});

// `--print-store` is a read of the binding, never a choice of one: it prints
// where the selected profile deploys to and nothing else, so a setup script can
// address the same database the actions write to instead of naming it twice.
describe('kcmd profiles --print-store', () => {
  test('prints the selected profile\'s store on one line', async () => {
    writeWorkspace('operational');
    const code = await profiles({printStore: true});
    expect(code).toBe(0);
    expect(logs).toEqual(['acme-ops/prod/commerce']);
  });

  test('`--profile` is what picks which store is printed', async () => {
    writeWorkspace('operational');
    const code = await profiles({printStore: true, profile: 'analytical'});
    expect(code).toBe(0);
    expect(logs).toEqual(['bigquery:acme-analytics/sales']);
  });

  test('a profile file has no store, since it names no deployment target', async () => {
    fs.writeFileSync(path.join(dir, 'catalog.yaml'), catalogYaml(undefined));
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    // The model file names a target for its own bindings.
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - name: prod
        target: spanner.googleapis.com/projects/acme-ops/instances/prod/databases/commerce/graphs/commerce
    entities:
      - name: Customer
        source: spanner.googleapis.com/projects/acme-ops/instances/prod/databases/commerce/tables/Customer
        primary_key: [key]
        fields:
          - { name: key, expression: CustomerId }
`);
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'), `name: prod
entities:
  - name: Customer
    source: spanner.googleapis.com/projects/acme-ops/instances/prod/databases/commerce/tables/Customers
`);
    const code = await profiles({printStore: true, profile: 'prod'});
    expect(code).not.toBe(0);
    expect(logs.join('\n')).toContain(
        "binding profile 'prod' is a named profile, which names no deployment " +
        'target');
  });
});


describe('catalog.yaml default_profile round-trips', () => {
  test('load reads default_profile and save writes it back', async () => {
    const p = path.join(dir, 'catalog.yaml');
    fs.writeFileSync(p, catalogYaml('analytical'));
    const loaded = await CatalogManifest.load(p, CTX);
    expect(loaded.defaultProfile).toBe('analytical');

    const p2 = path.join(dir, 'catalog2.yaml');
    loaded.save(p2);
    const reloaded = await CatalogManifest.load(p2, CTX);
    expect(reloaded.defaultProfile).toBe('analytical');
  });

  test('a manifest without default_profile has none', async () => {
    const p = path.join(dir, 'catalog.yaml');
    fs.writeFileSync(p, catalogYaml(undefined));
    const loaded = await CatalogManifest.load(p, CTX);
    expect(loaded.defaultProfile).toBeUndefined();
  });
});


// A Cloud SQL table written as its resource name takes its dialect from its
// Knowledge Catalog entry. `kcmd profiles` and push look it up once, before
// anything loads, and check the model against that dialect.
describe('a profile that binds a Cloud SQL resource name', () => {
  const TABLE = 'cloudsql.googleapis.com/projects/acme/locations/us-central1/' +
      'instances/ms/databases/shop/schemas/sales/tables/orders';
  const MODEL = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Order
        source: bigquery.googleapis.com/projects/acme/datasets/sales/tables/orders
        primary_key: [key]
        fields:
          - { name: key, expression: o_key }
          - name: amount
            expression:
              dialects:
                - { dialect: BIGQUERY, expression: SAFE_CAST(o_amount AS NUMERIC) }
`;
  // Profile prod, which binds Order to TABLE. It states Order's key and
  // restates field key and each of `fields`.
  const profile = (...fields: string[]) =>
      `name: prod\nentities:\n  - name: Order\n    source: ${TABLE}\n` +
      `    primary_key: [o_key]\n    fields: [${
          ['{ name: key, expression: o_key }', ...fields].join(', ')}]\n`;
  function writeScope(): void {
    fs.writeFileSync(path.join(dir, 'catalog.yaml'), catalogYaml(undefined));
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), MODEL);
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'), profile());
  }

  test('is checked against the dialect its catalog entry gives', async () => {
    writeScope();
    const lookup = stubCloudSqlEntry(200, 'cloudsql-sqlserver-table');
    // A push in two phases refuses --no-kc before it looks anything up.
    expect(await push({deployment: false, kc: false})).toBe(1);
    expect(lookup).not.toHaveBeenCalled();
    expect(await profiles({profile: 'prod'})).toBe(1);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup.mock.calls[0]).toEqual([
      'acme', 'us-central1',
      `projects/acme/locations/us-central1/entryGroups/@cloudsql/entries/${TABLE}`,
    ]);
    expect(logs.join('\n'))
        .toContain("field 'Order.amount' has no expression for SQLSERVER or ANSI_SQL");
    // So does a push in two phases, for the profile and then the model file.
    errs = [];
    expect(await push({validateOnly: true, deployment: false})).toBe(1);
    expect(errs.join('\n')).toContain("this profile's sources are SQLSERVER");
    fs.writeFileSync(
        path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg', 'commerce.yaml'),
        MODEL.replace(/source: .*\n/, `source: ${TABLE}\n`));
    errs = [];
    expect(await push({validateOnly: true, deployment: false})).toBe(1);
    expect(errs.join('\n')).toContain(
        "the model file binds entity 'Order' to a SQLSERVER source");
    // Push applies the profile with the dialect too, so it reads a bracketed
    // T-SQL metric, whose names resolve the metric's entity.
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.writeFileSync(
        path.join(eg, 'commerce.yaml'),
        MODEL.replace('BIGQUERY, expression: SAFE_CAST(o_amount AS NUMERIC)',
                      'ANSI_SQL, expression: o_amount') +
            `    metrics:
      - name: revenue
        expression:
          dialects:
            - { dialect: ANSI_SQL, expression: "SUM([Order].[amount])" }
`);
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'),
                     profile('{ name: amount, expression: o_amount }'));
    // Push checks that the file-copy type exists; that lookup passes.
    spyOn(CatalogClient.prototype, 'getEntryType')
        .mockResolvedValue({status: 200, result: {}} as any);
    spyOn(CatalogClient.prototype, 'getAspectType')
        .mockResolvedValue({status: 200, result: {}} as any);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    expect(await push({profile: 'prod', validateOnly: true} as any)).toBe(0);
    expect(warnSpy.mock.calls.flat().join('\n')).not.toContain("metric 'revenue'");
  });

  // The report reads each field in the profile's dialect. Under SQLSERVER the
  // DATABRICKS text of `net`, the only one that reads the unbound `discount`,
  // is not evaluated, so `net` is not withheld. Without the lookup every text
  // counts and it would be.
  // The same holds for a profile written as a legacy wrapper, which the report
  // loads itself.
  test('the report reads each field in the dialect its catalog entry gives', async () => {
    stubCloudSqlEntry(200, 'cloudsql-sqlserver-table');
    const profileFiles: Record<string, string> = {
      'commerce.profile.prod.yaml':
          `name: prod\nentities:\n  - name: Order\n    source: ${TABLE}\n`,
      'commerce.profiles/prod.yaml':
          `semantic_model:\n  - name: commerce\n    entities:\n` +
          `      - name: Order\n        source: ${TABLE}\n`,
    };
    for (const [file, text] of Object.entries(profileFiles)) {
      fs.rmSync(path.join(dir, 'catalog'), {recursive: true, force: true});
      logs = [];
      fs.writeFileSync(path.join(dir, 'catalog.yaml'), catalogYaml(undefined));
      const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
      fs.mkdirSync(path.join(eg, 'commerce.profiles'), {recursive: true});
      fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    entities:
      - name: Order
        source: bigquery.googleapis.com/projects/acme/datasets/sales/tables/orders
        primary_key: [key]
        fields:
          - { name: key, expression: o_key }
          - { name: discount }
          - name: net
            expression:
              dialects:
                - { dialect: BIGQUERY, expression: o_net }
                - { dialect: DATABRICKS, expression: o_amount - Order.discount }
`);
      fs.writeFileSync(path.join(eg, file), text);
      await profiles({profile: 'prod'});
      expect(logs.join('\n')).toContain('field Order.discount (unbound)');
      expect(logs.join('\n')).not.toContain('field Order.net (reads Order.discount');
    }
  });

  // A model file whose own source is a Cloud SQL table is read in that table's
  // dialect too: its ANSI_SQL metric is parsed as T-SQL, so its bracketed
  // names resolve the metric's entity, which a BigQuery graph push needs.
  test('the inline bindings are read in the dialect its catalog entry gives', async () => {
    fs.writeFileSync(path.join(dir, 'catalog.yaml'), catalogYaml(undefined));
    const eg = path.join(dir, 'catalog', 'EntryGroups', 'commerce_eg');
    fs.mkdirSync(eg, {recursive: true});
    fs.writeFileSync(path.join(eg, 'commerce.yaml'), `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployments:
      - {name: default, target: bigquery.googleapis.com/projects/acme/datasets/sales/propertyGraphs/g}
    entities:
      - name: Order
        source: ${TABLE}
        primary_key: [key]
        fields:
          - { name: key, expression: o_key }
          - { name: amount, expression: {dialects: [{dialect: ANSI_SQL, expression: o_amount}]} }
    metrics:
      - name: revenue
        expression:
          dialects:
            - { dialect: ANSI_SQL, expression: "SUM([Order].[amount])" }
`);
    stubCloudSqlEntry(200, 'cloudsql-sqlserver-table');
    await profiles({});
    expect(logs.join('\n')).not.toContain("metric 'revenue'");
  });

  test('stops kcmd profiles and push when its entry cannot be read', async () => {
    writeScope();
    stubCloudSqlEntry(403);
    const dataplex = "Turn on Dataplex integration for instance 'ms' (gcloud sql " +
        'instances patch ms --enable-dataplex-integration --project acme)';
    expect(await profiles({profile: 'prod'})).toBe(1);
    expect(errs.join('\n')).toContain(dataplex);
    errs = [];
    expect(await push({profile: 'prod', validateOnly: true} as any)).toBe(1);
    expect(errs.join('\n')).toContain(dataplex);
  });
});
