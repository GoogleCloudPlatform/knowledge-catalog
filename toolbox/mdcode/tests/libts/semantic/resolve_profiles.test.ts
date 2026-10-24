// Behavior specification for the binding-profile passes
// (src/libts/semantic/resolve_profiles.ts): mergeProfile overlays a profile's
// physical bindings onto a logical model by name and enforces the binding-only
// contract; pruneUnavailable drops what a binding cannot answer and reports it.
// Builders are minimal literals in the readable authoring form (mergeProfile) or
// the IR (pruneUnavailable), mirroring resolve_inheritance.test.ts.

import {beforeAll, describe, expect, spyOn, test} from 'bun:test';
import * as yaml from 'yaml';

import {Field, isFieldBound, ProfileEntityBinding, ProfileSpec, SemanticModel} from '../../../src/libts/semantic/ir';
import * as loader from '../../../src/libts/semantic/loader';
import {fromDocument, loadModels, loadSemanticModels, SemanticModelError} from '../../../src/libts/semantic/loader';
import * as inheritance from '../../../src/libts/semantic/resolve_inheritance';
import {resolveInheritance} from '../../../src/libts/semantic/resolve_inheritance';
import * as sqlUtils from '../../../src/libts/semantic/sql_expr_utils';
import {applyProfile, applyProfileExclusions, applyProfileFile, CompletenessOptions, loadProfileFile, mergeProfile as mergeProfileImpl, mergeProfileOntoDoc as mergeProfileOntoDocImpl, ProfileExclusion, profileForDocument, pruneUnavailable, sourcesDialect, validateProfileCompleteness, validateProfileConsistency} from '../../../src/libts/semantic/resolve_profiles';
import {loadSqlEngine} from '../../../src/libts/semantic/sql_parser';
import {validatePushRequirements} from '../../../src/libts/semantic/validate';
import {YAML_OPTIONS} from '../../../src/libts/semantic/yaml_options';
import {serializeModel} from '../../../src/libts/semantic/osi_converter';

beforeAll(async () => {
  await loadSqlEngine();
});


// Every profile file a test here merges is also applied with applyProfile,
// which must build the same model or fail with the same error, wherever the
// model file loads on its own. The one exception is a profile that states one
// of a relationship's join column lists without the other. The merge takes
// the other list from the model file, and applyProfile rejects it as the
// completeness check does.
function checkAgainstApply(
    logical: unknown, profile: unknown, name: string,
    merged: {doc?: unknown; error?: string; excluded: ProfileExclusion[]}) {
  if (!profile || typeof profile !== 'object' || Array.isArray(profile) ||
      (profile as any).semantic_model !== undefined) {
    return;
  }
  // The merge reads no version; a load needs one, and these documents are in
  // the Google flavor.
  const versioned = (doc: unknown) =>
      ({version: '0.2.0.dev0/google', ...structuredClone(doc as object)});
  let model: SemanticModel|undefined;
  try {
    model = fromDocument(versioned(logical), {bindingOptional: true}).models[0];
  } catch {
    return;
  }
  if (!model) return;
  const applied =
      applyProfileFile(model, yaml.stringify(profile, YAML_OPTIONS), name);
  if (merged.error) {
    expect(applied).toEqual({error: merged.error});
    return;
  }
  const relationships = (profile as any).relationships;
  if (Array.isArray(relationships) &&
      relationships.some(
          r => (r?.from_columns === undefined) !==
              (r?.to_columns === undefined))) {
    expect('error' in applied && applied.error)
        .toContain('has no join columns in this profile');
    return;
  }
  let mergedModel: SemanticModel;
  try {
    mergedModel =
        fromDocument(versioned(merged.doc), {bindingOptional: true}).models[0];
  } catch {
    expect('error' in applied).toBe(true);
    return;
  }
  if ('error' in applied) throw new Error(applied.error);
  expect(applied.model)
      .toEqual(applyProfileExclusions(mergedModel, merged.excluded));
}
const mergeProfile = (logical: unknown, profile: unknown, name: string) => {
  const merged = mergeProfileImpl(logical, profile, name);
  checkAgainstApply(logical, profile, name, merged);
  return merged;
};
const mergeProfileOntoDoc =
    (logicalText: string, profileText: string, name: string) => {
      const merged = mergeProfileOntoDocImpl(logicalText, profileText, name);
      checkAgainstApply(
          yaml.parse(logicalText, YAML_OPTIONS),
          yaml.parse(profileText, YAML_OPTIONS), name,
          'error' in merged ?
              {error: merged.error, excluded: []} :
              {doc: yaml.parse(merged.text, YAML_OPTIONS),
               excluded: merged.excluded});
      return merged;
    };

const GRAPH =
    'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/commerce';
const TBL = (t: string) =>
    `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;

function logicalDoc(): any {
  return {
    semantic_model: [{
      name: 'commerce',
      entities: [
        {
          name: 'Customer',
          primary_key: ['key'],
          fields: [
            {name: 'key', label: 'Customer ID'},
            {name: 'name'},
            {name: 'lifetimeValue'},
            {name: 'availableCredit'},
          ],
        },
        {
          name: 'Order',
          primary_key: ['key'],
          fields: [
            {name: 'key'},
            {name: 'customerKey'},
            {name: 'orderDate', dimension: {is_time: true}},
          ],
        },
      ],
      relationships: [{
        name: 'PlacedBy', from: 'Order', to: 'Customer',
        from_columns: ['customerKey'], to_columns: ['key'],
      }],
      metrics: [
        {name: 'order_count', expression: 'COUNT(Order.key)'},
        {name: 'avg_lifetime_value', expression: 'AVG(Customer.lifetimeValue)'},
      ],
    }],
  };
}

// The analytical binding: BigQuery sources, lifetimeValue bound, availableCredit
// explicitly unbound.
function analyticalDoc(): any {
  return {
    semantic_model: [{
      name: 'commerce',
      deployment_target: GRAPH,
      entities: [
        {
          name: 'Customer',
          source: TBL('customer'),
          fields: [
            {name: 'key', expression: 'c_custkey'},
            {name: 'name', expression: 'c_name'},
            {name: 'lifetimeValue', expression: 'c_ltv'},
            {name: 'availableCredit'},
          ],
        },
        {
          name: 'Order',
          source: TBL('orders'),
          fields: [
            {name: 'key', expression: 'o_orderkey'},
            {name: 'customerKey', expression: 'o_custkey'},
            {name: 'orderDate', expression: 'o_orderdate'},
          ],
        },
      ],
    }],
  };
}

const modelOf = (doc: any) => doc.semantic_model[0];
const entityOf = (doc: any, name: string) =>
    (modelOf(doc).entities ?? modelOf(doc).datasets)
        .find((e: any) => e.name === name);
const fieldOf = (doc: any, entity: string, field: string) =>
    entityOf(doc, entity).fields.find((f: any) => f.name === field);


describe('mergeProfile overlays physical bindings by name', () => {
  test('applies source and expression, preserving logical facets', () => {
    const {doc, error} = mergeProfile(logicalDoc(), analyticalDoc(), 'analytical');
    expect(error).toBeUndefined();
    expect(entityOf(doc, 'Customer').source).toBe(TBL('customer'));
    const key = fieldOf(doc, 'Customer', 'key');
    expect(key.expression).toBe('c_custkey');
    expect(key.label).toBe('Customer ID');  // logical facet preserved
    expect(modelOf(doc).deployment_target).toBe(GRAPH);
  });

  test('drops model deployments when a legacy profile sets deployment_target, and keeps them when it does not', () => {
    const deployments = [{
      name: 'prod',
      target: 'spanner.googleapis.com/projects/p/instances/i/databases/d/graphs/commerce',
    }];
    const logical = logicalDoc();
    modelOf(logical).deployments = deployments;
    const {doc, error} = mergeProfile(logical, analyticalDoc(), 'analytical');
    expect(error).toBeUndefined();
    expect(modelOf(doc).deployment_target).toBe(GRAPH);
    expect(modelOf(doc).deployments).toBeUndefined();

    const noTargetProfile = analyticalDoc();
    delete modelOf(noTargetProfile).deployment_target;
    const kept = mergeProfile(logical, noTargetProfile, 'analytical');
    expect(kept.error).toBeUndefined();
    expect(modelOf(kept.doc).deployment_target).toBeUndefined();
    expect(modelOf(kept.doc).deployments).toEqual(deployments);
  });

  test('a field the profile does not bind has no column', () => {
    // availableCredit is present in the profile but carries no expression, so
    // the merge leaves it unbound (a field is unbound exactly when it has no
    // expression -- there is no separate flag).
    const {doc} = mergeProfile(logicalDoc(), analyticalDoc(), 'analytical');
    const credit = fieldOf(doc, 'Customer', 'availableCredit');
    expect(credit.expression).toBeUndefined();
  });

  test('a field the profile omits is carried through as unbound', () => {
    const profile = analyticalDoc();
    // Drop availableCredit entirely from the profile (silent omission).
    entityOf(profile, 'Customer').fields =
        entityOf(profile, 'Customer')
            .fields.filter((f: any) => f.name !== 'availableCredit');
    const {doc, error} = mergeProfile(logicalDoc(), profile, 'analytical');
    expect(error).toBeUndefined();
    expect(fieldOf(doc, 'Customer', 'availableCredit').expression)
        .toBeUndefined();
  });

  test('selecting a profile keeps an inline binding it does not mention', () => {
    // A profile is an overlay: a field it does not rebind keeps the binding
    // the model file gave it.
    const logical = logicalDoc();
    fieldOf(logical, 'Customer', 'name').expression = 'inline_name';
    const profile = analyticalDoc();
    entityOf(profile, 'Customer').fields =
        entityOf(profile, 'Customer')
            .fields.filter((f: any) => f.name !== 'name');
    const {doc, error} = mergeProfile(logical, profile, 'analytical');
    expect(error).toBeUndefined();
    expect(fieldOf(doc, 'Customer', 'name').expression).toBe('inline_name');
  });

  test('the inputs are never mutated', () => {
    const logical = logicalDoc();
    const profile = analyticalDoc();
    const before = JSON.stringify(logical);
    mergeProfile(logical, profile, 'analytical');
    expect(JSON.stringify(logical)).toBe(before);
  });

  test('a profile that sets a declaration facet is rejected', () => {
    const profile = analyticalDoc();
    fieldOf(profile, 'Customer', 'name').label = 'Renamed';  // logical facet
    const {error} = mergeProfile(logicalDoc(), profile, 'analytical');
    expect(error).toMatch(/sets 'label'/);
  });

  test('a profile that defines a metric is rejected', () => {
    const profile = analyticalDoc();
    modelOf(profile).metrics = [{name: 'x', expression: 'COUNT(Order.key)'}];
    const {error} = mergeProfile(logicalDoc(), profile, 'analytical');
    expect(error).toMatch(/sets 'metrics'/);
  });

  test('a profile naming an unknown entity is rejected', () => {
    const profile = analyticalDoc();
    entityOf(profile, 'Order').name = 'Nope';
    const {error} = mergeProfile(logicalDoc(), profile, 'analytical');
    expect(error).toMatch(/entity 'Nope' is not in the logical model/);
  });

  test('a profile naming an unknown field is rejected', () => {
    const profile = analyticalDoc();
    entityOf(profile, 'Customer').fields.push({name: 'ghost', expression: 'g'});
    const {error} = mergeProfile(logicalDoc(), profile, 'analytical');
    expect(error).toMatch(/field 'Customer.ghost' is not in the logical model/);
  });

  test('a profile expression may be a computation, not only a column', () => {
    const profile = analyticalDoc();
    fieldOf(profile, 'Customer', 'lifetimeValue').expression = 'c_a + c_b';
    const {doc, error} = mergeProfile(logicalDoc(), profile, 'analytical');
    expect(error).toBeUndefined();
    expect(fieldOf(doc, 'Customer', 'lifetimeValue').expression)
        .toBe('c_a + c_b');
  });
});


// An action's executor is its only physical facet: the same operation is
// performed by DML where the data is relational and by a call to whoever owns
// the data where it is not. These build the smallest pair that shows a profile
// supplying it.
const SQL_EXEC = {
  sql: {statements: ['UPDATE orders SET total = 0 WHERE o_orderkey = @order']},
};
const MCP_EXEC = {
  mcp: {
    server: '//agentregistry.googleapis.com/projects/p/locations/l/mcpServers/s',
    tool: 'issue_credit',
  },
};

function logicalWithAction(defaultExecutor?: any): any {
  const doc = logicalDoc();
  modelOf(doc).actions = [{
    name: 'IssueCredit',
    description: 'Credit an order',
    parameters: [{name: 'order', type: 'Order'}],
    affects: [{concept: 'Order', operation: 'modify'}],
    ...(defaultExecutor ? {executor: defaultExecutor} : {}),
  }];
  return doc;
}

function profileWithAction(action: any): any {
  const p = analyticalDoc();
  modelOf(p).actions = [action];
  return p;
}

const actionOf = (doc: any, name: string) =>
    (modelOf(doc).actions ?? []).find((a: any) => a.name === name);


describe('an executor is a binding a profile supplies', () => {
  test('a profile binds an action the logical model leaves open', () => {
    const {doc, error} = mergeProfile(
        logicalWithAction(), profileWithAction({
          name: 'IssueCredit',
          executor: SQL_EXEC,
        }),
        'analytical');
    expect(error).toBeUndefined();
    expect(actionOf(doc, 'IssueCredit').executor).toEqual(SQL_EXEC);
    // The declaration is untouched: a profile moves the write, never its
    // meaning.
    expect(actionOf(doc, 'IssueCredit').description).toBe('Credit an order');
    expect(actionOf(doc, 'IssueCredit').affects).toEqual([
      {concept: 'Order', operation: 'modify'},
    ]);
  });

  test('a profile replaces the model default, and may change the kind', () => {
    // The point of binding the executor rather than declaring it: the model
    // names whoever owns the write, and the store that holds the rows performs
    // it as DML instead. Same action, same blast radius, different mechanism.
    const {doc, error} = mergeProfile(
        logicalWithAction(MCP_EXEC),
        profileWithAction({name: 'IssueCredit', executor: SQL_EXEC}),
        'analytical');
    expect(error).toBeUndefined();
    expect(actionOf(doc, 'IssueCredit').executor).toEqual(SQL_EXEC);
  });

  test('an action the profile does not mention keeps the model default', () => {
    // Unlike a field's column, an executor is inherited on silence. A column
    // inherited into a renamed schema binds to the wrong data quietly; an
    // executor names a whole mechanism, so a wrong one fails at the first call.
    const {doc, error} = mergeProfile(
        logicalWithAction(MCP_EXEC), analyticalDoc(), 'analytical');
    expect(error).toBeUndefined();
    expect(actionOf(doc, 'IssueCredit').executor).toEqual(MCP_EXEC);
  });

  test('`executor: null` withdraws an inherited executor', () => {
    // A read-only environment has to be able to say "by no means at all",
    // because silence already means "keep the default".
    const {doc, error} = mergeProfile(
        logicalWithAction(MCP_EXEC),
        profileWithAction({name: 'IssueCredit', executor: null}),
        'readonly');
    expect(error).toBeUndefined();
    expect(actionOf(doc, 'IssueCredit').executor).toBeUndefined();
    // Withdrawn, not deleted: the action is still declared.
    expect(actionOf(doc, 'IssueCredit').name).toBe('IssueCredit');
  });

  test(
      'a profile naming an action the model does not declare is an error',
      () => {
        const {error} = mergeProfile(
            logicalWithAction(),
            profileWithAction({name: 'Nonesuch', executor: SQL_EXEC}),
            'analytical');
        expect(error).toMatch(/action 'Nonesuch' is not in the logical model/);
      });

  test('a model with profiles may not declare a `sql` executor', () => {
    // A statement is written in one store's table and column names and its
    // dialect, so there is no model-level spelling of it. Left in the model it
    // would also outlive the columns it reads: the merge has just cleared this
    // model's inline field bindings for the profile to re-supply.
    const {error} = mergeProfile(
        logicalWithAction(SQL_EXEC),
        profileWithAction({name: 'IssueCredit', executor: MCP_EXEC}),
        'analytical');
    expect(error).toMatch(/action 'IssueCredit'/);
    expect(error).toMatch(/declares a 'sql' executor/);
  });

  test(
      'a model the profile does not name keeps its inline `sql` executor',
      () => {
        // The ban follows the same scope as the inline-binding strip: a model
        // the profile never touches keeps its own columns, so its statements
        // still match them.
        const logical = logicalWithAction(MCP_EXEC);
        const untouched = structuredClone(modelOf(logical));
        untouched.name = 'ops';
        untouched.actions = [{
          name: 'CloseOrder',
          parameters: [{name: 'order', type: 'Order'}],
          executor: SQL_EXEC,
        }];
        logical.semantic_model.push(untouched);

        const {doc, error} = mergeProfile(
            logical, profileWithAction({name: 'IssueCredit'}), 'analytical');
        expect(error).toBeUndefined();
        const ops =
            (doc as any).semantic_model.find((m: any) => m.name === 'ops');
        expect(ops.actions[0].executor).toEqual(SQL_EXEC);
      });

  test('a profile setting a logical facet on an action is rejected', () => {
    // What gates the action and what it changes are the model's to state. A
    // profile that could move a guard could turn a check off per environment.
    const {error} = mergeProfile(
        logicalWithAction(MCP_EXEC),
        profileWithAction({name: 'IssueCredit', guards: ['SomeRule']}),
        'analytical');
    expect(error).toMatch(/action 'IssueCredit' sets 'guards'/);
  });
});


// A loaded IR model with one field left unbound, for the pruning pass.
function irModel(): SemanticModel {
  return {
    name: 'commerce',
    entities: [
      {
        name: 'Customer', dataSource: 'p.d.customer', keys: ['key'],
        fields: [
          {name: 'key', expression: 'c_custkey'},
          {name: 'name', expression: 'c_name'},
          {name: 'lifetimeValue'},
        ],
      },
      {
        name: 'Order', dataSource: 'p.d.orders', keys: ['key'],
        fields: [
          {name: 'key', expression: 'o_orderkey'},
          {name: 'customerKey', expression: 'o_custkey'},
        ],
      },
    ],
    relationships: [{
      name: 'PlacedBy',
      source: {entity: 'Order', columns: ['customerKey']},
      destination: {entity: 'Customer', columns: ['key']},
    }],
    metrics: [
      {name: 'order_count', expression: 'COUNT(Order.key)', entity: 'Order'},
      {
        name: 'avg_lifetime_value',
        expression: 'AVG(Customer.lifetimeValue)', entity: 'Customer',
      },
    ],
  };
}

const BQ = (t: string) => `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
// A field whose expression is `expression`, by default the field's name.
const column = (name: string, expression = name) => ({name, expression});
const ID = column('id');
// A profile binding of `name` to `source` that states key `key`, restates
// field `key` and binds `more`.
const keyed = (key: string) => (name: string, source: string, ...more: Field[]) =>
    ({name, source, primaryKey: [key], fields: [column(key), ...more]});
const keyedById = keyed('id');
// irModel's Customer fields that read a column, as a named profile restates them.
const CUSTOMER_COLUMNS = [column('key', 'c_custkey'), column('name', 'c_name')];
// A named profile for irModel, whose Customer.lifetimeValue the model file
// leaves unbound. It states each entity's key and restates its column fields.
function profile(over: Partial<ProfileSpec> = {}): ProfileSpec {
  return {
    name: 'prod',
    entities: [
      {name: 'Customer', source: BQ('customer'), primaryKey: ['c_custkey'],
       fields: [...CUSTOMER_COLUMNS, column('lifetimeValue', 'ltv')]},
      {name: 'Order', source: BQ('orders'), primaryKey: ['o_orderkey'],
       fields: [column('key', 'o_orderkey'), column('customerKey', 'o_custkey')]},
    ],
    relationships: [{name: 'PlacedBy', fromColumns: ['o_custkey'], toColumns: ['c_custkey']}],
    ...over,
  };
}
// profile's Customer binding with lifetimeValue excluded.
const CUSTOMER_WITHOUT_LTV =
    {...profile().entities[0], fields: CUSTOMER_COLUMNS, fieldsExclude: ['lifetimeValue']};
// Profile prod's error for Customer stating none of `keys`.
const noKeys = (keys: string) =>
    `profile 'prod': entity 'Customer' has no ${keys} in this profile; the ` +
    "model file's keys are columns of its own table, so state this profile's keys";
// Profile prod's error for `field`, written 'Entity.field', reading `column`
// through its model file expression, or through the one it inherits from `owner`.
const readsColumn = (field: string, column: string, owner?: string) =>
    `profile 'prod': field '${field}' reads column '${column}' through ${
        owner ? `the expression it inherits from '${owner}'` : 'its model file expression'
    }; bind it in 'fields' for this profile, or leave it out in 'fields_exclude'`;

const fieldNames = (m: SemanticModel, entity: string) =>
    m.entities.find(e => e.name === entity)!.fields.map(f => f.name);
const metricNames = (m: SemanticModel) => (m.metrics ?? []).map(mt => mt.name);
const relNames = (m: SemanticModel) => (m.relationships ?? []).map(r => r.name);
const actionNames = (m: SemanticModel) => (m.actions ?? []).map(a => a.name);


describe('pruneUnavailable drops what a binding cannot answer', () => {
  test('an unbound field is removed from its entity', () => {
    const {model, report} = pruneUnavailable(irModel(), 'operational');
    expect(fieldNames(model, 'Customer')).toEqual(['key', 'name']);
    expect(report.unboundFields).toContain('Customer.lifetimeValue');
  });

  test('a metric that reads an unbound field is dropped and reported', () => {
    const {model, report} = pruneUnavailable(irModel(), 'operational');
    expect(metricNames(model)).toEqual(['order_count']);
    const dropped =
        report.droppedMetrics.find(d => d.name === 'avg_lifetime_value');
    expect(dropped?.reason).toMatch(/Customer\.lifetimeValue/);
  });

  test('a metric whose fields are all bound survives', () => {
    const {model} = pruneUnavailable(irModel(), 'operational');
    expect(metricNames(model)).toContain('order_count');
  });

  test('a field that reads an unavailable field is unavailable too, transitively', () => {
    // `discount` is unbound; `net_amount` reads it, `tax` reads `net_amount`,
    // and `total_tax` reads `tax`. All three go with it.
    const chain = (discount: Partial<Field>, excluded: string[] = []):
        SemanticModel => ({
          name: 'sales',
          entities: [{
            name: 'Order', dataSource: 'p.d.orders', keys: ['o_id'],
            excludedFields: excluded,
            fields: [
              {name: 'gross_amount', expression: 'gross'},
              {name: 'discount', ...discount},
              {name: 'net_amount', expression: 'Order.gross_amount - Order.discount'},
              {name: 'tax', expression: 'Order.net_amount * 0.08'},
            ],
          }],
          relationships: [],
          metrics: [
            {name: 'total_tax', expression: 'SUM(Order.tax)', entity: 'Order'},
            {name: 'gross', expression: 'SUM(Order.gross_amount)', entity: 'Order'},
          ],
        });
    for (const m of [chain({}), chain({expression: 'disc'}, ['discount'])]) {
      const {model, report} = pruneUnavailable(m, 'prod');
      expect(fieldNames(model, 'Order')).toEqual(['gross_amount']);
      expect(report.droppedFields).toEqual([
        {name: 'Order.net_amount', reason: 'reads Order.discount, which is unavailable'},
        {name: 'Order.tax', reason: 'reads Order.net_amount, which is unavailable'},
      ]);
      expect(metricNames(model)).toEqual(['gross']);
      expect(report.droppedMetrics).toEqual([
        {name: 'total_tax', reason: 'field Order.tax is unavailable', field: 'Order.tax'},
      ]);
    }
  });

  test('an inherited field that reads an unavailable one is excluded on the leaf', () => {
    // `y` reads `x`, which is unbound. The leaf inherits both and declares no
    // line for either, so pruning marks both excluded there.
    const m: SemanticModel = {
      name: 'h',
      entities: [
        {name: 'P', dataSource: 'p.d.parent', keys: ['id'], fields: [
          {name: 'id', expression: 'id'},
          {name: 'x'},
          {name: 'y', expression: 'P.x + 1'},
        ]},
        {name: 'C', dataSource: 'p.d.child', keys: ['id'], extends: ['P'], fields: []},
      ],
      relationships: [],
      metrics: [],
    };
    const {model, report} = pruneUnavailable(m, 'prod');
    expect(report.droppedFields.map(d => d.name)).toContain('C.y');
    expect(model.entities.find(e => e.name === 'C')!.excludedFields)
        .toEqual(['x', 'y']);
    const resolved = resolveInheritance(model).model;
    expect(fieldNames(resolved, 'C')).not.toContain('y');
  });

  test('an inherited unbound field is excluded on the subtype of a concrete parent', () => {
    // P keeps its `email` line for subtypes that bind it. C binds nothing, so
    // pruning marks `email` excluded on C, and inheritance does not hand it
    // back.
    const m: SemanticModel = {
      name: 'h',
      entities: [
        {name: 'P', dataSource: 'p.d.parent', keys: ['id'], fields: [
          {name: 'id', expression: 'id'},
          {name: 'email'},
        ]},
        {name: 'C', dataSource: 'p.d.child', keys: ['id'], extends: ['P'], fields: []},
      ],
      relationships: [],
      metrics: [],
    };
    const {model} = pruneUnavailable(m, 'prod');
    expect(model.entities.find(e => e.name === 'C')!.excludedFields)
        .toEqual(['email']);
    expect(fieldNames(resolveInheritance(model).model, 'C')).toEqual(['id']);
  });

  test('an inherited unbound field is excluded on the subtype of an abstract parent', () => {
    const m: SemanticModel = {
      name: 'h',
      entities: [
        {name: 'P', dataSource: '', abstract: true, keys: [], fields: [
          {name: 'id'},
          {name: 'email'},
        ]},
        {name: 'C', dataSource: 'p.d.child', keys: ['id'], extends: ['P'], fields: [
          {name: 'id', expression: 'c_id'},
        ]},
      ],
      relationships: [],
      metrics: [],
    };
    const {model} = pruneUnavailable(m, 'prod');
    expect(model.entities.find(e => e.name === 'C')!.excludedFields)
        .toEqual(['email']);
    expect(fieldNames(resolveInheritance(model).model, 'C')).toEqual(['id']);
  });

  test('a restated field that reads an unavailable one does not fall back to the ancestor', () => {
    // C restates `y` to read its own `bonus`, which is unbound. Removing C's
    // line alone would hand C the ancestor's `P.x + 1` again.
    const m: SemanticModel = {
      name: 'h',
      entities: [
        {name: 'P', dataSource: 'p.d.parent', keys: ['id'], fields: [
          {name: 'id', expression: 'id'},
          {name: 'x', expression: 'x'},
          {name: 'y', expression: 'P.x + 1'},
        ]},
        {name: 'C', dataSource: 'p.d.child', keys: ['id'], extends: ['P'], fields: [
          {name: 'bonus'},
          {name: 'y', expression: 'C.x + C.bonus'},
        ]},
      ],
      relationships: [],
      metrics: [],
    };
    const {model, report} = pruneUnavailable(m, 'default');
    expect(report.droppedFields).toEqual(
        [{name: 'C.y', reason: 'reads C.bonus, which is unavailable'}]);
    expect(fieldNames(resolveInheritance(model).model, 'C')).not.toContain('y');
    expect(fieldNames(resolveInheritance(model).model, 'P')).toContain('y');
  });

  test('a metric is dropped when a text it can read reaches an unavailable field', () => {
    // `Date` is a keyword, so the parser reads the backticked text and not the
    // other one.
    const m: SemanticModel = {
      name: 'cal',
      entities: [{name: 'Date', dataSource: 'p.d.dates', keys: ['d'], fields: [
        {name: 'd', expression: 'd'},
        {name: 'is_holiday'},
      ]}],
      relationships: [],
      metrics: [{
        name: 'holidays', entity: 'Date',
        dialects: [
          {dialect: 'BIGQUERY', expression: 'SUM(`Date`.is_holiday)'},
          {dialect: 'SNOWFLAKE', expression: 'SUM(Date.is_holiday)'},
        ],
      }],
    };
    const {model, report} = pruneUnavailable(m, 'default');
    expect(metricNames(model)).toEqual([]);
    expect(report.droppedMetrics).toEqual(
        [{name: 'holidays', reason: 'field Date.is_holiday is unbound', field: 'Date.is_holiday'}]);
  });

  test('a metric is dropped when its readable text joins unconnected entities', () => {
    const m = irModel();
    m.relationships = [];
    m.metrics = [{
      name: 'mixed', entity: 'Order',
      dialects: [
        {dialect: 'BIGQUERY', expression: 'COUNT(Order.key) + COUNT(Customer.key)'},
        {dialect: 'SNOWFLAKE', expression: 'COUNT(Order.key'},
      ],
    }];
    const {model, report} = pruneUnavailable(m, 'operational');
    expect(metricNames(model)).toEqual([]);
    expect(report.droppedMetrics[0].reason)
        .toBe('no available relationship connects Order, Customer');
  });

  test('an excluded field is not read for propagation', () => {
    const m = irModel();
    m.entities[0].excludedFields = ['odd'];
    m.entities[0].fields.push({name: 'odd', expression: 'a; b'});
    const {report} = pruneUnavailable(m, 'operational');
    expect(report.warnings).toEqual([]);
  });

  test('nothing is parsed for propagation when nothing is unbound', () => {
    const m = irModel();
    m.entities[0].fields = m.entities[0].fields.map(
        f => ({...f, expression: f.expression ?? 'ltv'}));
    m.entities[0].fields.push({name: 'odd', expression: 'a; b'});
    const {report} = pruneUnavailable(m, 'operational');
    expect(report.droppedFields).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  test('a metric is pruned on every text it carries when its sources name no one dialect', () => {
    // The BIGQUERY text reads a bound field; the SNOWFLAKE one does not.
    const twoTexts = (m: SemanticModel) => {
      const metric = m.metrics!.find(x => x.name === 'avg_lifetime_value')!;
      metric.expression = undefined;
      metric.dialects = [
        {dialect: 'BIGQUERY', expression: 'COUNT(Customer.key)'},
        {dialect: 'SNOWFLAKE', expression: 'AVG("Customer"."lifetimeValue")'},
      ];
      return m;
    };
    // Two databases, so no one dialect, and every text counts.
    const two = twoTexts(irModel());
    two.entities[1].dataSource =
        '//spanner.googleapis.com/projects/p/instances/i/databases/db/tables/orders';
    // A source in no accepted form names no dialect either.
    const unnamed = twoTexts(irModel());
    unnamed.entities[1].dataSource = 'custom:orders';
    for (const m of [two, unnamed]) {
      const {model, report} = pruneUnavailable(m, 'operational');
      expect(metricNames(model)).toEqual(['order_count']);
      expect(report.droppedMetrics).toContainEqual(
          {name: 'avg_lifetime_value', reason: 'field Customer.lifetimeValue is unbound', field: 'Customer.lifetimeValue'});
    }
  });

  test('a metric with only vendor text is judged by the SQL --transpile writes', () => {
    // The BigQuery graph emits no Snowflake text, so pruning does not read
    // it. Pruning does read the BigQuery SQL that push's --transpile pass
    // writes into `expression`, because the graph emits that.
    const m = irModel();
    const metric = m.metrics!.find(x => x.name === 'avg_lifetime_value')!;
    metric.expression = undefined;
    metric.importedExpression = 'AVG("Customer"."lifetimeValue")';
    metric.importedDialect = 'SNOWFLAKE';
    const {model, report} = pruneUnavailable(m, 'operational');
    expect(metricNames(model)).toContain('avg_lifetime_value');
    expect(report.droppedMetrics.map(d => d.name))
        .not.toContain('avg_lifetime_value');
    metric.dialects =
        [{dialect: 'SNOWFLAKE', expression: 'AVG(Customer.lifetimeValue)'}];
    metric.importedExpression = 'AVG(Customer.lifetimeValue)';
    metric.expression = 'AVG(Customer.lifetimeValue)';
    const transpiled = pruneUnavailable(m, 'operational');
    expect(metricNames(transpiled.model)).toEqual(['order_count']);
    expect(transpiled.report.droppedMetrics).toContainEqual(
        {name: 'avg_lifetime_value', reason: 'field Customer.lifetimeValue is unbound', field: 'Customer.lifetimeValue'});
  });

  test("a metric is judged by the text its sources' dialect evaluates", () => {
    // The sources are BigQuery tables, so only the BIGQUERY text counts.
    const m = irModel();
    const metric = m.metrics!.find(x => x.name === 'avg_lifetime_value')!;
    metric.expression = undefined;
    metric.dialects = [
      {dialect: 'BIGQUERY', expression: 'COUNT(Customer.key)'},
      {dialect: 'SNOWFLAKE', expression: 'AVG("Customer"."lifetimeValue")'},
    ];
    const {model, report} = pruneUnavailable(m, 'operational');
    expect(metricNames(model)).toContain('avg_lifetime_value');
    expect(report.droppedMetrics.map(d => d.name)).not.toContain('avg_lifetime_value');
  });

  test('a metric whose SQL cannot be read is kept, with a warning', () => {
    const m = irModel();
    m.metrics!.find(x => x.name === 'avg_lifetime_value')!.expression =
        'AVG(Customer.lifetimeValue';
    const {model, report} = pruneUnavailable(m, 'operational');
    expect(metricNames(model)).toContain('avg_lifetime_value');
    expect(report.warnings).toEqual([
      "metric 'avg_lifetime_value': kcmd could not read its SQL, so the " +
      'fields it reads were not checked',
    ]);
  });

  test('a relationship keeps when its join fields are bound', () => {
    const {model} = pruneUnavailable(irModel(), 'operational');
    expect(relNames(model)).toEqual(['PlacedBy']);
  });

  test('an unbound field sharing a join column\'s name keeps the relationship', () => {
    // Join columns are physical columns, not fields: unbinding the field named
    // like the FK column drops that field and nothing else.
    const m = irModel();
    const customerKey =
        m.entities.find(e => e.name === 'Order')!.fields.find(
            f => f.name === 'customerKey')!;
    delete customerKey.expression;
    const {model, report} = pruneUnavailable(m, 'operational');
    expect(relNames(model)).toEqual(['PlacedBy']);
    expect(report.droppedRelationships).toEqual([]);
    expect(model.entities.find(e => e.name === 'Order')!.fields.map(f => f.name))
        .not.toContain('customerKey');
  });

  test('an unbound field sharing a key column\'s name keeps the entity', () => {
    const m = irModel();
    delete m.entities.find(e => e.name === 'Customer')!.fields.find(
        f => f.name === 'key')!.expression;
    const {model, report} = pruneUnavailable(m, 'operational');
    expect(model.entities.map(e => e.name)).toContain('Customer');
    expect(relNames(model)).toEqual(['PlacedBy']);
    expect(report.droppedRelationships).toEqual([]);
  });

  test('the input is never mutated', () => {
    const m = irModel();
    const before = JSON.stringify(m);
    pruneUnavailable(m, 'operational');
    expect(JSON.stringify(m)).toBe(before);
  });

  test(
      'a field carrying only an imported (untranspiled) expression is bound',
      () => {
        // A vendor-dialect field's column lives on `importedExpression` until
        // transpilation fills `expression`. It is bound -- it names a column --
        // so pruning must not mistake it for unbound and drop it (or its
        // metric).
        const m = irModel();
        const ltv = m.entities.find(e => e.name === 'Customer')!.fields.find(
            f => f.name === 'lifetimeValue')!;
        delete ltv.expression;
        ltv.importedExpression = 'c_ltv';
        ltv.importedDialect = 'SNOWFLAKE';
        const {model, report} = pruneUnavailable(m, 'operational');
        expect(fieldNames(model, 'Customer')).toContain('lifetimeValue');
        expect(report.unboundFields).not.toContain('Customer.lifetimeValue');
        expect(metricNames(model)).toContain('avg_lifetime_value');
      });

  test(
      'an unbound field sharing a key column\'s name drops only that field',
      () => {
        // Keys are physical columns, not fields, so unbinding the field named
        // like the key column leaves the entity and its relationship in place.
        const m = irModel();
        const key = m.entities.find(e => e.name === 'Customer')!.fields.find(
            f => f.name === 'key')!;
        delete key.expression;
        const {model, report} = pruneUnavailable(m, 'operational');
        expect(model.entities.map(e => e.name).sort())
            .toEqual(['Customer', 'Order']);
        expect(report.droppedEntities).toEqual([]);
        expect(
            model.entities.find(e => e.name === 'Customer')!.fields.map(
                f => f.name))
            .not.toContain('key');
        expect(relNames(model)).toEqual(['PlacedBy']);
      });

  test(
      'an abstract supertype survives pruning with its field names intact',
      () => {
        // An abstract entity has no table and no bindings by design: its fields
        // are column-less on purpose (they name the label its subtypes bind).
        // Pruning must NOT treat them as "unbound" and drop the entity for its
        // unbound key, or the shared label loses the signature the emitter
        // reads.
        const m: SemanticModel = {
      name: 'parties',
      entities: [
        {
          name: 'Party', dataSource: '', keys: ['id'], abstract: true,
          fields: [{name: 'id'}, {name: 'name'}],
        },
        {
          name: 'Customer', dataSource: 'proj.ds.customer', keys: ['id'],
          extends: ['Party'],
          fields: [
            {name: 'id', expression: 'c_custkey'},
            {name: 'name', expression: 'c_name'},
          ],
        },
      ],
      relationships: [],
      metrics: [],
    };
    const {model, report} = pruneUnavailable(m, 'default');
    // Party is kept, not dropped, and its field names remain.
    expect(model.entities.map(e => e.name)).toEqual(['Party', 'Customer']);
    expect(report.droppedEntities).toEqual([]);
    const party = model.entities.find(e => e.name === 'Party')!;
    expect(party.fields.map(f => f.name)).toEqual(['id', 'name']);
    // Its column-less fields are not reported as unbound.
    expect(report.unboundFields).toEqual([]);
  });
});


describe('an action a binding cannot perform is unavailable', () => {
  function irWithActions(): any {
    const m: any = irModel();
    m.actions = [
      {
        name: 'IssueCredit',
        parameters:
            [{name: 'order', type: 'String', concept: 'Order', field: 'key'}],
        affects: [{concept: 'Order', operation: 'modify'}],
        executor: {kind: 'sql', sql: {statements: ['UPDATE orders SET x = 1']}},
      },
      {name: 'Unperformable', parameters: []},
    ];
    return m;
  }

  // Unbinding a key makes the whole entity unavailable, which is the existing
  // rule this reuses to reach the actions over it.
  function withoutCustomer(m: any): any {
    delete m.entities.find((e: any) => e.name === 'Customer')
        .fields.find((f: any) => f.name === 'key')
        .expression;
    return m;
  }

  test('an action with no executor is dropped and reported', () => {
    const {model, report} = pruneUnavailable(irWithActions(), 'operational');
    expect(actionNames(model)).toEqual(['IssueCredit']);
    expect(report.droppedActions.find(d => d.name === 'Unperformable')?.reason)
        .toMatch(/no executor/);
  });

  test('an action whose executor is bound survives', () => {
    const {model} = pruneUnavailable(irWithActions(), 'operational');
    expect(actionNames(model)).toContain('IssueCredit');
  });

  test(
      'an action whose parameter projects from an unavailable entity survives',
      () => {
        // The parameter took a copy of the field's type and wording when the
        // model loaded, and it carries a value rather than a row, so at run
        // time it asks the unavailable entity for nothing. The executor is
        // bound and the call is performable, so dropping it would withhold a
        // write this binding can perform.
        const m = withoutCustomer(irWithActions());
        m.actions.push({
          name: 'RaiseLimit',
          parameters: [
            {
              name: 'customer',
              type: 'String',
              concept: 'Customer',
              field: 'key'
            },
          ],
          executor: {
            kind: 'sql',
            sql: {statements: ['UPDATE customer SET x = 1']},
          },
        });
        const {model, report} = pruneUnavailable(m, 'operational');
        expect(actionNames(model)).toContain('RaiseLimit');
        expect(report.droppedActions.find(d => d.name === 'RaiseLimit'))
            .toBeUndefined();
      });

  test('an action is kept when a field named like its concept\'s key is unbound', () => {
    // Pruning a field never makes an entity unavailable, so an action that
    // affects the entity keeps its place.
    const m = withoutCustomer(irWithActions());
    m.actions.push({
      name: 'Anonymize',
      parameters: [],
      affects: [{concept: 'Customer', operation: 'modify'}],
      executor: {kind: 'sql', sql: {statements: ['UPDATE customer SET x = 1']}},
    });
    const {model, report} = pruneUnavailable(m, 'operational');
    expect(actionNames(model)).toContain('Anonymize');
    expect(report.droppedActions.find(d => d.name === 'Anonymize'))
        .toBeUndefined();
  });

  test('a model that declares no actions reports none dropped', () => {
    const {report} = pruneUnavailable(irModel(), 'operational');
    expect(report.droppedActions).toEqual([]);
  });
});


describe('mergeProfile reads a profile file', () => {
  // A profile file in the sibling-file form: a top-level profile object.
  function prodProfile(): any {
    return {
      name: 'prod',
      entities: [
        {
          name: 'Customer',
          source: TBL('customer_prod'),
          primary_key: ['c_id'],
          unique_keys: [['c_email']],
          fields: [{name: 'name', expression: 'full_name'}],
          fields_exclude: ['availableCredit'],
        },
      ],
      relationships: [
        {name: 'PlacedBy', from_columns: ['cust_id'], to_columns: ['c_id']},
      ],
      metrics_exclude: ['avg_lifetime_value'],
    };
  }
  function inlineBound(): any {
    const doc = logicalDoc();
    fieldOf(doc, 'Customer', 'name').expression = 'inline_name';
    fieldOf(doc, 'Customer', 'lifetimeValue').expression = 'inline_ltv';
    fieldOf(doc, 'Customer', 'availableCredit').expression = 'inline_credit';
    return doc;
  }

  test('rebinds what it names and leaves the rest as the model file has it', () => {
    const {doc, error, excluded} =
        mergeProfile(inlineBound(), prodProfile(), 'prod');
    expect(error).toBeUndefined();
    const customer = entityOf(doc, 'Customer');
    expect(customer.source).toBe(TBL('customer_prod'));
    expect(customer.primary_key).toEqual(['c_id']);
    expect(customer.unique_keys).toEqual([['c_email']]);
    expect(fieldOf(doc, 'Customer', 'name').expression).toBe('full_name');
    expect(fieldOf(doc, 'Customer', 'lifetimeValue').expression)
        .toBe('inline_ltv');
    expect(fieldOf(doc, 'Customer', 'availableCredit').expression)
        .toBeUndefined();
    const rel = modelOf(doc).relationships[0];
    expect(rel.from_columns).toEqual(['cust_id']);
    expect(rel.to_columns).toEqual(['c_id']);
    // An excluded metric stays in the document, so a catalog push still
    // publishes it, and the merge returns the exclusion for pruning.
    expect(modelOf(doc).metrics.map((m: any) => m.name))
        .toContain('avg_lifetime_value');
    expect(excluded.filter(x => 'metric' in x))
        .toEqual([{model: modelOf(doc).name, metric: 'avg_lifetime_value'}]);
  });

  test('a profile that rebinds one of three bound fields leaves the other two', () => {
    const {doc, error} = mergeProfile(inlineBound(), {
      name: 'prod',
      entities: [{name: 'Customer', fields: [{name: 'name', expression: 'full_name'}]}],
    }, 'prod');
    expect(error).toBeUndefined();
    expect(fieldOf(doc, 'Customer', 'name').expression).toBe('full_name');
    expect(fieldOf(doc, 'Customer', 'lifetimeValue').expression).toBe('inline_ltv');
    expect(fieldOf(doc, 'Customer', 'availableCredit').expression).toBe('inline_credit');
  });

  test('metrics_exclude "*" excludes every metric and keeps each in the document', () => {
    const profile = {...prodProfile(), metrics_exclude: '*'};
    const {doc, error, excluded} = mergeProfile(inlineBound(), profile, 'prod');
    expect(error).toBeUndefined();
    const names = modelOf(doc).metrics.map((m: any) => m.name);
    expect(names.length).toBeGreaterThan(0);
    expect(excluded.flatMap(x => 'metric' in x ? [x.metric] : []))
        .toEqual(names);
  });

  test('a field expression may use the dialects form', () => {
    const profile = prodProfile();
    profile.entities[0].fields = [{
      name: 'name',
      expression: {dialects: [{dialect: 'BIGQUERY', expression: 'full_name'}]},
    }];
    const {doc, error} = mergeProfile(inlineBound(), profile, 'prod');
    expect(error).toBeUndefined();
    expect(fieldOf(doc, 'Customer', 'name').expression).toEqual(
        {dialects: [{dialect: 'BIGQUERY', expression: 'full_name'}]});
  });

  test('a field in both fields and fields_exclude is an error', () => {
    const profile = prodProfile();
    profile.entities[0].fields_exclude = ['name'];
    expect(mergeProfile(inlineBound(), profile, 'prod').error)
        .toMatch(/'Customer': field 'name' is in both 'fields' and 'fields_exclude'/);
  });

  test('an unknown name in fields_exclude, relationships or metrics_exclude is an error', () => {
    const a = prodProfile();
    a.entities[0].fields_exclude = ['ghost'];
    expect(mergeProfile(inlineBound(), a, 'prod').error)
        .toMatch(/field 'Customer.ghost' in 'fields_exclude'/);
    const b = prodProfile();
    b.relationships = [{name: 'Ghost', from_columns: ['a'], to_columns: ['b']}];
    expect(mergeProfile(inlineBound(), b, 'prod').error)
        .toMatch(/relationship 'Ghost' is not in the logical model/);
    const c = {...prodProfile(), metrics_exclude: ['ghost']};
    expect(mergeProfile(inlineBound(), c, 'prod').error)
        .toMatch(/metric 'ghost' in 'metrics_exclude'/);
  });

  test('"*" inside a metrics_exclude list is an error', () => {
    const profile = {...prodProfile(), metrics_exclude: ['*']};
    expect(mergeProfile(inlineBound(), profile, 'prod').error)
        .toMatch(/"\*" on its own/);
  });

  test('a logical declaration in a profile file is rejected', () => {
    for (const set of [
      (p: any) => { p.deployments = []; },
      (p: any) => { p.entities[0].description = 'x'; },
      (p: any) => { p.entities[0].extends = ['Order']; },
      (p: any) => { p.entities[0].fields[0].datatype = 'String'; },
      (p: any) => { p.relationships[0].from = 'Order'; },
    ]) {
      const profile = prodProfile();
      set(profile);
      expect(mergeProfile(inlineBound(), profile, 'prod').error)
          .toMatch(/which a profile may not set/);
    }
  });

  test('a profile file against a document with two models is an error', () => {
    const logical = inlineBound();
    logical.semantic_model.push({name: 'other', entities: []});
    expect(mergeProfile(logical, prodProfile(), 'prod').error)
        .toMatch(/binds one model/);
  });
});


describe('loadProfileFile', () => {
  const TEXT = `name: prod
entities:
  - name: orders
    source: bigquery.googleapis.com/projects/acme/datasets/prod/tables/orders
    primary_key: [o_id]
    unique_keys: [[o_ref]]
    fields:
      - name: amount
        expression: net_amount
      - name: region
        expression:
          dialects:
            - {dialect: BIGQUERY, expression: region_code}
    fields_exclude: [legacy_code]
relationships:
  - name: orders_to_customers
    from_columns: [cust_id]
    to_columns: [id]
metrics_exclude: [legacy_total]
actions:
  - name: cancel_order
    executor: {mcp: {server: //agentregistry.googleapis.com/projects/p/locations/l/mcpServers/s, tool: cancel}}
`;

  test('reads the section 2 example into a ProfileSpec with every part set', () => {
    const p = loadProfileFile(TEXT, 'prod');
    expect(p.name).toBe('prod');
    const orders = p.entities[0];
    expect(orders.source).toBe(
        'bigquery.googleapis.com/projects/acme/datasets/prod/tables/orders');
    expect(orders.primaryKey).toEqual(['o_id']);
    expect(orders.uniqueKeys).toEqual([['o_ref']]);
    expect(orders.fields![0]).toEqual({
      name: 'amount', expression: 'net_amount', stringForm: true,
      dialects: [{dialect: 'ANSI_SQL', expression: 'net_amount'}],
    });
    expect(orders.fields![1]).toEqual({
      name: 'region', expression: 'region_code', stringForm: false,
      dialects: [{dialect: 'BIGQUERY', expression: 'region_code'}],
    });
    expect(orders.fieldsExclude).toEqual(['legacy_code']);
    expect(p.relationships).toEqual(
        [{name: 'orders_to_customers', fromColumns: ['cust_id'], toColumns: ['id']}]);
    expect(p.metricsExclude).toEqual(['legacy_total']);
    expect(p.actions).toEqual([{
      name: 'cancel_order',
      executor: {
        kind: 'mcp',
        mcp: {
          server: '//agentregistry.googleapis.com/projects/p/locations/l/mcpServers/s',
          tool: 'cancel',
        },
      },
    }]);
  });

  test('metrics_exclude "*" reads back as "*"', () => {
    expect(loadProfileFile('name: prod\nmetrics_exclude: "*"\n', 'prod').metricsExclude)
        .toBe('*');
  });

  test('a logical key, "*" in a list, a wrong name and the old wrapper are rejected', () => {
    for (const key of ['description', 'datatype']) {
      expect(() => loadProfileFile(
                 `name: prod\nentities:\n  - {name: orders, ${key}: x}\n`, 'prod'))
          .toThrow(/which a profile may not set/);
    }
    expect(() => loadProfileFile('name: prod\nmetrics_exclude: ["*"]\n', 'prod'))
        .toThrow(/on its own/);
    expect(() => loadProfileFile('name: staging\n', 'prod')).toThrow(/does not match/);
    expect(() => loadProfileFile('semantic_model: []\n', 'prod'))
        .toThrow(/not a profile file/);
  });
});


describe('validateProfileCompleteness', () => {
  test('a complete profile passes', () => {
    expect(validateProfileCompleteness(irModel(), profile())).toEqual([]);
  });

  test('unknown entity, field, relationship and metric names are reported', () => {
    const errors = validateProfileCompleteness(irModel(), profile({
      entities: [...profile().entities, {name: 'Ghost', source: BQ('g')}],
      relationships: [{name: 'Nope', fromColumns: ['a'], toColumns: ['b']}],
      metricsExclude: ['missing'],
    }));
    expect(errors.join('\n')).toContain("entity 'Ghost' is not in the logical model");
    expect(errors.join('\n')).toContain("relationship 'Nope' is not in the logical model");
    expect(errors.join('\n')).toContain("metric 'missing' in 'metrics_exclude'");
    const fieldErr = validateProfileCompleteness(irModel(), profile({
      entities: [{...profile().entities[0], fieldsExclude: ['ghost']}, profile().entities[1]],
    }));
    expect(fieldErr.join('\n'))
        .toContain("field 'Customer.ghost' in 'fields_exclude' is not in the logical model");
  });

  test('a concrete entity with no source is reported', () => {
    const errors = validateProfileCompleteness(irModel(), profile({
      entities: [profile().entities[0]],
    }));
    expect(errors.join('\n')).toContain("entity 'Order' has no source");
  });

  test('leaves out, when applied, the rules push checks on the applied model', () => {
    const p = profile({
      entities: [
        {...profile().entities[0], primaryKey: ['LOWER(c_custkey)'],
         fields: [...CUSTOMER_COLUMNS, {name: 'lifetimeValue', expression: 'Order.total'}]},
        {...profile().entities[1], source: undefined},
      ],
    });
    const errors = validateProfileCompleteness(irModel(), p).join('\n');
    expect(errors).toContain("key column 'LOWER(c_custkey)' is not a physical");
    expect(errors).toContain("field 'Customer.lifetimeValue' reads entity 'Order'");
    expect(validateProfileCompleteness(irModel(), p, [], {applied: true})).toEqual([
      "profile 'prod': entity 'Order' has no source in this profile",
    ]);
  });

  test('BigQuery datasets are one database; two Spanner databases are not', () => {
    const twoDatasets = profile({
      entities: [
        {...profile().entities[0], source: 'bigquery.googleapis.com/projects/p/datasets/raw/tables/customer'},
        {...profile().entities[1], source: 'bigquery.googleapis.com/projects/p/datasets/curated/tables/orders'},
      ],
    });
    expect(validateProfileCompleteness(irModel(), twoDatasets)).toEqual([]);
    const SP = (db: string, t: string) =>
        `spanner.googleapis.com/projects/p/instances/i/databases/${db}/tables/${t}`;
    const twoSpanner = profile({
      entities: [
        {...profile().entities[0], source: SP('a', 'Customer')},
        {name: 'Order', source: SP('b', 'Orders')},
      ],
    });
    expect(validateProfileCompleteness(irModel(), twoSpanner).join('\n'))
        .toContain('more than one database');
    const mixed = profile({
      entities: [
        {...profile().entities[0], source: BQ('customer')},
        {name: 'Order', source: SP('a', 'Orders')},
      ],
    });
    expect(validateProfileCompleteness(irModel(), mixed).join('\n'))
        .toContain('more than one database');
  });

  test('a relationship with no, uneven or non-column join columns is reported', () => {
    expect(validateProfileCompleteness(irModel(), profile({
      relationships: [{name: 'PlacedBy', fromColumns: [], toColumns: []}],
    })).join('\n')).toContain("relationship 'PlacedBy' has no join columns");
    expect(validateProfileCompleteness(irModel(), profile({
      relationships: [{name: 'PlacedBy', fromColumns: ['a', 'b'], toColumns: ['c']}],
    })).join('\n')).toContain('from_columns (2) and to_columns (1) have different lengths');
    expect(validateProfileCompleteness(irModel(), profile({
      relationships: [{name: 'PlacedBy', fromColumns: ['LOWER(a)'], toColumns: ['c']}],
    })).join('\n')).toContain('is not a physical column name');
  });

  // The model file states Customer's key, leaves lifetimeValue unbound, and
  // binds key and name to columns of its own table.
  test('a binding with only a source misses its key, the unbound field and the column fields', () => {
    expect(validateProfileCompleteness(irModel(), profile({
      entities: [{name: 'Customer', source: BQ('customer')}, profile().entities[1]],
    }))).toEqual([
      noKeys('primary_key'),
      "profile 'prod': field 'Customer.lifetimeValue' has no binding in the " +
          "model file; bind it in 'fields' or leave it out in 'fields_exclude'",
      readsColumn('Customer.key', 'c_custkey'),
      readsColumn('Customer.name', 'c_name'),
    ]);
  });

  test('a field depending on an excluded one must be excluded or rebound, transitively', () => {
    const m = irModel();
    const customer = m.entities[0];
    customer.fields.push({name: 'doubled', expression: 'Customer.name * 2'});
    customer.fields.push({name: 'quadrupled', expression: 'Customer.doubled * 2'});
    const excludingName = (...more: Field[]) => profile({
      entities: [{
        ...profile().entities[0], fieldsExclude: ['name'],
        fields: [CUSTOMER_COLUMNS[0], column('lifetimeValue', 'ltv'), ...more],
      }, profile().entities[1]],
      metricsExclude: '*',
    });
    const errors = validateProfileCompleteness(m, excludingName());
    expect(errors.join('\n')).toContain(
        "field 'Customer.doubled' depends on 'Customer.name'");
    expect(errors.join('\n')).toContain(
        "field 'Customer.quadrupled' depends on 'Customer.name'");
    // quadrupled reads only fields, so the profile need not restate it.
    expect(validateProfileCompleteness(
               m, excludingName(column('doubled', 'raw_doubled'))))
        .toEqual([]);
  });

  test('a metric reaching an excluded field is named with the field', () => {
    const entities = [CUSTOMER_WITHOUT_LTV, profile().entities[1]];
    const errors = validateProfileCompleteness(irModel(), profile({entities}));
    expect(errors).toEqual([
      "profile 'prod': metric 'avg_lifetime_value' reaches " +
      "'Customer.lifetimeValue', which this profile excludes; add " +
      "'avg_lifetime_value' to 'metrics_exclude'",
    ]);
    expect(validateProfileCompleteness(irModel(), profile({
      entities, metricsExclude: ['avg_lifetime_value'],
    }))).toEqual([]);
  });

  test('a metric is read in its own dialect', () => {
    // The profile's sources are AlloyDB tables, read as PostgreSQL. In
    // PostgreSQL, double quotes name a column, so this text reads the excluded
    // field.
    const PG = (t: string) =>
        `alloydb.googleapis.com/projects/acme/locations/us/clusters/c/databases/db/schemas/public/tables/${t}`;
    const m = irModel();
    const metric = m.metrics!.find(x => x.name === 'avg_lifetime_value')!;
    metric.expression = undefined;
    metric.dialects =
        [{dialect: 'ALLOYDB', expression: 'AVG("Customer"."lifetimeValue")'}];
    const errors = validateProfileCompleteness(m, profile({
      entities: [{name: 'Customer', source: PG('customer'), fieldsExclude: ['lifetimeValue']},
                 {name: 'Order', source: PG('orders')}],
    }));
    expect(errors.join('\n'))
        .toContain("metric 'avg_lifetime_value' reaches 'Customer.lifetimeValue'");
  });

  test('a metric with no text for the profile\'s dialect is reported', () => {
    const m = irModel();
    const metric = m.metrics!.find(x => x.name === 'avg_lifetime_value')!;
    metric.expression = undefined;
    metric.dialects =
        [{dialect: 'POSTGRES', expression: 'AVG("Customer"."lifetimeValue")'}];
    const message = "metric 'avg_lifetime_value' has no expression for BIGQUERY " +
        "or ANSI_SQL, and this profile's sources are BIGQUERY; give it one, or " +
        "add it to 'metrics_exclude'";
    expect(validateProfileCompleteness(m, profile()).join('\n')).toContain(message);
    expect(validateProfileCompleteness(
               m, profile({metricsExclude: ['avg_lifetime_value']})).join('\n'))
        .not.toContain('avg_lifetime_value');
  });

  test('with sources in two databases, the dependency rules read every text', () => {
    const SPANNER = (t: string) =>
        `spanner.googleapis.com/projects/p/instances/i/databases/db/tables/${t}`;
    const named = (orders: string) => profile({
      entities: [
        {
          name: 'Customer', source: BQ('customer'), fieldsExclude: ['lifetimeValue'],
          fields: [{
            name: 'name',
            dialects: [
              {dialect: 'BIGQUERY', expression: 'c_name'},
              {dialect: 'ANSI_SQL', expression: 'Customer.lifetimeValue'},
            ],
          }],
        },
        {name: 'Order', source: orders},
      ],
    });
    const dependsOn = "field 'Customer.name' depends on 'Customer.lifetimeValue'";
    expect(validateProfileCompleteness(irModel(), named(BQ('orders'))).join('\n'))
        .not.toContain(dependsOn);
    expect(validateProfileCompleteness(irModel(), named(SPANNER('orders'))).join('\n'))
        .toContain(dependsOn);
  });

  test("an ANSI_SQL text is read as the profile's own SQL by every rule", () => {
    // The generic parser cannot read a hex literal; the BigQuery one can, so the
    // text is checked, and reading another entity is reported.
    const warnings: string[] = [];
    const errors = validateProfileCompleteness(irModel(), profile({
      entities: [
        {
          name: 'Customer', source: BQ('customer'),
          fields: [
            {name: 'lifetimeValue', expression: 'ltv'},
            {name: 'name', dialects: [{dialect: 'ANSI_SQL', expression: 'IF(Order.key = 0x1F, 1, 0)'}]},
          ],
        },
        profile().entities[1],
      ],
    }), warnings);
    expect(errors.join('\n')).toContain("field 'Customer.name' reads entity 'Order'");
    expect(warnings).toEqual([]);
  });

  test('an imported text is read in its imported dialect', () => {
    // The profile's sources are AlloyDB tables, so it evaluates the AlloyDB
    // text.
    const PG = (t: string) =>
        `alloydb.googleapis.com/projects/acme/locations/us/clusters/c/databases/db/schemas/public/tables/${t}`;
    const m = irModel();
    const metric = m.metrics!.find(x => x.name === 'avg_lifetime_value')!;
    // The metric as a load gives it: an AlloyDB text, kept in its list too.
    metric.expression = undefined;
    metric.importedExpression = 'AVG("Customer"."lifetimeValue")';
    metric.importedDialect = 'ALLOYDB';
    metric.dialects =
        [{dialect: 'ALLOYDB', expression: 'AVG("Customer"."lifetimeValue")'}];
    const errors = validateProfileCompleteness(m, profile({
      entities: [{name: 'Customer', source: PG('customer'), fieldsExclude: ['lifetimeValue']},
                 {name: 'Order', source: PG('orders')}],
    }));
    expect(errors.join('\n'))
        .toContain("metric 'avg_lifetime_value' reaches 'Customer.lifetimeValue'");
  });

  test('a profile field whose SQL cannot be read is skipped, with a warning', () => {
    const warnings: string[] = [];
    const errors = validateProfileCompleteness(irModel(), profile({
      entities: [
        {...profile().entities[0],
         fields: [...CUSTOMER_COLUMNS, {name: 'lifetimeValue', expression: 'SUM(ltv'}]},
        profile().entities[1],
      ],
    }), warnings);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      "profile 'prod': kcmd could not read the SQL of field " +
      "'Customer.lifetimeValue', so the fields it reads were not checked",
    ]);
  });

  test('an expression the parser cannot read is skipped, with a warning', () => {
    const m = irModel();
    m.metrics!.find(x => x.name === 'avg_lifetime_value')!.expression =
        'AVG(Customer.lifetimeValue';
    const warnings: string[] = [];
    const errors = validateProfileCompleteness(m, profile({
      entities: [CUSTOMER_WITHOUT_LTV, profile().entities[1]],
    }), warnings);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      "profile 'prod': kcmd could not read the SQL of metric " +
      "'avg_lifetime_value', so the fields it reads were not checked",
    ]);
  });

  test('with ownSqlOnly, warns about the model file SQL the caller does not read as this profile does', () => {
    // BigQuery reads a hex literal and PostgreSQL does not.
    const AL = (t: string) =>
        `alloydb.googleapis.com/projects/p/locations/us/clusters/c/databases/db/schemas/public/tables/${t}`;
    const m = irModel();
    m.entities[0].fields.push({name: 'code', expression: 'Customer.name + 0x1F'});
    const pg = profile({
      name: 'pg',
      entities: [
        {name: 'Customer', source: AL('customer'),
         fields: [{name: 'lifetimeValue', expression: 'ltv'}], fieldsExclude: ['name']},
        {name: 'Order', source: AL('orders')},
      ],
    });
    const warned = (ownSqlOnly: CompletenessOptions['ownSqlOnly']) => {
      const warnings: string[] = [];
      validateProfileCompleteness(m, pg, warnings, {ownSqlOnly});
      return warnings;
    };
    const unread =
        "profile 'pg': kcmd could not read the SQL of field 'Customer.code', " +
        'so the fields it reads were not checked';
    // The caller reads the model file's SQL as BigQuery.
    expect(warned({dialect: sourcesDialect(m)})).toEqual([unread]);
    // The caller reads it as PostgreSQL too, and warns about it itself.
    expect(warned({dialect: 'ALLOYDB'})).toEqual([]);
    // The caller applies a profile that rebinds the field, so it never reads
    // the model file's text.
    expect(warned({dialect: 'ALLOYDB', rebound: ['Customer.code']}))
        .toEqual([unread]);
    // A rebound field counts only by its exact entity and field names.
    expect(warned({
      dialect: 'ALLOYDB',
      rebound: ['Customer.cod', 'Customer.code2', 'Order.code'],
    })).toEqual([]);
  });
});


describe('validateProfileConsistency', () => {
  const p = (name: string, extra: Partial<ProfileSpec> = {}): ProfileSpec =>
      ({name, entities: [], relationships: [], ...extra});

  test('profiles may state keys of different shapes for one entity', () => {
    const m = irModel();
    m.entities[1].keys = [];
    // d states an empty primary key, so its join is checked against the model
    // file's key, which its to_columns cover.
    expect(validateProfileConsistency(m, [
      p('a', {entities: [{name: 'Order', primaryKey: ['id']}]}), p('b'),
      p('c', {entities: [{name: 'Order', uniqueKeys: [['tenant', 'oid']]}]}),
      p('d', {entities: [{name: 'Customer', primaryKey: []}],
              relationships: [{name: 'PlacedBy', fromColumns: ['o_custkey'], toColumns: ['c_custkey']}]}),
    ])).toEqual([]);
  });

  test('cardinality may not vary by profile', () => {
    // PlacedBy's to_columns cover Customer's primary key in the model file;
    // profile b points them at a column that is no key.
    const errors = validateProfileConsistency(irModel(), [
      p('a'),
      p('b', {relationships: [{name: 'PlacedBy', fromColumns: ['o_c'], toColumns: ['email']}]}),
    ]);
    expect(errors.join('\n')).toContain(
        "relationship 'PlacedBy': profile 'b' joins on to_columns [\"email\"], " +
        "which cover no primary or unique key of 'Customer'");
    expect(validateProfileConsistency(irModel(), [
      p('b', {
        relationships: [{name: 'PlacedBy', fromColumns: ['o_c'], toColumns: ['c_id']}],
        entities: [{name: 'Customer', primaryKey: ['c_id']}],
      }),
    ])).toEqual([]);
  });
});


describe('profile completeness: sources, keys, relationships and inheritance', () => {
  const base = profile;

  test('a field listed with no expression does not count as bound', () => {
    const errors = validateProfileCompleteness(irModel(), base({
      entities: [{name: 'Customer', source: BQ('customer'), fields: [{name: 'lifetimeValue'}]},
                 {name: 'Order', source: BQ('orders')}],
    }));
    // One mistake, one error: the entry binds nothing.
    expect(errors.join('\n'))
        .toContain("field 'lifetimeValue' has no 'expression'");
    expect(errors.join('\n')).not.toContain('has no binding');
  });

  test('a bare table name and an unknown form are not sources', () => {
    const bare = base({entities: [{...base().entities[0], source: 'acme.prod.customer'},
                                  base().entities[1]]});
    expect(validateProfileCompleteness(irModel(), bare).join('\n'))
        .toContain("bare table name 'acme.prod.customer' is not a valid source");
    const unknown = base({entities: [{...base().entities[0], source: '//trino.example.com/x'},
                                     base().entities[1]]});
    expect(validateProfileCompleteness(irModel(), unknown).join('\n'))
        .toContain("source '//trino.example.com/x' is not a valid table reference");
  });

  test('Spanner and AlloyDB sources classify by database', () => {
    const sp = (project: string, db: string, t: string) =>
        `spanner.googleapis.com/projects/${project}/instances/i/databases/${db}/tables/${t}`;
    const alloy = (path: string) =>
        `alloydb.googleapis.com/projects/p/locations/us/clusters/c/${path}`;
    const bound = (customer: string, order: string) => base({entities: [
      {...base().entities[0], source: customer}, {...base().entities[1], source: order},
    ]});
    expect(validateProfileCompleteness(
               irModel(), bound(sp('p', 'db', 'Customer'), sp('p', 'db', 'Orders'))))
        .toEqual([]);
    expect(validateProfileCompleteness(
               irModel(), bound(sp('google.com:p', 'db', 'Customer'),
                                sp('google.com:p', 'db2', 'Orders'))).join('\n'))
        .toContain('more than one database');
    const customer = alloy('databases/db/schemas/public/tables/customer');
    expect(validateProfileCompleteness(
               irModel(), bound(customer, alloy('databases/db/schemas/public/tables/orders'))))
        .toEqual([]);
    // A database belongs to its cluster, so the instance-based name names no
    // real table.
    expect(validateProfileCompleteness(
               irModel(), bound(customer, alloy('instances/i/databases/db/tables/orders')))
               .join('\n'))
        .toContain('uses the legacy instance-based AlloyDB URI');
  });

  test('binding an abstract entity is rejected', () => {
    const m = irModel();
    m.entities.push({name: 'Party', dataSource: '', keys: [], abstract: true, fields: []});
    const errors = validateProfileCompleteness(m, base({
      entities: [...base().entities, {name: 'Party', source: BQ('party')}],
    }));
    expect(errors.join('\n')).toContain("entity 'Party' is abstract");
  });

  test('inherited fields count, and a broken hierarchy falls back to declared fields', () => {
    const m = irModel();
    m.entities.push({name: 'Party', dataSource: '', keys: [], abstract: true,
                     fields: [{name: 'label'}]});
    m.entities[0].extends = ['Party'];
    expect(validateProfileCompleteness(m, base()).join('\n'))
        .toContain("field 'Customer.label' has no binding");
    expect(validateProfileCompleteness(m, base({
      entities: [{...base().entities[0], fieldsExclude: ['label']}, base().entities[1]],
    }))).toEqual([]);
    expect(validateProfileCompleteness(m, base({
      entities: [{...base().entities[0],
                  fields: [...base().entities[0].fields!, {name: 'label', expression: 'lbl'}]},
                 base().entities[1]],
    }))).toEqual([]);
    m.entities[0].extends = ['Ghost'];
    expect(() => validateProfileCompleteness(m, base())).not.toThrow();
  });

  test('where the model file states keys, a profile states its own, of any shape', () => {
    const m = irModel();
    m.entities[0].uniqueKeys = [['email']];
    const customer = (keys: Partial<ProfileEntityBinding>) =>
        validateProfileCompleteness(m, base({
          entities: [{...base().entities[0], ...keys}, base().entities[1]],
        }));
    expect(customer({primaryKey: ['a', 'b'], uniqueKeys: [['c', 'd'], ['e']]}))
        .toEqual([]);
    expect(customer({})).toEqual([noKeys('unique_keys')]);
    expect(customer({primaryKey: [], uniqueKeys: []}))
        .toEqual([noKeys('primary_key or unique_keys')]);
    expect(customer({uniqueKeys: [[]]})).toEqual([noKeys('unique_keys')]);
    // An empty unique key counts as none.
    m.entities[0].uniqueKeys = [[]];
    expect(customer({})).toEqual([]);
  });

  test('association relationships are not checked for join columns', () => {
    const m = irModel();
    m.relationships.push({
      name: 'Tags', source: {entity: 'Order', columns: []}, destination: {entity: 'Customer', columns: []},
      association: {dataSource: 'p.d.tags', keys: [], sourceColumns: [], destinationColumns: []},
    } as any);
    expect(validateProfileCompleteness(m, base())).toEqual([]);
  });

  test('metrics_exclude "*" suppresses a metric reaching an excluded field', () => {
    const profile = base({
      entities: [CUSTOMER_WITHOUT_LTV, base().entities[1]], metricsExclude: '*',
    });
    expect(validateProfileCompleteness(irModel(), profile)).toEqual([]);
  });

  test('a relationship side the profile leaves to the model file is rejected', () => {
    for (const relationships of [
      [{name: 'PlacedBy', fromColumns: ['o_cust'], toColumns: []}],
      [],
    ]) {
      expect(validateProfileCompleteness(irModel(), base({relationships})).join('\n'))
          .toContain("relationship 'PlacedBy' has no join columns in this profile");
    }
  });

  test('cardinality: a model file with no join columns is left out; a join on a unique key counts', () => {
    const m = irModel();
    m.relationships[0].destination.columns = [];
    m.relationships[0].source.columns = [];
    const agree = [
      {name: 'a', entities: [], relationships: [{name: 'PlacedBy', fromColumns: ['x'], toColumns: ['key']}]},
      {name: 'b', entities: [], relationships: [{name: 'PlacedBy', fromColumns: ['y'], toColumns: ['key']}]},
    ];
    expect(validateProfileConsistency(m, agree)).toEqual([]);
    const m2 = irModel();
    m2.entities[0].uniqueKeys = [['email']];
    const errors = validateProfileConsistency(m2, [
      {name: 'a', entities: [], relationships: [{name: 'PlacedBy', fromColumns: ['x'], toColumns: ['email']}]},
    ]);
    expect(errors).toEqual([]);
  });

  test('loadProfileFile reads actions, rejects bad shapes, and matches dialects exactly', () => {
    const p = loadProfileFile(`name: prod
actions:
  - name: Cancel
    executor: {sql: {statements: ["UPDATE t SET x = 1"]}}
  - name: Read
    executor: null
entities:
  - name: orders
    fields:
      - name: region
        expression: {dialects: [{dialect: BIGQUERY, expression: r}]}
`, 'prod');
    expect(p.actions).toEqual([
      {name: 'Cancel', executor: {kind: 'sql', sql: {statements: ['UPDATE t SET x = 1']}}},
      {name: 'Read', executor: null},
    ]);
    expect(p.entities[0].fields![0].expression).toBe('r');
    expect(p.entities[0].fields![0].dialects).toEqual([{dialect: 'BIGQUERY', expression: 'r'}]);
    expect(() => loadProfileFile('name: prod\nentities:\n  -\n', 'prod')).toThrow(/not a mapping/);
    expect(() => loadProfileFile('name: prod\nversion: "0.2.0.dev0/google"\n', 'prod'))
        .toThrow("profile 'prod' sets 'version'; a profile file takes its version from the model file beside it");
    expect(() => loadProfileFile(
               'name: prod\nentities:\n  - {name: o, fields: [{name: a}]}\n', 'prod'))
        .toThrow("field 'a' has no 'expression'; bind it with one, or list it in 'fields_exclude'");
    expect(() => loadProfileFile('name: prod\nentities:\n  - {name: o, primary_key: c_id}\n', 'prod'))
        .toThrow(/must be a list/);
    expect(() => loadProfileFile(
               'name: prod\nentities:\n  - {name: o, fields: [{name: a, expression: x}], fields_exclude: [a]}\n',
               'prod'))
        .toThrow(/in both 'fields' and 'fields_exclude'/);
  });

  test('the merge binds an inherited field by redeclaring it with only a binding', () => {
    const logical = {
      semantic_model: [{
        name: 'm',
        entities: [
          {name: 'Party', abstract: true, fields: [{name: 'label', datatype: 'String'}]},
          {name: 'Person', extends: ['Party'], primary_key: ['id'], fields: [{name: 'id'}]},
        ],
      }],
    };
    const {doc, error} = mergeProfile(logical, {
      name: 'prod',
      entities: [{name: 'Person', fields: [{name: 'label', expression: 'display_name'}]}],
    }, 'prod');
    expect(error).toBeUndefined();
    const person = (doc as any).semantic_model[0].entities[1];
    expect(person.fields).toEqual([{name: 'id'}, {name: 'label', expression: 'display_name'}]);
    const excluded = mergeProfile(logical, {
      name: 'prod', entities: [{name: 'Person', fields_exclude: ['label']}],
    }, 'prod');
    expect(excluded.error).toBeUndefined();
  });
});


describe('profile overlay edges', () => {
  const BQ = (t: string) => `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
  const logical = () => ({
    semantic_model: [{
      name: 'm',
      entities: [
        {name: 'customer', source: BQ('customer'), primary_key: ['id'],
         fields: [{name: 'id', expression: 'id'}, {name: 'email', expression: 'email'}]},
        {name: 'vip', extends: ['customer'], source: BQ('vip'), primary_key: ['id'],
         fields: [{name: 'perk', expression: 'perk'}]},
        {name: 'orders', source: BQ('orders'), primary_key: ['o_id'],
         fields: [{name: 'o_id', expression: 'o_id'}]},
      ],
      relationships: [{name: 'placed_by', from: 'orders', to: 'vip',
                       from_columns: ['cust'], to_columns: ['id']}],
    }],
  });

  test('the legacy wrapper takes the new entity and relationship keys', () => {
    const {doc, error} = mergeProfile(logical(), {
      semantic_model: [{
        name: 'm', version: '0.2.0.dev0/google', deployment_target: 'x',
        entities: [{name: 'orders', source: BQ('orders2'), primary_key: ['oid'],
                    unique_keys: [['ref']]}],
        relationships: [{name: 'placed_by', from_columns: ['c'], to_columns: ['vid']}],
      }],
    }, 'prod');
    expect(error).toBeUndefined();
    const m = (doc as any).semantic_model[0];
    expect(m.deployment_target).toBe('x');
    expect(m.entities[2].primary_key).toEqual(['oid']);
    expect(m.entities[2].unique_keys).toEqual([['ref']]);
    expect(m.relationships[0].from_columns).toEqual(['c']);
    expect(m.relationships[0].to_columns).toEqual(['vid']);
    const withMetrics = logical() as any;
    withMetrics.semantic_model[0].metrics = [{name: 'n', expression: 'COUNT(orders.o_id)'}];
    const excluded = mergeProfile(withMetrics, {
      semantic_model: [{name: 'm', metrics_exclude: '*'}],
    }, 'prod');
    expect(excluded.error).toBeUndefined();
    expect((excluded.doc as any).semantic_model[0].metrics.length).toBe(1);
    expect(excluded.excluded).toEqual([{model: 'm', metric: 'n'}]);
  });

  test('deployment_target at the top of a profile file is rejected', () => {
    expect(mergeProfile(logical(), {name: 'prod', deployment_target: 'x'}, 'prod').error)
        .toMatch(/sets 'deployment_target', which a profile may not set/);
    expect(() => loadProfileFile('name: prod\ndeployment_target: x\n', 'prod'))
        .toThrow(/which a profile may not set/);
  });

  test('a subtype may exclude a field a concrete ancestor binds; the ancestor keeps it', () => {
    const merged = mergeProfile(logical(), {
      name: 'prod', entities: [{name: 'vip', fields_exclude: ['email']}],
    }, 'prod');
    expect(merged.error).toBeUndefined();
    expect(merged.excluded).toEqual([{model: 'm', entity: 'vip', field: 'email'}]);
    // The ancestor's binding stays in the document, for the ancestor.
    const customer = (merged.doc as any).semantic_model[0].entities[0];
    expect(customer.fields.find((f: any) => f.name === 'email').expression).toBe('email');
    const model: SemanticModel = {
      name: 'm',
      entities: [
        {name: 'customer', dataSource: 'p.d.customer', keys: ['id'],
         fields: [{name: 'id', expression: 'id'}, {name: 'email', expression: 'email'}]},
        {name: 'vip', extends: ['customer'], dataSource: 'p.d.vip', keys: ['id'], fields: []},
      ],
      relationships: [],
    } as any;
    expect(validateProfileCompleteness(model, {
      name: 'prod',
      entities: [keyedById('customer', BQ('customer'), column('email')),
                 {...keyedById('vip', BQ('vip')), fieldsExclude: ['email']}],
      relationships: [],
    })).toEqual([]);
  });

  test('a YAML-only tag in a custom ai_context member survives the merge as text', () => {
    const logicalText = `version: "0.2.0.dev0/google"
semantic_model:
  - name: m
    entities:
      - name: orders
        ai_context:
          custom:
            reviewed: !!timestamp 2025-01-01
        fields: [{name: id, datatype: Integer}]
`;
    const merged = mergeProfileOntoDoc(logicalText, `name: prod
entities:
  - name: orders
    source: ${BQ('orders')}
    fields: [{name: id, expression: id}]
`, 'prod');
    if ('error' in merged) throw new Error(merged.error);
    const {models} = loadModels(merged.text, {bindingOptional: true});
    expect(models[0].entities[0].aiContext)
        .toEqual({additionalProperties: {reviewed: '2025-01-01'}});
  });

  test('a dialect list with no BIGQUERY or ANSI_SQL entry still binds the field', () => {
    const p = loadProfileFile(`name: prod
entities:
  - name: orders
    fields:
      - name: amount
        expression:
          dialects:
            - {dialect: SPANNER, expression: amt}
`, 'prod');
    const f = p.entities[0].fields![0];
    expect(f).toEqual({
      name: 'amount', importedExpression: 'amt', importedDialect: 'SPANNER',
      dialects: [{dialect: 'SPANNER', expression: 'amt'}], stringForm: false,
    });
    expect(isFieldBound(f)).toBe(true);
    expect(() => loadProfileFile(
               'name: prod\nentities:\n  - name: o\n    fields:\n      - {name: a, expression: {dialects: []}}\n',
               'prod'))
        .toThrow("field 'a': 'expression': dialects: Too small");
  });
});


describe('profile merge: exclusions, duplicates and catalog names', () => {
  // vip extends customer; both have their own table.
  const logical = (emailInline: boolean) => ({
    semantic_model: [{
      name: 'm',
      entities: [
        {name: 'customer', source: 'bigquery.googleapis.com/projects/p/datasets/d/tables/customer', primary_key: ['id'],
         fields: [{name: 'id', expression: 'id'},
                  emailInline ? {name: 'email', expression: 'email'} : {name: 'email'}]},
        {name: 'vip', extends: ['customer'], source: 'bigquery.googleapis.com/projects/p/datasets/d/tables/vip', primary_key: ['id'], fields: []},
      ],
    }],
  });

  test('an exclusion applies to the entity that names it, whatever the entry order', () => {
    const both = [{name: 'customer', fields_exclude: ['email']},
                  {name: 'vip', fields_exclude: ['email']}];
    for (const order of [(x: any[]) => x, (x: any[]) => [...x].reverse()]) {
      const r = mergeProfile(logical(true), {name: 'prod', entities: order(both)}, 'prod');
      expect(r.error).toBeUndefined();
      expect(r.excluded.map(x => 'entity' in x ? x.entity : '').sort())
          .toEqual(['customer', 'vip']);
    }
    // vip excluding a field customer binds only in the profile is allowed too.
    expect(mergeProfile(logical(false), {name: 'prod', entities: [
      {name: 'vip', fields_exclude: ['email']},
      {name: 'customer', fields: [{name: 'email', expression: 'mail'}]},
    ]}, 'prod').error).toBeUndefined();
  });

  test('an entity or relationship listed twice is rejected', () => {
    expect(mergeProfile(logical(true), {
      name: 'prod', entities: [{name: 'vip'}, {name: 'vip'}],
    }, 'prod').error).toContain("'entities' lists 'vip' twice");
    expect(() => loadProfileFile(
               'name: prod\nrelationships:\n  - {name: r, from_columns: [a], to_columns: [b]}\n' +
                   '  - {name: r, from_columns: [c], to_columns: [d]}\n',
               'prod'))
        .toThrow("lists 'r' twice");
  });

  test('a profile entry with no name is rejected', () => {
    expect(() => loadProfileFile('name: prod\nentities:\n  - {source: x}\n', 'prod'))
        .toThrow("has no 'name'");
    expect(() => loadProfileFile(
               'name: prod\nentities:\n  - name: o\n    fields:\n      - {expression: x}\n',
               'prod'))
        .toThrow("has no 'name'");
  });
});


describe('completeness sees the model as the profile does', () => {
  const BQ = (t: string) => `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
  // vip extends customer; both have their own table.
  const model = (emailInline: boolean): SemanticModel => ({
    name: 'm',
    entities: [
      {name: 'customer', dataSource: 'p.d.c', keys: ['id'],
       fields: [{name: 'id', expression: 'id'},
                emailInline ? {name: 'email', expression: 'email'} : {name: 'email'}]},
      {name: 'vip', extends: ['customer'], dataSource: 'p.d.v', keys: ['id'], fields: []},
    ],
    relationships: [],
    metrics: [{name: 'vip_emails', expression: 'COUNT(vip.email)', entity: 'vip'}],
  } as any);
  // Each entity states its key and restates id and email, unless a test gives
  // its own fields.
  const spec = (entities: any[]): ProfileSpec => ({
    name: 'prod', relationships: [],
    entities: entities.map(e => ({
      primaryKey: ['id'], fields: [ID, column('email')], ...e,
    })),
  });

  test('an exclusion on an ancestor leaves its descendants\' field in place', () => {
    // customer excludes email; vip still reads email from its own table.
    expect(validateProfileCompleteness(model(true), spec([
      {name: 'customer', source: BQ('c'), fields: [ID], fieldsExclude: ['email']},
      {name: 'vip', source: BQ('v')},
    ]))).toEqual([]);
    // Excluding it on vip itself does reach vip's metric.
    expect(validateProfileCompleteness(model(true), spec([
      {name: 'customer', source: BQ('c')},
      {name: 'vip', source: BQ('v'), fields: [ID], fieldsExclude: ['email']},
    ]))).toEqual([
      "profile 'prod': metric 'vip_emails' reaches 'vip.email', which this profile " +
          "excludes; add 'vip_emails' to 'metrics_exclude'",
    ]);
  });

  test('a field an ancestor binds only in the profile is bound on its descendants', () => {
    expect(validateProfileCompleteness(model(false), spec([
      {name: 'customer', source: BQ('c'), fields: [ID, {name: 'email', expression: 'customer.id'}]},
      {name: 'vip', source: BQ('v'), fields: [ID]},
    ]))).toEqual([]);
  });

  test('a profile key column must be a physical column name', () => {
    const errors = validateProfileCompleteness(model(true), spec([
      {name: 'customer', source: BQ('c'), primaryKey: ['LOWER(id)'], uniqueKeys: [['a.b']]},
      {name: 'vip', source: BQ('v')},
    ]));
    expect(errors.join('\n')).toContain(
        "entity 'customer' key column 'LOWER(id)', 'a.b' is not a physical column name");
  });

  test('only the accepted source forms are accepted', () => {
    const errorsFor = (source: string) => validateProfileCompleteness(model(true), spec([
      {name: 'customer', source}, {name: 'vip', source: BQ('v')},
    ])).join('\n');
    for (const bad of [
           'not_a_table', 'acme.raw.customer', 'custom:foo.bar', 'trino:c.s.t',
           'oracle:p.i.t', 'spanner:p.c.i.db', 'bigquery:p.d',
           'bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g',
           'bigquery:graph:p.d.g', 'bigquery:propertygraph:p.d.g',
           'spanner:graph:p.c.i.db.g',
         ]) {
      // The loader's source reader judges a profile's sources too.
      expect(errorsFor(bad)).toMatch(/is not a valid (source|table reference)/);
    }
    expect(errorsFor(BQ('customer'))).toEqual('');
    // A profile's rebinding is held to the old-form rules a model file's
    // source is.
    expect(errorsFor(`//${BQ('customer')}`)).toContain(
        `source '//${BQ('customer')}' is a resource URI; write its GCP ` +
        `resource name, without the leading '//': '${BQ('customer')}'.`);
    expect(errorsFor('bigquery:p.d.customer')).toContain(
        `source 'bigquery:p.d.customer' is a Knowledge Catalog name; write ` +
        `the table's GCP resource name: '${BQ('customer')}'.`);
  });

  // A Cloud SQL table written as its resource name. A MySQL table has no
  // schema, and its database is its instance; a PostgreSQL or SQL Server table
  // has a schema, and its database is the one it names.
  test('Cloud SQL resource names classify by instance and database', () => {
    const errorsFor = (a: string, b: string,
                       cloudSqlDialects?: ReadonlyMap<string, string>) =>
        validateProfileCompleteness(model(true), spec([
          {name: 'customer', source: a}, {name: 'vip', source: b},
        ]), [], {cloudSqlDialects}).join('\n');
    const inst = 'cloudsql.googleapis.com/projects/acme/locations/us/instances/inst';
    // MySQL: one instance is one database, whatever its databases.
    expect(errorsFor(`${inst}/databases/sales/tables/c`, `${inst}/databases/crm/tables/v`))
        .toEqual('');
    expect(errorsFor(`${inst}/databases/sales/tables/c`,
                     'cloudsql.googleapis.com/projects/acme/locations/us/instances/other/databases/sales/tables/v'))
        .toContain('more than one database');
    // With a schema: one database is one; two on one instance are two, unless
    // the lookup names SQL Server, whose instance one query reaches whole.
    expect(errorsFor(`${inst}/databases/db1/schemas/public/tables/c`,
                     `${inst}/databases/db1/schemas/sales/tables/v`))
        .toEqual('');
    const twoDatabases = [
      `${inst}/databases/db1/schemas/public/tables/c`,
      `${inst}/databases/db2/schemas/public/tables/v`,
    ] as const;
    const lookedUp = (dialect: string) =>
        new Map(twoDatabases.map(s => [s, dialect]));
    expect(errorsFor(...twoDatabases)).toContain('more than one database');
    expect(errorsFor(...twoDatabases, lookedUp('POSTGRES')))
        .toContain('more than one database');
    expect(errorsFor(...twoDatabases, lookedUp('SQLSERVER'))).toEqual('');
    // Malformed: no location, no table, or a table under the instance.
    for (const bad of [
           'cloudsql.googleapis.com/projects/acme/instances/inst/databases/db/tables/c',
           `${inst}/databases/db/schemas/public`,
           `${inst}/tables/c`,
         ]) {
      expect(errorsFor(bad, `${inst}/databases/db/tables/v`))
          .toContain(`source '${bad}' is not a valid table reference`);
    }
  });

  // The dialect of a Cloud SQL table written as its resource name is the one
  // its catalog entry's type names, not one the source text implies. With no
  // entry read, it is unknown, even for a MySQL-shaped name; the catalog name
  // still implies its dialect from its prefix.
  test('a Cloud SQL resource name implies no dialect', () => {
    const dialectOf = (source: string) => sourcesDialect({entities: [
      {name: 'orders', dataSource: source, authoredSource: source, keys: [], fields: []},
    ]} as any);
    expect(dialectOf(
        'cloudsql.googleapis.com/projects/acme/locations/us/instances/inst/databases/db/tables/orders'))
        .toBeUndefined();
    expect(dialectOf(
        'cloudsql.googleapis.com/projects/acme/locations/us/instances/inst/databases/db/schemas/s/tables/orders'))
        .toBeUndefined();
  });

  // A profile's rebinding is read as the model file's source is, so a
  // third-party table is rejected there too, and counts as no database.
  test('a profile that binds a third-party source is rejected', () => {
    const errors = validateProfileCompleteness(model(true), spec([
      {name: 'customer', source: 'snowflake:acct.db.public.c'},
      {name: 'vip', source: BQ('vip')},
    ])).join('\n');
    expect(errors).toContain(
        "source 'snowflake:acct.db.public.c' is a third-party table; the " +
        "preview supports Google Cloud tables only");
    expect(errors).not.toContain('more than one database');
  });

  // A source the loader's reader rejects is reported, and names no
  // database. So its entity's fields are not held to the dialect of the
  // profile's other sources, which its table may not have. The other
  // entities' fields still are.
  test('a profile source the reader rejects leaves its entity\'s fields out of the dialect rule', () => {
    const m = model(true);
    // email as a load gives it: a SNOWFLAKE text, kept in its list too.
    m.entities[0].fields[1] = {
      name: 'email',
      importedExpression: 'email',
      importedDialect: 'SNOWFLAKE',
      dialects: [{dialect: 'SNOWFLAKE', expression: 'email'}],
    };
    // Tables in one Cloud SQL for MySQL instance, as the lookup reads them.
    const mysql = (t: string) =>
        `cloudsql.googleapis.com/projects/acme/locations/us/instances/inst/databases/sales/tables/${t}`;
    const cloudSqlDialects = new Map([mysql('c'), mysql('v')].map(t => [t, 'MYSQL']));
    const errorsFor = (customer: string) => validateProfileCompleteness(m, spec([
      {name: 'customer', source: customer, fields: [ID]},
      {name: 'vip', source: mysql('v'), fields: [ID]},
    ]), [], {cloudSqlDialects}).join('\n');
    for (const rejected of ['snowflake:acct.db.public.c', 'acme.sales.c', '']) {
      const errors = errorsFor(rejected);
      expect({rejected, errors}).toEqual({
        rejected,
        errors: expect.not.stringContaining("'customer.email' has no expression"),
      });
      // vip inherits email, and its own table is in the MySQL instance.
      expect(errors).toContain(
          "field 'vip.email' has no expression for MYSQL or ANSI_SQL");
    }
    // A source in the same instance gives the profile its dialect.
    expect(errorsFor(mysql('c'))).toContain(
        "field 'customer.email' has no expression for MYSQL or ANSI_SQL");
  });

  test('a profile that binds a system entry name is told the resource name', () => {
    const name = 'bigquery.googleapis.com/projects/acme/datasets/raw/tables/c';
    const errors = validateProfileCompleteness(model(true), spec([
      {name: 'customer', source: `projects/acme/locations/us/entryGroups/@bigquery/entries/${name}`},
      {name: 'vip', source: BQ('vip')},
    ])).join('\n');
    expect(errors).toContain(
        `in the system entry group '@bigquery'; write the table's resource ` +
        `name instead: '${name}'.`);
  });

  test('a BigLake table shares BigQuery\'s database', () => {
    expect(validateProfileCompleteness(model(true), spec([
      {name: 'customer',
       source: 'biglake.googleapis.com/projects/p/catalogs/c/namespaces/n/tables/t'},
      {name: 'vip', source: BQ('v')},
    ]))).toEqual([]);
  });
});


describe('profile rules', () => {
  const BQ = (t: string) => `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;

  test('cardinality: bindings may join on different keys', () => {
    // The model file joins on customer's primary key; prod restates both keys
    // and joins on its unique key instead.
    const model = (inlineJoin: boolean): SemanticModel => ({
      name: 'm',
      entities: [
        {name: 'customer', dataSource: '', keys: ['id'], uniqueKeys: [['email']],
         fields: []},
        {name: 'orders', dataSource: '', keys: ['o_id'], fields: []},
      ],
      relationships: [{
        name: 'placed_by',
        source: {entity: 'orders', columns: inlineJoin ? ['cust_id'] : []},
        destination: {entity: 'customer', columns: inlineJoin ? ['id'] : []},
      }],
    } as any);
    const prod: ProfileSpec = {
      name: 'prod',
      entities: [{name: 'customer', source: BQ('c'), primaryKey: ['c_id'],
                  uniqueKeys: [['c_email']]}],
      relationships: [{name: 'placed_by', fromColumns: ['o_mail'], toColumns: ['c_email']}],
    };
    expect(validateProfileConsistency(model(true), [prod])).toEqual([]);
    expect(validateProfileConsistency(model(false), [prod])).toEqual([]);
  });

  // A profile field expression reads only its own entity's columns and fields.
  test('a profile field expression may not read another entity or a missing field', () => {
    const errors = validateProfileCompleteness(irModel(), {
      name: 'prod',
      entities: [
        {name: 'Customer', source: BQ('customer'),
         fields: [{name: 'lifetimeValue', expression: 'Customer.lifetimeValu + Order.key'}]},
        {name: 'Order', source: BQ('orders')},
      ],
      relationships: [{name: 'PlacedBy', fromColumns: ['o_custkey'], toColumns: ['c_custkey']}],
    }).join('\n');
    expect(errors).toContain("field 'Customer.lifetimeValue' reads entity 'Order'");
    expect(errors).toContain("reads 'Customer.lifetimeValu', which is not a field of 'Customer'");
  });

  // Only the allowlisted dialects, each once.
  test('a profile expression may use only allowlisted dialects, each once', () => {
    const file = (dialects: string) =>
        `name: prod\nentities:\n  - name: o\n    fields:\n      - {name: a, expression: {dialects: [${dialects}]}}\n`;
    expect(() => loadProfileFile(file('{dialect: TABLEAU, expression: x}'), 'prod'))
        .toThrow(
            "Unknown dialect 'TABLEAU' in expression dialects. Expected one of " +
            'ANSI_SQL, BIGQUERY,');
    expect(() => loadProfileFile(
               file('{dialect: BIGQUERY, expression: x}, {dialect: BIGQUERY, expression: y}'),
               'prod'))
        .toThrow("Duplicate dialect 'BIGQUERY' in expression dialects.");
    expect(() => loadProfileFile(file('{dialect: BigQuery, expression: x}'), 'prod'))
        .toThrow("Unknown dialect 'BigQuery' in expression dialects.");
  });

  // The expression object and each entry are closed, as in a model file.
  test('a profile expression may carry no other key', () => {
    const file = (expression: string) =>
        `name: prod\nentities:\n  - name: o\n    fields:\n      - {name: a, expression: ${expression}}\n`;
    expect(() => loadProfileFile(
               file('{dialects: [{dialect: BIGQUERY, expression: x}], note: y}'), 'prod'))
        .toThrow("field 'a': 'expression': Unrecognized key: \"note\"");
    expect(() => loadProfileFile(
               file('{dialects: [{dialect: BIGQUERY, expression: x, note: y}]}'), 'prod'))
        .toThrow("field 'a': 'expression': dialects.0: Unrecognized key: \"note\"");
  });

  // A blank expression, one that is only a comment and one that is only its
  // entity's qualifier are rejected, as in a model file.
  test('a profile expression may not be blank', () => {
    const file = (expression: string) =>
        `name: prod\nentities:\n  - name: o\n    fields:\n      - {name: a, expression: ${expression}}\n`;
    expect(() => loadProfileFile(file('""'), 'prod'))
        .toThrow(
            "profile 'prod': entity 'o': field 'a': 'expression' is blank; " +
            "write the field's SQL");
    expect(() => loadProfileFile(
               file('{dialects: [{dialect: BIGQUERY, expression: "  "}]}'), 'prod'))
        .toThrow(
            "profile 'prod': entity 'o': field 'a': the BIGQUERY entry of " +
            "'expression' is blank; write the field's SQL");
    expect(() => loadProfileFile(file('"-- todo"'), 'prod'))
        .toThrow(
            "profile 'prod': entity 'o': field 'a': 'expression' is only a " +
            "comment; write the field's SQL");
    expect(() => loadProfileFile(file('"o."'), 'prod'))
        .toThrow(
            "profile 'prod': entity 'o': field 'a': 'expression' is only the " +
            "qualifier 'o.'; write the field's SQL");
  });

  // Inheritance removes `base.` on `orders`, and the graph generators remove
  // `orders.`, so the binding is checked on the entity that inherits it.
  test('a profile binding may not leave an inheriting entity only its qualifier', () => {
    const {models} = loadModels(`version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    entities:
      - name: base
        source: bigquery.googleapis.com/projects/p/datasets/d/tables/base
        primary_key: [id]
        fields:
          - {name: id, expression: id}
          - {name: notes, expression: notes}
      - name: orders
        extends: [base]
        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders
        primary_key: [id]
    deployments:
      - name: default
        target: bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/shop
`);
    const profile = (expression: string) =>
        `name: prod\nentities:\n  - name: base\n    fields:\n      - {name: notes, expression: ${expression}}\n`;
    expect(applyProfileFile(models[0], profile('"base.orders."'), 'prod')).toEqual({
      error: "profile 'prod': entity 'orders' inherits field 'notes': read on " +
          "'orders', 'expression' is only the qualifier 'orders.'; write the " +
          "field's SQL",
    });
    expect(applyProfileFile(models[0], profile('"base.notes"'), 'prod'))
        .not.toHaveProperty('error');
  });

  test('completeness reports a profile binding that leaves an inheriting entity only its qualifier, as the apply does', () => {
    const {models} = loadModels(`version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    entities:
      - name: base
        source: bigquery.googleapis.com/projects/p/datasets/d/tables/base
        primary_key: [id]
        fields:
          - {name: id, expression: id}
          - {name: notes}
      - name: orders
        extends: [base]
        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders
        primary_key: [id]
`);
    const profile = (expression: string) => loadProfileFile(`name: prod
entities:
  - name: base
    source: bigquery.googleapis.com/projects/p/datasets/prod/tables/base
    primary_key: [id]
    fields:
      - {name: id, expression: id}
      - {name: notes, expression: ${expression}}
  - name: orders
    source: bigquery.googleapis.com/projects/p/datasets/prod/tables/orders
    primary_key: [id]
    fields: [{name: id, expression: id}]
`, 'prod');
    expect(validateProfileCompleteness(models[0], profile('"base.orders."')))
        .toEqual([
          "profile 'prod': entity 'orders' inherits field 'notes': read on " +
          "'orders', 'expression' is only the qualifier 'orders.'; write the " +
          "field's SQL",
        ]);
    // orders inherits a binding that reads only fields.
    expect(validateProfileCompleteness(models[0], profile('UPPER(base.id)')))
        .toEqual([]);
    // A binding the reader rejects is reported once, where the profile writes
    // it, also when a profile built in memory gives it with no dialect list.
    for (const notes of [
           {name: 'notes', expression: '-- todo'},
           {name: 'notes', importedExpression: '-- todo', importedDialect: 'POSTGRES'},
         ]) {
      expect(validateProfileCompleteness(models[0], {
        name: 'prod',
        relationships: [],
        entities: [
          keyedById('base', 'bigquery.googleapis.com/projects/p/datasets/prod/tables/base', notes),
          keyedById('orders', 'bigquery.googleapis.com/projects/p/datasets/prod/tables/orders'),
        ],
      })).toEqual([expect.stringMatching(
          /^profile 'prod': entity 'base': field 'notes': .* is only a comment; write the field's SQL$/)]);
    }
  });

  // A field an entity binds itself is checked where it is declared, so the
  // inherited check reads only the fields the entity takes from an ancestor.
  test('the inherited check of the profile checks reads only what an entity inherits, and completeness lists every field', () => {
    const BQ = (t: string) =>
        `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
    // A model built in memory skips the loader, so `own` holds no SQL.
    const base: SemanticModel = {
      name: 'shop',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'base',
          dataSource: 'p.d.base',
          keys: ['id'],
          fields: [
            {name: 'id', expression: 'id'},
            {name: 'label', expression: 'label'},
            {name: 'tag', expression: 'tag'},
            {name: 'memo', expression: 'memo'},
            // It holds no SQL where it is declared, which push reports.
            {name: 'old', expression: '-- old'},
          ],
        },
        {
          name: 'orders',
          extends: ['base'],
          dataSource: 'p.d.orders',
          keys: ['id'],
          fields: [
            {name: 'id', expression: 'id'},
            {name: 'own', expression: '-- todo'},
            {name: 'memo', expression: '/* todo */'},
            // A line that binds nothing takes the ancestor's binding.
            {name: 'tag'},
          ],
        },
      ],
    };
    const profile = loadProfileFile(`name: prod
entities:
  - name: base
    source: ${BQ('base')}
    primary_key: [id]
    fields:
      - {name: id, expression: id}
      - {name: label, expression: "base.orders."}
      - {name: tag, expression: "base.orders."}
      - {name: memo, expression: memo}
  - name: orders
    source: ${BQ('orders')}
    primary_key: [id]
    fields: [{name: id, expression: id}]
`, 'prod');
    const inherited = (field: string) =>
        `profile 'prod': entity 'orders' inherits field '${field}': read on ` +
        `'orders', 'expression' is only the qualifier 'orders.'; write the ` +
        `field's SQL`;
    // Fields the entity declares come first.
    expect(() => applyProfile(base, profile)).toThrow(inherited('tag'));
    expect(validateProfileCompleteness(base, profile))
        .toEqual([inherited('tag'), inherited('label')]);
  });

  // A dialect list cannot hold an imported text with no imported dialect, or
  // one marked BIGQUERY beside a target text. A model built in memory can
  // also carry an imported text beside its dialect list. Push reads each such
  // text.
  test('push reads an inherited imported text outside the dialect list', () => {
    // Each imported text holds SQL on `base` and is only the qualifier
    // `orders.` on `orders`. Each target text reads only a field, so `orders`
    // may inherit it.
    const shop: SemanticModel = {
      name: 'shop',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'base',
          dataSource: 'p.d.base',
          keys: ['id'],
          fields: [
            {name: 'id', expression: 'id'},
            {
              name: 'loose',
              expression: 'base.id',
              importedExpression: 'base.orders.',
            },
            {
              name: 'marked',
              expression: 'base.id',
              importedExpression: 'base.orders.',
              importedDialect: 'BIGQUERY',
            },
            {
              name: 'listed',
              dialects: [{dialect: 'BIGQUERY', expression: 'base.id'}],
              expression: 'base.id',
              importedExpression: 'base.orders.',
              importedDialect: 'POSTGRES',
            },
            // Its target text has no SQL where it is declared, which push
            // reports there.
            {
              name: 'todo',
              expression: '-- todo',
              importedExpression: 'base.orders.',
            },
          ],
        },
        {
          name: 'orders',
          extends: ['base'],
          dataSource: 'p.d.orders',
          keys: ['id'],
          fields: [{name: 'id', expression: 'id'}],
        },
      ],
    };
    const problem = (field: string) =>
        `entity 'orders' inherits field '${field}': read on 'orders', ` +
        (field === 'todo' ? `'expression' is only a comment and ` : '') +
        `'importedExpression' is only the qualifier 'orders.'; write the ` +
        `field's SQL`;
    const fields = ['loose', 'marked', 'listed', 'todo'];
    expect(validatePushRequirements(
               [{document: 'shop.yaml', model: shop}], {targetOptional: true}))
        .toEqual([
          "field 'base.todo' in model 'shop' (shop.yaml): 'expression' is " +
              "only a comment; write the field's SQL, or remove 'expression' " +
              'to leave the field unbound.',
          ...fields.map(f => `model 'shop' (shop.yaml): ${problem(f)}.`),
        ]);
  });

  // A load dialect other than BigQuery picks the target text from that
  // dialect's entry. The entry already names the text, so it is not named
  // again.
  test('the inherited check names a text once when the load dialect picks it from a dialect entry', () => {
    const shop: SemanticModel = {
      name: 'shop',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'base',
          dataSource: 'p.d.base',
          keys: ['id'],
          fields: [{name: 'id', expression: 'id'}, {name: 'note'}],
        },
        {
          name: 'orders',
          extends: ['base'],
          dataSource: 'p.d.orders',
          keys: ['id'],
          fields: [{name: 'id', expression: 'id'}],
        },
      ],
    };
    const note = {
      name: 'note',
      dialects: [{dialect: 'SPANNER' as const, expression: 'base.orders.'}],
    };
    const BQ = (t: string) =>
        `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
    const profile: ProfileSpec = {
      name: 'prod',
      relationships: [],
      entities: [
        {name: 'base', source: BQ('base'), fields: [note]},
        {name: 'orders', source: BQ('orders')},
      ],
    };
    const problem = "entity 'orders' inherits field 'note': read on " +
        "'orders', the SPANNER entry of 'expression' is only the qualifier " +
        "'orders.'; write the field's SQL";
    expect(() => applyProfile(shop, profile, {load: {dialect: 'SPANNER'}}))
        .toThrow(`profile 'prod': ${problem}`);
    // Push reads the field as a load with the SPANNER dialect gives it.
    const loaded = structuredClone(shop);
    loaded.entities[0].fields[1] =
        {...note, stringForm: false, expression: 'base.orders.'};
    expect(validatePushRequirements(
               [{document: 'shop.yaml', model: loaded}],
               {targetOptional: true}))
        .toEqual([`model 'shop' (shop.yaml): ${problem}.`]);
  });

  // In PostgreSQL `#` is an operator, so `base.orders.# pts` holds SQL on
  // `orders`. A load in that dialect gives the field that text as its target
  // text, which BigQuery would read as the qualifier `orders.` and a comment.
  test('the profile checks read an inherited field in its own dialects under any load dialect', () => {
    const PG = (t: string) =>
        `cloudsql.googleapis.com/projects/p/locations/us-central1/instances/inst/databases/db/schemas/public/tables/${t}`;
    const pts = `
            expression:
              dialects:
                - dialect: POSTGRES
                  expression: "base.orders.# pts"`;
    const modelText = (bound: boolean) => `version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    entities:
      - name: base
        source: "${PG('base')}"
        primary_key: [id]
        fields:
          - {name: id, expression: id}
          - name: pts${bound ? pts : ''}
      - name: orders
        extends: [base]
        source: "${PG('orders')}"
        primary_key: [id]
        fields:
          - {name: id, expression: id}
`;
    const profileText = `name: prod
entities:
  - name: base
    source: "${PG('base')}"
    fields:
      - name: pts${pts.replace(/\n {4}/g, '\n')}
  - name: orders
    source: "${PG('orders')}"
`;
    const load = (text: string) =>
        loadSemanticModels(
            [{name: 'shop.yaml', text}],
            {dialect: 'POSTGRES', bindingOptional: true});
    const merged = mergeProfileOntoDocImpl(modelText(false), profileText, 'prod');
    if ('error' in merged) throw new Error(merged.error);
    expect(load(merged.text).error).toBeUndefined();
    const applied = applyProfileFile(
        load(modelText(false)).models[0].model, profileText, 'prod',
        {load: {dialect: 'POSTGRES'}});
    expect('error' in applied ? applied.error : undefined).toBeUndefined();
    // The model file binds the field, and the profile binds only sources.
    const bound = load(modelText(true));
    expect(bound.error).toBeUndefined();
    const sources: ProfileSpec = {
      name: 'prod',
      relationships: [],
      entities: [keyedById('base', PG('base')), keyedById('orders', PG('orders'))],
    };
    expect(() => applyProfile(bound.models[0].model, sources)).not.toThrow();
    expect(validateProfileCompleteness(bound.models[0].model, sources))
        .toEqual([]);
  });

  // The warning would say kcmd could not read SQL that is not there.
  test('the profile checks and pruning give a text with no SQL no unread-SQL warning', () => {
    const {models} = loadModels(`version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    entities:
      - name: orders
        source: bigquery.googleapis.com/projects/p/datasets/d/tables/orders
        primary_key: [id]
        fields:
          - {name: id, expression: id}
          - {name: notes}
          - {name: memo, expression: memo}
`);
    // A profile built in memory skips the profile-file reader.
    const warnings: string[] = [];
    expect(validateProfileCompleteness(
               models[0], {
                 name: 'prod',
                 relationships: [],
                 entities: [keyedById(
                     'orders', 'bigquery.googleapis.com/projects/p/datasets/prod/tables/orders',
                     column('notes', '-- todo'), column('memo', 'orders.'))],
               },
               warnings))
        .toEqual([
          "profile 'prod': entity 'orders': field 'notes': 'expression' is " +
              "only a comment; write the field's SQL",
          "profile 'prod': entity 'orders': field 'memo': 'expression' is " +
              "only the qualifier 'orders.'; write the field's SQL",
        ]);
    expect(warnings).toEqual([]);
    // A model built in memory skips the loader. `u` is unbound, so pruning
    // reads what each other field reads.
    const inMemory: SemanticModel = {
      name: 'shop',
      relationships: [],
      entities: [{
        name: 'orders',
        dataSource: 'p.d.orders',
        keys: ['id'],
        fields: [
          {name: 'id', expression: 'id'},
          {name: 'u'},
          {name: 'memo', expression: '-- todo'},
        ],
      }],
      metrics: [
        {name: 'total', expression: '/* todo */', entity: 'orders'},
        {
          name: 'count',
          expression: 'COUNT(orders.id)',
          dialects: [
            {dialect: 'BIGQUERY', expression: 'COUNT(orders.id)'},
            {dialect: 'POSTGRES', expression: '-- todo'},
          ],
        },
      ],
    };
    expect(pruneUnavailable(inMemory, 'prod').report.warnings).toEqual([]);
    const modelWarnings: string[] = [];
    validateProfileCompleteness(
        inMemory, {
          name: 'prod',
          relationships: [],
          entities: [{
            name: 'orders',
            source: 'bigquery.googleapis.com/projects/p/datasets/prod/tables/orders',
            fieldsExclude: ['u'],
          }],
        },
        modelWarnings);
    expect(modelWarnings).toEqual([]);
  });

  // An abstract entity has no table, so a profile entry for one is rejected.
  test('the merge rejects an entry for an abstract entity', () => {
    const logical = {semantic_model: [{name: 'm', entities: [
      {name: 'party', abstract: true, fields: [{name: 'name'}]},
    ]}]};
    expect(mergeProfile(logical, {name: 'prod', entities: [{name: 'party'}]}, 'prod').error)
        .toContain("entity 'party' is abstract, so a profile cannot bind it");
  });

  test('the legacy wrapper carries only version and semantic_model, with named entries', () => {
    const logical = {semantic_model: [{name: 'm', entities: [{name: 'o', fields: []}]}]};
    expect(mergeProfile(logical, {semantic_model: [], name: 'prod'}, 'prod').error)
        .toContain("carries only 'version' and 'semantic_model', not 'name'");
    expect(mergeProfile(logical, {semantic_model: ['m']}, 'prod').error)
        .toContain("every entry in 'semantic_model' is a mapping with a 'name'");
  });

  test('a YAML alias in the model file does not carry one entity\'s binding to another', () => {
    const logicalText = `version: "0.2.0.dev0/google"
semantic_model:
  - name: m
    entities:
      - {name: orders, source: ${BQ('orders')}, primary_key: [id], fields: [&idf {name: id, expression: id}]}
      - {name: refunds, source: ${BQ('refunds')}, primary_key: [id], fields: [*idf]}
`;
    const merged = mergeProfileOntoDoc(logicalText, `name: prod
entities:
  - {name: orders, source: ${BQ('orders')}, fields: [{name: id, expression: order_id}]}
  - {name: refunds, source: ${BQ('refunds')}}
relationships: []
`, 'prod');
    if ('error' in merged) throw new Error(merged.error);
    const {models} = loadModels(merged.text);
    expect(models[0].entities.find(e => e.name === 'refunds')!.fields[0].expression).toBe('id');
    expect(models[0].entities.find(e => e.name === 'orders')!.fields[0].expression).toBe('order_id');
  });

  test('an inheritance error the profile itself creates is reported', () => {
    const model: SemanticModel = {
      name: 'm',
      entities: [
        {name: 'A', abstract: true, dataSource: '', keys: [], fields: [{name: 'x', type: 'String'}]},
        {name: 'B', extends: ['A'], dataSource: '', keys: ['b'], fields: [{name: 'b', expression: 'b'}]},
        {name: 'D', extends: ['A'], dataSource: '', keys: ['d'],
         fields: [{name: 'd', expression: 'd'}, {name: 'x', expression: 'd_x'}]},
        {name: 'E', extends: ['B', 'D'], dataSource: '', keys: ['e'], fields: [{name: 'e', expression: 'e'}]},
      ],
      relationships: [],
    } as any;
    const errors = validateProfileCompleteness(model, {
      name: 'prod',
      entities: [{name: 'B', source: BQ('b'), fields: [{name: 'x', expression: 'b_x'}]},
                 {name: 'D', source: BQ('d')}, {name: 'E', source: BQ('e')}],
      relationships: [],
    });
    expect(errors.join('\n')).toContain("entity 'E' inherits field 'x' from 'B' and from 'D'");
  });

  // E extends B and D, which both extend the abstract A. The model file binds
  // the inherited x only on D, so its hierarchy resolves. A profile that binds
  // x on B too breaks it.
  const diamond = (more: object[] = []): SemanticModel => ({
    name: 'm',
    entities: [
      {name: 'A', abstract: true, dataSource: '', keys: [], fields: [{name: 'x', type: 'String'}]},
      {name: 'B', extends: ['A'], dataSource: '', keys: ['b'], fields: [{name: 'b', expression: 'b'}]},
      {name: 'D', extends: ['A'], dataSource: '', keys: ['d'],
       fields: [{name: 'd', expression: 'd'}, {name: 'x', expression: 'd_x'}]},
      {name: 'E', extends: ['B', 'D'], dataSource: '', keys: ['e'], fields: [{name: 'e', expression: 'e'}]},
      ...more,
    ],
    relationships: [],
  }) as any;
  // A profile's binding of one of the entities below: its key and its column
  // field, both named after the entity, and `more` fields.
  const ownBinding = (name: string, ...more: Field[]) =>
      keyed(name.toLowerCase())(name, BQ(name.toLowerCase()), ...more);
  const bindsXOnB = (more: object[] = []): ProfileSpec => ({
    name: 'prod',
    entities: [ownBinding('B', column('x', 'b_x')), ownBinding('D', column('x', 'd_x')),
               ...more] as any,
    relationships: [],
  });
  const conflict = expect.stringContaining(
      "profile 'prod': entity 'E' inherits field 'x' from 'B' and from 'D'");

  // Push reports the inheritance error itself for the profile it applies.
  test('and its other rules still run', () => {
    const noSource = "profile 'prod': entity 'E' has no source in this profile";
    expect(validateProfileCompleteness(diamond(), bindsXOnB()))
        .toEqual([conflict, noSource]);
    expect(validateProfileCompleteness(
               diamond(), bindsXOnB(), [], {applied: true}))
        .toEqual([noSource]);
  });

  // On a broken hierarchy each entity is resolved with only its own
  // ancestors, so an entity outside the conflict keeps its inherited fields.
  // R restates the bound b with only its name, so it reads B's bindings of b
  // and x, and V leaves x unbound.
  test('and reads the inherited fields of each entity outside the conflict', () => {
    const model = diamond([
      {name: 'R', extends: ['B'], dataSource: '', keys: ['r'],
       fields: [{name: 'r', expression: 'r'}, {name: 'b'}]},
      {name: 'V', extends: ['A'], dataSource: '', keys: ['v'], fields: [{name: 'v', expression: 'v'}]},
    ]);
    const spec = bindsXOnB([ownBinding('E'), ownBinding('R'), ownBinding('V')]);
    expect(validateProfileCompleteness(model, spec)).toEqual([
      conflict,
      "profile 'prod': field 'V.x' has no binding in the model file; bind it " +
          "in 'fields' or leave it out in 'fields_exclude'",
      readsColumn('R.b', 'b', 'B'),
      readsColumn('R.x', 'b_x', 'B'),
    ]);
  });

  // Push's own check of the SQL it reads stands down on a broken hierarchy, so
  // this check gives the warning for the profile push applies too.
  test('and warns about SQL it cannot read for the profile push applies', () => {
    const model = diamond([
      {name: 'F', dataSource: '', keys: ['f'], fields: [{name: 'f', expression: 'LOWER(f'}]},
    ]);
    const spec = bindsXOnB(
        [ownBinding('E'), {name: 'F', source: BQ('f'), primaryKey: ['f']}]);
    const warnings: string[] = [];
    expect(validateProfileCompleteness(model, spec, warnings, {applied: true}))
        .toEqual([]);
    expect(warnings).toEqual([
      "profile 'prod': kcmd could not read the SQL of field 'F.f', so the " +
          'fields it reads were not checked',
    ]);
    // A --deployment push warns about the model file's SQL when it loads the
    // model file, so this check leaves that warning out.
    const deferred: string[] = [];
    validateProfileCompleteness(model, spec, deferred,
                                {sqlWarned: true, ownSqlOnly: {dialect: 'BIGQUERY'}});
    expect(deferred).toEqual([]);
  });

  // Push's own check of what a field reads stands down on a broken hierarchy
  // too, so this check reads the fields of the profile push applies.
  test('and reads what the fields of the profile push applies read', () => {
    const model = diamond([
      {name: 'F', dataSource: '', keys: ['f'], fields: [{name: 'f', expression: 'f'}]},
    ]);
    const spec = bindsXOnB([
      {...ownBinding('E'), fields: [{name: 'e', expression: 'F.f'}]}, ownBinding('F'),
    ]);
    expect(validateProfileCompleteness(model, spec, [], {applied: true}))
        .toEqual([
          "profile 'prod': field 'E.e' reads entity 'F'; a field expression " +
              'reads only its own entity',
        ]);
  });

  // E inherits x from both A and B, so the model file's hierarchy does not
  // resolve, and what E inherits is not known. E inherits a from A.
  const unknownAncestry = (eFields: object[]): SemanticModel => ({
    name: 'm',
    entities: [
      {name: 'A', dataSource: '', keys: ['a'],
       fields: [{name: 'a', expression: 'a'}, {name: 'x', expression: 'ax'}]},
      {name: 'B', dataSource: '', keys: ['b'],
       fields: [{name: 'b', expression: 'b'}, {name: 'x', expression: 'bx'}]},
      {name: 'E', extends: ['A', 'B'], dataSource: '', keys: ['e'],
       fields: [{name: 'e', expression: 'e'}, ...eFields]},
    ],
    relationships: [],
  }) as any;
  const bindsAll = (eFields?: object[]): ProfileSpec => ({
    name: 'prod',
    entities: [
      ownBinding('A', column('x', 'ax')), ownBinding('B', column('x', 'bx')),
      {...ownBinding('E'), ...(eFields ? {fields: eFields} : {})},
    ],
    relationships: [],
  }) as any;

  test('does not call a field unknown on an entity whose own ancestors do not resolve', () => {
    const spec = bindsAll([{name: 'e', expression: 'UPPER(E.a)'}]);
    for (const applied of [false, true]) {
      expect(validateProfileCompleteness(unknownAncestry([]), spec, [], {applied}))
          .toEqual([]);
    }
  });

  // Restating an inherited field by its name alone is not a binding, and push
  // reports that line once the hierarchy resolves. E.a still reads A's
  // binding, which reads a column.
  test('does not call unbound a restated inherited field on such an entity', () => {
    for (const applied of [false, true]) {
      expect(validateProfileCompleteness(
                 unknownAncestry([{name: 'a'}]), bindsAll(), [], {applied}))
          .toEqual([]);
    }
  });

  // A binding is a per-table fact, so an exclusion applies to the entity that
  // names it.
  test('an applied exclusion leaves the field off that entity only', () => {
    const model: SemanticModel = {
      name: 'm',
      entities: [
        {name: 'customer', dataSource: 'p.d.c', keys: ['id'],
         fields: [{name: 'id', expression: 'id'}, {name: 'email', expression: 'email', type: 'String'}]},
        {name: 'vip', extends: ['customer'], dataSource: 'p.d.v', keys: ['id'], fields: []},
      ],
      relationships: [],
    } as any;
    const marked = applyProfileExclusions(model, [{model: 'm', entity: 'customer', field: 'email'}]);
    const resolved = resolveInheritance(marked).model.entities!;
    expect(resolved.find(e => e.name === 'customer')!.fields.map(f => f.name)).toEqual(['id']);
    const vipEmail = resolved.find(e => e.name === 'vip')!.fields.find(f => f.name === 'email')!;
    expect(vipEmail.type).toBe('String');
  });

  test('pruning drops a metric that reads an inherited unbound field, and keeps an ancestor\'s definition', () => {
    const model: SemanticModel = {
      name: 'm',
      entities: [
        {name: 'B', dataSource: 'p.d.b', keys: ['id'],
         fields: [{name: 'id', expression: 'id'}, {name: 'x', type: 'Decimal', description: 'the x'}]},
        {name: 'C', extends: ['B'], dataSource: 'p.d.c', keys: ['id'], fields: []},
        {name: 'D', extends: ['B'], dataSource: 'p.d.d', keys: ['id'], fields: [{name: 'x', expression: 'd_x'}]},
      ],
      relationships: [],
      metrics: [
        {name: 'c_total', entity: 'C', expression: 'SUM(C.x)'},
        {name: 'd_total', entity: 'D', expression: 'SUM(D.x)'},
      ],
    } as any;
    const {model: pruned, report} = pruneUnavailable(model, 'prod');
    expect(report.droppedMetrics.map(m => m.name)).toEqual(['c_total']);
    expect(report.unboundFields).toContain('C.x');
    const resolved = resolveInheritance(pruned).model.entities!;
    const dx = resolved.find(e => e.name === 'D')!.fields.find(f => f.name === 'x')!;
    expect(dx).toMatchObject({expression: 'd_x', type: 'Decimal', description: 'the x'});
    expect(resolved.find(e => e.name === 'B')!.fields.map(f => f.name)).toEqual(['id']);
  });

  test('an inherited computed field depending on a field the subtype excludes must go too', () => {
    const model: SemanticModel = {
      name: 'm',
      entities: [
        {name: 'customer', dataSource: 'p.d.c', keys: ['id'], fields: [
          {name: 'id', expression: 'id'}, {name: 'gross', expression: 'gross'},
          {name: 'discount', expression: 'discount'},
          {name: 'net', expression: 'customer.gross - customer.discount'},
        ]},
        {name: 'vip', extends: ['customer'], dataSource: 'p.d.v', keys: ['id'], fields: []},
      ],
      relationships: [],
    } as any;
    // net reads only fields, so the profile need not restate it.
    const errors = validateProfileCompleteness(model, {
      name: 'prod',
      entities: [keyedById('customer', BQ('c'), column('gross'), column('discount')),
                 {...keyedById('vip', BQ('v'), column('gross')), fieldsExclude: ['discount']}],
      relationships: [],
    });
    expect(errors).toEqual([
      "profile 'prod': field 'vip.net' depends on 'vip.discount', which this profile " +
          "excludes; exclude 'vip.net' too, or rebind it",
    ]);
  });

  // leaf extends root directly and through mid. Inheritance gives leaf the
  // binding of the ancestor with the most ancestors, mid, though root is
  // nearer by breadth. The check reads that binding.
  describe('an inherited field reads the binding inheritance keeps', () => {
    const model = (rootB: string, midB: string): SemanticModel => ({
      name: 'm',
      entities: [
        {name: 'root', dataSource: 'p.d.r', keys: ['r_id'], fields: [
          {name: 'r_id', expression: 'r_id'}, {name: 'a', expression: 'col_a'},
          {name: 'b', expression: rootB},
        ]},
        {name: 'mid', extends: ['root'], dataSource: 'p.d.m', keys: ['m_id'],
         fields: [{name: 'm_id', expression: 'm_id'}, {name: 'b', expression: midB}]},
        {name: 'leaf', extends: ['root', 'mid'], dataSource: 'p.d.l',
         keys: ['l_id'], fields: [{name: 'l_id', expression: 'l_id'}]},
      ],
      relationships: [],
    } as any);
    // The profile restates each field that reads a column. Each binding of b
    // reads only fields, so leaf may inherit it.
    const prod: ProfileSpec = {
      name: 'prod',
      entities: [
        keyed('r_id')('root', BQ('r'), column('a', 'col_a')),
        keyed('m_id')('mid', BQ('m'), column('r_id'), column('a', 'col_a')),
        {...keyed('l_id')('leaf', BQ('l'), column('r_id'), column('m_id')), fieldsExclude: ['a']},
      ],
      relationships: [],
    };

    test('and reports a dependency only that binding has', () => {
      expect(validateProfileCompleteness(model('root.r_id + 1', 'mid.a + 1'), prod))
          .toEqual([
            "profile 'prod': field 'leaf.b' depends on 'leaf.a', which this " +
                "profile excludes; exclude 'leaf.b' too, or rebind it",
          ]);
    });

    test('and does not report one only a nearer ancestor\'s binding has', () => {
      expect(validateProfileCompleteness(model('root.a + 1', 'mid.r_id + 1'), prod))
          .toEqual([]);
    });

    // Pruning reads the same binding. D inherits shout from X, whose
    // binding reads email, which D leaves unbound.
    test('and pruning drops a field whose kept binding reads an unbound one', () => {
      const diamond: SemanticModel = {
        name: 'm',
        entities: [
          {name: 'A', dataSource: 'p.d.a', keys: ['id'], fields: [
            {name: 'id', expression: 'id'}, {name: 'p'},
            {name: 'shout', expression: 'UPPER(A.p)'},
          ]},
          {name: 'X', extends: ['A'], dataSource: 'p.d.x', keys: ['id'], fields: [
            {name: 'email'}, {name: 'shout', expression: 'UPPER(X.email)'},
          ]},
          {name: 'D', extends: ['A', 'X'], dataSource: 'p.d.d', keys: ['id'],
           fields: [{name: 'p', expression: 'p'}]},
        ],
        relationships: [],
      } as any;
      const {report} = pruneUnavailable(diamond, 'prod');
      expect(report.droppedFields).toContainEqual(
          {name: 'D.shout', reason: 'reads D.email, which is unavailable'});
    });

    // Here X binds email, and A leaves p unbound. D inherits shout from X,
    // whose binding reads only email, so pruning keeps it.
    test('and pruning keeps a field whose kept binding reads only bound ones', () => {
      const diamond: SemanticModel = {
        name: 'm',
        entities: [
          {name: 'A', dataSource: 'p.d.a', keys: ['id'], fields: [
            {name: 'id', expression: 'id'}, {name: 'p'},
            {name: 'shout', expression: 'UPPER(A.p)'},
          ]},
          {name: 'X', extends: ['A'], dataSource: 'p.d.x', keys: ['id'], fields: [
            {name: 'email', expression: 'email'},
            {name: 'shout', expression: 'UPPER(X.email)'},
          ]},
          {name: 'D', extends: ['A', 'X'], dataSource: 'p.d.d', keys: ['id'],
           fields: []},
        ],
        relationships: [],
      } as any;
      const {report} = pruneUnavailable(diamond, 'prod');
      expect(report.droppedFields.map(f => f.name)).not.toContain('D.shout');
      expect(report.droppedFields.map(f => f.name)).toContain('A.shout');
    });
  });
});


describe('profile completeness: dialects and struct paths', () => {
  const BQ = (t: string) => `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
  const SP = (t: string) =>
      `spanner.googleapis.com/projects/p/instances/i/databases/db/tables/${t}`;
  // The IR keeps a Spanner table as its resource URI.
  const SP_DATA = (t: string) => `//${SP(t)}`;
  const shop = (amount: object): SemanticModel => ({
    name: 'shop',
    entities: [{
      name: 'orders', dataSource: BQ('orders'), keys: ['id'],
      fields: [{name: 'id', expression: 'id'}, {name: 'amount', ...amount}],
    }],
    relationships: [], metrics: [],
  } as any);
  // amount reads only a field, so a profile need not restate it.
  const bqOnly = () => shop({
    expression: 'SAFE_CAST(orders.id AS NUMERIC)',
    dialects: [{dialect: 'BIGQUERY', expression: 'SAFE_CAST(orders.id AS NUMERIC)'}],
  });
  const atSource = (source: string): ProfileSpec =>
      ({name: 'p', entities: [keyedById('orders', source)], relationships: []});

  // A Cloud SQL table written as its resource name takes the dialect its
  // catalog entry's type names, which a command looks up before it loads.
  // Without a lookup the source implies no dialect, so every text counts.
  test('a Cloud SQL resource name takes the dialect its catalog entry gave, and none without one', () => {
    const CS = 'cloudsql.googleapis.com/projects/p/locations/l/instances/ms/' +
        'databases/shop/schemas/sales/tables/orders';
    const sqlServer = {cloudSqlDialects: new Map([[CS, 'SQLSERVER']])};
    expect(validateProfileCompleteness(bqOnly(), atSource(CS))).toEqual([]);
    expect(validateProfileCompleteness(bqOnly(), atSource(CS), [], {cloudSqlDialects: sqlServer.cloudSqlDialects})
               .join('\n'))
        .toContain("field 'orders.amount' has no expression for SQLSERVER or ANSI_SQL");
    // The dialects are per table: another table's does not count.
    const other = {cloudSqlDialects: new Map([[CS.replace('/ms/', '/other/'), 'SQLSERVER']])};
    expect(validateProfileCompleteness(bqOnly(), atSource(CS), [], {cloudSqlDialects: other.cloudSqlDialects})).toEqual([]);
  });

  test('the loader and a profile record the looked-up dialect on the entity', () => {
    const CS = 'cloudsql.googleapis.com/projects/p/locations/l/instances/my/' +
        'databases/shop/tables/orders';
    const doc = (source: string) => ({
      version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'shop',
        entities: [{name: 'orders', source, primary_key: ['id'], fields: [{name: 'id', expression: 'id'}]}],
      }],
    });
    const opts = {cloudSqlDialects: new Map([[CS, 'MYSQL']])};
    const [model] = fromDocument(doc(CS), opts).models;
    expect(model.entities[0].sourceDialect).toBe('MYSQL');
    expect(sourcesDialect(model)).toBe('MYSQL');
    // Without the lookup, nothing is recorded and no dialect is implied.
    const [unread] = fromDocument(doc(CS)).models;
    expect(unread.entities[0].sourceDialect).toBeUndefined();
    expect(sourcesDialect(unread)).toBeUndefined();
    // A profile that rebinds the entity elsewhere drops the recorded dialect.
    const rebound = applyProfile(model, {
      name: 'bq', entities: [{name: 'orders', source: BQ('orders')}], relationships: [],
    }, {load: opts});
    expect(rebound.entities[0].sourceDialect).toBeUndefined();
    expect(sourcesDialect(rebound)).toBe('BIGQUERY');
    // The recorded dialect is never written back into a model file.
    expect(serializeModel(model).yaml).not.toContain('MYSQL');
    expect(serializeModel(model).yaml).not.toContain('sourceDialect');
  });

  // Every bound field has a text its profile's database can run.
  test('a bound field needs an expression for the profile\'s dialect or ANSI_SQL', () => {
    expect(validateProfileCompleteness(bqOnly(), atSource(SP('Orders'))).join('\n'))
        .toContain("field 'orders.amount' has no expression for SPANNER or ANSI_SQL");
    expect(validateProfileCompleteness(bqOnly(), atSource(BQ('orders_prod')))).toEqual([]);
    const ansi = shop(
        {expression: 'orders.id', dialects: [{dialect: 'ANSI_SQL', expression: 'orders.id'}]});
    expect(validateProfileCompleteness(ansi, atSource(SP('Orders')))).toEqual([]);
  });

  test('a field the profile rebinds needs a text for the profile\'s dialect too', () => {
    const rebound = (source: string, expression: string) => loadProfileFile(
        `name: p\nentities:\n  - name: orders\n    source: ${source}\n` +
            `    primary_key: [id]\n    fields:\n      - {name: id, expression: id}\n` +
            `      - name: amount\n        expression: ${expression}\n`,
        'p');
    expect(validateProfileCompleteness(
               bqOnly(),
               rebound(BQ('orders_prod'), '{dialects: [{dialect: SPANNER, expression: amt}]}'))
               .join('\n'))
        .toContain("field 'orders.amount' has no expression for BIGQUERY or ANSI_SQL");
    // The short form matches every engine.
    expect(validateProfileCompleteness(bqOnly(), rebound(SP('Orders'), 'Amount'))).toEqual([]);
  });

  // The one-database rule reads a source as the loader's reader does, trimmed,
  // and an empty source is reported once.
  test('a padded source is read trimmed, and an empty one reported once', () => {
    const model: SemanticModel = {
      name: 'shop',
      entities: [
        {name: 'orders', dataSource: BQ('orders'), keys: ['id'],
         fields: [{name: 'id', expression: 'id'}]},
        {name: 'items', dataSource: BQ('items'), keys: ['id'],
         fields: [{name: 'id', expression: 'id'}]},
      ],
      relationships: [], metrics: [],
    } as any;
    const spec = (source: string): ProfileSpec => ({
      name: 'p',
      entities: [keyedById('orders', source), keyedById('items', BQ('items'))],
      relationships: [],
    });
    expect(validateProfileCompleteness(model, spec(` ${SP('Orders')} `)).join('\n'))
        .toContain('more than one database');
    const empty = validateProfileCompleteness(model, spec(''));
    expect(empty.filter(e => e.includes("'orders'") || e.includes("source ''")))
        .toHaveLength(1);
  });

  // The completeness check reads the text the graph generators will emit for
  // the profile's engine: the entry for its dialect, else the ANSI_SQL entry.
  test('the completeness check reads the ANSI_SQL text when no entry matches', () => {
    const model = loadModels(`version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    entities:
      - name: orders
        source: "${BQ('orders')}"
        primary_key: [id]
        fields:
          - {name: id, expression: id}
          - {name: gross, expression: g}
          - {name: tax, expression: t}
          - {name: net, expression: "orders.gross - orders.tax"}
    metrics:
      - {name: total_tax, entity: orders, expression: SUM(orders.tax)}
`).models[0];
    const errors = validateProfileCompleteness(model, {
      name: 'p',
      entities: [{name: 'orders', source: BQ('orders_p'), fieldsExclude: ['tax']}],
      relationships: [],
    }).join('\n');
    expect(errors).toContain("field 'orders.net' depends on 'orders.tax'");
    expect(errors).toContain("metric 'total_tax' reaches 'orders.tax'");
  });

  // For a binding with no dialect list, the text is the imported one when its
  // dialect is the profile's, as expressionForDialect selects it for the
  // generators.
  test('a binding with no dialect list is judged by the text for its engine', () => {
    const model: SemanticModel = {
      name: 'shop',
      entities: [{name: 'orders', dataSource: SP_DATA('Orders'), keys: ['id'],
                  fields: [{name: 'id', expression: 'id'},
                           {name: 'a', expression: 'a'},
                           {name: 'b', expression: 'b'},
                           {name: 'x'}]}],
      relationships: [], metrics: [],
    } as any;
    const excluding = (field: string) => validateProfileCompleteness(model, {
      name: 'p',
      entities: [{
        name: 'orders', source: SP('Orders'), fieldsExclude: [field],
        fields: [{name: 'x', expression: 'orders.b',
                  importedExpression: 'orders.a', importedDialect: 'SPANNER'}],
      }],
      relationships: [],
    }).join('\n');
    expect(excluding('a')).toContain("field 'orders.x' depends on 'orders.a'");
    expect(excluding('b')).not.toContain("field 'orders.x'");
  });

  // A source written as a GCP resource name implies its system's dialect and
  // counts as its database for the one-database rule.
  test('a source written as a resource name implies its dialect and database', () => {
    expect(sourcesDialect({entities: [
      {name: 'orders', dataSource: SP_DATA('Orders'), authoredSource: SP('Orders'),
       keys: [], fields: []},
    ]} as any)).toBe('SPANNER');
    expect(validateProfileCompleteness(bqOnly(), atSource(BQ('orders_prod'))))
        .toEqual([]);

    const model: SemanticModel = {
      name: 'shop',
      entities: [
        {name: 'orders', dataSource: SP_DATA('Orders'), keys: ['id'],
         fields: [{name: 'id', expression: 'id'}]},
        {name: 'items', dataSource: SP_DATA('Items'), keys: ['id'],
         fields: [{name: 'id', expression: 'id'}]},
      ],
      relationships: [], metrics: [],
    } as any;
    const spec = (orders: string, items: string): ProfileSpec => ({
      name: 'p',
      entities: [{name: 'orders', source: orders}, {name: 'items', source: items}],
      relationships: [],
    });
    expect(validateProfileCompleteness(model, spec(SP('Orders'), SP('Items'))).join('\n'))
        .not.toContain('more than one database');
    expect(validateProfileCompleteness(
               model, spec(SP('Orders'), BQ('items'))).join('\n'))
        .toContain('more than one database');
  });

  // A profile's rebinding is read as the model file's source is: a GCP
  // resource name keeps the form written in `authoredSource`, which push
  // stores and pull returns, and gets the IR's `dataSource`.
  test('a profile rebinds a source written as a resource name', () => {
    const doc = {name: 'shop.yaml', text: `version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    entities:
      - name: orders
        primary_key: [id]
        fields:
          - {name: id, expression: id}
`};
    for (const [name, dataSource] of [
           [SP('Orders'), SP_DATA('Orders')], [BQ('orders'), 'p.d.orders']]) {
      const rebound = (source: string) => {
        const res = profileForDocument(
            doc, [{name: 'p', text: `name: p\nentities:\n  - name: orders\n    source: "${source}"\n`}],
            'p');
        if (res.kind !== 'file') throw new Error(JSON.stringify(res));
        return res.model.entities![0];
      };
      expect(rebound(name).authoredSource).toBe(name);
      expect(rebound(name).dataSource).toBe(dataSource);
    }
  });

  // Two databases of one system imply that system's dialect.
  test('sources in two Spanner databases read the SPANNER text', () => {
    const SP2 = (db: string, t: string) =>
        `spanner.googleapis.com/projects/p/instances/i/databases/${db}/tables/${t}`;
    const model: SemanticModel = {
      name: 'shop',
      entities: [
        {name: 'orders', dataSource: `//${SP2('db1', 'Orders')}`,
         authoredSource: SP2('db1', 'Orders'), keys: ['id'],
         fields: [
           {name: 'id', expression: 'id'},
           {name: 'gross', expression: 'g'},
           {name: 'tax'},
           {name: 'net', expression: 'orders.gross',
            dialects: [{dialect: 'SPANNER', expression: 'orders.gross'},
                       {dialect: 'POSTGRES', expression: 'orders.gross - orders.tax'}]},
         ]},
        {name: 'items', dataSource: `//${SP2('db2', 'Items')}`,
         authoredSource: SP2('db2', 'Items'), keys: ['id'],
         fields: [{name: 'id', expression: 'id'}]},
      ],
      relationships: [], metrics: [],
    } as any;
    expect(pruneUnavailable(model, 'default').report.droppedFields).toEqual([]);
  });

  // The dialect comes from the profile's own sources, so leaving an entity's
  // source out does not hide a dialect error.
  test('a missing source does not hide a dialect error', () => {
    const model: SemanticModel = {
      name: 'shop',
      entities: [
        {name: 'customer', dataSource: BQ('customer'), keys: ['id'],
         fields: [{name: 'id', expression: 'c_id',
                   dialects: [{dialect: 'BIGQUERY', expression: 'c_id'}]}]},
        {name: 'orders', dataSource: BQ('orders'), keys: ['id'],
         fields: [{name: 'id', expression: 'o_id'}]},
      ],
      relationships: [], metrics: [],
    } as any;
    const errors = validateProfileCompleteness(model, {
      name: 'p', entities: [{name: 'customer', source: SP('Customer')}],
      relationships: [],
    }).join('\n');
    expect(errors).toContain("entity 'orders' has no source in this profile");
    expect(errors).toContain(
        "field 'customer.id' has no expression for SPANNER or ANSI_SQL");
  });

  // A legacy bare name names BigQuery however many parts it is written with,
  // so pruning reads the BIGQUERY text.
  test('a legacy bare source of one part reads the BIGQUERY text', () => {
    const model: SemanticModel = {
      name: 'shop',
      entities: [{
        name: 'orders', dataSource: 'acme.sales.orders', authoredSource: 'orders',
        keys: ['id'],
        fields: [
          {name: 'id', expression: 'id'},
          {name: 'gross', expression: 'g'},
          {name: 'tax'},
          {name: 'net', expression: 'orders.gross',
           dialects: [{dialect: 'BIGQUERY', expression: 'orders.gross'},
                      {dialect: 'SPANNER', expression: 'orders.tax'}]},
        ],
      }],
      relationships: [], metrics: [],
    } as any;
    expect(pruneUnavailable(model, 'default').report.droppedFields).toEqual([]);
  });

  // A value the loader's readers reject is a message, not a crash, in the
  // consistency check too.
  test('the consistency check reports a rejected source without throwing', () => {
    const model: SemanticModel = {
      name: 'shop',
      entities: [{name: 'orders', dataSource: BQ('orders'), keys: ['id'],
                  fields: [{name: 'id', expression: 'id'}]}],
      relationships: [], metrics: [],
    } as any;
    expect(() => validateProfileConsistency(model, [
      {name: 'p', entities: [{name: 'orders', source: 'prod.orders'}], relationships: []},
    ])).not.toThrow();
  });

  // The completeness check reports every name apply would reject, with the
  // same words: an unknown action, and a `sql` executor in the model.
  test('the completeness check rejects what apply rejects, in its words', () => {
    const model: SemanticModel = {
      name: 'shop',
      entities: [{name: 'orders', dataSource: BQ('orders'), keys: ['id'],
                  fields: [{name: 'id', expression: 'id'}]}],
      relationships: [], metrics: [],
      actions: [{name: 'Close', executor: {kind: 'sql', sql: {statements: ['UPDATE x SET y = 1']}}}],
    } as any;
    const profile: ProfileSpec = {
      name: 'p', entities: [{name: 'orders', source: BQ('orders_p')}],
      relationships: [], metricsExclude: ['nope'],
      actions: [{name: 'Ghost'}],
    };
    const errors = validateProfileCompleteness(model, profile);
    let applied = '';
    try { applyProfile(model, profile); } catch (err: any) { applied = err.message; }
    expect(errors).toContain(applied);
    expect(applied).toContain("declares a 'sql' executor");
    expect(errors.join('\n')).toContain("action 'Ghost' is not in the logical model");
    expect(errors.join('\n'))
        .toContain("metric 'nope' in 'metrics_exclude' is not in the logical model");
  });

  // A profile held in memory whose expression the reader rejects gets that
  // error alone, not a second one saying the field is unbound.
  test('a rejected expression in memory is reported once', () => {
    const model: SemanticModel = {
      name: 'shop',
      entities: [{name: 'orders', dataSource: BQ('orders'), keys: ['id'],
                  fields: [{name: 'id', expression: 'id'}, {name: 'amount'}]}],
      relationships: [], metrics: [],
    } as any;
    const errors = validateProfileCompleteness(model, {
      name: 'p', relationships: [],
      entities: [{name: 'orders', source: BQ('orders_p'), fields: [{
        name: 'amount', expression: 'a',
        dialects: [{dialect: 'BigQuery' as any, expression: 'a'}],
      }]}],
    });
    expect(errors.filter(e => e.includes("'amount'") || e.includes('orders.amount')))
        .toEqual([expect.stringContaining("Unknown dialect 'BigQuery'")]);
  });

  // Only a mistake the loader's readers report is a profile error. A bug,
  // here a source that is not even a string, surfaces as itself.
  test('an internal error is not reported as a profile error', () => {
    const model: SemanticModel = {
      name: 'shop',
      entities: [{name: 'orders', dataSource: BQ('orders'), keys: ['id'],
                  fields: [{name: 'id', expression: 'id'}]}],
      relationships: [], metrics: [],
    } as any;
    const broken: ProfileSpec = {
      name: 'p', entities: [{name: 'orders', source: 42 as any}],
      relationships: [],
    };
    expect(() => applyProfile(model, broken)).toThrow(TypeError);
    expect(() => validateProfileCompleteness(model, broken)).toThrow(TypeError);
  });

  // A profile held in memory names itself when the loader's reader rejects
  // its source, as a profile file does.
  test('applyProfile names the profile when a source is rejected', () => {
    const model: SemanticModel = {
      name: 'shop',
      entities: [{name: 'orders', dataSource: BQ('orders'), keys: ['id'],
                  fields: [{name: 'id', expression: 'id'}]}],
      relationships: [], metrics: [],
    } as any;
    expect(() => applyProfile(model, {
             name: 'p',
             entities: [{name: 'orders', source: 'prod.orders'}],
             relationships: [],
           }))
        .toThrow("profile 'p': entity 'orders': bare table name 'prod.orders'");
  });

  // Pruning reads only the SPANNER text when a field has one. Under a Spanner
  // profile an ANSI_SQL text is read as Spanner SQL, so a hex literal,
  // which generic SQL cannot read, still reads the field.
  test('pruning reads an ANSI_SQL text in the profile\'s dialect', () => {
    const hex = 'IF(orders.code = 0x1F, 1, 0)';
    const model: SemanticModel = {
      name: 'shop',
      entities: [{
        name: 'orders', dataSource: SP_DATA('Orders'), authoredSource: SP('Orders'),
        keys: ['id'],
        fields: [
          {name: 'id', expression: 'id'},
          {name: 'code'},
          {name: 'flag', expression: hex,
           dialects: [{dialect: 'ANSI_SQL', expression: hex}]},
          {name: 'kept', expression: hex,
           dialects: [{dialect: 'SPANNER', expression: 'orders.id'},
                      {dialect: 'ANSI_SQL', expression: hex}]},
        ],
      }],
      relationships: [], metrics: [],
    } as any;
    const {report} = pruneUnavailable(model, 'default');
    expect(report.droppedFields.map(d => d.name)).toEqual(['orders.flag']);
  });

  // A metric is judged by the text its profile's dialect selects.
  test('a metric reads only the text its profile\'s dialect selects', () => {
    const model = (): SemanticModel => ({
      name: 'shop',
      entities: [{
        name: 'orders', dataSource: BQ('orders'), keys: ['id'],
        fields: [{name: 'id', expression: 'id'},
                 {name: 'amount', expression: 'amt'},
                 {name: 'tax', expression: 'tx'}],
      }],
      relationships: [],
      metrics: [{
        name: 'total', entity: 'orders',
        expression: 'SUM(orders.tax)',
        dialects: [{dialect: 'BIGQUERY', expression: 'SUM(orders.tax)'},
                   {dialect: 'SPANNER', expression: 'SUM(orders.amount)'}],
      }],
    } as any);
    const excludingTax = (source: string): ProfileSpec => ({
      name: 'p',
      entities: [{...keyedById('orders', source, column('amount', 'amt')), fieldsExclude: ['tax']}],
      relationships: [],
    });
    expect(validateProfileCompleteness(model(), excludingTax(SP('Orders'))))
        .toEqual([]);
    expect(validateProfileCompleteness(model(), excludingTax(BQ('orders_prod')))
               .join('\n'))
        .toContain("metric 'total'");
  });

  // A model file's field keeps every text the loader read, and the string form
  // is an ANSI_SQL text, which every engine runs.
  test('a model file field is judged by the texts the loader keeps', () => {
    const loaded = (amount: string) => loadModels(`version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    entities:
      - name: orders
        source: "${BQ('orders')}"
        primary_key: [id]
        fields:
          - {name: id, expression: id}
          - name: amount
            expression: ${amount}
`).models[0];
    expect(validateProfileCompleteness(
               loaded('{dialects: [{dialect: BIGQUERY, expression: orders.id}]}'),
               atSource(SP('Orders')))
               .join('\n'))
        .toContain("field 'orders.amount' has no expression for SPANNER or ANSI_SQL");
    expect(validateProfileCompleteness(loaded('orders.id'), atSource(SP('Orders'))))
        .toEqual([]);
  });

  // Only `entity.field` names a field; a struct path does not.
  test('a struct path segment named like an entity reads no entity', () => {
    const model = {
      name: 'm',
      entities: [
        {name: 'orders', dataSource: BQ('o'), keys: ['id'],
         fields: [{name: 'id', expression: 'id'}, {name: 'cust'}]},
        {name: 'customer', dataSource: BQ('c'), keys: ['id'],
         fields: [{name: 'id', expression: 'id'}]},
      ],
      relationships: [], metrics: [],
    } as any;
    expect(validateProfileCompleteness(model, {
      name: 'p',
      entities: [
        keyedById('orders', BQ('o'), column('cust', 'details.customer.id')),
        keyedById('customer', BQ('c')),
      ],
      relationships: [],
    })).toEqual([]);
  });

  // A key is covered only when all its columns are in to_columns, so [a, a]
  // does not cover [a, b].
  test('a repeated join column covers no key', () => {
    const model = {
      name: 'm',
      entities: [
        {name: 'customer', dataSource: '', keys: ['a', 'b'], fields: []},
        {name: 'orders', dataSource: '', keys: ['o'], fields: []},
      ],
      relationships: [{
        name: 'placed_by',
        source: {entity: 'orders', columns: ['x', 'y']},
        destination: {entity: 'customer', columns: ['a', 'b']},
      }],
    } as any;
    expect(validateProfileConsistency(model, [{
      name: 'p', entities: [],
      relationships: [{name: 'placed_by', fromColumns: ['x', 'y'], toColumns: ['a', 'a']}],
    }]).join('\n')).toContain(
        "profile 'p' joins on to_columns [\"a\",\"a\"], which cover no primary " +
        "or unique key of 'customer'");
  });

  test('pruning drops a metric the profile excludes, and names it excluded', () => {
    const model = shop({expression: 'amount'});
    model.metrics = [{name: 'revenue', expression: 'SUM(orders.amount)'}] as any;
    const marked = applyProfileExclusions(model, [{model: 'shop', metric: 'revenue'}]);
    expect(marked.excludedMetrics).toEqual(['revenue']);
    expect(model.excludedMetrics).toBeUndefined();
    const {model: pruned, report} = pruneUnavailable(marked, 'ops');
    expect(pruned.metrics).toEqual([]);
    expect(report.droppedMetrics).toEqual([{name: 'revenue', reason: 'excluded'}]);
    // An excluded metric names no field, even when the field it reads is unbound.
    const unbound = {...marked, entities: shop({}).entities};
    expect(pruneUnavailable(unbound, 'ops').report.droppedMetrics)
        .toEqual([{name: 'revenue', reason: 'excluded'}]);
  });

  // Actions are out of preview scope and gain no new checks.
  test('a profile file may list an action twice, as the merge always allowed', () => {
    expect(loadProfileFile('name: p\nactions:\n  - {name: Cancel}\n  - {name: Cancel}\n', 'p')
               .actions!.length)
        .toBe(2);
  });
});


describe('excluding a field a subtype redeclares', () => {
  // A redeclaration sets `expression` and nothing else, so
  // excluding the field drops the whole line rather than leave a bare name.
  test('drops the redeclaration line, and the subtype still inherits the field', () => {
    const logical = {
      version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm',
        entities: [
          {name: 'customer', source: 'bigquery.googleapis.com/projects/p/datasets/d/tables/c', primary_key: ['id'],
           fields: [{name: 'id', expression: 'id'}, {name: 'name', expression: 'cust_name'}]},
          {name: 'vip', extends: ['customer'], source: 'bigquery.googleapis.com/projects/p/datasets/d/tables/v', primary_key: ['id'],
           fields: [{name: 'name', expression: 'vip_name'}]},
        ],
      }],
    };
    const {doc, error, excluded} = mergeProfile(
        logical, {name: 'p', entities: [{name: 'vip', fields_exclude: ['name']}]}, 'p');
    expect(error).toBeUndefined();
    const vip = (doc as any).semantic_model[0].entities[1];
    expect(vip.fields).toEqual([]);
    expect(excluded).toEqual([{model: 'm', entity: 'vip', field: 'name'}]);
  });
});


// A relationship's to_columns must cover a key of its target in every binding,
// and a superset counts.
describe('a relationship joins on a key of its target', () => {
  const BQ = (t: string) => `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
  const model = (customer: object, to: string[]) => ({
    name: 'm',
    entities: [
      {name: 'customer', dataSource: BQ('c'), keys: [], fields: [], ...customer},
      {name: 'orders', dataSource: BQ('o'), keys: ['o_id'], fields: []},
    ],
    relationships: [{
      name: 'placed_by',
      source: {entity: 'orders', columns: to.map(c => `o_${c}`)},
      destination: {entity: 'customer', columns: to},
    }],
  } as any);
  const prod = (to: string[], customer: object = {}): ProfileSpec => ({
    name: 'prod',
    entities: [{name: 'customer', source: BQ('c2'), ...customer}],
    relationships: [{name: 'placed_by', fromColumns: to.map(c => `o_${c}`), toColumns: to}],
  });

  test('a superset of a key covers it', () => {
    expect(validateProfileConsistency(
               model({keys: ['c_id']}, ['c_id']), [prod(['c_id', 'tenant'])]))
        .toEqual([]);
  });

  test('a target with no key cannot be joined to', () => {
    expect(validateProfileConsistency(model({}, ['id']), [prod(['id'])]).join('\n'))
        .toContain("the model file joins on to_columns [\"id\"], which cover no " +
                   "primary or unique key of 'customer'");
  });

  // The primary key [tenant_id, id] contains the unique key [id]. The model
  // file joins on the unique key and prod on both keys.
  test('covering more keys in one binding than another is accepted', () => {
    expect(validateProfileConsistency(
               model({keys: ['tenant_id', 'id'], uniqueKeys: [['id']]}, ['id']),
               [prod(['tenant_id', 'id'])]))
        .toEqual([]);
  });
});


// A key or join column may name a field or its column, and both name the same
// column, as the graph generators read them.
describe('keys and join columns compare as the columns they name', () => {
  const BQ = (t: string) => `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
  test('a key named by field covers a join named by column, in every binding', () => {
    const model = {
      name: 'm',
      entities: [
        {name: 'customer', dataSource: BQ('c'), keys: ['key'],
         fields: [{name: 'key', expression: 'c_key'}]},
        {name: 'orders', dataSource: BQ('o'), keys: ['o_id'], fields: []},
      ],
      relationships: [{
        name: 'placed_by',
        source: {entity: 'orders', columns: ['cust']},
        destination: {entity: 'customer', columns: ['c_key']},
      }],
    } as any;
    // prod binds the key field to another column and joins on that column,
    // without restating the primary key.
    const prod: ProfileSpec = {
      name: 'prod',
      entities: [{name: 'customer', source: BQ('c2'),
                  fields: [{name: 'key', expression: 'c_custkey'}]}],
      relationships: [{name: 'placed_by', fromColumns: ['o_cust'], toColumns: ['c_custkey']}],
    };
    expect(validateProfileConsistency(model, [prod])).toEqual([]);
  });

  test('a relationship through a junction table is not checked', () => {
    const model = {
      name: 'm',
      entities: [
        {name: 'a', dataSource: BQ('a'), keys: ['id'], fields: []},
        {name: 'b', dataSource: BQ('b'), keys: ['id'], fields: []},
      ],
      relationships: [{
        name: 'a_b', association: {dataSource: BQ('ab')},
        source: {entity: 'a', columns: ['x']},
        destination: {entity: 'b', columns: ['not_a_key']},
      }],
    } as any;
    expect(validateProfileConsistency(model, [])).toEqual([]);
  });
});


describe('a profile applied to a model document', () => {
  const BQ = (t: string) => `bigquery.googleapis.com/projects/acme/datasets/raw/tables/${t}`;
  const DOC = {name: 'sales', text: `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    entities:
      - name: party
        abstract: true
        fields:
          - {name: id}
      - name: orders
        source: "${BQ('orders')}"
        fields:
          - {name: id, expression: o_id}
          - {name: amount}
      - name: items
        primary_key: [id]
        fields:
          - {name: id, expression: i_id}
    metrics:
      - name: total
        entity: orders
        expression:
          dialects:
            - {dialect: SPANNER, expression: SUM(orders.amount)}
`};
  const FILE = `name: prod
entities:
  - name: orders
    source: "${BQ('orders_prod')}"
    primary_key: []
    fields:
      - {name: amount, expression: amt}
`;

  // A profile held in memory takes the same path as the same profile in a
  // file, so it gets the same model, warnings and missing sources.
  test('a profile held in memory and its file give the same result', () => {
    const fromFile = profileForDocument(DOC, [{name: 'prod', text: FILE}], 'prod');
    const fromSpec = profileForDocument(
        DOC, [{name: 'prod', spec: loadProfileFile(FILE, 'prod')}], 'prod');
    expect(fromSpec).toEqual(fromFile);
    if (fromFile.kind !== 'file') throw new Error(JSON.stringify(fromFile));
    // The model file as it loads on its own comes back too.
    expect(fromFile.base.entities.find(e => e.name === 'orders')!.dataSource)
        .toBe('acme.raw.orders');
    // An abstract entity needs no source; `items` has none in either file.
    expect(fromFile.sourceless).toEqual(['items']);
    // A profile's empty primary key warns, as the model file's would.
    expect(fromFile.warnings)
        .toContain("[sales] dataset 'orders': no primary_key; the entity's KEY will be empty (invalid for graph generation)");
  });

  // A profile file that binds a Cloud SQL table written as its resource name
  // records the dialect the command looked up, on the model it gives.
  test('a profile file applied to its document records a looked-up Cloud SQL dialect', () => {
    const CS = 'cloudsql.googleapis.com/projects/p/locations/l/instances/pg/' +
        'databases/shop/schemas/sales/tables/orders';
    const file = FILE.replace(`"${BQ('orders_prod')}"`, `"${CS}"`);
    const res = profileForDocument(DOC, [{name: 'prod', text: file}], 'prod', {
      cloudSqlDialects: new Map([[CS, 'POSTGRES']]),
    });
    if (res.kind !== 'file') throw new Error(JSON.stringify(res));
    expect(res.model.entities.find(e => e.name === 'orders')!.sourceDialect)
        .toBe('POSTGRES');
    // A model file's own Cloud SQL source keeps its dialect under a profile
    // that does not rebind it.
    const withCs = {name: 'sales', text: DOC.text.replace(`"${BQ('orders')}"`, `"${CS}"`)};
    expect(withCs.text).toContain(CS);
    const kept = profileForDocument(withCs, [{name: 'prod', text: 'name: prod\n'}], 'prod', {
      cloudSqlDialects: new Map([[CS, 'POSTGRES']]),
    });
    if (kept.kind !== 'file') throw new Error(JSON.stringify(kept));
    expect(kept.model.entities.find(e => e.name === 'orders')!.sourceDialect)
        .toBe('POSTGRES');
    const unread = profileForDocument(DOC, [{name: 'prod', text: file}], 'prod');
    if (unread.kind !== 'file') throw new Error(JSON.stringify(unread));
    expect(unread.model.entities.find(e => e.name === 'orders')!.sourceDialect)
        .toBeUndefined();
  });

  // A model with a `sql` executor reports that first, before reading a
  // profile file that does not even parse, as the merge does.
  test('a sql executor in the model is reported before a broken profile file', () => {
    const withSql = {name: 'sales', text: DOC.text + `    actions:
      - name: Close
        executor:
          sql:
            statements: [UPDATE x SET y = 1]
`};
    const res = profileForDocument(
        withSql, [{name: 'prod', text: 'name: prod\nentities: 7\n'}], 'prod');
    expect(res.kind === 'error' && res.error).toContain("declares a 'sql' executor");
  });

  test('an expression of the wrong shape is rejected with the loader\'s words', () => {
    expect(() => loadProfileFile(
               'name: prod\nentities:\n  - name: orders\n    fields:\n      - {name: amount, expression: 7}\n',
               'prod'))
        .toThrow("field 'amount': 'expression' must be a string or a list of dialects");
  });

  // With every metric excluded, none needs a text for the profile's dialect.
  test('metrics_exclude "*" leaves no metric to judge by dialect', () => {
    const base = loadModels(DOC.text, {bindingOptional: true}).models[0];
    const errors = validateProfileCompleteness(base, {
      name: 'p', relationships: [], metricsExclude: '*',
      entities: [
        {name: 'orders', source: BQ('orders_p'), fieldsExclude: ['amount']},
        {name: 'items', source: BQ('items_p')},
      ],
    });
    expect(errors.join('\n')).not.toContain("metric 'total'");
  });
});


// A mistake in a model or profile document is a SemanticModelError, which is
// what the callers report to the author. Anything else is a bug and surfaces
// as itself.
describe('a document mistake versus a bug', () => {
  const BQ = (t: string) => `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
  const model = (): SemanticModel => ({
    name: 'shop',
    entities: [{name: 'orders', dataSource: BQ('orders'), keys: ['id'],
                fields: [{name: 'id', expression: 'id'}, {name: 'amount'}]}],
    relationships: [], metrics: [],
  } as any);
  const FILE = 'name: p\nentities:\n  - name: orders\n    fields:\n      - {name: amount, expression: amt}\n';

  test('the readers throw a SemanticModelError for a mistake', () => {
    expect(() => loader.parseSource('orders', {}, "entity 'orders'"))
        .toThrow(SemanticModelError);
    expect(() => loader.parseFieldExpression(7, "field 'a'", 'BIGQUERY', 'e'))
        .toThrow(SemanticModelError);
    expect(() => loader.parseExecutor({mcp: {}}, "action 'a'"))
        .toThrow(SemanticModelError);
    expect(() => loadProfileFile('name: p\nentities: 7\n', 'p'))
        .toThrow(SemanticModelError);
    expect(() => loadModels('version: nope\n')).toThrow(SemanticModelError);
  });

  const boom = () => {
    throw new TypeError('boom');
  };

  test('reading a profile file does not report a bug as a profile error', () => {
    const spy = spyOn(loader, 'parseFieldExpression').mockImplementation(boom);
    try {
      expect(() => applyProfileFile(model(), FILE, 'p')).toThrow(TypeError);
      expect(() => mergeProfileImpl(
                 {semantic_model: [{name: 'shop', datasets: []}]},
                 yaml.parse(FILE), 'p'))
          .toThrow(TypeError);
    } finally {
      spy.mockRestore();
    }
  });

  test('checking a profile held in memory does not report a bug either', () => {
    const spy = spyOn(loader, 'parseFieldExpression').mockImplementation(boom);
    try {
      expect(() => applyProfile(model(), {
               name: 'p', relationships: [],
               entities: [{name: 'orders', fields: [{
                 name: 'amount', expression: 'amt',
                 dialects: [{dialect: 'BIGQUERY', expression: 'amt'}],
               }]}],
             }))
          .toThrow(TypeError);
    } finally {
      spy.mockRestore();
    }
  });

  test('a load does not report a bug as a model error', () => {
    const spy =
        spyOn(sqlUtils, 'columnReferences').mockImplementation(boom);
    try {
      expect(() => loadSemanticModels([{name: 'shop', text: `version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    entities:
      - name: orders
        source: "${BQ('orders')}"
        primary_key: [id]
        fields:
          - {name: id, expression: id}
    metrics:
      - {name: n, expression: COUNT(orders.id)}
`}])).toThrow(TypeError);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('what applying a profile keeps and replaces', () => {
  const SP = (t: string) =>
      `spanner.googleapis.com/projects/p/instances/i/databases/db/tables/${t}`;
  const model = (): SemanticModel => ({
    name: 'shop',
    entities: [
      {name: 'party', abstract: true, dataSource: '', keys: [],
       fields: [{name: 'pid'}]},
      {name: 'orders', dataSource: `//${SP('Orders')}`, authoredSource: SP('Orders'),
       keys: ['id'],
       fields: [
         {name: 'id', expression: 'id'},
         {name: 'tax'},
         // The SPANNER text, as a load for Spanner picks it, is the emitted
         // one; only the BIGQUERY text reads the unbound `tax`.
         {name: 'net', expression: 'orders.id',
          importedExpression: 'orders.id', importedDialect: 'SPANNER',
          dialects: [{dialect: 'BIGQUERY', expression: 'orders.tax'},
                     {dialect: 'SPANNER', expression: 'orders.id'}]},
       ]},
      {name: 'customer', dataSource: `//${SP('Customer')}`, authoredSource: SP('Customer'),
       keys: ['id'], fields: [{name: 'id', expression: 'id'}]},
    ],
    relationships: [{name: 'placed_by',
                     source: {entity: 'orders', columns: ['o_cust']},
                     destination: {entity: 'customer', columns: ['id']}}],
    metrics: [],
  } as any);

  // A rebound field loses its old texts, so no SPANNER text lingers.
  test('a rebound field keeps none of its old texts', () => {
    const applied = applyProfile(model(), {
      name: 'p', relationships: [],
      entities: [{name: 'orders', fields: [{
        name: 'net', expression: 'c', stringForm: true,
        dialects: [{dialect: 'ANSI_SQL', expression: 'c'}],
      }]}],
    });
    const net = applied.entities.find(e => e.name === 'orders')!
                    .fields.find(f => f.name === 'net')!;
    expect(net.dialects).toEqual([{dialect: 'ANSI_SQL', expression: 'c'}]);
    expect(net.importedExpression).toBeUndefined();
  });

  // A named profile states both join column lists itself, and the model
  // file's other side does not stand in for one it leaves out. Applying a
  // profile that states one side gives the completeness check's error.
  test('one join side alone gets the completeness error', () => {
    const error = "profile 'p': relationship 'placed_by' has no join " +
        "columns in this profile; a named profile states both " +
        "'from_columns' and 'to_columns' itself";
    for (const [fromColumns, toColumns] of [[['cust_fk'], []], [[], ['key2']]]) {
      const profile: ProfileSpec = {
        name: 'p', entities: [],
        relationships: [{name: 'placed_by', fromColumns, toColumns}],
      };
      expect(() => applyProfile(model(), profile)).toThrow(error);
      expect(validateProfileCompleteness(model(), profile)).toContain(error);
    }
  });

  // An abstract entity has no source, so it does not keep the sources from
  // naming one dialect.
  test('an abstract entity does not hide the dialect', () => {
    expect(pruneUnavailable(model(), 'default').report.droppedFields).toEqual([]);
  });
});

// The options b/568184633 uses: the warnings the profile's values give, and
// the dialect a profile's texts are picked for.
describe('applyProfile options', () => {
  const SP = (t: string) =>
      `spanner.googleapis.com/projects/p/instances/i/databases/db/tables/${t}`;
  const BQ = (t: string) => `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
  const base = (): SemanticModel => ({
    name: 'shop',
    entities: [{name: 'orders', dataSource: BQ('orders'), authoredSource: BQ('orders'),
                keys: ['id'],
                fields: [{name: 'id', expression: 'id'}, {name: 'amount'}]}],
    relationships: [], metrics: [],
  } as any);
  const rebind = (source: string): ProfileSpec => ({
    name: 'p', relationships: [],
    entities: [{name: 'orders', source, primaryKey: [], fields: [{
      name: 'amount', expression: 'amt',
      dialects: [{dialect: 'SPANNER', expression: 'amt'}],
    }]}],
  });

  test('warnings name what the profile\'s own values give, in the load dialect', () => {
    // The empty key warns. The load's dialect picked each field's text, so it
    // judges the Spanner-only text, whatever system the sources are in.
    const onSpanner: string[] = [];
    applyProfile(base(), rebind(SP('Orders')), {warnings: onSpanner});
    expect(onSpanner.join('\n')).toContain("dataset 'orders': no primary_key");
    expect(onSpanner.join('\n')).toContain(
        "field 'orders.amount': no 'BIGQUERY' or 'ANSI_SQL' dialect");
    const loadedForSpanner: string[] = [];
    applyProfile(
        base(), rebind(SP('Orders')),
        {warnings: loadedForSpanner, load: {dialect: 'SPANNER'}});
    expect(loadedForSpanner.join('\n')).not.toContain("field 'orders.amount'");
    // A warning the model gave already is the model's, not the profile's.
    const withOwn = base();
    withOwn.entities[0].fields.push(
        {name: 'legacy', dialects: [{dialect: 'SPANNER', expression: 'x'}]} as any);
    const own: string[] = [];
    applyProfile(withOwn, rebind(SP('Orders')), {warnings: own});
    expect(own.join('\n')).toContain("field 'orders.amount'");
    expect(own.join('\n')).not.toContain("field 'orders.legacy'");
  });

  test('the load dialect picks each field\'s text', () => {
    const applied =
        applyProfile(base(), rebind(SP('Orders')), {load: {dialect: 'SPANNER'}});
    expect(applied.entities[0].fields.find(f => f.name === 'amount')!.expression)
        .toBe('amt');
    const byDefault = applyProfile(base(), rebind(SP('Orders')));
    expect(byDefault.entities[0].fields.find(f => f.name === 'amount')!.expression)
        .toBeUndefined();
  });

  // A BigLake source is part of BigQuery, which only its authored form says.
  test('a BigLake source gives the BigQuery dialect', () => {
    const lake =
        'biglake.googleapis.com/projects/p/catalogs/c/namespaces/n/tables/orders';
    const model = base();
    model.entities[0].authoredSource = lake;
    model.entities[0].dataSource = 'p.c.n.orders';
    model.entities[0].fields.push({
      name: 'net', expression: 'orders.id',
      dialects: [{dialect: 'BIGQUERY', expression: 'orders.id'},
                 {dialect: 'SPANNER', expression: 'orders.amount'}],
    });
    // Read in BigQuery, `net` reads `id` and survives `amount` being unbound.
    expect(pruneUnavailable(model, 'default').report.droppedFields).toEqual([]);
  });
});


describe('applyProfile builds the model the YAML merge builds', () => {
  const SHOP = `version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    entities:
      - name: party
        abstract: true
        fields:
          - {name: party_name, datatype: String}
      - name: customer
        extends: [party]
        source: "bigquery.googleapis.com/projects/acme/datasets/raw/tables/customer"
        primary_key: [c_id]
        unique_keys: [[c_email]]
        fields:
          - {name: c_id, expression: c_id}
          - {name: email, expression: c_email}
          - {name: party_name, expression: c_name}
      - name: account
        source: "bigquery.googleapis.com/projects/acme/datasets/raw/tables/account"
        primary_key: [a_id]
        fields:
          - {name: a_id, expression: a_id}
          - {name: balance, expression: a_balance}
          - {name: note}
      - name: premium
        extends: [account]
        source: "bigquery.googleapis.com/projects/acme/datasets/raw/tables/premium"
        primary_key: [p_id]
        fields:
          - {name: tier, expression: p_tier}
    relationships:
      - name: holds
        from: premium
        to: customer
        from_columns: [p_cust]
        to_columns: [c_id]
      - name: refers
        from: premium
        to: customer
    metrics:
      - name: total_balance
        entity: premium
        expression: SUM(premium.balance)
      - name: customers
        entity: customer
        expression: COUNT(customer.c_id)
    actions:
      - name: Notify
        executor:
          mcp: {server: //x/mcpServers/n, tool: notify}
      - name: Close
        executor:
          rest: {endpoint: https://x/close, method: POST}
`;
  const LOAD = {defaultProject: 'acme'};

  // The model each path builds, or its error.
  const viaMerge = (model: string, profile: string) => {
    const merged = mergeProfileOntoDoc(model, profile, 'prod');
    if ('error' in merged) return {error: merged.error};
    try {
      const {models} =
          loadModels(merged.text, {...LOAD, bindingOptional: true});
      return {model: applyProfileExclusions(models[0], merged.excluded)};
    } catch (err: any) {
      return {error: String(err?.message ?? err)};
    }
  };
  const viaApply = (model: string, profile: string) => {
    const {models} = loadModels(model, {...LOAD, bindingOptional: true});
    return applyProfileFile(models[0], profile, 'prod');
  };
  // The model alone; the warnings have their own test.
  const comparable = (r: {model: SemanticModel}|{error: string}) =>
      'error' in r ? r : {model: r.model};
  const same = (profile: string, model = SHOP) => {
    const applied = viaApply(model, profile);
    expect(comparable(applied)).toEqual(comparable(viaMerge(model, profile)));
    return applied;
  };

  test('an empty unique_keys list clears the model file\'s', () => {
    const applied = same(`name: prod
entities:
  - name: customer
    unique_keys: []
`);
    if ('error' in applied) throw new Error(applied.error);
    expect(applied.model.entities.find(e => e.name === 'customer')!.uniqueKeys)
        .toBeUndefined();
  });

  test('sources and keys', () => {
    same(`name: prod
entities:
  - name: customer
    source: "bigquery.googleapis.com/projects/acme/datasets/prod/tables/customer"
    primary_key: [cust_id]
    unique_keys: [[cust_email], [cust_phone]]
  - name: account
    source: "bigquery.googleapis.com/projects/acme/datasets/prod/tables/account"
    unique_keys: []
`);
  });

  test('field bindings, dialect lists and an inherited field', () => {
    const applied = same(`name: prod
entities:
  - name: customer
    fields:
      - name: email
        expression:
          dialects:
            - {dialect: BIGQUERY, expression: e_bq}
            - {dialect: SPANNER, expression: e_sp}
      - {name: party_name, expression: cust_name}
  - name: account
    fields:
      - name: note
        expression:
          dialects:
            - {dialect: SPANNER, expression: n_sp}
      - name: balance
        expression:
          dialects:
            - {dialect: ANSI_SQL, expression: bal}
  - name: premium
    fields:
      - {name: balance, expression: p_balance}
`);
    if ('error' in applied) throw new Error(applied.error);
    const email = applied.model.entities.find(e => e.name === 'customer')!
                      .fields.find(f => f.name === 'email')!;
    expect(email.dialects).toEqual([
      {dialect: 'BIGQUERY', expression: 'e_bq'},
      {dialect: 'SPANNER', expression: 'e_sp'},
    ]);
  });

  test('exclusions, on an entity with descendants and on leaves', () => {
    same(`name: prod
entities:
  - name: account
    fields_exclude: [note, balance]
  - name: premium
    fields_exclude: [tier, a_id]
  - name: customer
    fields_exclude: [party_name]
metrics_exclude: [customers]
`);
  });

  test('an entity that names itself in extends has no descendant', () => {
    const loop = SHOP.replace(
        '    relationships:',
        `      - name: loop
        extends: [loop]
        source: "bigquery.googleapis.com/projects/acme/datasets/raw/tables/loop"
        primary_key: [l_id]
        fields:
          - {name: f, expression: c_f}
    relationships:`);
    same('name: prod\nentities: [{name: loop, fields_exclude: [f]}]\n', loop);
  });

  test('join columns, every metric excluded, and executors', () => {
    same(`name: prod
relationships:
  - {name: holds, from_columns: [prem_cust], to_columns: [cust_id]}
metrics_exclude: "*"
actions:
  - name: Notify
    executor:
      rest: {endpoint: https://y/notify, method: POST}
  - name: Close
    executor: null
`);
  });

  test('the same errors, with the same messages', () => {
    const profiles = [
      'name: prod\nentities: [{name: nope}]\n',
      'name: prod\nentities: [{name: party, source: "bigquery.googleapis.com/projects/acme/datasets/raw/tables/party"}]\n',
      'name: prod\nentities: [{name: account, fields: [{name: nope, expression: x}]}]\n',
      'name: prod\nentities: [{name: account, fields_exclude: [nope]}]\n',
      'name: prod\nrelationships: [{name: nope, from_columns: [a], to_columns: [b]}]\n',
      'name: prod\nmetrics_exclude: [nope]\n',
      'name: prod\nactions: [{name: Nope, executor: null}]\n',
      'name: prod\nversion: "0.2.0.dev0/google"\n',
    ];
    for (const profile of profiles) {
      const applied = viaApply(SHOP, profile);
      expect('error' in applied).toBe(true);
      expect(applied).toEqual(viaMerge(SHOP, profile) as any);
    }
    const sqlModel = SHOP.replace(
        'rest: {endpoint: https://x/close, method: POST}',
        'sql: {statements: ["DELETE FROM account WHERE a_id = 1"]}');
    const applied = viaApply(sqlModel, 'name: prod\n');
    expect('error' in applied).toBe(true);
    expect(applied).toEqual(viaMerge(sqlModel, 'name: prod\n') as any);
  });

  describe("the completeness check and pruning read the profile's own dialect", () => {
    const model = `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    entities:
      - name: orders
        source: "bigquery.googleapis.com/projects/acme/datasets/raw/tables/orders"
        primary_key: [order_id]
        fields:
          - {name: order_id, expression: o_id}
          - {name: gross, expression: o_gross}
          - {name: tax}
          - {name: net}
          - {name: code}
          - {name: flag}
`;
    const SPANNER = (t: string) =>
        `spanner.googleapis.com/projects/acme/instances/i/databases/db/tables/${t}`;
    const profileOf = (source: string, net: string, rest = '') => `name: prod
entities:
  - name: orders
    source: "${source}"
    primary_key: [o_id]
    fields:
      - {name: order_id, expression: o_id}
      - {name: gross, expression: o_gross}
      - name: net
        expression:
          dialects:
${net}${rest}    fields_exclude: [tax, code, flag]
`;
    const check = (profile: string) => {
      const base = loadModels(model, {bindingOptional: true}).models[0];
      const errors = validateProfileCompleteness(base, loadProfileFile(profile, 'prod'));
      const applied = applyProfileFile(base, profile, 'prod');
      if ('error' in applied) throw new Error(applied.error);
      return {errors, applied: applied.model};
    };

    test('a BigQuery profile reads the BIGQUERY text', () => {
      const {errors, applied} = check(profileOf(
          'bigquery.googleapis.com/projects/acme/datasets/prod/tables/orders',
          '            - {dialect: BIGQUERY, expression: "orders.gross"}\n' +
          '            - {dialect: ANSI_SQL, expression: "orders.gross - orders.tax"}\n'));
      expect(errors).toEqual([]);
      const {model: pruned, report} = pruneUnavailable(applied, 'prod');
      expect(report.droppedFields).toEqual([]);
      expect(pruned.entities[0].fields.map(f => f.name))
          .toEqual(['order_id', 'gross', 'net']);
    });

    test("the profile's source becomes the entity's authored source", () => {
      // The dialect is read from the authored source, so a profile that moves
      // an entity to another system is judged in that system's dialect.
      const {applied} = check(profileOf(
          SPANNER('orders'),
          '            - {dialect: SPANNER, expression: "orders.gross"}\n'));
      expect(applied.entities[0].authoredSource).toBe(SPANNER('orders'));
    });

    test('a Spanner profile reads the SPANNER text', () => {
      const {errors} = check(profileOf(
          SPANNER('orders'),
          '            - {dialect: SPANNER, expression: "orders.gross"}\n' +
          '            - {dialect: BIGQUERY, expression: "orders.gross - orders.tax"}\n'));
      expect(errors).toEqual([]);
    });

    test('pruning reads only the text the profile\'s dialect selects', () => {
      // The Spanner graph reads only the SPANNER text, so `net` stays.
      const {applied} = check(profileOf(
          SPANNER('orders'),
          '            - {dialect: SPANNER, expression: "orders.gross"}\n' +
          '            - {dialect: BIGQUERY, expression: "orders.gross - orders.tax"}\n'));
      expect(pruneUnavailable(applied, 'prod').report.droppedFields).toEqual([]);
      // No graph emits a field's vendor text, so pruning does not read it.
      const vendor = check(profileOf(
          'bigquery.googleapis.com/projects/acme/datasets/prod/tables/orders',
          '            - {dialect: SNOWFLAKE, expression: "orders.gross - orders.tax"}\n'));
      expect(pruneUnavailable(vendor.applied, 'prod').report.droppedFields)
          .toEqual([]);
    });

    test('with sources in two databases, every text counts', () => {
      const {applied} = check(profileOf(
          'bigquery.googleapis.com/projects/acme/datasets/prod/tables/orders',
          '            - {dialect: BIGQUERY, expression: "orders.gross"}\n' +
          '            - {dialect: ANSI_SQL, expression: "orders.gross - orders.tax"}\n'));
      const twoDatabases = structuredClone(applied);
      twoDatabases.entities.push({
        name: 'customers', dataSource: `//${SPANNER('customers')}`, keys: ['id'],
        fields: [{name: 'id', expression: 'id'}],
      });
      const {report} = pruneUnavailable(twoDatabases, 'prod');
      expect(report.droppedFields.map(d => d.name)).toEqual(['orders.net']);
    });

    test("an ANSI_SQL text is read as the profile's own SQL", () => {
      // The generic parser cannot read a hex literal; the BigQuery one can.
      const {applied} = check(profileOf(
          'bigquery.googleapis.com/projects/acme/datasets/prod/tables/orders',
          '            - {dialect: ANSI_SQL, expression: "orders.gross"}\n',
          `      - name: flag
        expression:
          dialects:
            - {dialect: ANSI_SQL, expression: "IF(orders.code = 0x1F, 1, 0)"}
`).replace('fields_exclude: [tax, code, flag]', 'fields_exclude: [tax, code]'));
      const {report} = pruneUnavailable(applied, 'prod');
      expect(report.droppedFields).toEqual(
          [{name: 'orders.flag', reason: 'reads orders.code, which is unavailable'}]);
      expect(report.warnings).toEqual([]);
    });
  });

  test('a profile held in memory applies as the same profile in a file', () => {
    const base = loadModels(SHOP, {...LOAD, bindingOptional: true}).models[0];
    const fromFile = applyProfileFile(base, `name: prod
entities:
  - name: account
    source: "bigquery.googleapis.com/projects/acme/datasets/prod/tables/account"
    fields:
      - {name: note, expression: a_note}
    fields_exclude: [balance]
`, 'prod');
    if ('error' in fromFile) throw new Error(fromFile.error);
    const inMemory: ProfileSpec = {
      name: 'prod',
      entities: [{
        name: 'account',
        source: 'bigquery.googleapis.com/projects/acme/datasets/prod/tables/account',
        fields: [{
          name: 'note',
          expression: 'a_note',
          dialects: [{dialect: 'ANSI_SQL', expression: 'a_note'}],
          stringForm: true,
        }],
        fieldsExclude: ['balance'],
      }],
      relationships: [],
    };
    expect(applyProfile(base, inMemory)).toEqual(fromFile.model);
  });

  test('a binding held in memory with no dialect list applies as given', () => {
    const base = loadModels(SHOP, {...LOAD, bindingOptional: true}).models[0];
    const applied = applyProfile(base, {
      name: 'prod',
      entities: [{name: 'account', fields: [{name: 'note', expression: 'n'}]}],
      relationships: [],
    });
    expect(applied.entities.find(e => e.name === 'account')!.fields.find(
               f => f.name === 'note'))
        .toEqual({name: 'note', expression: 'n'});
  });

  test('a profile held in memory gets the checks a profile file gets', () => {
    const base = loadModels(SHOP, {...LOAD, bindingOptional: true}).models[0];
    const spec = (over: Partial<ProfileSpec>): ProfileSpec =>
        ({name: 'prod', entities: [], relationships: [], ...over});
    expect(() => applyProfile(base, spec({
             entities: [{name: 'account'}, {name: 'account'}],
           }))).toThrow("profile 'prod' 'entities' lists 'account' twice");
    expect(() => applyProfile(base, spec({
             relationships: [
               {name: 'holds', fromColumns: ['a'], toColumns: ['b']},
               {name: 'holds', fromColumns: ['a'], toColumns: ['b']},
             ],
           }))).toThrow("profile 'prod' 'relationships' lists 'holds' twice");
    expect(() => applyProfile(base, spec({
             entities: [{
               name: 'account',
               fields: [{name: 'note', expression: 'a'},
                        {name: 'note', expression: 'b'}],
             }],
           })))
        .toThrow("profile 'prod': entity 'account' 'fields' lists 'note' twice");
    expect(() => applyProfile(base, spec({
             entities: [{
               name: 'account',
               fields: [{name: 'note', expression: 'a'}],
               fieldsExclude: ['note'],
             }],
           })))
        .toThrow(
            "profile 'prod': entity 'account': field 'note' is in both " +
            "'fields' and 'fields_exclude'");
    expect(() => applyProfile(base, spec({
             entities: [{name: 'account', fields: [{name: 'note'}]}],
           })))
        .toThrow(
            "profile 'prod': entity 'account': field 'note' has no " +
            "'expression'; bind it with one, or list it in 'fields_exclude'");
    expect(() => applyProfile(base, spec({
             entities: [{
               name: 'account',
               fields: [{
                 name: 'note',
                 expression: 'a',
                 dialects: [{dialect: 'BIGQUERY', expression: 'a'},
                            {dialect: 'BIGQUERY', expression: 'b'}],
               }],
             }],
           })))
        .toThrow(
            "profile 'prod': entity 'account': field 'note': 'expression': " +
            "dialects.1.dialect: Duplicate dialect 'BIGQUERY' in expression " +
            'dialects.');
    expect(() => applyProfile(base, spec({metricsExclude: ['*']})))
        .toThrow(`profile 'prod': 'metrics_exclude' takes "*" on its own, ` +
                 'not inside a list');
    // The profile checks report an entry with nothing to bind, and keep the
    // model file's binding of that field, so nothing else is blamed on it.
    const errors = validateProfileCompleteness(base, spec({
      entities: [{name: 'account', fields: [{name: 'balance'}]}],
    }));
    expect(errors).toContain(
        "profile 'prod': entity 'account': field 'balance' has no " +
        "'expression'; bind it with one, or list it in 'fields_exclude'");
    expect(errors.join('\n')).not.toContain("'account.balance'");
    expect(validateProfileCompleteness(base, spec({
      entities: [{name: 'account'}, {name: 'account'}],
    }))).toContain("profile 'prod' 'entities' lists 'account' twice");
    // A binding with no dialect list is read as the string form, so a blank
    // one is rejected as in a profile file.
    for (const [expression, reason] of [['  ', 'is blank'], ['-- todo', 'is only a comment']]) {
      expect(() => applyProfile(base, spec({
               entities: [{name: 'account', fields: [{name: 'note', expression}]}],
             })))
          .toThrow(`profile 'prod': entity 'account': field 'note': 'expression' ${reason}`);
    }
    // An imported text with no dialect list is read in its imported dialect,
    // as the generators read it. PostgreSQL reads `#` as an operator, so
    // `# path`, which counts a path's points, holds SQL there.
    const imported = (text: string) => spec({
      entities: [{
        name: 'account',
        fields: [{name: 'note', importedExpression: text, importedDialect: 'POSTGRES'}],
      }],
    });
    expect(() => applyProfile(base, imported('# path'))).not.toThrow();
    expect(() => applyProfile(base, imported('-- todo')))
        .toThrow(
            "profile 'prod': entity 'account': field 'note': the POSTGRES " +
            "entry of 'expression' is only a comment");
    // Beside a target text, the imported text is read too, as a profile file
    // with both entries is.
    const both = (text: string) => spec({
      entities: [{
        name: 'account',
        fields: [{
          name: 'note',
          expression: 'a_note',
          importedExpression: text,
          importedDialect: 'POSTGRES',
        }],
      }],
    });
    expect(() => applyProfile(base, both('# path'))).not.toThrow();
    const bothProblem = "profile 'prod': entity 'account': field 'note': the " +
        "POSTGRES entry of 'expression' is only a comment";
    expect(() => applyProfile(base, both('-- todo'))).toThrow(bothProblem);
    expect(validateProfileCompleteness(base, both('-- todo')))
        .toContain(`${bothProblem}; write the field's SQL`);
    // With no imported dialect, or one a dialect list cannot hold beside the
    // target text, the imported text is read as push reads it, also when the
    // target text has no SQL.
    for (const importedDialect of [undefined, 'BIGQUERY']) {
      for (const [expression, target] of [
             ['a_note', ''],
             ['/* todo */', "'expression' is only a comment and "],
           ]) {
        const odd = spec({
          entities: [{
            name: 'account',
            fields: [{
              name: 'note',
              expression,
              importedExpression: '-- todo',
              ...(importedDialect ? {importedDialect} : {}),
            }],
          }],
        });
        const problem = "profile 'prod': entity 'account': field 'note': " +
            `${target}'importedExpression' is only a comment; write the ` +
            "field's SQL";
        expect(() => applyProfile(base, odd)).toThrow(problem);
        expect(validateProfileCompleteness(base, odd)
                   .filter(e => e.includes("field 'note'")))
            .toEqual([problem]);
      }
    }
  });

  // A profile file with such a binding does not load, so only a profile
  // built in memory reaches completeness with it.
  test('completeness reports a rejected binding on an ancestor once, and not again on each entity that inherits it', () => {
    const shop = (abstract: boolean): SemanticModel => ({
      name: 'shop',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'base',
          dataSource: abstract ? '' : 'p.d.base',
          ...(abstract ? {abstract} : {}),
          keys: ['id'],
          fields: [{name: 'id', expression: 'id'}, {name: 'note'}],
        },
        {
          name: 'orders',
          extends: ['base'],
          dataSource: 'p.d.orders',
          keys: ['id'],
          fields: [{name: 'id', expression: 'id'}],
        },
      ],
    });
    const BQ = (t: string) =>
        `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
    const profile = (note: Partial<Field>): ProfileSpec => ({
      name: 'prod',
      relationships: [],
      entities: [
        {name: 'base', source: BQ('base'), fields: [{name: 'note', ...note}]},
        {name: 'orders', source: BQ('orders')},
      ],
    });
    const note = (errors: string[]) => errors.filter(e => e.includes('note'));
    expect(note(validateProfileCompleteness(
               shop(false), profile({expression: '-- todo'}))))
        .toEqual([
          "profile 'prod': entity 'base': field 'note': 'expression' is " +
              "only a comment; write the field's SQL",
        ]);
    expect(note(validateProfileCompleteness(
               shop(false),
               profile({dialects: [{dialect: 'NOPE' as any, expression: 'n'}]}))))
        .toEqual([
          "profile 'prod': entity 'base': field 'note': 'expression': " +
              "dialects.0.dialect: Unknown dialect 'NOPE' in expression " +
              'dialects. Expected one of ANSI_SQL, BIGQUERY, SPANNER, MYSQL, ' +
              'POSTGRES, ALLOYDB, SQLSERVER, SNOWFLAKE, DATABRICKS.',
        ]);
    // No profile binds an abstract entity, so `orders` still needs its own
    // binding.
    expect(note(validateProfileCompleteness(
               shop(true), profile({expression: 'n'}))))
        .toEqual([
          "profile 'prod': field 'orders.note' has no binding in the model " +
              "file; bind it in 'fields' or leave it out in 'fields_exclude'",
        ]);
  });

  // A field the profile lists on an ancestor that does not have it binds
  // nothing on the entity that declares it.
  test('completeness still reports a field that a listing on an ancestor does not reach', () => {
    const shop: SemanticModel = {
      name: 'shop',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'base',
          dataSource: 'p.d.base',
          keys: ['id'],
          fields: [{name: 'id', expression: 'id'}],
        },
        {
          name: 'orders',
          extends: ['base'],
          dataSource: 'p.d.orders',
          keys: ['id'],
          fields: [{name: 'id', expression: 'id'}, {name: 'extra'}],
        },
      ],
    };
    const BQ = (t: string) =>
        `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
    const profile = loadProfileFile(`name: prod
entities:
  - name: base
    source: ${BQ('base')}
    fields:
      - {name: extra, expression: x}
  - name: orders
    source: ${BQ('orders')}
`, 'prod');
    expect(validateProfileCompleteness(shop, profile)
               .filter(e => e.includes('extra')))
        .toEqual([
          "profile 'prod': field 'base.extra' is not in the logical model",
          "profile 'prod': field 'orders.extra' has no binding in the model " +
              "file; bind it in 'fields' or leave it out in 'fields_exclude'",
        ]);
  });

  // The binding is left unapplied, so nothing else is blamed on it, but its
  // problem on an entity that inherits it is its own and push reports it.
  test('completeness reads a rejected binding with no SQL on each entity that inherits it, as push does', () => {
    const shop = (note: Partial<Field>): SemanticModel => ({
      name: 'shop',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'base',
          dataSource: 'p.d.base',
          keys: ['id'],
          fields: [{name: 'id', expression: 'id'}, {name: 'note', ...note}],
        },
        {
          name: 'orders',
          extends: ['base'],
          dataSource: 'p.d.orders',
          keys: ['id'],
          fields: [{name: 'id', expression: 'id'}],
        },
      ],
    });
    const BQ = (t: string) =>
        `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
    const profile = (note: Partial<Field>): ProfileSpec => ({
      name: 'prod',
      relationships: [],
      entities: [
        {name: 'base', source: BQ('base'), fields: [{name: 'note', ...note}]},
        {name: 'orders', source: BQ('orders')},
      ],
    });
    // The target text is only a comment, and the imported text is only the
    // qualifier `orders.` on `orders`.
    const note = {
      dialects: [
        {dialect: 'BIGQUERY' as const, expression: '-- t'},
        {dialect: 'POSTGRES' as const, expression: 'base.orders.'},
      ],
    };
    const own = "the BIGQUERY entry of 'expression' is only a comment";
    const inherited = "entity 'orders' inherits field 'note': read on " +
        `'orders', ${own} and the POSTGRES entry of 'expression' is only the ` +
        "qualifier 'orders.'; write the field's SQL";
    expect(validatePushRequirements(
               [{document: 'shop.yaml', model: shop(note)}],
               {targetOptional: true}))
        .toEqual([
          `field 'base.note' in model 'shop' (shop.yaml): ${own}; write ` +
              "the field's SQL, or remove 'expression' to leave the field " +
              'unbound.',
          `model 'shop' (shop.yaml): ${inherited}.`,
        ]);
    expect(validateProfileCompleteness(shop({}), profile(note))
               .filter(e => e.includes('note')))
        .toEqual([
          `profile 'prod': entity 'base': field 'note': ${own}; write the ` +
              "field's SQL",
          `profile 'prod': ${inherited}`,
        ]);
  });

  // Only a binding the reader rejects for holding no SQL is read on each
  // entity that inherits it, and it is read as applying it would give it.
  test('completeness reads on inheriting entities only a binding rejected for no SQL, as applying it would give it', () => {
    const shop: SemanticModel = {
      name: 'shop',
      relationships: [],
      metrics: [],
      entities: [
        {
          name: 'base',
          dataSource: 'p.d.base',
          keys: ['id'],
          fields: [{name: 'id', expression: 'id'}, {name: 'note'}],
        },
        {
          name: 'orders',
          extends: ['base'],
          dataSource: 'p.d.orders',
          keys: ['id'],
          fields: [{name: 'id', expression: 'id'}],
        },
      ],
    };
    const BQ = (t: string) =>
        `bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
    const profile = (note: Partial<Field>): ProfileSpec => ({
      name: 'prod',
      relationships: [],
      entities: [
        {name: 'base', source: BQ('base'), fields: [{name: 'note', ...note}]},
        {name: 'orders', source: BQ('orders')},
      ],
    });
    const note = (errors: string[]) => errors.filter(e => e.includes('note'));
    // Rejected for a repeated dialect.
    expect(note(validateProfileCompleteness(shop, profile({
      dialects: [
        {dialect: 'BIGQUERY', expression: '-- t'},
        {dialect: 'BIGQUERY', expression: 'base.orders.'},
      ],
    })))).toEqual([
      "profile 'prod': entity 'base': field 'note': 'expression': " +
          "dialects.1.dialect: Duplicate dialect 'BIGQUERY' in expression " +
          'dialects.',
    ]);
    // A binding with a dialect list applies only the texts in the list.
    expect(note(validateProfileCompleteness(shop, profile({
      dialects: [{dialect: 'BIGQUERY', expression: '-- t'}],
      expression: 'base.orders.',
    })))).toEqual([
      "profile 'prod': entity 'base': field 'note': the BIGQUERY entry of " +
          "'expression' is only a comment; write the field's SQL",
    ]);
  });

  test('a profile held in memory fails first where a profile file would', () => {
    const base = loadModels(SHOP, {...LOAD, bindingOptional: true}).models[0];
    const firstError = (spec: ProfileSpec, file: string) => {
      let inMemory = '';
      try {
        applyProfile(base, spec);
      } catch (err: any) {
        inMemory = err.message;
      }
      const fromFile = applyProfileFile(base, file, 'prod');
      expect('error' in fromFile).toBe(true);
      expect(inMemory).toBe((fromFile as {error: string}).error);
    };
    firstError({
      name: 'prod',
      entities: [{
        name: 'account',
        fields: [{
          name: 'note',
          expression: 'a',
          dialects: [{dialect: 'BIGQUERY', expression: 'a'},
                     {dialect: 'BIGQUERY', expression: 'b'}],
        }],
        fieldsExclude: ['note'],
      }],
      relationships: [],
    }, `name: prod
entities:
  - name: account
    fields:
      - name: note
        expression:
          dialects:
            - {dialect: BIGQUERY, expression: a}
            - {dialect: BIGQUERY, expression: b}
    fields_exclude: [note]
`);
    firstError({
      name: 'prod',
      entities: [{
        name: 'account',
        fields: [{name: 'note', expression: 'a'}],
        fieldsExclude: ['note'],
      }],
      relationships: [
        {name: 'holds', fromColumns: ['a'], toColumns: ['b']},
        {name: 'holds', fromColumns: ['a'], toColumns: ['b']},
      ],
    }, `name: prod
entities:
  - name: account
    fields:
      - {name: note, expression: a}
    fields_exclude: [note]
relationships:
  - {name: holds, from_columns: [a], to_columns: [b]}
  - {name: holds, from_columns: [a], to_columns: [b]}
`);
  });

  test('join columns and executors are checked as a load checks them', () => {
    const lengths = viaApply(SHOP, `name: prod
relationships:
  - {name: holds, from_columns: [a, b], to_columns: [c_id]}
`);
    // The load's message, naming the profile, which the merged load does not.
    const merged = viaMerge(SHOP, `name: prod
relationships:
  - {name: holds, from_columns: [a, b], to_columns: [c_id]}
`) as {error: string};
    expect(lengths).toEqual({error: `profile 'prod': ${merged.error}`});
    expect(lengths).toEqual({
      error: "profile 'prod': relationship 'holds': from_columns (2) and " +
          'to_columns (1) have different lengths; the join keys are mismatched',
    });
    expect(viaApply(SHOP, `name: prod
relationships:
  - {name: holds, from_columns: [], to_columns: []}
`)).toEqual({
      error: "profile 'prod': relationship 'holds' 'from_columns' lists no " +
          'column',
    });
    const twoKinds = viaApply(SHOP, `name: prod
actions:
  - name: Notify
    executor:
      mcp: {server: s, tool: t}
      rest: {endpoint: e, method: POST}
`);
    expect(twoKinds).toEqual({
      error: "profile 'prod': action 'Notify' 'executor': executor requires " +
          'exactly one kind, but 2 given (mcp, rest)',
    });
    const noTool = viaApply(SHOP, `name: prod
actions:
  - {name: Notify, executor: {mcp: {server: s}}}
`);
    if (!('error' in noTool)) throw new Error('expected an error');
    expect(noTool.error)
        .toStartWith("profile 'prod': action 'Notify' 'executor': mcp.tool: ");
    expect('error' in viaMerge(SHOP, `name: prod
actions:
  - {name: Notify, executor: {mcp: {server: s}}}
`)).toBe(true);
  });

  // A named profile states both join column lists itself, so one side alone
  // gets the completeness check's error, whatever join columns the model file
  // has. The merge, which the commands use only for a legacy wrapper, takes
  // the other list from the model file, and the load then checks the join.
  test('one side of a join gets the completeness error', () => {
    const cases: Array<[string, string, string|undefined]> = [
      // refers has no join columns in the model file.
      ['refers', 'from_columns: [p_cust]', 'must be given together'],
      // holds joins [p_cust] to [c_id] in the model file.
      ['holds', 'from_columns: [a, b]',
       'from_columns (2) and to_columns (1) have different lengths'],
      ['holds', 'to_columns: [c_email]', undefined],
    ];
    for (const [name, columns, mergeError] of cases) {
      const profile = `name: prod\nrelationships:\n  - {name: ${name}, ${
          columns}}\n`;
      expect({columns, ...viaApply(SHOP, profile)}).toEqual({
        columns,
        error: `profile 'prod': relationship '${name}' has no join columns ` +
            "in this profile; a named profile states both 'from_columns' " +
            "and 'to_columns' itself",
      });
      const merged = viaMerge(SHOP, profile);
      expect({columns, merged: 'error' in merged ? merged.error : 'loads'})
          .toEqual({columns, merged: mergeError ?
                        expect.stringContaining(mergeError) : 'loads'});
    }
  });

  test('the warnings match the ones a load of the merged document gives', () => {
    const model = `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    entities:
      - name: orders
        source: "bigquery.googleapis.com/projects/acme/datasets/raw/tables/orders"
        fields:
          - name: o_id
            expression:
              dialects:
                - {dialect: SPANNER, expression: o_id}
          - name: total
            expression:
              dialects:
                - {dialect: ANSI_SQL, expression: o_total}
          - name: tax
            expression:
              dialects:
                - {dialect: ANSI_SQL, expression: o_tax}
`;
    const fromMerge = (profile: string) => {
      const merged = mergeProfileOntoDocImpl(model, profile, 'prod');
      if ('error' in merged) throw new Error(merged.error);
      return loadSemanticModels([{name: 'sales', text: merged.text}],
                                {...LOAD, bindingOptional: true})
          .warnings;
    };
    const fromApply = (profile: string) => {
      const loaded = loadSemanticModels(
          [{name: 'sales', text: model}], {...LOAD, bindingOptional: true});
      const applied = applyProfileFile(
          loaded.models[0].model, profile, 'prod',
          {from: {document: 'sales', warnings: loaded.warnings}});
      if ('error' in applied) throw new Error(applied.error);
      return applied.warnings;
    };
    // Keys in the profile, and every field the model file warns about
    // rebound: the merged document gives no warning at all.
    const replacesAll = `name: prod
entities:
  - name: orders
    primary_key: [o_id]
    fields:
      - {name: o_id, expression: id}
      - {name: total, expression: t}
      - {name: tax, expression: x}
`;
    expect(fromApply(replacesAll)).toEqual(fromMerge(replacesAll));
    expect(fromApply(replacesAll)).toEqual([]);
    // One ANSI_SQL field left as the model file binds it keeps the note, and
    // a profile text with no BIGQUERY or ANSI_SQL entry warns, prefixed.
    const keepsOne = `name: prod
entities:
  - name: orders
    primary_key: [o_id]
    fields:
      - {name: o_id, expression: id}
      - name: total
        expression:
          dialects:
            - {dialect: SPANNER, expression: t}
`;
    expect(new Set(fromApply(keepsOne))).toEqual(new Set(fromMerge(keepsOne)));
    expect(fromApply(keepsOne).length).toBe(2);
    // A field the profile excludes takes its warning with it.
    const excludes = `name: prod
entities:
  - name: orders
    primary_key: [o_id]
    fields:
      - {name: total, expression: t}
      - {name: tax, expression: x}
    fields_exclude: [o_id]
`;
    expect(fromApply(excludes)).toEqual(fromMerge(excludes));
    expect(fromApply(excludes).join('\n')).not.toContain("field 'orders.o_id'");
    // The warnings come in the order a load gives them: the entities', then
    // each metric's, here one naming no entity, then the actions'.
    const unanchored = model + `    metrics:
      - name: n
        expression: COUNT(*)
    actions:
      - name: Close
        parameters:
          - {name: reason}
`;
    const loadedUnanchored = loadSemanticModels(
        [{name: 'sales', text: unanchored}], {...LOAD, bindingOptional: true});
    const keyless = 'name: prod\nentities:\n  - name: orders\n    fields:\n      - {name: o_id, expression: id}\n';
    const ordered = applyProfileFile(
        loadedUnanchored.models[0].model, keyless, 'prod',
        {from: {document: 'sales', warnings: loadedUnanchored.warnings}});
    if ('error' in ordered) throw new Error(ordered.error);
    const mergedOrder = loadSemanticModels(
        [{name: 'sales',
          text: (mergeProfileOntoDocImpl(unanchored, keyless, 'prod') as {text: string}).text}],
        {...LOAD, bindingOptional: true}).warnings;
    expect(ordered.warnings).toEqual(mergedOrder);
    expect(ordered.warnings.at(-1)).toContain("parameter 'reason' states no 'type'");
    // A metric that takes its ANSI_SQL text keeps the note, though the
    // profile rebinds every field that did.
    const withMetric = model + `    metrics:
      - name: total_tax
        entity: orders
        expression:
          dialects:
            - {dialect: ANSI_SQL, expression: SUM(orders.tax)}
`;
    const loaded = loadSemanticModels(
        [{name: 'sales', text: withMetric}], {...LOAD, bindingOptional: true});
    const metricNote = applyProfileFile(
        loaded.models[0].model, replacesAll, 'prod',
        {from: {document: 'sales', warnings: loaded.warnings}});
    if ('error' in metricNote) throw new Error(metricNote.error);
    expect(metricNote.warnings.some(w => w.includes('note:'))).toBe(true);
  });
});


describe('profile application: errors, warnings and order', () => {
  const BQ = (t: string) => `bigquery.googleapis.com/projects/acme/datasets/raw/tables/${t}`;
  const HIERARCHY = `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    entities:
      - name: party
        abstract: true
        fields:
          - {name: id, expression: id}
      - name: customer
        extends: [party]
        source: "${BQ('customer')}"
        fields:
          - {name: email, expression: email}
      - name: orders
        source: "${BQ('orders')}"
        fields:
          - {name: amount, expression: amount}
    metrics:
      - name: count_all
        expression: COUNT(*)
      - name: spanner_total
        entity: orders
        expression:
          dialects:
            - {dialect: SPANNER, expression: SUM(orders.amount)}
`;
  const DOC = {name: 'sales', text: HIERARCHY};
  const loadDoc = () => loadSemanticModels(
      [DOC], {defaultProject: 'acme', bindingOptional: true}).models[0].model;

  // Only a broken hierarchy falls back to the declared fields; any other
  // error is a bug and surfaces.
  test('an error inside inheritance resolution that is not a hierarchy error is rethrown', () => {
    const m = loadDoc();
    const prod = loadProfileFile(
        `name: prod\nentities:\n  - name: customer\n    source: "${BQ('c2')}"\n`, 'prod');
    const spy = spyOn(inheritance, 'resolveInheritance').mockImplementation(() => {
      throw new TypeError('boom');
    });
    try {
      expect(() => pruneUnavailable(m, 'default')).toThrow('boom');
      expect(() => validateProfileCompleteness(m, prod)).toThrow('boom');
      expect(() => validateProfileConsistency(m, [prod, {...prod, name: 'p2'}]))
          .toThrow('boom');
    } finally {
      spy.mockRestore();
    }
    // The completeness check resolves the model file first, then the profiled
    // model; a bug in the second resolution surfaces too.
    const real = inheritance.resolveInheritance;
    let calls = 0;
    const second = spyOn(inheritance, 'resolveInheritance').mockImplementation(model => {
      if (++calls === 2) throw new TypeError('boom');
      return real(model);
    });
    try {
      expect(() => validateProfileCompleteness(m, prod)).toThrow('boom');
    } finally {
      second.mockRestore();
    }
  });

  // A concrete entity with no key warns; an abstract one, which is never a
  // node, does not.
  test('only a concrete entity with no key gives the missing-key warning', () => {
    const res = profileForDocument(
        DOC, [{name: 'prod', text: `name: prod\nentities:\n  - name: orders\n    source: "${BQ('o2')}"\n`}],
        'prod');
    if (res.kind !== 'file') throw new Error(JSON.stringify(res));
    const keyWarnings = res.warnings.filter(w => w.includes('no primary_key'));
    expect(keyWarnings.some(w => w.includes("'orders'"))).toBe(true);
    expect(keyWarnings.some(w => w.includes("'party'"))).toBe(false);
  });

  // The warnings after a profile come in the order a load gives them: a
  // metric that names no entity before a later metric's dialect warning.
  test('warnings after a profile keep the load order across metrics', () => {
    const res = profileForDocument(
        DOC, [{name: 'prod', text: `name: prod\nentities:\n  - name: orders\n    source: "${BQ('o2')}"\n`}],
        'prod');
    if (res.kind !== 'file') throw new Error(JSON.stringify(res));
    const noEntity = res.warnings.findIndex(w => w.includes("metric 'count_all'"));
    const dialect = res.warnings.findIndex(w => w.includes("metric 'spanner_total'"));
    expect(noEntity).toBeGreaterThanOrEqual(0);
    expect(dialect).toBeGreaterThan(noEntity);
  });

  // Push, `kcmd profiles` and the runtime judge the applied model in the
  // load's dialect, which picked the text the model holds: under a Spanner
  // profile, a SPANNER-only metric warns as the model file's load does.
  test('the callers judge warnings in the load dialect', () => {
    const SP = (t: string) => `spanner.googleapis.com/projects/p/instances/i/databases/db/tables/${t}`;
    const res = profileForDocument(DOC, [{name: 'sp', text: `name: sp
entities:
  - name: customer
    source: "${SP('customer')}"
  - name: orders
    source: "${SP('orders')}"
`}], 'sp');
    if (res.kind !== 'file') throw new Error(JSON.stringify(res));
    const loaded = loadSemanticModels([DOC], {defaultProject: 'acme', bindingOptional: true});
    const own = loaded.warnings.filter(w => w.includes("metric 'spanner_total'"));
    expect(own.length).toBe(1);
    expect(res.warnings.filter(w => w.includes("metric 'spanner_total'"))).toEqual(own);
  });

  // With two sources the readers reject, the error names the first.
  test('the first rejected source is the one reported', () => {
    const res = profileForDocument(DOC, [{name: 'prod', text: `name: prod
entities:
  - name: customer
    source: "SELECT 1 FROM t"
  - name: orders
    source: "nosuch:a.b.c"
`}], 'prod');
    expect(res.kind).toBe('error');
    if (res.kind !== 'error') return;
    expect(res.error).toContain("'customer'");
    expect(res.error).not.toContain("'orders'");
  });

  // A logical model file implies no dialect, so an ANSI_SQL metric using
  // BigQuery syntax (double-quoted DATE literal, hex literal, WITH OFFSET)
  // cannot be parsed until the profile file binds its entity to BigQuery.
  test('infers a metric entity again once the profile binds the entity source', () => {
    const logicalDoc = {
      name: 'sales.yaml',
      text: `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    entities:
      - name: orders
        primary_key: [id]
        fields:
          - {name: id, expression: id}
          - {name: order_date, expression: order_date}
          - {name: flags, expression: flags}
          - {name: items, expression: items}
    metrics:
      - name: recent_orders
        expression: 'COUNTIF(orders.order_date >= DATE "2024-01-01")'
      - name: flagged_orders
        expression: 'SUM(orders.flags & 0x1)'
      - name: item_positions
        expression: '(SELECT SUM(off) FROM UNNEST(orders.items) AS i WITH OFFSET AS off)'
`,
    };
    const res = profileForDocument(
        logicalDoc,
        [{name: 'prod', text: `name: prod\nentities:\n  - name: orders\n    source: "${BQ('orders')}"\n`}],
        'prod');
    if (res.kind !== 'file') throw new Error(JSON.stringify(res));
    expect(res.model.metrics?.map(m => [m.name, m.entity])).toEqual([
      ['recent_orders', 'orders'],
      ['flagged_orders', 'orders'],
      ['item_positions', 'orders'],
    ]);
    expect(res.warnings).toEqual([]);
  });

  // The generic parser reads `"orders"."amount"` as a column, and BigQuery
  // cannot parse it. Once the profile binds a BigQuery source, the metric has
  // no entity, as when the model file names that source itself.
  test('drops an inferred metric entity the profile dialect does not pin', () => {
    const doc = {
      name: 'sales.yaml',
      text: `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    entities:
      - name: orders
        primary_key: [id]
        fields:
          - {name: id, expression: id}
          - {name: amount, expression: amount}
    metrics:
      - name: total
        expression: 'SUM("orders"."amount")'
`,
    };
    const prod = `name: prod\nentities:\n  - name: orders\n    source: "${BQ('orders')}"\n`;
    const loaded = loadSemanticModels([doc], {bindingOptional: true});
    expect(loaded.models[0].model.metrics?.[0].entity).toBe('orders');
    const res = profileForDocument(doc, [{name: 'prod', text: prod}], 'prod');
    if (res.kind !== 'file') throw new Error(JSON.stringify(res));
    expect(res.model.metrics?.[0].entity).toBeUndefined();
    expect(res.warnings).toContain(
        "[sales.yaml] metric 'total': expression could not be parsed; entity " +
        "inference was skipped (set 'entity' on the metric, or " +
        "backtick-quote a reserved qualifier, such as `Date`.amount)");
    // The YAML merge of the same profile builds the same model.
    mergeProfileOntoDoc(doc.text, prod, 'prod');
  });
});
