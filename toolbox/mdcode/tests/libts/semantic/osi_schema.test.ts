// Guardrail: every YAML fixture under tests/libts/semantic/fixtures must be a
// valid document of the flavor its `version:` declares.
//
// A vanilla `0.2.0.dev0` document is validated against the vendored Apache
// Ossie schema (fixtures/ossie/osi-schema.json; see that directory's README),
// the same JSON Schema check the Apache validator runs as its first step. A
// `0.2.0.dev0/google` document is validated against the published Google
// flavor schema (docs/semantic-model/osi-google-schema.json). Both are Draft
// 2020-12, checked in-process with ajv. This catches fixtures drifting from
// the spec, so the loader's own tests exercise only valid input.

import { describe, test, expect } from 'bun:test';
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import * as yaml from 'yaml';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const fixturesDir = join(__dirname, 'fixtures');
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));

// strict:false: the vanilla schema is authored by a third party; we validate
// documents against it, not the schema's own meta-style.
const ajv = new Ajv2020({ allErrors: true, strict: false });

// The validator for each flavor, keyed by the `version` const its schema pins.
const validators = new Map<string, ValidateFunction>(
  [
    join(fixturesDir, 'ossie', 'osi-schema.json'),
    join(__dirname, '..', '..', '..', 'docs', 'semantic-model',
         'osi-google-schema.json'),
  ].map(path => {
    const schema = readJson(path);
    return [schema.properties.version.const, ajv.compile(schema)];
  }));

// Recursively collect every *.yaml/*.yml fixture, so a newly added fixture is
// schema-checked automatically without editing this file.
function yamlFixtures(dir: string): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    // The profiles/ subtree holds binding-profile authoring input, a
    // deliberate pre-OSI superset -- a logical model declares fields with no
    // `expression`, and a profile carries a `deployment_target` sugar
    // -- so it is not a standalone OSI document. The loader, merge, and
    // profile-golden tests validate it instead.
    if (ent.isDirectory()) {
      if (ent.name === 'profiles') continue;
      out.push(...yamlFixtures(p));
    } else if (ent.name.endsWith('.yaml') || ent.name.endsWith('.yml')) {
      out.push(p);
    }
  }
  return out;
}

// The fixtures the schema cannot pass yet, by why. Each may fail only for
// that reason, so a new mistake in one of them is still caught.
type SchemaError = NonNullable<ValidateFunction['errors']>[number];
const EXCLUDED: Array<{ files: Set<string>; reason: (e: SchemaError) => boolean }> = [
  // Fixtures still written in a form the loader rejects: a `deployment_target:`
  // key, and in sales_unqualified_source.yaml a bare source too. b/568184815
  // migrates each one, and removes it from this list.
  {
    files: new Set([
      'actions_place_order.yaml',
      'hierarchy_graph.yaml',
      'sales_bad_target.yaml',
      'sales_bq_graph_target.yaml',
      'sales_google_ext.yaml',
      'sales_spanner_graph_target.yaml',
      'sales_unqualified_source.yaml',
      'star_orders_customer.yaml',
    ]),
    reason: e => e.instancePath.endsWith('/source') ||
      (e.keyword === 'additionalProperties' &&
        e.params.additionalProperty === 'deployment_target'),
  },
  // Pull goldens that record the fallback output of pull rebuilding a model
  // from first-generation aspects, which hold no metric expression. They are
  // fallback output rather than authored documents, so they stay excluded.
  {
    files: new Set([
      'actions_place_order.pull.golden.yaml',
      'sales_bq_graph_target.pull.golden.yaml',
      'star_orders_customer.pull.golden.yaml',
    ]),
    reason: e => e.keyword === 'required' && e.params.missingProperty === 'expression',
  },
];

// The schema's errors, one per line.
const describeErrors = (errors: SchemaError[]) =>
  errors.map(e => `  ${e.instancePath || '(root)'} ${e.message}`).join('\n');

describe('fixtures are valid for their declared OSI flavor', () => {
  const fixtures = yamlFixtures(fixturesDir);

  test('at least one fixture is discovered', () => {
    expect(fixtures.length).toBeGreaterThan(0);
  });

  for (const path of fixtures) {
    const rel = path.slice(fixturesDir.length + 1);
    const excluded = EXCLUDED.find(x => x.files.has(rel));
    // An excluded fixture must still fail, so an entry is removed as soon as
    // its fixture validates, and fail only for the reason it is excluded.
    test(`${rel} ${excluded ? 'is still excluded' : 'validates'}`, () => {
      const doc = yaml.parse(readFileSync(path, 'utf8'));
      const validate = validators.get(doc?.version);
      if (!validate) throw new Error(`${rel}: unknown version '${doc?.version}'`);
      const errors = validate(doc) ? [] : validate.errors ?? [];
      if (excluded) {
        expect(errors.length).toBeGreaterThan(0);
        const other = errors.filter(e => !excluded.reason(e));
        if (other.length) {
          throw new Error(
            `${rel} fails for more than the reason it is excluded:\n${describeErrors(other)}`);
        }
      } else if (errors.length) {
        throw new Error(`Schema validation failed for ${rel}:\n${describeErrors(errors)}`);
      }
    });
  }
});

test('the Google flavor rejects a GOOGLE custom_extensions block in any letter case', () => {
  const { $id } = validators.get('0.2.0.dev0/google')!.schema as { $id: string };
  const validate = ajv.getSchema(`${$id}#/$defs/CustomExtension`)!;
  const valid = (vendor_name: string) => validate({ vendor_name, data: '{}' });
  expect(Object.fromEntries(['GOOGLE', 'google', 'Google', 'LOOKER'].map(v => [v, valid(v)])))
    .toEqual({ GOOGLE: false, google: false, Google: false, LOOKER: true });
});
