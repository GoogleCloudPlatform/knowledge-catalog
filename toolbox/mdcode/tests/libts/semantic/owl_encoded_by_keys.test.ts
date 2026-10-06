// Behavior specification for foreign-key joins stated in the ontology
// (src/libts/semantic/converters/owl/{parse,to_ir,coverage}.ts):
//
//   - `<objectProperty> <ns>:encodedBy <datatypeProperty>` gives the edge its
//     join columns when the destination is an ordinary keyed class, not only a
//     vocabulary: from = the encoding field on the source (or an ancestor),
//     to = the destination's single-column key (its own or inherited). A
//     composite or missing destination key leaves the edge logical, with a
//     warning and a dropped coverage row.
//   - A datatype property shared by several classes is declared with ONE
//     `owl:unionOf` domain (several rdfs:domain triples mean an intersection
//     in OWL); the field lands on every member class, so the key field of the
//     owning class and the foreign-key field of the referencing class are the
//     same property. Members that are not named classes (or nested unions)
//     are warned about and skipped.

import {describe, expect, test} from 'bun:test';

import {convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {parseOwl} from '../../../src/libts/semantic/converters/owl/parse';
import {loadModels} from '../../../src/libts/semantic/loader';

const PREFIXES = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
  @prefix core: <https://example.org/core#> .
  @prefix ex:   <https://example.org/sales#> .
`;

// ClientAccount owns accountId (its key); Opportunity carries it as a
// foreign key. One union domain places the field on both.
const SALES = `${PREFIXES}
  core:encodedBy a owl:AnnotationProperty .
  ex:ClientAccount a owl:Class ; owl:hasKey ( ex:accountId ) .
  ex:Opportunity a owl:Class ; owl:hasKey ( ex:opportunityId ) .
  ex:accountId a owl:DatatypeProperty ; rdfs:range xsd:string ;
      rdfs:domain [ a owl:Class ;
                    owl:unionOf ( ex:ClientAccount ex:Opportunity ) ] .
  ex:opportunityId a owl:DatatypeProperty ; rdfs:domain ex:Opportunity ;
      rdfs:range xsd:string .
  ex:forAccount a owl:ObjectProperty ; rdfs:domain ex:Opportunity ;
      rdfs:range ex:ClientAccount ; core:encodedBy ex:accountId .
`;

function convert(ttl: string) {
  const r = convertOwlToOsi(ttl, 'sales');
  const model = loadModels(r.yaml, {bindingOptional: true}).models[0];
  return {...r, model};
}

const entity = (m: ReturnType<typeof convert>['model'], name: string) =>
    m.entities.find(e => e.name === name)!;
const rel = (m: ReturnType<typeof convert>['model'], name: string) =>
    m.relationships.find(r => r.name === name)!;

describe('a union domain places the field on every member class', () => {
  test('the parser lists each member as a domain', () => {
    const p = parseOwl(SALES).datatypeProperties.find(
        x => x.localName === 'accountId')!;
    expect(p.domains).toEqual(['ClientAccount', 'Opportunity']);
    expect(p.unionDomain).toBe(true);
    expect(p.unsupportedDomains).toBeUndefined();
  });

  test('both classes get the field and the owner keeps its key', () => {
    const {model} = convert(SALES);
    expect(entity(model, 'ClientAccount').fields.map(f => f.name))
        .toEqual(['accountId']);
    expect(entity(model, 'ClientAccount').keys).toEqual(['accountId']);
    expect(entity(model, 'Opportunity').fields.map(f => f.name))
        .toEqual(['accountId', 'opportunityId']);
  });

  test('a nested union is flattened', () => {
    const ttl = `${PREFIXES}
      ex:A a owl:Class . ex:B a owl:Class . ex:C a owl:Class .
      ex:code a owl:DatatypeProperty ; rdfs:range xsd:string ;
          rdfs:domain [ owl:unionOf ( ex:A [ owl:unionOf ( ex:B ex:C ) ] ) ] .
    `;
    const p = parseOwl(ttl).datatypeProperties[0];
    expect(p.domains).toEqual(['A', 'B', 'C']);
  });

  test('an anonymous non-union member is warned about and skipped', () => {
    const ttl = `${PREFIXES}
      ex:A a owl:Class . ex:B a owl:Class .
      ex:code a owl:DatatypeProperty ; rdfs:range xsd:string ;
          rdfs:domain [ owl:unionOf ( ex:A
              [ owl:intersectionOf ( ex:A ex:B ) ] ) ] .
    `;
    const {model, warnings, coverage} = convert(ttl);
    expect(entity(model, 'A').fields.map(f => f.name)).toEqual(['code']);
    expect(entity(model, 'B').fields).toEqual([]);
    expect(warnings).toContain(
        `datatype property 'code' has an rdfs:domain that is an owl:unionOf ` +
        `member that is an owl:intersectionOf; that domain is skipped (a ` +
        `field goes on a named class, or on each member of an owl:unionOf ` +
        `of named classes).`);
    expect(coverage.find(e => e.construct === 'rdfs:domain')?.outcome)
        .toBe('dropped');
  });

  test('a non-union class expression domain is skipped, not leaked', () => {
    const ttl = `${PREFIXES}
      ex:A a owl:Class . ex:B a owl:Class .
      ex:code a owl:DatatypeProperty ; rdfs:range xsd:string ;
          rdfs:domain [ owl:intersectionOf ( ex:A ex:B ) ] .
    `;
    const {model, warnings} = convert(ttl);
    expect(model.entities.every(e => e.fields.length === 0)).toBe(true);
    expect(warnings.some(
               w => w.includes(`'code' has an rdfs:domain that is an ` +
                               `owl:intersectionOf`)))
        .toBe(true);
    expect(warnings).toContain(
        `datatype property 'code' has no rdfs:domain; skipped (a field must ` +
        `belong to a class).`);
  });

  test('several rdfs:domain triples still place the field on each', () => {
    const ttl = `${PREFIXES}
      ex:A a owl:Class . ex:B a owl:Class .
      ex:code a owl:DatatypeProperty ; rdfs:range xsd:string ;
          rdfs:domain ex:A , ex:B .
    `;
    const {model} = convert(ttl);
    expect(entity(model, 'A').fields.map(f => f.name)).toEqual(['code']);
    expect(entity(model, 'B').fields.map(f => f.name)).toEqual(['code']);
  });

  test('coverage lists the union domain as compiled onto each member', () => {
    const {coverage} = convert(SALES);
    expect(coverage.find(e => e.construct === 'owl:unionOf (rdfs:domain)'))
        .toMatchObject({
          outcome: 'compiled',
          subject: 'accountId domain unionOf(ClientAccount Opportunity)',
          target: 'fields ClientAccount.accountId, Opportunity.accountId',
        });
  });
});

describe('encodedBy joins a foreign key to a keyed destination', () => {
  test('from = the encoding field, to = the destination key', () => {
    const {model} = convert(SALES);
    const r = rel(model, 'forAccount');
    expect(r.source).toEqual({entity: 'Opportunity', columns: ['accountId']});
    expect(r.destination).toEqual(
        {entity: 'ClientAccount', columns: ['accountId']});
  });

  test('the encoding field may live on an ancestor of the source', () => {
    const ttl = `${PREFIXES}
      ex:Account a owl:Class ; owl:hasKey ( ex:accountId ) .
      ex:Deal a owl:Class ; owl:hasKey ( ex:dealId ) .
      ex:BigDeal a owl:Class ; rdfs:subClassOf ex:Deal .
      ex:accountId a owl:DatatypeProperty ; rdfs:range xsd:string ;
          rdfs:domain [ owl:unionOf ( ex:Account ex:Deal ) ] .
      ex:dealId a owl:DatatypeProperty ; rdfs:domain ex:Deal ;
          rdfs:range xsd:string .
      ex:bigDealFor a owl:ObjectProperty ; rdfs:domain ex:BigDeal ;
          rdfs:range ex:Account ; core:encodedBy ex:accountId .
    `;
    const r = rel(convert(ttl).model, 'bigDealFor');
    expect(r.source.columns).toEqual(['accountId']);
    expect(r.destination.columns).toEqual(['accountId']);
  });

  test('a destination subclass joins on its inherited key', () => {
    const ttl = `${PREFIXES}
      ex:Account a owl:Class ; owl:hasKey ( ex:accountId ) .
      ex:KeyAccount a owl:Class ; rdfs:subClassOf ex:Account .
      ex:Deal a owl:Class ; owl:hasKey ( ex:dealId ) .
      ex:accountId a owl:DatatypeProperty ; rdfs:range xsd:string ;
          rdfs:domain [ owl:unionOf ( ex:Account ex:Deal ) ] .
      ex:dealId a owl:DatatypeProperty ; rdfs:domain ex:Deal ;
          rdfs:range xsd:string .
      ex:forKeyAccount a owl:ObjectProperty ; rdfs:domain ex:Deal ;
          rdfs:range ex:KeyAccount ; core:encodedBy ex:accountId .
    `;
    const r = rel(convert(ttl).model, 'forKeyAccount');
    expect(r.destination).toEqual(
        {entity: 'KeyAccount', columns: ['accountId']});
  });

  test('a composite destination key leaves the edge logical', () => {
    const ttl = `${PREFIXES}
      ex:Snapshot a owl:Class ; owl:hasKey ( ex:asOf ex:unit ) .
      ex:Note a owl:Class ; owl:hasKey ( ex:noteId ) .
      ex:asOf a owl:DatatypeProperty ; rdfs:domain ex:Snapshot ;
          rdfs:range xsd:date .
      ex:unit a owl:DatatypeProperty ; rdfs:range xsd:string ;
          rdfs:domain [ owl:unionOf ( ex:Snapshot ex:Note ) ] .
      ex:noteId a owl:DatatypeProperty ; rdfs:domain ex:Note ;
          rdfs:range xsd:string .
      ex:about a owl:ObjectProperty ; rdfs:domain ex:Note ;
          rdfs:range ex:Snapshot ; core:encodedBy ex:unit .
    `;
    const {model, warnings, coverage} = convert(ttl);
    expect(rel(model, 'about').source.columns).toEqual([]);
    const w = `object property 'about' is encodedBy 'unit', but 'Snapshot' ` +
        `has a composite primary key to match it to; the edge keeps no join ` +
        `columns.`;
    expect(warnings).toContain(w);
    expect(coverage.find(e => e.construct === 'encodedBy')).toEqual({
      construct: 'encodedBy',
      subject: 'about encodedBy unit',
      outcome: 'dropped',
      reason: w,
    });
  });

  test('a field missing on the source leaves the edge logical', () => {
    const ttl = `${PREFIXES}
      ex:Account a owl:Class ; owl:hasKey ( ex:accountId ) .
      ex:Deal a owl:Class .
      ex:accountId a owl:DatatypeProperty ; rdfs:domain ex:Account ;
          rdfs:range xsd:string .
      ex:forAccount a owl:ObjectProperty ; rdfs:domain ex:Deal ;
          rdfs:range ex:Account ; core:encodedBy ex:accountId .
    `;
    const {model, warnings} = convert(ttl);
    expect(rel(model, 'forAccount').source.columns).toEqual([]);
    expect(warnings).toContain(
        `object property 'forAccount' is encodedBy 'accountId', which is not ` +
        `a field of 'Deal'; the edge keeps no join columns.`);
  });

  test('coverage lists the derived join as compiled', () => {
    const {coverage} = convert(SALES);
    expect(coverage.find(e => e.construct === 'encodedBy')).toEqual({
      construct: 'encodedBy',
      subject: 'forAccount encodedBy accountId',
      outcome: 'compiled',
      target: 'relationship forAccount from_columns [accountId] to_columns ' +
          '[accountId]',
    });
  });
});
