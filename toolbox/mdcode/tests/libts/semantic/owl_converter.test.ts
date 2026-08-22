// Behavior specification for the OWL -> OSI converter
// (convertOwlToOsi in src/libts/semantic/converters/owl/convert.ts).
//
// The converter is one-way: a Turtle OWL ontology becomes an OSI YAML document
// that then rides the normal kcmd push/pull. The guarantees pinned here mirror
// the user-guide section "Importing an OWL ontology":
//   1. the sales example produces exactly the documented OSI (golden), and
//   2. that OSI loads through the OSI loader (the UNBOUND placeholders satisfy
//      the schema, so `kcmd push --target kc` works on the result), and
//   3. each mapped construct behaves as documented.
// The scope is exactly the user guide; richer OWL is out of scope by design.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {googleOntologyExtension} from '../../../src/libts/semantic/converters/owl/to_ir';
import {isTimeDimension} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';

const FIXTURES = path.join(__dirname, 'fixtures', 'owl');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// Converts an inline ontology and loads the result, the common path for the
// focused rule tests below.
function loadOwl(ttl: string) {
  return loadModels(convertOwlToOsi(ttl, 'x').yaml).models[0];
}

const PREFIXES = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
  @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
  @prefix dct:  <http://purl.org/dc/terms/> .
  @prefix ex:   <http://example.com/x#> .
`;


describe('sales ontology matches the user-guide CUJ', () => {
  const ttl = readFixture('sales.owl.ttl');

  test('produces exactly the documented OSI (golden)', () => {
    const {yaml} = convertOwlToOsi(ttl, 'sales');
    expect(yaml).toEqual(readFixture('sales.osi.golden.yaml'));
  });

  test('reports the documented conversion counts', () => {
    const {stats, warnings} = convertOwlToOsi(ttl, 'sales');
    expect(stats).toEqual(
        {classes: 2, datatypeProperties: 9, objectProperties: 1});
    // Every construct in the walkthrough maps to native OSI, so nothing is
    // dropped.
    expect(warnings).toEqual([]);
  });

  test('the generated OSI loads and carries the guide highlights', () => {
    const {yaml} = convertOwlToOsi(ttl, 'sales');
    // loadModels throws on a schema violation; a clean return proves the model
    // is loadable and thus KC-pushable as-is.
    const model = loadModels(yaml).models[0];
    expect(model.name).toBe('sales');
    expect(model.entities.map(e => e.name)).toEqual(['Customer', 'Order']);

    // Ontology header -> model description (+ version) and ai_context.
    expect(model.description)
        .toBe(
            'A minimal sales domain: customers and the orders they place. ' +
            '(ontology version 1.0)');
    expect(model.aiContext?.synonyms).toEqual(['Sales domain']);
    expect(model.aiContext?.examples).toEqual([
      'How many orders did each customer place last month?'
    ]);

    const customer = model.entities[0];
    // owl:hasKey -> primary_key; inverse-functional email -> unique_keys.
    expect(customer.keys).toEqual(['customerId']);
    expect(customer.uniqueKeys).toEqual([['email']]);

    // The edge's destination binds to Customer's key; only the source FK stays
    // a placeholder.
    const placedBy = model.relationships.find(r => r.name === 'placedBy')!;
    expect(placedBy.destination.columns).toEqual(['customerId']);
    expect(placedBy.source.columns).toEqual(['TODO_BIND']);
  });
});


describe('org ontology exercises datatypes, keys, and binding', () => {
  const ttl = readFixture('org.owl.ttl');

  test('produces exactly the documented OSI (golden)', () => {
    const {yaml} = convertOwlToOsi(ttl, 'org');
    expect(yaml).toEqual(readFixture('org.osi.golden.yaml'));
  });

  test('maps cleanly with no warnings', () => {
    expect(convertOwlToOsi(ttl, 'org').warnings).toEqual([]);
  });

  test('the generated OSI loads and covers the mapping', () => {
    const model = loadModels(convertOwlToOsi(ttl, 'org').yaml).models[0];
    expect(model.entities.map(e => e.name)).toEqual([
      'Employee', 'Department', 'Project'
    ]);
    const [employee, department, project] = model.entities;

    // skos alt/pref labels -> synonyms; non-redundant class label -> synonym.
    expect(employee.aiContext?.synonyms).toEqual(['Staff member', 'Worker']);
    expect(department.aiContext?.synonyms).toEqual(['Org unit']);

    // The full mapped xsd datatype range.
    const empTypes =
        Object.fromEntries(employee.fields.map(f => [f.name, f.type]));
    expect(empTypes).toEqual({
      employeeId: 'String',
      fullName: 'String',
      hireDate: 'Date',
      salary: 'Decimal',
      fteRatio: 'Float',
      level: 'Integer',
      isManager: 'Boolean',
      lastLogin: 'DateTime',
      startDate: 'Date',
    });
    // A range outside the mapped set falls back to Opaque.
    expect(project.fields.find(f => f.name === 'notes')!.type).toBe('Opaque');

    // Keys: single, and inverse-functional employeeId that IS the key is NOT
    // also emitted as a unique_keys constraint.
    expect(employee.keys).toEqual(['employeeId']);
    expect(employee.uniqueKeys).toBeUndefined();
    expect(department.keys).toEqual(['deptCode']);
    // Composite key.
    expect(project.keys).toEqual(['portfolio', 'projectNo']);

    // Multi-domain property: startDate is a field on both entities it declares.
    expect(employee.fields.some(f => f.name === 'startDate')).toBe(true);
    expect(project.fields.some(f => f.name === 'startDate')).toBe(true);

    // Temporal fields are marked as time dimensions.
    expect(isTimeDimension(employee.fields.find(f => f.name === 'hireDate')!))
        .toBe(true);
    expect(isTimeDimension(employee.fields.find(f => f.name === 'lastLogin')!))
        .toBe(true);
    expect(isTimeDimension(employee.fields.find(f => f.name === 'salary')!))
        .toBe(false);

    // Edges bind their destination columns to the destination's key: single,
    // self-referential, and composite (two columns, two source placeholders).
    const byName =
        Object.fromEntries(model.relationships.map(r => [r.name, r]));
    expect(byName['worksIn'].destination.columns).toEqual(['deptCode']);
    expect(byName['reportsTo'].source.entity).toBe('Employee');
    expect(byName['reportsTo'].destination.entity).toBe('Employee');
    expect(byName['reportsTo'].destination.columns).toEqual(['employeeId']);
    expect(byName['worksOn'].destination.columns).toEqual([
      'portfolio', 'projectNo'
    ]);
    expect(byName['worksOn'].source.columns).toEqual([
      'TODO_BIND', 'TODO_BIND'
    ]);
  });
});


describe('class hierarchies map rdfs:subClassOf to entity extends', () => {
  const ttl = readFixture('hierarchy.owl.ttl');

  test('produces exactly the documented OSI (golden)', () => {
    const {yaml} = convertOwlToOsi(ttl, 'hierarchy');
    expect(yaml).toEqual(readFixture('hierarchy.osi.golden.yaml'));
  });

  test(
      'the generated OSI reloads through the loader with extends intact',
      () => {
        // The point of the golden: `extends` survives import -> serialize ->
        // load. If the loader schema did not accept `extends`, loadModels would
        // throw or drop it; a clean reload with the parents present proves the
        // round trip.
        const {yaml} = convertOwlToOsi(ttl, 'hierarchy');
        const model = loadModels(yaml).models[0];
        const byName = Object.fromEntries(model.entities.map(e => [e.name, e]));
        // Single-parent subclass.
        expect(byName['Customer'].extends).toEqual(['Person']);
        // Multi-parent subclass, parents in document order; the blank-node
        // owl:Restriction superclass is not a named class and is excluded.
        expect(byName['Manager'].extends).toEqual(['Person', 'Employee']);
        // A base class with no rdfs:subClassOf carries no `extends`.
        expect(byName['Person'].extends).toBeUndefined();
        expect(byName['Employee'].extends).toBeUndefined();
      });

  test('inheritance is recorded, not flattened (no fields copied down)', () => {
    // This cut only RECORDS the hierarchy; it does not resolve it. A subclass
    // keeps exactly its own fields -- Person's fullName does NOT appear on
    // Customer. Resolving inherited fields is a follow-on.
    const model = loadModels(convertOwlToOsi(ttl, 'hierarchy').yaml).models[0];
    const customer = model.entities.find(e => e.name === 'Customer')!;
    expect(customer.fields.map(f => f.name)).toEqual(['loyaltyTier']);
    const manager = model.entities.find(e => e.name === 'Manager')!;
    expect(manager.fields).toHaveLength(0);
  });

  test(
      'property inheritance (rdfs:subPropertyOf) is warned and dropped', () => {
        // Only entity-level inheritance is supported. A datatype/object
        // property's rdfs:subPropertyOf is dropped with a warning, but the
        // field/relationship itself is still imported.
        const {yaml, warnings} = convertOwlToOsi(ttl, 'hierarchy');
        expect(warnings).toHaveLength(2);
        expect(warnings.some(
                   w => w.includes('legalName') && w.includes('subPropertyOf')))
            .toBe(true);
        expect(warnings.some(
                   w => w.includes('managedBy') && w.includes('subPropertyOf')))
            .toBe(true);
        // The field and relationship survive despite the dropped subPropertyOf
        // link.
        const model = loadModels(yaml).models[0];
        const employee = model.entities.find(e => e.name === 'Employee')!;
        expect(employee.fields.some(f => f.name === 'legalName')).toBe(true);
        expect(model.relationships.some(r => r.name === 'managedBy'))
            .toBe(true);
      });

  test('an extends parent that is not a class is recorded but warned', () => {
    // subClassOf a superclass that is not an owl:Class in this ontology (a
    // typo, or an external superclass) is still recorded as `extends`, but --
    // like every other unresolved cross-reference in the converter -- it is
    // warned about rather than emitted silently.
    const ttl = [
      '@prefix owl:  <http://www.w3.org/2002/07/owl#> .',
      '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
      '@prefix ex:   <http://example.com/hr#> .',
      'ex:Customer a owl:Class ; rdfs:subClassOf ex:Persn .',
    ].join('\n');
    const {yaml, warnings} = convertOwlToOsi(ttl, 'dangling');
    expect(warnings.some(
               w => w.includes('Customer') && w.includes('Persn') &&
                   w.includes('subClassOf')))
        .toBe(true);
    // Still recorded as declared -- the warning does not drop the link.
    const customer =
        loadModels(yaml).models[0].entities.find(e => e.name === 'Customer')!;
    expect(customer.extends).toEqual(['Persn']);
  });

  test(
      'the universal superclass owl:Thing is ignored (no extends, no warning)',
      () => {
        // Every class is trivially a subclass of owl:Thing / rdfs:Resource, so
        // an explicit rdfs:subClassOf naming one is neither recorded as
        // `extends` nor warned about -- unlike a genuine unresolved superclass.
        const ttl = [
          '@prefix owl:  <http://www.w3.org/2002/07/owl#> .',
          '@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .',
          '@prefix ex:   <http://example.com/hr#> .',
          'ex:Person a owl:Class ; rdfs:subClassOf owl:Thing .',
        ].join('\n');
        const {yaml, warnings} = convertOwlToOsi(ttl, 'top');
        expect(warnings).toEqual([]);
        const person =
            loadModels(yaml).models[0].entities.find(e => e.name === 'Person')!;
        expect(person.extends).toBeUndefined();
      });
});


describe('datatype mapping (rdfs:range xsd:* -> DataType)', () => {
  // The documented xsd -> OSI table. Widths collapse (every integer ->
  // Integer, float/double -> Float); anything outside the set falls back to
  // Opaque.
  test('maps the supported xsd ranges, else Opaque', () => {
    const ttl = `${PREFIXES}
      ex:T a owl:Class .
      ex:s   a owl:DatatypeProperty ; rdfs:domain ex:T ; rdfs:range xsd:string .
      ex:uri a owl:DatatypeProperty ; rdfs:domain ex:T ; rdfs:range xsd:anyURI .
      ex:i   a owl:DatatypeProperty ; rdfs:domain ex:T ; rdfs:range xsd:integer .
      ex:l   a owl:DatatypeProperty ; rdfs:domain ex:T ; rdfs:range xsd:long .
      ex:pi  a owl:DatatypeProperty ; rdfs:domain ex:T ; rdfs:range xsd:positiveInteger .
      ex:dec a owl:DatatypeProperty ; rdfs:domain ex:T ; rdfs:range xsd:decimal .
      ex:f   a owl:DatatypeProperty ; rdfs:domain ex:T ; rdfs:range xsd:float .
      ex:dbl a owl:DatatypeProperty ; rdfs:domain ex:T ; rdfs:range xsd:double .
      ex:b   a owl:DatatypeProperty ; rdfs:domain ex:T ; rdfs:range xsd:boolean .
      ex:dt  a owl:DatatypeProperty ; rdfs:domain ex:T ; rdfs:range xsd:date .
      ex:tm  a owl:DatatypeProperty ; rdfs:domain ex:T ; rdfs:range xsd:time .
      ex:dtm a owl:DatatypeProperty ; rdfs:domain ex:T ; rdfs:range xsd:dateTime .
      ex:tz  a owl:DatatypeProperty ; rdfs:domain ex:T ; rdfs:range xsd:dateTimeStamp .
      ex:un  a owl:DatatypeProperty ; rdfs:domain ex:T ; rdfs:range xsd:hexBinary .
      ex:nr  a owl:DatatypeProperty ; rdfs:domain ex:T .
    `;
    const types = Object.fromEntries(
        loadOwl(ttl).entities[0].fields.map(f => [f.name, f.type]));
    expect(types).toEqual({
      s: 'String',
      uri: 'String',
      i: 'Integer',
      l: 'Integer',
      pi: 'Integer',
      dec: 'Decimal',
      f: 'Float',
      dbl: 'Float',
      b: 'Boolean',
      dt: 'Date',
      tm: 'Time',
      dtm: 'DateTime',
      tz: 'DateTimeTz',
      un: 'Opaque',  // range outside the set
      nr: 'Opaque',  // no range at all
    });
  });

  // A temporal-typed field is a time dimension by OSI's own rule; a
  // non-temporal one is not a dimension.
  test('temporal fields are marked as time dimensions', () => {
    const ttl = `${PREFIXES}
      ex:T a owl:Class .
      ex:when a owl:DatatypeProperty ; rdfs:domain ex:T ; rdfs:range xsd:dateTime .
      ex:qty  a owl:DatatypeProperty ; rdfs:domain ex:T ; rdfs:range xsd:integer .
    `;
    const fields = loadOwl(ttl).entities[0].fields;
    expect(isTimeDimension(fields.find(f => f.name === 'when')!)).toBe(true);
    expect(isTimeDimension(fields.find(f => f.name === 'qty')!)).toBe(false);
  });
});


describe('keys and edge binding', () => {
  // owl:hasKey names the class's key properties -> primary_key (grain).
  test('owl:hasKey becomes the entity primary_key', () => {
    const ttl = `${PREFIXES}
      ex:Order a owl:Class ; owl:hasKey ( ex:orderId ) .
      ex:orderId a owl:DatatypeProperty ; rdfs:domain ex:Order ; rdfs:range xsd:string .
    `;
    expect(loadOwl(ttl).entities[0].keys).toEqual(['orderId']);
  });

  // A multi-property owl:hasKey is a composite primary_key, in list order.
  test('a composite owl:hasKey preserves order', () => {
    const ttl = `${PREFIXES}
      ex:Line a owl:Class ; owl:hasKey ( ex:orderId ex:lineNo ) .
      ex:orderId a owl:DatatypeProperty ; rdfs:domain ex:Line ; rdfs:range xsd:string .
      ex:lineNo  a owl:DatatypeProperty ; rdfs:domain ex:Line ; rdfs:range xsd:integer .
    `;
    expect(loadOwl(ttl).entities[0].keys).toEqual(['orderId', 'lineNo']);
  });

  // An inverse-functional datatype property uniquely identifies its subject
  // -> a unique_keys constraint (distinct from the primary key).
  test('owl:InverseFunctionalProperty becomes a unique_keys constraint', () => {
    const ttl = `${PREFIXES}
      ex:Person a owl:Class ; owl:hasKey ( ex:pid ) .
      ex:pid   a owl:DatatypeProperty ; rdfs:domain ex:Person ; rdfs:range xsd:string .
      ex:ssn   a owl:DatatypeProperty, owl:InverseFunctionalProperty ;
               rdfs:domain ex:Person ; rdfs:range xsd:string .
    `;
    const person = loadOwl(ttl).entities[0];
    expect(person.keys).toEqual(['pid']);
    expect(person.uniqueKeys).toEqual([['ssn']]);
  });

  // When the inverse-functional property IS the declared key, it is not also
  // emitted as a redundant unique_keys constraint.
  test('an inverse-functional key is not duplicated as a unique key', () => {
    const ttl = `${PREFIXES}
      ex:Person a owl:Class ; owl:hasKey ( ex:ssn ) .
      ex:ssn a owl:DatatypeProperty, owl:InverseFunctionalProperty ;
             rdfs:domain ex:Person ; rdfs:range xsd:string .
    `;
    const person = loadOwl(ttl).entities[0];
    expect(person.keys).toEqual(['ssn']);
    expect(person.uniqueKeys).toBeUndefined();
  });

  // An edge into a class with a key binds its destination columns to that
  // key; the source foreign-key columns stay placeholders (one per key
  // column).
  test('an edge binds its destination to the destination key', () => {
    const ttl = `${PREFIXES}
      ex:Order a owl:Class .
      ex:Customer a owl:Class ; owl:hasKey ( ex:cid ) .
      ex:cid a owl:DatatypeProperty ; rdfs:domain ex:Customer ; rdfs:range xsd:string .
      ex:placedBy a owl:ObjectProperty ; rdfs:domain ex:Order ; rdfs:range ex:Customer .
    `;
    const edge = loadOwl(ttl).relationships[0];
    expect(edge.destination.columns).toEqual(['cid']);
    expect(edge.source.columns).toEqual(['TODO_BIND']);
  });

  // Without a key on the destination, both ends stay fully unbound.
  test('an edge into a keyless class is fully unbound', () => {
    const ttl = `${PREFIXES}
      ex:Order a owl:Class .
      ex:Customer a owl:Class .
      ex:placedBy a owl:ObjectProperty ; rdfs:domain ex:Order ; rdfs:range ex:Customer .
    `;
    const edge = loadOwl(ttl).relationships[0];
    expect(edge.destination.columns).toEqual(['TODO_BIND']);
    expect(edge.source.columns).toEqual(['TODO_BIND']);
  });

  // A relationship maps ONE source to ONE destination. An object property with
  // more than one rdfs:domain (or rdfs:range) keeps the first of each and warns
  // about the rest, rather than silently dropping the extra endpoints.
  test('a multi-endpoint object property keeps the first and warns', () => {
    const ttl = `${PREFIXES}
      ex:Person a owl:Class . ex:Company a owl:Class . ex:Asset a owl:Class .
      ex:owns a owl:ObjectProperty ;
          rdfs:domain ex:Person ; rdfs:domain ex:Company ;
          rdfs:range ex:Asset .
    `;
    const {warnings} = convertOwlToOsi(ttl, 'x');
    const model = loadOwl(ttl);
    expect(model.relationships.length).toBe(1);
    expect(model.relationships[0].source.entity).toBe('Person');
    expect(model.relationships[0].destination.entity).toBe('Asset');
    expect(warnings.some(
               w => w.includes(`'owns'`) && w.includes(`domain 'Company'`) &&
                   w.includes('one source to one destination')))
        .toBe(true);
  });

  // An owl:hasKey column that has no datatype property on the class
  // (undeclared, or declared only on another class) would name a phantom
  // primary_key column that only errors later at graph generation. Because a
  // partial composite key would silently change the entity's grain, the ENTIRE
  // primary_key is dropped -- not just the phantom member -- with a warning.
  test(
      'a hasKey with a phantom column drops the whole key with a warning',
      () => {
        const ttl = `${PREFIXES}
      ex:Order a owl:Class ; owl:hasKey ( ex:orderId ex:ghost ) .
      ex:orderId a owl:DatatypeProperty ; rdfs:domain ex:Order ; rdfs:range xsd:string .
    `;
        const {warnings} = convertOwlToOsi(ttl, 'x');
        expect(loadOwl(ttl).entities[0].keys).toEqual([]);
        expect(warnings.some(
                   w => w.includes(`'ghost'`) && w.includes('primary_key')))
            .toBe(true);
      });

  // A class whose only key material is a single inverse-functional property (no
  // owl:hasKey) has a natural identifier; it is promoted to primary_key so the
  // entity is valid for graph generation rather than keyless, and is then not
  // also repeated as a unique_keys constraint.
  test('a sole inverse-functional property is promoted to primary_key', () => {
    const ttl = `${PREFIXES}
      ex:Person a owl:Class .
      ex:email a owl:DatatypeProperty, owl:InverseFunctionalProperty ;
               rdfs:domain ex:Person ; rdfs:range xsd:string .
    `;
    const {warnings} = convertOwlToOsi(ttl, 'x');
    const person = loadOwl(ttl).entities[0];
    expect(person.keys).toEqual(['email']);
    expect(person.uniqueKeys).toBeUndefined();
    expect(warnings.some(
               w => w.includes('no usable owl:hasKey') && w.includes('email')))
        .toBe(true);
  });

  // Ambiguous key material (more than one inverse-functional property) is left
  // alone: no primary_key is guessed, and each stays a unique_keys constraint.
  test('multiple inverse-functional properties are not promoted', () => {
    const ttl = `${PREFIXES}
      ex:Person a owl:Class .
      ex:email a owl:DatatypeProperty, owl:InverseFunctionalProperty ; rdfs:domain ex:Person ; rdfs:range xsd:string .
      ex:ssn   a owl:DatatypeProperty, owl:InverseFunctionalProperty ; rdfs:domain ex:Person ; rdfs:range xsd:string .
    `;
    const person = loadOwl(ttl).entities[0];
    expect(person.keys).toEqual([]);
    expect(person.uniqueKeys).toEqual([['email'], ['ssn']]);
  });

  // A class whose declared owl:hasKey is entirely phantom still has usable key
  // material if it carries a lone inverse-functional property: the phantom key
  // is dropped and the IFP promoted. The promotion warning must not claim the
  // class "declares no owl:hasKey" (it did -- the key was dropped), so it reads
  // "no usable owl:hasKey".
  test('a dropped phantom key still allows IFP promotion', () => {
    const ttl = `${PREFIXES}
      ex:Person a owl:Class ; owl:hasKey ( ex:ghost ) .
      ex:email a owl:DatatypeProperty, owl:InverseFunctionalProperty ;
               rdfs:domain ex:Person ; rdfs:range xsd:string .
    `;
    const {warnings} = convertOwlToOsi(ttl, 'x');
    const person = loadOwl(ttl).entities[0];
    expect(person.keys).toEqual(['email']);
    expect(person.uniqueKeys).toBeUndefined();
    expect(warnings.some(w => w.includes(`'ghost'`))).toBe(true);
    expect(warnings.some(w => w.includes('no usable owl:hasKey'))).toBe(true);
  });
});


describe('converted counts and provenance', () => {
  // The CLI summary counts what was actually converted, not source triples: a
  // skipped element (duplicate class, domain-less or endpoint-less property) is
  // not reported, and a multi-domain property counts once.
  test('stats count conversions, excluding skipped elements', () => {
    const ttl = `${PREFIXES}
      @prefix ex2: <http://example.com/other#> .
      ex:Order  a owl:Class .
      ex2:Order a owl:Class .                                    # dup name -> skipped
      ex:amount a owl:DatatypeProperty ; rdfs:domain ex:Order ; rdfs:range xsd:decimal .
      ex:orphan a owl:DatatypeProperty ; rdfs:range xsd:string . # no domain -> skipped
      ex:ghost  a owl:ObjectProperty ; rdfs:domain ex:Order .    # no range -> skipped
    `;
    const {stats} = convertOwlToOsi(ttl, 'x');
    expect(stats.classes).toBe(1);
    expect(stats.datatypeProperties).toBe(1);
    expect(stats.objectProperties).toBe(0);
  });

  // A multi-domain datatype property is one conversion, not one per domain.
  test('a multi-domain property counts once', () => {
    const ttl = `${PREFIXES}
      ex:A a owl:Class . ex:B a owl:Class .
      ex:shared a owl:DatatypeProperty ; rdfs:domain ex:A ; rdfs:domain ex:B ; rdfs:range xsd:string .
    `;
    expect(convertOwlToOsi(ttl, 'x').stats.datatypeProperties).toBe(1);
  });

  // The base-IRI provenance is taken from an actual term's namespace (exact,
  // delimiter and all), not from the ontology IRI's guessed `#` suffix -- so a
  // slash-namespaced ontology is recorded correctly.
  test(
      'base IRI provenance follows the term namespace, not a guessed suffix',
      () => {
        const ttl = `
      @prefix owl:  <http://www.w3.org/2002/07/owl#> .
      @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
      @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
      @prefix ex:   <http://example.com/sales/> .
      <http://example.com/sales> a owl:Ontology .
      ex:Order  a owl:Class .
      ex:amount a owl:DatatypeProperty ; rdfs:domain ex:Order ; rdfs:range xsd:decimal .
    `;
        const description = loadOwl(ttl).description ?? '';
        expect(description).toContain('http://example.com/sales/');
        expect(description).not.toContain('sales#');
      });
});


describe('ai_context enrichment', () => {
  // skos:example on a term -> ai_context.examples.
  test('skos:example becomes ai_context.examples', () => {
    const ttl = `${PREFIXES}
      ex:Order a owl:Class ; skos:example "A weekly grocery order." .
      ex:amount a owl:DatatypeProperty ; rdfs:domain ex:Order ; rdfs:range xsd:decimal ;
          skos:example "19.99" .
    `;
    const model = loadOwl(ttl);
    expect(model.entities[0].aiContext?.examples).toEqual([
      'A weekly grocery order.'
    ]);
    expect(model.entities[0].fields[0].aiContext?.examples).toEqual(['19.99']);
  });

  // The owl:Ontology header -> model description (+ version) and ai_context.
  test('the ontology header becomes model-level metadata', () => {
    const ttl = `${PREFIXES}
      <http://example.com/x> a owl:Ontology ;
          rdfs:label "Widgets" ;
          rdfs:comment "The widget catalog." ;
          skos:example "Which widgets are discontinued?" ;
          owl:versionInfo "2.3" .
      ex:Widget a owl:Class .
    `;
    const model = loadOwl(ttl);
    expect(model.description)
        .toBe('The widget catalog. (ontology version 2.3)');
    expect(model.aiContext?.synonyms).toEqual(['Widgets']);
    expect(model.aiContext?.examples).toEqual([
      'Which widgets are discontinued?'
    ]);
  });

  // Descriptions come from rdfs:comment, or skos:definition / dcterms: / dc:
  // when there is no rdfs:comment (a fixed precedence).
  test('skos:definition and dcterms:description fill the description', () => {
    const ttl = `${PREFIXES}
      ex:A a owl:Class ; skos:definition "Defined via SKOS." .
      ex:B a owl:Class ; dct:description "Described via Dublin Core." .
    `;
    const model = loadOwl(ttl);
    expect(model.entities.find(e => e.name === 'A')!.description)
        .toBe('Defined via SKOS.');
    expect(model.entities.find(e => e.name === 'B')!.description)
        .toBe('Described via Dublin Core.');
  });

  // rdfs:comment wins when more than one description predicate is present.
  test('rdfs:comment takes precedence over skos:definition', () => {
    const ttl = `${PREFIXES}
      ex:A a owl:Class ; rdfs:comment "The comment." ; skos:definition "The definition." .
    `;
    expect(loadOwl(ttl).entities[0].description).toBe('The comment.');
  });
});


describe('multi-domain properties', () => {
  // A datatype property with more than one rdfs:domain becomes a field on
  // each domain entity.
  test('a property with two domains lands on both entities', () => {
    const ttl = `${PREFIXES}
      ex:Person a owl:Class .
      ex:Company a owl:Class .
      ex:name a owl:DatatypeProperty ;
          rdfs:domain ex:Person ; rdfs:domain ex:Company ; rdfs:range xsd:string .
    `;
    const model = loadOwl(ttl);
    expect(model.entities.find(e => e.name === 'Person')!.fields.some(
               f => f.name === 'name'))
        .toBe(true);
    expect(model.entities.find(e => e.name === 'Company')!.fields.some(
               f => f.name === 'name'))
        .toBe(true);
  });
});


describe('mapping table rules (labels, comments, skips)', () => {
  // A datatype property's rdfs:label is a display name -> the field `label`
  // slot; a class/object-property label has no slot, so a *non-redundant* one
  // becomes a synonym; a label that only respaces/recases the name is
  // dropped.
  test('labels route to field label vs. synonyms vs. dropped', () => {
    const ttl = `${PREFIXES}
      ex:Client a owl:Class ; rdfs:label "Customer account" .
      ex:Widget a owl:Class ; rdfs:label "Widget" .
      ex:fullName a owl:DatatypeProperty ;
          rdfs:domain ex:Client ; rdfs:range xsd:string ; rdfs:label "Legal name" .
      ex:code a owl:DatatypeProperty ;
          rdfs:domain ex:Widget ; rdfs:range xsd:string ; rdfs:label "code" .
    `;
    const model = loadOwl(ttl);
    const client = model.entities.find(e => e.name === 'Client')!;
    const widget = model.entities.find(e => e.name === 'Widget')!;
    // Non-redundant class label -> synonym.
    expect(client.aiContext?.synonyms).toEqual(['Customer account']);
    // Redundant class label ("Widget" == name) -> dropped, no ai_context.
    expect(widget.aiContext).toBeUndefined();
    // A datatype-property label that adds a name -> field label slot.
    expect(client.fields.find(f => f.name === 'fullName')!.label)
        .toBe('Legal name');
    // A datatype-property label that only recases the field name -> dropped.
    expect(widget.fields.find(f => f.name === 'code')!.label).toBeUndefined();
  });

  // A property with no usable endpoint can't be placed; it is skipped with a
  // warning rather than failing the conversion.
  test('unmappable properties are warned and skipped', () => {
    const ttl = `${PREFIXES}
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
        const ttl = `${PREFIXES}
      ex:Order a owl:Class ; rdfs:comment "A purchase." .
      ex:Customer a owl:Class .
      ex:amount a owl:DatatypeProperty ;
          rdfs:domain ex:Order ; rdfs:range xsd:decimal ; rdfs:comment "Total charged." .
      ex:placedBy a owl:ObjectProperty ;
          rdfs:domain ex:Order ; rdfs:range ex:Customer ; rdfs:comment "Who placed the order." .
    `;
        const model = loadOwl(ttl);
        const order = model.entities.find(e => e.name === 'Order')!;
        expect(order.description).toBe('A purchase.');
        expect(order.fields.find(f => f.name === 'amount')!.description)
            .toBe('Total charged.');
        const placedBy = model.relationships.find(r => r.name === 'placedBy')!;
        expect(placedBy.aiContext?.instructions).toBe('Who placed the order.');
      });

  // A class has no label slot, so its first (non-redundant) label and every
  // further rdfs:label / skos label all collect as synonyms, in document
  // order.
  test('skos and extra rdfs:label values collect as synonyms', () => {
    const ttl = `${PREFIXES}
      ex:Client a owl:Class ;
          rdfs:label "Customer account" ;
          rdfs:label "Buyer" ;
          skos:altLabel "Account holder" ;
          skos:hiddenLabel "acct" .
    `;
    expect(loadOwl(ttl).entities[0].aiContext?.synonyms).toEqual([
      'Customer account', 'Buyer', 'Account holder', 'acct'
    ]);
  });

  // A synonym that only respaces/recases the term's own name is redundant
  // with the name and dropped -- the same rule the primary label gets.
  test('synonyms redundant with the term name are dropped', () => {
    const ttl = `${PREFIXES}
      ex:Customer a owl:Class ;
          rdfs:label "Customer" ; skos:altLabel "customer" ; skos:altLabel "Buyer" .
    `;
    expect(loadOwl(ttl).entities[0].aiContext?.synonyms).toEqual(['Buyer']);
  });

  // A domain that names something not declared as an owl:Class cannot host a
  // field; it is skipped with a warning naming the property and the domain.
  test('a datatype property whose domain is not a class is skipped', () => {
    const ttl = `${PREFIXES}
      ex:Thing a owl:Class .
      ex:stray a owl:DatatypeProperty ; rdfs:domain ex:NotAClass ; rdfs:range xsd:string .
    `;
    const {yaml, warnings} = convertOwlToOsi(ttl, 'x');
    expect(warnings.some(w => w.includes('stray') && w.includes('NotAClass')))
        .toBe(true);
    expect(
        loadModels(yaml).models[0].entities.find(
                                               e => e.name === 'Thing')!.fields)
        .toHaveLength(0);
  });

  // Terms are named by their local name, so two terms sharing one (e.g.
  // across namespaces) would collapse to one OSI name. The first wins; the
  // rest are warned and skipped, so the output stays valid and loadable.
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
    expect(warnings.some(
               w => w.includes('Customer') && w.includes('more than once')))
        .toBe(true);
    const model = loadModels(yaml).models[0];
    expect(model.entities.map(e => e.name)).toEqual(['Customer']);
    expect(model.entities[0].description).toBe('from a');
  });

  // With no ontology header, the model description records the source base
  // IRI as provenance.
  test('the model description records the source ontology base IRI', () => {
    const ttl = `
      @prefix owl:  <http://www.w3.org/2002/07/owl#> .
      @prefix ex:   <http://example.com/sales#> .
      ex:Customer a owl:Class .
    `;
    expect(loadOwl(ttl).description)
        .toBe('Imported from OWL ontology http://example.com/sales#');
  });
});


// The GOOGLE data.ontology extension is the promotion seam for OWL constructs
// OSI cannot yet express natively (subClassOf, inverseOf, ...). It is defined
// and shape-tested but unused by the current cut, which maps everything it
// reads to native OSI -- see to_ir.ts.
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

  test('is not exercised by the sales example (nothing to promote yet)', () => {
    const {yaml} = convertOwlToOsi(readFixture('sales.owl.ttl'), 'sales');
    expect(yaml).not.toContain('custom_extensions');
    expect(yaml).not.toContain('GOOGLE');
  });
});
