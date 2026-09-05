// Behavior specification for the binding-profile passes
// (src/libts/semantic/resolve_profiles.ts): mergeProfile overlays a profile's
// physical bindings onto a logical model by name and enforces the binding-only
// contract; pruneUnavailable drops what a binding cannot answer and reports it.
// Builders are minimal literals in the readable authoring form (mergeProfile) or
// the IR (pruneUnavailable), mirroring resolve_inheritance.test.ts.

import {describe, expect, test} from 'bun:test';

import {SemanticModel} from '../../../src/libts/semantic/ir';
import {mergeProfile, pruneUnavailable} from '../../../src/libts/semantic/resolve_profiles';

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
    (modelOf(doc).entities ?? modelOf(doc).datasets).find(
        (e: any) => e.name === name);
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
        entityOf(profile, 'Customer').fields.filter(
            (f: any) => f.name !== 'availableCredit');
    const {doc, error} = mergeProfile(logicalDoc(), profile, 'analytical');
    expect(error).toBeUndefined();
    expect(fieldOf(doc, 'Customer', 'availableCredit').expression).toBeUndefined();
  });

  test('selecting a profile clears an inline logical binding it omits', () => {
    // Selecting a profile makes it authoritative for physical bindings: an
    // inline column binding in the logical model is cleared before the profile
    // is overlaid, so a field the profile does not rebind is left unbound
    // (omission is unbound).
    const logical = logicalDoc();
    fieldOf(logical, 'Customer', 'name').expression = 'inline_name';
    const profile = analyticalDoc();
    entityOf(profile, 'Customer').fields =
        entityOf(profile, 'Customer').fields.filter(
            (f: any) => f.name !== 'name');
    const {doc, error} = mergeProfile(logical, profile, 'analytical');
    expect(error).toBeUndefined();
    expect(fieldOf(doc, 'Customer', 'name').expression).toBeUndefined();
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

  test('a profile expression that is arbitrary SQL is rejected', () => {
    const profile = analyticalDoc();
    fieldOf(profile, 'Customer', 'lifetimeValue').expression = 'c_a + c_b';
    const {error} = mergeProfile(logicalDoc(), profile, 'analytical');
    expect(error).toMatch(/bare column reference/);
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


describe('pruneUnavailable drops what a binding cannot answer', () => {
  test('an unbound field is removed from its entity', () => {
    const {model, report} = pruneUnavailable(irModel(), 'operational');
    expect(fieldNames(model, 'Customer')).toEqual(['key', 'name']);
    expect(report.unboundFields).toContain('Customer.lifetimeValue');
  });

  test('a metric that reads an unbound field is dropped and reported', () => {
    const {model, report} = pruneUnavailable(irModel(), 'operational');
    expect(metricNames(model)).toEqual(['order_count']);
    const dropped = report.droppedMetrics.find(
        d => d.name === 'avg_lifetime_value');
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

  test('a relationship drops when a join field is unbound', () => {
    const m = irModel();
    // Unbind the FK field the relationship joins on.
    const customerKey =
        m.entities.find(e => e.name === 'Order')!.fields.find(
            f => f.name === 'customerKey')!;
    delete customerKey.expression;
    const {model, report} = pruneUnavailable(m, 'operational');
    expect(relNames(model)).toEqual([]);
    expect(report.droppedRelationships[0].name).toBe('PlacedBy');
  });

  test('the input is never mutated', () => {
    const m = irModel();
    const before = JSON.stringify(m);
    pruneUnavailable(m, 'operational');
    expect(JSON.stringify(m)).toBe(before);
  });

  test('a field carrying only an imported (untranspiled) expression is bound', () => {
    // A vendor-dialect field's column lives on `importedExpression` until
    // transpilation fills `expression`. It is bound -- it names a column -- so
    // pruning must not mistake it for unbound and drop it (or its metric).
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

  test('an unbound KEY field drops the whole entity and everything on it', () => {
    // A graph node must be keyed, so unbinding a key field makes the entire
    // entity unavailable; the relationship into it and the metric over it fall
    // with it, while the other entity survives.
    const m = irModel();
    const key = m.entities.find(e => e.name === 'Customer')!.fields.find(
        f => f.name === 'key')!;
    delete key.expression;
    const {model, report} = pruneUnavailable(m, 'operational');
    expect(model.entities.map(e => e.name)).toEqual(['Order']);
    expect(report.droppedEntities.map(d => d.name)).toEqual(['Customer']);
    expect(report.droppedEntities[0].reason).toMatch(/key field key is unbound/);
    // The relationship into Customer and the metric over it are gone; a metric
    // confined to the surviving entity stays.
    expect(relNames(model)).toEqual([]);
    expect(report.droppedRelationships[0].reason).toMatch(/Customer is unavailable/);
    expect(metricNames(model)).toEqual(['order_count']);
    expect(report.droppedMetrics.map(d => d.name)).toContain('avg_lifetime_value');
  });

  test('an abstract supertype survives pruning with its field names intact', () => {
    // An abstract entity has no table and no bindings by design: its fields are
    // column-less on purpose (they name the label its subtypes bind). Pruning
    // must NOT treat them as "unbound" and drop the entity for its unbound key,
    // or the shared label loses the signature the emitter reads.
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
