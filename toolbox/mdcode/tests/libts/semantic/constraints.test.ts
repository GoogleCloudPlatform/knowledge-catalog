// Behavior specification for model-level CONSTRAINTS: the named invariants a
// model states over its ontology. Covers the whole pipeline -- loader parsing,
// the push-time validation gate, the OSI round trip, and the Knowledge Catalog
// publish/pull round trip. Dataplex has no built-in constraint type, so a
// constraint publishes as one entry under the custom `semantic-constraint`
// type, the way an action publishes under `semantic-action`.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {fromDocument, LoadedModel, loadModels} from '../../../src/libts/semantic/loader';
import {serializeModel} from '../../../src/libts/semantic/osi_converter';
import {generateSpannerPropertyGraph} from '../../../src/libts/semantic/spanner';
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

// A one-entity document with a constraints array, for focused loader tests.
function withConstraints(constraints: any[], over: any = {}) {
  return fromDocument({
    version: '0.2.0.dev0/google',
    semantic_model: [{
      name: 'm',
      datasets: [{
        name: 'customer',
        source: 'p.d.c',
        primary_key: ['id'],
        fields: [{
          name: 'balance',
          expression: {dialects: [{dialect: 'ANSI_SQL', expression: 'balance'}]},
        }],
      }],
      constraints,
      ...over,
    }],
  });
}


describe('loader parses constraints', () => {
  test('reads name, expression, and description', () => {
    const {models, warnings} = withConstraints([{
      name: 'NonNegativeBalance',
      expression: 'customer.balance >= 0',
      description: 'A balance cannot go negative.',
    }]);
    // Scoped to constraints: the fixture's field expression emits an unrelated
    // dialect note.
    expect(warnings.filter(w => w.includes('constraint'))).toEqual([]);
    expect(models[0].constraints).toEqual([{
      name: 'NonNegativeBalance',
      expression: 'customer.balance >= 0',
      description: 'A balance cannot go negative.',
    }]);
  });

  test('a model without constraints leaves model.constraints unset', () => {
    const {models} = fromDocument({
      version: '0.2.0.dev0/google',
      semantic_model: [{
        name: 'm',
        datasets:
            [{name: 'customer', source: 'p.d.c', primary_key: ['id'], fields: []}],
      }],
    });
    expect(models[0].constraints).toBeUndefined();
  });

  test('description is optional', () => {
    const {models} =
        withConstraints([{name: 'C', expression: 'customer.balance >= 0'}]);
    expect(models[0].constraints).toEqual([
      {name: 'C', expression: 'customer.balance >= 0'}
    ]);
  });

  test('the expression is kept verbatim, not parsed', () => {
    // A compound expression the loader has no business interpreting: it belongs
    // to the evaluator, so it must survive character for character.
    const expr =
        'customer.balance >= 0 AND (total_revenue > 100 OR NOT flagged)';
    const {models} = withConstraints([{name: 'C', expression: expr}]);
    expect(models[0].constraints![0].expression).toBe(expr);
  });

  test('a constraint with no body parses and is caught by validation', () => {
    // Neither body is a schema-legal document, because the schema cannot say
    // "one of these two". The push gate is where it fails; see the
    // validatePushRequirements suite below.
    const {models} = withConstraints([{name: 'C'}]);
    expect(models[0].constraints).toEqual([{name: 'C'}]);
  });

  test('reads a judgment, and it is the whole of the body', () => {
    const {models} = withConstraints([{
      name: 'MemoNamesAFailure',
      judgment: 'The credit memo must name a specific service failure.',
      on_violation: 'escalate',
    }]);
    expect(models[0].constraints).toEqual([{
      name: 'MemoNamesAFailure',
      judgment: 'The credit memo must name a specific service failure.',
      onViolation: 'escalate',
    }]);
    expect(models[0].constraints![0].expression).toBeUndefined();
  });

  test('the judgment is kept verbatim, not reflowed', () => {
    const prose =
        'A discount over 30% must be justified by customer.balance history,\n' +
        'not by the size of the order alone.';
    const {models} =
        withConstraints([{name: 'C', judgment: prose, on_violation: 'warn'}]);
    expect(models[0].constraints![0].judgment).toBe(prose);
  });

  test('duplicate constraint names are rejected', () => {
    // A duplicate name is a hard load error in every other scope, and for the
    // same reason: an action naming a constraint would not say which it meant.
    expect(() => withConstraints([
             {name: 'C', expression: 'customer.balance >= 0'},
             {name: 'C', expression: 'customer.balance < 100'},
           ])).toThrow(/duplicate constraint name 'C'/);
  });

  test('ai_context rides the constraint onto the IR', () => {
    const {models} = withConstraints([{
      name: 'C',
      expression: 'customer.balance >= 0',
      ai_context: {instructions: 'Explain the shortfall in currency terms.'},
    }]);
    expect(models[0].constraints![0].aiContext)
        .toEqual({instructions: 'Explain the shortfall in currency terms.'});
  });

  test('custom_extensions on a constraint is rejected', () => {
    // A constraint is a native key of the extended profile, and that profile
    // has no `custom_extensions` surface at all -- the native keys replace it.
    expect(() => withConstraints([{
             name: 'C',
             expression: 'customer.balance >= 0',
             custom_extensions: [{vendor_name: 'ACME', data: '{}'}],
           }])).toThrow(/custom_extensions/);
  });
});


describe('validatePushRequirements gates constraints', () => {
  const target =
      '//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g';
  const googleExt = {
    vendorName: 'GOOGLE',
    data: JSON.stringify({deploymentTargets: [target]})
  };

  function loaded(constraints: any[]): LoadedModel {
    const model: SemanticModel = {
      name: 'm',
      entities: [{
        name: 'customer',
        dataSource: 'p.d.c',
        keys: ['id'],
        fields: [{name: 'balance'}],
      }],
      relationships: [],
      metrics: [],
      constraints,
      customExtensions: [googleExt],
    };
    return {document: 'doc', model};
  }

  test('a well-formed constraint passes', () => {
    const errs = validatePushRequirements(
        [loaded([{name: 'C', expression: 'customer.balance >= 0'}])]);
    expect(errs).toEqual([]);
  });

  test('an empty expression is a hard error', () => {
    const errs =
        validatePushRequirements([loaded([{name: 'C', expression: '   '}])]);
    expect(errs.some(e => e.includes("constraint 'C'") &&
                      e.includes('empty expression')))
        .toBe(true);
  });

  test('an unknown field on a KNOWN entity is a hard error', () => {
    const errs = validatePushRequirements(
        [loaded([{name: 'C', expression: 'customer.blance >= 0'}])]);
    expect(errs.some(e => e.includes('customer.blance'))).toBe(true);
  });

  test('a leading qualifier that is not an entity is left to the evaluator',
       () => {
         // `OrderedAs` names a relationship rather than an entity. Guessing
         // here would falsely reject a valid constraint, so validation stays
         // out of it.
         const errs = validatePushRequirements(
             [loaded([{name: 'C', expression: 'OrderedAs.quantity > 0'}])]);
         expect(errs).toEqual([]);
       });

  test('an expression that does not open with a field ref passes', () => {
    const errs = validatePushRequirements(
        [loaded([{name: 'C', expression: 'COUNT(*) > 0'}])]);
    expect(errs).toEqual([]);
  });

  test('a bad reference anywhere in an expression is a hard error', () => {
    // The scan does not stop at the leading qualifier. A guard reads its
    // action's parameters first, so the field it misspells is usually not the
    // token the expression opens with.
    const errs = validatePushRequirements(
        [loaded([{name: 'C', expression: 'amount <= customer.blance'}])]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('customer.blance');
  });

  test('an entity that declares no fields is not scanned', () => {
    // Fields are optional, and a logical model bound to nothing but Knowledge
    // Catalog routinely declares none. Reading an empty set as "this entity
    // has no such field" would refuse every constraint such a model can write.
    const m = loaded([{name: 'C', expression: 'orders.total >= 0'}]);
    m.model.entities = [
      {name: 'orders', dataSource: 'p.d.o', keys: ['id']} as any,
    ];
    expect(validatePushRequirements([m])).toEqual([]);
  });

  test('an extends naming an undeclared entity does not throw', () => {
    // declaredFields resolves inheritance, and that throws on an unknown
    // parent. A validation gate reports; it does not stack-trace.
    const m = loaded([{name: 'C', expression: 'customer.balance >= 0'}]);
    (m.model.entities[0] as any).extends = ['MissingParent'];
    expect(() => validatePushRequirements([m])).not.toThrow();
  });

  test('a bad extends does not throw through the affects check either', () => {
    // The action check resolves inheritance by a second path. Standing one
    // caller down and not the other leaves the stack trace exactly where a
    // model is most likely to reach it.
    const m = loaded([{name: 'C', expression: 'customer.balance >= 0'}]);
    (m.model.entities[0] as any).extends = ['MissingParent'];
    m.model.actions = [{
      name: 'Touch',
      description: 'd',
      executor: {kind: 'mcp', mcp: {server: 's', tool: 't'}},
      parameters: [],
      affects: [{concept: 'customer', operation: 'modify'}],
    }] as any;
    expect(() => validatePushRequirements([m])).not.toThrow();
  });

  test('a dotted path is not read as a field of its first segment', () => {
    // `customer.orders.total` is a path. Reading `orders` as a field of
    // `customer` rejects it for a field the author never claimed existed.
    const errs = validatePushRequirements(
        [loaded([{name: 'C', expression: 'customer.orders.total > 0'}])]);
    expect(errs).toEqual([]);
  });

  test('a tail naming a relationship is not read as a field', () => {
    // `customer.OwnedBy` is a traversal. The model declares the name, so the
    // scan cannot call it a misspelling.
    const m = loaded([{
      name: 'C',
      judgment: 'Trace the balance through customer.OwnedBy before approving.',
      onViolation: 'warn',
    }]);
    m.model.relationships = [{
      name: 'OwnedBy',
      source: {entity: 'customer', columns: ['id']},
      destination: {entity: 'customer', columns: ['id']},
    }];
    expect(validatePushRequirements([m])).toEqual([]);
  });

  test('a tail naming a metric is not read as a field', () => {
    // Metrics are model-level, so the qualifier is the entity the metric hangs
    // off rather than an entity that declares it as a field.
    const m = loaded([{name: 'C', expression: '0 <= customer.total_owed'}]);
    m.model.metrics = [{name: 'total_owed', entity: 'customer'}];
    expect(validatePushRequirements([m])).toEqual([]);
  });

  test('a tail naming another entity is not read as a field', () => {
    const m = loaded([{name: 'C', expression: 'customer.account > 0'}]);
    m.model.entities.push(
        {name: 'account', dataSource: 'p.d.a', keys: ['id'], fields: []} as
        any);
    expect(validatePushRequirements([m])).toEqual([]);
  });

  test('a tail the model declares nowhere is still a misspelling', () => {
    // The carve-outs above must not swallow the case the scan exists for.
    const m = loaded([{name: 'C', expression: 'customer.blance > 0'}]);
    m.model.relationships = [{
      name: 'OwnedBy',
      source: {entity: 'customer', columns: ['id']},
      destination: {entity: 'customer', columns: ['id']},
    }];
    m.model.metrics = [{name: 'total_owed', entity: 'customer'}];
    const errs = validatePushRequirements([m]);
    expect(errs.some(e => e.includes("declares no field 'blance'"))).toBe(true);
  });

  test('an extends naming an undeclared entity is reported', () => {
    // Standing the field scan down cannot mean saying nothing: nothing else on
    // a Knowledge-Catalog-only push resolves inheritance, so silence here
    // publishes the broken model.
    const m = loaded([{name: 'C', expression: 'customer.balance >= 0'}]);
    (m.model.entities[0] as any).extends = ['MissingParent'];
    const errs = validatePushRequirements([m]);
    expect(errs.some(e => e.includes('MissingParent'))).toBe(true);
  });

  test('an empty judgment still reports a missing on_violation', () => {
    // The two are independent. Reporting only the empty body sends the author
    // back for a second failure over a key they were never told about.
    const errs =
        validatePushRequirements([loaded([{name: 'C', judgment: '   '}])]);
    expect(errs.some(e => e.includes('empty judgment'))).toBe(true);
    expect(errs.some(e => e.includes('on_violation'))).toBe(true);
  });

  test('a quoted literal in an expression is not a field reference', () => {
    const errs = validatePushRequirements([loaded(
        [{name: 'C', expression: "customer.balance = 'customer.blance'"}])]);
    expect(errs).toEqual([]);
  });

  // The field check reads a field list, and by the time this gate runs the
  // model's field lists are no longer what the author wrote. Both directions
  // of that gap rejected a valid constraint.

  // `extends` is flattened by the graph legs, which run AFTER this gate, so a
  // subtype's own `fields` omit everything it inherits.
  function withInheritance(expression: string): LoadedModel {
    const model: SemanticModel = {
      name: 'm',
      entities: [
        {
          name: 'account',
          dataSource: 'p.d.a',
          keys: ['id'],
          fields: [{name: 'balance'}],
        },
        {
          name: 'savings',
          dataSource: 'p.d.s',
          keys: ['id'],
          fields: [],
          extends: ['account'],
        },
      ],
      relationships: [],
      metrics: [],
      constraints: [{name: 'C', expression}],
      customExtensions: [googleExt],
    };
    return {document: 'doc', model};
  }

  test('a constraint over an INHERITED field passes', () => {
    const errs =
        validatePushRequirements([withInheritance('savings.balance >= 0')]);
    expect(errs).toEqual([]);
  });

  test('a typo is still caught on an entity that inherits', () => {
    const errs =
        validatePushRequirements([withInheritance('savings.blance >= 0')]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain(`declares no field 'blance'`);
  });

  test('the field check stands down once the profile has pruned fields', () => {
    // A profile push drops every field the profile leaves unbound before this
    // gate sees the model, so the author's field is gone rather than misspelt.
    // A constraint reaches no graph in any case, so failing the push here would
    // refuse a deploy for no reason.
    const errs = validatePushRequirements(
        [loaded([{name: 'C', expression: 'customer.unbound >= 0'}])],
        {fieldsPruned: true});
    expect(errs).toEqual([]);
  });

  test('an empty expression is rejected even on a pruned model', () => {
    // Standing down applies to the field check alone; the expression itself is
    // still the constraint's whole content.
    const errs = validatePushRequirements(
        [loaded([{name: 'C', expression: '   '}])], {fieldsPruned: true});
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('empty expression');
  });

  // A constraint states its rule in one body or the other. The schema cannot
  // express that, so both halves of the exclusivity land here.

  test('declaring both bodies is a hard error', () => {
    const errs = validatePushRequirements([loaded([{
      name: 'C',
      expression: 'customer.balance >= 0',
      judgment: 'The balance must be defensible.',
    }])]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('declares both an expression and a judgment');
  });

  test('declaring neither body is a hard error', () => {
    const errs = validatePushRequirements([loaded([{name: 'C'}])]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('declares neither an expression nor a judgment');
  });

  test('an empty judgment is a hard error', () => {
    const errs = validatePushRequirements(
        [loaded([{name: 'C', judgment: '  ', onViolation: 'warn'}])]);
    expect(errs.some(e => e.includes('empty judgment'))).toBe(true);
  });

  test('a well-formed judged constraint passes', () => {
    const errs = validatePushRequirements([loaded([{
      name: 'C',
      judgment: 'A credit must be justified by a stated service failure.',
      onViolation: 'escalate',
    }])]);
    expect(errs).toEqual([]);
  });

  test('a judged constraint must state on_violation', () => {
    // Silence means `reject`, which is too strong a thing for an author to
    // inherit by leaving the key out of a rule a model settles.
    const errs = validatePushRequirements(
        [loaded([{name: 'C', judgment: 'The memo must be specific.'}])]);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('is judged, so it must state on_violation');
  });

  test('all three words are accepted on a judgment', () => {
    // `reject` included. A rule an organization means as unappealable is
    // representable, and publishes as `judged` beside the word so the pairing
    // can be found.
    for (const onViolation of ['reject', 'escalate', 'warn'] as const) {
      const errs = validatePushRequirements(
          [loaded([{name: 'C', judgment: 'Be specific.', onViolation}])]);
      expect(errs).toEqual([]);
    }
  });

  // A judgment gets its `Entity.field` tokens resolved by the same scan an
  // expression gets, so the two bodies are checked alike.

  test(
      'an unknown field on a KNOWN entity in a judgment is a hard error',
      () => {
        const errs = validatePushRequirements([loaded([{
          name: 'C',
          judgment: 'The write must be consistent with customer.blance.',
          onViolation: 'warn',
        }])]);
        expect(errs).toHaveLength(1);
        expect(errs[0]).toContain('customer.blance');
      });

  test(
      'a field reference anywhere in the prose is checked, not just the first',
      () => {
        const errs = validatePushRequirements([loaded([{
          name: 'C',
          judgment: 'Given customer.balance, the memo must also cite ' +
              'customer.blance and customer.nope.',
          onViolation: 'warn',
        }])]);
        expect(errs).toHaveLength(2);
        expect(errs.some(e => e.includes('customer.blance'))).toBe(true);
        expect(errs.some(e => e.includes('customer.nope'))).toBe(true);
      });

  test('the same bad reference twice is reported once', () => {
    const errs = validatePushRequirements([loaded([{
      name: 'C',
      judgment: 'Cite customer.blance, and check customer.blance again.',
      onViolation: 'warn',
    }])]);
    expect(errs).toHaveLength(1);
  });

  test('an unrecognized entity in a judgment is left alone', () => {
    // A judgment may name a concept from another system, and a wrong guess
    // here would refuse a valid rule. Only a known entity with an unknown
    // field is plainly a typo.
    const errs = validatePushRequirements([loaded([{
      name: 'C',
      judgment: 'The write must respect Salesforce.opportunity_stage.',
      onViolation: 'warn',
    }])]);
    expect(errs).toEqual([]);
  });

  test('ordinary prose is not mistaken for a field reference', () => {
    // A sentence boundary and a decimal both look like `x.y` to a careless
    // scan. Neither survives, because the leading segment has to name a
    // declared entity.
    const errs = validatePushRequirements([loaded([{
      name: 'C',
      judgment: 'Check the memo. Every credit over 30.5% needs a reason.',
      onViolation: 'warn',
    }])]);
    expect(errs).toEqual([]);
  });

  test('a lowercase entity name is checked like any other', () => {
    // The scan keys on the model declaring the entity rather than on the name
    // being capitalized: these models name entities `customer` and `orders`.
    const good = validatePushRequirements([loaded([{
      name: 'C',
      judgment: 'Weigh customer.balance against the stated reason.',
      onViolation: 'warn',
    }])]);
    expect(good).toEqual([]);
  });

  test('the field check in a judgment stands down on a pruned model', () => {
    const errs = validatePushRequirements(
        [loaded([{
          name: 'C',
          judgment: 'Consider customer.unbound before approving.',
          onViolation: 'warn',
        }])],
        {fieldsPruned: true});
    expect(errs).toEqual([]);
  });

  test('the routing check still runs on a pruned model', () => {
    // Pruning is about fields. Whether a violation says what it does not
    // depend on which columns this profile binds.
    const errs = validatePushRequirements(
        [loaded([{name: 'C', judgment: 'Be specific.'}])], {fieldsPruned: true});
    expect(errs).toHaveLength(1);
    expect(errs[0]).toContain('is judged, so it must state on_violation');
  });
});


describe('OSI round trip', () => {
  test('constraints survive serialize -> reload', () => {
    const model = loadFixtureModel('actions_place_order.yaml');
    expect(model.constraints).toHaveLength(5);
    const {yaml} = serializeModel(model);
    expect(yaml).toContain('constraints:');
    const reloaded = loadModels(yaml).models[0];
    expect(reloaded.constraints).toEqual(model.constraints);
  });

  test('a model with no constraints emits no constraints key', () => {
    const model = loadFixtureModel('actions_place_order.yaml');
    const {yaml} = serializeModel({...model, constraints: undefined});
    expect(yaml).not.toContain('constraints:');
  });
});


describe('Knowledge Catalog publish/pull round trip', () => {
  const model = loadFixtureModel('actions_place_order.yaml');
  const CONSTRAINT_ENTRY_TYPE = '/entryTypes/semantic-constraint';
  const CONSTRAINT_ASPECT = 'dest.global.semantic-constraint';

  function constraintEntriesOf(m: SemanticModel) {
    return generateCatalogResources(m, OPTS).entries.filter(
        e => e.entryType.endsWith(CONSTRAINT_ENTRY_TYPE));
  }

  test(
      'every constraint becomes one entry, parented to the model anchor',
      () => {
        const {entries, warnings} = generateCatalogResources(model, OPTS);
        const constraints =
            entries.filter(e => e.entryType.endsWith(CONSTRAINT_ENTRY_TYPE));
        expect(constraints.map(e => e.name.split('/entries/')[1])).toEqual([
          'sales.constraints.NonNegativeOrderTotal',
          'sales.constraints.PositiveQuantity',
          'sales.constraints.OrderWithinStandingLimit',
          'sales.constraints.RequestedQuantityIsPositive',
          'sales.constraints.LargeOrderIsJustified',
        ]);
        for (const e of constraints)
          expect(e.parentEntry).toBe(entries[0].name);
        // Author is warned constraints are catalog-only.
        expect(warnings.some(w => w.includes('constraint(s) published')))
            .toBe(true);
      });

  test(
      'the entry type is custom, so it lives in the destination project',
      () => {
        // Every built-in type is referenced from `dataplex-types`; this one is
        // provisioned by `kcmd init` in the project being pushed to.
        const [first] = constraintEntriesOf(model);
        expect(first.entryType)
            .toBe(
                'projects/dest/locations/global/entryTypes/' +
                'semantic-constraint');
        expect(first.aspects![CONSTRAINT_ASPECT].aspectType)
            .toBe(
                'projects/dest/locations/global/aspectTypes/' +
                'semantic-constraint');
      });

  test(
      'the aspect carries the expression and the entry source the description',
      () => {
        // PositiveQuantity is the fixture's constraint with no `ai_context`,
        // so its aspect is the expression alone.
        const positive = constraintEntriesOf(model).find(
            e => e.entrySource!.displayName === 'PositiveQuantity')!;
        expect(positive.aspects![CONSTRAINT_ASPECT].data).toEqual({
          expression: 'OrderedAs.quantity > 0',
          evaluation: 'deterministic',
        });
        // The description is the message a violation quotes back, so it is the
        // entry's human-readable summary rather than an aspect field.
        expect(positive.entrySource!.description)
            .toBe('An order line must be for at least one unit.');
      });

  test('the whole ai_context rides the constraint\'s own aspect', () => {
    // Not `instructions` alone: the built-in guidelines aspect has a home for
    // that part only, and a custom aspect kcmd defines has no reason to lose
    // the other two. The fixture declares all three so this is browsable.
    const [nonNegative] = constraintEntriesOf(model);
    expect(nonNegative.entrySource!.displayName).toBe('NonNegativeOrderTotal');
    expect(nonNegative.aspects![CONSTRAINT_ASPECT].data).toEqual({
      expression: 'orders.o_totalprice >= 0',
      evaluation: 'deterministic',
      aiContext: {
        instructions:
            'Quote the shortfall in the customer\'s own currency when refusing.',
        synonyms: ['NoNegativeTotals', 'NonNegativeTotal'],
        examples: ['Why was my order rejected?'],
      },
    });
  });

  test('a pull recovers every part of the ai_context', () => {
    // The emit side above and this read side are what make the annotation
    // survive a round trip; dropping either would lose a declared field
    // silently, since the pull rewrites the document it read.
    const {entries, entryLinks} = generateCatalogResources(model, OPTS);
    const {models} = modelsFromCatalogResources(entries, entryLinks);
    expect(models[0].constraints![0].aiContext).toEqual({
      instructions:
          'Quote the shortfall in the customer\'s own currency when refusing.',
      synonyms: ['NoNegativeTotals', 'NonNegativeTotal'],
      examples: ['Why was my order rejected?'],
    });
    // The constraint that declares none stays clean rather than gaining an
    // empty record.
    expect(models[0].constraints![1].aiContext).toBeUndefined();
  });

  test('a model with no constraints publishes no constraint entry', () => {
    const none: SemanticModel = {...model, constraints: undefined};
    expect(constraintEntriesOf(none)).toEqual([]);
  });

  test('the constraint prefix is owned, so a dropped constraint is deleted',
       () => {
         // Delete reconciliation removes server entries under an owned prefix
         // that this push did not re-emit; without the prefix a constraint
         // dropped from the model would linger in the catalog.
         const {ownedPrefixes} = generateCatalogResources(model, OPTS);
         expect(ownedPrefixes).toContain('sales.constraints.');
       });

  test('a pull recovers the constraints', () => {
    const {entries, entryLinks} = generateCatalogResources(model, OPTS);
    const {models} = modelsFromCatalogResources(entries, entryLinks);
    expect(models[0].constraints).toEqual(model.constraints);
  });

  test('a pull recovers actions and constraints together', () => {
    const {entries, entryLinks} = generateCatalogResources(model, OPTS);
    const {models} = modelsFromCatalogResources(entries, entryLinks);
    expect(models[0].actions).toEqual(model.actions);
    expect(models[0].constraints).toEqual(model.constraints);
  });

  test('a second push of the pulled model produces the same entries', () => {
    // Push -> pull -> push has to be a fixed point: if it were not, a pull
    // followed by a push would rewrite entries that nobody edited.
    const first = generateCatalogResources(model, OPTS);
    const {models} = modelsFromCatalogResources(first.entries, first.entryLinks);
    const second = generateCatalogResources(models[0], OPTS);

    const constraintsOf = (entries: typeof first.entries) =>
        entries.filter(e => e.entryType.endsWith(CONSTRAINT_ENTRY_TYPE))
            .map(e => [e.name, e.aspects![CONSTRAINT_ASPECT].data])
            .sort();
    expect(constraintsOf(second.entries))
        .toEqual(constraintsOf(first.entries));
  });

  test('both routing words survive publish and pull', () => {
    // Without these the catalog states every rule the same way, and a credit a
    // supervisor may approve reads as one nobody can.
    const {entries} = generateCatalogResources(model, OPTS);
    const held = entries.find(
        e => e.entrySource?.displayName === 'OrderWithinStandingLimit')!;
    expect(held.aspects![CONSTRAINT_ASPECT].data!.onViolation)
        .toBe('escalate');
    expect(held.aspects![CONSTRAINT_ASPECT].data!.severity).toBe('high');

    const {models} = modelsFromCatalogResources(entries);
    const byName = new Map(models[0].constraints!.map(c => [c.name, c]));
    expect(byName.get('OrderWithinStandingLimit')!.onViolation)
        .toBe('escalate');
    expect(byName.get('OrderWithinStandingLimit')!.severity).toBe('high');
    // A constraint that states neither publishes without both fields and reads
    // back without them, so the defaults stay the IR's to define.
    expect(byName.get('PositiveQuantity')!.onViolation).toBeUndefined();
    expect(byName.get('PositiveQuantity')!.severity).toBeUndefined();
  });

  test('an unrecognized onViolation is dropped with a warning', () => {
    // A hand-edited aspect can say anything. Keeping the word would fail the
    // pulled model's own push-side validation; dropping it falls back to
    // `reject`, which refuses more than the catalog asked for and never less.
    const {entries} = generateCatalogResources(model, OPTS);
    const held = entries.find(
        e => e.entrySource?.displayName === 'OrderWithinStandingLimit')!;
    held.aspects![CONSTRAINT_ASPECT].data!.onViolation = 'maybe';

    const {models, warnings} = modelsFromCatalogResources(entries);
    const held2 = models[0].constraints!.find(
        c => c.name === 'OrderWithinStandingLimit')!;
    expect(held2.onViolation).toBeUndefined();
    // The two words are read separately, so one bad one does not cost the
    // reader the other.
    expect(held2.severity).toBe('high');
    expect(warnings.some(
               w => w.includes("constraint 'OrderWithinStandingLimit'") &&
                   w.includes("onViolation 'maybe'")))
        .toBe(true);
  });

  test('a non-string routing word is dropped rather than coerced', () => {
    // A hand-edited or programmatically written aspect can hold a list where a
    // word belongs. Coercing it would read `["escalate"]` back as `escalate`,
    // which invents a routing word the catalog never stated -- the one failure
    // mode worse than dropping it, because nothing would say it happened.
    const {entries} = generateCatalogResources(model, OPTS);
    const held = entries.find(
        e => e.entrySource?.displayName === 'OrderWithinStandingLimit')!;
    held.aspects![CONSTRAINT_ASPECT].data!.onViolation = ['escalate'];

    const {models, warnings} = modelsFromCatalogResources(entries);
    const held2 = models[0].constraints!.find(
        c => c.name === 'OrderWithinStandingLimit')!;
    expect(held2.onViolation).toBeUndefined();
    expect(warnings.some(
               w => w.includes("constraint 'OrderWithinStandingLimit'") &&
                   w.includes('onViolation ["escalate"]')))
        .toBe(true);
  });

  test('a whitespace-only routing word reads as unset, not as wrong', () => {
    // Blank is the aspect saying nothing, which is what an absent field says.
    // Warning about it would quote an empty word back at a reader who has no
    // typo to fix.
    const {entries} = generateCatalogResources(model, OPTS);
    const held = entries.find(
        e => e.entrySource?.displayName === 'OrderWithinStandingLimit')!;
    held.aspects![CONSTRAINT_ASPECT].data!.onViolation = '   ';

    const {models, warnings} = modelsFromCatalogResources(entries);
    const held2 = models[0].constraints!.find(
        c => c.name === 'OrderWithinStandingLimit')!;
    expect(held2.onViolation).toBeUndefined();
    expect(warnings.some(w => w.includes('onViolation'))).toBe(false);
  });

  test('an unrecognized severity is dropped with a warning', () => {
    // Severity ranks and reports rather than routes, so an unreadable one
    // leaves the rule unranked rather than changing what the engine does. That
    // is the cheaper of the two failures, and it is still said out loud.
    const {entries} = generateCatalogResources(model, OPTS);
    const held = entries.find(
        e => e.entrySource?.displayName === 'OrderWithinStandingLimit')!;
    held.aspects![CONSTRAINT_ASPECT].data!.severity = 'urgent';

    const {models, warnings} = modelsFromCatalogResources(entries);
    const held2 = models[0].constraints!.find(
        c => c.name === 'OrderWithinStandingLimit')!;
    expect(held2.severity).toBeUndefined();
    expect(held2.onViolation).toBe('escalate');
    expect(warnings.some(
               w => w.includes("constraint 'OrderWithinStandingLimit'") &&
                   w.includes("severity 'urgent'")))
        .toBe(true);
  });

  test('an entry whose expression is blank is skipped and warned', () => {
    // A hand-edited aspect can carry a blank expression. Such a constraint
    // states no invariant, so it degrades itself rather than the pull.
    const {entries} = generateCatalogResources(model, OPTS);
    const broken =
        entries.find(e => e.entrySource?.displayName === 'PositiveQuantity')!;
    broken.aspects![CONSTRAINT_ASPECT].data!.expression = '  ';
    const {models, warnings} = modelsFromCatalogResources(entries);
    expect(models[0].constraints!.map(c => c.name)).toEqual([
      'NonNegativeOrderTotal',
      'OrderWithinStandingLimit',
      'RequestedQuantityIsPositive',
      'LargeOrderIsJustified',
    ]);
    expect(warnings.some(
               w => w.includes('constraint \'PositiveQuantity\'') &&
                   w.includes('no expression and no judgment')))
        .toBe(true);
    // The actions, published under their own type, are unaffected.
    expect(models[0].actions).toHaveLength(1);
  });

  test('an entry stating both bodies is skipped and warned', () => {
    // The same reading as neither: a constraint that answers both ways states
    // no single rule, and pulling it would produce a model that fails its own
    // push-side validation.
    const {entries} = generateCatalogResources(model, OPTS);
    const broken =
        entries.find(e => e.entrySource?.displayName === 'PositiveQuantity')!;
    broken.aspects![CONSTRAINT_ASPECT].data!.judgment = 'Also be reasonable.';
    const {models, warnings} = modelsFromCatalogResources(entries);
    expect(models[0].constraints!.map(c => c.name))
        .not.toContain('PositiveQuantity');
    expect(warnings.some(
               w => w.includes('constraint \'PositiveQuantity\'') &&
                   w.includes('both an expression and a judgment')))
        .toBe(true);
  });
});


// A judged constraint is the second body: the rule stated in words, for rules
// no expression decides. It travels the same pipeline as an expression, so what
// follows checks the places the two diverge.
describe('judged constraints', () => {
  const judged: SemanticModel = {
    name: 'sales',
    entities: [{
      name: 'credit',
      dataSource: 'p.d.credit',
      keys: ['id'],
      fields: [{name: 'memo'}, {name: 'amount'}],
    }],
    relationships: [],
    metrics: [],
    constraints: [
      {
        name: 'MemoNamesAFailure',
        judgment:
            'The credit.memo must name a specific service failure rather ' +
            'than restating the amount.',
        description: 'Say which service failure the credit is for.',
        onViolation: 'escalate',
        severity: 'high',
      },
      {
        name: 'NonNegativeAmount',
        expression: 'credit.amount >= 0',
      },
    ],
  };
  const CONSTRAINT_ASPECT = 'dest.global.semantic-constraint';

  function aspectOf(m: SemanticModel, name: string) {
    return generateCatalogResources(m, OPTS)
        .entries.find(e => e.entrySource?.displayName === name)!
        .aspects![CONSTRAINT_ASPECT]
        .data!;
  }

  test(
      'the judgment rides the aspect and the description the entry source',
      () => {
        const {entries} = generateCatalogResources(judged, OPTS);
        const entry = entries.find(
            e => e.entrySource?.displayName === 'MemoNamesAFailure')!;
        expect(entry.aspects![CONSTRAINT_ASPECT].data).toEqual({
          judgment: 'The credit.memo must name a specific service failure ' +
              'rather than restating the amount.',
          evaluation: 'judged',
          onViolation: 'escalate',
          severity: 'high',
        });
        expect(entry.entrySource!.description)
            .toBe('Say which service failure the credit is for.');
      });

  test('evaluation is derived, so each body publishes its own word', () => {
    expect(aspectOf(judged, 'MemoNamesAFailure').evaluation).toBe('judged');
    expect(aspectOf(judged, 'NonNegativeAmount').evaluation)
        .toBe('deterministic');
  });

  test('a pull recovers the judgment and recomputes evaluation', () => {
    // `evaluation` is never read back: recomputing it from the body that
    // returned is the only reading that cannot go stale against it.
    const {entries, entryLinks} = generateCatalogResources(judged, OPTS);
    const {models, warnings} = modelsFromCatalogResources(entries, entryLinks);
    expect(models[0].constraints).toEqual(judged.constraints);
    expect(warnings.filter(w => w.includes('MemoNamesAFailure'))).toEqual([]);
  });

  test('push -> pull -> push is a fixed point', () => {
    const first = generateCatalogResources(judged, OPTS);
    const {models} =
        modelsFromCatalogResources(first.entries, first.entryLinks);
    const second = generateCatalogResources(models[0], OPTS);
    expect(second.entries).toEqual(first.entries);
  });

  test('the judgment survives serialize -> reload', () => {
    const {yaml} = serializeModel(judged);
    expect(yaml).toContain('judgment:');
    // Derived, so it has no place in an authored document.
    expect(yaml).not.toContain('evaluation:');
    expect(loadModels(yaml).models[0].constraints).toEqual(judged.constraints);
  });
});


// Knowledge Catalog is the only system an action or a constraint reaches, so a
// push to any other target deploys neither. Dropping them silently is the
// failure mode worth guarding: an author who declared a rule and sees a clean
// push has no way to learn it went nowhere.
describe('a graph leg says what it dropped', () => {
  const model = () => loadFixtureModel('actions_place_order.yaml');

  for (const [backend, generate] of [
           ['BigQuery', generatePropertyGraph],
           ['Spanner', generateSpannerPropertyGraph],
  ] as const) {
    test(`the ${backend} leg warns about actions and constraints`, () => {
      const {warnings} = generate(model());
      // The fixture declares one action and five constraints.
      expect(warnings.some(
                 w => /1 action\(s\) reach Knowledge Catalog only/.test(w)))
          .toBe(true);
      expect(warnings.some(
                 w => /5 constraint\(s\) reach Knowledge Catalog only/.test(w)))
          .toBe(true);
      // Named the system it does reach, and the one that drops it.
      expect(warnings.some(w => w.includes(`the ${backend} push deploys none`)))
          .toBe(true);
    });
  }

  test('a model with neither is quiet about both', () => {
    const {warnings} = generatePropertyGraph(
        loadFixtureModel('star_orders_customer.yaml'));
    expect(warnings.some(w => /reach Knowledge Catalog only/.test(w)))
        .toBe(false);
  });
});
