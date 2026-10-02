// Behavior specification for OWL annotations and property characteristics that
// map onto native ai_context / description slots
// (src/libts/semantic/converters/owl/annotations.ts):
//   owl:equivalentClass / owl:equivalentProperty (named) -> synonyms
//   owl:deprecated (+ rdfs:seeAlso)                      -> DEPRECATED + instruction
//   owl:TransitiveProperty                              -> quantified-path instruction
//   owl:SymmetricProperty                               -> undirected-match instruction

import {describe, expect, test} from 'bun:test';

import {convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {loadModels} from '../../../src/libts/semantic/loader';

const PREFIXES = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
  @prefix schema: <https://schema.org/> .
  @prefix ex:   <http://example.com/x#> .
`;

function convert(ttl: string) {
  const r = convertOwlToOsi(`${PREFIXES}${ttl}`, 'x');
  const model = loadModels(r.yaml, {bindingOptional: true}).models[0];
  return {...r, model};
}

describe('equivalences become synonyms', () => {
  test('owl:equivalentClass adds the referent name and its label', () => {
    const {model, warnings} = convert(`
      ex:Client a owl:Class ; owl:equivalentClass ex:Customer, schema:Person .
      ex:Customer a owl:Class ; rdfs:label "Buyer account" .`);
    expect(warnings).toEqual([]);
    const client = model.entities.find(e => e.name === 'Client')!;
    expect(client.aiContext?.synonyms)
        .toEqual(['Customer', 'Buyer account', 'Person']);
  });

  test('owl:equivalentProperty adds synonyms to fields and relationships', () => {
    const {model} = convert(`
      ex:A a owl:Class . ex:B a owl:Class .
      ex:amount a owl:DatatypeProperty ; rdfs:domain ex:A ;
          rdfs:range xsd:decimal ; owl:equivalentProperty ex:tcv .
      ex:owns a owl:ObjectProperty ; rdfs:domain ex:A ; rdfs:range ex:B ;
          owl:equivalentProperty schema:owns, ex:holds .`);
    const a = model.entities.find(e => e.name === 'A')!;
    expect(a.fields[0].aiContext?.synonyms).toEqual(['tcv']);
    // schema:owns has the relationship's own name, so it adds nothing.
    expect(model.relationships[0].aiContext?.synonyms).toEqual(['holds']);
  });
});

describe('owl:deprecated', () => {
  test('marks the entity and points at the in-model replacement', () => {
    const {model} = convert(`
      ex:LegacyDeal a owl:Class ; rdfs:comment "An old-style deal." ;
          owl:deprecated true ;
          rdfs:seeAlso <https://wiki.example.com/deals>, ex:Opportunity .
      ex:Opportunity a owl:Class .`);
    const legacy = model.entities.find(e => e.name === 'LegacyDeal')!;
    expect(legacy.description).toBe('DEPRECATED: An old-style deal.');
    expect(legacy.aiContext?.instructions)
        .toBe('LegacyDeal is deprecated: do not use it in new queries or ' +
              'writes. Use Opportunity instead.');
  });

  test('a deprecated field and relationship; no replacement when unknown', () => {
    const {model} = convert(`
      ex:A a owl:Class . ex:B a owl:Class .
      ex:old a owl:DatatypeProperty ; rdfs:domain ex:A ; rdfs:range xsd:string ;
          owl:deprecated "true"^^xsd:boolean ; rdfs:seeAlso ex:new .
      ex:new a owl:DatatypeProperty ; rdfs:domain ex:A ; rdfs:range xsd:string .
      ex:rel a owl:ObjectProperty ; rdfs:domain ex:A ; rdfs:range ex:B ;
          rdfs:comment "Links A to B." ; owl:deprecated true ;
          rdfs:seeAlso ex:nowhere .`);
    const old = model.entities[0].fields.find(f => f.name === 'old')!;
    expect(old.description).toBe('DEPRECATED.');
    expect(old.aiContext?.instructions)
        .toBe('A.old is deprecated: do not use it in new queries or writes. ' +
              'Use A.new instead.');
    expect(model.relationships[0].aiContext?.instructions)
        .toBe('Links A to B.\n\nDEPRECATED: do not use rel in new queries ' +
              'or writes.');
  });

  test('owl:deprecated false changes nothing', () => {
    const {model} = convert(`
      ex:A a owl:Class ; rdfs:comment "Fine." ; owl:deprecated false .`);
    expect(model.entities[0].description).toBe('Fine.');
    expect(model.entities[0].aiContext).toBeUndefined();
  });
});

describe('property characteristics become query instructions', () => {
  test('transitive -> quantified path', () => {
    const {model} = convert(`
      ex:Territory a owl:Class .
      ex:belongsToTerritory a owl:ObjectProperty, owl:TransitiveProperty ;
          rdfs:domain ex:Territory ; rdfs:range ex:Territory .`);
    expect(model.relationships[0].aiContext?.instructions)
        .toContain(
            'MATCH (a:Territory)-[:belongsToTerritory]->{1,10}(b:Territory)');
  });

  test('symmetric -> undirected match', () => {
    const {model} = convert(`
      ex:Party a owl:Class .
      ex:relatedParty a owl:ObjectProperty, owl:SymmetricProperty ;
          rdfs:domain ex:Party ; rdfs:range ex:Party .`);
    expect(model.relationships[0].aiContext?.instructions)
        .toContain('MATCH (a:Party)-[:relatedParty]-(b:Party)');
  });

  test('both, after the comment, in a fixed order', () => {
    const {model} = convert(`
      ex:P a owl:Class .
      ex:r a owl:ObjectProperty, owl:SymmetricProperty, owl:TransitiveProperty ;
          rdfs:domain ex:P ; rdfs:range ex:P ; rdfs:comment "Related." .`);
    const parts = model.relationships[0].aiContext!.instructions!.split('\n\n');
    expect(parts[0]).toBe('Related.');
    expect(parts[1]).toMatch(/^r is transitive/);
    expect(parts[2]).toMatch(/^r is symmetric/);
  });
});
