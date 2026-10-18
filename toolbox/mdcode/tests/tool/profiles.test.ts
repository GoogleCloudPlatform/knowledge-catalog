// Tests for `kcmd profiles` (src/tool/commands.ts, profiles()) and the
// catalog.yaml `default_profile` it reads (src/libts/manifest.ts). The command
// is read-only -- it applies and prunes each profile the way push does but
// deploys nothing and makes no network call -- so it runs in a temp working
// directory with a pinned context, mirroring init_semantic_model.test.ts.

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
    deployment_target: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/propertyGraphs/commerce
    entities:
      - name: Customer
        source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/customer
        fields:
          - { name: key, expression: c_custkey }
          - { name: lifetimeValue, expression: c_ltv }
          - { name: availableCredit }
      - name: Order
        source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/orders
        fields:
          - { name: key, expression: o_orderkey }
`;

const OPERATIONAL = `version: "0.2.0.dev0/google"
semantic_model:
  - name: commerce
    deployment_target: //spanner.googleapis.com/projects/acme-ops/instances/prod/databases/commerce/propertyGraphs/commerce
    entities:
      - name: Customer
        source: //spanner.googleapis.com/projects/acme-ops/instances/prod/databases/commerce/tables/Customer
        fields:
          - { name: key, expression: CustomerId }
          - { name: availableCredit, expression: AvailableCredit }
          - { name: lifetimeValue }
      - name: Order
        source: //spanner.googleapis.com/projects/acme-ops/instances/prod/databases/commerce/tables/Orders
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
  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  spyOn(console, 'log').mockImplementation((...a: any[]) => {
    logs.push(a.join(' '));
  });
  spyOn(console, 'error').mockImplementation((...a: any[]) => {
    logs.push(a.join(' '));
    errs.push(a.join(' '));
  });
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
        source: //bigquery.googleapis.com/projects/acme/datasets/sales/tables/customer
        primary_key: [key]
        fields:
          - name: key
            expression: {dialects: [{dialect: ANSI_SQL, expression: c_key}]}
`);
    fs.writeFileSync(path.join(eg, 'commerce.profiles', 'prod.yaml'), `name: prod
entities:
  - name: Customer
    source: //bigquery.googleapis.com/projects/acme/datasets/prod/tables/customer
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
  const BQ = (t: string) => `//bigquery.googleapis.com/projects/acme/datasets/sales/tables/${t}`;

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
    // A profile that cannot be applied fails the command. The model file's
    // error is reported under each profile, as push words it for that
    // profile, and under the inline bindings, which push loads alone too.
    expect(await profiles()).toBe(1);
    const out = logs.join('\n');
    expect(out).toContain(
        "relationship 'placed_by': from_columns and to_columns must be given " +
        'together');
    expect(out.split("Model document 'commerce'").length - 1).toBe(3);
    for (const name of ['prod', 'staging']) {
      expect(out).toContain(
          `(under profile '${name}', the model file must load on its own ` +
          'before the profile applies)');
    }
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

  test('the runtime names the document of a profile that cannot apply', async () => {
    writeModel(LOGICAL, 'name: prod\nentities:\n  - name: Ghost\n');
    const runtimes = await createSemanticRuntimes(
        {path: dir, profile: 'prod', ctx: CTX, onWarning: () => {}});
    expect('error' in runtimes && runtimes.error)
        .toBe("[commerce] profile 'prod': entity 'Ghost' is not in the logical model");
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
        source: //bigquery.googleapis.com/projects/acme/datasets/sales/tables/customer
      - name: Order
        source: //bigquery.googleapis.com/projects/acme/datasets/sales/tables/orders
`);
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
    expect(await profiles()).toBe(0);
    expect(warnSpy.mock.calls.map(c => String(c[0])).join('\n'))
        .toContain("profile 'legacy': warning: [commerce] dataset 'Order': no primary_key");
  });

  // A catalog-only push needs no source, so `kcmd profiles` shows the entity
  // unbound and passes it.
  test('a concrete entity with a source in neither file passes beside a model with no graph target', async () => {
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
    fields:
      - { name: key, expression: cust_key }
`);
    expect(await profiles()).toBe(0);
    expect(logs).toContain('      Customer -> (unbound)');
    expect(logs.join('\n')).not.toContain('has no source');
    // Push checks that the file-copy type exists; that lookup passes.
    spyOn(CatalogClient.prototype, 'getEntryType')
        .mockResolvedValue({status: 200, result: {}} as any);
    spyOn(CatalogClient.prototype, 'getAspectType')
        .mockResolvedValue({status: 200, result: {}} as any);
    expect(await push({validateOnly: true, profile: 'prod'})).toBe(0);
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
    source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/customer
    fields:
      - { name: key, expression: c_custkey }
      - { name: lifetimeValue, expression: c_ltv }
    fields_exclude: [availableCredit]
  - name: Order
    source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/orders
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
    source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/customer
    fields:
      - { name: key, expression: c_custkey }
      - { name: lifetimeValue, expression: c_ltv }
    fields_exclude: [availableCredit]
  - name: Order
    source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/orders
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
        `//bigquery.googleapis.com/projects/acme/datasets/raw/tables/${t}`;
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
    source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/customer
    fields:
      - { name: key, expression: c_custkey }
      - { name: lifetimeValue, expression: c_ltv }
    fields_exclude: [availableCredit]
  - name: Order
    source: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/tables/orders
    fields:
      - { name: key, expression: o_orderkey }
`);
    expect(await profiles()).toBe(0);
    const out = logs.join('\n');
    expect(out).toContain("profile 'analytical'");
    expect(out).toContain(
        'target: (none; no deployment names this profile)');
    expect(out).toContain('Customer -> acme-analytics.sales.customer');
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
            'target: //bigquery.googleapis.com/projects/acme-analytics/datasets/sales/propertyGraphs/commerce');
        expect(out).toContain('Customer -> acme-analytics.sales.customer');
        expect(out).toContain(
            'Customer -> //spanner.googleapis.com/projects/acme-ops/instances/prod/databases/commerce/tables/Customer');

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
        source: //bigquery.googleapis.com/projects/acme/datasets/dev/tables/orders
        primary_key: [id]
        fields:
          - { name: id, expression: o_id }
`);
        fs.writeFileSync(
            path.join(eg, 'orders.profiles', 'prod.yaml'),
            `version: "0.2.0.dev0/google"
semantic_model:
  - name: orders_model
    deployment_target: //bigquery.googleapis.com/projects/acme/datasets/prod/propertyGraphs/orders_model
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
      `//bigquery.googleapis.com/projects/acme/datasets/${dataset}/tables/${table}`;
  const GRAPH =
      '//bigquery.googleapis.com/projects/acme/datasets/prod/propertyGraphs/commerce';
  const SPANNER_DB =
      '//spanner.googleapis.com/projects/acme/instances/prod/databases/commerce';
  const INLINE = "  profile 'default': the model document's own inline " +
      'bindings, as authored -- nothing merged, nothing withheld.';
  const NO_PROFILES = "  no binding profiles; the model document is its own " +
      "inline 'default' binding.";

  // Purchases join customers on the customer's key, c_id. `targets` is how
  // many graph deployments the model declares, of which a graph push takes
  // exactly one. `joined: false` leaves the join without columns, which push
  // rejects for a model with a graph target.
  function commerce({targets = 0, joined = true} = {}): string {
    const deployments = ['prod', 'qa'].slice(0, targets).map(
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

  // A profile file that binds customer to the prod table with key `key`.
  function profileFile(name: string, key = 'c_id'): string {
    return `name: ${name}
entities:
  - name: customer
    source: ${BQ('prod', 'customer')}
    primary_key: ["${key}"]
`;
  }

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

  // The exit code of `kcmd push --validate-only` for `profile`, or for the
  // default binding with no profile, and the errors it prints. An error push
  // throws counts as one, as the command line prints it and exits 1.
  async function pushResult(profile?: string):
      Promise<{code: number; errors: string[]}> {
    logs.length = 0;
    let code: number;
    const thrown: string[] = [];
    try {
      code = await push({validateOnly: true, profile});
    } catch (err: any) {
      code = 1;
      thrown.push(err.message);
    }
    const leg = /^Error pushing semantic model to [^:]*: /;
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

  beforeEach(() => {
    // Push probes BigQuery before it generates a graph; that probe passes.
    spyOn(BigQueryClient.prototype, 'query')
        .mockResolvedValue({status: 200, result: {}});
    // Push checks that the file-copy type exists; that lookup passes.
    spyOn(CatalogClient.prototype, 'getEntryType')
        .mockResolvedValue({status: 200, result: {}} as any);
    spyOn(CatalogClient.prototype, 'getAspectType')
        .mockResolvedValue({status: 200, result: {}} as any);
    spyOn(console, 'warn').mockImplementation(() => {});
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
      '      customer -> acme.prod.customer',
      '      purchase -> acme.dev.purchase',
      '    cannot answer: nothing withheld.',
    ]);
  });

  // Push accepts each of these profiles, so `kcmd profiles` must too.
  const accepted: Array<[string, Record<string, string>]> = [
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
`;
  const partiesProfile = (exclude: boolean) => `name: prod
entities:
  - name: party
    source: ${BQ('prod', 'party')}
    fields:
      - { name: notes, expression: "party.customer." }
  - name: customer
    source: ${BQ('prod', 'customer')}
${exclude ? '    fields_exclude: [notes]\n' : ''}`;
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
    expect(profileSection('prod')).toContain('      customer -> acme.prod.customer');
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
      expect(profileSection('prod')).toContain('      customer -> acme.prod.customer');
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
      'a profile file sits beside a model file with a graph deployment',
      {
        'commerce.yaml': commerce({targets: 1}),
        'commerce.profile.prod.yaml': profileFile('prod'),
      },
    ],
    [
      'the model file\'s deployment names the profile',
      {
        'commerce.yaml': commerce({targets: 1})
                             .replace(/(target: \S+)\n/, '$1\n        profile: prod\n'),
        'commerce.profile.prod.yaml': profileFile('prod'),
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
  for (const [label, files] of rejected) {
    test(`prints only push's errors under the profile when ${label}`, async () => {
      writeScope(files);
      const pushed = await pushResult('prod');
      expect(pushed.code).toBe(1);
      expect(pushed.errors).not.toEqual([]);
      expect(await profiles()).toBe(1);
      expect(rejects(profileSection('prod'))).toEqual(pushed.errors);
    });
  }

  // Push refuses a deployment that names a profile. The report has no check
  // of its own for it: it shows push's refusal under each binding push
  // refuses.
  test('shows push\'s refusal of a deployment that names a profile under each binding', async () => {
    writeScope({
      'commerce.yaml': commerce({targets: 1})
                           .replace(/(target: \S+)\n/, '$1\n        profile: prod\n'),
      'commerce.profiles/prod.yaml': legacyProfile(false),
    });
    const refusal = "[commerce] model 'commerce': deployment 'prod' names " +
        "profile 'prod'; remove 'profile' from the deployment entry so it " +
        "uses the model file's own bindings.";
    expect(await pushResult('prod')).toEqual({code: 1, errors: [refusal]});
    expect(await pushResult()).toEqual({code: 1, errors: [refusal]});
    expect(await profiles()).toBe(1);
    expect(rejects(profileSection('prod'))).toEqual([refusal]);
    expect(rejects(section(INLINE))).toEqual([refusal]);
  });

  test('prints push\'s errors at the profile\'s indent, under a heading', async () => {
    writeScope({
      'commerce.yaml': commerce(),
      'commerce.profile.prod.yaml': profileFile('prod', 'LOWER(c_id)'),
    });
    const pushed = await pushResult('prod');
    expect(pushed.errors).toHaveLength(1);
    expect(await profiles()).toBe(1);
    expect(logs).toEqual([
      "Model 'commerce' (commerce_eg):",
      "  profile 'prod'",
      '    target: (none; no deployment names this profile)',
      '    sources:',
      '      customer -> acme.prod.customer',
      '      purchase -> acme.dev.purchase',
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
      '      customer -> acme.prod.customer',
      '      purchase -> acme.dev.purchase',
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
    const a = (await pushResult('a')).errors;
    const b = (await pushResult('b')).errors;
    expect(a).not.toEqual([]);
    expect(b).not.toEqual([]);
    expect(await profiles()).toBe(1);
    expect(rejects(profileSection('a'))).toEqual(a);
    expect(rejects(profileSection('b'))).toEqual(b);
  });

  // Two deployments fail a graph push only, so this also shows the inline
  // bindings get the checks of the push that deploys them.
  test('prints push\'s errors for the inline bindings', async () => {
    writeScope({'commerce.yaml': commerce({targets: 2})});
    const pushed = await pushResult();
    expect(pushed.errors).toEqual(
        [expect.stringContaining('declares 2 deployments')]);
    expect(await profiles()).toBe(1);
    expect(logs).toEqual([
      "Model 'commerce' (commerce_eg):",
      NO_PROFILES,
      '    push rejects:',
      `      ${pushed.errors[0]}`,
    ]);
    logs.length = 0;
    expect(await profiles({profile: 'default'})).toBe(1);
    expect(logs).toEqual([
      "Model 'commerce' (commerce_eg):",
      INLINE,
      '    push rejects:',
      `      ${pushed.errors[0]}`,
    ]);
  });

  // Push generates each graph's DDL offline, and a generator can fail.
  const ungenerated: Array<[string, string]> = [
    ['BigQuery', uniqueKeysOnly(commerce({targets: 1}))],
    [
      'Spanner',
      uniqueKeysOnly(commerce({targets: 1}))
          .replace(`${GRAPH}_prod`, `${SPANNER_DB}/propertyGraphs/commerce`)
          .replaceAll(BQ('dev', ''), `${SPANNER_DB}/tables/`),
    ],
  ];
  for (const [system, model] of ungenerated) {
    test(`prints the error generating a ${system} graph gives`, async () => {
      writeScope({'commerce.yaml': model});
      const pushed = await pushResult();
      expect(pushed.errors).toEqual(
          [expect.stringContaining('cannot generate a property graph')]);
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
    expect(pushed).toEqual({code: 1, errors: ['simulated generator failure']});
    expect(await profiles()).toBe(1);
    expect(rejects(section(NO_PROFILES))).toEqual(pushed.errors);
  });

  // `kcmd push --profile default`, and a bare push when no `default_profile`
  // is set, deploy the inline bindings beside the profile files.
  for (const defaultProfile of [undefined, 'prod']) {
    test(`checks the inline bindings beside a profile file${
             defaultProfile ? ' when default_profile is set' : ''}`,
         async () => {
           writeScope(
               {
                 'commerce.yaml':
                     commerce().replace('to_columns: [c_id]', 'to_columns: [c_email]'),
                 'commerce.profile.prod.yaml':
                     'name: prod\nrelationships:\n  - name: placed_by\n    to_columns: [c_id]\n',
               },
               defaultProfile);
           expect(await pushResult('prod')).toEqual({code: 0, errors: []});
           const pushed = await pushResult('default');
           expect(pushed.errors).not.toEqual([]);
           expect(await profiles()).toBe(1);
           expect(errs.some(l => l.includes("profile 'prod'"))).toBe(false);
           expect(rejects(section(INLINE))).toEqual(pushed.errors);
         });
  }

  // A push that names no profile deploys `default_profile`, so it fails when
  // the model does not declare that profile. A push that names a profile does
  // not read `default_profile`.
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
    expect(await pushResult('prod')).toEqual({code: 0, errors: []});
    expect(await profiles()).toBe(1);
    expect(logs[1]).toBe('  push rejects:');
    expect(rejects(logs, '  ')).toEqual(pushed.errors);
    expect(rejects(profileSection('prod'))).toEqual([]);
    logs.length = 0;
    errs.length = 0;
    expect(await profiles({profile: 'prod'})).toBe(0);
    expect(errs).toEqual([]);
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

  test('prints push\'s error for a scope with two models once', async () => {
    writeScope({
      'commerce.yaml': commerce(),
      'shop.yaml': commerce().replace('name: commerce', 'name: shop'),
    });
    const pushed = await pushResult();
    expect(pushed.errors).toEqual(
        [expect.stringContaining('would receive 2 models')]);
    expect(await profiles()).toBe(1);
    expect(rejects(logs, '')).toEqual(pushed.errors);
    expect(logs.filter(l => l.includes('would receive 2 models')))
        .toHaveLength(1);
  });

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

  // Push skips the copies when the scope holds more than one model document.
  test('prints only the one-model error for two models and a file over the size limit', async () => {
    writeScope({
      'commerce.yaml': `# ${'x'.repeat(130 * 1024)}\n${commerce()}`,
      'shop.yaml': commerce().replace('name: commerce', 'name: shop'),
    });
    const pushed = await pushResult();
    expect(pushed.errors).toEqual(
        [expect.stringContaining('would receive 2 models')]);
    expect(await profiles()).toBe(1);
    expect(rejects(logs, '')).toEqual(pushed.errors);
    expect(logs.join('\n')).not.toContain('too large');
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
      '      customer -> acme.prod.customer',
      '      purchase -> acme.dev.purchase',
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
        target: //spanner.googleapis.com/projects/acme-ops/instances/prod/databases/commerce/propertyGraphs/commerce
    entities:
      - name: Customer
        source: //spanner.googleapis.com/projects/acme-ops/instances/prod/databases/commerce/tables/Customer
        primary_key: [key]
        fields:
          - { name: key, expression: CustomerId }
`);
    fs.writeFileSync(path.join(eg, 'commerce.profile.prod.yaml'), `name: prod
entities:
  - name: Customer
    source: //spanner.googleapis.com/projects/acme-ops/instances/prod/databases/commerce/tables/Customers
`);
    const code = await profiles({printStore: true, profile: 'prod'});
    expect(code).not.toBe(0);
    expect(logs.join('\n')).toContain(
        "binding profile 'prod' is a profile file, which names no deployment " +
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
