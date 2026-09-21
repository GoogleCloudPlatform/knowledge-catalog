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
import {mergeProfileOntoDoc} from '../../../src/libts/semantic/resolve_profiles';
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

const ACTIONS_DOC =
    path.join(__dirname, '../../../docs/semantic-model/actions.md');

// The first ```yaml fence under `heading` in the actions guide.
//
// The guide's examples are the ones a reader will copy, so the tests below run
// the guide's own text rather than a copy of it: a copy keeps passing after
// the doc is edited, which is exactly the drift worth catching. Throwing on a
// heading or fence that is not there means renaming a section fails the test
// loudly instead of silently testing nothing.
function yamlFenceFromActionsDoc(heading: string): string {
  const doc = fs.readFileSync(ACTIONS_DOC, 'utf8');
  const at = doc.indexOf(`\n${heading}\n`);
  if (at < 0) {
    throw new Error(
        `docs/semantic-model/actions.md has no heading '${heading}'. If it ` +
        `was renamed, update this test to the new name.`);
  }
  const open = doc.indexOf('\n```yaml\n', at);
  if (open < 0) {
    throw new Error(
        `docs/semantic-model/actions.md has no yaml fence under '${heading}'.`);
  }
  const body = open + '\n```yaml\n'.length;
  const close = doc.indexOf('\n```', body);
  if (close < 0) {
    throw new Error(
        `docs/semantic-model/actions.md has an unterminated yaml fence under ` +
        `'${heading}'.`);
  }
  return doc.slice(body, close + 1);
}

// A one-entity document with an actions array, for focused loader tests.
// `actions` is a native extension key, so the document declares the extended
// profile (see the version gating in loader.ts).
function withActions(actions: any[], over: any = {}) {
  return fromDocument({
    version: '0.2.0.dev0/google',
    semantic_model: [{
      name: 'm',
      datasets: [{
        name: 'customer',
        source: 'p.d.c',
        primary_key: ['id'],
        fields: [
          {name: 'id', datatype: 'Integer', description: 'The account number.'},
          {name: 'email', datatype: 'String'},
        ],
      }],
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
        {name: 'customer', concept: 'customer', field: 'id'},
        {name: 'quantity', type: 'Integer'}
      ],
    }]);
    const [action] = models[0].actions!;
    expect(action.name).toBe('PlaceOrder');
    expect(action.description).toBe('Create an order');
    expect(action.executor).toEqual({kind: 'mcp', mcp: MCP.mcp});
    // The projected one carries BOTH halves: the reference it was authored as,
    // and the type and wording that reference resolved to.
    expect(action.parameters).toEqual([
      {
        name: 'customer',
        type: 'Integer',
        concept: 'customer',
        field: 'id',
        description: 'The account number.',
      },
      {name: 'quantity', type: 'Integer'},
    ]);
    expect(warnings).toEqual([]);
  });

  test('a projected parameter with no name takes the field\'s', () => {
    const {models, warnings} = withActions([{
      name: 'A',
      executor: MCP,
      parameters: [{concept: 'customer', field: 'email'}],
    }]);
    expect(models[0].actions![0].parameters).toEqual([
      {name: 'email', type: 'String', concept: 'customer', field: 'email'},
    ]);
    expect(warnings).toEqual([]);
  });

  test('an authored description overrides the field\'s', () => {
    const {models} = withActions([{
      name: 'A',
      executor: MCP,
      parameters: [{
        name: 'who',
        concept: 'customer',
        field: 'id',
        description: 'Who the order is for.',
      }],
    }]);
    // The type still comes from the field: only the wording is the
    // parameter's to restate.
    expect(models[0].actions![0].parameters[0]).toEqual({
      name: 'who',
      type: 'Integer',
      concept: 'customer',
      field: 'id',
      description: 'Who the order is for.',
    });
  });

  test(
      'a label and an ai_context are inherited or overridden the same way',
      () => {
        const {models} = fromDocument({
          version: '0.2.0.dev0/google',
          semantic_model: [{
            name: 'm',
            datasets: [{
              name: 'customer',
              source: 'p.d.c',
              primary_key: ['id'],
              fields: [{
                name: 'id',
                datatype: 'Integer',
                label: 'Account number',
                ai_context: {synonyms: ['acct']},
              }],
            }],
            actions: [{
              name: 'A',
              parameters: [
                {name: 'a', concept: 'customer', field: 'id'},
                {
                  name: 'b',
                  concept: 'customer',
                  field: 'id',
                  label: 'Destination account',
                  ai_context: {synonyms: ['payee']},
                  description: 'Where it lands.',
                },
              ],
            }],
          }],
        });
        const [a, b] = models[0].actions![0].parameters;
        expect(a.label).toBe('Account number');
        expect(a.aiContext).toEqual({synonyms: ['acct']});
        expect(b.label).toBe('Destination account');
        expect(b.aiContext).toEqual({synonyms: ['payee']});
      });

  test('a `type` or `datatype` alongside `concept`/`field` is rejected at parse', () => {
    expect(
        () => withActions([{
          name: 'A',
          parameters:
              [{name: 'x', type: 'String', concept: 'customer', field: 'id'}],
        }]))
        .toThrow(/states a 'type' alongside 'concept: customer' and 'field: id'/);
    expect(
        () => withActions([{
          name: 'A',
          parameters:
              [{name: 'x', datatype: 'String', field: 'customer.id'}],
        }]))
        .toThrow(/states a 'datatype' alongside 'field: customer\.id'/);
  });

  test('half a projection is rejected at parse', () => {
    expect(
        () => withActions(
            [{name: 'A', parameters: [{name: 'x', concept: 'customer'}]}]))
        .toThrow(/states 'concept' without 'field'/);
    expect(
        () =>
            withActions([{name: 'A', parameters: [{name: 'x', field: 'id'}]}]))
        .toThrow(/states 'field' without 'concept'/);
  });

  test('dotted `field: Concept.field` shorthand projects the field and defaults name', () => {
    const {models, warnings} = withActions([{
      name: 'A',
      parameters: [
        {field: 'customer.id'},
        {name: 'payee', field: 'customer.id', description: 'Recipient account.'},
      ],
    }]);
    expect(warnings).toEqual([]);
    expect(models[0].actions![0].parameters).toEqual([
      {
        name: 'id',
        type: 'Integer',
        concept: 'customer',
        field: 'id',
        description: 'The account number.',
      },
      {
        name: 'payee',
        type: 'Integer',
        concept: 'customer',
        field: 'id',
        description: 'Recipient account.',
      },
    ]);
    expect(
        () => withActions([{
          name: 'A',
          parameters: [{concept: 'customer', field: 'customer.id'}],
        }]))
        .toThrow(/already contains a concept prefix/);
    expect(
        () => withActions([{
          name: 'A',
          parameters: [{name: 'x', field: 'a.b.c'}],
        }]))
        .toThrow(/not a valid 'Concept\.field' reference/);
  });

  test('`datatype` is accepted as an alias for `type` on standalone parameters', () => {
    const {models, warnings} = withActions([{
      name: 'A',
      parameters: [{name: 'amount', datatype: 'Float', description: 'How much.'}],
    }]);
    expect(warnings).toEqual([]);
    expect(models[0].actions![0].parameters[0]).toEqual({
      name: 'amount',
      type: 'Float',
      description: 'How much.',
    });
    expect(
        () => withActions([{
          name: 'A',
          parameters: [{name: 'amount', type: 'Float', datatype: 'Float'}],
        }]))
        .toThrow(/both 'type' and 'datatype'/);
  });

  test('an unknown concept and an unknown field read differently', () => {
    const unknownConcept = withActions([{
      name: 'A',
      parameters: [{name: 'x', concept: 'Nope', field: 'id'}],
    }]);
    expect(unknownConcept.warnings.some(
               w => w.includes('neither an entity nor a relationship') &&
                   w.includes('\'Nope\'')))
        .toBe(true);

    const unknownField = withActions([{
      name: 'A',
      parameters: [{name: 'x', concept: 'customer', field: 'nope'}],
    }]);
    expect(unknownField.warnings.some(
               w => w.includes('does not declare') && w.includes('\'nope\'')))
        .toBe(true);
    // Different sentences, so a reader is sent to the right half of the pair.
    expect(unknownConcept.warnings).not.toEqual(unknownField.warnings);
  });

  test('an entity name as `type` says to project a field instead', () => {
    const {warnings} = withActions([{
      name: 'A',
      parameters: [{name: 'x', type: 'customer'}],
    }]);
    expect(warnings.some(
               w => w.includes('which is an entity') &&
                   w.includes('{concept: customer, field: <field>}')))
        .toBe(true);
  });

  test('a standalone parameter with no type is warned', () => {
    const {warnings} = withActions([{
      name: 'A',
      parameters: [{name: 'x'}],
    }]);
    expect(warnings.some(w => w.includes('states no \'type\''))).toBe(true);
  });

  test('projecting an UNBOUND field resolves like any other', () => {
    // Deliberate: a parameter needs the logical definition, which an unbound
    // field has in full, so a logical-only model's actions are as usable as a
    // bound one's.
    const {models, warnings} = fromDocument({
      version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm',
        datasets: [{
          name: 'customer',
          source: 'p.d.c',
          primary_key: ['id'],
          fields: [
            {name: 'id', datatype: 'Integer', expression: 'id'},
            {name: 'notes', datatype: 'String', description: 'Free text.'},
          ],
        }],
        actions: [{
          name: 'A',
          parameters: [{concept: 'customer', field: 'notes'}],
        }],
      }],
    });
    expect(models[0].actions![0].parameters[0]).toEqual({
      name: 'notes',
      type: 'String',
      concept: 'customer',
      field: 'notes',
      description: 'Free text.',
    });
    expect(warnings.some(w => w.includes('notes') && w.includes('parameter')))
        .toBe(false);
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
    expect(p).toEqual({name: 'x', type: 'Nope'});
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
      parameters: [{name: 'customer', concept: 'customer', field: 'id'}],
    }]);
    const [action] = models[0].actions!;
    expect(action.executor).toBeUndefined();
    expect(action.description).toBe('Declared here, performed elsewhere');
    expect(action.parameters).toEqual([
      {
        name: 'customer',
        type: 'Integer',
        concept: 'customer',
        field: 'id',
        description: 'The account number.',
      },
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
           ]))
        .toThrow(/action name.*Dup/);
  });

  test('duplicate parameter names within an action are rejected', () => {
    expect(() => withActions([{
             name: 'A',
             executor: MCP,
             parameters: [
               {name: 'customer', concept: 'customer', field: 'id'},
               {name: 'customer', type: 'Integer'},
             ],
           }]))
        .toThrow(/parameter name.*customer/);
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
      entities: [{
        name: 'customer',
        dataSource: 'p.d.c',
        keys: ['id'],
        fields: [{name: 'id', type: 'Integer'}],
      }],
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
      parameters: [
        {name: 'customer', type: 'Integer', concept: 'customer', field: 'id'}
      ],
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
      parameters: [
        {name: 'customer', type: 'Integer', concept: 'customer', field: 'id'}
      ],
    }])]);
    expect(errs).toEqual([]);
  });

  test('an unresolved parameter type is a hard error', () => {
    const errs = validatePushRequirements([loaded([{
      name: 'A',
      executor: {kind: 'mcp', mcp: {server: 's', tool: 't'}},
      parameters: [{name: 'x', type: 'Nope'}],
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
      parameters: [{name: 'id', type: 'Integer'}],
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

  test(
      'a created row gets its key from the statement, whatever affects says',
      () => {
        // `affects` binds nothing. A statement that keys a new row with SQL the
        // store evaluates passes whatever the action declares it changes, and a
        // statement that binds a name no parameter declares fails either way.
        const supplied = 'INSERT INTO customer (id) VALUES (GENERATE_UUID())';
        const bound = 'INSERT INTO customer (id) VALUES (@who)';
        for (const operation of ['create', 'modify'] as const) {
          expect(validatePushRequirements([loaded([{
            name: 'A',
            executor: {kind: 'sql', sql: {statements: [supplied]}},
            parameters: [],
            affects: [{concept: 'customer', operation}],
          }])]))
              .toEqual([]);

          const errs = validatePushRequirements([loaded([{
            name: 'A',
            executor: {kind: 'sql', sql: {statements: [bound]}},
            parameters: [],
            affects: [{concept: 'customer', operation}],
          }])]);
          expect(errs.length).toBe(1);
          expect(errs[0]).toContain('declares no parameter of that name');
        }
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
    expect(entry.entrySource?.description)
        .toBe('Create an order for a customer');

    const data = entry.aspects!['dest.global.semantic-action'].data!;
    expect(data.executorKind).toBe('mcp');
    expect(data.mcpTool).toBe('place_order');
    // Only the live executor kind's fields are written.
    expect(data.restEndpoint).toBeUndefined();
    expect(data.parameters).toEqual([
      {
        name: 'customer',
        type: 'Integer',
        concept: 'customer',
        field: 'c_custkey',
        description: 'The customer\'s account number.',
      },
      {name: 'quantity', type: 'Integer'},
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
      {
        name: 'customer',
        type: 'Integer',
        concept: 'customer',
        field: 'c_custkey',
        description: 'The customer\'s account number.',
      },
      {name: 'quantity', type: 'Integer'},
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
    expect(
        warnings.some(w => w.includes('no usable') && w.includes('executor')))
        .toBe(true);
  });

  test(
      'a pull missing the projected concept recovers the parameter whole',
      () => {
        // Pull the anchor and the action, but no entity entries. Nothing is
        // re-derived on the way back, so the parameter arrives with its type
        // and its wording intact and still names the field it came from -- the
        // pull is missing the field's own entry, not the parameter's
        // definition.
        const {entries} = generateCatalogResources(model, OPTS);
        const withoutEntities =
            entries.filter(e => !e.entryType.endsWith('/semantic-entity'));
        const {models, warnings} = modelsFromCatalogResources(withoutEntities);
        const params = models[0].actions![0].parameters;
        expect(params.find(p => p.name === 'customer')).toEqual({
          name: 'customer',
          type: 'Integer',
          concept: 'customer',
          field: 'c_custkey',
          description: 'The customer\'s account number.',
        });
        expect(warnings.some(w => w.includes('parameter'))).toBe(false);
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
    return generateCatalogResources(m, OPTS).entries.filter(
        e => e.entryType.endsWith(ACTION_ENTRY_TYPE));
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
            '(GENERATE_UUID(), @buyer)',
        'DELETE FROM orders WHERE o_orderkey = @supersedes',
      ],
    });
    // A kind writes nothing belonging to another kind, so the aspect never
    // carries two executors at once.
    for (const [kind, foreign] of [
             [
               'PlaceOrder',
               [
                 'restEndpoint', 'restMethod', 'grpcService', 'grpcMethod',
                 'sqlStatements'
               ]
             ],
             [
               'RefundOrder',
               [
                 'mcpServer', 'mcpTool', 'grpcService', 'grpcMethod',
                 'sqlStatements'
               ]
             ],
             [
               'CloseBooks',
               [
                 'mcpServer', 'mcpTool', 'restEndpoint', 'restMethod',
                 'sqlStatements'
               ]
             ],
             [
               'ReplaceOrder',
               [
                 'mcpServer', 'mcpTool', 'restEndpoint', 'restMethod',
                 'grpcService', 'grpcMethod'
               ]
             ],
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


describe('actions projecting concepts the push does not publish', () => {
  test(
      'a parameter projected from an abstract entity publishes, and warns',
      () => {
        // An abstract entity is a table-less supertype, so the Knowledge
        // Catalog leg skips it. The parameter still publishes whole -- its type
        // and wording were resolved at load and travel in the aspect -- but the
        // catalog then names a concept it has no entry for, which is what the
        // warning is about.
        const {models} = fromDocument({
          version: '0.2.0.dev0/google',
          semantic_model: [{
            name: 'm',
            entities: [
              {
                name: 'party',
                abstract: true,
                fields: [{name: 'partyId', datatype: 'String'}],
              },
              {
                name: 'customer',
                source: 'p.d.c',
                primary_key: ['id'],
                fields: [{
                  name: 'id',
                  expression:
                      {dialects: [{dialect: 'ANSI_SQL', expression: 'id'}]}
                }],
              },
            ],
            actions: [{
              name: 'Notify',
              executor: MCP,
              parameters: [{name: 'who', concept: 'party', field: 'partyId'}],
            }],
          }],
        });
        // Resolved against the ontology, which includes abstract entities.
        expect(models[0].actions![0].parameters[0].type).toBe('String');

        const {warnings} = generateCatalogResources(models[0], OPTS);
        expect(warnings.some(
                   w => w.includes('parameter \'who\'') &&
                       w.includes('does not publish')))
            .toBe(true);
      });
});


describe('parameter description, required, and default', () => {
  test(
      'loader parses description, required, and default and round-trips through KC',
      () => {
        const {models} = withActions([{
          name: 'TransferFunds',
          executor: MCP,
          parameters: [
            {
              name: 'source',
              concept: 'customer',
              field: 'id',
              description: 'The account money leaves.'
            },
            {
              name: 'target',
              concept: 'customer',
              field: 'id',
              description: 'The account money enters.'
            },
            {name: 'currency', type: 'String', default: 'USD'},
            {
              name: 'memo',
              type: 'String',
              description: 'Optional note.',
              required: false
            },
          ],
        }]);
        const params = models[0].actions![0].parameters;
        expect(params[0]).toEqual({
          name: 'source',
          type: 'Integer',
          concept: 'customer',
          field: 'id',
          description: 'The account money leaves.',
        });
        expect(params[2]).toEqual({
          name: 'currency',
          type: 'String',
          default: 'USD',
        });
        expect(params[3]).toEqual({
          name: 'memo',
          type: 'String',
          description: 'Optional note.',
          required: false,
        });

        const cat = generateCatalogResources(models[0], OPTS);
        const pulled = modelsFromCatalogResources(cat.entries, cat.entryLinks);
        expect(pulled.models[0].actions![0].parameters).toEqual(params);
      });

  test(
      'validator requires descriptions when multiple parameters share a type',
      () => {
        const missingDesc = withActions([{
          name: 'TransferFunds',
          executor: MCP,
          parameters: [
            {name: 'source', type: 'String'},
            {name: 'target', type: 'String'},
          ],
        }]);
        const errs = validatePushRequirements(
            [{document: 'test.yaml', model: missingDesc.models[0]}],
            {targetOptional: true});
        expect(errs.some(
                   e => e.includes('multiple parameters of type \'String\'')))
            .toBe(true);

        const withDesc = withActions([{
          name: 'TransferFunds',
          executor: MCP,
          parameters: [
            {name: 'source', type: 'String', description: 'Origin account.'},
            {
              name: 'target',
              type: 'String',
              description: 'Destination account.'
            },
          ],
        }]);
        expect(validatePushRequirements(
                   [{document: 'test.yaml', model: withDesc.models[0]}],
                   {targetOptional: true}))
            .toEqual([]);
      });

  test('two parameters projecting the SAME field need descriptions', () => {
    // A stronger trigger than a shared scalar type: two parameters that project
    // one field are the same definition twice, and the only thing that can tell
    // a caller which is which is what each one says about itself. The field's
    // own description reaches both, so it cannot.
    const missingDesc = withActions([{
      name: 'TransferFunds',
      executor: MCP,
      parameters: [
        {name: 'source', concept: 'customer', field: 'id'},
        {name: 'target', concept: 'customer', field: 'id'},
      ],
    }]);
    const errs = validatePushRequirements(
        [{document: 'test.yaml', model: missingDesc.models[0]}],
        {targetOptional: true});
    expect(errs.some(
               e => e.includes('multiple parameters projected from') &&
                   e.includes('customer.id')))
        .toBe(true);

    const withDesc = withActions([{
      name: 'TransferFunds',
      executor: MCP,
      parameters: [
        {
          name: 'source',
          concept: 'customer',
          field: 'id',
          description: 'Origin account.'
        },
        {
          name: 'target',
          concept: 'customer',
          field: 'id',
          description: 'Destination account.'
        },
      ],
    }]);
    expect(validatePushRequirements(
               [{document: 'test.yaml', model: withDesc.models[0]}],
               {targetOptional: true}))
        .toEqual([]);
  });

  test('a projected and a declared parameter of one type still collide', () => {
    // What a caller sees is the datatype, so that is what the check keys on.
    // Keying it on the projection instead would let this pair through: the
    // schema offers two integers, one of them says nothing about itself, and
    // there is nothing to tell a caller which number goes where.
    const missingDesc = withActions([{
      name: 'PlaceOrder',
      executor: MCP,
      parameters: [
        {name: 'customer', concept: 'customer', field: 'id'},
        {name: 'quantity', type: 'Integer'},
      ],
    }]);
    const errs = validatePushRequirements(
        [{document: 'test.yaml', model: missingDesc.models[0]}],
        {targetOptional: true});
    expect(errs.some(
               e => e.includes('multiple parameters of type \'Integer\'') &&
                   e.includes('parameter \'quantity\' must have')))
        .toBe(true);

    // Describing the one that said nothing settles it; `customer` already
    // inherited a description from the field it projects.
    const withDesc = withActions([{
      name: 'PlaceOrder',
      executor: MCP,
      parameters: [
        {name: 'customer', concept: 'customer', field: 'id'},
        {name: 'quantity', type: 'Integer', description: 'How many.'},
      ],
    }]);
    expect(validatePushRequirements(
               [{document: 'test.yaml', model: withDesc.models[0]}],
               {targetOptional: true}))
        .toEqual([]);
  });

  test(
      'KC round-trip preserves empty string, null, literal "null", and exact decimal defaults',
      () => {
        const {models} = withActions([{
          name: 'EdgeCases',
          executor: MCP,
          parameters: [
            {name: 'blankStr', type: 'String', default: ''},
            {name: 'nullVal', type: 'String', default: null},
            {name: 'literalNull', type: 'String', default: 'null'},
            {
              name: 'exactDec',
              type: 'Decimal',
              default: '0.1000000000000000055'
            },
            {name: 'largeInt', type: 'Integer', default: '9007199254740993'},
          ],
        }]);
        const cat = generateCatalogResources(models[0], OPTS);
        const pulled = modelsFromCatalogResources(cat.entries, cat.entryLinks);
        expect(pulled.models[0].actions![0].parameters)
            .toEqual(models[0].actions![0].parameters);
      });

  test(
      'validator rejects required: true alongside default and invalid scalar defaults',
      () => {
        const contradictory = withActions([{
          name: 'BadDefault',
          executor: MCP,
          parameters: [
            {name: 'currency', type: 'String', required: true, default: 'USD'},
            {name: 'amount', type: 'Float', default: 'banana'},
          ],
        }]);
        const errs = validatePushRequirements(
            [{document: 'test.yaml', model: contradictory.models[0]}],
            {targetOptional: true});
        expect(
            errs.some(e => e.includes('\'required: true\' and a \'default\'')))
            .toBe(true);
        expect(errs.some(e => e.includes('default \'banana\' is invalid')))
            .toBe(true);
      });
});


describe('a published statement and a run read the verb the same way', () => {
  // Valid DML statements can begin with leading whitespace, comments, or CTEs,
  // or use dialect-specific upsert forms (`INSERT OR UPDATE`). `kcmd push`
  // (`validatePushRequirements`) calls `sqlExecutorErrors` to accept all of
  // these while rejecting non-DML verbs.
  const target =
      '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';

  function withStatement(sql: string): LoadedModel {
    return {
      document: 'doc',
      model: {
        name: 'm',
        entities: [{
          name: 'customer',
          dataSource: 'p.d.c',
          keys: ['id'],
          fields: [{name: 'id', type: 'Integer'}],
        }],
        relationships: [],
        metrics: [],
        actions: [{
          name: 'A',
          executor: {kind: 'sql', sql: {statements: [sql]}},
          parameters: [],
        }],
        customExtensions: [{
          vendorName: 'GOOGLE',
          data: JSON.stringify({deploymentTargets: [target]}),
        }],
      } as SemanticModel,
    };
  }

  test('a leading line comment is publishable', () => {
    expect(validatePushRequirements([
      withStatement('-- put the money back\nUPDATE customer SET id = 1')
    ])).toEqual([]);
  });

  test('a GoogleSQL # comment is publishable', () => {
    // Spanner speaks GoogleSQL, where `#` opens a line comment.
    expect(validatePushRequirements([
      withStatement('# put the money back\nUPDATE customer SET id = 1')
    ])).toEqual([]);
  });

  test('a leading block comment is publishable', () => {
    expect(validatePushRequirements([
      withStatement('/* settled */ DELETE FROM customer')
    ])).toEqual([]);
  });

  test('a CTE ahead of the verb is publishable', () => {
    expect(validatePushRequirements([withStatement(
        'WITH stale AS (SELECT id FROM customer) DELETE FROM customer')]))
        .toEqual([]);
  });

  test('sharing the scanner does not admit MERGE', () => {
    // The scanner reads MERGE so a run can say a MERGE matched nothing.
    // Publishing is governed by SQL_EXECUTOR_VERBS, which does not list it,
    // so widening where the verb is found must not widen which verbs pass.
    const errs =
        validatePushRequirements([withStatement('MERGE INTO customer USING x')]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('starts with \'MERGE\'');
  });

  test('a SELECT is still named, not reported as unreadable', () => {
    // The scanner reads DML verbs only, so it finds nothing in a SELECT. The
    // author wrote a query and can see that they did; answering 'no readable
    // DML verb' would describe their own statement back to them.
    const errs =
        validatePushRequirements([withStatement('SELECT * FROM customer')]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('starts with \'SELECT\'');
  });

  test('a statement with no verb at all reports the absence', () => {
    const errs = validatePushRequirements([withStatement('-- nothing here')]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain('has no readable DML verb');
  });
});


describe('a lone projection is not blamed for a duplication', () => {
  const target =
      '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';

  test(
      'one parameter projected from a field, beside a described scalar of the same type',
      () => {
        // The bucket collides by DATATYPE: `account` has no description of its
        // own and `quantity` does, so only `account` is indistinct. It is the
        // only parameter projected from `Account.accountId`, so naming that
        // field sends the author hunting for a second projection to delete.
        const errs = validatePushRequirements([{
          document: 'doc',
          model: {
            name: 'm',
            entities: [{
              name: 'Account',
              dataSource: 'p.d.a',
              keys: ['accountId'],
              fields: [{name: 'accountId', type: 'Integer'}],
            }],
            relationships: [],
            metrics: [],
            actions: [{
              name: 'A',
              executor: {kind: 'mcp', mcp: MCP.mcp},
              parameters: [
                {name: 'account', concept: 'Account', field: 'accountId',
                 type: 'Integer'},
                {name: 'quantity', type: 'Integer', description: 'How many.'},
              ],
            }],
            customExtensions: [{
              vendorName: 'GOOGLE',
              data: JSON.stringify({deploymentTargets: [target]}),
            }],
          } as SemanticModel,
        }]);
        expect(errs.length).toBe(1);
        expect(errs[0]).toContain('multiple parameters of type \'Integer\'');
        expect(errs[0]).not.toContain('projected from');
      });

  test('two parameters projected from one field still name it', () => {
    // The case the message was written for, which the narrower condition must
    // not cost: both came from the same field, so the field is the fix.
    const errs = validatePushRequirements([{
      document: 'doc',
      model: {
        name: 'm',
        entities: [{
          name: 'Account',
          dataSource: 'p.d.a',
          keys: ['accountId'],
          fields: [{name: 'accountId', type: 'Integer'}],
        }],
        relationships: [],
        metrics: [],
        actions: [{
          name: 'A',
          executor: {kind: 'mcp', mcp: MCP.mcp},
          parameters: [
            {name: 'from', concept: 'Account', field: 'accountId',
             type: 'Integer'},
            {name: 'to', concept: 'Account', field: 'accountId',
             type: 'Integer'},
          ],
        }],
        customExtensions: [{
          vendorName: 'GOOGLE',
          data: JSON.stringify({deploymentTargets: [target]}),
        }],
      } as SemanticModel,
    }]);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain(
        'multiple parameters projected from \'Account.accountId\'');
  });
});


describe('a projection the catalog cannot give back', () => {
  test('the concept publishes but the field does not', () => {
    // `pruneUnavailable` drops an unbound field and keeps the entity whose key
    // still binds, and a projected parameter no longer prunes its action. So
    // the entry goes out naming a field the `schema` aspect does not carry,
    // and the old check -- "is the concept published" -- said yes and stayed
    // quiet.
    const model: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'customer',
        dataSource: 'p.d.c',
        keys: ['id'],
        fields: [{name: 'id', type: 'Integer', expression: 'id'}],
      }],
      relationships: [],
      metrics: [],
      actions: [{
        name: 'Notify',
        executor: {kind: 'mcp', mcp: MCP.mcp},
        parameters: [{
          name: 'who',
          concept: 'customer',
          field: 'email',
          type: 'String',
        }],
      }],
    };
    const {warnings} = generateCatalogResources(model, OPTS);
    expect(warnings.some(
               w => w.includes('parameter \'who\'') &&
                   w.includes('without its \'email\' field')))
        .toBe(true);
  });

  test('the concept is a relationship, whose fields no entry records', () => {
    // Pull rebuilds relationships from `schema-join` entry links alone, and a
    // link records its two endpoints and nothing else -- so an association's
    // own fields come back from no entry, published or not.
    const model: SemanticModel = {
      name: 'm',
      entities: [
        {name: 'student', dataSource: 'p.d.s', keys: ['id'],
         fields: [{name: 'id', type: 'Integer', expression: 'id'}]},
        {name: 'course', dataSource: 'p.d.co', keys: ['id'],
         fields: [{name: 'id', type: 'Integer', expression: 'id'}]},
      ],
      relationships: [{
        name: 'enrollment',
        source: {entity: 'student', columns: ['id']},
        destination: {entity: 'course', columns: ['id']},
        association: {
          dataSource: 'p.d.e',
          keys: ['student_id', 'course_id'],
          sourceColumns: ['student_id'],
          destinationColumns: ['course_id'],
          fields: [{name: 'grade', type: 'String', expression: 'grade'}],
        },
      }],
      metrics: [],
      actions: [{
        name: 'Regrade',
        executor: {kind: 'mcp', mcp: MCP.mcp},
        parameters: [{
          name: 'grade',
          concept: 'enrollment',
          field: 'grade',
          type: 'String',
        }],
      }],
    };
    const {warnings} = generateCatalogResources(model, OPTS);
    expect(warnings.some(
               w => w.includes('parameter \'grade\'') &&
                   w.includes('is a relationship')))
        .toBe(true);
  });

  test('a published concept and a published field warn about nothing', () => {
    const model: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'customer',
        dataSource: 'p.d.c',
        keys: ['id'],
        fields: [{name: 'id', type: 'Integer', expression: 'id'}],
      }],
      relationships: [],
      metrics: [],
      actions: [{
        name: 'Notify',
        executor: {kind: 'mcp', mcp: MCP.mcp},
        parameters: [
          {name: 'who', concept: 'customer', field: 'id', type: 'Integer'}
        ],
      }],
    };
    const {warnings} = generateCatalogResources(model, OPTS);
    expect(warnings.some(w => w.includes('parameter \'who\''))).toBe(false);
  });

  test('Section 1 of docs/semantic-model/actions.md loads, validates, and publishes', () => {
    // Read straight out of the guide rather than copied in here: a duplicate
    // would keep passing while the doc drifted, which is the one failure this
    // test exists to catch.
    const docYaml = yamlFenceFromActionsDoc('## 1. Declare the action');
    const loaded = loadModels(docYaml);
    expect(loaded.warnings).toEqual([]);
    const model = loaded.models[0];
    // The doc writes `source` in the one-key form and `target` in the two-key
    // form, and both have to land as the same projected parameter.
    expect(model.actions![0].parameters).toEqual([
      {
        name: 'source',
        type: 'Integer',
        concept: 'Account',
        field: 'accountId',
        description: 'The account the money leaves.',
      },
      {
        name: 'target',
        type: 'Integer',
        concept: 'Account',
        field: 'accountId',
        description: 'The account the money goes to.',
      },
      {
        name: 'amount',
        type: 'Float',
        description: 'How much money to move.',
      },
    ]);
    expect(validatePushRequirements(
               [{document: 'payments.yaml', model}], {targetOptional: true}))
        .toEqual([]);
    const {warnings: kcWarnings} = generateCatalogResources(model, OPTS);
    expect(kcWarnings.some(w => w.includes('parameter'))).toBe(false);

    // The `sql` profile the guide shows next, merged onto that same model.
    const operationalYaml =
        yamlFenceFromActionsDoc('## Carrying the write as DML');
    const merged = mergeProfileOntoDoc(docYaml, operationalYaml, 'operational');
    expect('error' in merged).toBe(false);
    if ('error' in merged) return;
    const mergedModel = loadModels(merged.text).models[0];
    expect(mergedModel.actions![0].executor).toEqual({
      kind: 'sql',
      sql: {
        statements: [
          'UPDATE account SET balance = balance - @amount WHERE account_id = @source',
          'UPDATE account SET balance = balance + @amount WHERE account_id = @target',
          'INSERT INTO transfer (transfer_id, amount, debited_account_id) VALUES (GENERATE_UUID(), @amount, @source)',
        ],
      },
    });
    expect(validatePushRequirements([
      {document: 'payments.yaml', model: mergedModel}
    ])).toEqual([]);
  });

  test('the guide teaches both spellings of a projection, and they agree', () => {
    // Pins the claim under `A projected parameter takes its definition from a
    // field`: the one-key and two-key forms load to the same parameter.
    const docYaml = yamlFenceFromActionsDoc('## 1. Declare the action');
    expect(docYaml).toContain('field: Account.accountId');
    expect(docYaml).toContain('concept: Account');
    const [source, target] = loadModels(docYaml).models[0].actions![0].parameters;
    expect([source.concept, source.field, source.type])
        .toEqual([target.concept, target.field, target.type]);
  });
});
