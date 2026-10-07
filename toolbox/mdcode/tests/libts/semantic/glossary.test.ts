// Behavior specification for K9: the business glossary
// (src/libts/semantic/glossary.ts) -- the `glossary:` spec block through the
// loader and push validation, the Knowledge Catalog (Dataplex) request plan
// with its exact REST bodies and entry-link types, the description codec and
// pull reverse, OSI round-trip, and the OWL importer's SKOS mapping.
//
// Running example (neutral): an order table and a customer table, with a
// small revenue vocabulary.

import {describe, expect, test} from 'bun:test';

import {convertOwlToOsi} from '../../../src/libts/semantic/converters/owl/convert';
import {checkGlossary, glossaryDoc, glossaryFromDataplex, glossaryId, GlossaryRequest, LINK_TYPES, linkId, planGlossary, splitTermDescription, termDescription, termEntryName} from '../../../src/libts/semantic/glossary';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {fromDocument, loadModels} from '../../../src/libts/semantic/loader';
import {serializeModel} from '../../../src/libts/semantic/osi_converter';
import {validatePushRequirements} from '../../../src/libts/semantic/validate';

const GOOGLE = '0.2.0.dev0/google';

function doc(glossary: any, version = GOOGLE) {
  return {
    version,
    semantic_model: [{
      name: 'shop',
      datasets: [
        {
          name: 'Party',
          abstract: true,
          fields: [{name: 'displayName', datatype: 'String'}],
        },
        {
          name: 'Customer',
          source: 'data-proj.sales.customers',
          primary_key: ['customerId'],
          extends: ['Party'],
          fields: [
            {name: 'customerId', expression: 'customer_id', datatype: 'String'},
            {name: 'displayName', expression: 'name', datatype: 'String'},
          ],
        },
        {
          name: 'Order',
          source: 'data-proj.sales.orders',
          primary_key: ['orderId'],
          fields: [
            {name: 'orderId', expression: 'order_id', datatype: 'String'},
            {name: 'total', expression: 'total_amount', datatype: 'Decimal'},
            {name: 'net', expression: 'total_amount - tax', datatype: 'Decimal'},
          ],
        },
      ],
      metrics: [{name: 'revenue', expression: 'SUM(Order.total)'}],
      glossary,
    }],
  };
}

const GLOSSARY = {
  description: 'Commercial vocabulary.',
  categories: [
    {id: 'finance', display_name: 'Finance'},
    {id: 'sales-finance', parent: 'finance'},
  ],
  terms: [
    {
      id: 'revenue',
      display_name: 'Revenue',
      definition: 'Total value of orders.',
      category: 'finance',
      synonyms: ['sales', 'turnover'],
      related: ['order-total'],
      formula: 'SUM(Order.total)',
      defines: [{metric: 'revenue'}, {entity: 'Order'}],
      source: 'finance handbook, section 2',
    },
    {
      id: 'order-total',
      definition: 'Gross amount of one order.',
      category: 'sales-finance',
      defines: [{field: 'Order.total'}],
    },
    {
      id: 'customer-name',
      display_name: 'Customer Name',
      definition: 'Name the customer trades under.',
      // Inherited from the abstract Party.
      defines: [{field: 'Customer.displayName'}],
    },
  ],
};

function loaded(): SemanticModel {
  return fromDocument(doc(GLOSSARY)).models[0];
}

describe('loader', () => {
  test('the glossary loads onto the IR in camelCase', () => {
    const {models, warnings} = fromDocument(doc(GLOSSARY));
    const g = models[0].glossary!;
    expect(warnings).toEqual([]);
    expect(g.categories[1]).toEqual({id: 'sales-finance', parent: 'finance'});
    expect(g.terms[0]).toEqual({
      id: 'revenue',
      displayName: 'Revenue',
      definition: 'Total value of orders.',
      category: 'finance',
      synonyms: ['sales', 'turnover'],
      related: ['order-total'],
      formula: 'SUM(Order.total)',
      defines: [{kind: 'metric', ref: 'revenue'}, {kind: 'entity', ref: 'Order'}],
      source: 'finance handbook, section 2',
    });
  });

  test('extended profile only: vanilla Ossie rejects the key', () => {
    expect(() => fromDocument(doc(GLOSSARY, '0.2.0.dev0'))).toThrow();
  });

  test('ids follow the Dataplex resource-id rule', () => {
    expect(() => fromDocument(doc({terms: [{id: 'Revenue'}]}))).toThrow();
    expect(() => fromDocument(doc({terms: [{id: 'net_revenue'}]}))).toThrow();
    expect(() => fromDocument(doc({terms: [{id: '1st'}]}))).toThrow();
  });

  test('unknown keys and multi-key defines items are rejected', () => {
    expect(() => fromDocument(doc({terms: [{id: 'a', synonym: ['x']}]}))).toThrow();
    expect(() => fromDocument(
               doc({terms: [{id: 'a', defines: [{entity: 'Order', metric: 'revenue'}]}]})))
        .toThrow();
  });

  test('an unresolved reference loads with a warning', () => {
    const {warnings} =
        fromDocument(doc({terms: [{id: 'a', definition: 'x', defines: [{entity: 'Nope'}]}]}));
    expect(warnings.some(w => /defines entity 'Nope'/.test(w))).toBe(true);
  });
});

describe('validation', () => {
  const errorsOf = (m: SemanticModel, fieldsPruned = false) =>
      validatePushRequirements(
          [{document: 'shop.yaml', model: m} as any],
          {targetOptional: true, fieldsPruned});

  test('the running example is valid (inherited field resolves)', () => {
    expect(checkGlossary(loaded())).toEqual({errors: [], warnings: []});
    expect(errorsOf(loaded())).toEqual([]);
  });

  test('duplicate ids, unknown category / parent / related are errors', () => {
    const m = loaded();
    m.glossary!.terms.push({id: 'revenue', definition: 'dup'});
    m.glossary!.terms[1].category = 'nope';
    m.glossary!.terms[1].related = ['ghost'];
    m.glossary!.categories.push({id: 'x', parent: 'missing'});
    const {errors} = checkGlossary(m);
    expect(errors.some(e => /duplicate term id 'revenue'/.test(e))).toBe(true);
    expect(errors.some(e => /category 'nope' is not a category/.test(e))).toBe(true);
    expect(errors.some(e => /related term 'ghost'/.test(e))).toBe(true);
    expect(errors.some(e => /parent 'missing'/.test(e))).toBe(true);
    expect(errorsOf(m).length).toBeGreaterThan(0);
  });

  test('category cycles and nesting deeper than 3 are errors', () => {
    const m = loaded();
    m.glossary!.categories = [
      {id: 'a', parent: 'b'}, {id: 'b', parent: 'a'},
      {id: 'l1'}, {id: 'l2', parent: 'l1'}, {id: 'l3', parent: 'l2'},
      {id: 'l4', parent: 'l3'},
    ];
    m.glossary!.terms = [];
    const {errors} = checkGlossary(m);
    expect(errors.some(e => /'a' is its own ancestor/.test(e))).toBe(true);
    expect(errors.some(e => /'l4' is nested 4 levels/.test(e))).toBe(true);
    expect(errors.some(e => /'l3' is nested/.test(e))).toBe(false);
  });

  test('unresolved defines: error, or warning when fields are pruned', () => {
    const m = loaded();
    m.glossary!.terms[1].defines = [{kind: 'field', ref: 'Order.gone'}];
    expect(checkGlossary(m).errors.some(e => /'Order.gone'/.test(e))).toBe(true);
    const pruned = checkGlossary(m, {fieldsPruned: true});
    expect(pruned.errors).toEqual([]);
    expect(pruned.warnings.some(w => /'Order.gone'/.test(w))).toBe(true);
    expect(errorsOf(m, true)).toEqual([]);
  });

  test('a missing definition and >10 terms on a table are warnings', () => {
    const m = loaded();
    m.glossary!.terms = Array.from({length: 11}, (_, i) => ({
      id: `t${i}`,
      defines: [{kind: 'entity' as const, ref: 'Order'}],
    }));
    const {errors, warnings} = checkGlossary(m);
    expect(errors).toEqual([]);
    expect(warnings.some(w => /'t0': has no definition/.test(w))).toBe(true);
    expect(warnings.some(w => /11 terms define entity 'Order'/.test(w))).toBe(true);
  });
});

describe('term description codec', () => {
  test('definition then fixed trailers; synonyms searchable', () => {
    const t = loaded().glossary!.terms[0];
    expect(termDescription(t)).toBe(
        'Total value of orders.\n\n' +
        'Formula: SUM(Order.total)\n\n' +
        'Also called: sales, turnover.\n\n' +
        'Related terms: order-total.\n\n' +
        'Defines: revenue (metric), Order (entity).\n\n' +
        'Source: finance handbook, section 2');
  });

  test('splitTermDescription inverts it', () => {
    const t = loaded().glossary!.terms[0];
    const {id, displayName, category, ...rest} = t;
    expect(splitTermDescription(termDescription(t))).toEqual(rest);
    expect(splitTermDescription('Just prose.\n\nMore prose.'))
        .toEqual({definition: 'Just prose.\n\nMore prose.'});
  });
});

describe('Dataplex request plan', () => {
  const TARGET = {
    project: 'gloss-proj',
    projectNumber: '111',
    location: 'global',
    semantic: {project: 'kc-proj', projectNumber: '222', location: 'us',
               entryGroup: 'shop_eg'},
    datasetLocations: new Map([['data-proj.sales', 'US']]),
    projectNumbers: new Map([['data-proj', '333']]),
  };
  const plan = planGlossary(loaded(), TARGET);
  const req = (kind: string, id?: string) =>
      plan.requests.filter(r => r.kind === kind && (!id || r.id === id));
  const links = req('link');
  const TERM = (t: string) => termEntryName('111', 'global', 'shop-glossary', t);

  test('glossary first: LRO create with labels, PATCH on 409', () => {
    const g = plan.requests[0];
    expect(g).toMatchObject({
      kind: 'glossary',
      method: 'POST',
      path: 'projects/gloss-proj/locations/global/glossaries',
      query: {glossaryId: 'shop-glossary'},
      lro: true,
      onConflict: {updateMask: 'displayName,description,labels'},
    });
    expect(g.body).toEqual({
      displayName: 'Shop Glossary',
      description: 'Commercial vocabulary.',
      labels: {'managed-by': 'kcmd', 'kcmd-model': 'shop'},
    });
    expect(plan.glossaryName)
        .toBe('projects/gloss-proj/locations/global/glossaries/shop-glossary');
    expect(glossaryId(loaded())).toBe('shop-glossary');
  });

  test('categories parent-first, with full parent names', () => {
    const cats = req('category');
    expect(cats.map(c => c.id)).toEqual(['finance', 'sales-finance']);
    expect(cats[1]).toMatchObject({
      path: `${plan.glossaryName}/categories`,
      query: {categoryId: 'sales-finance'},
    });
    expect(cats[1].body.parent).toBe(`${plan.glossaryName}/categories/finance`);
    expect(cats[0].body.parent).toBe(plan.glossaryName);
  });

  test('terms POST to the glossary with parent = category or glossary', () => {
    const [rev] = req('term', 'revenue');
    expect(rev).toMatchObject({
      path: `${plan.glossaryName}/terms`,
      query: {termId: 'revenue'},
      onConflict: {updateMask: 'displayName,description,labels,parent'},
    });
    expect(rev.body.parent).toBe(`${plan.glossaryName}/categories/finance`);
    expect(rev.body.description).toContain('Also called: sales, turnover.');
    expect(req('term', 'customer-name')[0].body.parent).toBe(plan.glossaryName);
    expect(req('term', 'order-total')[0].body.displayName).toBe('Order Total');
  });

  test('term entry names use the project number and @dataplex', () => {
    expect(TERM('revenue')).toBe(
        'projects/111/locations/global/entryGroups/@dataplex/entries/' +
        'projects/111/locations/global/glossaries/shop-glossary/terms/revenue');
  });

  test('related: one link per pair in @dataplex, both UNSPECIFIED', () => {
    const rel = links.filter(l => l.body.entryLinkType === LINK_TYPES.related);
    expect(rel.length).toBe(1);
    expect(LINK_TYPES.related)
        .toBe('projects/dataplex-types/locations/global/entryLinkTypes/related');
    expect(rel[0].path)
        .toBe('projects/gloss-proj/locations/global/entryGroups/@dataplex/entryLinks');
    expect(rel[0].body.entryReferences).toEqual([
      {name: TERM('order-total'), type: 'UNSPECIFIED'},
      {name: TERM('revenue'), type: 'UNSPECIFIED'},
    ]);
    expect(rel[0].onConflict).toBe('exists');
  });

  test('definition (field): BigQuery table entry in @bigquery, Schema.<column>', () => {
    const def = links.find(
        l => l.body.entryLinkType === LINK_TYPES.definition &&
            l.path.includes('@bigquery') &&
            l.body.entryReferences[1].name === TERM('order-total'))!;
    expect(LINK_TYPES.definition)
        .toBe('projects/dataplex-types/locations/global/entryLinkTypes/definition');
    expect(def.path)
        .toBe('projects/333/locations/us/entryGroups/@bigquery/entryLinks');
    expect(def.body).toEqual({
      entryLinkType: LINK_TYPES.definition,
      entryReferences: [
        {
          name: 'projects/333/locations/us/entryGroups/@bigquery/entries/' +
              'bigquery.googleapis.com/projects/data-proj/datasets/sales/tables/orders',
          path: 'Schema.total_amount',
          type: 'SOURCE',
        },
        {name: TERM('order-total'), type: 'TARGET'},
      ],
    });
    expect(def.query.entryLinkId).toBe(def.id);
    expect(def.id).toMatch(/^def-order-total-[0-9a-f]{8}$/);
  });

  test('definition (inherited field): the concrete table column', () => {
    const def = links.find(
        l => l.path.includes('@bigquery') &&
            l.body.entryReferences[1].name === TERM('customer-name'))!;
    expect(def.body.entryReferences[0]).toMatchObject({
      name: expect.stringContaining('/tables/customers'),
      path: 'Schema.name',
    });
  });

  test('definition (entity): the whole table, no path', () => {
    const def = links.find(
        l => l.path.includes('@bigquery') &&
            l.body.entryReferences[1].name === TERM('revenue'))!;
    expect(def.body.entryReferences[0].path).toBeUndefined();
    expect(def.body.entryReferences[0].name).toContain('/tables/orders');
  });

  test('semantic legs in the kcmd entry group (entity, field, metric)', () => {
    const sem = links.filter(l => l.path.includes('/entryGroups/shop_eg/'));
    const sources = sem.map(l => [l.body.entryReferences[0].name.split('/entries/')[1],
                                  l.body.entryReferences[0].path]);
    expect(sources).toEqual(expect.arrayContaining([
      ['shop.metrics.revenue', undefined],
      ['shop.entities.Order', undefined],
      ['shop.entities.Order', 'Schema.total'],
      ['shop.entities.Customer', 'Schema.displayName'],
    ]));
    expect(sem[0].path).toBe('projects/222/locations/us/entryGroups/shop_eg/entryLinks');
  });

  test('a computed field or unknown location gets no BigQuery leg, with a note', () => {
    const m = loaded();
    m.glossary!.terms.push({id: 'net', defines: [{kind: 'field', ref: 'Order.net'}]});
    const p = planGlossary(m, {...TARGET, datasetLocations: new Map()});
    expect(p.requests.some(r => r.kind === 'link' && r.path.includes('@bigquery')))
        .toBe(false);
    expect(p.notes.some(n => /'Order.net'.*computed or unbound/.test(n))).toBe(true);
    expect(p.notes.some(n => /location of dataset data-proj.sales is unknown/.test(n)))
        .toBe(true);
  });

  test('without a semantic target only BigQuery legs are planned', () => {
    const {semantic, ...bare} = TARGET;
    const p = planGlossary(loaded(), bare);
    expect(p.requests.some(r => r.path.includes('shop_eg'))).toBe(false);
  });

  test('link ids are valid Dataplex ids and deterministic', () => {
    for (const l of links) {
      expect(l.id).toMatch(/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/);
    }
    expect(linkId('def', 'x'.repeat(80), 'k')).toHaveLength(63);
    expect(planGlossary(loaded(), TARGET).requests.map((r: GlossaryRequest) => r.id))
        .toEqual(plan.requests.map(r => r.id));
  });
});

describe('pull reverse', () => {
  test('Dataplex resources rebuild the spec block', () => {
    const plan = planGlossary(
        loaded(), {project: 'p', projectNumber: '1', location: 'global'});
    const res = (kind: string) => plan.requests.filter(r => r.kind === kind)
                                      .map(r => ({name: r.name, ...r.body}));
    const g = glossaryFromDataplex(res('glossary')[0], res('category'), res('term'));
    const original = loaded().glossary!;
    expect(g.id).toBe('shop-glossary');
    // A display name equal to the id's default ("finance" -> "Finance") is
    // not restored: it is what the publisher would write anyway.
    const dropDefault = <T extends {id: string; displayName?: string}>(x: T) => {
      const {displayName, ...rest} = x;
      const humanized = x.id.split('-').map(w => w[0].toUpperCase() + w.slice(1))
                            .join(' ');
      return displayName === humanized ? rest : x;
    };
    expect(g.categories).toEqual(original.categories.map(dropDefault));
    const byId = new Map(g.terms.map(t => [t.id, t]));
    for (const t of original.terms) expect(byId.get(t.id)).toEqual(dropDefault(t));
  });
});

describe('OSI round-trip', () => {
  test('the glossary block survives serialize -> load', () => {
    const {yaml} = serializeModel(loaded());
    expect(yaml).toContain('glossary:');
    expect(yaml).toContain('display_name: Revenue');
    const {models} = loadModels(yaml);
    expect(models[0].glossary).toEqual(loaded().glossary);
    expect(glossaryDoc(loaded().glossary!).terms[0].defines)
        .toEqual([{metric: 'revenue'}, {entity: 'Order'}]);
  });
});

describe('OWL import (SKOS)', () => {
  const TTL = `
    @prefix owl:  <http://www.w3.org/2002/07/owl#> .
    @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
    @prefix xsd:  <http://www.w3.org/2001/XMLSchema#> .
    @prefix skos: <http://www.w3.org/2004/02/skos/core#> .
    @prefix dcterms: <http://purl.org/dc/terms/> .
    @prefix ex:   <http://example.com/shop#> .

    ex:Order a owl:Class ; rdfs:label "Order" .
    ex:total a owl:DatatypeProperty ; rdfs:domain ex:Order ; rdfs:range xsd:decimal .

    ex:vocab a skos:ConceptScheme ; skos:prefLabel "Shop vocabulary"@en .
    ex:GrossSales a skos:Concept ;
      skos:inScheme ex:vocab ;
      skos:prefLabel "Gross Sales"@en ;
      skos:altLabel "gross revenue"@en , "Bruttoumsatz"@de ;
      skos:definition "Order value before returns."@en ;
      skos:related ex:NetSales ;
      dcterms:subject ex:total .
    ex:NetSales a skos:Concept ;
      skos:inScheme ex:vocab ;
      skos:prefLabel "Net Sales" ;
      rdfs:seeAlso ex:Order .
  `;

  test('concepts become terms with labels, synonyms, related and defines', () => {
    const {yaml} = convertOwlToOsi(TTL, 'shop');
    const {models, warnings} = loadModels(yaml, {bindingOptional: true});
    const g = models[0].glossary!;
    expect(g.displayName).toBe('Shop vocabulary');
    expect(g.categories).toEqual([]);
    const gross = g.terms.find(t => t.id === 'gross-sales')!;
    expect(gross).toEqual({
      id: 'gross-sales',
      displayName: 'Gross Sales',
      definition: 'Order value before returns.',
      synonyms: ['gross revenue'],
      related: ['net-sales'],
      defines: [{kind: 'field', ref: 'Order.total'}],
    });
    const net = g.terms.find(t => t.id === 'net-sales')!;
    expect(net.related).toEqual(['gross-sales']);
    expect(net.defines).toEqual([{kind: 'entity', ref: 'Order'}]);
    expect(warnings.filter(w => /glossary/.test(w))).toEqual(
        [expect.stringContaining("'net-sales': has no definition")]);
  });

  test('several schemes become categories', () => {
    const ttl = TTL.replace('ex:NetSales a skos:Concept ;\n      skos:inScheme ex:vocab',
                            'ex:NetSales a skos:Concept ;\n      skos:inScheme ex:other');
    const {yaml} = convertOwlToOsi(ttl, 'shop');
    const g = loadModels(yaml, {bindingOptional: true}).models[0].glossary!;
    expect(g.categories.map(c => c.id).sort()).toEqual(['other', 'vocab']);
    expect(g.terms.find(t => t.id === 'net-sales')!.category).toBe('other');
  });

  test('an ontology without SKOS concepts gets no glossary', () => {
    const {yaml} = convertOwlToOsi(TTL.split('ex:vocab')[0], 'shop');
    expect(yaml).not.toContain('glossary:');
  });
});
