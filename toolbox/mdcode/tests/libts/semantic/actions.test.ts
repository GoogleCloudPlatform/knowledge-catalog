// Behavior specification for model-level ACTIONS -- the write-side counterpart
// to metrics -- across the pipeline: loader parsing (executor + typed
// parameters), the push-time validation gate, and the Knowledge Catalog
// publish/pull round trip (actions ride the anchor's `overview` aspect, as they
// have no semantic-* system type of their own). Preconditions and `affects` are
// intentionally out of scope for this prototype.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {ACTIONS_OVERVIEW_MARKER, generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {fromDocument, LoadedModel, loadModels} from '../../../src/libts/semantic/loader';
import {validatePushRequirements} from '../../../src/libts/semantic/validate';

const FIXTURES = path.join(__dirname, 'fixtures');
const OPTS = {
  project: 'dest',
  location: 'us',
  entryGroup: 'eg'
};

function loadFixtureModel(name: string): SemanticModel {
  const text = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
  return loadModels(text).models[0];
}

// A one-entity document with an actions array, for focused loader tests.
function withActions(actions: any[], over: any = {}) {
  return fromDocument({
    semantic_model: [{
      name: 'm',
      datasets: [
        {name: 'customer', source: 'p.d.c', primary_key: ['id'], fields: []}
      ],
      actions,
      ...over,
    }],
  });
}

const MCP = {
  mcp: {
    server: '//agentregistry.googleapis.com/x/mcpServers/commerce',
    tool: 'place_order'
  },
};


describe('loader parses actions', () => {
  test('reads name, description, executor, and typed parameters', () => {
    const {models, warnings} = withActions([{
      name: 'PlaceOrder',
      description: 'Create an order',
      executor: MCP,
      parameters: [
        {name: 'customer', type: 'customer'},
        {name: 'quantity', type: 'Integer'}
      ],
    }]);
    const [action] = models[0].actions!;
    expect(action.name).toBe('PlaceOrder');
    expect(action.description).toBe('Create an order');
    expect(action.executor).toEqual({kind: 'mcp', mcp: MCP.mcp});
    expect(action.parameters).toEqual([
      {name: 'customer', type: 'customer', isEntityRef: true},
      {name: 'quantity', type: 'Integer', isEntityRef: false},
    ]);
    expect(warnings).toEqual([]);
  });

  test('a model without actions leaves model.actions unset', () => {
    const {models} = fromDocument({
      semantic_model: [{
        name: 'm',
        datasets:
            [{name: 'c', source: 'p.d.c', primary_key: ['id'], fields: []}]
      }],
    });
    expect(models[0].actions).toBeUndefined();
  });

  test('an unresolvable parameter type is kept verbatim and warned', () => {
    const {models, warnings} = withActions([{
      name: 'A',
      executor: MCP,
      parameters: [{name: 'x', type: 'Nope'}],
    }]);
    const [p] = models[0].actions![0].parameters;
    expect(p).toEqual({name: 'x', type: 'Nope'});  // isEntityRef unset
    expect(
        warnings.some(w => w.includes('parameter \'x\'') && w.includes('Nope')))
        .toBe(true);
  });

  test('an executor with two kinds is rejected at parse', () => {
    expect(() => withActions([{
             name: 'A',
             executor: {mcp: MCP.mcp, rest: {endpoint: 'e', method: 'POST'}},
           }]))
        .toThrow(/exactly one kind/);
  });

  test('an executor with no kind is rejected at parse', () => {
    expect(() => withActions([{name: 'A', executor: {}}]))
        .toThrow(/exactly one kind/);
  });

  test('rest and grpc executors normalize to the tagged union', () => {
    const {models} = withActions([
      {
        name: 'R',
        executor: {rest: {endpoint: 'https://x/orders', method: 'POST'}}
      },
      {
        name: 'G',
        executor: {grpc: {service: 'commerce.Orders', method: 'Place'}}
      },
    ]);
    expect(models[0].actions![0].executor).toEqual({
      kind: 'rest',
      rest: {endpoint: 'https://x/orders', method: 'POST'}
    });
    expect(models[0].actions![1].executor).toEqual({
      kind: 'grpc',
      grpc: {service: 'commerce.Orders', method: 'Place'}
    });
  });

  test('duplicate action names warn', () => {
    const {warnings} = withActions([
      {name: 'Dup', executor: MCP},
      {name: 'Dup', executor: MCP},
    ]);
    expect(warnings.some(w => w.includes('action name') && w.includes('Dup')))
        .toBe(true);
  });

  test('duplicate parameter names within an action warn', () => {
    const {warnings} = withActions([{
      name: 'A',
      executor: MCP,
      parameters: [
        {name: 'customer', type: 'customer'},
        {name: 'customer', type: 'Integer'},
      ],
    }]);
    expect(warnings.some(
               w => w.includes('parameter name') && w.includes('customer') &&
                   w.includes('A')))
        .toBe(true);
  });
});


describe('validatePushRequirements gates actions', () => {
  const target =
      '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';
  const googleExt = {
    vendorName: 'GOOGLE',
    data: JSON.stringify({deploymentTargets: [target]})
  };

  function loaded(actions: any[]): LoadedModel {
    const model: SemanticModel = {
      name: 'm',
      entities:
          [{name: 'customer', dataSource: 'p.d.c', keys: ['id'], fields: []}],
      relationships: [],
      metrics: [],
      actions,
      customExtensions: [googleExt],
    };
    return {document: 'doc', model};
  }

  test('a well-formed action passes', () => {
    const errs = validatePushRequirements([loaded([{
      name: 'PlaceOrder',
      executor: {kind: 'mcp', mcp: {server: 's', tool: 't'}},
      parameters: [{name: 'customer', type: 'customer', isEntityRef: true}],
    }])]);
    expect(errs).toEqual([]);
  });

  test('an unresolved parameter type is a hard error', () => {
    const errs = validatePushRequirements([loaded([{
      name: 'A',
      executor: {kind: 'mcp', mcp: {server: 's', tool: 't'}},
      parameters: [{name: 'x', type: 'Nope'}],  // isEntityRef unset
    }])]);
    expect(errs.some(e => e.includes('parameter \'x\'') && e.includes('Nope')))
        .toBe(true);
  });

  test('a blank executor coordinate is a hard error', () => {
    const errs = validatePushRequirements([loaded([{
      name: 'A',
      executor: {kind: 'mcp', mcp: {server: '', tool: 't'}},
      parameters: [],
    }])]);
    expect(errs.some(e => e.includes('executor') && e.includes('server')))
        .toBe(true);
  });
});


describe('Knowledge Catalog publish/pull round trip', () => {
  const model = loadFixtureModel('actions_place_order.yaml');

  test('actions are published to the anchor overview aspect', () => {
    const {entries, warnings} = generateCatalogResources(model, OPTS);
    const anchor = entries[0];
    const overview = anchor.aspects?.['dataplex-types.global.overview'];
    expect(overview).toBeDefined();
    const content = overview!.data!.content as string;
    expect(overview!.data!.contentType).toBe('MARKDOWN');
    // Human-readable section + the machine-readable marker/JSON block.
    expect(content).toContain('## Actions');
    expect(content).toContain('### PlaceOrder');
    expect(content).toContain(ACTIONS_OVERVIEW_MARKER);
    expect(content).toContain('"place_order"');
    // Author is warned actions are catalog-only.
    expect(warnings.some(w => w.includes('action'))).toBe(true);
  });

  test('a pull recovers the actions from the overview', () => {
    const {entries, entryLinks} = generateCatalogResources(model, OPTS);
    const {models} = modelsFromCatalogResources(entries, entryLinks);
    expect(models[0].actions).toEqual(model.actions);
  });

  test('a pull missing the referenced entity drops isEntityRef and warns', () => {
    // Pull only the anchor: the `customer` entity entry is absent, so the
    // action's entity-typed `customer` parameter can no longer be resolved.
    const {entries} = generateCatalogResources(model, OPTS);
    const anchorOnly =
        entries.filter(e => e.entryType.endsWith('/semantic-model'));
    const {models, warnings} = modelsFromCatalogResources(anchorOnly);
    const params = models[0].actions![0].parameters;
    const customer = params.find(p => p.name === 'customer')!;
    const quantity = params.find(p => p.name === 'quantity')!;
    // The unresolvable entity type loses isEntityRef and is warned; the scalar
    // `quantity` still resolves.
    expect(customer.isEntityRef).toBeUndefined();
    expect(quantity.isEntityRef).toBe(false);
    expect(warnings.some(
               w => w.includes('parameter \'customer\'') &&
                   w.includes('resolved type')))
        .toBe(true);
  });

  test('a model with no actions carries no overview aspect', () => {
    const noActions: SemanticModel = {...model, actions: undefined};
    const {entries} = generateCatalogResources(noActions, OPTS);
    expect(entries[0].aspects?.['dataplex-types.global.overview'])
        .toBeUndefined();
  });
});
