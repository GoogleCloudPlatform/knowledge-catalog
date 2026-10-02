// Behavior specification for the import coverage report (proposed):
// converters/coverage.ts (the shared outcome model, the summary table and the
// coverage.json file), the OWL pass (converters/owl/coverage.ts), the SHACL
// pass (converters/shacl/coverage.ts) and the CLI seam that prints the summary
// and writes the file.
//
// The guarantees pinned here:
//   1. every construct occurrence an import reads is listed exactly once with
//      one outcome -- compiled, hinted or dropped -- and a hint or drop always
//      says why;
//   2. the outcome is a fact about the OUTPUT: a construct is compiled only
//      when the model holds it natively, hinted when only agent text carries
//      it, dropped when nothing does;
//   3. the per-construct summary is stable (golden);
//   4. elements `--prune-unbound` removed are reported as dropped ("pruned");
//   5. coverage.json keeps the OWL and SHACL reports of a model side by side;
//   6. `kcmd owl import` / `kcmd shacl import` write it beside the model they
//      write, or to --coverage <path>, and not at all with --no-coverage.

import {describe, expect, test} from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {buildCoverageReport, CoverageEntry, CoverageFile, formatCoverageSummary, summarizeCoverage, writeCoverageFile} from '../../../src/libts/semantic/converters/coverage';
import {convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {importShacl} from '../../../src/libts/semantic/converters/shacl/import';
import {owl, shacl} from '../../../src/tool/commands';

const PREFIXES = `
  @prefix owl:  <http://www.w3.org/2002/07/owl#> .
  @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
  @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
  @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
  @prefix ex:   <https://example.org/shop#> .
`;

// One occurrence of most constructs the OWL importer recognizes.
const SHOP = `${PREFIXES}
  ex:shop a owl:Ontology ; rdfs:comment "A small shop." .

  ex:Party a owl:Class ; rdfs:comment "Anyone the shop deals with." .
  ex:Customer a owl:Class ; rdfs:subClassOf ex:Party ;
      owl:hasKey ( ex:customerId ) ; skos:altLabel "client" ;
      owl:equivalentClass ex:Patron .
  ex:Patron a owl:Class .
  ex:Order a owl:Class ; owl:hasKey ( ex:orderId ) .
  ex:Department a owl:Class ; owl:hasKey ( ex:departmentId ) .
  ex:LargeOrder a owl:Class ; rdfs:subClassOf ex:Order ;
      owl:equivalentClass [ a owl:Class ; owl:intersectionOf ( ex:Order
          [ a owl:Restriction ; owl:onProperty ex:total ;
            owl:someValuesFrom [ a rdfs:Datatype ; owl:onDatatype xsd:decimal ;
                owl:withRestrictions ( [ xsd:minInclusive "1000"^^xsd:decimal ] ) ] ] ) ] .
  ex:Color a owl:Class ; owl:oneOf ( ex:Red ex:Blue ) .
  ex:Voucher a owl:Class ; owl:deprecated true ; rdfs:seeAlso ex:Order .

  ex:customerId a owl:DatatypeProperty ; rdfs:domain ex:Customer ;
      rdfs:range xsd:string .
  ex:orderId a owl:DatatypeProperty ; rdfs:domain ex:Order ;
      rdfs:range xsd:string .
  ex:total a owl:DatatypeProperty , owl:FunctionalProperty ;
      rdfs:domain ex:Order ; rdfs:range xsd:decimal .
  ex:departmentId a owl:DatatypeProperty ; rdfs:domain ex:Department ;
      rdfs:range xsd:string .

  ex:placedBy a owl:ObjectProperty ; rdfs:domain ex:Order ;
      rdfs:range ex:Customer .
  ex:placed a owl:ObjectProperty ; owl:inverseOf ex:placedBy .
  ex:assignedTo a owl:ObjectProperty ; rdfs:domain ex:Customer ;
      rdfs:range ex:Department .
  ex:servedBy a owl:ObjectProperty ; rdfs:domain ex:Order ;
      rdfs:range ex:Department ;
      owl:propertyChainAxiom ( ex:placedBy ex:assignedTo ) .
  ex:partOf a owl:ObjectProperty , owl:TransitiveProperty ;
      rdfs:domain ex:Department ; rdfs:range ex:Department .
  ex:twinOf a owl:ObjectProperty , owl:SymmetricProperty ;
      rdfs:domain ex:Department ; rdfs:range ex:Department .
`;

function find(entries: CoverageEntry[], construct: string, subject: string):
    CoverageEntry|undefined {
  return entries.find(e => e.construct === construct && e.subject === subject);
}

describe('OWL import coverage lists every construct with its outcome', () => {
  const {coverage} = convertOwlToOsi(SHOP, 'shop');

  test('structure the model holds natively is compiled, with its target', () => {
    expect(find(coverage, 'rdfs:subClassOf', 'Customer SubClassOf Party'))
        .toEqual({
          construct: 'rdfs:subClassOf',
          subject: 'Customer SubClassOf Party',
          outcome: 'compiled',
          target: 'entity Customer extends',
        });
    expect(find(coverage, 'owl:hasKey', 'Order HasKey (orderId)')?.target)
        .toBe('entity Order primary_key');
    expect(find(coverage, 'owl:ObjectProperty', 'placedBy')?.target)
        .toBe('relationship placedBy');
    expect(find(coverage, 'owl:inverseOf', 'placed InverseOf placedBy'))
        .toMatchObject({
          outcome: 'compiled',
          target: 'relationship placedBy inverse placed',
        });
    expect(find(coverage, 'owl:ObjectProperty', 'placed')).toMatchObject({
      outcome: 'compiled',
      target: 'relationship placedBy inverse',
    });
  });

  test('a defined class compiles to a defined entity, restrictions included',
       () => {
         expect(find(
                    coverage, 'owl:equivalentClass (defined class)',
                    'LargeOrder EquivalentTo <class expression>'))
             .toMatchObject({
               outcome: 'compiled',
               target: 'defined entity LargeOrder definition.expression',
             });
         const restriction = coverage.find(
             e => e.construct === 'owl:Restriction' &&
                 e.subject.startsWith('LargeOrder EquivalentTo'));
         expect(restriction).toMatchObject({
           outcome: 'compiled',
           reason: 'part of the membership predicate',
         });
       });

  test('characteristics agents can only be told about are hinted', () => {
    expect(find(coverage, 'owl:TransitiveProperty', 'partOf')).toMatchObject({
      outcome: 'hinted',
      target: 'relationship partOf ai_context.instructions',
    });
    expect(find(coverage, 'owl:SymmetricProperty', 'twinOf')).toMatchObject({
      outcome: 'hinted',
      target: 'relationship twinOf ai_context.instructions',
    });
    expect(find(
               coverage, 'owl:equivalentClass (named)',
               'Customer EquivalentTo Patron'))
        .toMatchObject({
          outcome: 'hinted',
          target: 'entity Customer ai_context.synonyms',
        });
    expect(find(coverage, 'owl:deprecated', 'Voucher')?.outcome).toBe('hinted');
  });

  test('constructs with no home are dropped, with the reason', () => {
    expect(find(
               coverage, 'owl:propertyChainAxiom',
               'servedBy = placedBy o assignedTo'))
        .toMatchObject({outcome: 'dropped'});
    expect(find(
               coverage, 'owl:propertyChainAxiom',
               'servedBy = placedBy o assignedTo')
               ?.reason)
        .toContain('property chain');
    expect(find(coverage, 'owl:oneOf', 'Color = {Red Blue}')?.outcome)
        .toBe('dropped');
  });

  test('a single-valued datatype property is compiled by construction', () => {
    expect(find(coverage, 'owl:FunctionalProperty', 'Order.total'))
        .toMatchObject({
          outcome: 'compiled',
          reason: 'guaranteed by construction: a field holds at most one value',
        });
  });

  test('every hint and drop says why; every compiled or hinted entry says where',
       () => {
         for (const e of coverage) {
           if (e.outcome !== 'compiled') expect(e.reason).toBeTruthy();
           if (e.outcome !== 'dropped') expect(e.target).toBeTruthy();
         }
       });

  test('the summary counts each construct by outcome (golden)', () => {
    const report = buildCoverageReport('owl', 'shop', ['shop.ttl'], coverage);
    expect(formatCoverageSummary(report)).toEqual(OWL_SUMMARY_GOLDEN);
  });
});

const OWL_SUMMARY_GOLDEN = [
  `coverage (owl import of model 'shop'):`,
  '  construct                            compiled  hinted  dropped',
  '  owl:Class                                   8       0        0',
  '  rdfs:subClassOf                             2       0        0',
  '  owl:hasKey                                  3       0        0',
  '  owl:DatatypeProperty                        4       0        0',
  '  rdfs:range                                  4       0        0',
  '  owl:FunctionalProperty                      1       0        0',
  '  owl:ObjectProperty                          6       0        0',
  '  owl:inverseOf                               1       0        0',
  '  owl:propertyChainAxiom                      0       0        1',
  '  owl:TransitiveProperty                      0       1        0',
  '  owl:SymmetricProperty                       0       1        0',
  '  owl:equivalentClass (named)                 0       1        0',
  '  owl:equivalentClass (defined class)         1       0        0',
  '  owl:Restriction                             1       0        0',
  '  owl:oneOf                                   0       0        1',
  '  rdfs:comment                                1       0        0',
  '  skos:altLabel                               1       0        0',
  '  owl:deprecated                              0       1        0',
  '  rdfs:seeAlso                                0       1        0',
  '  owl:Ontology                                1       0        0',
  '  total                                      34       5        2',
].join('\n');

describe('pruned elements are reported as dropped', () => {
  test('a class, its fields and its edges dropped by --prune-unbound say so',
       () => {
         const {coverage, prune} =
             convertOwlToOsi(SHOP, 'shop', {bound: ['Order', 'Customer']});
         expect(prune?.pruned.entities).toContain('Department');
         const reason = find(coverage, 'owl:Class', 'Department')?.reason;
         expect(reason).toStartWith('pruned (--prune-unbound)');
         expect(find(coverage, 'owl:DatatypeProperty', 'Department.departmentId'))
             .toMatchObject({outcome: 'dropped', reason});
         expect(find(coverage, 'owl:TransitiveProperty', 'partOf'))
             .toMatchObject({outcome: 'dropped', reason});
         // What was kept keeps its outcome.
         expect(find(coverage, 'owl:ObjectProperty', 'placedBy')?.outcome)
             .toBe('compiled');
       });
});

const SHACL_MODEL = `version: 0.2.0.dev0/google
semantic_model:
  - name: shop
    entities:
      - name: Customer
        fields:
          - name: customerId
            datatype: String
      - name: Order
        fields:
          - name: orderId
            datatype: String
          - name: status
            datatype: String
          - name: total
            datatype: Decimal
    relationships:
      - name: placedBy
        from: Order
        to: Customer
`;

const SHACL_SHAPES = `
  @prefix sh:  <http://www.w3.org/ns/shacl#> .
  @prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
  @prefix ex:  <https://example.org/shop#> .
  @prefix shp: <https://example.org/shapes#> .

  shp:OrderShape a sh:NodeShape ;
      sh:targetClass ex:Order ;
      sh:property [ sh:path ex:placedBy ; sh:minCount 1 ; sh:maxCount 1 ;
                    sh:message "Every order has exactly one customer." ] ;
      sh:property [ sh:path ex:orderId ; sh:minCount 1 ; sh:datatype xsd:string ;
                    sh:pattern "^O-[0-9]+$" ; sh:name "order id" ] ;
      sh:property [ sh:path ex:status ; sh:in ( "open" "shipped" ) ;
                    sh:severity sh:Warning ] ;
      sh:property [ sh:path ex:total ; sh:minInclusive 0 ;
                    sh:node shp:MoneyShape ] ;
      sh:property [ sh:path ex:discount ; sh:maxCount 1 ] .

  shp:VipShape a sh:NodeShape ;
      sh:targetNode ex:alice ;
      sh:property [ sh:path ex:customerId ; sh:minCount 1 ] .

  shp:RetiredShape a sh:NodeShape ;
      sh:targetClass ex:Customer ;
      sh:deactivated true ;
      sh:property [ sh:path ex:customerId ; sh:minCount 1 ] .
`;

describe('SHACL import coverage lists every shape and component', () => {
  const {coverage} = importShacl(SHACL_SHAPES, SHACL_MODEL);

  test('a node shape whose rules became constraints is compiled', () => {
    expect(find(coverage, 'sh:NodeShape', 'OrderShape')).toEqual({
      construct: 'sh:NodeShape',
      subject: 'OrderShape',
      outcome: 'compiled',
      target: 'target Order',
    });
  });

  test('each component names the constraint that states it', () => {
    const subject = 'OrderShape / placedBy on Order';
    for (const term of ['sh:minCount', 'sh:maxCount', 'sh:message']) {
      expect(find(coverage, term, subject)?.target)
          .toBe('constraint Order_placedBy_exactly_1');
    }
    expect(find(coverage, 'sh:pattern', 'OrderShape / orderId on Order')?.target)
        .toBe('constraint Order_orderId_pattern');
  });

  test('a component the model already guarantees is compiled into structure',
       () => {
         expect(find(coverage, 'sh:datatype', 'OrderShape / orderId on Order'))
             .toMatchObject({outcome: 'compiled', target: 'model structure'});
       });

  test('unsupported components, untargeted and deactivated shapes are dropped',
       () => {
         expect(find(coverage, 'sh:node', 'OrderShape / total on Order')?.outcome)
             .toBe('dropped');
         expect(find(coverage, 'sh:name', 'OrderShape / orderId on Order')?.outcome)
             .toBe('dropped');
         expect(find(coverage, 'sh:PropertyShape', 'OrderShape / discount on Order')
                    ?.outcome)
             .toBe('dropped');
         expect(find(coverage, 'sh:targetNode', 'VipShape')?.outcome)
             .toBe('dropped');
         expect(find(coverage, 'sh:PropertyShape', 'VipShape / customerId'))
             .toMatchObject({
               outcome: 'dropped',
               reason: 'its node shape has no target class',
             });
         expect(find(coverage, 'sh:NodeShape', 'RetiredShape')).toMatchObject({
           outcome: 'dropped',
           reason: 'sh:deactivated true',
         });
       });

  test('the summary counts each construct by outcome (golden)', () => {
    const report =
        buildCoverageReport('shacl', 'shop', ['shapes.ttl'], coverage);
    expect(formatCoverageSummary(report)).toEqual(SHACL_SUMMARY_GOLDEN);
  });
});

const SHACL_SUMMARY_GOLDEN = [
  `coverage (shacl import of model 'shop'):`,
  '  construct         compiled  hinted  dropped',
  '  sh:NodeShape             1       0        2',
  '  sh:PropertyShape         4       0        3',
  '  sh:minCount              2       0        0',
  '  sh:maxCount              1       0        1',
  '  sh:message               1       0        0',
  '  sh:datatype              1       0        0',
  '  sh:pattern               1       0        0',
  '  sh:name                  0       0        1',
  '  sh:in                    1       0        0',
  '  sh:severity              1       0        0',
  '  sh:minInclusive          1       0        0',
  '  sh:node                  0       0        1',
  '  sh:targetNode            0       0        1',
  '  total                   14       0        9',
].join('\n');

describe('the summary and the report', () => {
  const entries: CoverageEntry[] = [
    {construct: 'a', subject: '1', outcome: 'compiled', target: 't'},
    {construct: 'b', subject: '2', outcome: 'dropped', reason: 'r'},
    {construct: 'a', subject: '3', outcome: 'hinted', target: 't', reason: 'r'},
  ];

  test('rows follow first appearance; totals add up', () => {
    expect(summarizeCoverage(entries)).toEqual([
      {construct: 'a', compiled: 1, hinted: 1, dropped: 0},
      {construct: 'b', compiled: 0, hinted: 0, dropped: 1},
    ]);
    const report = buildCoverageReport('owl', 'm', ['m.ttl'], entries);
    expect(report.totals).toEqual({compiled: 1, hinted: 1, dropped: 1});
    expect(report.pruned).toBeUndefined();
  });
});

describe('coverage.json keeps each model\'s OWL and SHACL reports', () => {
  const owlReport = buildCoverageReport('owl', 'shop', ['shop.ttl'], [
    {construct: 'owl:Class', subject: 'Order', outcome: 'compiled', target: 'x'},
  ]);
  const shaclReport = buildCoverageReport('shacl', 'shop', ['shapes.ttl'], [
    {construct: 'sh:NodeShape', subject: 'S', outcome: 'dropped', reason: 'r'},
  ]);

  test('a SHACL report lands beside the OWL report of the same model', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-coverage-'));
    const file = path.join(dir, 'coverage.json');
    writeCoverageFile(file, owlReport);
    writeCoverageFile(file, shaclReport);
    writeCoverageFile(file, {...owlReport, model: 'other'});
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as CoverageFile;
    expect(data.coverage_version).toBe(1);
    expect(Object.keys(data.models)).toEqual(['shop', 'other']);
    expect(data.models.shop.owl).toEqual(owlReport);
    expect(data.models.shop.shacl).toEqual(shaclReport);
  });

  test('a file that is not a coverage report is replaced', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-coverage-'));
    const file = path.join(dir, 'coverage.json');
    fs.writeFileSync(file, '{"something": "else"}');
    writeCoverageFile(file, owlReport);
    const data = JSON.parse(fs.readFileSync(file, 'utf8')) as CoverageFile;
    expect(Object.keys(data)).toEqual(['coverage_version', 'models']);
    expect(data.models.shop.owl).toEqual(owlReport);
  });
});

describe('the import commands print the summary and write coverage.json', () => {
  function workdir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kcmd-coverage-cli-'));
    fs.writeFileSync(path.join(dir, 'shop.ttl'), SHOP);
    fs.writeFileSync(path.join(dir, 'shapes.ttl'), SHACL_SHAPES);
    return dir;
  }

  test('owl then shacl import: one coverage.json beside the model, both reports',
       async () => {
         const dir = workdir();
         const model = path.join(dir, 'out', 'shop.yaml');
         expect(await owl('import', path.join(dir, 'shop.ttl'), {out: model}))
             .toBe(0);
         expect(await shacl('import', path.join(dir, 'shapes.ttl'), {
           into: model,
         })).toBe(0);
         const data = JSON.parse(fs.readFileSync(
                          path.join(dir, 'out', 'coverage.json'), 'utf8')) as
             CoverageFile;
         expect(data.models.shop.owl?.importer).toBe('owl');
         expect(data.models.shop.owl?.sources).toEqual([path.join(dir, 'shop.ttl')]);
         expect(data.models.shop.shacl?.importer).toBe('shacl');
         expect(data.models.shop.shacl?.entries.length).toBeGreaterThan(0);
       });

  test('--coverage <path> writes there; --no-coverage writes nothing', async () => {
    const dir = workdir();
    const custom = path.join(dir, 'reports', 'shop.coverage.json');
    expect(await owl('import', path.join(dir, 'shop.ttl'), {
      out: path.join(dir, 'a', 'shop.yaml'),
      coverage: custom,
    })).toBe(0);
    expect(fs.existsSync(custom)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'a', 'coverage.json'))).toBe(false);

    expect(await owl('import', path.join(dir, 'shop.ttl'), {
      out: path.join(dir, 'b', 'shop.yaml'),
      coverage: false,
    })).toBe(0);
    expect(fs.existsSync(path.join(dir, 'b', 'coverage.json'))).toBe(false);
  });
});
