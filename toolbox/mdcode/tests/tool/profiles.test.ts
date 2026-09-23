// Tests for `kcmd profiles` (src/tool/commands.ts, profiles()) and the
// catalog.yaml `default_profile` it reads (src/libts/manifest.ts). The command
// is read-only -- it merges and prunes each profile the way push does but
// deploys nothing and makes no network call -- so it runs in a temp working
// directory with a pinned context, mirroring init_semantic_model.test.ts.

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {ApiContext} from '../../src/libts/gcp/context';
import {CatalogManifest} from '../../src/libts/manifest';
import {profiles} from '../../src/tool/commands';

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
  spyOn(ApiContext, 'default').mockReturnValue(CTX);
  spyOn(console, 'log').mockImplementation((...a: any[]) => {
    logs.push(a.join(' '));
  });
  spyOn(console, 'error').mockImplementation((...a: any[]) => {
    logs.push(a.join(' '));
  });
});

afterEach(() => {
  process.chdir(cwd);
  if (dir) fs.rmSync(dir, {recursive: true, force: true});
  dir = '';
  mock.restore();
});


describe('kcmd profiles', () => {
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
