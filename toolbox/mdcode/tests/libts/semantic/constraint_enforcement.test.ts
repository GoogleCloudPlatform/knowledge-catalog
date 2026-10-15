// Behavior specification for consumption-time constraint enforcement
// (src/libts/semantic/constraint_enforcement.ts): which rules an entity's node
// view applies and how (withhold, exclude, flag, report), the enforcing view
// SQL, the `_warnings` column and the spelling repair, the opt-in hydration
// rule, the catalog `Constraints:` paragraph and its pull round trip, and
// `kcmd bind --enforce-constraints`.
//
// Running example: deal pricing proposals for opportunities. A proposal's
// floor price may not exceed its target price (a reject rule: the floor price
// is withheld when it does), its id is required and patterned (reject rules on
// the key: the row is excluded), its pricing construct is one of a closed set
// (a warn rule, with spelling repair), and a lost opportunity has no won
// amount (a warn rule on a defined entity).

import {describe, expect, test} from 'bun:test';

import {enforceableEntities} from '../../../src/libts/semantic/bind/run';
import {constraintsTrailer, planEnforcement, repairSql, spellingKey, splitConstraintsTrailer} from '../../../src/libts/semantic/constraint_enforcement';
import {checkHydration, hydrationClauses, hydrationDocErrors} from '../../../src/libts/semantic/hydration';
import {splitHydrationTrailer} from '../../../src/libts/semantic/hydration_kc';
import {Constraint, Entity, SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {lowerNodeViews} from '../../../src/libts/semantic/node_views';
import {resolveInheritance} from '../../../src/libts/semantic/resolve_inheritance';

const TARGET = {project: 'p', dataset: 'sem'};
const KC_OPTS = {project: 'dest-proj', location: 'us', entryGroup: 'eg'};

function shacl(
    name: string, shape: string, terms: string, onViolation: Constraint['onViolation'],
    judgment = `${name} holds.`): Constraint {
  return {
    name,
    judgment,
    description: `A rule. (From SHACL: ${shape}, ${terms}.)`,
    onViolation,
  };
}

function opportunity(): Entity {
  return {
    name: 'Opportunity',
    dataSource: 'p.crm.opportunity',
    keys: ['opportunityId'],
    fields: [
      {name: 'opportunityId', type: 'String', expression: 'opportunity_id'},
      {name: 'salesStage', type: 'String', expression: 'sales_stage'},
      {name: 'wonAmount', type: 'Decimal', expression: 'won_amount'},
    ],
    hydration: {grain: {deterministic: true}, constraints: 'enforce'},
  };
}

function lostOpportunity(): Entity {
  return {
    name: 'LostOpportunity',
    dataSource: '',
    keys: [],
    fields: [],
    extends: ['Opportunity'],
    definition: {expression: `salesStage = 'closed_lost'`},
  };
}

function dealPricing(): Entity {
  return {
    name: 'DealPricing',
    dataSource: 'p.crm.deal_pricing',
    keys: ['pricingId'],
    description: 'A priced proposal.',
    fields: [
      {name: 'pricingId', type: 'String', expression: 'pricing_id'},
      {name: 'opportunityId', type: 'String', expression: 'opportunity_id'},
      {name: 'floorPrice', type: 'Decimal', expression: 'floor_price'},
      {name: 'targetPrice', type: 'Decimal', expression: 'target_price'},
      {name: 'pricingConstruct', type: 'String', expression: 'pricing_construct'},
      {name: 'discountPct', type: 'Decimal', expression: 'discount_pct'},
      {name: 'approver', type: 'String'},
    ],
    hydration: {constraints: 'enforce'},
  };
}

function constraints(): Constraint[] {
  return [
    shacl('DealPricing_pricingId_required', 'DealPricingShape', 'pricingId sh:minCount 1', 'reject'),
    shacl('DealPricing_pricingId_pattern', 'DealPricingShape', `pricingId sh:pattern '^DP-[0-9]+$'`, 'reject'),
    shacl('DealPricing_floorPrice_lte_targetPrice', 'DealPricingShape',
          'floorPrice sh:lessThanOrEquals targetPrice', 'reject'),
    shacl('DealPricing_pricingConstruct_in', 'DealPricingShape',
          'pricingConstruct sh:in (Time and Materials Fixed Price)', 'warn',
          `DealPricing.pricingConstruct is one of 'Time and Materials' or 'Fixed Price'.`),
    shacl('DealPricing_discountPct_range', 'DealPricingShape',
          'discountPct sh:minInclusive 0 sh:maxInclusive 1', 'reject'),
    shacl('DealPricing_approver_required', 'DealPricingShape', 'approver sh:minCount 1', 'warn'),
    shacl('LostOpportunity_wonAmount_empty', 'LostOpportunityShape', 'wonAmount sh:maxCount 0', 'warn'),
    {
      name: 'DealPricing_prices_functional',
      judgment: 'A proposal prices one opportunity.',
      description: 'One opportunity. (From OWL: prices is a FunctionalProperty.)',
      onViolation: 'warn',
    },
  ];
}

function model(): SemanticModel {
  return {
    name: 'sales',
    entities: [opportunity(), lostOpportunity(), dealPricing()],
    relationships: [{
      name: 'prices',
      source: {entity: 'DealPricing', columns: ['opportunityId']},
      destination: {entity: 'Opportunity', columns: ['opportunityId']},
    }],
    metrics: [],
    constraints: constraints(),
    customExtensions: [{
      vendorName: 'GOOGLE',
      data: JSON.stringify({
        deploymentTargets:
            ['//bigquery.googleapis.com/projects/p/datasets/sem/propertyGraphs/g'],
      }),
    }],
  };
}

const resolvedOf = (m: SemanticModel, name: string) =>
    resolveInheritance(m).model.entities.find(e => e.name === name)!;
const boundOn = (m: SemanticModel, name: string) => (f: string) =>
    !!resolvedOf(m, name).fields.find(x => x.name === f)?.expression;

describe('which rules a node view applies, and how', () => {
  test('reject rules withhold a value, or exclude the row for a required field or the key; the rest flag', () => {
    const m = model();
    const plan = planEnforcement(m, resolvedOf(m, 'DealPricing'), boundOn(m, 'DealPricing'));
    expect(plan.rules.map(r => [r.constraint, r.effect])).toEqual([
      ['DealPricing_pricingId_required', 'exclude'],
      ['DealPricing_pricingId_pattern', 'exclude'],
      ['DealPricing_floorPrice_lte_targetPrice', 'withhold'],
      ['DealPricing_pricingConstruct_in', 'flag'],
      ['DealPricing_discountPct_range', 'withhold'],
      ['DealPricing_prices_functional', 'report'],
    ]);
    expect(plan.repairs).toEqual(
        [{field: 'pricingConstruct', members: ['Time and Materials', 'Fixed Price']}]);
    expect(plan.skipped).toEqual([{
      constraint: 'DealPricing_approver_required',
      reason: `'approver' is not bound on 'DealPricing'`,
    }]);
  });

  test('a defined entity\'s rule applies to its base, gated by the membership', () => {
    const m = model();
    const plan = planEnforcement(m, resolvedOf(m, 'Opportunity'), boundOn(m, 'Opportunity'));
    expect(plan.rules.map(r => [r.constraint, r.effect, r.gate?.membership])).toEqual([
      ['LostOpportunity_wonAmount_empty', 'flag', `salesStage = 'closed_lost'`],
    ]);
  });

  test('escalate and an unstated word flag the row: a read has no approver', () => {
    const m = model();
    m.constraints = [
      {...shacl('DealPricing_discountPct_range', 'DealPricingShape',
                'discountPct sh:minInclusive 0 sh:maxInclusive 1', 'escalate')},
      {...shacl('DealPricing_floorPrice_lte_targetPrice', 'DealPricingShape',
                'floorPrice sh:lessThanOrEquals targetPrice', undefined)},
    ];
    const plan = planEnforcement(m, resolvedOf(m, 'DealPricing'), boundOn(m, 'DealPricing'));
    expect(plan.rules.map(r => r.effect)).toEqual(['flag', 'flag']);
  });

  test('a rule on a supertype applies to the subtype\'s rows', () => {
    const m = model();
    m.entities.push({
      name: 'CommercialDocument',
      dataSource: '',
      abstract: true,
      keys: [],
      fields: [{name: 'discountPct', type: 'Decimal'}],
    });
    m.entities.find(e => e.name === 'DealPricing')!.extends = ['CommercialDocument'];
    m.constraints = [shacl('CommercialDocument_discountPct_range', 'CommercialDocumentShape',
                           'discountPct sh:minInclusive 0 sh:maxInclusive 1', 'reject')];
    const plan = planEnforcement(m, resolvedOf(m, 'DealPricing'), boundOn(m, 'DealPricing'));
    expect(plan.rules.map(r => [r.constraint, r.effect])).toEqual([
      ['CommercialDocument_discountPct_range', 'withhold'],
    ]);
  });
});

describe('spelling repair', () => {
  test('a value equal to a member up to case and whitespace takes the member\'s spelling', () => {
    expect(spellingKey(' Time and\tMaterials ')).toBe('timeandmaterials');
    expect(repairSql('t.c', ['Time and Materials', 'Fixed Price'])).toBe(
        `CASE LOWER(REGEXP_REPLACE(CAST(t.c AS STRING), r'\\s', '')) ` +
        `WHEN 'timeandmaterials' THEN 'Time and Materials' ` +
        `WHEN 'fixedprice' THEN 'Fixed Price' ELSE t.c END`);
  });

  test('a spelling two members share is left as recorded', () => {
    expect(repairSql('t.c', ['Fixed Price', 'FIXED PRICE', 'Gainshare'])).toBe(
        `CASE LOWER(REGEXP_REPLACE(CAST(t.c AS STRING), r'\\s', '')) ` +
        `WHEN 'gainshare' THEN 'Gainshare' ELSE t.c END`);
    expect(repairSql('t.c', ['A', 'a'])).toBe('t.c');
  });
});

describe('the enforcing node view', () => {
  const lowered = () => {
    const warnings: string[] = [];
    return {...lowerNodeViews(model(), TARGET, warnings), warnings};
  };
  const ddlOf = (name: string) => lowered().views.find(v => v.name === name)!.ddl;

  test('hydrated, checked, then served: withheld values, excluded rows, _warnings', () => {
    expect(ddlOf('deal_pricing')).toBe([
      'CREATE OR REPLACE VIEW `p.sem.deal_pricing`',
      `OPTIONS (description = 'A priced proposal. Key: pricing_id. Hydration: ` +
          `constraints enforced. Constraints: enforced in the node view after ` +
          `hydration; each rule a served row breaks is named in its _warnings ` +
          `column. Rows excluded: DealPricing_pricingId_required, ` +
          `DealPricing_pricingId_pattern. Values withheld (served as NULL): ` +
          `floorPrice by DealPricing_floorPrice_lte_targetPrice, discountPct by ` +
          `DealPricing_discountPct_range. Flagged only: ` +
          `DealPricing_pricingConstruct_in. Spelling normalized to the allowed ` +
          `members: pricingConstruct. Reported, not applied: ` +
          `DealPricing_prices_functional. Source: crm.deal_pricing. Generated ` +
          `by kcmd from the semantic model; do not edit.') AS`,
      'WITH hydrated AS (',
      '  SELECT',
      '    t.pricing_id,',
      '    t.opportunity_id,',
      '    t.floor_price,',
      '    t.target_price,',
      `    CASE LOWER(REGEXP_REPLACE(CAST(t.pricing_construct AS STRING), r'\\s', '')) ` +
          `WHEN 'timeandmaterials' THEN 'Time and Materials' WHEN 'fixedprice' ` +
          `THEN 'Fixed Price' ELSE t.pricing_construct END AS pricing_construct,`,
      '    t.discount_pct',
      '  FROM `p.crm.deal_pricing` AS t',
      '),',
      'checked AS (',
      '  SELECT',
      '    h.*,',
      `    COALESCE(h.pricing_id IS NULL OR TRIM(CAST(h.pricing_id AS STRING)) = '', FALSE) AS _kcmd_c0,`,
      `    COALESCE(h.pricing_id IS NOT NULL AND NOT REGEXP_CONTAINS(CAST(h.pricing_id AS STRING), '^DP-[0-9]+$'), FALSE) AS _kcmd_c1,`,
      '    COALESCE(h.floor_price IS NOT NULL AND h.target_price IS NOT NULL AND h.floor_price > h.target_price, FALSE) AS _kcmd_c2,',
      `    COALESCE(h.pricing_construct IS NOT NULL AND CAST(h.pricing_construct AS STRING) NOT IN ('Time and Materials', 'Fixed Price'), FALSE) AS _kcmd_c3,`,
      `    COALESCE(h.discount_pct IS NOT NULL AND (SAFE_CAST(CAST(h.discount_pct AS STRING) AS BIGNUMERIC) < CAST('0' AS BIGNUMERIC) OR SAFE_CAST(CAST(h.discount_pct AS STRING) AS BIGNUMERIC) > CAST('1' AS BIGNUMERIC)), FALSE) AS _kcmd_c4`,
      '  FROM hydrated AS h',
      ')',
      'SELECT',
      '  c.pricing_id,',
      '  c.opportunity_id,',
      '  IF(c._kcmd_c2, NULL, c.floor_price) AS floor_price,',
      '  c.target_price,',
      '  c.pricing_construct,',
      '  IF(c._kcmd_c4, NULL, c.discount_pct) AS discount_pct,',
      '  ARRAY(SELECT w.rule FROM UNNEST([',
      `      STRUCT(c._kcmd_c2 AS broken, 'DealPricing_floorPrice_lte_targetPrice' AS rule),`,
      `      STRUCT(c._kcmd_c3, 'DealPricing_pricingConstruct_in'),`,
      `      STRUCT(c._kcmd_c4, 'DealPricing_discountPct_range')`,
      '    ]) AS w WITH OFFSET AS o WHERE w.broken ORDER BY o) AS _warnings',
      'FROM checked AS c',
      'WHERE NOT (c._kcmd_c0 OR c._kcmd_c1)',
    ].join('\n'));
  });

  test('a defined entity\'s rule is gated by its membership over the hydrated columns', () => {
    const ddl = ddlOf('opportunity');
    expect(ddl).toContain(
        `    COALESCE(((h.sales_stage) = 'closed_lost') AND (h.won_amount IS NOT NULL), FALSE) AS _kcmd_c0`);
    expect(ddl).toContain(
        `  ARRAY(SELECT w.rule FROM UNNEST([\n` +
        `      STRUCT(c._kcmd_c0 AS broken, 'LostOpportunity_wonAmount_empty' AS rule)\n` +
        `    ]) AS w WITH OFFSET AS o WHERE w.broken ORDER BY o) AS _warnings`);
    expect(ddl).not.toContain('WHERE NOT');
    // The grain still realizes the key inside the hydrated step.
    expect(ddl).toContain('  QUALIFY ROW_NUMBER() OVER (PARTITION BY t.opportunity_id ' +
                          'ORDER BY FARM_FINGERPRINT(TO_JSON_STRING(t))) = 1\n),');
  });

  test('the rates query counts each rule over the same checked rows', () => {
    const e = lowered().enforcement.get('DealPricing')!;
    expect(e.ratesSql!.split('\n').slice(-8)).toEqual([
      'SELECT',
      '  COUNT(*) AS total,',
      '  COUNTIF(_kcmd_c0) AS _kcmd_c0,',
      '  COUNTIF(_kcmd_c1) AS _kcmd_c1,',
      '  COUNTIF(_kcmd_c2) AS _kcmd_c2,',
      '  COUNTIF(_kcmd_c3) AS _kcmd_c3,',
      '  COUNTIF(_kcmd_c4) AS _kcmd_c4',
      'FROM checked',
    ]);
  });

  test('the plan line names the switch; an unbound rule is a warning', () => {
    const {plan, warnings} = lowered();
    expect(plan).toContain(
        'node view p.sem.deal_pricing (DealPricing): constraints enforced');
    expect(warnings).toEqual([
      `entity 'DealPricing': constraint 'DealPricing_approver_required' is not ` +
          `enforced in its node view: 'approver' is not bound on 'DealPricing'`,
    ]);
  });

  test('without the switch the view serves the rows as hydrated', () => {
    const m = model();
    for (const e of m.entities) {
      if (e.hydration) delete e.hydration.constraints;
    }
    const out = lowerNodeViews(m, TARGET, []);
    const ddl = out.views.find(v => v.name === 'deal_pricing')!.ddl;
    expect(ddl).not.toContain('_warnings');
    expect(ddl).not.toContain('WITH hydrated');
    expect(out.enforcement.size).toBe(0);
  });

  test('the graph reads the served columns, not _warnings', () => {
    const out = lowerNodeViews(model(), TARGET, []);
    const e = out.model.entities.find(x => x.name === 'DealPricing')!;
    expect(e.dataSource).toBe('p.sem.deal_pricing');
    expect(e.fields.map(f => f.expression)).not.toContain('_warnings');
  });
});

describe('the hydration rule', () => {
  test('constraints: enforce is the one value', () => {
    expect(hydrationDocErrors({constraints: 'enforce'})).toEqual([]);
    expect(hydrationDocErrors({constraints: 'report'})[0])
        .toContain(`'hydration.constraints' must be 'enforce'`);
  });

  test('it needs a node view: mode direct and derive_from refuse it', () => {
    const m = model();
    m.entities.find(e => e.name === 'DealPricing')!.mode = 'direct';
    expect(checkHydration(m).errors.join('\n'))
        .toContain(`hydration constraints has no node view to apply in`);
    expect(hydrationDocErrors({derive_from: {relationship: 'r'}, constraints: 'enforce'})
               .some(e => /derive_from' stands alone/.test(e)))
        .toBe(true);
  });

  test('its clause is fixed and parsed back', () => {
    expect(hydrationClauses(dealPricing())).toEqual(['constraints enforced']);
    expect(splitHydrationTrailer('Text.\n\nHydration: one row per pricing_id ' +
                                 '(deterministic pick); constraints enforced.'))
        .toEqual({
          rest: 'Text.',
          hydration: {grain: {deterministic: true}, constraints: 'enforce'},
        });
  });
});

describe('the catalog paragraph', () => {
  const RATES = new Map([
    ['DealPricing', new Map([
      ['DealPricing_pricingId_required', {violations: 0, total: 60700}],
      ['DealPricing_pricingId_pattern', {violations: 0, total: 60700}],
      ['DealPricing_floorPrice_lte_targetPrice', {violations: 30431, total: 60700}],
      ['DealPricing_pricingConstruct_in', {violations: 12, total: 60700}],
      ['DealPricing_discountPct_range', {violations: 0, total: 60700}],
      ['DealPricing_prices_functional', {violations: 0, total: 64300}],
    ])],
  ]);
  const entryOf = (rates?: typeof RATES) => generateCatalogResources(model(), {
    ...KC_OPTS,
    bigQueryEntries: {datasetLocations: new Map([['p.sem', 'us']])},
    ...(rates ? {constraintRates: new Map([['sales', rates]])} : {}),
  }).entries.find(e => e.name.endsWith('.entities.DealPricing'))!;

  test('the rules and their rates, between Relationships and Hydration', () => {
    const text = entryOf(RATES).entrySource!.description!;
    const paragraphs = text.split('\n\n');
    expect(paragraphs.map(p => p.split(':')[0])).toEqual(
        ['A priced proposal.', 'Read through', 'Relationships', 'Constraints', 'Hydration']);
    expect(paragraphs[3]).toBe(
        'Constraints: enforced in the node view after hydration; each rule a ' +
        'served row breaks is named in its _warnings column. Rows excluded: ' +
        'DealPricing_pricingId_required (none), DealPricing_pricingId_pattern ' +
        '(none). Values withheld (served as NULL): floorPrice by ' +
        'DealPricing_floorPrice_lte_targetPrice (50.1%), discountPct by ' +
        'DealPricing_discountPct_range (none). Flagged only: ' +
        'DealPricing_pricingConstruct_in (<0.1%). Spelling normalized to the ' +
        'allowed members: pricingConstruct. Reported, not applied: ' +
        'DealPricing_prices_functional (none). Rates are over the 60,700 ' +
        'hydrated rows.');
  });

  test('without rates the rules are named alone', () => {
    const text = entryOf().entrySource!.description!;
    expect(text).toContain('Values withheld (served as NULL): floorPrice by ' +
                           'DealPricing_floorPrice_lte_targetPrice, discountPct');
    expect(text).not.toContain('Rates are over');
  });

  test('a tight budget folds the rules no row breaks into a count', () => {
    const m = model();
    const plan = planEnforcement(m, resolvedOf(m, 'DealPricing'), boundOn(m, 'DealPricing'));
    const full = constraintsTrailer(plan, RATES.get('DealPricing'), 2000)!;
    const folded = constraintsTrailer(plan, RATES.get('DealPricing'), full.length - 1)!;
    expect(folded).toBe(
        'Constraints: enforced in the node view after hydration; each rule a ' +
        'served row breaks is named in its _warnings column. Values withheld ' +
        '(served as NULL): floorPrice by DealPricing_floorPrice_lte_targetPrice ' +
        '(50.1%). Flagged only: DealPricing_pricingConstruct_in (<0.1%). ' +
        'Spelling normalized to the allowed members: pricingConstruct. 4 more ' +
        'rules hold on every row. Rates are over the 60,700 hydrated rows.');
  });

  test('pull drops the paragraph and restores the switch', () => {
    const resources = generateCatalogResources(model(), {
      ...KC_OPTS,
      bigQueryEntries: {datasetLocations: new Map([['p.sem', 'us']])},
      constraintRates: new Map([['sales', RATES]]),
    });
    const pulled = modelsFromCatalogResources(resources.entries, resources.entryLinks);
    const e = pulled.models[0].entities.find(x => x.name === 'DealPricing')!;
    expect(e.description).toBe('A priced proposal.');
    expect(e.hydration).toEqual({constraints: 'enforce'});
    expect(splitConstraintsTrailer('A.\n\nConstraints: Reported, not applied: X (none).'))
        .toEqual({rest: 'A.'});
  });
});

describe('kcmd bind --enforce-constraints', () => {
  test('lists the entities whose node view applies or reports a rule', () => {
    const modelText = [
      'version: "0.2.0.dev0/google"',
      'semantic_model:',
      '  - name: sales',
      '    datasets:',
      '      - name: DealPricing',
      '        primary_key: [pricingId]',
      '        fields:',
      '          - {name: pricingId, datatype: String}',
      '          - {name: floorPrice, datatype: Decimal}',
      '          - {name: targetPrice, datatype: Decimal}',
      '      - name: Region',
      '        primary_key: [regionId]',
      '        fields:',
      '          - {name: regionId, datatype: String}',
      '    constraints:',
      '      - name: DealPricing_floorPrice_lte_targetPrice',
      '        judgment: DealPricing.floorPrice is at most DealPricing.targetPrice.',
      '        description: "A rule. (From SHACL: DealPricingShape, floorPrice sh:lessThanOrEquals targetPrice.)"',
      '        on_violation: reject',
    ].join('\n');
    const profileText = [
      'version: "0.2.0.dev0/google"',
      'semantic_model:',
      '  - name: sales',
      '    deployment_target: //bigquery.googleapis.com/projects/p/datasets/sem/propertyGraphs/g',
      '    entities:',
      '      - name: DealPricing',
      '        source: //bigquery.googleapis.com/projects/p/datasets/crm/tables/deal_pricing',
      '        fields:',
      '          - {name: pricingId, expression: pricing_id}',
      '          - {name: floorPrice, expression: floor_price}',
      '          - {name: targetPrice, expression: target_price}',
      '      - name: Region',
      '        source: //bigquery.googleapis.com/projects/p/datasets/crm/tables/region',
      '        fields:',
      '          - {name: regionId, expression: region_id}',
    ].join('\n');
    expect([...enforceableEntities(modelText, profileText, 'bigquery', 'sales', 'p')])
        .toEqual(['DealPricing']);
  });
});
