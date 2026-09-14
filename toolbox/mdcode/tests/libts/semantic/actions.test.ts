// Behavior specification for model-level ACTIONS -- the write-side counterpart
// to metrics -- across the pipeline: loader parsing (executor + typed
// parameters), the push-time validation gate, and the Knowledge Catalog
// publish/pull round trip (actions have no BUILT-IN system type; the custom
// one they use is declared in kc_custom_types.ts and the encoding that fills
// it lives in kc_actions.ts). Preconditions and `affects` are out of scope
// for this prototype.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
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
// `actions` is a native extension key, so the document declares the extended
// profile (see the version gating in loader.ts).
function withActions(actions: any[], over: any = {}) {
  return fromDocument({
    version: '0.2.0.dev0/google',
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
      version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm',
        datasets:
            [{name: 'c', source: 'p.d.c', primary_key: ['id'], fields: []}]
      }],
    });
    expect(models[0].actions).toBeUndefined();
  });

  test('an explicit `executor: null` reads the same as no executor', () => {
    // `executor:` with its body commented out parses as null, and a profile
    // already spells withdrawal that way, so the two agree rather than one
    // being a parse error.
    const {models, warnings} =
        withActions([{name: 'A', executor: null, parameters: []}]);
    expect(models[0].actions![0].executor).toBeUndefined();
    expect(warnings).toEqual([]);
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

  test('an action with no executor at all loads, with executor unset', () => {
    // An empty executor is a binding that names no mechanism, which is an
    // authoring mistake. Omitting it entirely says something else: no binding
    // supplies one here. The action still declares what it does and what gates
    // it, which is the whole of what a reader needs, so it loads.
    const {models, warnings} = withActions([{
      name: 'A',
      description: 'Declared here, performed elsewhere',
      parameters: [{name: 'customer', type: 'customer'}],
    }]);
    const [action] = models[0].actions!;
    expect(action.executor).toBeUndefined();
    expect(action.description).toBe('Declared here, performed elsewhere');
    expect(action.parameters).toEqual([
      {name: 'customer', type: 'customer', isEntityRef: true},
    ]);
    expect(warnings).toEqual([]);
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

  test('a sql executor normalizes to the tagged union, trimmed', () => {
    // The statements are the write, so whitespace an author wrapped them in is
    // not part of it; trimming here keeps the verb check in validate.ts
    // reading the first word rather than the first character.
    const {models} = withActions([{
      name: 'S',
      executor:
          {sql: {statements: ['  DELETE FROM orders WHERE id = @id  ']}},
      parameters: [{name: 'id', type: 'Integer'}],
    }]);
    expect(models[0].actions![0].executor).toEqual({
      kind: 'sql',
      sql: {statements: ['DELETE FROM orders WHERE id = @id']},
    });
  });

  test('a sql executor with no statements is rejected at parse', () => {
    // An empty list is not an executor that does nothing; it is one that was
    // never written, and it is caught before validate has to reason about it.
    expect(() => withActions([{name: 'S', executor: {sql: {statements: []}}}]))
        .toThrow();
  });

  test('duplicate action names are rejected', () => {
    expect(() => withActions([
             {name: 'Dup', executor: MCP},
             {name: 'Dup', executor: MCP},
           ])).toThrow(/action name.*Dup/);
  });

  test('duplicate parameter names within an action are rejected', () => {
    expect(() => withActions([{
             name: 'A',
             executor: MCP,
             parameters: [
               {name: 'customer', type: 'customer'},
               {name: 'customer', type: 'Integer'},
             ],
           }])).toThrow(/parameter name.*customer/);
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

  test('an action with no executor passes: it is still publishable', () => {
    // The catalog records what the action does, and that is worth publishing
    // whether or not this binding can perform it. A missing executor is a
    // question of availability, which pruneUnavailable answers; a blank
    // coordinate INSIDE an executor is still a hard error, below.
    const errs = validatePushRequirements([loaded([{
      name: 'PlaceOrder',
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

  // A sql executor carries the write itself, so unlike the other three kinds it
  // has text the model can check -- and must check, since it is the one kind
  // that could otherwise smuggle an unreviewed write into a governed model.

  test('a sql statement must be a single DML write', () => {
    const errs = validatePushRequirements([loaded([{
      name: 'A',
      executor: {kind: 'sql', sql: {statements: ['SELECT * FROM customer']}},
      parameters: [],
    }])]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('starts with \'SELECT\'');
  });

  test('a statement separator is rejected', () => {
    // Each entry is executed on its own, so anything past the ';' would
    // silently not run -- the failure an author is least likely to notice.
    const errs = validatePushRequirements([loaded([{
      name: 'A',
      executor: {
        kind: 'sql',
        sql: {statements: ['DELETE FROM orders; DELETE FROM customer']}
      },
      parameters: [],
    }])]);
    expect(errs.some(e => e.includes('contains \';\''))).toBe(true);
  });

  test('a trailing semicolon is allowed', () => {
    // It separates nothing, so rejecting it would be pedantry rather than a
    // check.
    const errs = validatePushRequirements([loaded([{
      name: 'A',
      executor: {kind: 'sql', sql: {statements: ['DELETE FROM orders;']}},
      parameters: [],
    }])]);
    expect(errs).toEqual([]);
  });

  test('a statement may bind only parameters the action declares', () => {
    // The load-bearing check: it is what lets a runtime bind every value
    // instead of interpolating it, so an argument cannot become SQL.
    const errs = validatePushRequirements([loaded([{
      name: 'A',
      executor: {
        kind: 'sql',
        sql: {statements: ['DELETE FROM orders WHERE id = @orderId']}
      },
      parameters: [{name: 'id', type: 'Integer', isEntityRef: false}],
    }])]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('binds \'@orderId\'');
  });

  test('an @ inside a string literal is not read as a binding', () => {
    const errs = validatePushRequirements([loaded([{
      name: 'A',
      executor: {
        kind: 'sql',
        sql: {statements: ['UPDATE customer SET email = \'a@b.com\'']}
      },
      parameters: [],
    }])]);
    expect(errs).toEqual([]);
  });

  test('a created row keys off a parameter the caller cannot supply', () => {
    // The key of a new row cannot come from the caller: an agent that picks
    // its own primary keys can overwrite an existing row by choosing one that
    // is already taken. Declaring the create is what makes the generated name
    // bindable, so an action that writes a key it never declared creating is
    // told exactly which declaration is missing.
    const stmt = 'INSERT INTO customer (id) VALUES (@newcustomerKey)';
    const declared = validatePushRequirements([loaded([{
      name: 'A',
      executor: {kind: 'sql', sql: {statements: [stmt]}},
      parameters: [],
      affects: [{concept: 'customer', operation: 'create'}],
    }])]);
    expect(declared).toEqual([]);

    const undeclared = validatePushRequirements([loaded([{
      name: 'A',
      executor: {kind: 'sql', sql: {statements: [stmt]}},
      parameters: [],
      affects: [{concept: 'customer', operation: 'modify'}],
    }])]);
    expect(undeclared.length).toBe(1);
    expect(undeclared[0]).toContain('operation: create');
  });

  test('a sql executor of nothing but blanks is a hard error', () => {
    const errs = validatePushRequirements([loaded([{
      name: 'A',
      executor: {kind: 'sql', sql: {statements: ['   ']}},
      parameters: [],
    }])]);
    expect(errs.some(e => e.includes('statements'))).toBe(true);
  });
});


describe('Knowledge Catalog publish/pull round trip', () => {
  const model = loadFixtureModel('actions_place_order.yaml');
  const ACTION_ENTRY_TYPE = '/entryTypes/semantic-action';

  test('each action is published as its own semantic-action entry', () => {
    const {entries, warnings} = generateCatalogResources(model, OPTS);
    const entry = entries.find(e => e.entryType.endsWith(ACTION_ENTRY_TYPE))!;
    expect(entry).toBeDefined();
    // The type is custom, so it lives in the DESTINATION project at `global`,
    // where `kcmd init` provisions it -- not under `dataplex-types` with the
    // built-in types the other entries reference.
    expect(entry.entryType)
        .toBe('projects/dest/locations/global/entryTypes/semantic-action');
    // Ids sit alongside `<model>.entities.` and `<model>.metrics.`, and the
    // action hangs off the model anchor the way a metric does.
    expect(entry.name)
        .toBe(
            'projects/dest/locations/us/entryGroups/eg/entries/' +
            'sales.actions.PlaceOrder');
    expect(entry.parentEntry).toBe(entries[0].name);
    expect(entry.entrySource?.displayName).toBe('PlaceOrder');
    expect(entry.entrySource?.description).toBe('Create an order for a customer');

    const data = entry.aspects!['dest.global.semantic-action'].data!;
    expect(data.executorKind).toBe('mcp');
    expect(data.mcpTool).toBe('place_order');
    // Only the live executor kind's fields are written.
    expect(data.restEndpoint).toBeUndefined();
    expect(data.parameters).toEqual([
      {name: 'customer', type: 'customer', isEntityRef: true},
      {name: 'quantity', type: 'Integer', isEntityRef: false},
    ]);
    expect(data.instructions)
        .toBe('Resolve the buyer to a customer before calling.');
    // Author is warned actions are catalog-only.
    expect(warnings.some(w => w.includes('action'))).toBe(true);
  });

  test('the model owns its action entries for delete reconciliation', () => {
    const {ownedPrefixes} = generateCatalogResources(model, OPTS);
    expect(ownedPrefixes).toContain('sales.actions.');
  });

  test('a pull recovers the actions', () => {
    const {entries, entryLinks} = generateCatalogResources(model, OPTS);
    const {models} = modelsFromCatalogResources(entries, entryLinks);
    expect(models[0].actions).toEqual(model.actions);
  });

  test('an action with no executor publishes and pulls back unchanged', () => {
    // The `semantic-action` aspect type does not require `executorKind`: an
    // action no binding performs here is still a declaration, and the catalog
    // is where declarations live.
    const unbound: SemanticModel = structuredClone(model);
    delete unbound.actions![0].executor;

    const {entries, entryLinks} = generateCatalogResources(unbound, OPTS);
    const entry = entries.find(e => e.entryType.endsWith(ACTION_ENTRY_TYPE))!;
    const data = entry.aspects!['dest.global.semantic-action'].data!;
    expect(data.executorKind).toBeUndefined();
    // Everything else the action declares is still published.
    expect(data.parameters).toEqual([
      {name: 'customer', type: 'customer', isEntityRef: true},
      {name: 'quantity', type: 'Integer', isEntityRef: false},
    ]);

    const {models, warnings} = modelsFromCatalogResources(entries, entryLinks);
    expect(models[0].actions).toEqual(unbound.actions);
    expect(warnings.some(w => w.includes('executor'))).toBe(false);
  });

  test('an entry whose executor names a kind it cannot back is skipped', () => {
    // The other half of the rule above: no kind is a published state, a kind
    // with no coordinates is damage, and damage still degrades itself.
    const {entries, entryLinks} = generateCatalogResources(model, OPTS);
    const entry = entries.find(e => e.entryType.endsWith(ACTION_ENTRY_TYPE))!;
    entry.aspects!['dest.global.semantic-action'].data!.mcpTool = '';

    const {models, warnings} = modelsFromCatalogResources(entries, entryLinks);
    expect(models[0].actions ?? []).toEqual([]);
    expect(warnings.some(w => w.includes('no usable') && w.includes('executor')))
        .toBe(true);
  });

  test('a pull missing the referenced entity drops isEntityRef and warns', () => {
    // Pull the anchor and the action, but no entity entries: the `customer`
    // entity is absent, so the action's entity-typed `customer` parameter can
    // no longer be resolved.
    const {entries} = generateCatalogResources(model, OPTS);
    const withoutEntities =
        entries.filter(e => !e.entryType.endsWith('/semantic-entity'));
    const {models, warnings} = modelsFromCatalogResources(withoutEntities);
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

  test('a model with no actions publishes no action entry', () => {
    const noActions: SemanticModel = {...model, actions: undefined};
    const {entries} = generateCatalogResources(noActions, OPTS);
    expect(entries.some(e => e.entryType.endsWith(ACTION_ENTRY_TYPE)))
        .toBe(false);
  });
});


// The round trip above covers one MCP action in detail. These cover the shapes
// that differ: the other two executor kinds, an action with no parameters, and
// an action with neither a description nor instructions -- the cases where the
// aspect either takes a different branch or omits fields.
describe('Knowledge Catalog round trip across executor kinds', () => {
  const model = loadFixtureModel('actions_executors.yaml');
  const ACTION_ENTRY_TYPE = '/entryTypes/semantic-action';

  function actionEntriesOf(m: SemanticModel) {
    return generateCatalogResources(m, OPTS)
        .entries.filter(e => e.entryType.endsWith(ACTION_ENTRY_TYPE));
  }

  test('every action becomes one entry, parented to the model anchor', () => {
    const {entries} = generateCatalogResources(model, OPTS);
    const actions = entries.filter(e => e.entryType.endsWith(ACTION_ENTRY_TYPE));
    expect(actions.map(e => e.name.split('/entries/')[1])).toEqual([
      'commerce.actions.PlaceOrder',
      'commerce.actions.RefundOrder',
      'commerce.actions.CloseBooks',
      'commerce.actions.ReplaceOrder',
    ]);
    for (const e of actions) expect(e.parentEntry).toBe(entries[0].name);
  });

  test('each executor kind writes only its own coordinates', () => {
    const byName = new Map(
        actionEntriesOf(model).map(e => [e.entrySource!.displayName, e]));
    const dataOf = (name: string) =>
        byName.get(name)!.aspects!['dest.global.semantic-action'].data!;

    expect(dataOf('PlaceOrder')).toMatchObject({
      executorKind: 'mcp',
      mcpServer: '//agentregistry.googleapis.com/x/mcpServers/commerce',
      mcpTool: 'place_order',
    });
    expect(dataOf('RefundOrder')).toMatchObject({
      executorKind: 'rest',
      restEndpoint: 'https://commerce.example.com/v1/refunds',
      restMethod: 'POST',
    });
    expect(dataOf('CloseBooks')).toMatchObject({
      executorKind: 'grpc',
      grpcService: 'commerce.v1.Ledger',
      grpcMethod: 'CloseBooks',
    });
    // The one kind whose coordinate is a list, and whose order is part of the
    // meaning: the insert has to reach the store before the delete.
    expect(dataOf('ReplaceOrder')).toMatchObject({
      executorKind: 'sql',
      sqlStatements: [
        'INSERT INTO orders (o_orderkey, o_custkey) VALUES ' +
            '(@newordersKey, @buyer)',
        'DELETE FROM orders WHERE o_orderkey = @supersedes',
      ],
    });
    // A kind writes nothing belonging to another kind, so the aspect never
    // carries two executors at once.
    for (const [kind, foreign] of [
             ['PlaceOrder', ['restEndpoint', 'restMethod', 'grpcService', 'grpcMethod', 'sqlStatements']],
             ['RefundOrder', ['mcpServer', 'mcpTool', 'grpcService', 'grpcMethod', 'sqlStatements']],
             ['CloseBooks', ['mcpServer', 'mcpTool', 'restEndpoint', 'restMethod', 'sqlStatements']],
             ['ReplaceOrder', ['mcpServer', 'mcpTool', 'restEndpoint', 'restMethod', 'grpcService', 'grpcMethod']],
    ] as Array<[string, string[]]>) {
      for (const field of foreign) expect(dataOf(kind)[field]).toBeUndefined();
    }
  });

  test('an action with nothing optional omits those fields entirely', () => {
    const closeBooks = actionEntriesOf(model).find(
        e => e.entrySource!.displayName === 'CloseBooks')!;
    // No description, so the entry source carries none, and no instructions.
    expect(closeBooks.entrySource!.description).toBeUndefined();
    const data = closeBooks.aspects!['dest.global.semantic-action'].data!;
    expect(data.instructions).toBeUndefined();
    expect(data.parameters).toEqual([]);
  });

  test('a pull recovers every action unchanged', () => {
    const {entries, entryLinks} = generateCatalogResources(model, OPTS);
    const {models} = modelsFromCatalogResources(entries, entryLinks);
    // Entries come back ordered by the catalog rather than by the document, so
    // compare as a set keyed by name.
    const byName = (m: SemanticModel) =>
        Object.fromEntries((m.actions ?? []).map(a => [a.name, a]));
    expect(byName(models[0])).toEqual(byName(model));
  });

  test('a second push of the pulled model produces the same entries', () => {
    // Push -> pull -> push has to be a fixed point: if it were not, a pull
    // followed by a push would rewrite entries that nobody edited.
    const first = generateCatalogResources(model, OPTS);
    const {models} = modelsFromCatalogResources(first.entries, first.entryLinks);
    const second = generateCatalogResources(models[0], OPTS);

    const actionsOf = (entries: typeof first.entries) =>
        entries.filter(e => e.entryType.endsWith(ACTION_ENTRY_TYPE))
            .map(e => [e.name, e.aspects!['dest.global.semantic-action'].data])
            .sort();
    expect(actionsOf(second.entries)).toEqual(actionsOf(first.entries));
  });
});


describe('actions referencing entities the push does not publish', () => {
  test('an abstract entity parameter is published but warned about', () => {
    // An abstract entity is a table-less supertype, so the Knowledge Catalog
    // leg skips it. A parameter typed by one therefore names an entity with no
    // entry, which a later pull cannot tell from a misspelled scalar.
    const {models} = fromDocument({
      version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm',
        entities: [
          {name: 'party', abstract: true, fields: []},
          {
            name: 'customer',
            source: 'p.d.c',
            primary_key: ['id'],
            fields: [{name: 'id', expression: {dialects: [{dialect: 'ANSI_SQL', expression: 'id'}]}}],
          },
        ],
        actions: [{
          name: 'Notify',
          executor: MCP,
          parameters: [{name: 'who', type: 'party'}],
        }],
      }],
    });
    // The loader resolved it against the ontology, which includes abstract
    // entities.
    expect(models[0].actions![0].parameters[0].isEntityRef).toBe(true);

    const {warnings} = generateCatalogResources(models[0], OPTS);
    expect(warnings.some(
               w => w.includes('parameter \'who\'') &&
                   w.includes('does not publish')))
        .toBe(true);
  });
});
