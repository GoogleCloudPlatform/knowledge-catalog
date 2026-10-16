// Behavior specification for the binding-profile passes
// (src/libts/semantic/resolve_profiles.ts): mergeProfile overlays a profile's
// physical bindings onto a logical model by name and enforces the binding-only
// contract; pruneUnavailable drops what a binding cannot answer and reports it.
// Builders are minimal literals in the readable authoring form (mergeProfile) or
// the IR (pruneUnavailable), mirroring resolve_inheritance.test.ts.

import {beforeAll, describe, expect, spyOn, test} from 'bun:test';
import * as yaml from 'yaml';

import {Field, isFieldBound, ProfileSpec, SemanticModel} from '../../../src/libts/semantic/ir';
import * as loader from '../../../src/libts/semantic/loader';
import {fromDocument, loadModels, loadSemanticModels, SemanticModelError} from '../../../src/libts/semantic/loader';
import * as inheritance from '../../../src/libts/semantic/resolve_inheritance';
import {resolveInheritance} from '../../../src/libts/semantic/resolve_inheritance';
import * as sqlUtils from '../../../src/libts/semantic/sql_expr_utils';
import {applyProfile, applyProfileExclusions, applyProfileFile, loadProfileFile, mergeProfile as mergeProfileImpl, mergeProfileOntoDoc as mergeProfileOntoDocImpl, ProfileExclusion, profileForDocument, pruneUnavailable, sourcesDialect, validateProfileCompleteness, validateProfileConsistency} from '../../../src/libts/semantic/resolve_profiles';
import {loadSqlEngine} from '../../../src/libts/semantic/sql_parser';
import {YAML_OPTIONS} from '../../../src/libts/semantic/yaml_options';

beforeAll(async () => {
  await loadSqlEngine();
});


// Every profile file a test here merges is also applied with applyProfile,
// which must build the same model or fail with the same error, wherever the
// model file loads on its own.
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
    '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/commerce';
const TBL = (t: string) =>
    `//bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;

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
      target: '//spanner.googleapis.com/projects/p/instances/i/databases/d/propertyGraphs/commerce',
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
        {name: 'total_tax', reason: 'field Order.tax is unavailable'},
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
        [{name: 'holidays', reason: 'field Date.is_holiday is unbound'}]);
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
          {name: 'avg_lifetime_value', reason: 'field Customer.lifetimeValue is unbound'});
    }
  });

  test('a metric is pruned on the text the generators emit', () => {
    const m = irModel();
    const metric = m.metrics!.find(x => x.name === 'avg_lifetime_value')!;
    metric.expression = undefined;
    metric.importedExpression = 'AVG("Customer"."lifetimeValue")';
    metric.importedDialect = 'SNOWFLAKE';
    const {model, report} = pruneUnavailable(m, 'operational');
    expect(metricNames(model)).toEqual(['order_count']);
    expect(report.droppedMetrics).toContainEqual(
        {name: 'avg_lifetime_value', reason: 'field Customer.lifetimeValue is unbound'});
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
    source: //bigquery.googleapis.com/projects/acme/datasets/prod/tables/orders
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
        '//bigquery.googleapis.com/projects/acme/datasets/prod/tables/orders');
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
  // A logical model whose Customer.lifetimeValue is unbound in the model file.
  const BQ = (t: string) => `//bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
  function profile(over: Partial<ProfileSpec> = {}): ProfileSpec {
    return {
      name: 'prod',
      entities: [
        {name: 'Customer', source: BQ('customer'), fields: [{name: 'lifetimeValue', expression: 'ltv'}]},
        {name: 'Order', source: BQ('orders')},
      ],
      relationships: [{name: 'PlacedBy', fromColumns: ['o_custkey'], toColumns: ['c_custkey']}],
      ...over,
    };
  }

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

  test('BigQuery datasets are one database; two Spanner databases are not', () => {
    const twoDatasets = profile({
      entities: [
        {...profile().entities[0], source: '//bigquery.googleapis.com/projects/p/datasets/raw/tables/customer'},
        {name: 'Order', source: 'bigquery:p.curated.orders'},
      ],
    });
    expect(validateProfileCompleteness(irModel(), twoDatasets)).toEqual([]);
    const SP = (db: string, t: string) =>
        `//spanner.googleapis.com/projects/p/instances/i/databases/${db}/tables/${t}`;
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

  test('a restated key of another width is rejected; leaving it out inherits', () => {
    const wide = profile({
      entities: [{...profile().entities[0], primaryKey: ['a', 'b']}, profile().entities[1]],
    });
    expect(validateProfileCompleteness(irModel(), wide).join('\n'))
        .toContain("restates its primary key with 2 column(s)");
    const same = profile({
      entities: [{...profile().entities[0], primaryKey: ['c_id']}, profile().entities[1]],
    });
    expect(validateProfileCompleteness(irModel(), same)).toEqual([]);
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

  test('a field the model file leaves unbound must be bound or excluded', () => {
    const errors = validateProfileCompleteness(irModel(), profile({
      entities: [{name: 'Customer', source: BQ('customer')}, profile().entities[1]],
    }));
    expect(errors.join('\n')).toContain(
        "field 'Customer.lifetimeValue' has no binding in the model file");
  });

  test('a field depending on an excluded one must be excluded or rebound, transitively', () => {
    const m = irModel();
    const customer = m.entities[0];
    customer.fields.push({name: 'doubled', expression: 'Customer.name * 2'});
    customer.fields.push({name: 'quadrupled', expression: 'Customer.doubled * 2'});
    const errors = validateProfileCompleteness(m, profile({
      entities: [{...profile().entities[0], fieldsExclude: ['name']}, profile().entities[1]],
      metricsExclude: '*',
    }));
    expect(errors.join('\n')).toContain(
        "field 'Customer.doubled' depends on 'Customer.name'");
    expect(errors.join('\n')).toContain(
        "field 'Customer.quadrupled' depends on 'Customer.name'");
    const rebound = validateProfileCompleteness(m, profile({
      entities: [{
        ...profile().entities[0], fieldsExclude: ['name'],
        fields: [
          {name: 'lifetimeValue', expression: 'ltv'},
          {name: 'doubled', expression: 'raw_doubled'},
        ],
      }, profile().entities[1]],
      metricsExclude: '*',
    }));
    expect(rebound).toEqual([]);
  });

  test('a metric reaching an excluded field is named with the field', () => {
    const errors = validateProfileCompleteness(irModel(), profile({
      entities: [{name: 'Customer', source: BQ('customer'), fieldsExclude: ['lifetimeValue']},
                 profile().entities[1]],
    }));
    expect(errors).toEqual([
      "profile 'prod': metric 'avg_lifetime_value' reaches " +
      "'Customer.lifetimeValue', which this profile excludes; add " +
      "'avg_lifetime_value' to 'metrics_exclude'",
    ]);
    expect(validateProfileCompleteness(irModel(), profile({
      entities: [{name: 'Customer', source: BQ('customer'), fieldsExclude: ['lifetimeValue']},
                 profile().entities[1]],
      metricsExclude: ['avg_lifetime_value'],
    }))).toEqual([]);
  });

  test('a metric is read in its own dialect', () => {
    // The profile's sources are PostgreSQL tables. In PostgreSQL, double quotes
    // name a column, so this text reads the excluded field.
    const PG = (t: string) => `postgresql:host.db.public.${t}`;
    const m = irModel();
    const metric = m.metrics!.find(x => x.name === 'avg_lifetime_value')!;
    metric.expression = undefined;
    metric.dialects =
        [{dialect: 'POSTGRES', expression: 'AVG("Customer"."lifetimeValue")'}];
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
        `//spanner.googleapis.com/projects/p/instances/i/databases/db/tables/${t}`;
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
    // The profile's sources are Snowflake tables, so it evaluates the
    // Snowflake text.
    const SF = (t: string) => `snowflake:acct.db.public.${t}`;
    const m = irModel();
    const metric = m.metrics!.find(x => x.name === 'avg_lifetime_value')!;
    // The metric as a load gives it: a Snowflake text, kept in its list too.
    metric.expression = undefined;
    metric.importedExpression = 'AVG("Customer"."lifetimeValue")';
    metric.importedDialect = 'SNOWFLAKE';
    metric.dialects =
        [{dialect: 'SNOWFLAKE', expression: 'AVG("Customer"."lifetimeValue")'}];
    const errors = validateProfileCompleteness(m, profile({
      entities: [{name: 'Customer', source: SF('customer'), fieldsExclude: ['lifetimeValue']},
                 {name: 'Order', source: SF('orders')}],
    }));
    expect(errors.join('\n'))
        .toContain("metric 'avg_lifetime_value' reaches 'Customer.lifetimeValue'");
  });

  test('a profile field whose SQL cannot be read is skipped, with a warning', () => {
    const warnings: string[] = [];
    const errors = validateProfileCompleteness(irModel(), profile({
      entities: [
        {name: 'Customer', source: BQ('customer'),
         fields: [{name: 'lifetimeValue', expression: 'SUM(ltv'}]},
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
      entities: [{name: 'Customer', source: BQ('customer'), fieldsExclude: ['lifetimeValue']},
                 profile().entities[1]],
    }), warnings);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([
      "profile 'prod': kcmd could not read the SQL of metric " +
      "'avg_lifetime_value', so the fields it reads were not checked",
    ]);
  });
});


describe('validateProfileConsistency', () => {
  const p = (name: string, extra: Partial<ProfileSpec> = {}): ProfileSpec =>
      ({name, entities: [], relationships: [], ...extra});

  test('with no key in the model file, profiles must agree on one shape or none', () => {
    const m = irModel();
    m.entities[1].keys = [];
    const disagree = validateProfileConsistency(m, [
      p('a', {entities: [{name: 'Order', primaryKey: ['id']}]}),
      p('b'),
    ]);
    expect(disagree.join('\n')).toContain("entity 'Order' has no key in the model file");
    expect(validateProfileConsistency(m, [
      p('a', {entities: [{name: 'Order', primaryKey: ['id']}]}),
      p('b', {entities: [{name: 'Order', primaryKey: ['oid']}]}),
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
  const BQ = (t: string) => `//bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
  const base = (over: Partial<ProfileSpec> = {}): ProfileSpec => ({
    name: 'prod',
    entities: [
      {name: 'Customer', source: BQ('customer'), fields: [{name: 'lifetimeValue', expression: 'ltv'}]},
      {name: 'Order', source: BQ('orders')},
    ],
    relationships: [{name: 'PlacedBy', fromColumns: ['o_custkey'], toColumns: ['c_custkey']}],
    ...over,
  });

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

  test('Spanner catalog names and AlloyDB sources classify by database', () => {
    const one = base({entities: [
      {...base().entities[0], source: 'spanner:p.regional-us.i.db.Customer'},
      {name: 'Order', source: '//spanner.googleapis.com/projects/p/instances/i/databases/db/tables/Orders'},
    ]});
    expect(validateProfileCompleteness(irModel(), one)).toEqual([]);
    const two = base({entities: [
      {...base().entities[0], source: 'spanner:`google.com:p`.regional-us.i.db.Customer'},
      {name: 'Order', source: 'spanner:`google.com:p`.regional-us.i.db2.Orders'},
    ]});
    expect(validateProfileCompleteness(irModel(), two).join('\n'))
        .toContain('more than one database');
    const alloy = base({entities: [
      {...base().entities[0], source: 'alloydb:p.us.c.db.public.customer'},
      {name: 'Order', source: '//alloydb.googleapis.com/projects/p/locations/us/clusters/c/databases/db/schemas/public/tables/orders'},
    ]});
    expect(validateProfileCompleteness(irModel(), alloy)).toEqual([]);
    // A database belongs to its cluster, so the instance-based URI names no
    // real table.
    const instanceUri = base({entities: [
      {...base().entities[0], source: 'alloydb:p.us.c.db.public.customer'},
      {name: 'Order', source: '//alloydb.googleapis.com/projects/p/locations/us/clusters/c/instances/i/databases/db/tables/orders'},
    ]});
    expect(validateProfileCompleteness(irModel(), instanceUri).join('\n'))
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

  test('a unique-key shape mismatch is rejected', () => {
    const m = irModel();
    m.entities[0].uniqueKeys = [['email']];
    const errors = validateProfileCompleteness(m, base({
      entities: [{...base().entities[0], uniqueKeys: [['a', 'b']]}, base().entities[1]],
    }));
    expect(errors.join('\n')).toContain('restates its unique keys as [2]');
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
      entities: [{name: 'Customer', source: BQ('customer'), fieldsExclude: ['lifetimeValue']},
                 base().entities[1]],
      metricsExclude: '*',
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

  test('cardinality: a model file with no join columns is left out; the k-th unique key counts', () => {
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
    expect(errors.join('\n')).toContain("profile 'a': unique key 1");
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
  const BQ = (t: string) => `//bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
  const logical = () => ({
    semantic_model: [{
      name: 'm',
      entities: [
        {name: 'customer', source: 'p.d.customer', primary_key: ['id'],
         fields: [{name: 'id', expression: 'id'}, {name: 'email', expression: 'email'}]},
        {name: 'vip', extends: ['customer'], source: 'p.d.vip', primary_key: ['id'],
         fields: [{name: 'perk', expression: 'perk'}]},
        {name: 'orders', source: 'p.d.orders', primary_key: ['o_id'],
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
        entities: [{name: 'orders', source: 'p.d.orders2', primary_key: ['oid'],
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
      entities: [{name: 'customer', source: BQ('customer')},
                 {name: 'vip', source: BQ('vip'), fieldsExclude: ['email']}],
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
        {name: 'customer', source: 'p.d.customer', primary_key: ['id'],
         fields: [{name: 'id', expression: 'id'},
                  emailInline ? {name: 'email', expression: 'email'} : {name: 'email'}]},
        {name: 'vip', extends: ['customer'], source: 'p.d.vip', primary_key: ['id'], fields: []},
      ],
    }],
  });
  const ir = (emailInline: boolean): SemanticModel => ({
    name: 'm',
    entities: [
      {name: 'customer', dataSource: 'p.d.customer', keys: ['id'],
       fields: [{name: 'id', expression: 'id'},
                emailInline ? {name: 'email', expression: 'email'} : {name: 'email'}]},
      {name: 'vip', extends: ['customer'], dataSource: 'p.d.vip', keys: ['id'], fields: []},
    ],
    relationships: [],
  } as any);

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

  test('a backtick-quoted catalog name is the same database as its URI', () => {
    const model = ir(true);
    model.entities[1].extends = undefined;
    const SP = '//spanner.googleapis.com/projects/google.com:p/instances/i/databases/db/tables/';
    const errors = validateProfileCompleteness(model, {
      name: 'prod',
      entities: [{name: 'customer', source: 'spanner:`google.com:p`.regional-us.i.db.Customer'},
                 {name: 'vip', source: `${SP}Vip`}],
      relationships: [],
    });
    expect(errors.join('\n')).not.toContain('more than one database');
  });
});


describe('completeness sees the model as the profile does', () => {
  const BQ = (t: string) => `//bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
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
  const spec = (entities: any[]): ProfileSpec => ({name: 'prod', entities, relationships: []});

  test('an exclusion on an ancestor leaves its descendants\' field in place', () => {
    // customer excludes email; vip still reads email from its own table.
    expect(validateProfileCompleteness(model(true), spec([
      {name: 'customer', source: BQ('c'), fieldsExclude: ['email']},
      {name: 'vip', source: BQ('v')},
    ]))).toEqual([]);
    // Excluding it on vip itself does reach vip's metric.
    expect(validateProfileCompleteness(model(true), spec([
      {name: 'customer', source: BQ('c')},
      {name: 'vip', source: BQ('v'), fieldsExclude: ['email']},
    ]))).toEqual([
      "profile 'prod': metric 'vip_emails' reaches 'vip.email', which this profile " +
          "excludes; add 'vip_emails' to 'metrics_exclude'",
    ]);
  });

  test('a field an ancestor binds only in the profile is bound on its descendants', () => {
    expect(validateProfileCompleteness(model(false), spec([
      {name: 'customer', source: BQ('c'), fields: [{name: 'email', expression: 'mail'}]},
      {name: 'vip', source: BQ('v')},
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
           'bigtable:p.i.t', 'spanner:p.c.i.db', 'bigquery:p.d',
           '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g',
           'bigquery:graph:p.d.g', 'bigquery:propertygraph:p.d.g',
           'spanner:graph:p.c.i.db.g',
         ]) {
      // The loader's source reader judges a profile's sources too.
      expect(errorsFor(bad)).toMatch(/is not a valid (source|table reference)/);
    }
    expect(errorsFor('bigquery:p.raw.customer')).toEqual('');
  });

  // The Knowledge Catalog FQN reference: a self-managed server is named by its
  // DNS name, a Cloud SQL instance by project, location and instance.
  test('MySQL and PostgreSQL sources classify by server, instance and database', () => {
    const errorsFor = (a: string, b: string) => validateProfileCompleteness(model(true), spec([
      {name: 'customer', source: a}, {name: 'vip', source: b},
    ])).join('\n');
    // One MySQL server or instance is one database, whatever its schemas.
    expect(errorsFor('mysql:`db.example.com`.sales.c', 'mysql:`db.example.com`.crm.v'))
        .toEqual('');
    expect(errorsFor('cloudsql_mysql:acme.us.inst.sales.c', 'cloudsql_mysql:acme.us.inst.crm.v'))
        .toEqual('');
    // One PostgreSQL database is one; two on one server are two.
    expect(errorsFor('postgresql:`pg.example.com`.db1.public.c',
                     'postgresql:`pg.example.com`.db1.sales.v'))
        .toEqual('');
    expect(errorsFor('cloudsql_postgresql:acme.us.inst.db1.public.c',
                     'cloudsql_postgresql:acme.us.inst.db2.public.v'))
        .toContain('more than one database');
    // A self-managed server and a Cloud SQL instance are different systems.
    expect(errorsFor('mysql:acme.sales.c', 'cloudsql_mysql:acme.us.inst.sales.v'))
        .toContain('more than one database');
    // Each prefix has its own number of segments.
    expect(errorsFor('mysql:acme.us.inst.sales.c', 'mysql:acme.us.inst.sales.v'))
        .toContain("source 'mysql:acme.us.inst.sales.c' is not a valid table reference");
    expect(errorsFor('postgresql:acme.us.inst.db1.public.c', 'postgresql:acme.us.inst.db1.public.v'))
        .toContain("source 'postgresql:acme.us.inst.db1.public.c' is not a valid table reference");
  });

  test('a BigLake table shares BigQuery\'s database', () => {
    expect(validateProfileCompleteness(model(true), spec([
      {name: 'customer',
       source: '//biglake.googleapis.com/projects/p/catalogs/c/namespaces/n/tables/t'},
      {name: 'vip', source: BQ('v')},
    ]))).toEqual([]);
  });
});


describe('profile rules', () => {
  const BQ = (t: string) => `//bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;

  // Every binding that states the join columns gives the same cardinality
  // answer, the model file's included.
  test('cardinality compares the model file\'s binding when it states join columns', () => {
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
    expect(validateProfileConsistency(model(true), [prod]).join('\n'))
        .toContain("relationship 'placed_by' covers different keys under different bindings");
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
    const errors = validateProfileCompleteness(model, {
      name: 'prod',
      entities: [{name: 'customer', source: BQ('c')},
                 {name: 'vip', source: BQ('v'), fieldsExclude: ['discount']}],
      relationships: [],
    });
    expect(errors).toEqual([
      "profile 'prod': field 'vip.net' depends on 'vip.discount', which this profile " +
          "excludes; exclude 'vip.net' too, or rebind it",
    ]);
  });
});


describe('profile completeness: dialects and struct paths', () => {
  const BQ = (t: string) => `//bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
  const SP = (t: string) =>
      `//spanner.googleapis.com/projects/p/instances/i/databases/db/tables/${t}`;
  const shop = (amount: object): SemanticModel => ({
    name: 'shop',
    entities: [{
      name: 'orders', dataSource: BQ('orders'), keys: ['id'],
      fields: [{name: 'id', expression: 'id'}, {name: 'amount', ...amount}],
    }],
    relationships: [], metrics: [],
  } as any);
  const bqOnly = () => shop({
    expression: 'SAFE_CAST(amt AS NUMERIC)',
    dialects: [{dialect: 'BIGQUERY', expression: 'SAFE_CAST(amt AS NUMERIC)'}],
  });
  const atSource = (source: string): ProfileSpec =>
      ({name: 'p', entities: [{name: 'orders', source}], relationships: []});

  // Every bound field has a text its profile's database can run.
  test('a bound field needs an expression for the profile\'s dialect or ANSI_SQL', () => {
    expect(validateProfileCompleteness(bqOnly(), atSource(SP('Orders'))).join('\n'))
        .toContain("field 'orders.amount' has no expression for SPANNER or ANSI_SQL");
    expect(validateProfileCompleteness(bqOnly(), atSource(BQ('orders_prod')))).toEqual([]);
    const ansi = shop({expression: 'amt', dialects: [{dialect: 'ANSI_SQL', expression: 'amt'}]});
    expect(validateProfileCompleteness(ansi, atSource(SP('Orders')))).toEqual([]);
  });

  test('a field the profile rebinds needs a text for the profile\'s dialect too', () => {
    const rebound = (source: string, expression: string) => loadProfileFile(
        `name: p\nentities:\n  - name: orders\n    source: ${source}\n    fields:\n` +
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
      entities: [{name: 'orders', source}, {name: 'items', source: BQ('items')}],
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
      entities: [{name: 'orders', dataSource: SP('Orders'), keys: ['id'],
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

  // A source written as a GCP resource name, the URI without the leading
  // `//`, names the same database, so it implies the same dialect and counts
  // as the same database for the one-database rule.
  test('a source written as a resource name implies the same dialect and database', () => {
    const name = (uri: string) => uri.slice(2);
    expect(sourcesDialect({entities: [
      {name: 'orders', dataSource: SP('Orders'), authoredSource: name(SP('Orders')),
       keys: [], fields: []},
    ]} as any)).toBe('SPANNER');
    expect(validateProfileCompleteness(bqOnly(), atSource(name(SP('Orders')))).join('\n'))
        .toContain("field 'orders.amount' has no expression for SPANNER or ANSI_SQL");
    expect(validateProfileCompleteness(bqOnly(), atSource(name(BQ('orders_prod')))))
        .toEqual([]);

    const model: SemanticModel = {
      name: 'shop',
      entities: [
        {name: 'orders', dataSource: SP('Orders'), keys: ['id'],
         fields: [{name: 'id', expression: 'id'}]},
        {name: 'items', dataSource: SP('Items'), keys: ['id'],
         fields: [{name: 'id', expression: 'id'}]},
      ],
      relationships: [], metrics: [],
    } as any;
    const spec = (orders: string, items: string): ProfileSpec => ({
      name: 'p',
      entities: [{name: 'orders', source: orders}, {name: 'items', source: items}],
      relationships: [],
    });
    expect(validateProfileCompleteness(model, spec(name(SP('Orders')), SP('Items'))).join('\n'))
        .not.toContain('more than one database');
    expect(validateProfileCompleteness(
               model, spec(name(SP('Orders')), name(BQ('items')))).join('\n'))
        .toContain('more than one database');
  });

  // A profile's rebinding is read as the model file's source is: a GCP
  // resource name keeps the form written in `authoredSource`, which push
  // stores and pull returns, and gets the URI's `dataSource`.
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
    for (const uri of [SP('Orders'), BQ('orders')]) {
      const name = uri.slice(2);
      const rebound = (source: string) => {
        const res = profileForDocument(
            doc, [{name: 'p', text: `name: p\nentities:\n  - name: orders\n    source: "${source}"\n`}],
            'p');
        if (res.kind !== 'file') throw new Error(JSON.stringify(res));
        return res.model.entities![0];
      };
      expect(rebound(name).authoredSource).toBe(name);
      expect(rebound(name).dataSource).toBe(rebound(uri).dataSource);
    }
  });

  // Two databases of one system imply that system's dialect.
  test('sources in two Spanner databases read the SPANNER text', () => {
    const SP2 = (db: string, t: string) =>
        `//spanner.googleapis.com/projects/p/instances/i/databases/${db}/tables/${t}`;
    const model: SemanticModel = {
      name: 'shop',
      entities: [
        {name: 'orders', dataSource: SP2('db1', 'Orders'),
         authoredSource: SP2('db1', 'Orders'), keys: ['id'],
         fields: [
           {name: 'id', expression: 'id'},
           {name: 'gross', expression: 'g'},
           {name: 'tax'},
           {name: 'net', expression: 'orders.gross',
            dialects: [{dialect: 'SPANNER', expression: 'orders.gross'},
                       {dialect: 'POSTGRES', expression: 'orders.gross - orders.tax'}]},
         ]},
        {name: 'items', dataSource: SP2('db2', 'Items'),
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

  // Pruning also reads the text the graph generators emit. Under a Spanner
  // profile an emitted ANSI_SQL text is read as Spanner SQL, so a hex literal,
  // which generic SQL cannot read, still reads the field.
  test('pruning reads an emitted ANSI_SQL text in the profile\'s dialect', () => {
    const hex = 'IF(orders.code = 0x1F, 1, 0)';
    const model: SemanticModel = {
      name: 'shop',
      entities: [{
        name: 'orders', dataSource: SP('Orders'), authoredSource: SP('Orders'),
        keys: ['id'],
        fields: [
          {name: 'id', expression: 'id'},
          {name: 'code'},
          {name: 'flag', expression: hex,
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
      entities: [{name: 'orders', source, fieldsExclude: ['tax']}],
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
               loaded('{dialects: [{dialect: BIGQUERY, expression: amt}]}'),
               atSource(SP('Orders')))
               .join('\n'))
        .toContain("field 'orders.amount' has no expression for SPANNER or ANSI_SQL");
    expect(validateProfileCompleteness(loaded('amt'), atSource(SP('Orders'))))
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
        {name: 'orders', source: BQ('o'),
         fields: [{name: 'cust', expression: 'details.customer.id'}]},
        {name: 'customer', source: BQ('c')},
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
          {name: 'customer', source: 'p.d.c', primary_key: ['id'],
           fields: [{name: 'id', expression: 'id'}, {name: 'name', expression: 'cust_name'}]},
          {name: 'vip', extends: ['customer'], source: 'p.d.v', primary_key: ['id'],
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


// A relationship's to_columns must cover a key of its target, a superset
// counts, and every binding covers the same keys.
describe('a relationship joins on a key of its target', () => {
  const BQ = (t: string) => `//bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
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

  test('covering more keys in one binding than another is a different cardinality', () => {
    const errors = validateProfileConsistency(
        model({keys: ['id'], uniqueKeys: [['email']]}, ['id']), [prod(['id', 'email'])]);
    expect(errors.join('\n')).toContain(
        "relationship 'placed_by' covers different keys under different bindings " +
        "(the model file: the primary key; profile 'prod': the primary key and unique key 1)");
  });
});


// A key or join column may name a field or its column, and both name the same
// column, as the graph generators read them.
describe('keys and join columns compare as the columns they name', () => {
  const BQ = (t: string) => `//bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
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
  const BQ = (t: string) => `//bigquery.googleapis.com/projects/acme/datasets/raw/tables/${t}`;
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
  const BQ = (t: string) => `//bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
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
    expect(() => loader.parseFieldExpression(7, "field 'a'", 'BIGQUERY'))
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
      `//spanner.googleapis.com/projects/p/instances/i/databases/db/tables/${t}`;
  const model = (): SemanticModel => ({
    name: 'shop',
    entities: [
      {name: 'party', abstract: true, dataSource: '', keys: [],
       fields: [{name: 'pid'}]},
      {name: 'orders', dataSource: SP('Orders'), authoredSource: SP('Orders'),
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
      {name: 'customer', dataSource: SP('Customer'), authoredSource: SP('Customer'),
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

  // A profile that states one join side keeps the model file's other side.
  // The completeness check still wants a named profile to state both.
  test('one join side from the profile, the other from the model file', () => {
    const profile: ProfileSpec = {
      name: 'p', entities: [],
      relationships: [{name: 'placed_by', fromColumns: ['cust_fk'], toColumns: []}],
    };
    const applied = applyProfile(model(), profile);
    const r = applied.relationships[0];
    expect([r.source.columns, r.destination.columns]).toEqual([['cust_fk'], ['id']]);
    expect(validateProfileCompleteness(model(), profile).join('\n'))
        .toContain("relationship 'placed_by' has no join columns in this profile");
    // The same holds for the other side.
    const toOnly = applyProfile(model(), {
      name: 'p', entities: [],
      relationships: [{name: 'placed_by', fromColumns: [], toColumns: ['key2']}],
    }).relationships[0];
    expect([toOnly.source.columns, toOnly.destination.columns])
        .toEqual([model().relationships[0].source.columns, ['key2']]);
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
      `//spanner.googleapis.com/projects/p/instances/i/databases/db/tables/${t}`;
  const BQ = (t: string) => `//bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;
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
        '//biglake.googleapis.com/projects/p/catalogs/c/namespaces/n/tables/orders';
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
        source: "//bigquery.googleapis.com/projects/acme/datasets/raw/tables/customer"
        primary_key: [c_id]
        unique_keys: [[c_email]]
        fields:
          - {name: c_id, expression: c_id}
          - {name: email, expression: c_email}
          - {name: party_name, expression: c_name}
      - name: account
        source: "//bigquery.googleapis.com/projects/acme/datasets/raw/tables/account"
        primary_key: [a_id]
        fields:
          - {name: a_id, expression: a_id}
          - {name: balance, expression: a_balance}
          - {name: note}
      - name: premium
        extends: [account]
        source: "//bigquery.googleapis.com/projects/acme/datasets/raw/tables/premium"
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
    source: "//bigquery.googleapis.com/projects/acme/datasets/prod/tables/customer"
    primary_key: [cust_id]
    unique_keys: [[cust_email], [cust_phone]]
  - name: account
    source: "//bigquery.googleapis.com/projects/acme/datasets/prod/tables/account"
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
        source: "//bigquery.googleapis.com/projects/acme/datasets/raw/tables/loop"
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
      'name: prod\nentities: [{name: party, source: "//bigquery.googleapis.com/projects/acme/datasets/raw/tables/party"}]\n',
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
        source: "//bigquery.googleapis.com/projects/acme/datasets/raw/tables/orders"
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
        `//spanner.googleapis.com/projects/acme/instances/i/databases/db/tables/${t}`;
    const profileOf = (source: string, net: string, rest = '') => `name: prod
entities:
  - name: orders
    source: "${source}"
    fields:
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
          '//bigquery.googleapis.com/projects/acme/datasets/prod/tables/orders',
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

    test('pruning also reads the text the generators emit', () => {
      // The generators emit `expression`, here the BIGQUERY text, whatever the
      // engine. Pruning reads it too, so the Spanner DDL never reads `tax`.
      const {applied} = check(profileOf(
          SPANNER('orders'),
          '            - {dialect: SPANNER, expression: "orders.gross"}\n' +
          '            - {dialect: BIGQUERY, expression: "orders.gross - orders.tax"}\n'));
      expect(pruneUnavailable(applied, 'prod').report.droppedFields).toEqual(
          [{name: 'orders.net', reason: 'reads orders.tax, which is unavailable'}]);
      // A field with no text for the profile's dialect is judged by the
      // vendor text the BigQuery generator would emit.
      const vendor = check(profileOf(
          '//bigquery.googleapis.com/projects/acme/datasets/prod/tables/orders',
          '            - {dialect: SNOWFLAKE, expression: "orders.gross - orders.tax"}\n'));
      expect(pruneUnavailable(vendor.applied, 'prod').report.droppedFields)
          .toEqual([{name: 'orders.net', reason: 'reads orders.tax, which is unavailable'}]);
    });

    test('with sources in two databases, every text counts', () => {
      const {applied} = check(profileOf(
          '//bigquery.googleapis.com/projects/acme/datasets/prod/tables/orders',
          '            - {dialect: BIGQUERY, expression: "orders.gross"}\n' +
          '            - {dialect: ANSI_SQL, expression: "orders.gross - orders.tax"}\n'));
      const twoDatabases = structuredClone(applied);
      twoDatabases.entities.push({
        name: 'customers', dataSource: SPANNER('customers'), keys: ['id'],
        fields: [{name: 'id', expression: 'id'}],
      });
      const {report} = pruneUnavailable(twoDatabases, 'prod');
      expect(report.droppedFields.map(d => d.name)).toEqual(['orders.net']);
    });

    test("an ANSI_SQL text is read as the profile's own SQL", () => {
      // The generic parser cannot read a hex literal; the BigQuery one can.
      const {applied} = check(profileOf(
          '//bigquery.googleapis.com/projects/acme/datasets/prod/tables/orders',
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
    source: "//bigquery.googleapis.com/projects/acme/datasets/prod/tables/account"
    fields:
      - {name: note, expression: a_note}
    fields_exclude: [balance]
`, 'prod');
    if ('error' in fromFile) throw new Error(fromFile.error);
    const inMemory: ProfileSpec = {
      name: 'prod',
      entities: [{
        name: 'account',
        source: '//bigquery.googleapis.com/projects/acme/datasets/prod/tables/account',
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
    // The load reports the half-bound join inside its schema error.
    const half = 'name: prod\nrelationships: [{name: refers, from_columns: [p_cust]}]\n';
    const applied = viaApply(SHOP, half);
    if (!('error' in applied)) throw new Error('expected an error');
    expect(applied.error)
        .toBe(
            "profile 'prod': relationship 'refers': from_columns and " +
            'to_columns must be given together (both bind the edge) or both ' +
            'omitted (a logical edge); one without the other is a half-bound ' +
            'join.');
    expect((viaMerge(SHOP, half) as {error: string}).error)
        .toContain(applied.error.replace("profile 'prod': ", ''));
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

  test('the warnings match the ones a load of the merged document gives', () => {
    const model = `version: "0.2.0.dev0/google"
semantic_model:
  - name: sales
    entities:
      - name: orders
        source: "//bigquery.googleapis.com/projects/acme/datasets/raw/tables/orders"
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
  const BQ = (t: string) => `//bigquery.googleapis.com/projects/acme/datasets/raw/tables/${t}`;
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
    const SP = (t: string) => `//spanner.googleapis.com/projects/p/instances/i/databases/db/tables/${t}`;
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
