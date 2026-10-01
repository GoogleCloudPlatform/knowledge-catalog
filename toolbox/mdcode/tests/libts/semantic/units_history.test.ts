// Behavior specification for K7: field `unit` / `scale` and entity `grain` /
// `history` (src/libts/semantic/units_history.ts) across the toolchain: the
// loader and push validation, the BigQuery property-graph descriptions, the
// Knowledge Catalog push/pull trailers, OSI round-trip, the query-skill
// entity pages, and the OWL importer's qudt:unit mapping.
//
// Running example: an opportunity table that keeps every version of each
// opportunity, flagged `is_current`, with amounts stored in thousands of USD.

import {describe, expect, test} from 'bun:test';

import {generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {parseOwl} from '../../../src/libts/semantic/converters/owl/parse';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {fromDocument, loadModels} from '../../../src/libts/semantic/loader';
import {serializeModel} from '../../../src/libts/semantic/osi_converter';
import {resolveInheritance} from '../../../src/libts/semantic/resolve_inheritance';
import {SemanticRuntime} from '../../../src/libts/semantic/runtime/runtime';
import {generateSkill} from '../../../src/libts/semantic/skills';
import {NAVIGATION_GUIDE} from '../../../src/libts/semantic/skills_query';
import {checkUnitsAndHistory, splitGrainHistoryTrailers, splitUnitTrailer, unitTrailer} from '../../../src/libts/semantic/units_history';
import {validatePushRequirements} from '../../../src/libts/semantic/validate';

const GEN_OPTS = {project: 'p', dataset: 'd'};
const KC_OPTS = {project: 'dest-proj', location: 'us', entryGroup: 'eg'};

function model(): SemanticModel {
  return {
    name: 'sales',
    entities: [{
      name: 'Opportunity',
      dataSource: 'p.d.opportunity_versions',
      keys: ['versionId'],
      description: 'A sales opportunity.',
      grain: 'one row per opportunity version',
      history: {
        versioned: true,
        currentFlag: 'isCurrent',
        validFrom: 'validFrom',
        validTo: 'validTo',
      },
      fields: [
        {name: 'versionId', type: 'String', expression: 'version_id'},
        {
          name: 'amount',
          type: 'Decimal',
          expression: 'amount_k',
          description: 'Contract value.',
          unit: 'USD',
          scale: 1000,
        },
        {name: 'hours', type: 'Float', expression: 'hrs', unit: 'hours'},
        {name: 'share', type: 'Float', expression: 'share_pm', scale: 0.001},
        {name: 'isCurrent', type: 'Boolean', expression: 'is_current'},
        {name: 'validFrom', type: 'Date', expression: 'valid_from'},
        {name: 'validTo', type: 'Date', expression: 'valid_to'},
      ],
    }],
    relationships: [],
    metrics: [],
    customExtensions: [{
      vendorName: 'GOOGLE',
      data: JSON.stringify({
        deploymentTargets:
            ['//bigquery.googleapis.com/projects/p/datasets/d/propertyGraphs/g'],
      }),
    }],
  };
}

const errorsOf = (m: SemanticModel) =>
    validatePushRequirements([{document: 'doc.yaml', model: m} as any], {
      targetOptional: true,
    });

describe('loader', () => {
  const doc = (ds: any, fields: any[] = [], version = '0.2.0.dev0/google') => ({
    version,
    semantic_model: [{
      name: 'm',
      datasets: [{
        name: 'Opportunity',
        source: 'p.d.opp',
        primary_key: ['id'],
        fields: [
          {name: 'id', expression: 'id', datatype: 'String'},
          {name: 'is_current', expression: 'is_current', datatype: 'Boolean'},
          ...fields,
        ],
        ...ds,
      }],
    }],
  });

  test('unit, scale, grain and history load onto the IR', () => {
    const {models, warnings} = fromDocument(doc(
        {
          grain: 'one row per opportunity version',
          history: {versioned: true, current_flag: 'is_current'},
        },
        [{name: 'amount', expression: 'amount_k', unit: 'USD', scale: 1000}]));
    const e = models[0].entities[0];
    expect(e.grain).toBe('one row per opportunity version');
    expect(e.history).toEqual({versioned: true, currentFlag: 'is_current'});
    const amount = e.fields.find(f => f.name === 'amount')!;
    expect(amount.unit).toBe('USD');
    expect(amount.scale).toBe(1000);
    expect(warnings).toEqual([]);
  });

  test('a non-positive scale is a load error', () => {
    expect(() => fromDocument(doc({}, [{name: 'a', expression: 'a', scale: 0}])))
        .toThrow();
    expect(() => fromDocument(doc({}, [{name: 'a', expression: 'a', scale: -5}])))
        .toThrow();
  });

  test('the keys are native extensions: vanilla Ossie rejects them', () => {
    expect(() => fromDocument(doc({grain: 'x'}, [], '0.2.0.dev0'))).toThrow();
    expect(() => fromDocument(
               doc({}, [{name: 'a', expression: 'a', unit: 'USD'}], '0.2.0.dev0')))
        .toThrow();
  });

  test('a history key naming no field loads with a warning', () => {
    const {warnings} =
        fromDocument(doc({history: {versioned: true, current_flag: 'nope'}}));
    expect(warnings.some(w => /history\.current_flag names 'nope'/.test(w)))
        .toBe(true);
  });

  test('a non-Boolean current_flag is warned', () => {
    const {warnings} = fromDocument(doc({history: {versioned: true, current_flag: 'id'}}));
    expect(warnings.some(w => /current_flag 'id' is String, not Boolean/.test(w)))
        .toBe(true);
  });
});

describe('validation', () => {
  test('the running example is valid', () => {
    expect(errorsOf(model())).toEqual([]);
  });

  test('a history key naming no field is a push error', () => {
    const m = model();
    m.entities[0].history!.validTo = 'missing';
    expect(errorsOf(m).some(e => /history\.valid_to names 'missing'/.test(e)))
        .toBe(true);
  });

  test('a non-positive scale on a hand-built IR is a push error', () => {
    const m = model();
    m.entities[0].fields[1].scale = 0;
    expect(errorsOf(m).some(e => /scale must be a number > 0/.test(e))).toBe(true);
  });

  test('an inherited field satisfies a history reference', () => {
    const m = model();
    m.entities.push({
      name: 'Deal',
      dataSource: 'p.d.deal',
      keys: ['versionId'],
      extends: ['Opportunity'],
      history: {versioned: true, currentFlag: 'isCurrent'},
      fields: [],
    });
    expect(checkUnitsAndHistory(m).errors).toEqual([]);
  });

  test('fieldsPruned stands the missing-field check down', () => {
    const m = model();
    m.entities[0].history!.currentFlag = 'pruned';
    expect(checkUnitsAndHistory(m, {fieldsPruned: true}).errors).toEqual([]);
  });
});

describe('trailers', () => {
  test('unit trailer forms', () => {
    expect(unitTrailer({unit: 'USD', scale: 1000})).toBe('Unit: USD (x1000).');
    expect(unitTrailer({unit: 'USD'})).toBe('Unit: USD.');
    expect(unitTrailer({scale: 0.001})).toBe('Scale: x0.001.');
    expect(unitTrailer({})).toBeUndefined();
  });

  test('splitUnitTrailer inverts each form and leaves other text alone', () => {
    expect(splitUnitTrailer('Value.\n\nUnit: USD (x1000).'))
        .toEqual({rest: 'Value.', unit: 'USD', scale: 1000});
    expect(splitUnitTrailer('Unit: U.S.D..')).toEqual({rest: undefined, unit: 'U.S.D.'});
    expect(splitUnitTrailer('Scale: x0.001.')).toEqual({rest: undefined, scale: 0.001});
    expect(splitUnitTrailer('Plain text.')).toEqual({rest: 'Plain text.'});
  });

  test('splitGrainHistoryTrailers leaves other descriptions alone', () => {
    expect(splitGrainHistoryTrailers('Plain.\n\nDefined as: x = 1'))
        .toEqual({rest: 'Plain.\n\nDefined as: x = 1'});
  });
});

describe('BigQuery DDL descriptions', () => {
  const {ddl} = generatePropertyGraph(model(), GEN_OPTS);

  test('a property description ends with its unit trailer', () => {
    expect(ddl).toContain(
        'amount_k AS amount OPTIONS(description="Contract value.\\n\\nUnit: USD (x1000).")');
    expect(ddl).toContain('hrs AS hours OPTIONS(description="Unit: hours.")');
    expect(ddl).toContain('share_pm AS share OPTIONS(description="Scale: x0.001.")');
  });

  test('the node label description ends with grain and history', () => {
    expect(ddl).toContain(
        'OPTIONS(description="A sales opportunity.\\n\\n' +
        'Grain: one row per opportunity version\\n\\n' +
        'History: versioned; current rows where isCurrent; valid from ' +
        'validFrom; valid to validTo.")');
  });

  test('the node table stays the all-versions table (no view, no filter)', () => {
    expect(ddl).toContain('`p.d.opportunity_versions` AS Opportunity');
    expect(ddl).not.toMatch(/is_current\s*=\s*TRUE/i);
  });
});

describe('Knowledge Catalog push / pull', () => {
  const entryOf = (entries: any[], name: string) =>
      entries.find(e => e.entrySource?.displayName === name);

  test('push writes the trailers on the entity and the schema fields', () => {
    const {entries} = generateCatalogResources(model(), KC_OPTS);
    const opp = entryOf(entries, 'Opportunity');
    expect(opp.entrySource.description).toBe(
        'A sales opportunity.\n\nGrain: one row per opportunity version\n\n' +
        'History: versioned; current rows where isCurrent; valid from ' +
        'validFrom; valid to validTo.');
    const schema = Object.entries(opp.aspects as Record<string, any>)
                       .find(([k]) => k.endsWith('.schema'))![1].data;
    const amount = schema.fields.find((f: any) => f.name === 'amount');
    expect(amount.description).toBe('Contract value.\n\nUnit: USD (x1000).');
  });

  test('pull restores unit, scale, grain and history; push is a fixed point', () => {
    const m = model();
    const pushed = generateCatalogResources(m, KC_OPTS);
    const {models} = modelsFromCatalogResources(pushed.entries, pushed.entryLinks);
    const opp = models[0].entities[0];
    expect(opp.description).toBe('A sales opportunity.');
    expect(opp.grain).toBe(m.entities[0].grain);
    expect(opp.history).toEqual(m.entities[0].history);
    const field = (n: string) => opp.fields.find(f => f.name === n)!;
    expect(field('amount')).toMatchObject(
        {description: 'Contract value.', unit: 'USD', scale: 1000});
    expect(field('hours').unit).toBe('hours');
    expect(field('hours').description).toBeUndefined();
    expect(field('share').scale).toBe(0.001);
    expect(field('versionId').unit).toBeUndefined();

    const again = generateCatalogResources(models[0], KC_OPTS);
    expect(entryOf(again.entries, 'Opportunity').entrySource.description)
        .toBe(entryOf(pushed.entries, 'Opportunity').entrySource.description);
  });

  test('a defined entity keeps its K1 trailers alongside K7 ones', () => {
    const m = model();
    m.entities.push({
      name: 'BigDeal',
      dataSource: '',
      keys: [],
      extends: ['Opportunity'],
      fields: [],
      definition: {expression: 'amount >= 1000'},
      grain: 'one row per big opportunity version',
    });
    const pushed = generateCatalogResources(m, KC_OPTS);
    const {models} = modelsFromCatalogResources(pushed.entries, pushed.entryLinks);
    const big = models[0].entities.find(e => e.name === 'BigDeal')!;
    expect(big.definition).toEqual({expression: 'amount >= 1000'});
    expect(big.grain).toBe('one row per big opportunity version');
    expect(big.extends).toEqual(['Opportunity']);
  });
});

describe('OSI round-trip', () => {
  test('native keys survive serialize -> load', () => {
    const {yaml} = serializeModel(model());
    expect(yaml).toContain('grain:');
    expect(yaml).toContain('history:');
    expect(yaml).toContain('unit: USD');
    const {models} = loadModels(yaml);
    const e = models[0].entities[0];
    expect(e.grain).toBe('one row per opportunity version');
    expect(e.history).toEqual(model().entities[0].history);
    expect(e.fields.find(f => f.name === 'amount')).toMatchObject({unit: 'USD', scale: 1000});
  });
});

describe('query skill', () => {
  function generate() {
    const runtime: SemanticRuntime = {
      model: resolveInheritance(model()).model,
      document: 'sales',
      store: {kind: 'bigquery', name: 'projects/p/datasets/d', project: 'p', dataset: 'd'},
      profile: 'bigquery',
      entryGroup: 'sales_eg',
    } as SemanticRuntime;
    const out = generateSkill({runtime, mode: 'query', query: {location: 'US'}});
    if ('error' in out) throw new Error(out.error);
    return Object.fromEntries(out.files.map(x => [x.path, x.text]));
  }
  const files = generate();
  const page = files['references/entities/Opportunity.md'];

  test('properties show unit and scale', () => {
    expect(page).toContain('Unit: USD. Scale: x1000 (a stored 1 is 1000 USD).');
    expect(page).toContain('Unit: hours.');
    expect(page).toContain('Scale: x0.001 (a stored 1 is 0.001).');
  });

  test('the page states the grain and how to get current rows', () => {
    expect(page).toContain('Grain: one row per opportunity version.');
    expect(page).toContain('every version of each record');
    expect(page).toContain('`WHERE n.isCurrent = TRUE` in GQL');
    expect(page).toContain('`WHERE is_current = TRUE` in SQL');
    expect(page).toContain('valid from `validFrom` to `validTo`');
  });

  test('SKILL.md says units are per property and never to rescale', () => {
    const guide = NAVIGATION_GUIDE.join('\n');
    expect(guide).toContain('Units and scale are per property on entity pages');
    expect(guide).toContain('never rescale');
    expect(files['SKILL.md']).toContain('Units and scale are per property');
  });
});

describe('OWL import', () => {
  const TTL = `
    @prefix owl:  <http://www.w3.org/2002/07/owl#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
    @prefix qudt: <http://qudt.org/schema/qudt/> .
    @prefix unit: <http://qudt.org/vocab/unit/> .
    @prefix ex:   <https://example.org/sales#> .

    qudt:unit a owl:AnnotationProperty .
    ex:unit a owl:AnnotationProperty .
    ex:Opportunity a owl:Class ; owl:hasKey ( ex:id ) .
    ex:id a owl:DatatypeProperty ; rdfs:domain ex:Opportunity ; rdfs:range xsd:string .
    ex:amount a owl:DatatypeProperty ; rdfs:domain ex:Opportunity ;
        rdfs:range xsd:decimal ; qudt:unit unit:USD .
    ex:effort a owl:DatatypeProperty ; rdfs:domain ex:Opportunity ;
        rdfs:range xsd:decimal ; qudt:hasUnit unit:HR .
    ex:margin a owl:DatatypeProperty ; rdfs:domain ex:Opportunity ;
        rdfs:range xsd:decimal ; ex:unit "percent" .
  `;

  test('the parser reads qudt:unit, qudt:hasUnit and a plain unit annotation', () => {
    const owl = parseOwl(TTL);
    const unitOf = (n: string) =>
        owl.datatypeProperties.find(p => p.localName === n)!.unit;
    expect(unitOf('amount')).toBe('USD');
    expect(unitOf('effort')).toBe('HR');
    expect(unitOf('margin')).toBe('percent');
    expect(unitOf('id')).toBeUndefined();
  });

  test('the unit maps to fields[].unit and reloads', () => {
    const r = convertOwlToOsi(TTL, 'sales');
    expect(r.yaml).toContain('unit: USD');
    const m = loadModels(r.yaml, {bindingOptional: true}).models[0];
    const fields = m.entities.find(e => e.name === 'Opportunity')!.fields;
    expect(fields.find(f => f.name === 'amount')!.unit).toBe('USD');
    expect(fields.find(f => f.name === 'effort')!.unit).toBe('HR');
    expect(fields.find(f => f.name === 'margin')!.unit).toBe('percent');
    expect(fields.find(f => f.name === 'id')!.unit).toBeUndefined();
  });
});
