// Behavior specification for the OWL -> OSI converter
// (convertOwlToOsi in src/libts/semantic/converters/owl/convert.ts).
//
// The converter is one-way: a Turtle OWL ontology becomes an OSI YAML document
// that then rides the normal kcmd push/pull. The guarantees pinned here mirror
// the user-guide section "Importing an OWL ontology":
//   1. the sales example produces exactly the documented OSI (golden), and
//   2. that OSI loads through the OSI loader (the UNBOUND placeholders satisfy
//      the schema, so `kcmd push --target kc` works on the result), and
//   3. each row of the mapping table behaves as documented.
// The scope is exactly the user guide; richer OWL is out of scope by design.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {loadModels} from '../../../src/libts/semantic/loader';

const FIXTURES = path.join(__dirname, 'fixtures', 'owl');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}


describe('sales ontology matches the user-guide CUJ', () => {
  const ttl = readFixture('sales.owl.ttl');

  test('produces exactly the documented OSI (golden)', () => {
    const {yaml} = convertOwlToOsi(ttl, 'sales');
    const golden = readFixture('sales.osi.golden.yaml');
    expect(yaml).toEqual(golden);
  });

  test('reports the documented conversion counts', () => {
    const {stats, warnings} = convertOwlToOsi(ttl, 'sales');
    expect(stats).toEqual(
        {classes: 2, datatypeProperties: 4, objectProperties: 1});
    // The minimal example maps entirely to native OSI, so nothing is dropped.
    expect(warnings).toEqual([]);
  });

  test(
      'the generated OSI loads (UNBOUND placeholders are schema-valid)', () => {
        const {yaml} = convertOwlToOsi(ttl, 'sales');
        // loadModels throws on a schema violation; a clean return proves the
        // model is loadable and thus KC-pushable as-is.
        const loaded = loadModels(yaml);
        expect(loaded.models).toHaveLength(1);
        const model = loaded.models[0];
        expect(model.name).toBe('sales');
        expect(model.entities.map(e => e.name)).toEqual(['Customer', 'Order']);
        expect(model.relationships.map(r => r.name)).toEqual(['placedBy']);
      });
});


describe('mapping table rules', () => {
  // A datatype property's rdfs:label is a display name -> the field `label`
  // slot; a class/object-property label has no slot, so a *non-redundant* one
  // becomes a synonym; a label that only respaces/recases the name is dropped.
  test('labels route to field label vs. synonyms vs. dropped', () => {
    const ttl = `
      @prefix owl:  <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
      @prefix ex:   <http://example.com/x#> .

      ex:Client a owl:Class ; rdfs:label "Customer account" .
      ex:Widget a owl:Class ; rdfs:label "Widget" .
      ex:fullName a owl:DatatypeProperty ;
          rdfs:domain ex:Client ; rdfs:range xsd:string ; rdfs:label "Legal name" .
      ex:code a owl:DatatypeProperty ;
          rdfs:domain ex:Widget ; rdfs:range xsd:string ; rdfs:label "code" .
    `;
    const {yaml} = convertOwlToOsi(ttl, 'x');
    const model = loadModels(yaml).models[0];
    const client = model.entities.find(e => e.name === 'Client')!;
    const widget = model.entities.find(e => e.name === 'Widget')!;
    // Non-redundant class label -> synonym.
    expect(client.aiContext?.synonyms).toEqual(['Customer account']);
    // Redundant class label ("Widget" == name) -> dropped, no ai_context.
    expect(widget.aiContext).toBeUndefined();
    // A datatype-property label that adds a name -> field label slot.
    const fullName = client.fields.find(f => f.name === 'fullName')!;
    expect(fullName.label).toBe('Legal name');
    // A datatype-property label that only recases the field name -> dropped.
    const code = widget.fields.find(f => f.name === 'code')!;
    expect(code.label).toBeUndefined();
  });

  // rdfs:range xsd:* maps string/date/decimal to the OSI datatype; every other
  // range falls back to Opaque (the documented set).
  test('xsd ranges map to datatypes, else Opaque', () => {
    const ttl = `
      @prefix owl:  <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
      @prefix ex:   <http://example.com/x#> .

      ex:Thing a owl:Class .
      ex:s a owl:DatatypeProperty ; rdfs:domain ex:Thing ; rdfs:range xsd:string .
      ex:d a owl:DatatypeProperty ; rdfs:domain ex:Thing ; rdfs:range xsd:date .
      ex:m a owl:DatatypeProperty ; rdfs:domain ex:Thing ; rdfs:range xsd:decimal .
      ex:i a owl:DatatypeProperty ; rdfs:domain ex:Thing ; rdfs:range xsd:integer .
    `;
    const model = loadModels(convertOwlToOsi(ttl, 'x').yaml).models[0];
    const types =
        Object.fromEntries(model.entities[0].fields.map(f => [f.name, f.type]));
    expect(types).toEqual({s: 'String', d: 'Date', m: 'Decimal', i: 'Opaque'});
  });

  // A property with no usable endpoint can't be placed; it is skipped with a
  // warning rather than failing the conversion.
  test('unmappable properties are warned and skipped', () => {
    const ttl = `
      @prefix owl:  <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
      @prefix ex:   <http://example.com/x#> .

      ex:Thing a owl:Class .
      ex:orphan a owl:DatatypeProperty ; rdfs:range xsd:string .
      ex:danglingEdge a owl:ObjectProperty ; rdfs:domain ex:Thing .
    `;
    const {yaml, warnings} = convertOwlToOsi(ttl, 'x');
    expect(warnings).toHaveLength(2);
    expect(warnings.some(w => w.includes('orphan'))).toBe(true);
    expect(warnings.some(w => w.includes('danglingEdge'))).toBe(true);
    const model = loadModels(yaml).models[0];
    expect(model.entities[0].fields).toHaveLength(0);
    expect(model.relationships).toHaveLength(0);
  });
});
