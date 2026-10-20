// Behavior specification for keys and fields across the class hierarchy
// (src/libts/semantic/converters/owl/{folds,to_ir,vocabularies}.ts):
//
//   - the equivalent-class fold runs before encodedBy joins, so an edge whose
//     range is an unkeyed equivalent joins to the keyed class's key;
//   - an inverse-functional property on a category whose subclasses declare
//     their own keys stays a unique key (it is not promoted to the category's
//     primary key, so the category stays abstract), every concrete subclass
//     inherits it as a unique key, and the abstract category keeps none;
//   - a vocabulary does not extend a parent that carries fields (its rows are
//     its members, read through fixed columns); a warning and a dropped
//     rdfs:subClassOf coverage row say so.

import {describe, expect, test} from 'bun:test';

import {convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {loadModels} from '../../../src/libts/semantic/loader';

const PREFIXES = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
  @prefix core: <https://example.org/core#> .
  @prefix com:  <https://example.org/commercial#> .
  @prefix fin:  <https://example.org/finance#> .
`;

function convert(ttl: string) {
  const r = convertOwlToOsi(ttl, 'x');
  const model = loadModels(r.yaml, {bindingOptional: true}).models[0];
  const entity = (name: string) => model.entities.find(e => e.name === name)!;
  const rel = (name: string) => model.relationships.find(x => x.name === name)!;
  return {...r, model, entity, rel};
}

describe('fold before encodedBy joins', () => {
  test('an edge into an unkeyed equivalent joins to the keyed class key', () => {
    const ttl = `${PREFIXES}
      core:encodedBy a owl:AnnotationProperty .
      com:ClientAccount a owl:Class ; owl:hasKey ( com:accountId ) .
      fin:Counterparty a owl:Class ; owl:equivalentClass com:ClientAccount .
      fin:Invoice a owl:Class ; owl:hasKey ( fin:invoiceId ) .
      fin:invoiceId a owl:DatatypeProperty ; rdfs:domain fin:Invoice ;
          rdfs:range xsd:string .
      com:accountId a owl:DatatypeProperty ; rdfs:range xsd:string ;
          rdfs:domain [ owl:unionOf ( com:ClientAccount fin:Invoice ) ] .
      fin:hasPayer a owl:ObjectProperty ; rdfs:domain fin:Invoice ;
          rdfs:range fin:Counterparty ; core:encodedBy com:accountId .
    `;
    const r = convert(ttl).rel('hasPayer');
    expect(r.source).toEqual({entity: 'Invoice', columns: ['accountId']});
    expect(r.destination)
        .toEqual({entity: 'ClientAccount', columns: ['accountId']});
  });
});

// The prototype's org units: OrgUnit declares no key but an
// inverse-functional name; its data subclasses declare their own keys; a
// vocabulary subclass lists the regions.
const ORG = `${PREFIXES}
  core:vocabulary a owl:AnnotationProperty .
  core:OrgUnit a owl:Class .
  core:MarketUnit a owl:Class ; rdfs:subClassOf core:OrgUnit ;
      owl:hasKey ( core:marketUnitCode ) .
  core:ServiceGroup a owl:Class ; rdfs:subClassOf core:OrgUnit ;
      owl:hasKey ( core:serviceGroupCode ) .
  core:GeographicRegion a owl:Class ; rdfs:subClassOf core:OrgUnit ;
      core:vocabulary true ; owl:hasKey ( core:regionCode ) ;
      owl:equivalentClass [ a owl:Class ;
          owl:oneOf ( core:Region_NA core:Region_EMEA ) ] .
  core:unitName a owl:DatatypeProperty , owl:InverseFunctionalProperty ;
      rdfs:domain core:OrgUnit ; rdfs:range xsd:string .
  core:marketUnitCode a owl:DatatypeProperty ; rdfs:domain core:MarketUnit ;
      rdfs:range xsd:string .
  core:serviceGroupCode a owl:DatatypeProperty ;
      rdfs:domain core:ServiceGroup ; rdfs:range xsd:string .
  core:regionCode a owl:DatatypeProperty ; rdfs:domain core:GeographicRegion ;
      rdfs:range xsd:string .
`;

describe('unique keys down the hierarchy', () => {
  test('the category passes the property down and keeps no key itself',
       () => {
         const org = convert(ORG).entity('OrgUnit');
         expect(org.keys).toEqual([]);
         // An abstract entity has no table, so it declares no key; its
         // concrete subclasses carry the unique key instead.
         expect(org.uniqueKeys).toBeUndefined();
         expect(org.abstract).toBe(true);
       });

  test('each concrete subclass inherits the unique key', () => {
    const {entity} = convert(ORG);
    expect(entity('MarketUnit').keys).toEqual(['marketUnitCode']);
    expect(entity('MarketUnit').uniqueKeys).toEqual([['unitName']]);
    expect(entity('ServiceGroup').uniqueKeys).toEqual([['unitName']]);
  });

  test('coverage reports the key on the concrete subclasses', () => {
    const row = convert(ORG).coverage.find(
        e => e.construct === 'owl:InverseFunctionalProperty' &&
            e.subject === 'OrgUnit.unitName');
    expect(row).toMatchObject({
      outcome: 'compiled',
      target: 'entity MarketUnit unique_keys, entity ServiceGroup unique_keys',
    });
    expect(row!.reason).toContain(`'OrgUnit' is abstract (no table)`);
  });

  test('an abstract class passes its owl:hasKey down the same way', () => {
    // kcmd:abstract true over owl:hasKey: the subclass with no key of its own
    // takes the key as its primary key, one keyed otherwise as a unique key.
    const ttl = `${PREFIXES}
      @prefix kcmd: <https://kcmd.dev/ns#> .
      core:Account a owl:Class ; owl:hasKey ( core:accountId ) ;
          kcmd:abstract true .
      core:Client a owl:Class ; rdfs:subClassOf core:Account .
      core:Partner a owl:Class ; rdfs:subClassOf core:Account ;
          owl:hasKey ( core:partnerId ) .
      core:accountId a owl:DatatypeProperty ; rdfs:domain core:Account ;
          rdfs:range xsd:string .
      core:partnerId a owl:DatatypeProperty ; rdfs:domain core:Partner ;
          rdfs:range xsd:string .
    `;
    const {entity, warnings, coverage} = convert(ttl);
    expect(entity('Account').abstract).toBe(true);
    expect(entity('Account').keys).toEqual([]);
    expect(entity('Account').uniqueKeys).toBeUndefined();
    expect(entity('Client').keys).toEqual(['accountId']);
    expect(entity('Partner').keys).toEqual(['partnerId']);
    expect(entity('Partner').uniqueKeys).toEqual([['accountId']]);
    expect(warnings).toEqual([]);
    expect(coverage.find(
               e => e.construct === 'owl:hasKey' &&
                   e.subject === 'Account HasKey (accountId)'))
        .toMatchObject({
          outcome: 'compiled',
          target: 'entity Client primary_key, entity Partner unique_keys',
        });
  });

  test('a vocabulary subclass does not inherit it', () => {
    expect(convert(ORG).entity('GeographicRegion').uniqueKeys).toBeUndefined();
  });

  test('a single inverse-functional property still keys a class with no ' +
           'keyed subclass',
       () => {
         const ttl = `${PREFIXES}
           core:Unit a owl:Class .
           core:Team a owl:Class ; rdfs:subClassOf core:Unit .
           core:unitName a owl:DatatypeProperty , owl:InverseFunctionalProperty ;
               rdfs:domain core:Unit ; rdfs:range xsd:string .
         `;
         const {entity} = convert(ttl);
         expect(entity('Unit').keys).toEqual(['unitName']);
         expect(entity('Unit').abstract).toBeUndefined();
         expect(entity('Team').uniqueKeys).toBeUndefined();
       });
});

describe('a vocabulary does not inherit fields', () => {
  test('it does not extend a parent that carries fields', () => {
    const {entity, warnings} = convert(ORG);
    const region = entity('GeographicRegion');
    expect(region.members?.map(m => m.code)).toEqual(['Region_NA', 'Region_EMEA']);
    expect(region.extends).toBeUndefined();
    expect(entity('MarketUnit').extends).toEqual(['OrgUnit']);
    expect(warnings).toContain(
        `class 'GeographicRegion' is a vocabulary, so it does not extend ` +
        `'OrgUnit': a vocabulary's rows are its members (code, label, sort ` +
        `order), which carry none of the fields it would inherit.`);
  });

  test('a parent with no fields is kept', () => {
    const ttl = `${PREFIXES}
      core:vocabulary a owl:AnnotationProperty .
      core:Category a owl:Class .
      core:Region a owl:Class ; rdfs:subClassOf core:Category ;
          owl:oneOf ( core:NA core:EMEA ) .
    `;
    expect(convert(ttl).entity('Region').extends).toEqual(['Category']);
  });

  test('coverage reports the dropped subclass axiom', () => {
    const row = convert(ORG).coverage.find(
        e => e.construct === 'rdfs:subClassOf' &&
            e.subject === 'GeographicRegion SubClassOf OrgUnit');
    expect(row).toMatchObject({outcome: 'dropped'});
    expect(row!.reason).toContain('is a vocabulary, so it does not extend');
  });
});
