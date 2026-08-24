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
import {SemanticModel} from '../../../src/libts/semantic/ir';
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
