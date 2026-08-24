// Behavior specification for the OSI -> OWL exporter
// (convertOsiToOwl in src/libts/semantic/converters/owl/convert.ts).
//
// Export is the inverse of import, scoped to ROUND-TRIP fidelity: a model that
// originated as OWL exports back to Turtle that re-imports to the SAME IR. The
// guarantees pinned here mirror the user-guide section "Exporting to OWL":
//   1. every import fixture round-trips OWL -> OSI -> OWL -> OSI unchanged (and
//      with no warnings -- an OWL-origin model holds nothing OWL cannot
//      express);
//   2. the sales model exports to exactly the documented Turtle (golden); and
//   3. a construct OWL cannot express (a metric, a bound source, a non-column
//      expression, an association, a composite unique key, a deployment target)
//      is dropped with a warning, never silently misrepresented.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {convertOsiToOwl, convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {Field, SemanticModel} from '../../../src/libts/semantic/ir';
import {loadModels} from '../../../src/libts/semantic/loader';

const FIXTURES = path.join(__dirname, 'fixtures', 'owl');

function readFixture(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

// The IR a Turtle ontology imports to, via the normal import path.
function importToIr(ttl: string, name: string): SemanticModel {
  return loadModels(convertOwlToOsi(ttl, name).yaml).models[0];
}

// Every OWL import fixture. Each exercises a different slice of the mapping, so
// running the round-trip over all of them covers the exporter end to end:
//   sales           - the guide CUJ: keys, a unique key, xsd ranges, an edge
//   sales-advanced  - the guide's carriage + hierarchy extensions together
//   carriage        - every construct with no native home (cross-refs, chars)
//   hierarchy       - rdfs:subClassOf -> extends across several levels
//   org             - the stress fixture: full xsd set, composite key,
//                     multi-domain property, self edge, Opaque range
const FIXTURE_NAMES =
    ['sales', 'sales-advanced', 'carriage', 'hierarchy', 'org'];

describe(
    'OWL-origin models round-trip OWL -> OSI -> OWL -> OSI unchanged', () => {
      for (const name of FIXTURE_NAMES) {
        test(`${name} is stable across a full round-trip`, () => {
          const imported = importToIr(readFixture(`${name}.owl.ttl`), name);

          const exported = convertOsiToOwl(imported);
          // An OWL-origin model holds nothing OWL cannot express, so export is
          // lossless: no warnings.
          expect(exported.warnings).toEqual([]);
          // The stats report exactly the model's shape.
          expect(exported.stats.classes).toBe(imported.entities.length);
          expect(exported.stats.objectProperties)
              .toBe(imported.relationships.length);

          // Re-importing the exported Turtle yields the identical IR: the
          // strong round-trip guarantee.
          const reimported = importToIr(exported.turtle, name);
          expect(reimported).toEqual(imported);
        });
      }
    });

describe('sales export matches the documented Turtle (golden)', () => {
  test('produces exactly the golden .ttl', () => {
    const model = loadModels(readFixture('sales.osi.golden.yaml')).models[0];
    const {turtle, warnings} = convertOsiToOwl(model);
    expect(warnings).toEqual([]);
    expect(turtle).toBe(readFixture('sales.owl.golden.ttl'));
  });

  test('the golden .ttl re-imports to the same model', () => {
    const golden = readFixture('sales.owl.golden.ttl');
    const fromGolden = importToIr(golden, 'sales');
    const fromYaml = loadModels(readFixture('sales.osi.golden.yaml')).models[0];
    expect(fromGolden).toEqual(fromYaml);
  });
});

// The OSI-origin round-trip: the mirror of the OWL-origin suite above. A
// hand-authored, fully-OWL-expressible model, exported and re-imported, must be
// IR-stable with no warnings. Its job is to reach paths an OWL-origin fixture
// cannot easily set up -- above all the cross-entity field-order merge
// (orderFields), where a multi-domain field sits at different absolute
// positions on its domains and the single exported property order must be a
// linear extension of every entity's order.
describe('OSI-origin models round-trip OSI -> OWL -> OSI unchanged', () => {
  test('directory is stable across a full round-trip', () => {
    const model =
        loadModels(readFixture('directory.osi.golden.yaml')).models[0];

    const exported = convertOsiToOwl(model);
    // Fully OWL-expressible, so export drops nothing: no warnings.
    expect(exported.warnings).toEqual([]);
    expect(exported.stats.classes).toBe(model.entities.length);
    expect(exported.stats.objectProperties).toBe(model.relationships.length);

    const reimported = importToIr(exported.turtle, 'directory');
    expect(reimported).toEqual(model);
  });

  test('the cross-entity field order is preserved on both domains', () => {
    const model =
        loadModels(readFixture('directory.osi.golden.yaml')).models[0];
    const reimported = importToIr(convertOsiToOwl(model).turtle, 'directory');
    const names = (e: string) =>
        reimported.entities.find(x => x.name === e)!.fields.map(f => f.name);
    // `name` and `createdAt` are multi-domain and sit at different absolute
    // positions on each entity; the single exported property order interleaves
    // companyId between them globally, yet each entity's own order comes back
    // intact -- the topological merge did its job.
    expect(names('Person')).toEqual(['personId', 'email', 'name', 'createdAt']);
    expect(names('Company')).toEqual(['companyId', 'name', 'createdAt']);
  });
});

// A minimal, valid OWL-shaped model to graft one non-OWL construct onto per
// test. On its own it exports with no warnings.
function baseModel(): SemanticModel {
  return {
    name: 'shop',
    description: 'A tiny shop.',
    entities: [{
      name: 'Customer',
      dataSource: 'unbound:Customer',
      keys: ['customerId'],
      fields: [{name: 'customerId', expression: 'customerId', type: 'String'}],
    }],
    relationships: [],
    metrics: [],
  };
}

describe('constructs OWL cannot express are dropped with a warning', () => {
  test('the base model exports cleanly (control)', () => {
    const {warnings, turtle} = convertOsiToOwl(baseModel());
    expect(warnings).toEqual([]);
    expect(turtle).toContain('ex:Customer a owl:Class');
  });

  test('a metric is dropped with a warning', () => {
    const model = baseModel();
    model.metrics =
        [{name: 'customerCount', expression: 'COUNT(Customer.customerId)'}];
    const {warnings, turtle} = convertOsiToOwl(model);
    expect(warnings.some(w => /metric/i.test(w))).toBe(true);
    expect(turtle).not.toContain('customerCount');
  });

  test('a bound (non-unbound) source is dropped with a warning', () => {
    const model = baseModel();
    model.entities[0].dataSource = 'proj.dataset.customers';
    const {warnings, turtle} = convertOsiToOwl(model);
    expect(warnings.some(w => /bound to source/i.test(w))).toBe(true);
    // The class itself is still exported; only the binding is lost.
    expect(turtle).toContain('ex:Customer a owl:Class');
    expect(turtle).not.toContain('proj.dataset.customers');
  });

  test(
      'a field whose expression is not a plain column is dropped with a warning',
      () => {
        const model = baseModel();
        model.entities[0].fields.push({
          name: 'domain',
          expression: 'SPLIT(email, "@")[1]',
          type: 'String'
        });
        const {warnings, turtle} = convertOsiToOwl(model);
        expect(warnings.some(w => /not a plain column/i.test(w))).toBe(true);
        // The property is still exported by name; the expression is not.
        expect(turtle).toContain('ex:domain a owl:DatatypeProperty');
        expect(turtle).not.toContain('SPLIT');
      });

  test('a composite unique key is dropped with a warning', () => {
    const model = baseModel();
    model.entities[0].uniqueKeys = [['firstName', 'lastName']];
    const {warnings} = convertOsiToOwl(model);
    expect(warnings.some(w => /composite unique key/i.test(w))).toBe(true);
  });

  test(
      'a many-to-many association is reduced to its direction with a warning',
      () => {
        const model = baseModel();
        model.entities.push({
          name: 'Product',
          dataSource: 'unbound:Product',
          keys: ['sku'],
          fields: [{name: 'sku', expression: 'sku', type: 'String'}],
        });
        model.relationships = [{
          name: 'purchased',
          source: {entity: 'Customer', columns: ['customerId']},
          destination: {entity: 'Product', columns: ['sku']},
          association: {
            dataSource: 'unbound:Purchase',
            keys: ['purchaseId'],
            sourceColumns: ['customerId'],
            destinationColumns: ['sku'],
          },
        }];
        const {warnings, turtle} = convertOsiToOwl(model);
        expect(warnings.some(w => /association/i.test(w))).toBe(true);
        // The edge's domain -> range direction survives as an object property.
        expect(turtle).toContain('ex:purchased a owl:ObjectProperty');
      });

  test(
      'a non-ontology model-level GOOGLE extension is dropped with a warning',
      () => {
        const model = baseModel();
        model.customExtensions = [{
          vendorName: 'GOOGLE',
          data: JSON.stringify({deploymentTargets: [{type: 'bigquery'}]}),
        }];
        const {warnings, turtle} = convertOsiToOwl(model);
        expect(warnings.some(w => /deploymentTargets/.test(w))).toBe(true);
        expect(turtle).not.toContain('deploymentTargets');
      });
});

// A second entity carrying a same-named field, so a hand-authored model can
// make a multi-domain datatype property diverge across its domains (which an
// OWL-origin model never does).
function twoEntityModel(orderField: Field): SemanticModel {
  const model = baseModel();
  model.entities.push({
    name: 'Order',
    dataSource: 'unbound:Order',
    keys: ['orderId'],
    fields:
        [{name: 'orderId', expression: 'orderId', type: 'String'}, orderField],
  });
  return model;
}

describe('hand-authored constructs OWL cannot faithfully carry warn', () => {
  test(
      'a field defined differently on two entities keeps the first and warns',
      () => {
        const model = twoEntityModel(
            {name: 'status', expression: 'status', type: 'Integer'});
        model.entities[0].fields.push(
            {name: 'status', expression: 'status', type: 'String'});
        const {warnings, turtle} = convertOsiToOwl(model);
        expect(warnings.some(w => /defined differently/.test(w))).toBe(true);
        // Customer is the first domain, so its String range wins; Order's
        // Integer is dropped, not misrepresented as a second property.
        expect(turtle).toContain('rdfs:range xsd:string');
        expect(turtle).not.toContain('xsd:integer');
      });

  test('a field unique on one entity but not another warns', () => {
    const model =
        twoEntityModel({name: 'email', expression: 'email', type: 'String'});
    model.entities[0].fields.push(
        {name: 'email', expression: 'email', type: 'String'});
    model.entities[0].uniqueKeys = [['email']];
    const {warnings} = convertOsiToOwl(model);
    // Same definition on both domains (no "defined differently"), but the
    // inverse-functional status diverges.
    expect(warnings.some(w => /defined differently/.test(w))).toBe(false);
    expect(warnings.some(w => /single-column unique key/.test(w))).toBe(true);
  });

  test('a non-temporal field marked a time dimension warns', () => {
    const model = baseModel();
    model.entities[0].fields.push({
      name: 'code',
      expression: 'code',
      type: 'String',
      dimension: {isTime: true},
    });
    const {warnings} = convertOsiToOwl(model);
    expect(warnings.some(w => /time dimension/.test(w))).toBe(true);
  });

  test(
      'a temporal field with no dimension flag warns (re-import adds one)',
      () => {
        const model = baseModel();
        model.entities[0].fields.push(
            {name: 'created', expression: 'created', type: 'Date'});
        const {warnings} = convertOsiToOwl(model);
        expect(warnings.some(w => /time dimension/.test(w))).toBe(true);
      });

  test(
      'a temporal field flagged is_time:true round-trips without a warning',
      () => {
        const model = baseModel();
        model.entities[0].fields.push({
          name: 'created',
          expression: 'created',
          type: 'Date',
          dimension: {isTime: true},
        });
        const {warnings} = convertOsiToOwl(model);
        expect(warnings.some(w => /time dimension/.test(w))).toBe(false);
      });

  test(
      'a model with no description warns about the synthesized placeholder',
      () => {
        const model = baseModel();
        delete model.description;
        const {warnings} = convertOsiToOwl(model);
        expect(warnings.some(w => /no description/.test(w))).toBe(true);
      });

  test('a relationship with both instructions and a description warns', () => {
    const model = twoEntityModel(
        {name: 'placedAt', expression: 'placedAt', type: 'Date'});
    model.relationships = [{
      name: 'placedBy',
      source: {entity: 'Order', columns: ['TODO_BIND']},
      destination: {entity: 'Customer', columns: ['customerId']},
      description: 'FK to customer.',
      aiContext: {instructions: 'Links an order to its customer.'},
    }];
    const {warnings, turtle} = convertOsiToOwl(model);
    expect(warnings.some(w => /description is dropped/.test(w))).toBe(true);
    // The instructions win as the single rdfs:comment; the description is gone.
    expect(turtle).toContain('Links an order to its customer.');
    expect(turtle).not.toContain('FK to customer.');
  });

  test(
      'a carried bare cross-reference with no base IRI exports as a valid IRI',
      () => {
        const model = twoEntityModel(
            {name: 'placedAt', expression: 'placedAt', type: 'Date'});
        model.relationships = [{
          name: 'placedBy',
          source: {entity: 'Order', columns: ['TODO_BIND']},
          destination: {entity: 'Customer', columns: ['customerId']},
          customExtensions: [{
            vendorName: 'GOOGLE',
            data: JSON.stringify({'owl:inverseOf': 'placed'}),
          }],
        }];
        const {turtle} = convertOsiToOwl(model);
        // No owl:baseIri is carried, so the bare local name expands against the
        // serializer's DEFAULT_BASE and renders prefixed -- never as a broken
        // relative <placed>.
        expect(turtle).toContain('owl:inverseOf ex:placed');
        expect(turtle).not.toContain('<placed>');
      });
});

describe('export warns on the remaining constructs with no OWL home', () => {
  test('an abstract entity warns and still exports as a plain class', () => {
    const model = baseModel();
    model.entities[0].abstract = true;
    const {warnings, turtle} = convertOsiToOwl(model);
    expect(warnings.some(w => /abstract/.test(w))).toBe(true);
    expect(turtle).toContain('ex:Customer a owl:Class');
  });

  test('an imported vendor expression is dropped with a warning', () => {
    const model = baseModel();
    model.entities[0].fields.push({
      name: 'region',
      expression: 'region',
      importedExpression: 'UPPER(region)',
      importedDialect: 'SNOWFLAKE',
      type: 'String',
    });
    const {warnings, turtle} = convertOsiToOwl(model);
    expect(warnings.some(w => /imported vendor expression/.test(w))).toBe(true);
    // The property name and datatype survive; the vendor SQL does not.
    expect(turtle).toContain('ex:region a owl:DatatypeProperty');
    expect(turtle).not.toContain('UPPER');
  });

  test('a relationship to an endpoint outside the model warns', () => {
    const model = baseModel();
    model.relationships = [{
      name: 'ghostLink',
      source: {entity: 'Customer', columns: ['TODO_BIND']},
      destination: {entity: 'Ghost', columns: ['ghostId']},
    }];
    const {warnings, turtle} = convertOsiToOwl(model);
    expect(warnings.some(w => /not an entity in this model/.test(w)))
        .toBe(true);
    // The object property is still emitted; only its range dangles.
    expect(turtle).toContain('ex:ghostLink a owl:ObjectProperty');
  });

  test('bound join columns are dropped with a warning', () => {
    const model = twoEntityModel(
        {name: 'placedAt', expression: 'placedAt', type: 'Date'});
    model.relationships = [{
      name: 'placedBy',
      // A real FK column on the source -- not the TODO_BIND placeholder, not
      // the destination key -- is a bound column OWL object properties cannot
      // carry.
      source: {entity: 'Order', columns: ['customerFk']},
      destination: {entity: 'Customer', columns: ['customerId']},
    }];
    const {warnings} = convertOsiToOwl(model);
    expect(warnings.some(w => /bound join columns/.test(w))).toBe(true);
  });

  test('a non-GOOGLE vendor extension on the model warns', () => {
    const model = baseModel();
    model.customExtensions = [{vendorName: 'ACME', data: '{}'}];
    const {warnings} = convertOsiToOwl(model);
    expect(warnings.some(w => /vendor extension/.test(w))).toBe(true);
  });

  test('an unparseable GOOGLE extension on the model warns', () => {
    const model = baseModel();
    model.customExtensions = [{vendorName: 'GOOGLE', data: '{ not json'}];
    const {warnings} = convertOsiToOwl(model);
    expect(warnings.some(w => /unparseable/.test(w))).toBe(true);
  });

  test(
      'entities that disagree on a shared field order warn and still export',
      () => {
        const model = baseModel();
        model.entities[0].fields = [
          {name: 'customerId', expression: 'customerId', type: 'String'},
          {name: 'a', expression: 'a', type: 'String'},
          {name: 'b', expression: 'b', type: 'String'},
        ];
        model.entities.push({
          name: 'Order',
          dataSource: 'unbound:Order',
          keys: ['orderId'],
          fields: [
            {name: 'orderId', expression: 'orderId', type: 'String'},
            // b before a -- the reverse of Customer, so no single property
            // order satisfies both (a cycle in orderFields' constraints).
            {name: 'b', expression: 'b', type: 'String'},
            {name: 'a', expression: 'a', type: 'String'},
          ],
        });
        const {warnings, turtle} = convertOsiToOwl(model);
        expect(warnings.some(w => /different relative order/.test(w)))
            .toBe(true);
        // Every property is still emitted; only their cross-entity order is
        // arbitrary.
        expect(turtle).toContain('ex:a a owl:DatatypeProperty');
        expect(turtle).toContain('ex:b a owl:DatatypeProperty');
      });
});
