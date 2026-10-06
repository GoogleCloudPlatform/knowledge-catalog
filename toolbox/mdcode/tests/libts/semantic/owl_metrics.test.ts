// Behavior specification for metrics stated in the ontology
// (src/libts/semantic/converters/owl/{parse,metrics,skos,coverage}.ts):
//
//   - every individual of kcmd:Metric (https://kcmd.dev/ns#Metric) becomes a
//     model metric: name = local name, expression = kcmd:expression,
//     description = skos:definition (else rdfs:comment) plus the unit trailer
//     `Unit: X.` for kcmd:unit, ai_context.synonyms = prefLabel / labels /
//     altLabels, ai_context.instructions = kcmd:instructions;
//   - the metric attaches to the single entity its expression references (none
//     for a cross-entity metric), as the loader derives it;
//   - `kcmd:Metric a owl:Class` (declared so OWL tools accept the
//     individuals) is never an entity, nor are metrics vocabulary members;
//   - a metric without kcmd:expression is skipped with a warning;
//   - when the ontology ships a SKOS glossary, each metric gets a glossary
//     term that defines it;
//   - coverage lists each metric (compiled or dropped).

import {describe, expect, test} from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';

import {convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {parseOwl} from '../../../src/libts/semantic/converters/owl/parse';
import {loadModels} from '../../../src/libts/semantic/loader';

const FIXTURES = path.join(__dirname, 'fixtures', 'owl');
const readFixture = (name: string) =>
    fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const TTL = readFixture('metrics.owl.ttl');

function convert(ttl: string) {
  const r = convertOwlToOsi(ttl, 'pipeline');
  const model = loadModels(r.yaml, {bindingOptional: true}).models[0];
  const metric = (name: string) => model.metrics.find(m => m.name === name);
  return {...r, model, metric};
}

describe('kcmd:Metric individuals become metrics', () => {
  test('the parser reads each metric', () => {
    const metrics = parseOwl(TTL).metrics!;
    expect(metrics.map(m => m.localName)).toEqual([
      'total_contract_value', 'win_rate_pct', 'revenue_per_deal',
      'draft_metric',
    ]);
    expect(metrics[0]).toEqual({
      iri: 'https://example.org/pipeline/metrics#total_contract_value',
      localName: 'total_contract_value',
      expression: 'SUM(Opportunity.totalContractValue)',
      labels: ['Total contract value'],
      altLabels: ['TCV', 'deal value'],
      definition: 'Total contract value of the opportunities in scope.',
      unit: 'USD',
    });
    expect(metrics[1].instructions)
        .toBe('Only closed opportunities are in the denominator.');
  });

  test('kcmd:Metric is not an entity and metrics are not individuals', () => {
    const owl = parseOwl(TTL);
    expect(owl.classes.map(c => c.localName))
        .toEqual(['Opportunity', 'Engagement']);
    expect(owl.individuals).toBeUndefined();
    expect(convert(TTL).model.entities.map(e => e.name))
        .toEqual(['Opportunity', 'Engagement']);
  });

  test('name, expression, description with unit, ai_context', () => {
    const m = convert(TTL).metric('total_contract_value')!;
    expect(m.expression).toBe('SUM(Opportunity.totalContractValue)');
    expect(m.description).toBe(
        'Total contract value of the opportunities in scope.\n\nUnit: USD.');
    expect(m.aiContext?.synonyms)
        .toEqual(['Total contract value', 'TCV', 'deal value']);
    expect(m.aiContext?.instructions).toBeUndefined();
  });

  test('kcmd:instructions become ai_context.instructions', () => {
    expect(convert(TTL).metric('win_rate_pct')!.aiContext?.instructions)
        .toBe('Only closed opportunities are in the denominator.');
  });

  test('the attach entity is the one the expression references', () => {
    const {metric} = convert(TTL);
    expect(metric('total_contract_value')!.entity).toBe('Opportunity');
    expect(metric('win_rate_pct')!.entity).toBe('Opportunity');
    // Cross-entity: no single attach entity.
    expect(metric('revenue_per_deal')!.entity).toBeUndefined();
    // rdfs:comment is the fallback description; no unit, no trailer.
    expect(metric('revenue_per_deal')!.description)
        .toBe('Engagement revenue per opportunity (cross-entity).');
  });

  test('a metric without kcmd:expression is skipped and warned', () => {
    const {metric, warnings} = convert(TTL);
    expect(metric('draft_metric')).toBeUndefined();
    expect(warnings).toContain(
        `metric 'draft_metric' has no kcmd:expression, so it is not imported.`);
  });

  test('the import summary counts the metrics', () => {
    expect(convert(TTL).stats.metrics).toBe(3);
  });

  test('a qualifier naming a folded class is rewritten to the keyed class',
       () => {
         const ttl = `${TTL}
           ex:Deal2 a owl:Class ; owl:equivalentClass ex:Opportunity .
           met:deals a kcmd:Metric ;
               kcmd:expression "COUNT(DISTINCT Deal2.opportunityId)" .
         `;
         const m = convert(ttl).metric('deals')!;
         expect(m.expression).toBe('COUNT(DISTINCT Opportunity.opportunityId)');
         expect(m.entity).toBe('Opportunity');
       });
});

describe('metrics in the glossary', () => {
  test('each metric gets a term that defines it', () => {
    const terms = convert(TTL).model.glossary!.terms;
    const tcv = terms.find(
        t => t.defines?.some(d => d.kind === 'metric' &&
                                  d.ref === 'total_contract_value'))!;
    expect(tcv).toMatchObject({
      displayName: 'Total contract value',
      definition: 'Total contract value of the opportunities in scope.',
      synonyms: ['TCV', 'deal value'],
      defines: [{kind: 'metric', ref: 'total_contract_value'}],
    });
    // The skipped metric gets no term.
    expect(terms.some(t => t.defines?.some(d => d.ref === 'draft_metric')))
        .toBe(false);
  });

  test('no glossary is invented when the ontology has no SKOS concepts', () => {
    const ttl = TTL.replace(/ex:PipelineGlossary[\s\S]*?ex:Opportunity \.\n/,
                            '');
    const {model} = convert(ttl);
    expect(model.glossary).toBeUndefined();
    expect(model.metrics.length).toBe(3);
  });
});

describe('coverage lists the metrics', () => {
  test('imported metrics are compiled, the skipped one dropped', () => {
    const {coverage} = convert(TTL);
    const rows = coverage.filter(e => e.construct === 'kcmd:Metric');
    expect(rows.map(r => [r.subject, r.outcome])).toEqual([
      ['total_contract_value', 'compiled'],
      ['win_rate_pct', 'compiled'],
      ['revenue_per_deal', 'compiled'],
      ['draft_metric', 'dropped'],
    ]);
    expect(rows[0].target).toBe('metric total_contract_value');
    expect(rows[3].reason).toBe('no kcmd:expression');
    expect(coverage.filter(e => e.construct === 'kcmd:Metric (glossary)')
               .map(e => e.subject))
        .toEqual(['total_contract_value', 'win_rate_pct', 'revenue_per_deal']);
  });
});

describe('golden', () => {
  test('produces exactly the documented OSI (golden)', () => {
    expect(convertOwlToOsi(TTL, 'pipeline').yaml)
        .toEqual(readFixture('metrics.osi.golden.yaml'));
  });
});
