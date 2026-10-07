// Phase K (Knowledge Catalog closure) behavior:
//
//   K1  lossless push / pull. With kcmd's annotation aspects provisioned
//       (semantic-ai-context, semantic-expressions, semantic-binding) a model
//       survives emit -> read unchanged: whole ai_context (model, entity,
//       field, metric, relationship), expressions / imported SQL / logical
//       types / dimension roles, binding mode, hydration, full vocabulary
//       members, verbatim relationship names in authored order, and
//       many-to-many relationships (a junction entry plus two links). Pinned
//       per construct on the pure codec, then end to end through
//       deployKnowledgeCatalog -> pullKnowledgeCatalog over an in-memory
//       catalog.
//   K3  binding links: each bound entity links to the @bigquery entry it is
//       read through (node view, or table under mode: direct) and to its
//       graph node entry; stale ones are reconciled.
//   K5  a glossary definition link refused on a kcmd semantic entry falls
//       back to the bound node view's column.

import {afterEach, describe, expect, mock, spyOn, test} from 'bun:test';

import {BigQueryClient} from '../../../src/libts/gcp/bigquery';
import {ApiContext} from '../../../src/libts/gcp/context';
import {ResourceManagerClient} from '../../../src/libts/gcp/crm';
import {CatalogClient, Entry, EntryLink} from '../../../src/libts/gcp/dataplex';
import {deployKnowledgeCatalog} from '../../../src/libts/semantic/deploy_knowledge_catalog';
import {LINK_TYPES, planGlossary} from '../../../src/libts/semantic/glossary';
import {publishGlossary} from '../../../src/libts/semantic/glossary_publish';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {AI_CONTEXT_TYPE_ID, ANNOTATION_ASPECT_IDS, BINDING_TYPE_ID, EXPRESSIONS_TYPE_ID} from '../../../src/libts/semantic/kc_custom_types';
import {generateCatalogResources, physicalBindings} from '../../../src/libts/semantic/knowledge_catalog';
import {pullKnowledgeCatalog} from '../../../src/libts/semantic/pull_kc';

const CTX = new ApiContext('test-project', 'us', 'test-token');
const OPTS = {project: 'dest', location: 'us', entryGroup: 'eg'};
const ALL = [...ANNOTATION_ASPECT_IDS];
const GRAPH =
    '//bigquery.googleapis.com/projects/data-proj/datasets/sem/propertyGraphs/shop_graph';

afterEach(() => {
  mock.restore();
});

// A representative model using every construct K1 must carry.
function shop(): SemanticModel {
  return {
    name: 'shop',
    description: 'The shop model.',
    aiContext: {
      instructions: 'Use for shop analytics.',
      synonyms: ['store', 'retail'],
      examples: ['Revenue by segment last quarter?'],
    },
    customExtensions: [{
      vendorName: 'GOOGLE',
      data: JSON.stringify({deploymentTargets: [GRAPH]}),
    }],
    entities: [
      {
        name: 'Customer',
        dataSource: 'src.sales.customers',
        keys: ['customerId'],
        description: 'A buyer.',
        aiContext: {
          instructions: 'One row per customer.',
          synonyms: ['client', 'account'],
          examples: ['How many customers?'],
        },
        fields: [
          {
            name: 'customerId',
            expression: 'customer_id',
            type: 'String',
            aiContext: {synonyms: ['customer number']},
          },
          {name: 'email', expression: 'email', type: 'String'},
          {name: 'segment', expression: 'segment'},  // untyped
          {
            name: 'signupDate',
            expression: 'signup_date',
            type: 'Date',
            dimension: {isTime: true},
          },
          {
            name: 'region',
            importedExpression: 'REGION_CODE',
            importedDialect: 'SNOWFLAKE',
            dimension: {},
          },
        ],
      },
      {
        name: 'Order',
        dataSource: 'src.sales.orders',
        keys: ['orderId'],
        mode: 'view',  // explicit: only the binding aspect can carry it
        hydration: {
          grain: {latestBy: 'updated_at'},
          normalize: [{
            field: 'amount',
            before: '2024-03-25',
            divideBy: 100,
            on: 'updated_at',
          }],
          resolve: [{field: 'customerId', match: ['customerId', 'email']}],
        },
        fields: [
          {name: 'orderId', expression: 'order_id', type: 'String'},
          {name: 'customerId', expression: 'customer_ref', type: 'String'},
          {
            name: 'amount',
            expression: 'amount',
            type: 'Decimal',
            unit: 'USD',
            aiContext: {instructions: 'Gross, tax included.'},
          },
        ],
      },
      {
        name: 'Product',
        dataSource: 'src.sales.products',
        keys: ['productId'],
        mode: 'direct',
        fields: [{name: 'productId', expression: 'product_id', type: 'String'}],
      },
      {
        name: 'OrderStatus',
        dataSource: '',
        keys: ['code'],
        members: [
          {
            code: 'OPEN',
            label: 'Open',
            order: 1,
            synonyms: ['pending'],
            definition: 'Not shipped yet.',
            iri: 'http://example.org/shop#Open',
          },
          {code: 'SHIPPED', label: 'Shipped', order: 2},
        ],
        fields: [{name: 'code', expression: 'code', type: 'String'}],
      },
    ],
    relationships: [
      {
        name: 'placedBy',
        source: {entity: 'Order', columns: ['customer_ref']},
        destination: {entity: 'Customer', columns: ['customer_id']},
        description: 'Each order has one buyer.',
        aiContext: {instructions: 'The buyer.', synonyms: ['buyer']},
      },
      {
        name: 'containsProduct',
        source: {entity: 'Order', columns: ['order_id']},
        destination: {entity: 'Product', columns: ['product_id']},
        association: {
          dataSource: 'src.sales.order_lines',
          keys: ['line_id'],
          sourceColumns: ['order_id'],
          destinationColumns: ['product_id'],
          fields: [{
            name: 'quantity',
            expression: 'qty',
            type: 'Integer',
            aiContext: {synonyms: ['qty']},
          }],
        },
      },
    ],
    metrics: [
      {
        name: 'revenue',
        expression: 'SUM(Order.amount)',
        entity: 'Order',
        type: 'Decimal',
        description: 'Gross revenue.',
        aiContext: {synonyms: ['sales'], examples: ['Revenue by month?']},
      },
      // Untyped, and an authored String: the semantic-metric aspect cannot
      // tell these apart, the expressions aspect can.
      {
        name: 'orderCount',
        expression: 'COUNT(DISTINCT Order.orderId)',
        entity: 'Order',
      },
      {
        name: 'topSegment',
        expression: 'ANY_VALUE(Customer.segment)',
        entity: 'Customer',
        type: 'String',
        importedExpression: 'ANY_VALUE(SEGMENT)',
        importedDialect: 'SNOWFLAKE',
      },
    ],
  };
}

function roundTrip(model: SemanticModel, customAspects: string[] = ALL) {
  const {entries, entryLinks} =
      generateCatalogResources(model, {...OPTS, customAspects});
  return modelsFromCatalogResources(entries, entryLinks);
}


describe('K1: per-construct round trip with the annotation aspects', () => {
  const back = roundTrip(shop()).models[0];
  const src = shop();
  const entity = (m: SemanticModel, n: string) =>
      m.entities.find(e => e.name === n)!;
  const metric = (m: SemanticModel, n: string) =>
      m.metrics.find(x => x.name === n)!;

  test('model ai_context: synonyms and examples', () => {
    expect(back.aiContext).toEqual(src.aiContext);
  });

  test('entity ai_context: synonyms and examples', () => {
    expect(entity(back, 'Customer').aiContext)
        .toEqual(entity(src, 'Customer').aiContext);
  });

  test('field ai_context', () => {
    expect(entity(back, 'Customer').fields[0].aiContext)
        .toEqual({synonyms: ['customer number']});
    expect(entity(back, 'Order').fields[2].aiContext)
        .toEqual({instructions: 'Gross, tax included.'});
  });

  test('field expressions, imported SQL, String vs untyped, dimensions', () => {
    expect(entity(back, 'Customer').fields)
        .toEqual(entity(src, 'Customer').fields);
  });

  test('metric expression, types (untyped / String) and imported SQL', () => {
    for (const n of ['revenue', 'orderCount', 'topSegment']) {
      expect(metric(back, n)).toEqual(metric(src, n));
    }
  });

  test('binding mode (view and direct) and hydration rules', () => {
    expect(entity(back, 'Order').mode).toBe('view');
    expect(entity(back, 'Order').hydration)
        .toEqual(entity(src, 'Order').hydration);
    expect(entity(back, 'Product').mode).toBe('direct');
    expect(entity(back, 'Customer').mode).toBeUndefined();
  });

  test('full vocabulary members (synonyms, definition, iri)', () => {
    expect(entity(back, 'OrderStatus').members)
        .toEqual(entity(src, 'OrderStatus').members);
  });

  test('many-to-many relationship with its edge fields', () => {
    const rel = back.relationships.find(r => r.name === 'containsProduct');
    expect(rel).toEqual(src.relationships[1]);
    // The junction is not an entity of the model.
    expect(back.entities.map(e => e.name))
        .toEqual(['Customer', 'Order', 'Product', 'OrderStatus']);
  });

  test('relationship names verbatim, in authored order, with ai_context', () => {
    expect(back.relationships.map(r => r.name))
        .toEqual(['placedBy', 'containsProduct']);
    expect(back.relationships[0]).toEqual(src.relationships[0]);
  });

  test('the whole model comes back equal', () => {
    expect(back).toEqual(src);
  });

  test('each aspect is attached only when provisioned', () => {
    const {entries} = generateCatalogResources(
        shop(), {...OPTS, customAspects: [AI_CONTEXT_TYPE_ID]});
    const keys = new Set(entries.flatMap(e => Object.keys(e.aspects ?? {})));
    expect(keys.has(`dest.global.${AI_CONTEXT_TYPE_ID}`)).toBe(true);
    expect(keys.has(`dest.global.${EXPRESSIONS_TYPE_ID}`)).toBe(false);
    expect(keys.has(`dest.global.${BINDING_TYPE_ID}`)).toBe(false);
  });
});


describe('K1: without the annotation aspects nothing new is attached', () => {
  test('no custom aspect, no binding links', () => {
    const res = generateCatalogResources(shop(), OPTS);
    const keys = res.entries.flatMap(e => Object.keys(e.aspects ?? {}));
    expect(keys.some(k => k.startsWith('dest.global.'))).toBe(false);
    expect(res.bindingLinks).toBeUndefined();
  });

  test('the old lossy read still applies (synonyms dropped)', () => {
    const back = roundTrip(shop(), []).models[0];
    expect(back.aiContext).toEqual({instructions: 'Use for shop analytics.'});
    expect(back.relationships.map(r => r.name))
        .toEqual(['placedby', 'containsproduct']);
  });
});


describe('K1: relationships that publish no link ride the index whole', () => {
  // An abstract parent, a child extending it, and a column-less edge with a
  // description and an inverse: none of the latter two kinds of row carries
  // a link, so the anchor's index is their only record.
  const withUnpublished = (): SemanticModel => {
    const m = shop();
    m.relationships.push(
        {
          name: 'relatesTo',
          source: {entity: 'Order', columns: []},
          destination: {entity: 'Customer', columns: []},
          abstract: true,
          description: 'Any link from an order to a customer.',
        },
        {
          name: 'reviewedBy',
          source: {entity: 'Order', columns: []},
          destination: {entity: 'Customer', columns: []},
          extends: ['relatesTo'],
          description: 'The customer who reviewed the order.',
          inverse: 'reviewed',
          aiContext: {synonyms: ['reviewer']},
        });
    m.relationships[0].extends = ['relatesTo'];
    return m;
  };

  test('they come back, in authored order, with the extends that name them',
       () => {
         const read = roundTrip(withUnpublished());
         expect(read.warnings).toEqual([]);
         expect(read.models[0].relationships)
             .toEqual(withUnpublished().relationships);
       });

  test('without semantic-ai-context they are lost, as before', () => {
    const back = roundTrip(withUnpublished(), []).models[0];
    expect(back.relationships.map(r => r.name))
        .toEqual(['placedby', 'containsproduct']);
  });
});


// ---------------------------------------------------------------------------
// In-memory catalog: just enough of CatalogClient for push and pull.
// ---------------------------------------------------------------------------

function aspectKey(aspectType: string): string {
  const m =
      aspectType.match(/^projects\/([^/]+)\/locations\/([^/]+)\/aspectTypes\/(.+)$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : aspectType;
}

function fakeCatalog() {
  const entries = new Map<string, Entry>();
  const links = new Map<string, EntryLink>();
  const ok = (result?: any) => ({status: 200, result});
  const P = CatalogClient.prototype as any;
  spyOn(P, 'listEntries').mockImplementation(async function*() {
    for (const e of [...entries.values()]) {
      yield {name: e.name, entryType: e.entryType, parentEntry: e.parentEntry};
    }
  });
  spyOn(P, 'createEntry')
      .mockImplementation(async (...a: any[]) => {
        const entry: Entry = a[4];
        if (entries.has(entry.name)) {
          return {status: 409, message: 'entry already exists'};
        }
        entries.set(entry.name, structuredClone(entry));
        return ok(entry);
      });
  spyOn(P, 'updateEntry').mockImplementation(async (entry: Entry) => {
    entries.set(entry.name, structuredClone(entry));
    return ok(entry);
  });
  spyOn(P, 'deleteEntry').mockImplementation(async (...a: any[]) => {
    for (const name of entries.keys()) {
      if (name.endsWith(`/entries/${a[3]}`)) entries.delete(name);
    }
    return ok({});
  });
  spyOn(P, 'lookupEntry')
      .mockImplementation(async (...a: any[]) => {
        const e = entries.get(a[2]);
        if (!e) return {status: 404, message: 'not found'};
        // A CUSTOM view returns only the requested aspect types, so a pull that
        // forgets to ask for an annotation aspect loses it here too.
        const want = new Set((a[3] ?? []).map(aspectKey));
        const out = structuredClone(e);
        out.aspects = Object.fromEntries(
            Object.entries(e.aspects ?? {}).filter(([k]) => want.has(k)));
        return ok(out);
      });
  spyOn(P, 'createEntryLink').mockImplementation(async (...a: any[]) => {
    const link: EntryLink = a[4];
    if (links.has(link.name!)) return {status: 409, message: 'already exists'};
    links.set(link.name!, structuredClone(link));
    return ok(link);
  });
  spyOn(P, 'updateEntryLink').mockImplementation(async (link: EntryLink) => {
    const cur = links.get(link.name!)!;
    links.set(link.name!, {...cur, aspects: structuredClone(link.aspects)});
    return ok(link);
  });
  spyOn(P, 'deleteEntryLink').mockImplementation(async (...a: any[]) => {
    for (const name of links.keys()) {
      if (name.endsWith(`/entryLinks/${a[3]}`)) links.delete(name);
    }
    return ok({});
  });
  spyOn(P, 'lookupEntryLinks').mockImplementation(async (...a: any[]) => {
    const o = a[2];
    return ok([...links.values()].filter(
        l => l.entryReferences.some(r => r.name === o.entry) &&
            (!o.entryLinkTypes || o.entryLinkTypes.includes(l.entryLinkType))));
  });
  return {entries, links};
}

const loaded = (model: SemanticModel) =>
    [{document: 'shop.yaml', model}] as any;


describe('K1: push -> pull over a catalog', () => {
  test('the pulled IR equals the pushed one (empty diff)', async () => {
    fakeCatalog();
    const push = await deployKnowledgeCatalog(
        loaded(shop()), CTX, {...OPTS, entryCreateTries: 1, customAspects: ALL});
    expect(push.details).toBeUndefined();
    expect(push.success).toBe(true);

    const pull = await pullKnowledgeCatalog(
        new CatalogClient(CTX), {...OPTS, customAspects: ALL});
    expect(pull.models).toHaveLength(1);
    expect(pull.models[0]).toEqual(shop());
  });

  test('a re-push is idempotent and still pulls back equal', async () => {
    const {entries} = fakeCatalog();
    const o = {...OPTS, entryCreateTries: 1, customAspects: ALL};
    await deployKnowledgeCatalog(loaded(shop()), CTX, o);
    const count = entries.size;
    const again = await deployKnowledgeCatalog(loaded(shop()), CTX, o);
    expect(again.success).toBe(true);
    expect(again.created).toBe(0);
    expect(entries.size).toBe(count);
    const pull = await pullKnowledgeCatalog(
        new CatalogClient(CTX), {...OPTS, customAspects: ALL});
    expect(pull.models[0]).toEqual(shop());
  });

  test('a pull that does not ask for the aspects reads the lossy form',
       async () => {
         fakeCatalog();
         await deployKnowledgeCatalog(
             loaded(shop()), CTX,
             {...OPTS, entryCreateTries: 1, customAspects: ALL});
         const pull = await pullKnowledgeCatalog(new CatalogClient(CTX), OPTS);
         expect(pull.models[0].aiContext)
             .toEqual({instructions: 'Use for shop analytics.'});
       });
});


// ---------------------------------------------------------------------------
// K3: binding links.
// ---------------------------------------------------------------------------

const LOCATOR = {
  datasetLocations: new Map([['data-proj.sem', 'US'], ['src.sales', 'US']]),
  projectNumbers: new Map([['data-proj', '42'], ['src', '43']]),
};

describe('K3: binding links', () => {
  const res = generateCatalogResources(
      shop(), {...OPTS, customAspects: ALL, bigQueryEntries: LOCATOR});
  const byId = new Map(
      (res.bindingLinks ?? []).map(l => [l.name!.split('/').pop()!, l]));
  const BQ = 'entryGroups/@bigquery/entries/bigquery.googleapis.com/projects';

  test('physical bindings: node view by default, none under mode: direct', () => {
    const phys = physicalBindings(shop());
    expect(phys.get('Customer')).toEqual({
      nodeView: 'data-proj.sem.customer',
      graph: 'data-proj.sem.shop_graph',
      graphNode: 'Customer',
    });
    expect(phys.get('Product')?.nodeView).toBeUndefined();
    expect(phys.get('Product')?.graphNode).toBe('Product');
  });

  test('an entity links to its node view entry and its graph node entry', () => {
    const view = byId.get('shop-bind-view-customer')!;
    expect(view).toBeDefined();
    expect(view.entryReferences[0].name)
        .toBe('projects/dest/locations/us/entryGroups/eg/entries/shop.entities.Customer');
    expect(view.entryReferences[1].name).toBe(
        `projects/42/locations/us/${BQ}/data-proj/datasets/sem/tables/customer`);
    const join =
        view.aspects!['dataplex-types.global.schema-join'].data!.joins[0];
    expect(join.target).toEqual(
        {name: 'data-proj.sem.customer', fields: ['customer_id']});
    expect(join.type).toBe('JOIN');

    const node = byId.get('shop-bind-node-customer')!;
    expect(node.entryReferences[1].name).toBe(
        `projects/42/locations/us/${BQ}/data-proj/datasets/sem/` +
        `propertyGraphs/shop_graph/nodes/Customer`);
  });

  test('mode: direct links the source table itself', () => {
    const view = byId.get('shop-bind-view-product')!;
    expect(view.entryReferences[1].name).toBe(
        `projects/43/locations/us/${BQ}/src/datasets/sales/tables/products`);
  });

  test('an unknown dataset location skips the link with a warning', () => {
    const r = generateCatalogResources(shop(), {
      ...OPTS,
      bigQueryEntries: {datasetLocations: new Map([['src.sales', 'US']])},
    });
    expect((r.bindingLinks ?? []).some(l => l.name!.includes('-node-')))
        .toBe(false);
    expect(r.warnings.some(w => /location of .* is unknown/.test(w)))
        .toBe(true);
  });

  test('push writes them non-fatally and reconciles stale ones', async () => {
    const {links} = fakeCatalog();
    const o = {
      ...OPTS, entryCreateTries: 1, customAspects: ALL,
      bigQueryEntries: LOCATOR,
    };
    const first = await deployKnowledgeCatalog(loaded(shop()), CTX, o);
    expect(first.success).toBe(true);
    expect(first.bound).toBe(res.bindingLinks!.length);
    const ids = () => [...links.keys()].map(n => n.split('/').pop()!);
    expect(ids()).toContain('shop-bind-view-product');

    // Drop Product (and the relationship through it): its binding links go.
    const m = shop();
    m.entities = m.entities.filter(e => e.name !== 'Product');
    m.relationships = m.relationships.filter(r => !r.association);
    const second = await deployKnowledgeCatalog(loaded(m), CTX, o);
    expect(second.success).toBe(true);
    expect(ids()).not.toContain('shop-bind-view-product');
    expect(ids()).not.toContain('shop-bind-node-product');
    expect(ids()).toContain('shop-bind-view-customer');
  });

  test('without a locator, push reports no binding count', async () => {
    fakeCatalog();
    const r = await deployKnowledgeCatalog(
        loaded(shop()), CTX, {...OPTS, entryCreateTries: 1});
    expect(r.bound).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// K5: glossary definition links fall back to the node view column.
// ---------------------------------------------------------------------------

function glossaryModel(): SemanticModel {
  return {
    name: 'shop',
    customExtensions: [{
      vendorName: 'GOOGLE',
      data: JSON.stringify({deploymentTargets: [GRAPH]}),
    }],
    entities: [
      {
        name: 'Order',
        dataSource: 'data-proj.sales.orders',
        keys: ['orderId'],
        fields: [
          {name: 'orderId', expression: 'order_id', type: 'String'},
          {name: 'totalAmount', expression: 'total', type: 'Decimal'},
        ],
      },
      {
        name: 'Product',
        dataSource: 'data-proj.sales.products',
        keys: ['productId'],
        mode: 'direct',
        fields: [{name: 'productId', expression: 'product_id', type: 'String'}],
      },
    ],
    relationships: [],
    metrics: [{
      name: 'revenue',
      expression: 'SUM(Order.totalAmount)',
      entity: 'Order',
      type: 'Decimal',
    }],
    glossary: {
      categories: [],
      terms: [
        {
          id: 'order-total',
          definition: 'Gross amount of one order.',
          defines: [{kind: 'field', ref: 'Order.totalAmount'}],
        },
        {
          id: 'revenue',
          definition: 'Total value of orders.',
          defines: [{kind: 'metric', ref: 'revenue'}],
        },
        {
          id: 'product',
          definition: 'Something sold.',
          defines: [{kind: 'entity', ref: 'Product'}],
        },
      ],
    },
  };
}

describe('K5: glossary node-view fallback', () => {
  const TARGET = {
    project: 'gloss-proj',
    projectNumber: '111',
    location: 'global',
    semantic: {project: 'kc-proj', projectNumber: '222', location: 'us',
               entryGroup: 'shop_eg'},
    datasetLocations:
        new Map([['data-proj.sales', 'US'], ['data-proj.sem', 'US']]),
    projectNumbers: new Map([['data-proj', '333']]),
  };
  const plan = planGlossary(glossaryModel(), TARGET);
  const semLeg = (term: string) => plan.requests.find(
      r => r.kind === 'link' && r.path.includes('/entryGroups/shop_eg/') &&
          r.body.entryReferences[1].name.endsWith(`/terms/${term}`))!;
  const VIEW = 'projects/333/locations/us/entryGroups/@bigquery/entries/' +
      'bigquery.googleapis.com/projects/data-proj/datasets/sem/tables/order';

  test('a field leg falls back to the node view column (snake_case)', () => {
    const fb = semLeg('order-total').fallback!;
    expect(fb).toBeDefined();
    expect(fb.path)
        .toBe('projects/333/locations/us/entryGroups/@bigquery/entryLinks');
    expect(fb.body.entryLinkType).toBe(LINK_TYPES.definition);
    expect(fb.body.entryReferences[0])
        .toEqual({name: VIEW, path: 'Schema.total_amount', type: 'SOURCE'});
    expect(fb.body.entryReferences[1])
        .toEqual(semLeg('order-total').body.entryReferences[1]);
    expect(fb.id).toMatch(/^[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/);
  });

  test('a metric leg falls back to its entity\'s node view', () => {
    const fb = semLeg('revenue').fallback!;
    expect(fb.body.entryReferences[0]).toEqual({name: VIEW, type: 'SOURCE'});
  });

  test('a mode: direct entity has no node view, so no fallback', () => {
    expect(semLeg('product').fallback).toBeUndefined();
  });

  test('publish sends the fallback when the semantic entry refuses', async () => {
    spyOn(ResourceManagerClient.prototype, 'getProject')
        .mockImplementation(async () => ({status: 200,
                                          result: {name: 'projects/333'}}) as any);
    spyOn(BigQueryClient.prototype, 'getDataset')
        .mockImplementation(async () => ({status: 200,
                                          result: {location: 'US'}}) as any);
    const posted: string[] = [];
    spyOn(CatalogClient.prototype as any, '_post')
        .mockImplementation(async (...a: any[]) => {
          const p: string = a[0];
          posted.push(p);
          if (p.includes('/entryGroups/shop_eg/')) {
            return {status: 400, message: 'definition links not allowed'};
          }
          return {status: 200, result: {}};
        });
    const result = await publishGlossary(glossaryModel(), CTX, {
      project: 'gloss-proj',
      semantic: {project: 'kc-proj', location: 'us', entryGroup: 'shop_eg'},
      log: () => {},
    });
    expect(result.errors).toEqual([]);
    expect(result.skipped.filter(s => /node view fallback\) instead$/.test(s)))
        .toHaveLength(2);
    expect(result.skipped.some(
               s => /Product -> product: refused on the semantic entry/.test(s) &&
                   !/instead/.test(s)))
        .toBe(true);
    // The fallback went to @bigquery, in the node view's dataset location.
    expect(posted.filter(
               p => p ===
                   'projects/333/locations/us/entryGroups/@bigquery/entryLinks')
               .length)
        .toBeGreaterThanOrEqual(2);
  });
});
