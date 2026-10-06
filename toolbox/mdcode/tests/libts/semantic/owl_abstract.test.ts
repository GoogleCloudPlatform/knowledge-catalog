// Behavior specification for abstract classes by structure
// (src/libts/semantic/converters/owl/{abstract,parse,coverage}.ts):
//
//   - a class with no owl:hasKey (own or inherited) that has subclasses is a
//     category, not a table: `abstract: true` (a label on its subtypes);
//   - a keyless LEAF class stays a concrete entity with an empty key, and the
//     coverage report lists it;
//   - a keyed class, or one inheriting a key, is never made abstract;
//   - `kcmd:abstract true|false` (https://kcmd.dev/ns#abstract) overrides the
//     rule either way; vocabularies and defined entities are never abstract.

import {describe, expect, test} from 'bun:test';

import {convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {parseOwl} from '../../../src/libts/semantic/converters/owl/parse';
import {loadModels} from '../../../src/libts/semantic/loader';

const PREFIXES = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
  @prefix kcmd: <https://kcmd.dev/ns#> .
  @prefix ex:   <https://example.org/x#> .
`;

const PARTIES = `${PREFIXES}
  ex:Party a owl:Class .
  ex:Organization a owl:Class ; rdfs:subClassOf ex:Party .
  ex:ClientAccount a owl:Class ; rdfs:subClassOf ex:Organization ;
      owl:hasKey ( ex:accountId ) .
  ex:KeyAccount a owl:Class ; rdfs:subClassOf ex:ClientAccount .
  ex:Note a owl:Class .
  ex:accountId a owl:DatatypeProperty ; rdfs:domain ex:ClientAccount ;
      rdfs:range xsd:string .
`;

function convert(ttl: string) {
  const r = convertOwlToOsi(ttl, 'x');
  const model = loadModels(r.yaml, {bindingOptional: true}).models[0];
  const abstract = (name: string) =>
      model.entities.find(e => e.name === name)!.abstract === true;
  return {...r, model, abstract};
}

describe('a keyless class with subclasses is abstract', () => {
  test('keyless parents become abstract; keyed and leaf classes do not', () => {
    const {abstract} = convert(PARTIES);
    expect(abstract('Party')).toBe(true);
    expect(abstract('Organization')).toBe(true);
    expect(abstract('ClientAccount')).toBe(false);
    // Inherits ClientAccount's key.
    expect(abstract('KeyAccount')).toBe(false);
    // A keyless leaf stays concrete.
    expect(abstract('Note')).toBe(false);
  });

  test('the import adds no warning for it', () => {
    expect(convert(PARTIES).warnings).toEqual([]);
  });

  test('a keyed class with subclasses is not abstract', () => {
    const ttl = `${PREFIXES}
      ex:Deal a owl:Class ; owl:hasKey ( ex:dealId ) .
      ex:BigDeal a owl:Class ; rdfs:subClassOf ex:Deal .
      ex:dealId a owl:DatatypeProperty ; rdfs:domain ex:Deal ;
          rdfs:range xsd:string .
    `;
    expect(convert(ttl).abstract('Deal')).toBe(false);
  });

  test('a defined entity does not make its keyless parent concrete', () => {
    const ttl = `${PREFIXES}
      ex:Deal a owl:Class .
      ex:amount a owl:DatatypeProperty ; rdfs:domain ex:Deal ;
          rdfs:range xsd:decimal .
      ex:BigDeal a owl:Class ;
          owl:equivalentClass [ owl:intersectionOf ( ex:Deal
              [ a owl:Restriction ; owl:onProperty ex:amount ;
                owl:someValuesFrom [ a rdfs:Datatype ;
                    owl:onDatatype xsd:decimal ;
                    owl:withRestrictions ( [ xsd:minInclusive "1000"^^xsd:decimal ] ) ] ] ) ] .
    `;
    const {model, abstract} = convert(ttl);
    expect(model.entities.find(e => e.name === 'BigDeal')!.definition)
        .toBeDefined();
    expect(abstract('BigDeal')).toBe(false);
    expect(abstract('Deal')).toBe(true);
  });
});

describe('kcmd:abstract overrides the rule', () => {
  test('the parser reads the boolean', () => {
    const ttl = `${PREFIXES}
      ex:A a owl:Class ; kcmd:abstract true .
      ex:B a owl:Class ; kcmd:abstract "false"^^<http://www.w3.org/2001/XMLSchema#boolean> .
      ex:C a owl:Class .
    `;
    const cls = parseOwl(ttl).classes;
    expect(cls.map(c => c.abstract)).toEqual([true, false, undefined]);
  });

  test('true makes a keyless leaf abstract', () => {
    const ttl = `${PARTIES}  ex:Note kcmd:abstract true .`;
    expect(convert(ttl).abstract('Note')).toBe(true);
  });

  test('false keeps a keyless parent concrete', () => {
    const ttl = `${PARTIES}  ex:Organization kcmd:abstract false .`;
    const {abstract} = convert(ttl);
    expect(abstract('Organization')).toBe(false);
    expect(abstract('Party')).toBe(true);
  });

  test('true on a vocabulary is warned and ignored', () => {
    const ttl = `${PREFIXES}
      ex:Color a owl:Class ; owl:oneOf ( ex:Red ex:Blue ) ; kcmd:abstract true .
    `;
    const {abstract, warnings} = convert(ttl);
    expect(abstract('Color')).toBe(false);
    expect(warnings).toContain(
        `class 'Color' is annotated kcmd:abstract true but is a vocabulary; ` +
        `the annotation is ignored.`);
  });
});

describe('coverage lists abstract and keyless classes', () => {
  const find = (ttl: string, construct: string, subject: string) =>
      convertOwlToOsi(ttl, 'x').coverage.find(
          e => e.construct === construct && e.subject === subject);

  test('abstract by structure is compiled', () => {
    expect(find(PARTIES, 'owl:hasKey (absent)', 'Party')).toEqual({
      construct: 'owl:hasKey (absent)',
      subject: 'Party',
      outcome: 'compiled',
      target: 'entity Party abstract',
      reason: 'no key (own or inherited) and has subclasses: a label on its ' +
          'subtypes, not a table',
    });
  });

  test('a keyless leaf is reported', () => {
    expect(find(PARTIES, 'owl:hasKey (absent)', 'Note')).toMatchObject({
      outcome: 'dropped',
    });
    expect(find(PARTIES, 'owl:hasKey (absent)', 'KeyAccount')).toBeUndefined();
  });

  test('the override is compiled', () => {
    expect(find(`${PARTIES} ex:Note kcmd:abstract true .`, 'kcmd:abstract',
                'Note'))
        .toMatchObject({outcome: 'compiled', target: 'entity Note abstract'});
    expect(find(`${PARTIES} ex:Party kcmd:abstract false .`, 'kcmd:abstract',
                'Party'))
        .toMatchObject({outcome: 'compiled', target: 'entity Party (concrete)'});
  });
});
