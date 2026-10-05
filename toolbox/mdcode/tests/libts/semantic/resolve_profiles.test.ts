// Behavior specification for the binding-profile passes
// (src/libts/semantic/resolve_profiles.ts): mergeProfile overlays a profile's
// physical bindings onto a logical model by name and enforces the binding-only
// contract; pruneUnavailable drops what a binding cannot answer and reports it.
// Builders are minimal literals in the readable authoring form (mergeProfile) or
// the IR (pruneUnavailable), mirroring resolve_inheritance.test.ts.

import {describe, expect, test} from 'bun:test';

import {isFieldBound, ProfileSpec, SemanticModel} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';
import {resolveInheritance} from '../../../src/libts/semantic/resolve_inheritance';
import {applyProfileExclusions, loadProfileFile, mergeProfile, mergeProfileOntoDoc, pruneUnavailable, validateProfileCompleteness, validateProfileConsistency} from '../../../src/libts/semantic/resolve_profiles';

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
    expect(errors.join('\n')).toContain("entity 'Ghost' is not in the model");
    expect(errors.join('\n')).toContain("relationship 'Nope' is not in the model");
    expect(errors.join('\n')).toContain("metric 'missing' in 'metrics_exclude'");
    const fieldErr = validateProfileCompleteness(irModel(), profile({
      entities: [{...profile().entities[0], fieldsExclude: ['ghost']}, profile().entities[1]],
    }));
    expect(fieldErr.join('\n')).toContain("field 'Customer.ghost' is not in the model");
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
    })).join('\n')).toContain('joins 2 column(s) to 1');
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
    // profile b points them at another column.
    const errors = validateProfileConsistency(irModel(), [
      p('a'),
      p('b', {relationships: [{name: 'PlacedBy', fromColumns: ['o_c'], toColumns: ['email']}]}),
    ]);
    expect(errors.join('\n')).toContain(
        "relationship 'PlacedBy' has a different cardinality");
    expect(validateProfileConsistency(irModel(), [
      p('b', {
        relationships: [{name: 'PlacedBy', fromColumns: ['o_c'], toColumns: ['c_id']}],
        entities: [{name: 'Customer', primaryKey: ['c_id']}],
      }),
    ])).toEqual([]);
  });
});


describe('profile checks the first review found missing', () => {
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
    expect(errors.join('\n')).toContain("field 'Customer.lifetimeValue' has no binding");
  });

  test('a bare table name and an unknown form are not sources (Model Spec §4.4)', () => {
    const bare = base({entities: [{...base().entities[0], source: 'acme.prod.customer'},
                                  base().entities[1]]});
    expect(validateProfileCompleteness(irModel(), bare).join('\n'))
        .toContain("source 'acme.prod.customer' is not a resource URI or a catalog name");
    const unknown = base({entities: [{...base().entities[0], source: '//trino.example.com/x'},
                                     base().entities[1]]});
    expect(validateProfileCompleteness(irModel(), unknown).join('\n'))
        .toContain('is not a resource URI or a catalog name');
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
      {name: 'Order', source: '//alloydb.googleapis.com/projects/p/locations/us/clusters/c/instances/i/databases/db/tables/orders'},
    ]});
    expect(validateProfileCompleteness(irModel(), alloy)).toEqual([]);
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

  test('loadProfileFile reads actions, rejects bad shapes, and matches dialects in any case', () => {
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
        expression: {dialects: [{dialect: bigquery, expression: r}]}
`, 'prod');
    expect(p.actions).toEqual([
      {name: 'Cancel', executor: {kind: 'sql', sql: {statements: ['UPDATE t SET x = 1']}}},
      {name: 'Read', executor: null},
    ]);
    expect(p.entities[0].fields![0].expression).toBe('r');
    expect(p.entities[0].fields![0].dialects).toEqual([{dialect: 'BIGQUERY', expression: 'r'}]);
    expect(() => loadProfileFile('name: prod\nentities:\n  -\n', 'prod')).toThrow(/not a mapping/);
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
    source: p.d.orders
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
        .toThrow(/must be a string or a list of dialects/);
  });
});


describe('profile review follow-ups', () => {
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

  test('only the sources Model Spec §4.4 lists are accepted', () => {
    const errorsFor = (source: string) => validateProfileCompleteness(model(true), spec([
      {name: 'customer', source}, {name: 'vip', source: BQ('v')},
    ])).join('\n');
    for (const bad of [
           'not_a_table', 'acme.raw.customer', 'custom:foo.bar', 'trino:c.s.t',
           'bigtable:p.i.t', 'spanner:p.c.i.db', 'bigquery:p.d',
           '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g',
         ]) {
      expect(errorsFor(bad)).toContain('is not a resource URI or a catalog name');
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
        .toContain('is not a resource URI or a catalog name');
    expect(errorsFor('postgresql:acme.us.inst.db1.public.c', 'postgresql:acme.us.inst.db1.public.v'))
        .toContain('is not a resource URI or a catalog name');
  });

  test('a BigLake table shares BigQuery\'s database', () => {
    expect(validateProfileCompleteness(model(true), spec([
      {name: 'customer',
       source: '//biglake.googleapis.com/projects/p/catalogs/c/namespaces/n/tables/t'},
      {name: 'vip', source: BQ('v')},
    ]))).toEqual([]);
  });
});


describe('profile rules from the spec', () => {
  const BQ = (t: string) => `//bigquery.googleapis.com/projects/p/datasets/d/tables/${t}`;

  // Mapping Addendum 2 §2: every binding that states the join columns gives the
  // same cardinality answer, the model file's included.
  test('cardinality compares the model file\'s binding when it states join columns', () => {
    const model = (inlineJoin: boolean): SemanticModel => ({
      name: 'm',
      entities: [
        {name: 'customer', dataSource: '', keys: [], fields: [{name: 'id', type: 'Integer'}]},
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
      entities: [{name: 'customer', source: BQ('c'), primaryKey: ['c_id']}],
      relationships: [{name: 'placed_by', fromColumns: ['o_cust'], toColumns: ['c_id']}],
    };
    expect(validateProfileConsistency(model(true), [prod]).join('\n'))
        .toContain("relationship 'placed_by' has a different cardinality");
    expect(validateProfileConsistency(model(false), [prod])).toEqual([]);
  });

  // Model Spec §4.5 and §3.5.3: a profile field expression reads only its own
  // entity's columns and fields.
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

  // Model Spec §3.5.2: only the allowlisted dialects, each once.
  test('a profile expression may use only allowlisted dialects, each once', () => {
    const file = (dialects: string) =>
        `name: prod\nentities:\n  - name: o\n    fields:\n      - {name: a, expression: {dialects: [${dialects}]}}\n`;
    expect(() => loadProfileFile(file('{dialect: TABLEAU, expression: x}'), 'prod'))
        .toThrow("dialect 'TABLEAU' is not one of");
    expect(() => loadProfileFile(
               file('{dialect: BIGQUERY, expression: x}, {dialect: bigquery, expression: y}'),
               'prod'))
        .toThrow("dialect 'BIGQUERY' appears twice");
    expect(loadProfileFile(file('{dialect: BigQuery, expression: x}'), 'prod')
               .entities[0].fields![0].dialects)
        .toEqual([{dialect: 'BIGQUERY', expression: 'x'}]);
  });

  // Model Spec §4.2.2: kcmd push MUST reject a profile entry for an abstract entity.
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

  // Model Spec §3.1.3: a binding is a per-table fact, so an exclusion applies
  // to the entity that names it.
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


describe('profile checks the second review found missing', () => {
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

  // Mapping §8.1: every bound field has a text its profile's database can run.
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
    // The short form matches every engine (Model Spec §3.5).
    expect(validateProfileCompleteness(bqOnly(), rebound(SP('Orders'), 'Amount'))).toEqual([]);
  });

  // Model Spec §3.5.3: only `entity.field` names a field; a struct path does not.
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

  // Mapping Addendum 2 §2, with the exact-match reading in decisions.md.
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
    }]).join('\n')).toContain("relationship 'placed_by' has a different cardinality");
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

  // decisions.md: actions are out of preview scope and gain no new checks.
  test('a profile file may list an action twice, as the merge always allowed', () => {
    expect(loadProfileFile('name: p\nactions:\n  - {name: Cancel}\n  - {name: Cancel}\n', 'p')
               .actions!.length)
        .toBe(2);
  });
});


describe('excluding a field a subtype redeclares', () => {
  // A redeclaration sets `expression` and nothing else (Model Spec §3.1.3), so
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
