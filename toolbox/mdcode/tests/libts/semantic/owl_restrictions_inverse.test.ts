// Behavior specification for OWL restrictions stated through an INVERSE
// property name, and for restrictions that are conjuncts of an
// owl:intersectionOf class expression
// (src/libts/semantic/converters/owl/{parse,constraints}.ts).
//
// An object property declared only as `Y owl:inverseOf X` is folded into
// `inverse: Y` on relationship X (feat/owl-inverse-edges), so it is not a
// relationship of its own. Ontologies still state rules through it --
// `Opportunity ⊑ ≤1 governedBy.ContractAgreement` -- and those rules map onto
// the SAME native constraint shape as any other relationship rule, described
// against the forward edge read backwards. Likewise a defined class
// `C ≡ D ⊓ ∃p.X` yields a constraint on C from its restriction conjunct, and
// its named conjunct D becomes a supertype (`extends`).

import {describe, expect, test} from 'bun:test';

import {convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {Constraint} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';
import {validatePushRequirements} from '../../../src/libts/semantic/validate';

const PREFIXES = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
  @prefix ex:   <http://example.com/x#> .
`;

// Mirrors the real ontology's shapes: contractFor / governedBy,
// delivers / deliveredBy, checks / hasHealthCheck. The inverse names carry no
// domain or range of their own.
const BASE = `${PREFIXES}
  ex:Opportunity a owl:Class .
  ex:WonOpportunity a owl:Class ; rdfs:subClassOf ex:Opportunity .
  ex:ContractAgreement a owl:Class .
  ex:Engagement a owl:Class .
  ex:QAHealthCheck a owl:Class .
  ex:QAAssuredEngagement a owl:Class .
  ex:contractFor a owl:ObjectProperty ; rdfs:domain ex:ContractAgreement ;
      rdfs:range ex:Opportunity ; owl:inverseOf ex:governedBy .
  ex:governedBy a owl:ObjectProperty .
  ex:delivers a owl:ObjectProperty ; rdfs:domain ex:Engagement ;
      rdfs:range ex:Opportunity .
  ex:deliveredBy a owl:ObjectProperty ; owl:inverseOf ex:delivers .
  ex:checks a owl:ObjectProperty ; rdfs:domain ex:QAHealthCheck ;
      rdfs:range ex:Engagement ; owl:inverseOf ex:hasHealthCheck .
  ex:hasHealthCheck a owl:ObjectProperty .
`;

function convert(ttl: string) {
  const r = convertOwlToOsi(ttl, 'x');
  const model = loadModels(r.yaml, {bindingOptional: true}).models[0];
  return {...r, model, constraints: model.constraints ?? []};
}

const byName = (cs: Constraint[], name: string) =>
    cs.find(c => c.name === name);

const entity = (model: ReturnType<typeof convert>['model'], name: string) =>
    model.entities.find(e => e.name === name)!;


describe('restrictions through an inverse name', () => {
  test('≤1 governedBy.ContractAgreement reads contractFor backwards', () => {
    const {constraints, warnings} = convert(`${BASE}
      ex:Opportunity rdfs:subClassOf [ a owl:Restriction ;
          owl:onProperty ex:governedBy ;
          owl:maxQualifiedCardinality "1"^^xsd:nonNegativeInteger ;
          owl:onClass ex:ContractAgreement ] .`);
    expect(warnings).toEqual([]);
    expect(constraints).toEqual([{
      name: 'Opportunity_governedBy_max_1',
      judgment: 'Each Opportunity is linked from at most one ' +
          'ContractAgreement via contractFor (governedBy is contractFor read ' +
          'backwards). An Opportunity linked from more than one does not ' +
          'satisfy this rule.',
      description: 'Link each Opportunity from at most one ContractAgreement ' +
          'through contractFor. (From OWL: Opportunity SubClassOf governedBy ' +
          'max 1 ContractAgreement.)',
      onViolation: 'warn',
    }]);
  });

  test('a subclass of the edge destination may state the rule', () => {
    const {constraints, warnings} = convert(`${BASE}
      ex:WonOpportunity rdfs:subClassOf [ a owl:Restriction ;
          owl:onProperty ex:deliveredBy ;
          owl:someValuesFrom ex:QAAssuredEngagement ] .`);
    expect(warnings).toEqual([]);
    const c = byName(constraints,
                     'WonOpportunity_deliveredBy_some_QAAssuredEngagement');
    expect(c?.judgment)
        .toBe('Each WonOpportunity is linked from at least one ' +
              'QAAssuredEngagement via delivers (deliveredBy is delivers ' +
              'read backwards). A WonOpportunity linked from no ' +
              'QAAssuredEngagement via delivers does not satisfy this rule.');
  });

  test('the inverse is not a relationship of its own', () => {
    const {model} = convert(BASE);
    const names = model.relationships?.map(r => r.name) ?? [];
    expect(names).not.toContain('governedBy');
    expect(names).not.toContain('deliveredBy');
    expect(names).not.toContain('hasHealthCheck');
  });

  test('a class that is not the edge destination is warned and skipped', () => {
    const {constraints, warnings} = convert(`${BASE}
      ex:Engagement rdfs:subClassOf [ a owl:Restriction ;
          owl:onProperty ex:governedBy ; owl:maxCardinality 1 ] .`);
    expect(constraints).toEqual([]);
    expect(warnings).toEqual([
      `restriction 'Engagement SubClassOf governedBy max 1': 'governedBy' is ` +
          `the inverse of relationship 'contractFor', which ends at ` +
          `'Opportunity', not at 'Engagement' or one of its supertypes; ` +
          `skipped.`,
    ]);
  });

  test('`only` the declared source restates the edge and is dropped', () => {
    const {constraints, warnings} = convert(`${BASE}
      ex:Opportunity rdfs:subClassOf [ a owl:Restriction ;
          owl:onProperty ex:governedBy ;
          owl:allValuesFrom ex:ContractAgreement ] .`);
    expect(constraints).toEqual([]);
    expect(warnings).toEqual([]);
  });

  test('`only` a narrower source is a rule', () => {
    const {constraints} = convert(`${BASE}
      ex:MSA a owl:Class ; rdfs:subClassOf ex:ContractAgreement .
      ex:Opportunity rdfs:subClassOf [ a owl:Restriction ;
          owl:onProperty ex:governedBy ; owl:allValuesFrom ex:MSA ] .`);
    expect(constraints.map(c => c.name)).toEqual(['Opportunity_governedBy_only_MSA']);
  });

  test('exactly 1 and min N name the count', () => {
    const names = (body: string) => convert(`${BASE}
      ex:Opportunity rdfs:subClassOf [ a owl:Restriction ;
          owl:onProperty ex:governedBy ; ${body} ] .`)
        .constraints.map(c => c.name);
    expect(names('owl:cardinality 1')).toEqual(['Opportunity_governedBy_exactly_1']);
    expect(names('owl:minCardinality 2')).toEqual(['Opportunity_governedBy_min_2']);
    expect(names('owl:minCardinality 0')).toEqual([]);
    expect(names('owl:maxCardinality 0')).toEqual(['Opportunity_governedBy_max_0']);
  });
});


describe('restrictions inside owl:intersectionOf', () => {
  const QA = `${BASE}
    ex:QAAssuredEngagement owl:equivalentClass [ a owl:Class ;
        owl:intersectionOf ( ex:Engagement [ a owl:Restriction ;
            owl:onProperty ex:hasHealthCheck ;
            owl:someValuesFrom ex:QAHealthCheck ] ) ] .`;

  test('Engagement ⊓ ∃hasHealthCheck.QAHealthCheck → constraint + extends', () => {
    const {model, constraints, warnings} = convert(QA);
    expect(warnings).toEqual([]);
    expect(entity(model, 'QAAssuredEngagement').extends)
        .toEqual(['Engagement']);
    const c = byName(constraints,
                     'QAAssuredEngagement_hasHealthCheck_some_QAHealthCheck');
    expect(c?.description)
        .toBe('Link each QAAssuredEngagement from at least one QAHealthCheck ' +
              'through checks. (From OWL: QAAssuredEngagement EquivalentTo ' +
              'Engagement and (hasHealthCheck some QAHealthCheck).)');
  });

  test('the output passes constraint validation', () => {
    const {model} = convert(QA);
    expect(validatePushRequirements(
               [{document: 'x', model}], {targetOptional: true}))
        .toEqual([]);
  });

  test('an intersection as rdfs:subClassOf is read the same way', () => {
    const {model, constraints, warnings} = convert(`${BASE}
      ex:QAAssuredEngagement rdfs:subClassOf [ a owl:Class ;
          owl:intersectionOf ( ex:Engagement [ a owl:Restriction ;
              owl:onProperty ex:hasHealthCheck ;
              owl:minCardinality 2 ] ) ] .`);
    expect(warnings).toEqual([]);
    expect(entity(model, 'QAAssuredEngagement').extends)
        .toEqual(['Engagement']);
    expect(constraints.map(c => c.name))
        .toEqual(['QAAssuredEngagement_hasHealthCheck_min_2']);
    expect(constraints[0].description).toContain(
        '(From OWL: QAAssuredEngagement SubClassOf Engagement and ' +
        '(hasHealthCheck min 2).)');
  });

  test('nested intersections flatten; unions are dropped; extends dedupes', () => {
    const {model, constraints, warnings} = convert(`${BASE}
      ex:QAAssuredEngagement rdfs:subClassOf ex:Engagement ;
        owl:equivalentClass [ a owl:Class ;
          owl:intersectionOf ( ex:Engagement
            [ a owl:Class ; owl:intersectionOf (
                [ a owl:Restriction ; owl:onProperty ex:hasHealthCheck ;
                  owl:someValuesFrom ex:QAHealthCheck ] ) ]
            [ a owl:Class ; owl:unionOf ( ex:Opportunity ex:Engagement ) ] ) ] .`);
    expect(warnings).toEqual([]);
    expect(entity(model, 'QAAssuredEngagement').extends)
        .toEqual(['Engagement']);
    expect(constraints.map(c => c.name)).toEqual([
      'QAAssuredEngagement_hasHealthCheck_some_QAHealthCheck',
    ]);
  });
});
