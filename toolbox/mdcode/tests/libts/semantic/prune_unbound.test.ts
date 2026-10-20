// Behavior specification for pruning a model to what a binding binds
// (proposed: `kcmd owl import --prune-unbound`; src/libts/semantic/prune.ts).
//
// The guarantees pinned here:
//   1. kept = the bound entities + their ancestors + the defined entities over
//      a kept base; everything else is removed;
//   2. what refers to a removed entity goes with it -- relationships with a
//      removed end, abstract relationships left with no sub-relationship,
//      constraints whose rule names a removed entity or relationship, and
//      glossary `defines` links (the terms stay);
//   3. the pruned model still loads and passes push validation;
//   4. pruning is pure, reports unknown bound names, and says what it removed
//      (golden summary);
//   5. the bound names come from a binding profile (a profile file or a
//      `semantic_model:` wrapper) or from inline bindings;
//   6. the CLI seam: a named binding document, the bare flag reading the
//      `<model>.profile.<name>.yaml` files beside --out (else
//      `<model>.profiles/` there), and the failure modes.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {loadModels} from '../../../src/libts/semantic/loader';
import {boundEntityNames, formatPruneSummary, pruneUnbound} from '../../../src/libts/semantic/prune';
import {validatePushRequirements} from '../../../src/libts/semantic/validate';
import {owl} from '../../../src/tool/commands';

const SHOP = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
  @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
  @prefix ex:   <https://example.org/shop#> .

  ex:Party a owl:Class .
  ex:Customer a owl:Class ; rdfs:subClassOf ex:Party ;
      owl:hasKey ( ex:customerId ) .
  ex:Supplier a owl:Class ; rdfs:subClassOf ex:Party ;
      owl:hasKey ( ex:supplierId ) .
  ex:Order a owl:Class ; owl:hasKey ( ex:orderId ) ;
      rdfs:subClassOf
          [ a owl:Restriction ; owl:onProperty ex:shippedIn ;
            owl:maxCardinality "1"^^xsd:nonNegativeInteger ] ,
          [ a owl:Restriction ; owl:onProperty ex:placedBy ;
            owl:minCardinality "1"^^xsd:nonNegativeInteger ] .
  ex:LargeOrder a owl:Class ; rdfs:subClassOf ex:Order ;
      owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( ex:Order
          [ a owl:Restriction ; owl:onProperty ex:total ;
            owl:someValuesFrom [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ;
                owl:withRestrictions ( [ xsd:minInclusive "1000"^^xsd:decimal ] ) ] ] ) ] .
  ex:Shipment a owl:Class ; owl:hasKey ( ex:shipmentId ) .
  ex:Department a owl:Class ; owl:hasKey ( ex:departmentId ) .

  ex:customerId a owl:DatatypeProperty ; rdfs:domain ex:Customer ;
      rdfs:range xsd:string .
  ex:supplierId a owl:DatatypeProperty ; rdfs:domain ex:Supplier ;
      rdfs:range xsd:string .
  ex:orderId a owl:DatatypeProperty ; rdfs:domain ex:Order ;
      rdfs:range xsd:string .
  ex:total a owl:DatatypeProperty ; rdfs:domain ex:Order ;
      rdfs:range xsd:decimal .
  ex:shipmentId a owl:DatatypeProperty ; rdfs:domain ex:Shipment ;
      rdfs:range xsd:string .
  ex:departmentId a owl:DatatypeProperty ; rdfs:domain ex:Department ;
      rdfs:range xsd:string .

  ex:involves a owl:ObjectProperty ; rdfs:domain ex:Order ;
      rdfs:range ex:Party .
  ex:placedBy a owl:ObjectProperty ; rdfs:subPropertyOf ex:involves ;
      rdfs:domain ex:Order ; rdfs:range ex:Customer .
  ex:suppliedBy a owl:ObjectProperty ; rdfs:subPropertyOf ex:involves ;
      rdfs:domain ex:Order ; rdfs:range ex:Supplier .
  ex:shippedIn a owl:ObjectProperty ; rdfs:domain ex:Order ;
      rdfs:range ex:Shipment .
  ex:partOf a owl:ObjectProperty ; rdfs:domain ex:Department ;
      rdfs:range ex:Department .
  ex:hasPart a owl:ObjectProperty ; owl:inverseOf ex:partOf .

  ex:shipmentTerm a skos:Concept ; skos:prefLabel "Shipment" ;
      skos:definition "A consignment of goods." ; skos:exactMatch ex:Shipment .
  ex:orderTerm a skos:Concept ; skos:prefLabel "Order" ;
      skos:definition "A request to buy." ; skos:exactMatch ex:Order .
`;

// The full (unpruned) model.
const MODEL = convertOwlToOsi(SHOP, 'shop').model;

const names = (items: {name: string}[]) => items.map(i => i.name);

describe('what pruning keeps', () => {
  const r = pruneUnbound(MODEL, ['Customer', 'Order']);

  test('the bound entities, their ancestors and the defined entities over them',
       () => {
         expect(r.kept).toEqual({
           bound: ['Customer', 'Order'],
           ancestors: ['Party'],
           defined: ['LargeOrder'],
         });
         expect(names(r.model.entities))
             .toEqual(['Party', 'Customer', 'Order', 'LargeOrder']);
         expect(r.pruned.entities).toEqual(['Supplier', 'Shipment', 'Department']);
       });

  test('relationships with a removed end go; an abstract parent with a kept ' +
           'child stays',
       () => {
         expect(names(r.model.relationships)).toEqual(['involves', 'placedBy']);
         expect(r.pruned.relationships)
             .toEqual(['suppliedBy', 'shippedIn', 'partOf']);
       });

  test('constraints that name a removed relationship go; others stay', () => {
    const kept = (r.model.constraints ?? []).map(c => c.name);
    expect(r.pruned.constraints.length).toBe(1);
    expect(r.pruned.constraints[0]).toContain('shippedIn');
    expect(kept.some(n => n.includes('placedBy'))).toBe(true);
  });

  test('glossary links to a removed entity go; the term stays', () => {
    const terms = r.model.glossary!.terms;
    expect(terms.map(t => t.id)).toEqual(
        MODEL.glossary!.terms.map(t => t.id));
    const shipment = terms.find(t => t.id === 'shipment-term')!;
    expect(shipment.defines).toBeUndefined();
    expect(r.pruned.glossaryLinks).toEqual(['shipment-term -> Shipment']);
    expect(terms.find(t => t.id === 'order-term')!.defines?.length).toBe(1);
  });

  test('the input model is not modified', () => {
    const before = JSON.stringify(MODEL);
    pruneUnbound(MODEL, ['Order']);
    expect(JSON.stringify(MODEL)).toBe(before);
  });

  test('the summary says what was kept and removed (golden)', () => {
    expect(formatPruneSummary(r)).toEqual([
      'pruned to the bound entities: kept 4 entities (2 bound, 1 ancestor, ' +
          '1 defined); removed 3 entities, 3 relationships, 1 constraint',
      '  removed entities: Supplier, Shipment, Department',
      '  removed relationships: suppliedBy, shippedIn, partOf',
      `  removed constraints: ${r.pruned.constraints[0]}`,
      '  removed glossary links: shipment-term -> Shipment',
    ].join('\n'));
  });
});

describe('edge cases', () => {
  test('an abstract relationship whose sub-relationships were all removed goes',
       () => {
         const r = pruneUnbound(MODEL, ['Order', 'Party']);
         // involves still has both ends, but placedBy and suppliedBy are gone
         // (Customer and Supplier are not kept), so nothing carries it.
         expect(names(r.model.relationships)).toEqual([]);
         expect(r.pruned.relationships).toContain('involves');
       });

  test('a defined entity over a removed base goes with it', () => {
    const r = pruneUnbound(MODEL, ['Customer']);
    expect(r.kept.defined).toEqual([]);
    expect(r.pruned.entities).toContain('LargeOrder');
  });

  test('a bound name the model does not declare is reported and ignored', () => {
    const r = pruneUnbound(MODEL, ['Order', 'Ghost']);
    expect(r.kept.bound).toEqual(['Order']);
    expect(r.warnings).toEqual([
      `the binding binds 'Ghost', which is not an entity of model 'shop'; ` +
          `ignored.`,
    ]);
  });

  test('the pruned model still loads and validates', () => {
    const {yaml} =
        convertOwlToOsi(SHOP, 'shop', {bound: ['Customer', 'Order']});
    const model = loadModels(yaml, {bindingOptional: true}).models[0];
    expect(names(model.entities))
        .toEqual(['Party', 'Customer', 'Order', 'LargeOrder']);
    expect(validatePushRequirements(
               [{document: 'shop', model}], {targetOptional: true}))
        .toEqual([]);
  });
});

describe('the bound names a binding document declares', () => {
  const PROFILE = `
semantic_model:
  - name: shop
    entities:
      - name: Customer
        source: proj.ds.customer
      - name: Order
        source: proj.ds.orders
      - name: Party
  - name: other
    entities:
      - name: Department
        source: proj.ds.department
`;

  test('entities with a source, in document order', () => {
    expect(boundEntityNames(PROFILE, 'shop')).toEqual(['Customer', 'Order']);
  });

  test('every model when none is named (or the name is not in the document)',
       () => {
         expect(boundEntityNames(PROFILE))
             .toEqual(['Customer', 'Order', 'Department']);
         expect(boundEntityNames(PROFILE, 'absent'))
             .toEqual(['Customer', 'Order', 'Department']);
       });

  test('a model document with inline bindings under `datasets`', () => {
    expect(boundEntityNames(`
semantic_model:
  - name: shop
    datasets:
      - name: Order
        source: proj.ds.orders
      - name: Shipment
        source: "  "
`)).toEqual(['Order']);
  });

  test('a profile file: the entities its top-level profile object binds',
       () => {
         expect(boundEntityNames(`
name: prod
entities:
  - name: Customer
    source: bigquery:proj.ds.customer
  - name: Party
`, 'shop')).toEqual(['Customer']);
         expect(boundEntityNames('name: prod\nentities: []\n')).toEqual([]);
       });

  test('a document that is neither a profile file nor has a semantic_model ' +
           'list is an error',
       () => {
         const message = 'the binding document is neither a profile file ' +
             'nor a document with a semantic_model list.';
         expect(() => boundEntityNames('- shop')).toThrow(message);
         expect(() => boundEntityNames('semantic_model: shop')).toThrow(message);
       });
});

describe('owl import --prune-unbound', () => {
  const PROFILE = `semantic_model:
  - name: shop
    entities:
      - name: Customer
        source: proj.ds.customer
      - name: Order
        source: proj.ds.orders
`;

  function workdir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-prune-'));
    fs.writeFileSync(path.join(dir, 'shop.ttl'), SHOP);
    return dir;
  }
  const entitiesOf = (file: string) =>
      names(loadModels(fs.readFileSync(file, 'utf8'), {bindingOptional: true})
                .models[0]
                .entities);

  test('a named binding document prunes the written model and the coverage ' +
           'report records what was removed',
       async () => {
         const dir = workdir();
         const profile = path.join(dir, 'bigquery.yaml');
         fs.writeFileSync(profile, PROFILE);
         const out = path.join(dir, 'model', 'shop.yaml');
         expect(await owl('import', path.join(dir, 'shop.ttl'), {
           out,
           pruneUnbound: profile,
         })).toBe(0);
         expect(entitiesOf(out))
             .toEqual(['Party', 'Customer', 'Order', 'LargeOrder']);
         const coverage = JSON.parse(fs.readFileSync(
             path.join(dir, 'model', 'coverage.json'), 'utf8'));
         expect(coverage.models.shop.owl.pruned.entities)
             .toEqual(['Supplier', 'Shipment', 'Department']);
       });

  test('the bare flag reads <model>.profiles/ beside --out', async () => {
    const dir = workdir();
    fs.mkdirSync(path.join(dir, 'model', 'shop.profiles'), {recursive: true});
    fs.writeFileSync(
        path.join(dir, 'model', 'shop.profiles', 'bigquery.yaml'), PROFILE);
    const out = path.join(dir, 'model', 'shop.yaml');
    expect(await owl('import', path.join(dir, 'shop.ttl'), {
      out,
      name: 'shop',
      pruneUnbound: true,
    })).toBe(0);
    expect(entitiesOf(out)).toContain('Customer');
    expect(entitiesOf(out)).not.toContain('Shipment');
  });

  test('the bare flag reads the <model>.profile.<name>.yaml files beside ' +
           '--out, which hide <model>.profiles/ as in the layout',
       async () => {
         const dir = workdir();
         fs.mkdirSync(
             path.join(dir, 'model', 'shop.profiles'), {recursive: true});
         // The directory binds Shipment alone; the sibling file is read.
         fs.writeFileSync(
             path.join(dir, 'model', 'shop.profiles', 'bigquery.yaml'),
             'semantic_model:\n  - name: shop\n    entities:\n' +
                 '      - name: Shipment\n        source: proj.ds.shipment\n');
         fs.writeFileSync(
             path.join(dir, 'model', 'shop.profile.bigquery.yaml'),
             'name: bigquery\nentities:\n' +
                 '  - name: Customer\n    source: bigquery:proj.ds.customer\n' +
                 '  - name: Order\n    source: bigquery:proj.ds.orders\n');
         const out = path.join(dir, 'model', 'shop.yaml');
         expect(await owl('import', path.join(dir, 'shop.ttl'), {
           out,
           name: 'shop',
           pruneUnbound: true,
         })).toBe(0);
         expect(entitiesOf(out))
             .toEqual(['Party', 'Customer', 'Order', 'LargeOrder']);
       });

  test('no binding found, or a binding that binds nothing, fails and writes ' +
           'nothing',
       async () => {
         const dir = workdir();
         const out = path.join(dir, 'model', 'shop.yaml');
         expect(await owl('import', path.join(dir, 'shop.ttl'), {
           out,
           pruneUnbound: true,
         })).toBe(1);
         const empty = path.join(dir, 'empty.yaml');
         fs.writeFileSync(
             empty, 'semantic_model:\n  - name: shop\n    entities: []\n');
         expect(await owl('import', path.join(dir, 'shop.ttl'), {
           out,
           pruneUnbound: empty,
         })).toBe(1);
         expect(await owl('import', path.join(dir, 'shop.ttl'), {
           out,
           pruneUnbound: path.join(dir, 'missing.yaml'),
         })).toBe(1);
         expect(fs.existsSync(out)).toBe(false);
       });
});
