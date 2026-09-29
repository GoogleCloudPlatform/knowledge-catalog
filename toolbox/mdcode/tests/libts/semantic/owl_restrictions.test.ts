// Behavior specification for OWL axioms -> semantic-model constraints
// (src/libts/semantic/converters/owl/constraints.ts, wired in by to_ir.ts).
//
// An ontology's rule-stating axioms -- property restrictions, functional object
// properties, class disjointness -- map onto NATIVE model-level constraints
// (a named judgment with an on_violation and optional severity), never onto an
// opaque carrier. These tests pin each mapping, the enforcement-facet
// annotations (kcmd:severity / kcmd:onViolation) and their precedence, what is
// dropped as structurally guaranteed, what is warned and skipped, and that the
// output stays loadable and passes constraint validation.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {parseOwl} from '../../../src/libts/semantic/converters/owl/parse';
import {Constraint} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';
import {validatePushRequirements} from '../../../src/libts/semantic/validate';

const FIXTURES = path.join(__dirname, 'fixtures', 'owl');
const readFixture = (name: string) =>
    fs.readFileSync(path.join(FIXTURES, name), 'utf8');

const PREFIXES = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
  @prefix kcmd: <https://kcmd.dev/ns#> .
  @prefix ex:   <http://example.com/x#> .
`;

// A two-class base: Opportunity -hasBuyer-> Account, with an id field.
const BASE = `${PREFIXES}
  ex:Opportunity a owl:Class .
  ex:Account a owl:Class .
  ex:Big a owl:Class ; rdfs:subClassOf ex:Account .
  ex:oppId a owl:DatatypeProperty ; rdfs:domain ex:Opportunity ;
      rdfs:range xsd:string .
  ex:hasBuyer a owl:ObjectProperty ; rdfs:domain ex:Opportunity ;
      rdfs:range ex:Account .
`;

function convert(ttl: string) {
  const r = convertOwlToOsi(ttl, 'x');
  const model = loadModels(r.yaml, {bindingOptional: true}).models[0];
  return {...r, model, constraints: model.constraints ?? []};
}

const byName = (cs: Constraint[], name: string) =>
    cs.find(c => c.name === name);

function restricted(body: string): string {
  return `${BASE}
    ex:Opportunity rdfs:subClassOf [ a owl:Restriction ;
        owl:onProperty ${body} ] .`;
}


describe('the constraints fixture', () => {
  test('produces exactly the documented OSI (golden)', () => {
    const r = convertOwlToOsi(readFixture('constraints.owl.ttl'), 'deals');
    expect(r.yaml).toEqual(readFixture('constraints.osi.golden.yaml'));
    expect(r.warnings).toEqual([
      `restriction 'Opportunity SubClassOf hasBuyer some [anonymous]': the ` +
          `filler is an anonymous class expression, which has no name to ` +
          `state a rule about; skipped.`,
      `restriction 'Opportunity SubClassOf ghost some Party': 'ghost' is ` +
          `neither a relationship (or a relationship's inverse) nor a field ` +
          `of 'Opportunity' (or its supertypes) in the imported model; ` +
          `skipped.`,
      `functional property 'suppliedBy': kcmd:onViolation 'block' is not ` +
          `one of reject, escalate, warn; ignored.`,
    ]);
  });

  test('loads, and every judgment passes constraint validation', () => {
    const {model} = convert(readFixture('constraints.owl.ttl'));
    expect(model.constraints?.length).toBe(9);
    expect(validatePushRequirements(
               [{document: 'constraints', model}], {targetOptional: true}))
        .toEqual([]);
  });
});


describe('object-property restrictions become relationship rules', () => {
  test('qualified exactly 1', () => {
    const {constraints} = convert(restricted(`ex:hasBuyer ;
        owl:qualifiedCardinality "1"^^xsd:nonNegativeInteger ;
        owl:onClass ex:Account`));
    expect(constraints).toEqual([{
      name: 'Opportunity_hasBuyer_exactly_1',
      judgment: 'Each Opportunity has exactly one hasBuyer relationship to an ' +
          'Account. An Opportunity with no hasBuyer relationship to an ' +
          'Account, or with more than one, does not satisfy this rule.',
      description: 'Link each Opportunity to exactly one Account through ' +
          'hasBuyer. (From OWL: Opportunity SubClassOf hasBuyer exactly 1 ' +
          'Account.)',
      onViolation: 'warn',
    }]);
  });

  test('min / max / exactly N name the count', () => {
    const names = (body: string) =>
        convert(restricted(body)).constraints.map(c => c.name);
    expect(names('ex:hasBuyer ; owl:minCardinality 2'))
        .toEqual(['Opportunity_hasBuyer_min_2']);
    expect(names('ex:hasBuyer ; owl:maxCardinality 3'))
        .toEqual(['Opportunity_hasBuyer_max_3']);
    expect(names('ex:hasBuyer ; owl:cardinality 2'))
        .toEqual(['Opportunity_hasBuyer_exactly_2']);
    expect(names('ex:hasBuyer ; owl:maxCardinality 0'))
        .toEqual(['Opportunity_hasBuyer_max_0']);
  });

  test('someValuesFrom and allValuesFrom a subclass of the range', () => {
    const some = convert(restricted('ex:hasBuyer ; owl:someValuesFrom ex:Big'));
    expect(some.constraints[0].name).toBe('Opportunity_hasBuyer_some_Big');
    expect(some.constraints[0].judgment)
        .toContain('has at least one hasBuyer relationship to a Big');
    const only = convert(restricted('ex:hasBuyer ; owl:allValuesFrom ex:Big'));
    expect(only.constraints[0].name).toBe('Opportunity_hasBuyer_only_Big');
    expect(only.constraints[0].judgment)
        .toContain('Every hasBuyer relationship from an Opportunity leads to a Big');
  });

  test('a restriction on a supertype-declared edge applies to the subclass', () => {
    const {constraints, warnings} = convert(`${BASE}
      ex:Won a owl:Class ; rdfs:subClassOf ex:Opportunity ;
          rdfs:subClassOf [ a owl:Restriction ; owl:onProperty ex:hasBuyer ;
                            owl:someValuesFrom ex:Big ] .`);
    expect(warnings).toEqual([]);
    expect(constraints.map(c => c.name)).toEqual(['Won_hasBuyer_some_Big']);
  });

  test('an edge that does not start at the class is warned and skipped', () => {
    const {constraints, warnings} = convert(`${BASE}
      ex:Account rdfs:subClassOf [ a owl:Restriction ;
          owl:onProperty ex:hasBuyer ; owl:minCardinality 1 ] .`);
    expect(constraints).toEqual([]);
    expect(warnings[0]).toMatch(/starts at 'Opportunity', not at 'Account'/);
  });
});


describe('datatype-property restrictions become field rules', () => {
  test('min 1 / someValuesFrom -> required', () => {
    for (const body of ['ex:oppId ; owl:minCardinality 1',
                        'ex:oppId ; owl:someValuesFrom xsd:string',
                        'ex:oppId ; owl:cardinality 1']) {
      const {constraints} = convert(restricted(body));
      expect(constraints.map(c => c.name))
          .toEqual(['Opportunity_oppId_required']);
      expect(constraints[0].judgment)
          .toBe('Every Opportunity has a value for Opportunity.oppId. An ' +
                'Opportunity whose Opportunity.oppId is null or missing does ' +
                'not satisfy this rule.');
    }
  });

  test('hasValue -> a fixed value; rdfs:comment is the description', () => {
    const {constraints} = convert(restricted(`ex:oppId ; owl:hasValue "A1" ;
        rdfs:comment "Only the A1 series is tracked."`));
    expect(constraints[0].name).toBe('Opportunity_oppId_value_A1');
    expect(constraints[0].description)
        .toBe('Only the A1 series is tracked. (From OWL: Opportunity ' +
              'SubClassOf oppId value \'A1\'.)');
  });

  test('what a scalar field already guarantees is dropped silently', () => {
    for (const body of ['ex:oppId ; owl:maxCardinality 1',
                        'ex:oppId ; owl:allValuesFrom xsd:string',
                        'ex:oppId ; owl:minCardinality 0']) {
      const {constraints, warnings} = convert(restricted(body));
      expect(constraints).toEqual([]);
      expect(warnings).toEqual([]);
    }
  });

  test('a datatype minimum above one is warned and skipped', () => {
    const {constraints, warnings} =
        convert(restricted('ex:oppId ; owl:minCardinality 2'));
    expect(constraints).toEqual([]);
    expect(warnings[0]).toMatch(/holds one value, so a minimum of 2/);
  });
});


describe('functional properties and disjointness', () => {
  test('a functional object property bounds its edge to one', () => {
    const {constraints} = convert(`${BASE}
      ex:hasBuyer a owl:FunctionalProperty .`);
    expect(byName(constraints, 'Opportunity_hasBuyer_functional')?.judgment)
        .toBe('Each Opportunity has at most one hasBuyer relationship. An ' +
              'Opportunity with more than one does not satisfy this rule.');
  });

  test('is not restated when a restriction already bounds the edge', () => {
    const {constraints} = convert(`${restricted(
        'ex:hasBuyer ; owl:maxCardinality 1')}
      ex:hasBuyer a owl:FunctionalProperty .`);
    expect(constraints.map(c => c.name)).toEqual(['Opportunity_hasBuyer_max_1']);
  });

  test('a functional datatype property is a scalar field already', () => {
    const {constraints} = convert(`${BASE}
      ex:oppId a owl:FunctionalProperty .`);
    expect(constraints).toEqual([]);
  });

  test('disjointWith pairs are deduped; set members are not restated', () => {
    const {constraints} = convert(`${BASE}
      ex:Opportunity owl:disjointWith ex:Account .
      ex:Account owl:disjointWith ex:Opportunity .
      ex:A a owl:Class . ex:B a owl:Class . ex:C a owl:Class .
      ex:A owl:disjointWith ex:B .
      [] a owl:AllDisjointClasses ; owl:members ( ex:A ex:B ex:C ) .`);
    expect(constraints.map(c => c.name)).toEqual([
      'Opportunity_disjoint_Account',
      'A_B_C_disjoint',
    ]);
  });

  test('an unknown member is left out of a set rule, with a warning', () => {
    const {constraints, warnings} = convert(`${BASE}
      [] a owl:AllDisjointClasses ;
         owl:members ( ex:Opportunity ex:Account ex:Nope ) .`);
    expect(constraints.map(c => c.name))
        .toEqual(['Opportunity_Account_disjoint']);
    expect(warnings[0]).toMatch(/'Nope' is not a class/);
  });
});


describe('kcmd enforcement annotations', () => {
  test('restriction > class > property, per facet', () => {
    const {constraints} = convert(`${BASE}
      ex:Opportunity kcmd:severity "critical" ; kcmd:onViolation "escalate" .
      ex:hasBuyer kcmd:severity "low" .
      ex:Opportunity rdfs:subClassOf [ a owl:Restriction ;
          owl:onProperty ex:hasBuyer ; owl:minCardinality 1 ;
          kcmd:onViolation "reject" ] .`);
    expect(constraints[0].onViolation).toBe('reject');  // restriction
    expect(constraints[0].severity).toBe('critical');   // class over property
  });

  test('defaults: on_violation warn, no severity', () => {
    const {constraints} =
        convert(restricted('ex:hasBuyer ; owl:minCardinality 1'));
    expect(constraints[0].onViolation).toBe('warn');
    expect(constraints[0].severity).toBeUndefined();
  });

  test('an invalid value is warned and ignored', () => {
    const {constraints, warnings} = convert(`${BASE}
      ex:Opportunity rdfs:subClassOf [ a owl:Restriction ;
          owl:onProperty ex:hasBuyer ; owl:minCardinality 1 ;
          kcmd:severity "urgent" ] .`);
    expect(constraints[0].severity).toBeUndefined();
    expect(warnings[0]).toMatch(/kcmd:severity 'urgent' is not one of/);
  });
});


describe('parsing', () => {
  test('restriction nodes are recorded on the class; others are not', () => {
    const owl = parseOwl(`${BASE}
      ex:Opportunity owl:equivalentClass [ a owl:Restriction ;
          owl:onProperty ex:oppId ; owl:hasValue "x" ] ;
        rdfs:subClassOf [ owl:intersectionOf ( ex:Account ex:Big ) ] .`);
    const opp = owl.classes.find(c => c.localName === 'Opportunity')!;
    expect(opp.restrictions).toEqual([{
      via: 'equivalentClass',
      property: 'http://example.com/x#oppId',
      kind: 'value',
      value: 'x',
      qualified: false,
    }]);
  });

  test('names are unique even when two axioms derive the same one', () => {
    const {constraints} = convert(`${BASE}
      ex:Opportunity rdfs:subClassOf
        [ a owl:Restriction ; owl:onProperty ex:hasBuyer ; owl:minCardinality 1 ],
        [ a owl:Restriction ; owl:onProperty ex:hasBuyer ;
          owl:minQualifiedCardinality 1 ; owl:onClass ex:Account ] .`);
    expect(constraints.map(c => c.name))
        .toEqual(['Opportunity_hasBuyer_min_1', 'Opportunity_hasBuyer_min_1_2']);
  });
});
