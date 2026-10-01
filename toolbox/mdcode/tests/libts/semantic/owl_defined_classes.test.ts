// Behavior specification for OWL defined classes -> defined (virtual)
// entities (src/libts/semantic/converters/owl/definitions.ts, wired in by
// to_ir.ts).
//
// A class with an owl:equivalentClass definition that one row of an existing
// entity can decide becomes a defined entity: `definition.expression` is the
// membership test in SQL over the base's field names, `extends` is its single
// parent, and its equivalentClass restrictions are NOT re-stated as
// constraints (they are the definition). Anything that needs a join -- a
// restriction traversing a relationship -- keeps today's import (extends +
// constraints) with a warning naming the construct.
//
// The ontology below mirrors the prototype's commercial.ttl: a sales-stage
// vocabulary of named individuals with stored codes, an object property
// `inStage` encodedBy the `salesStage` column, and the lifecycle classes.

import {describe, expect, test} from 'bun:test';

import {convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {parseOwl} from '../../../src/libts/semantic/converters/owl/parse';
import {generatePropertyGraph} from '../../../src/libts/semantic/bigquery';
import {loadModels} from '../../../src/libts/semantic/loader';
import {validatePushRequirements} from '../../../src/libts/semantic/validate';

const PREFIXES = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
  @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
  @prefix core: <https://example.org/ontology/core#> .
  @prefix com:  <https://example.org/ontology/commercial#> .
`;

const BASE = `${PREFIXES}
  com:ClientAccount a owl:Class ; owl:hasKey ( com:accountId ) .
  com:accountId a owl:DatatypeProperty ; rdfs:domain com:ClientAccount ;
      rdfs:range xsd:string .
  com:accountTier a owl:DatatypeProperty ; rdfs:domain com:ClientAccount ;
      rdfs:range xsd:string .

  com:Opportunity a owl:Class ; owl:hasKey ( com:opportunityId ) .
  com:opportunityId a owl:DatatypeProperty ; rdfs:domain com:Opportunity ;
      rdfs:range xsd:string .
  com:salesStage a owl:DatatypeProperty ; rdfs:domain com:Opportunity ;
      rdfs:range xsd:string .
  com:totalContractValue a owl:DatatypeProperty ; rdfs:domain com:Opportunity ;
      rdfs:range xsd:decimal .
  com:hasBuyer a owl:ObjectProperty ; rdfs:domain com:Opportunity ;
      rdfs:range com:ClientAccount .

  com:SalesStage a owl:Class ; owl:hasKey ( com:stageCode ) ;
      owl:equivalentClass [ a owl:Class ;
          owl:oneOf ( com:Stage_1 com:Stage_Won com:Stage_Lost ) ] .
  com:stageCode a owl:DatatypeProperty ; rdfs:domain com:SalesStage ;
      rdfs:range xsd:string .
  com:Stage_1    a owl:NamedIndividual , com:SalesStage ; core:code "1" .
  com:Stage_Won  a owl:NamedIndividual , com:SalesStage ; core:code "5_won" .
  com:Stage_Lost a owl:NamedIndividual , com:SalesStage ; core:code "closed_lost" .

  com:inStage a owl:ObjectProperty ; rdfs:domain com:Opportunity ;
      rdfs:range com:SalesStage ; core:encodedBy com:salesStage .
`;

const LIFECYCLE = `${BASE}
  com:WonOpportunity a owl:Class ;
      rdfs:subClassOf com:ClosedOpportunity ;
      skos:definition "An opportunity in the Won stage." ;
      owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( com:Opportunity
          [ a owl:Restriction ; owl:onProperty com:inStage ;
            owl:hasValue com:Stage_Won ] ) ] .
  com:LostOpportunity a owl:Class ;
      rdfs:subClassOf com:ClosedOpportunity ;
      owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( com:Opportunity
          [ a owl:Restriction ; owl:onProperty com:inStage ;
            owl:hasValue com:Stage_Lost ] ) ] .
  com:ClosedOpportunity a owl:Class ;
      rdfs:subClassOf com:Opportunity ;
      owl:equivalentClass [ a owl:Class ;
          owl:unionOf ( com:WonOpportunity com:LostOpportunity ) ] .
  com:ActivePipeline a owl:Class ;
      rdfs:subClassOf com:Opportunity ;
      owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( com:Opportunity
          [ a owl:Class ; owl:complementOf com:ClosedOpportunity ] ) ] .
  com:HighValueOpportunity a owl:Class ;
      rdfs:subClassOf com:Opportunity ;
      owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( com:Opportunity
          [ a owl:Restriction ; owl:onProperty com:totalContractValue ;
            owl:someValuesFrom [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ;
                owl:withRestrictions ( [ xsd:minInclusive "1000"^^xsd:decimal ] ) ] ] ) ] .
  com:MegaDeal a owl:Class ;
      rdfs:subClassOf com:HighValueOpportunity ;
      owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( com:Opportunity
          [ a owl:Restriction ; owl:onProperty com:totalContractValue ;
            owl:someValuesFrom [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ;
                owl:withRestrictions ( [ xsd:minInclusive "20000"^^xsd:decimal ] ) ] ] ) ] .
  com:StrategicAccount a owl:Class ;
      rdfs:subClassOf com:ClientAccount ;
      owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( com:ClientAccount
          [ a owl:Restriction ; owl:onProperty com:accountTier ;
            owl:someValuesFrom [ a rdfs:Datatype ;
                owl:oneOf ( "Diamond" "Tier 1 Global" ) ] ] ) ] .
  com:PriorityOpportunity a owl:Class ;
      rdfs:subClassOf com:Opportunity ;
      owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( com:Opportunity
          [ a owl:Class ; owl:unionOf ( com:HighValueOpportunity
              [ a owl:Restriction ; owl:onProperty com:hasBuyer ;
                owl:someValuesFrom com:StrategicAccount ] ) ] ) ] .
`;

function convert(ttl: string) {
  const r = convertOwlToOsi(ttl, 'sales');
  const model = loadModels(r.yaml, {bindingOptional: true}).models[0];
  return {...r, model};
}

const entity = (model: ReturnType<typeof convert>['model'], name: string) =>
    model.entities.find(e => e.name === name)!;

describe('parsing', () => {
  test('individual codes and encodedBy are read', () => {
    const owl = parseOwl(BASE);
    expect(owl.individualCodes).toMatchObject({
      'https://example.org/ontology/commercial#Stage_Won': '5_won',
      'https://example.org/ontology/commercial#Stage_Lost': 'closed_lost',
    });
    expect(owl.objectProperties.find(p => p.localName === 'inStage')!.encodedBy)
        .toBe('salesStage');
  });

  test('a top-level oneOf (a closed vocabulary) is not a definition', () => {
    const owl = parseOwl(BASE);
    expect(owl.classes.find(c => c.localName === 'SalesStage')!.definitions)
        .toBeUndefined();
  });
});

describe('the lifecycle classes', () => {
  const r = convert(LIFECYCLE);

  test('hasValue on an encodedBy object property compares the code', () => {
    const won = entity(r.model, 'WonOpportunity');
    expect(won.definition).toEqual({expression: `LOWER(salesStage) = '5_won'`});
    // The most specific defined class over the same base is the parent.
    expect(won.extends).toEqual(['ClosedOpportunity']);
    expect(won.dataSource).toBe('');
    expect(won.description).toContain('An opportunity in the Won stage.');
  });

  test('a union of defined classes expands their definitions', () => {
    const closed = entity(r.model, 'ClosedOpportunity');
    expect(closed.definition).toEqual({
      expression: `LOWER(salesStage) = '5_won' OR LOWER(salesStage) = 'closed_lost'`,
    });
    expect(closed.extends).toEqual(['Opportunity']);
  });

  test('a complement becomes NOT (...)', () => {
    expect(entity(r.model, 'ActivePipeline').definition).toEqual({
      expression: `NOT (LOWER(salesStage) = '5_won' OR LOWER(salesStage) = 'closed_lost')`,
    });
  });

  test('datatype facets become range tests; chains keep their parent', () => {
    expect(entity(r.model, 'HighValueOpportunity').definition)
        .toEqual({expression: 'totalContractValue >= 1000'});
    const mega = entity(r.model, 'MegaDeal');
    expect(mega.definition).toEqual({expression: 'totalContractValue >= 20000'});
    expect(mega.extends).toEqual(['HighValueOpportunity']);
  });

  test('a data enumeration becomes IN (...)', () => {
    const s = entity(r.model, 'StrategicAccount');
    expect(s.definition)
        .toEqual({expression: `accountTier IN ('Diamond', 'Tier 1 Global')`});
    expect(s.extends).toEqual(['ClientAccount']);
  });

  test('a restriction that traverses a relationship falls back, warned', () => {
    const p = entity(r.model, 'PriorityOpportunity');
    expect(p.definition).toBeUndefined();
    expect(p.extends).toEqual(['Opportunity']);
    expect(r.warnings).toContain(
        `class 'PriorityOpportunity': its owl:equivalentClass definition was ` +
        `not compiled to a defined entity (unsupported: a restriction on ` +
        `object property 'hasBuyer', which traverses a relationship and has ` +
        `no encodedBy code column on 'Opportunity'); imported as a subclass ` +
        `with constraints instead.`);
  });

  test('compiled definitions are not restated as constraints', () => {
    const names = (r.model.constraints ?? []).map(c => c.name);
    for (const cls of ['WonOpportunity', 'LostOpportunity',
                       'HighValueOpportunity', 'MegaDeal', 'StrategicAccount']) {
      expect(names.filter(n => n.startsWith(`${cls}_`))).toEqual([]);
    }
  });

  test('the imported model validates', () => {
    expect(validatePushRequirements(
               [{document: 'sales', model: r.model}], {targetOptional: true}))
        .toEqual([]);
  });

  test('the YAML carries `defined`', () => {
    expect(r.yaml).toContain(`defined:`);
    expect(r.yaml).toContain(`LOWER(salesStage) = '5_won'`);
  });
});

describe('codes', () => {
  test('an individual with no stored code uses its local name, warned', () => {
    const r = convert(`${BASE}
      com:Stage_X a owl:NamedIndividual , com:SalesStage .
      com:XOpportunity a owl:Class ; rdfs:subClassOf com:Opportunity ;
          owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( com:Opportunity
              [ a owl:Restriction ; owl:onProperty com:inStage ;
                owl:hasValue com:Stage_X ] ) ] .`);
    expect(entity(r.model, 'XOpportunity').definition)
        .toEqual({expression: `LOWER(salesStage) = 'stage_x'`});
    expect(r.warnings).toContain(
        `class 'XOpportunity': individual 'Stage_X' has no code (core:code / ` +
        `skos:notation); its local name is used in the definition.`);
  });

  test('skos:notation is a code too', () => {
    const owl = parseOwl(`${BASE}
      com:Stage_N a owl:NamedIndividual , com:SalesStage ; skos:notation "N9" .`);
    expect(owl.individualCodes?.['https://example.org/ontology/commercial#Stage_N'])
        .toBe('N9');
  });
});

describe('end to end', () => {
  test('bound to a table, the defined class lowers to a graph property', () => {
    const {model} = convert(LIFECYCLE);
    // Bind Opportunity (the import is logical) to a table.
    const opp = entity(model, 'Opportunity');
    opp.dataSource = 'sqlgen-testing.demo.opportunity';
    for (const f of opp.fields) f.expression = f.name.replace(/[A-Z]/g, c => `_${c.toLowerCase()}`);
    model.entities = model.entities.filter(
        e => e.name === 'Opportunity' || e.definition?.expression.includes('salesStage'));
    model.relationships = [];
    model.constraints = [];
    const {ddl} = generatePropertyGraph(model, {project: 'sqlgen-testing', dataset: 'demo'});
    // Won's parent is the defined ClosedOpportunity, so its membership is the
    // chain's conjunction (redundant but exact: Won implies Closed).
    expect(ddl).toContain(
        `COALESCE((LOWER(sales_stage) = '5_won' OR LOWER(sales_stage) = 'closed_lost') AND ` +
        `(LOWER(sales_stage) = '5_won'), FALSE) AS isWonOpportunity`);
    expect(ddl).toContain(
        `COALESCE(LOWER(sales_stage) = '5_won' OR LOWER(sales_stage) = 'closed_lost', FALSE) AS isClosedOpportunity`);
    expect(ddl).toContain(
        `COALESCE(NOT (LOWER(sales_stage) = '5_won' OR LOWER(sales_stage) = 'closed_lost'), FALSE) AS isActivePipeline`);
    expect(ddl).toContain('True when this Opportunity is an ActivePipeline');
  });
});
