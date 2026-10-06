// Behavior specification for folding unkeyed equivalent classes
// (src/libts/semantic/converters/owl/{folds,to_ir,coverage}.ts):
//
//   - C owl:equivalentClass D where C has no key (own or inherited) and D has
//     one: C is not imported; relationships and fields declared on C move to
//     D, subclasses of C extend D, and C's name and labels become synonyms of
//     D. A warning names the fold and coverage lists it.
//   - The equivalence may be stated from either side.
//   - Two keyed (or two unkeyed) equivalent classes are not folded.

import {describe, expect, test} from 'bun:test';

import {convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {loadModels} from '../../../src/libts/semantic/loader';

const PREFIXES = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
  @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
  @prefix com:  <https://example.org/commercial#> .
  @prefix fin:  <https://example.org/finance#> .
`;

// The prototype's case: finance names the commercial client account
// "Counterparty" and states no key for it.
const FINANCE = `${PREFIXES}
  com:ClientAccount a owl:Class ; owl:hasKey ( com:accountId ) .
  com:accountId a owl:DatatypeProperty ; rdfs:domain com:ClientAccount ;
      rdfs:range xsd:string .
  fin:Counterparty a owl:Class ; rdfs:label "Counterparty" ;
      skos:altLabel "Payer", "Bill-to party" ;
      owl:equivalentClass com:ClientAccount .
  fin:PublicCounterparty a owl:Class ; rdfs:subClassOf fin:Counterparty .
  fin:creditRating a owl:DatatypeProperty ; rdfs:domain fin:Counterparty ;
      rdfs:range xsd:string .
  fin:Invoice a owl:Class ; owl:hasKey ( fin:invoiceId ) .
  fin:invoiceId a owl:DatatypeProperty ; rdfs:domain fin:Invoice ;
      rdfs:range xsd:string .
  fin:hasPayer a owl:ObjectProperty ; rdfs:domain fin:Invoice ;
      rdfs:range fin:Counterparty .
`;

const FOLD_WARNING =
    `class 'Counterparty' is owl:equivalentClass 'ClientAccount' and has no ` +
    `key of its own, so it is folded into 'ClientAccount': its relationships ` +
    `and fields move there and its name and labels become synonyms of ` +
    `'ClientAccount'.`;

function convert(ttl: string) {
  const r = convertOwlToOsi(ttl, 'x');
  const model = loadModels(r.yaml, {bindingOptional: true}).models[0];
  const entity = (name: string) => model.entities.find(e => e.name === name);
  const rel = (name: string) => model.relationships.find(x => x.name === name);
  return {...r, model, entity, rel};
}

describe('an unkeyed equivalent class is folded into the keyed one', () => {
  test('the unkeyed class is not imported', () => {
    const {entity} = convert(FINANCE);
    expect(entity('Counterparty')).toBeUndefined();
    expect(entity('ClientAccount')).toBeDefined();
  });

  test('relationships into it are re-pointed to the keyed class', () => {
    const {rel} = convert(FINANCE);
    expect(rel('hasPayer')!.source.entity).toBe('Invoice');
    expect(rel('hasPayer')!.destination.entity).toBe('ClientAccount');
  });

  test('its fields move to the keyed class, whose key is kept', () => {
    const {entity} = convert(FINANCE);
    const ca = entity('ClientAccount')!;
    expect(ca.fields.map(f => f.name).sort())
        .toEqual(['accountId', 'creditRating']);
    expect(ca.keys).toEqual(['accountId']);
  });

  test('its name and labels become synonyms', () => {
    const syn = convert(FINANCE).entity('ClientAccount')!.aiContext?.synonyms;
    expect(syn).toEqual(
        expect.arrayContaining(['Counterparty', 'Payer', 'Bill-to party']));
  });

  test('its subclasses extend the keyed class', () => {
    expect(convert(FINANCE).entity('PublicCounterparty')!.extends)
        .toEqual(['ClientAccount']);
  });

  test('the fold is warned about', () => {
    expect(convert(FINANCE).warnings).toEqual([FOLD_WARNING]);
  });

  test('coverage lists the fold', () => {
    const {coverage} = convert(FINANCE);
    expect(coverage.find(
               e => e.construct === 'owl:Class' && e.subject === 'Counterparty'))
        .toMatchObject(
            {outcome: 'compiled', target: 'entity ClientAccount (folded in)'});
    expect(coverage.find(e => e.construct === 'owl:equivalentClass (folded)'))
        .toMatchObject({
          subject: 'Counterparty EquivalentTo ClientAccount',
          outcome: 'compiled',
        });
  });

  test('the equivalence may be stated from the keyed side', () => {
    const ttl = `${PREFIXES}
      com:ClientAccount a owl:Class ; owl:hasKey ( com:accountId ) ;
          owl:equivalentClass fin:Counterparty .
      com:accountId a owl:DatatypeProperty ; rdfs:domain com:ClientAccount ;
          rdfs:range xsd:string .
      fin:Counterparty a owl:Class .
    `;
    const {entity, warnings} = convert(ttl);
    expect(entity('Counterparty')).toBeUndefined();
    expect(entity('ClientAccount')!.aiContext?.synonyms)
        .toContain('Counterparty');
    expect(warnings).toEqual([FOLD_WARNING]);
  });
});

describe('equivalent classes that are not folded', () => {
  test('two keyed classes stay separate', () => {
    const ttl = `${PREFIXES}
      com:ClientAccount a owl:Class ; owl:hasKey ( com:accountId ) ;
          owl:equivalentClass fin:Counterparty .
      com:accountId a owl:DatatypeProperty ; rdfs:domain com:ClientAccount ;
          rdfs:range xsd:string .
      fin:Counterparty a owl:Class ; owl:hasKey ( fin:partyId ) .
      fin:partyId a owl:DatatypeProperty ; rdfs:domain fin:Counterparty ;
          rdfs:range xsd:string .
    `;
    const {entity, warnings} = convert(ttl);
    expect(entity('Counterparty')).toBeDefined();
    expect(entity('ClientAccount')).toBeDefined();
    expect(warnings).toEqual([]);
  });

  test('two unkeyed classes stay separate', () => {
    const ttl = `${PREFIXES}
      com:ClientAccount a owl:Class ; owl:equivalentClass fin:Counterparty .
      fin:Counterparty a owl:Class .
    `;
    const {entity, warnings} = convert(ttl);
    expect(entity('Counterparty')).toBeDefined();
    expect(entity('ClientAccount')).toBeDefined();
    expect(warnings).toEqual([]);
  });
});
