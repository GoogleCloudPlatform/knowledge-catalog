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
import { fromDocument, SemanticModelError } from '../../../src/libts/semantic/loader';
import { resolveModelDeployments } from '../../../src/libts/semantic/deployment_target';
import { nameProblem } from '../../../src/libts/semantic/names';
import { applyProfile, loadProfileFile, reservedProfileNameError, validateProfileCompleteness } from '../../../src/libts/semantic/resolve_profiles';
import { undeclaredProfileError } from '../../../src/libts/semantic/runtime/runtime';
import { validateDeployments, validateInlineDialects, validatePushRequirements } from '../../../src/libts/semantic/validate';

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

// The schema's errors for `doc`, one per line, or undefined when it passes.
function schemaErrors(
  validate: ValidateFunction, doc: unknown): string|undefined {
  return validate(doc) ? undefined : describeErrors(validate.errors ?? []);
}

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

// ---------------------------------------------------------------------------
// Agreement: the published schema and kcmd accept the same model documents.
// Each case is one document and whether it is valid. It is checked against the
// schema root and against what a Knowledge Catalog push accepts: the loader
// with bindingOptional, then resolveModelDeployments, undeclaredProfileError,
// validateInlineDialects, validateDeployments and validatePushRequirements with
// targetOptional, as the push command runs them.
// A case where the two disagree fails.
// ---------------------------------------------------------------------------

const GOOGLE = '0.2.0.dev0/google';
const validateGoogle = validators.get(GOOGLE)!;

// Why kcmd rejects `doc` at push, or undefined when it accepts it.
function loaderErrors(doc: unknown): string|undefined {
  try {
    const { models } = fromDocument(doc, { bindingOptional: true });
    for (const model of models) {
      const resolved = resolveModelDeployments(model);
      if ('error' in resolved) return resolved.error;
      // The scope has one profile file, 'prod', as in the profile cases.
      const undeclared = undeclaredProfileError('doc', model, ['prod']);
      if (undeclared) return undeclared;
    }
    const errors = [
      ...models.flatMap(model => [
        ...validateInlineDialects(model, 'doc'),
        ...validateDeployments(model, 'doc')]),
      // Push checks the catalog's model as one that deploys nowhere.
      ...validatePushRequirements(
        models.map(model => ({ document: 'doc',
          model: model.deployments ? { ...model, deployments: [] } : model })),
        { targetOptional: true }),
    ];
    return errors.length ? errors.join('\n') : undefined;
  } catch (err) {
    if (err instanceof SemanticModelError) return err.message;
    throw err;
  }
}

const SOURCE = {
  bigquery: 'bigquery.googleapis.com/projects/p/datasets/d/tables/orders',
  biglake: 'biglake.googleapis.com/projects/p/catalogs/c/namespaces/n/tables/orders',
  spanner: 'spanner.googleapis.com/projects/p/instances/i/databases/db/tables/orders',
  alloydb: 'alloydb.googleapis.com/projects/p/locations/l/clusters/c/databases/db/schemas/s/tables/orders',
  cloudsqlMysql: 'cloudsql.googleapis.com/projects/p/locations/l/instances/i/databases/db/tables/orders',
  cloudsqlSchema: 'cloudsql.googleapis.com/projects/p/locations/l/instances/i/databases/db/schemas/s/tables/orders',
};
const TARGET = {
  bigquery: 'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g',
  spanner: 'spanner.googleapis.com/projects/p/instances/i/databases/db/graphs/g',
  alloydb: 'alloydb.googleapis.com/projects/p/locations/l/clusters/c/databases/db',
};
// A broken variant of each form: a segment missing, added or malformed.
const BAD_SOURCE: Record<keyof typeof SOURCE, string> = {
  bigquery: 'bigquery.googleapis.com/projects/p/datasets/d/tables/orders.v2',
  biglake: 'biglake.googleapis.com/projects/p/catalogs/c/tables/orders',
  spanner: 'spanner.googleapis.com/projects/p/instances/i/tables/orders',
  alloydb: 'alloydb.googleapis.com/projects/p/locations/l/clusters/c/databases/db/tables/orders',
  cloudsqlMysql: 'cloudsql.googleapis.com/projects/p/instances/i/databases/db/tables/orders',
  cloudsqlSchema: 'cloudsql.googleapis.com/projects/p/locations/l/instances/i/schemas/s/tables/orders',
};
const BAD_TARGET: Record<keyof typeof TARGET, string> = {
  bigquery: 'bigquery.googleapis.com/projects/p/datasets/d/graphs/g',
  spanner: 'spanner.googleapis.com/projects/p/instances/i/databases/db/propertyGraphs/g',
  alloydb: 'alloydb.googleapis.com/projects/p/locations/l/clusters/c/instances/x/databases/db',
};

// A small valid Google-flavor model: two entities, a relationship, a metric.
function baseModel(): any {
  return {
    name: 'sales',
    entities: [
      { name: 'orders', source: SOURCE.bigquery, primary_key: ['id'],
        fields: [
          { name: 'id', expression: 'id' },
          { name: 'customer_id', expression: 'customer_id' },
        ] },
      { name: 'customers', source: SOURCE.bigquery.replace('orders', 'customers'),
        primary_key: ['id'], fields: [{ name: 'id', expression: 'id' }] },
    ],
    relationships: [{
      name: 'orders_to_customers', from: 'orders', to: 'customers',
      from_columns: ['customer_id'], to_columns: ['id'],
    }],
    metrics: [{ name: 'order_count', expression: 'COUNT(orders.id)' }],
  };
}

// Every Google extension at once. `entities` holds the entities; a case can
// rename the key to `datasets`.
function fullModel(): any {
  const ext = [{ vendor_name: 'DBT', data: '{"owner":"analytics"}' }];
  return {
    name: 'sales-analytics',
    description: 'Orders and the people who place them.',
    ai_context: { instructions: 'Revenue is net.', custom: { priority: 3 } },
    custom_extensions: ext,
    deployments: [{ name: 'prod', target: TARGET.bigquery }],
    entities: [
      { name: 'party', abstract: true, fields: [{ name: 'id' }] },
      { name: 'customers', extends: ['party'], source: SOURCE.bigquery,
        primary_key: ['id'], custom_extensions: ext,
        fields: [{ name: 'id', expression: 'id' }] },
      { name: 'orders', source: SOURCE.bigquery.replace('orders', 'o'),
        primary_key: ['id'],
        fields: [
          { name: 'id', expression: 'id', datatype: 'integer',
            custom_extensions: ext },
          { name: 'customer_id', expression: {
            dialects: [{ dialect: 'ANSI_SQL', expression: 'customer_id' }] } },
        ] },
    ],
    relationships: [{
      name: 'orders_to_customers', from: 'orders', to: 'customers',
      from_columns: ['customer_id'], to_columns: ['id'],
      description: 'Who placed the order.', custom_extensions: ext,
    }],
    metrics: [{
      name: 'order_count', entity: 'orders', expression: 'COUNT(orders.id)',
      custom_extensions: ext,
    }],
  };
}

// A document holding `model`, edited by `edit` when given.
function docOf(model: any, edit?: (m: any, doc: any) => void): any {
  const doc = { version: GOOGLE, semantic_model: [model] };
  edit?.(model, doc);
  return doc;
}
const base = (edit?: (m: any, doc: any) => void) => docOf(baseModel(), edit);

// A name of `length` characters that matches every name pattern.
const nameOf = (length: number) => 'n'.repeat(length);

// The part of baseModel that a kind of name or description sits on. The
// entity is `customers`, which only the relationship's `to` refers to.
type Part = 'model'|'entity'|'metric'|'relationship';
const partOf = (m: any, kind: Part) => ({
  model: m, entity: m.entities[1], metric: m.metrics[0],
  relationship: m.relationships[0] })[kind];
// Gives a kind of thing in baseModel a new name, and every reference to it.
function rename(m: any, kind: Part|'deployment', name: string): void {
  if (kind === 'deployment') m.deployments = [{ name, target: TARGET.bigquery }];
  else partOf(m, kind).name = name;
  if (kind === 'entity') m.relationships[0].to = name;
}

// `loaderBug` says why kcmd disagrees with the schema on this case: a bug,
// whose entry is removed once the loader is fixed, or a rule no JSON Schema
// can state. The test then expects the disagreement.
type Case = [label: string, doc: any, valid: boolean, loaderBug?: string];

// The loader accepts an empty name or description here; the schema does not.
const EMPTY_TEXT_BUG = 'b/577102892';

// One valid and one malformed case per source form, and the '//' URI form.
function sourceCases(withSource: (source: string) => any): Case[] {
  return [
    ...(Object.keys(SOURCE) as (keyof typeof SOURCE)[]).flatMap((form): Case[] => [
      [`a ${form} source`, withSource(SOURCE[form]), true],
      [`a malformed ${form} source`, withSource(BAD_SOURCE[form]), false],
    ]),
    ['a source with a leading //', withSource(`//${SOURCE.bigquery}`), false],
  ];
}

// The key and join column cases. `build` is base or profile; both put the
// key on entity 0 and the join columns on relationship 0.
function columnCases(build: (edit: (d: any) => void) => any): Case[] {
  return ([
    ['o_id', true], ['_id', true], ['`order id`', true],
    ['LOWER(cust_id)', false], ['customers.id', false], ['a,b', false],
    ['a`b', false],
  ] as const).flatMap(([column, valid]): Case[] => [
    [`primary_key column ${column}`,
      build(d => { d.entities[0].primary_key = [column]; }), valid],
    [`join column ${column}`,
      build(d => { d.relationships[0].from_columns = [column]; }), valid],
  ]);
}

// One test per case: the schema and kcmd each give the case's verdict.
function describeAgreement(
  title: string, validate: ValidateFunction,
  kcmdErrors: (doc: any) => string|undefined, cases: Case[]): void {
  describe(title, () => {
    for (const [label, doc, valid, loaderBug] of cases) {
      const verdict = valid ? 'valid' : 'invalid';
      test(`${label}: ${verdict}${loaderBug ? `, loader disagrees (${loaderBug})` : ''}`, () => {
        const schema = schemaErrors(validate, doc);
        const loader = kcmdErrors(doc);
        expect({ schema: schema === undefined, loader: loader === undefined },
          `schema:\n${schema ?? '  passes'}\nloader:\n  ${loader ?? 'passes'}`)
          .toEqual({ schema: valid, loader: loaderBug ? !valid : valid });
      });
    }
  });
}

const MODEL_CASES: Case[] = [
  ['a minimal model', base(), true],
  ['a full model with entities:', docOf(fullModel()), true],
  ['a full model with datasets:', docOf(fullModel(), m => {
    m.datasets = m.entities;
    delete m.entities;
  }), true],

  // Document shape.
  ['both entities: and datasets:', base(m => { m.datasets = m.entities; }), false],
  ['two models', base((m, d) => d.semantic_model.push(baseModel())), false],
  ['vendor_name GOOGLE', base(m => {
    m.custom_extensions = [{ vendor_name: 'GOOGLE', data: '{}' }];
  }), false],
  ['an inline profiles: key', base(m => { m.profiles = [{ name: 'p' }]; }), false],
  ['a deployment_target: key', base(m => { m.deployment_target = TARGET.bigquery; }), false],
  ['an unknown key on an entity', base(m => { m.entities[0].colour = 'red'; }), false],

  // Dialects and datatypes.
  ['a dialect outside the list', base(m => {
    m.metrics[0].expression = { dialects: [{ dialect: 'DUCKDB', expression: 'COUNT(orders.id)' }] };
  }), false],
  ['a dialect in another case', base(m => {
    m.metrics[0].expression = { dialects: [{ dialect: 'BigQuery', expression: 'COUNT(orders.id)' }] };
  }), false],
  ['a datatype in any case', base(m => { m.entities[0].fields[0].datatype = 'dateTIMEtz'; }), true],
  ['an unknown datatype', base(m => { m.entities[0].fields[0].datatype = 'Text'; }), false],

  // ai_context.
  ['an unknown key in ai_context', base(m => { m.ai_context = { owner: 'x' }; }), false],
  ['custom holding a list', base(m => { m.ai_context = { custom: ['x'] }; }), false],
  ['synonyms inside custom', base(m => { m.ai_context = { custom: { synonyms: ['x'] } }; }), false],
  ['a non-string example', base(m => { m.ai_context = { examples: [1] }; }), false],
  ['a custom member named __proto__', base(m => {
    m.ai_context = { custom: JSON.parse('{"__proto__": 1}') };
  }), false],

  // Abstract entities have no table.
  ...([
    ['source', (e: any) => { e.source = SOURCE.bigquery; }],
    ['primary_key', (e: any) => { e.primary_key = ['id']; }],
    ['unique_keys', (e: any) => { e.unique_keys = [['id']]; }],
    ['a field expression', (e: any) => { e.fields[0].expression = 'id'; }],
  ] as const).map(([what, edit]): Case => [
    `an abstract entity with ${what}`,
    docOf(fullModel(), m => edit(m.entities[0])), false]),

  // Descriptions: the model, an entity, a metric and a relationship hold 2000.
  ...(['model', 'entity', 'metric', 'relationship'] as const).flatMap(kind =>
    [2000, 2001].map((n): Case => [
      `a ${kind} description of ${n} characters`,
      base(m => { partOf(m, kind).description = 'd'.repeat(n); }), n === 2000])),

  // Names.
  ...([
    ['my-entity', false], ['2024_orders', false], ['order date', false],
    ['_orders', false],
  ] as const).map(([name, valid]): Case => [
    `entity name '${name}'`,
    base(m => rename(m, 'entity', name)), valid]),
  ...([
    ['metric', false], ['relationship', false], ['model', true], ['deployment', true],
  ] as const).map(([kind, valid]): Case => [
    `${kind} name with a hyphen`, base(m => rename(m, kind, 'sales-analytics')), valid]),
  ['field name starting with an underscore', base(m => {
    m.entities[0].fields.push({ name: '_loaded_at', expression: '_loaded_at' });
  }), true],
  ...[300, 301].map((n): Case => [
    `field name of ${n} characters`,
    base(m => { m.entities[0].fields.push({ name: nameOf(n), expression: 'x' }); }),
    n === 300]),
  ...(['model', 'entity', 'metric', 'relationship', 'deployment'] as const)
    .flatMap(kind => [500, 501].map((n): Case => [
      `${kind} name of ${n} characters`,
      base(m => rename(m, kind, nameOf(n))), n === 500])),

  ...columnCases(base),

  // Actions and their executors.
  ...([
    ['an mcp executor', { mcp: { server: 's', tool: 't' } }, true],
    ['a rest executor with any method', { rest: { endpoint: 'https://x', method: 'GET' } }, true],
    ['a grpc executor', { grpc: { service: 's', method: 'm' } }, true],
    ['a sql executor', { sql: { statements: ['DELETE FROM orders WHERE id = @id'] } }, true],
    ['a null executor', null, true],
    ['an executor with no kind', {}, false],
    ['an executor with two kinds',
      { mcp: { server: 's', tool: 't' }, grpc: { service: 's', method: 'm' } }, false],
    ['an mcp executor with a blank server', { mcp: { server: ' ', tool: 't' } }, false],
    ['a rest executor with a blank method', { rest: { endpoint: 'https://x', method: '' } }, false],
    ['a grpc executor with a blank service', { grpc: { service: '', method: 'm' } }, false],
    ['an mcp executor with a blank tool', { mcp: { server: 's', tool: ' ' } }, false],
    ['a rest executor with a blank endpoint', { rest: { endpoint: ' ', method: 'GET' } }, false],
    ['a grpc executor with a blank method', { grpc: { service: 's', method: ' ' } }, false],
    ['a sql executor with a blank statement',
      { sql: { statements: ['DELETE FROM orders WHERE id = @id', ' '] } }, false],
  ] as const).map(([label, executor, valid]): Case => [label, base(m => {
    m.actions = [{
      name: 'cancel_order', description: 'Cancels an order.', executor,
      ...(executor && 'sql' in executor ?
        { parameters: [{ name: 'id', type: 'Integer', required: true }] } : {}),
    }];
  }), valid]),
  // A constraint states a non-blank judgment and its on_violation.
  ...([
    ['no judgment', { name: 'c', on_violation: 'warn' }],
    ['a blank judgment', { name: 'c', judgment: ' ', on_violation: 'warn' }],
    ['no on_violation', { name: 'c', judgment: 'j' }],
  ] as const).map(([what, constraint]): Case => [
    `a constraint with ${what}`,
    base(m => { m.constraints = [structuredClone(constraint)]; }), false]),

  // A deployment with no profile, or 'default', uses the model file's own
  // bindings, so they must bind every concrete entity and relationship.
  ...([
    ['no deployment', undefined, true],
    ['a deployment naming a profile', 'prod', true],
    ['a deployment naming no profile', null, false],
    ["a deployment naming 'default'", 'default', false],
  ] as const).flatMap(([what, profile, valid]): Case[] => {
    const deploy = (m: any) => {
      if (profile === undefined) return;
      m.deployments = [{ name: 'prod', target: TARGET.bigquery,
        ...(profile ? { profile } : {}) }];
    };
    return [
      [`${what}, with an entity with no source`,
        base(m => { deploy(m); delete m.entities[1].source; }), valid],
      [`${what}, with a relationship with no join columns`, base(m => {
        deploy(m);
        delete m.relationships[0].from_columns;
        delete m.relationships[0].to_columns;
      }), valid],
    ];
  }),
  ['a deployment profile with a space', base(m => {
    m.deployments = [{ name: 'prod', target: TARGET.bigquery, profile: 'prod us' }];
  }), false],
  // Rules about what a metric's SQL reads, which no JSON Schema can see.
  ['a metric reading a field with no expression', base(m => {
    m.entities[0].fields.push({ name: 'amount' });
    m.metrics.push({ name: 'revenue', expression: 'SUM(orders.amount)' });
    m.deployments = [{ name: 'prod', target: TARGET.bigquery }];
  }), true, 'no JSON Schema can see which fields a metric reads'],
  ['a ratio metric on a BigQuery deployment', base(m => {
    m.metrics.push({ name: 'orders_per_customer',
      expression: 'COUNT(orders.id) / COUNT(DISTINCT orders.customer_id)' });
    m.deployments = [{ name: 'prod', target: TARGET.bigquery }];
  }), true, 'no JSON Schema can see whether a metric is one aggregate'],

  ['an action with custom_extensions', base(m => {
    m.actions = [{ name: 'cancel_order', custom_extensions: [{ vendor_name: 'DBT', data: '{}' }] }];
  }), false],
  // Action, parameter and constraint names and descriptions have no pattern,
  // so whitespace passes, but they may not be empty.
  ['an action with a whitespace-only name', base(m => { m.actions = [{ name: ' ' }]; }), true],
  ...([
    ['action name', { actions: [{ name: '' }] }],
    ['action description', { actions: [{ name: 'a', description: '' }] }],
    ['parameter name', { actions: [{ name: 'a', parameters: [{ name: '', type: 'Integer' }] }] }],
    ['parameter description',
      { actions: [{ name: 'a', parameters: [{ name: 'x', type: 'Integer', description: '' }] }] }],
    ['constraint name', { constraints: [{ name: '', judgment: 'j', on_violation: 'warn' }] }],
    ['constraint description',
      { constraints: [{ name: 'c', judgment: 'j', on_violation: 'warn', description: '' }] }],
  ] as const).map(([what, patch]): Case => [
    `an empty ${what}`, base(m => Object.assign(m, structuredClone(patch))), false,
    EMPTY_TEXT_BUG]),

  ...sourceCases(source => base(m => { m.entities[0].source = source; })),

  // Deployment targets: one valid and one invalid case per form.
  ...Object.entries(TARGET).flatMap(([form, target]): Case[] => [
    [`a ${form} target`, base(m => { m.deployments = [{ name: 'prod', target }]; }), true],
    [`a malformed ${form} target`, base(m => {
      m.deployments = [{ name: 'prod', target: BAD_TARGET[form as keyof typeof TARGET] }];
    }), false],
  ]),
];

describeAgreement('the Google schema and the loader agree on model documents',
  validateGoogle, loaderErrors, MODEL_CASES);

// ---------------------------------------------------------------------------
// Agreement on profile files. Each case is the whole of a profile file. It is
// checked against #/$defs/ProfileDocument and against what push accepts when
// it applies the profile file to profileModel: the layout's profile-name
// rules, then loadProfileFile, validateProfileCompleteness, and
// validatePushRequirements on the model with the profile applied.
// ---------------------------------------------------------------------------

const validateProfile = ajv.getSchema(
  `${(validateGoogle.schema as { $id: string }).$id}#/$defs/ProfileDocument`)!;

// The logical model the profile files bind: no sources, no field expressions
// and no join columns.
const profileModel = fromDocument({
  version: GOOGLE,
  semantic_model: [{
    name: 'sales',
    entities: [
      { name: 'orders', primary_key: ['id'],
        fields: [{ name: 'id' }, { name: 'customer_id' }, { name: 'amount' }] },
      { name: 'customers', primary_key: ['id'], fields: [{ name: 'id' }] },
    ],
    relationships: [{ name: 'orders_to_customers', from: 'orders', to: 'customers' }],
    metrics: [{ name: 'order_count', expression: 'COUNT(orders.id)' }],
    actions: [{ name: 'cancel_order' }],
  }],
}, { bindingOptional: true }).models[0];

// Why push rejects the profile file `doc` when applying it to profileModel, or
// undefined. The layout checks the profile name with nameProblem and
// reserves 'default'.
function profileErrors(doc: any): string|undefined {
  const name = String(doc?.name);
  const nameError = nameProblem('profile', name) ??
    reservedProfileNameError('profile', [{ name }]);
  if (nameError) return nameError;
  try {
    const spec = loadProfileFile(yaml.stringify(doc), name);
    const errors = validateProfileCompleteness(profileModel, spec);
    if (!errors.length) {
      errors.push(...validatePushRequirements(
        [{ document: 'doc', model: applyProfile(profileModel, spec) }],
        { targetOptional: true }));
    }
    return errors.length ? errors.join('\n') : undefined;
  } catch (err) {
    if (err instanceof SemanticModelError) return err.message;
    throw err;
  }
}

// A profile file that binds every entity and relationship of profileModel,
// edited by `edit` when given.
function profile(edit?: (p: any) => void): any {
  const p = {
    name: 'prod',
    entities: [
      { name: 'orders', source: SOURCE.bigquery, primary_key: ['id'],
        fields: [
          { name: 'id', expression: 'id' },
          { name: 'customer_id', expression: 'customer_id' },
          { name: 'amount', expression: 'amount' },
        ] },
      { name: 'customers', source: SOURCE.bigquery.replace('orders', 'customers'),
        primary_key: ['id'], fields: [{ name: 'id', expression: 'id' }] },
    ],
    relationships: [
      { name: 'orders_to_customers', from_columns: ['customer_id'], to_columns: ['id'] },
    ],
  };
  edit?.(p);
  return p;
}

const PROFILE_CASES: Case[] = [
  ['a profile binding the whole model', profile(), true],
  ['a profile name with a hyphen', profile(p => { p.name = 'prod-us'; }), true],
  ...['default', 'Default', 'DEFAULT'].map((name): Case => [
    `profile name '${name}'`, profile(p => { p.name = name; }), false]),
  ['a profile name with a space', profile(p => { p.name = 'prod us'; }), false],
  ['a version key', profile(p => { p.version = GOOGLE; }), false],
  ['an unknown key on an entity', profile(p => { p.entities[0].colour = 'red'; }), false],

  // Actions: a profile binds an executor and nothing else.
  ['an action executor binding', profile(p => {
    p.actions = [{ name: 'cancel_order', executor: { mcp: { server: 's', tool: 't' } } }];
  }), true],
  ['an action bound to no executor', profile(p => {
    p.actions = [{ name: 'cancel_order', executor: null }];
  }), true],
  ['an action executor with a blank server', profile(p => {
    p.actions = [{ name: 'cancel_order', executor: { mcp: { server: ' ', tool: 't' } } }];
  }), false],
  ['an action setting a description', profile(p => {
    p.actions = [{ name: 'cancel_order', description: 'Cancels an order.' }];
  }), false],

  // metrics_exclude: '*' alone, or a list of names without it.
  ...([
    ['*', true], [['order_count'], true], [['*'], false], [['order_count', '*'], false],
  ] as const).map(([exclude, valid]): Case => [
    `metrics_exclude ${JSON.stringify(exclude)}`,
    profile(p => { p.metrics_exclude = exclude; }), valid]),

  // Fields.
  ['fields_exclude naming a field', profile(p => {
    p.entities[0].fields.pop();
    p.entities[0].fields_exclude = ['amount'];
  }), true],
  ["fields_exclude '*'", profile(p => {
    p.entities[0].fields_exclude = ['*'];
  }), false],
  ['a field with no expression', profile(p => { p.entities[0].fields[2] = { name: 'amount' }; }), false],
  ['an entity with no source', profile(p => { delete p.entities[1].source; }), false],
  ['a relationship with no join columns', profile(p => {
    p.relationships[0] = { name: 'orders_to_customers' };
  }), false],
  ['a relationship with only from_columns', profile(p => {
    delete p.relationships[0].to_columns;
  }), false],

  ...columnCases(profile),

  // A profile reads from one database, so both entities take the form.
  ...sourceCases(source => profile(p => {
    p.entities[0].source = source;
    p.entities[1].source = source.replace(/orders$/, 'customers');
  })),
];

describeAgreement('the Google schema and the loader agree on profile files',
  validateProfile, profileErrors, PROFILE_CASES);

// The schema cannot see the model file, so this case checks the schema alone.
test('a profile entity with no primary_key passes the schema', () => {
  expect(schemaErrors(validateProfile,
    profile(p => { delete p.entities[1].primary_key; }))).toBeUndefined();
});

test('the Google flavor rejects a GOOGLE custom_extensions block in any letter case', () => {
  const { $id } = validators.get('0.2.0.dev0/google')!.schema as { $id: string };
  const validate = ajv.getSchema(`${$id}#/$defs/CustomExtension`)!;
  const valid = (vendor_name: string) => validate({ vendor_name, data: '{}' });
  expect(Object.fromEntries(['GOOGLE', 'google', 'Google', 'LOOKER'].map(v => [v, valid(v)])))
    .toEqual({ GOOGLE: false, google: false, Google: false, LOOKER: true });
});
