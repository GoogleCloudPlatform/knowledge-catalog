// Behavior specification for defined (virtual) entities (Entity.definition,
// src/libts/semantic/defined_entities.ts) across the toolchain: the loader,
// push validation, the BigQuery / Spanner graph legs (which lower a defined
// entity to a boolean membership property `is<Name>` on its base), OSI
// round-trip, the Knowledge Catalog push/pull trailers and availability
// pruning.
//
// The running example is the OWL defined class
//   WonOpportunity ≡ Opportunity ⊓ (salesStage = '5_won')
// authored as
//   - name: WonOpportunity
//     extends: [Opportunity]
//     defined: "salesStage = '5_won'"

import {describe, expect, test} from 'bun:test';

import {generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {lowerDefinedEntities, membershipPropertyName, resolveDefinedEntities, validateDefinedEntities} from '../../../src/libts/semantic/defined_entities';
import {Entity, SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources, splitDefinitionTrailer} from '../../../src/libts/semantic/kc_converter';
import {DEFINED_AS_PREFIX, generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {fromDocument, loadModels} from '../../../src/libts/semantic/loader';
import {serializeModel} from '../../../src/libts/semantic/osi_converter';
import {pruneUnavailable} from '../../../src/libts/semantic/resolve_profiles';
import {generateSpannerPropertyGraph} from '../../../src/libts/semantic/spanner';
import {referencedIdentifiers} from '../../../src/libts/semantic/sql_expr_utils';
import {validatePushRequirements} from '../../../src/libts/semantic/validate';

const GEN_OPTS = {project: 'sqlgen-testing', dataset: 'demo'};
const KC_OPTS = {project: 'dest-proj', location: 'us', entryGroup: 'eg'};

function defined(
    name: string, parent: string|string[], expression: string,
    extra: Partial<Entity> = {}): Entity {
  return {
    name,
    dataSource: '',
    keys: [],
    extends: Array.isArray(parent) ? parent : [parent],
    fields: [],
    definition: {expression},
    ...extra,
  };
}

// Opportunity (concrete) with Won / HighValue / MegaDeal (a defined entity
// refining another defined entity) over it, plus an Account the Opportunity
// points to.
function model(): SemanticModel {
  return {
    name: 'sales',
    entities: [
      {
        name: 'Opportunity',
        dataSource: 'sqlgen-testing.demo.opportunity',
        keys: ['id'],
        fields: [
          {name: 'id', type: 'String', expression: 'id'},
          {name: 'salesStage', type: 'String', expression: 'sales_stage'},
          {name: 'totalContractValue', type: 'Decimal', expression: 'tcv'},
          {name: 'accountId', type: 'String', expression: 'account_id'},
        ],
      },
      {
        name: 'Account',
        dataSource: 'sqlgen-testing.demo.account',
        keys: ['id'],
        fields: [{name: 'id', type: 'String', expression: 'id'}],
      },
      defined('WonOpportunity', 'Opportunity', `salesStage = '5_won'`, {
        description: 'A deal we won.',
      }),
      defined(
          'HighValueOpportunity', 'Opportunity', 'totalContractValue >= 1000'),
      defined(
          'MegaDeal', 'HighValueOpportunity',
          'MegaDeal.totalContractValue >= 20000'),
    ],
    relationships: [{
      name: 'forAccount',
      source: {entity: 'Opportunity', columns: ['accountId']},
      destination: {entity: 'Account', columns: ['id']},
    }],
    metrics: [],
  };
}

const errorsOf = (m: SemanticModel) =>
    validatePushRequirements([{document: 'doc.yaml', model: m} as any], {
      targetOptional: true,
    });

describe('loader', () => {
  const doc = (ds: any, version = '0.2.0.dev0/google') => ({
    version,
    semantic_model: [{
      name: 'm',
      datasets: [
        {name: 'Opportunity', source: 'p.d.opp', primary_key: ['id'], fields: []},
        {name: 'WonOpportunity', extends: ['Opportunity'], ...ds},
      ],
    }],
  });

  test('a bare-string definition loads as {expression}, with no source', () => {
    const {models, warnings} = fromDocument(doc({defined: `salesStage = '5_won'`}));
    const won = models[0].entities.find(e => e.name === 'WonOpportunity')!;
    expect(won.definition).toEqual({expression: `salesStage = '5_won'`});
    expect(won.dataSource).toBe('');
    expect(won.keys).toEqual([]);
    // A defined dataset has no key of its own by design: no key warning.
    expect(warnings.filter(w => w.includes('WonOpportunity'))).toEqual([]);
  });

  test('the object form carries a description', () => {
    const {models} = fromDocument(doc({
      defined: {expression: `salesStage = '5_won'`, description: 'Stage 5.'},
    }));
    const won = models[0].entities.find(e => e.name === 'WonOpportunity')!;
    expect(won.definition)
        .toEqual({expression: `salesStage = '5_won'`, description: 'Stage 5.'});
  });

  test('a defined dataset with a source is a hard error', () => {
    expect(() => fromDocument(doc({defined: 'x = 1', source: 'p.d.t'})))
        .toThrow(/a defined dataset is a/);
  });

  test('a defined dataset with a primary_key is a hard error', () => {
    expect(() => fromDocument(doc({defined: 'x = 1', primary_key: ['id']})))
        .toThrow(/a defined dataset is a/);
  });

  test('abstract: true on a defined dataset is warned and dropped', () => {
    const {models, warnings} =
        fromDocument(doc({defined: `salesStage = '5_won'`, abstract: true}));
    const won = models[0].entities.find(e => e.name === 'WonOpportunity')!;
    expect(won.abstract).toBeFalsy();
    expect(warnings.some(w => /'abstract: true' is ignored on a defined/.test(w)))
        .toBe(true);
  });
});

describe('resolution', () => {
  test('membership is the chain of definitions, outermost first', () => {
    const {infos, problems} = resolveDefinedEntities(model());
    expect(problems.size).toBe(0);
    expect(infos.get('WonOpportunity')).toMatchObject({
      parent: 'Opportunity',
      base: 'Opportunity',
      membership: `salesStage = '5_won'`,
    });
    expect(infos.get('MegaDeal')).toMatchObject({
      parent: 'HighValueOpportunity',
      base: 'Opportunity',
      chain: ['MegaDeal', 'HighValueOpportunity'],
      // The MegaDeal. qualifier is stripped.
      membership: '(totalContractValue >= 1000) AND (totalContractValue >= 20000)',
    });
  });

  test('membershipPropertyName capitalizes', () => {
    expect(membershipPropertyName('WonOpportunity')).toBe('isWonOpportunity');
    expect(membershipPropertyName('won')).toBe('isWon');
  });
});

describe('validation', () => {
  test('a well-formed model has no errors', () => {
    expect(errorsOf(model())).toEqual([]);
  });

  const withEntity = (e: Entity) => {
    const m = model();
    m.entities.push(e);
    return m;
  };

  test('no parent', () => {
    const m = withEntity(defined('Orphan', [], 'salesStage = 1'));
    expect(validateDefinedEntities(m).join('\n'))
        .toMatch(/defined entity 'Orphan'.*exactly one parent.*none/);
  });

  test('several parents', () => {
    const m = withEntity(
        defined('Both', ['Opportunity', 'Account'], 'salesStage = 1'));
    expect(validateDefinedEntities(m).join('\n'))
        .toMatch(/'Both'.*but it extends 'Opportunity', 'Account'/);
  });

  test('unknown parent (also reported through validatePushRequirements)', () => {
    const m = withEntity(defined('Ghostly', 'Ghost', 'salesStage = 1'));
    expect(validateDefinedEntities(m).join('\n'))
        .toMatch(/'Ghostly': its parent 'Ghost' is not an entity/);
    expect(errorsOf(m).join('\n')).toMatch(/model 'sales' \(doc\.yaml\).*Ghost/);
  });

  test('a parent chain cycle', () => {
    const m = model();
    m.entities.push(defined('A', 'B', 'salesStage = 1'));
    m.entities.push(defined('B', 'A', 'salesStage = 2'));
    expect(validateDefinedEntities(m).join('\n')).toMatch(/loops back/);
  });

  test('a definition reading an unknown field (with a case hint)', () => {
    const m = withEntity(defined('Bad', 'Opportunity', `salesstage = 'x' AND foo > 1`));
    const errs = validateDefinedEntities(m).join('\n');
    expect(errs).toMatch(/'salesstage' \(did you mean 'salesStage'\?\)/);
    expect(errs).toMatch(/'foo'/);
    expect(errs).toMatch(/are not fields of 'Opportunity'/);
  });

  test('keywords, functions, types and literals are not field references', () => {
    const m = withEntity(defined(
        'Fancy', 'Opportunity',
        `UPPER(salesStage) IN ('A', "B") AND CAST(totalContractValue AS INT64) ` +
            `BETWEEN 1 AND 2e3 AND REGEXP_CONTAINS(id, r'^x') IS NOT NULL`));
    expect(validateDefinedEntities(m)).toEqual([]);
  });

  test('the unknown-field check stands down when fields were pruned', () => {
    const m = withEntity(defined('Bad', 'Opportunity', 'foo > 1'));
    expect(validateDefinedEntities(m, {fieldsPruned: true})).toEqual([]);
  });

  test('a definition may not reach another entity', () => {
    const m = withEntity(defined('X', 'Opportunity', 'Account.id = 1'));
    expect(validateDefinedEntities(m).join('\n'))
        .toMatch(/references 'Account', which is not on its parent chain/);
  });

  test('a source, keys or fields on a defined entity', () => {
    const m = withEntity(defined('Won2', 'Opportunity', 'salesStage = 1', {
      dataSource: 'p.d.t',
      keys: ['id'],
      fields: [{name: 'extra'}],
    }));
    const errs = validateDefinedEntities(m).join('\n');
    expect(errs).toMatch(/'Won2' has a source/);
    expect(errs).toMatch(/'Won2' declares keys/);
    expect(errs).toMatch(/'Won2' declares fields \(extra\)/);
  });

  test('a concrete entity extending a defined entity', () => {
    const m = model();
    m.entities.push({
      name: 'WonSub',
      dataSource: 'p.d.won',
      keys: ['id'],
      extends: ['WonOpportunity'],
      fields: [{name: 'id', expression: 'id'}],
    });
    expect(validateDefinedEntities(m).join('\n'))
        .toMatch(/entity 'WonSub' extends defined entity 'WonOpportunity'.*extend 'Opportunity'/);
  });

  test('the membership property colliding with a base field', () => {
    const m = model();
    m.entities[0].fields.push(
        {name: 'isWonOpportunity', type: 'Boolean', expression: 'won'});
    expect(validateDefinedEntities(m).join('\n'))
        .toMatch(/collides with field 'Opportunity.isWonOpportunity'/);
  });

  test('two defined entities lowering to the same property', () => {
    const m = withEntity(defined('wonOpportunity', 'Opportunity', 'salesStage = 1'));
    expect(validateDefinedEntities(m).join('\n'))
        .toMatch(/both lower to the membership property/);
  });
});

describe('BigQuery lowering', () => {
  test('a defined entity becomes a boolean property on its base', () => {
    const {ddl} = generatePropertyGraph(model(), GEN_OPTS);
    expect(ddl).toContain(
        `COALESCE(sales_stage = '5_won', FALSE) AS isWonOpportunity`);
    expect(ddl).toContain(`COALESCE(tcv >= 1000, FALSE) AS isHighValueOpportunity`);
    // A chain is the conjunction of its definitions.
    expect(ddl).toContain(
        'COALESCE((tcv >= 1000) AND (tcv >= 20000), FALSE) AS isMegaDeal');
    // No node table, no label, for a defined entity.
    expect(ddl).not.toMatch(/AS WonOpportunity\b/);
    expect(ddl).not.toMatch(/LABEL WonOpportunity\b/);
    expect(ddl).toContain('AS Opportunity');
  });

  test('a model without defined entities is untouched (same object)', () => {
    const m = model();
    m.entities = m.entities.filter(e => !e.definition);
    expect(lowerDefinedEntities(m, [])).toBe(m);
  });

  test('lowering never mutates its input', () => {
    const m = model();
    const before = structuredClone(m);
    lowerDefinedEntities(m, []);
    expect(m).toEqual(before);
  });

  test('the property describes the class and its membership', () => {
    const lowered = lowerDefinedEntities(model(), []);
    const f = lowered.entities.find(e => e.name === 'Opportunity')!.fields.find(
        f => f.name === 'isWonOpportunity')!;
    expect(f.type).toBe('Boolean');
    expect(f.description).toBe(
        `A deal we won. True when this Opportunity is a WonOpportunity: ` +
        `salesStage = '5_won'.`);
  });

  test('relationship endpoints and metrics on a defined entity', () => {
    const m = model();
    m.relationships.push({
      name: 'wonFor',
      source: {entity: 'WonOpportunity', columns: ['accountId']},
      destination: {entity: 'Account', columns: ['id']},
    });
    m.metrics.push(
        {name: 'wonCount', entity: 'WonOpportunity', expression: 'COUNT(*)'} as any);
    const warnings: string[] = [];
    const lowered = lowerDefinedEntities(m, warnings);
    expect(lowered.relationships.find(r => r.name === 'wonFor')!.source.entity)
        .toBe('Opportunity');
    expect(lowered.metrics.find(r => r.name === 'wonCount')).toBeUndefined();
    expect(warnings.some(w => /relationship 'wonFor'.*connects its base/.test(w)))
        .toBe(true);
    expect(warnings.some(w => /metric 'wonCount' is skipped/.test(w))).toBe(true);
  });

  test('an abstract base: each concrete descendant binds the property', () => {
    const m: SemanticModel = {
      name: 'party',
      entities: [
        {
          name: 'Party',
          dataSource: '',
          keys: [],
          abstract: true,
          fields: [{name: 'id'}, {name: 'tier'}],
        },
        {
          name: 'Person',
          dataSource: 'sqlgen-testing.demo.person',
          keys: ['id'],
          extends: ['Party'],
          fields: [
            {name: 'id', expression: 'p_id'},
            {name: 'tier', expression: 'p_tier'},
          ],
        },
        {
          name: 'Organization',
          dataSource: 'sqlgen-testing.demo.org',
          keys: ['id'],
          extends: ['Party'],
          fields: [{name: 'id', expression: 'o_id'}],
        },
        defined('VipParty', 'Party', `tier = 'vip'`),
      ],
      relationships: [],
      metrics: [],
    };
    const {ddl, warnings} = generatePropertyGraph(m, GEN_OPTS);
    expect(ddl).toContain(`COALESCE(p_tier = 'vip', FALSE) AS isVipParty`);
    expect(ddl).toContain('CAST(NULL AS BOOL) AS isVipParty');
    expect(warnings.some(
               w => /'Organization' does not bind 'tier'.*isVipParty' is NULL/.test(w)))
        .toBe(true);
  });

  test('an unbound referenced field skips the property with a warning', () => {
    const m = model();
    m.entities[0].fields = m.entities[0].fields.filter(f => f.name !== 'salesStage');
    const warnings: string[] = [];
    const lowered = lowerDefinedEntities(m, warnings);
    expect(lowered.entities[0].fields.map(f => f.name))
        .not.toContain('isWonOpportunity');
    expect(warnings.some(w => /'WonOpportunity' is skipped.*'salesStage'/.test(w)))
        .toBe(true);
  });
});

describe('Spanner lowering', () => {
  test('the same membership property on the Spanner leg', () => {
    const {ddl} = generateSpannerPropertyGraph(model(), {graphName: 'g'} as any);
    expect(ddl).toContain(
        `COALESCE(sales_stage = '5_won', FALSE) AS isWonOpportunity`);
    expect(ddl).not.toMatch(/AS WonOpportunity\b/);
  });
});

describe('OSI round-trip', () => {
  test('defined survives serialize -> load', () => {
    const m = model();
    m.entities.find(e => e.name === 'WonOpportunity')!.definition!.description =
        'Stage 5.';
    const {yaml} = serializeModel(m);
    expect(yaml).toContain('defined:');
    const {models} = loadModels(yaml);
    const byName = new Map(models[0].entities.map(e => [e.name, e]));
    expect(byName.get('WonOpportunity')!.definition).toEqual({
      expression: `salesStage = '5_won'`,
      description: 'Stage 5.',
    });
    expect(byName.get('WonOpportunity')!.extends).toEqual(['Opportunity']);
    expect(byName.get('MegaDeal')!.definition)
        .toEqual({expression: 'MegaDeal.totalContractValue >= 20000'});
  });
});

describe('Knowledge Catalog push / pull', () => {
  const entryOf = (entries: any[], name: string) =>
      entries.find(e => e.entrySource?.displayName === name);

  function pushed() {
    const m = model();
    m.entities.find(e => e.name === 'WonOpportunity')!.definition!.description =
        'Stage 5\nof the funnel.';
    return {m, ...generateCatalogResources(m, KC_OPTS)};
  }

  test('push records the definition as a description trailer', () => {
    const {entries, warnings} = pushed();
    const won = entryOf(entries, 'WonOpportunity');
    const desc: string = won.entrySource.description;
    expect(desc).toContain(`${DEFINED_AS_PREFIX}salesStage = '5_won'`);
    expect(desc).toContain('Definition note: Stage 5 of the funnel.');
    expect(desc.startsWith('A deal we won.')).toBe(true);
    expect(warnings.filter(w => w.includes('WonOpportunity'))).toEqual([]);
  });

  test('pull restores definition and extends, and push is a fixed point', () => {
    const {entries, entryLinks} = pushed();
    const {models} = modelsFromCatalogResources(entries, entryLinks);
    const byName = new Map(models[0].entities.map(e => [e.name, e]));
    const won = byName.get('WonOpportunity')!;
    expect(won.definition).toEqual({
      expression: `salesStage = '5_won'`,
      description: 'Stage 5 of the funnel.',
    });
    expect(won.extends).toEqual(['Opportunity']);
    expect(won.description).toBe('A deal we won.');
    expect(byName.get('MegaDeal')!.definition)
        .toEqual({expression: 'MegaDeal.totalContractValue >= 20000'});
    expect(byName.get('Opportunity')!.definition).toBeUndefined();

    const again = generateCatalogResources(models[0], KC_OPTS);
    expect(entryOf(again.entries, 'WonOpportunity').entrySource.description)
        .toBe(entryOf(entries, 'WonOpportunity').entrySource.description);
  });

  test('splitDefinitionTrailer leaves other descriptions alone', () => {
    expect(splitDefinitionTrailer('Plain text.')).toEqual({rest: 'Plain text.'});
  });
});

describe('availability pruning', () => {
  test('a defined entity falls with its unavailable parent, transitively', () => {
    const m = model();
    // Unbind Opportunity's key: the whole entity is unavailable.
    m.entities[0].fields[0] = {name: 'id', type: 'String'};
    const {model: pruned, report} = pruneUnavailable(m, 'p');
    const names = pruned.entities.map(e => e.name);
    expect(names).not.toContain('WonOpportunity');
    expect(names).not.toContain('MegaDeal');
    expect(report.droppedEntities).toContainEqual({
      name: 'MegaDeal',
      reason: 'parent entity HighValueOpportunity is unavailable',
    });
  });
});

describe('referencedIdentifiers', () => {
  test('skips literals, function names and members', () => {
    expect(referencedIdentifiers(
               `LOWER(a) = 'b c' AND t.d > 1e5 AND r'x' <> e AND \`f g\` IS NULL`))
        .toEqual(['a', 'AND', 't', 'e', 'f g', 'IS', 'NULL']);
  });
});
