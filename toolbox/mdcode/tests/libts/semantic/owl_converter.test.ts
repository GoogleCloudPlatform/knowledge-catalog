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
import {googleOntologyExtension} from '../../../src/libts/semantic/converters/owl/to_ir';
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


describe('org ontology exercises the full range of mapped constructs', () => {
  const ttl = readFixture('org.owl.ttl');

  test('produces exactly the documented OSI (golden)', () => {
    const {yaml} = convertOwlToOsi(ttl, 'org');
    expect(yaml).toEqual(readFixture('org.osi.golden.yaml'));
  });

  test('maps cleanly with no warnings', () => {
    // Every construct here is supported, so nothing is dropped.
    expect(convertOwlToOsi(ttl, 'org').warnings).toEqual([]);
  });

  test('the generated OSI loads and covers the mapping table', () => {
    const model = loadModels(convertOwlToOsi(ttl, 'org').yaml).models[0];

    // Classes in declaration order; a bare class carries no metadata.
    expect(model.entities.map(e => e.name))
        .toEqual(['Employee', 'Department', 'Project']);
    const [employee, department, project] = model.entities;

    // Redundant class label dropped; skos alt/pref labels -> synonyms.
    expect(employee.aiContext?.synonyms).toEqual(['Staff member', 'Worker']);
    // Non-redundant class label -> synonym.
    expect(department.aiContext?.synonyms).toEqual(['Org unit']);
    // Bare class: no description, no ai_context.
    expect(project.description).toBeUndefined();
    expect(project.aiContext).toBeUndefined();

    // Datatypes: the three mapped xsd types, and Opaque for everything else
    // (xsd:integer, xsd:boolean, and a property with no range).
    const empTypes = Object.fromEntries(
        employee.fields.map(f => [f.name, f.type]));
    expect(empTypes).toEqual({
      fullName: 'String',
      hireDate: 'Date',
      salary: 'Decimal',
      employeeId: 'Opaque',
      isActive: 'Opaque',
    });
    expect(project.fields.find(f => f.name === 'notes')!.type).toBe('Opaque');

    // Field label kept when it adds a name, dropped when it only recases.
    expect(employee.fields.find(f => f.name === 'fullName')!.label).toBe('name');
    expect(project.fields.find(f => f.name === 'code')!.label).toBeUndefined();

    // Relationships, including a self-referential one; comments -> instructions.
    const byName = Object.fromEntries(model.relationships.map(r => [r.name, r]));
    expect(Object.keys(byName)).toEqual(['worksIn', 'reportsTo', 'worksOn']);
    // Redundant edge label dropped, skos synonym kept, comment -> instructions.
    expect(byName['worksIn'].aiContext)
        .toEqual({instructions: 'The department an employee belongs to.',
                  synonyms: ['member of']});
    // Self-referential edge: both endpoints are the same entity.
    expect(byName['reportsTo'].source.entity).toBe('Employee');
    expect(byName['reportsTo'].destination.entity).toBe('Employee');
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

  // rdfs:comment is a description everywhere it has a slot; the OSI
  // relationship has none, so an object property's comment rides in
  // ai_context.instructions.
  test(
      'rdfs:comment routes to description, or relationship instructions',
      () => {
        const ttl = `
      @prefix owl:  <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
      @prefix ex:   <http://example.com/x#> .

      ex:Order a owl:Class ; rdfs:comment "A purchase." .
      ex:Customer a owl:Class .
      ex:amount a owl:DatatypeProperty ;
          rdfs:domain ex:Order ; rdfs:range xsd:decimal ; rdfs:comment "Total charged." .
      ex:placedBy a owl:ObjectProperty ;
          rdfs:domain ex:Order ; rdfs:range ex:Customer ;
          rdfs:comment "Who placed the order." .
    `;
        const model = loadModels(convertOwlToOsi(ttl, 'x').yaml).models[0];
        const order = model.entities.find(e => e.name === 'Order')!;
        // Class comment -> entity description.
        expect(order.description).toBe('A purchase.');
        // Datatype-property comment -> field description.
        expect(order.fields.find(f => f.name === 'amount')!.description)
            .toBe('Total charged.');
        // Object-property comment -> relationship ai_context.instructions.
        const placedBy = model.relationships.find(r => r.name === 'placedBy')!;
        expect(placedBy.aiContext?.instructions).toBe('Who placed the order.');
      });

  // An object property is an edge between its domain and range; the real join
  // columns are unknown until sources are bound, so both ends carry TODO_BIND.
  test('an object property becomes an edge with UNBOUND join columns', () => {
    const ttl = `
      @prefix owl:  <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix ex:   <http://example.com/x#> .

      ex:Order a owl:Class .
      ex:Customer a owl:Class .
      ex:placedBy a owl:ObjectProperty ;
          rdfs:domain ex:Order ; rdfs:range ex:Customer .
    `;
    const model = loadModels(convertOwlToOsi(ttl, 'x').yaml).models[0];
    const edge = model.relationships.find(r => r.name === 'placedBy')!;
    expect(edge.source.entity).toBe('Order');
    expect(edge.destination.entity).toBe('Customer');
    expect(edge.source.columns).toEqual(['TODO_BIND']);
    expect(edge.destination.columns).toEqual(['TODO_BIND']);
  });

  // A class has no label slot, so its first (non-redundant) label and every
  // further rdfs:label / skos label all collect as synonyms, in document order.
  test('skos and extra rdfs:label values collect as synonyms', () => {
    const ttl = `
      @prefix owl:  <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
      @prefix ex:   <http://example.com/x#> .

      ex:Client a owl:Class ;
          rdfs:label "Customer account" ;
          rdfs:label "Buyer" ;
          skos:altLabel "Account holder" ;
          skos:prefLabel "Patron" .
    `;
    const model = loadModels(convertOwlToOsi(ttl, 'x').yaml).models[0];
    const client = model.entities.find(e => e.name === 'Client')!;
    expect(client.aiContext?.synonyms).toEqual([
      'Customer account', 'Buyer', 'Account holder', 'Patron'
    ]);
  });

  // A domain that names something not declared as an owl:Class cannot host a
  // field; it is skipped with a warning naming the property and the domain.
  test('a datatype property whose domain is not a class is skipped', () => {
    const ttl = `
      @prefix owl:  <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
      @prefix ex:   <http://example.com/x#> .

      ex:Thing a owl:Class .
      ex:stray a owl:DatatypeProperty ;
          rdfs:domain ex:NotAClass ; rdfs:range xsd:string .
    `;
    const {yaml, warnings} = convertOwlToOsi(ttl, 'x');
    expect(warnings.some(w => w.includes('stray') && w.includes('NotAClass')))
        .toBe(true);
    const model = loadModels(yaml).models[0];
    expect(model.entities.find(e => e.name === 'Thing')!.fields)
        .toHaveLength(0);
  });

  // A synonym (skos alt label or extra rdfs:label) that only respaces/recases
  // the term's own name is redundant with the name and dropped -- the same rule
  // the primary label gets.
  test('synonyms redundant with the term name are dropped', () => {
    const ttl = `
      @prefix owl:  <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
      @prefix ex:   <http://example.com/x#> .

      ex:Customer a owl:Class ;
          rdfs:label "Customer" ;
          skos:altLabel "customer" ;
          skos:altLabel "Buyer" .
    `;
    const model = loadModels(convertOwlToOsi(ttl, 'x').yaml).models[0];
    const customer = model.entities.find(e => e.name === 'Customer')!;
    // Both "Customer" and "customer" collapse to the name; only "Buyer" survives.
    expect(customer.aiContext?.synonyms).toEqual(['Buyer']);
  });

  // Terms are named by their namespace-stripped local name, so two terms that
  // share a local name (e.g. across namespaces) would collapse to one OSI name.
  // OSI names must be unique, so the first wins and the rest are warned and
  // skipped -- the output stays valid and loadable rather than emitting a
  // duplicate.
  test('local-name collisions are warned and deduped (first wins)', () => {
    const ttl = `
      @prefix owl:  <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix a:    <http://example.com/a#> .
      @prefix b:    <http://example.com/b#> .

      a:Customer a owl:Class ; rdfs:comment "from a" .
      b:Customer a owl:Class ; rdfs:comment "from b" .
    `;
    const {yaml, warnings} = convertOwlToOsi(ttl, 'x');
    expect(warnings.some(w => w.includes('Customer') && w.includes('more than once')))
        .toBe(true);
    // The result still loads: a single Customer entity, the first declaration.
    const model = loadModels(yaml).models[0];
    expect(model.entities.map(e => e.name)).toEqual(['Customer']);
    expect(model.entities[0].description).toBe('from a');
  });

  // The source ontology's base IRI is not carried on terms, but is preserved
  // once as provenance in the model description.
  test('the model description records the source ontology base IRI', () => {
    const ttl = `
      @prefix owl:  <http://www.w3.org/2002/07/owl#> .
      @prefix ex:   <http://example.com/sales#> .
      ex:Customer a owl:Class .
    `;
    const model = loadModels(convertOwlToOsi(ttl, 'x').yaml).models[0];
    expect(model.description)
        .toBe('Imported from OWL ontology http://example.com/sales#');
  });
});


// The GOOGLE data.ontology extension is the promotion seam for OWL constructs
// OSI cannot yet express natively (subClassOf, inverseOf, ...). It is defined
// and shape-tested but unused by the minimal example, which maps entirely to
// native OSI -- see to_ir.ts.
describe('the GOOGLE ontology extension seam (defined-but-unused)', () => {
  test(
      'wraps its payload as a GOOGLE custom extension under data.ontology',
      () => {
        const ext =
            googleOntologyExtension({subClassOf: {Manager: 'Employee'}});
        expect(ext.vendorName).toBe('GOOGLE');
        expect(JSON.parse(ext.data)).toEqual({
          data: {ontology: {subClassOf: {Manager: 'Employee'}}}
        });
      });

  test(
      'is not exercised by the minimal example (nothing to promote yet)',
      () => {
        const {yaml} = convertOwlToOsi(readFixture('sales.owl.ttl'), 'sales');
        // Everything maps natively, so no custom_extensions / GOOGLE block
        // appears.
        expect(yaml).not.toContain('custom_extensions');
        expect(yaml).not.toContain('GOOGLE');
      });
});
