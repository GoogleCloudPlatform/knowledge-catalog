// Behavior specification for `kcmd shacl import` (converters/shacl): a SHACL
// shapes graph merged into an EXISTING semantic model as native model-level
// constraints.
//
// The guarantees pinned here:
//   1. the deals fixture produces exactly the documented document (golden),
//      with every unmappable term warned rather than silently dropped;
//   2. each SHACL Core term maps onto the documented constraint, with
//      sh:severity mapped onto severity + on_violation;
//   3. the import is idempotent: re-running replaces the constraints generated
//      from the same shapes, keeps hand-written ones, and names are
//      deterministic;
//   4. the result still loads and passes push validation (the judgment's
//      Entity.field tokens resolve).

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as YAML from 'yaml';

import {importShacl} from '../../../src/libts/semantic/converters/shacl/import';
import {loadModels} from '../../../src/libts/semantic/loader';
import {validatePushRequirements} from '../../../src/libts/semantic/validate';
import {shacl} from '../../../src/tool/commands';

const FIXTURES = path.join(__dirname, 'fixtures', 'shacl');
const read = (name: string) =>
    fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const MODEL = read('deals.osi.yaml');
const SHAPES = read('deals.shapes.ttl');

const PREFIXES = `
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix sh:   <http://www.w3.org/ns/shacl#> .
  @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
  @prefix ex:   <http://example.com/deals#> .
  @prefix shp:  <http://example.com/shapes#> .
`;

// The constraints of the (single) model in a document, as plain objects.
function constraintsOf(yaml: string): any[] {
  return YAML.parse(yaml).semantic_model[0].constraints ?? [];
}
function byName(yaml: string, name: string): any {
  return constraintsOf(yaml).find(c => c.name === name);
}
// Imports inline shapes into the deals model.
function run(shapes: string, model = MODEL) {
  return importShacl(`${PREFIXES}${shapes}`, model);
}

describe('the deals shapes merge into the deals model', () => {
  test('produces exactly the documented document (golden)', () => {
    const r = importShacl(SHAPES, MODEL);
    expect(r.yaml).toEqual(read('deals.osi.golden.yaml'));
    expect(r.model).toBe('deals');
    expect(r.shapes).toBe(5);
    expect(r.added).toEqual([
      'Opportunity_hasBuyer_exactly_1',
      'Opportunity_governedBy_max_1',
      'Opportunity_opportunityId_required',
      'Opportunity_opportunityId_pattern',
      'Opportunity_stage_in',
      'Opportunity_amountUsdK_range',
      'WonOpportunity_hasBuyer_min_1',
      'Contract_contractType_length',
    ]);
  });

  test('every term it cannot map is warned, never silently dropped', () => {
    const {warnings} = importShacl(SHAPES, MODEL);
    const expected = [
      /amountUsdK.*sh:datatype integer \(Integer\) conflicts with .*Decimal/,
      /inverse path \(\^hasBuyer\)/,
      /'probability' is neither a relationship nor a field of 'Opportunity'/,
      /sh:class 'MasterServicesAgreement' is not an entity/,
      /contractType.*sh:node constrain a linked node/,
      /AcmeShape': sh:targetNode targets individual nodes/,
      /AcmeShape': node-level sh:closed is not supported/,
    ];
    expect(warnings.length).toBe(expected.length);
    expected.forEach((re, i) => expect(warnings[i]).toMatch(re));
  });

  test('the comments, layout and hand-written constraint are preserved', () => {
    const {yaml} = importShacl(SHAPES, MODEL);
    expect(yaml).toContain('# Hand-written: never touched by a SHACL import.');
    expect(constraintsOf(yaml)[0].name).toBe('Opportunity_amount_reviewed');
    expect(yaml.startsWith(MODEL.slice(0, MODEL.indexOf('    constraints:'))))
        .toBe(true);
  });

  test('the result loads and passes push validation', () => {
    const {yaml} = importShacl(SHAPES, MODEL);
    const {models} = loadModels(yaml, {bindingOptional: true});
    expect(models[0].constraints?.length).toBe(9);
    expect(validatePushRequirements(
               [{document: 'deals.yaml', model: models[0]}],
               {targetOptional: true}))
        .toEqual([]);
  });
});

describe('severity and description', () => {
  test('sh:severity maps onto severity and on_violation', () => {
    const {yaml} = run(`
      shp:S a sh:NodeShape ; sh:targetClass ex:Opportunity ;
        sh:property [ sh:path ex:opportunityId ; sh:minCount 1 ] ;
        sh:property [ sh:path ex:stage ; sh:maxCount 0 ; sh:severity sh:Violation ] ;
        sh:property [ sh:path ex:hasBuyer ; sh:minCount 1 ; sh:severity sh:Warning ] ;
        sh:property [ sh:path ex:governedBy ; sh:maxCount 2 ; sh:severity sh:Info ] .
    `);
    const facets = (n: string) =>
        [byName(yaml, n).severity, byName(yaml, n).on_violation];
    // No sh:severity is sh:Violation (the SHACL default).
    expect(facets('Opportunity_opportunityId_required')).toEqual(['high', 'reject']);
    expect(facets('Opportunity_stage_empty')).toEqual(['high', 'reject']);
    expect(facets('Opportunity_hasBuyer_min_1')).toEqual(['medium', 'warn']);
    expect(facets('Opportunity_governedBy_max_2')).toEqual(['low', 'warn']);
  });

  test('an unknown severity is warned and treated as sh:Violation', () => {
    const r = run(`
      shp:S a sh:NodeShape ; sh:targetClass ex:Opportunity ;
        sh:property [ sh:path ex:opportunityId ; sh:minCount 1 ;
                      sh:severity shp:Critical ] .
    `);
    expect(r.warnings[0]).toMatch(/sh:severity 'Critical' is not/);
    expect(byName(r.yaml, 'Opportunity_opportunityId_required').on_violation)
        .toBe('reject');
  });

  test('sh:message, else sh:description, else a steering sentence', () => {
    const {yaml} = run(`
      shp:S a sh:NodeShape ; sh:targetClass ex:Opportunity ;
        sh:property [ sh:path ex:opportunityId ; sh:minCount 1 ;
                      sh:message "Needs an id."@en ; sh:description "ignored" ] ;
        sh:property [ sh:path ex:stage ; sh:minCount 1 ;
                      sh:description "Stage is mandatory." ] ;
        sh:property [ sh:path ex:amountUsdK ; sh:minCount 1 ] .
    `);
    expect(byName(yaml, 'Opportunity_opportunityId_required').description)
        .toBe('Needs an id. (From SHACL: S, opportunityId sh:minCount 1.)');
    expect(byName(yaml, 'Opportunity_stage_required').description)
        .toStartWith('Stage is mandatory. (From SHACL: S,');
    expect(byName(yaml, 'Opportunity_amountUsdK_required').description)
        .toStartWith('Set Opportunity.amountUsdK on every Opportunity.');
  });
});

describe('term mapping', () => {
  test('relationship counts: exactly, min, max, and only', () => {
    const {yaml} = run(`
      shp:S a sh:NodeShape ; sh:targetClass ex:Opportunity ;
        sh:property [ sh:path ex:hasBuyer ; sh:minCount 2 ; sh:maxCount 3 ;
                      sh:class ex:ClientAccount ] ;
        sh:property [ sh:path ex:governedBy ; sh:minCount 0 ; sh:maxCount 0 ] .
      shp:T a sh:NodeShape ; sh:targetClass ex:Opportunity ;
        sh:property [ sh:path ex:hasBuyer ; sh:class ex:Party ] .
    `);
    expect(constraintsOf(yaml).map(c => c.name)).toEqual([
      'Opportunity_amount_reviewed',
      'Opportunity_hasBuyer_min_2',
      'Opportunity_hasBuyer_max_3',
      // sh:class ClientAccount is hasBuyer's destination: no rule.
      'Opportunity_governedBy_exactly_0',
      'Opportunity_hasBuyer_only_Party',
    ]);
  });

  test('a qualified count narrower than the destination is suffixed', () => {
    const model = MODEL.replace(
        '      - name: Contract\n',
        '      - name: MSA\n        extends:\n          - Contract\n' +
            '      - name: Contract\n');
    const {yaml} = run(`
      shp:S a sh:NodeShape ; sh:targetClass ex:Opportunity ;
        sh:property [ sh:path ex:governedBy ;
                      sh:qualifiedValueShape [ sh:class ex:MSA ] ;
                      sh:qualifiedMinCount 1 ; sh:qualifiedMaxCount 1 ] .
    `, model);
    const c = byName(yaml, 'Opportunity_governedBy_exactly_1_MSA');
    expect(c.judgment).toStartWith(
        'Each Opportunity has exactly one governedBy relationship to an MSA.');
    expect(c.description).toContain(
        'governedBy sh:qualifiedMinCount 1 sh:qualifiedMaxCount 1 sh:class MSA');
  });

  test('field rules: required, empty, pattern with flags, value, range, length', () => {
    const {yaml, warnings} = run(`
      shp:S a sh:NodeShape ; sh:targetClass ex:Opportunity ;
        sh:property [ sh:path ex:opportunityId ; sh:minCount 1 ; sh:maxCount 1 ;
                      sh:pattern "^opp-" ; sh:flags "i" ] ;
        sh:property [ sh:path ex:stage ; sh:in ( "Won" ) ; sh:minLength 2 ] ;
        sh:property [ sh:path ex:amountUsdK ; sh:minExclusive 0 ;
                      sh:maxInclusive 500 ; sh:datatype xsd:decimal ] .
    `);
    expect(warnings).toEqual([]);
    expect(constraintsOf(yaml).map(c => c.name).slice(1)).toEqual([
      'Opportunity_opportunityId_required',
      'Opportunity_opportunityId_pattern',
      'Opportunity_stage_value_Won',
      'Opportunity_stage_length',
      'Opportunity_amountUsdK_range',
    ]);
    expect(byName(yaml, 'Opportunity_opportunityId_pattern').judgment)
        .toContain(`'^opp-' (regular-expression flags: i)`);
    expect(byName(yaml, 'Opportunity_amountUsdK_range').judgment)
        .toStartWith(
            'Every Opportunity.amountUsdK that is set is greater than 0 and at most 500.');
  });

  test('a field minimum above one cannot be met and is warned', () => {
    const r = run(`
      shp:S a sh:NodeShape ; sh:targetClass ex:Opportunity ;
        sh:property [ sh:path ex:stage ; sh:minCount 2 ] .
    `);
    expect(r.added).toEqual([]);
    expect(r.warnings[0]).toMatch(/sh:minCount 2 cannot be met/);
  });

  test('paths resolve through supertypes; a foreign edge is warned', () => {
    const r = run(`
      shp:S a sh:NodeShape ; sh:targetClass ex:ClientAccount ;
        sh:property [ sh:path ex:partyName ; sh:minCount 1 ] ;
        sh:property [ sh:path ex:hasBuyer ; sh:minCount 1 ] .
    `);
    expect(r.added).toEqual(['ClientAccount_partyName_required']);
    expect(r.warnings[0]).toMatch(
        /relationship 'hasBuyer' starts at 'Opportunity', not at 'ClientAccount'/);
  });

  test('an unknown target class and a target-less shape are warned', () => {
    const r = run(`
      shp:S a sh:NodeShape ; sh:targetClass ex:Invoice ;
        sh:property [ sh:path ex:stage ; sh:minCount 1 ] .
      shp:T a sh:NodeShape ; sh:property [ sh:path ex:stage ; sh:minCount 1 ] .
    `);
    expect(r.added).toEqual([]);
    expect(r.warnings).toEqual([
      expect.stringMatching(/'Invoice' is not an entity in the model/),
      expect.stringMatching(/shape 'T' has no sh:targetClass/),
    ]);
  });

  test('a standalone property shape with its own target is read', () => {
    const r = run(`
      shp:IdRequired a sh:PropertyShape ; sh:targetClass ex:Opportunity ;
        sh:path ex:opportunityId ; sh:minCount 1 .
    `);
    expect(r.added).toEqual(['Opportunity_opportunityId_required']);
    expect(byName(r.yaml, r.added[0]).description)
        .toContain('(From SHACL: IdRequired, opportunityId sh:minCount 1.)');
  });

  test('several files are one shapes graph', () => {
    const a = `${PREFIXES} shp:A a sh:NodeShape ; sh:targetClass ex:Opportunity ;
                 sh:property [ sh:path ex:stage ; sh:minCount 1 ] .`;
    const b = `${PREFIXES} shp:B a sh:NodeShape ; sh:targetClass ex:Contract ;
                 sh:property [ sh:path ex:contractType ; sh:minCount 1 ] .`;
    expect(importShacl([a, b], MODEL).added).toEqual([
      'Opportunity_stage_required', 'Contract_contractType_required',
    ]);
  });
});

describe('property pairs (sh:lessThan, sh:lessThanOrEquals, sh:equals, sh:disjoint)', () => {
  // DealPricing compares its own prices, and ceilingPrice inherited from
  // PricedThing; Deal.dealPrice is another entity's field.
  const PRICING = `version: 0.2.0.dev0/google
semantic_model:
  - name: pricing
    entities:
      - name: PricedThing
        fields:
          - name: ceilingPrice
            datatype: Decimal
      - name: DealPricing
        extends:
          - PricedThing
        fields:
          - name: floorPrice
            datatype: Decimal
          - name: targetPrice
            datatype: Decimal
          - name: listPrice
            datatype: Integer
          - name: pricingCode
            datatype: String
          - name: approvedCode
            datatype: String
      - name: Deal
        fields:
          - name: dealPrice
            datatype: Decimal
    relationships:
      - name: pricesDeal
        from: DealPricing
        to: Deal
`;
  const pricing = (shapes: string) => run(shapes, PRICING);

  test('sh:lessThanOrEquals becomes C_f_lte_g with facets from sh:severity', () => {
    const r = pricing(`
      shp:DealPricingShape a sh:NodeShape ; sh:targetClass ex:DealPricing ;
        sh:property [ sh:path ex:floorPrice ;
                      sh:lessThanOrEquals ex:targetPrice ;
                      sh:severity sh:Warning ] .
    `);
    expect(r.warnings).toEqual([]);
    expect(byName(r.yaml, 'DealPricing_floorPrice_lte_targetPrice')).toEqual({
      name: 'DealPricing_floorPrice_lte_targetPrice',
      judgment: 'Each DealPricing\'s floorPrice must be less than or equal to ' +
          'its targetPrice. A DealPricing whose DealPricing.floorPrice is ' +
          'greater than its DealPricing.targetPrice does not satisfy this ' +
          'rule. The rule compares the two only when both are set.',
      description: 'Keep DealPricing.floorPrice at most DealPricing.targetPrice. ' +
          '(From SHACL: DealPricingShape, floorPrice sh:lessThanOrEquals ' +
          'targetPrice.)',
      on_violation: 'warn',
      severity: 'medium',
    });
  });

  test('all four terms, several values, a supertype field and sh:message', () => {
    const {yaml, added, warnings} = pricing(`
      shp:S a sh:NodeShape ; sh:targetClass ex:DealPricing ;
        sh:property [ sh:path ex:floorPrice ;
                      sh:lessThan ex:targetPrice, ex:ceilingPrice ;
                      sh:message "Floor must stay under target and ceiling." ] ;
        sh:property [ sh:path ex:listPrice ; sh:equals ex:targetPrice ] ;
        sh:property [ sh:path ex:pricingCode ; sh:disjoint ex:approvedCode ] .
    `);
    expect(warnings).toEqual([]);
    expect(added).toEqual([
      'DealPricing_floorPrice_lt_targetPrice',
      'DealPricing_floorPrice_lt_ceilingPrice',
      // Integer and Decimal compare.
      'DealPricing_listPrice_eq_targetPrice',
      'DealPricing_pricingCode_disjoint_approvedCode',
    ]);
    expect(byName(yaml, 'DealPricing_floorPrice_lt_ceilingPrice').description)
        .toBe('Floor must stay under target and ceiling. (From SHACL: S, ' +
              'floorPrice sh:lessThan ceilingPrice.)');
    expect(byName(yaml, 'DealPricing_floorPrice_lt_targetPrice').judgment)
        .toStartWith('Each DealPricing\'s floorPrice must be less than its ' +
                     'targetPrice. A DealPricing whose DealPricing.floorPrice ' +
                     'is greater than or equal to');
    expect(byName(yaml, 'DealPricing_listPrice_eq_targetPrice').judgment)
        .toContain('or that sets only one of them, does not satisfy this rule.');
    expect(byName(yaml, 'DealPricing_pricingCode_disjoint_approvedCode').judgment)
        .toStartWith('Each DealPricing\'s pricingCode must differ from its ' +
                     'approvedCode.');
    // No sh:severity: sh:Violation.
    expect(byName(yaml, 'DealPricing_listPrice_eq_targetPrice').on_violation)
        .toBe('reject');
  });

  test('an unresolvable other path is warned and skipped', () => {
    const r = pricing(`
      shp:S a sh:NodeShape ; sh:targetClass ex:DealPricing ;
        sh:property [ sh:path ex:floorPrice ;
                      sh:lessThan ex:dealPrice, ex:pricesDeal, ex:floorPrice ;
                      sh:equals [ sh:path ex:targetPrice ] ] .
    `);
    expect(r.added).toEqual([]);
    expect(r.warnings).toEqual([
      expect.stringMatching(/sh:equals value is not a property IRI; skipped/),
      expect.stringMatching(
          /sh:lessThan 'dealPrice' is not a field of 'DealPricing' \(or its supertypes\); skipped/),
      expect.stringMatching(/sh:lessThan 'pricesDeal' is a relationship/),
      expect.stringMatching(/sh:lessThan compares 'floorPrice' with itself; skipped/),
    ]);
  });

  test('incomparable datatypes: orderings and sh:equals warned, sh:disjoint dropped', () => {
    const r = pricing(`
      shp:S a sh:NodeShape ; sh:targetClass ex:DealPricing ;
        sh:property [ sh:path ex:floorPrice ;
                      sh:lessThanOrEquals ex:pricingCode ;
                      sh:equals ex:pricingCode ;
                      sh:disjoint ex:pricingCode ] .
    `);
    expect(r.added).toEqual([]);
    expect(r.warnings).toEqual([
      expect.stringMatching(
          /sh:equals compares DealPricing.floorPrice \(Decimal\) with DealPricing.pricingCode \(String\), whose values never compare/),
      expect.stringMatching(/sh:lessThanOrEquals compares DealPricing.floorPrice/),
    ]);
  });

  test('a pair on a relationship path is warned', () => {
    const r = pricing(`
      shp:S a sh:NodeShape ; sh:targetClass ex:DealPricing ;
        sh:property [ sh:path ex:pricesDeal ; sh:maxCount 1 ;
                      sh:lessThan ex:targetPrice ] .
    `);
    expect(r.added).toEqual(['DealPricing_pricesDeal_max_1']);
    expect(r.warnings).toEqual([expect.stringMatching(
        /sh:lessThan compare field values, but 'pricesDeal' is a relationship; ignored/)]);
  });

  test('the result loads, passes push validation, and re-imports unchanged', () => {
    const shapes = `
      shp:S a sh:NodeShape ; sh:targetClass ex:DealPricing ;
        sh:property [ sh:path ex:floorPrice ; sh:lessThan ex:ceilingPrice ;
                      sh:lessThanOrEquals ex:targetPrice ] ;
        sh:property [ sh:path ex:pricingCode ; sh:disjoint ex:approvedCode ] .
    `;
    const first = pricing(shapes);
    const {models} = loadModels(first.yaml, {bindingOptional: true});
    expect(models[0].constraints?.length).toBe(3);
    expect(validatePushRequirements(
               [{document: 'pricing.yaml', model: models[0]}],
               {targetOptional: true}))
        .toEqual([]);
    const second = run(shapes, first.yaml);
    expect(second.yaml).toEqual(first.yaml);
    expect(second.replaced).toBe(3);
  });
});

describe('re-import is idempotent', () => {
  test('re-running the same shapes changes nothing', () => {
    const first = importShacl(SHAPES, MODEL);
    const second = importShacl(SHAPES, first.yaml);
    expect(second.yaml).toEqual(first.yaml);
    expect(second.replaced).toBe(8);
  });

  test('an edited shape replaces its constraints; others are kept', () => {
    const first = run(`
      shp:S a sh:NodeShape ; sh:targetClass ex:Opportunity ;
        sh:property [ sh:path ex:governedBy ; sh:maxCount 1 ] .
      shp:T a sh:NodeShape ; sh:targetClass ex:Opportunity ;
        sh:property [ sh:path ex:stage ; sh:minCount 1 ] .
    `);
    // S is edited and T is not in the second input.
    const second = importShacl(`${PREFIXES}
      shp:S a sh:NodeShape ; sh:targetClass ex:Opportunity ;
        sh:property [ sh:path ex:governedBy ; sh:maxCount 2 ] .
    `, first.yaml);
    expect(second.replaced).toBe(1);
    expect(constraintsOf(second.yaml).map(c => c.name)).toEqual([
      'Opportunity_amount_reviewed',
      'Opportunity_stage_required',  // T's, kept
      'Opportunity_governedBy_max_2',
    ]);
  });

  test('a name taken by a kept constraint gets a stable suffix', () => {
    const model = MODEL.replace(
        'name: Opportunity_amount_reviewed', 'name: Opportunity_stage_required');
    const shapes = `
      shp:S a sh:NodeShape ; sh:targetClass ex:Opportunity ;
        sh:property [ sh:path ex:stage ; sh:minCount 1 ] .
    `;
    const first = run(shapes, model);
    expect(first.added).toEqual(['Opportunity_stage_required_2']);
    expect(run(shapes, first.yaml).added).toEqual(['Opportunity_stage_required_2']);
  });

  test('a deactivated shape produces nothing and removes its old output', () => {
    const on = run(`
      shp:S a sh:NodeShape ; sh:targetClass ex:Opportunity ;
        sh:property [ sh:path ex:stage ; sh:minCount 1 ] .
    `);
    const off = importShacl(`${PREFIXES}
      shp:S a sh:NodeShape ; sh:targetClass ex:Opportunity ; sh:deactivated true ;
        sh:property [ sh:path ex:stage ; sh:minCount 1 ] .
    `, on.yaml);
    expect(off.added).toEqual([]);
    expect(off.replaced).toBe(1);
    expect(constraintsOf(off.yaml).map(c => c.name))
        .toEqual(['Opportunity_amount_reviewed']);
  });
});

describe('model selection', () => {
  const two = MODEL + MODEL.replace(/^version:.*\nsemantic_model:\n/, '')
                          .replace('- name: deals', '- name: other');

  test('several models require --model', () => {
    expect(() => importShacl(SHAPES, two)).toThrow(/pass --model <name>/);
    const r = importShacl(SHAPES, two, {model: 'other'});
    expect(r.model).toBe('other');
    const models = YAML.parse(r.yaml).semantic_model;
    expect(models[0].constraints.length).toBe(1);
    expect(models[1].constraints.length).toBe(9);
  });

  test('an unknown model is an error', () => {
    expect(() => importShacl(SHAPES, MODEL, {model: 'nope'}))
        .toThrow(/model 'nope' is not in the document/);
  });
});

describe('the shacl import command', () => {
  test('--into edits the document in place; --out writes elsewhere', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-shacl-'));
    const shapes = path.join(dir, 'shapes.ttl');
    const model = path.join(dir, 'deals.yaml');
    fs.writeFileSync(shapes, SHAPES);
    fs.writeFileSync(model, MODEL);

    const out = path.join(dir, 'out', 'deals.yaml');
    expect(await shacl('import', [shapes], {into: model, out})).toBe(0);
    expect(fs.readFileSync(model, 'utf8')).toEqual(MODEL);  // untouched
    expect(fs.readFileSync(out, 'utf8')).toEqual(read('deals.osi.golden.yaml'));

    expect(await shacl('import', [shapes], {into: model})).toBe(0);
    expect(fs.readFileSync(model, 'utf8'))
        .toEqual(read('deals.osi.golden.yaml'));
  });

  test('usage errors exit non-zero', async () => {
    expect(await shacl('export', ['x.ttl'], {})).toBe(1);
    expect(await shacl('import', [], {into: 'm.yaml'})).toBe(1);
    expect(await shacl('import', ['/no/such.ttl'], {into: 'm.yaml'})).toBe(1);
  });
});
