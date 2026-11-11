// Phase K (Knowledge Catalog V2 closure) behavior:
//
//   K1  lossless V2 push / pull. Built-in V2 Dataplex types (`semantic-model`,
//       `semantic-entity`, `semantic-metric`, `semantic-relationship`,
//       `schema`, `sql-expressions`, `guidelines`, `overview`,
//       `semantic-extensions` with synthesized `GOOGLE` blocks) plus parseable
//       description trailers round-trip every Google-profile IR construct
//       unchanged without any custom annotation aspect provisioning:
//         - whole `ai_context` (instructions, synonyms, examples, custom)
//         - field & metric dialect / string-form SQL expressions & dimensions
//         - `abstract` entities & `abstract` relationships + `extends`
//         - `defined` entities (`definition.expression` + `description`)
//         - `vocabulary` (`members` with code, label, order, synonyms,
//           definition, iri)
//         - `via` & `filter` derived relationships
//         - `inverse` on relationships
//         - self-referential relationships (`from === to`, e.g. `parentAccount`)
//         - many-to-many `association` relationships with edge fields
//         - `unit` / `scale` on fields and `grain` / `history` on entities
//         - model `glossary`
//         - inline and profile `hydration` / `mode` (`ProfileSpec`)
//         - grounding trailers (`Contents:`, `Read through:`, `Relationships:`,
//           `Query:`) written on push and stripped cleanly on pull so
//           `serializeModelFiles` produces zero spurious diffs.
//   K3  `@bigquery` binding links: each bound entity links to the `@bigquery`
//       entry it is read through (node view, or table under `mode: direct`)
//       and to its graph node entry; stale ones are reconciled.
//   K5  a glossary definition link refused on a kcmd semantic entry falls
//       back to the bound node view's column.

import {afterEach, beforeAll, describe, expect, mock, spyOn, test} from 'bun:test';

import {BigQueryClient} from '../../../src/libts/gcp/bigquery';
import {ApiContext} from '../../../src/libts/gcp/context';
import {ResourceManagerClient} from '../../../src/libts/gcp/crm';
import {CatalogClient, Entry, EntryLink} from '../../../src/libts/gcp/dataplex';
import {deployKnowledgeCatalog} from '../../../src/libts/semantic/deploy_knowledge_catalog';
import {LINK_TYPES, planGlossary} from '../../../src/libts/semantic/glossary';
import {publishGlossary} from '../../../src/libts/semantic/glossary_publish';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {modelsFromCatalogResources} from '../../../src/libts/semantic/kc_converter';
import {generateCatalogResources, physicalBindings} from '../../../src/libts/semantic/knowledge_catalog';
import {loadModels} from '../../../src/libts/semantic/loader';
import {serializeModelFiles} from '../../../src/libts/semantic/osi_converter';
import {pullKnowledgeCatalog} from '../../../src/libts/semantic/pull_kc';
import {loadProfileFile} from '../../../src/libts/semantic/resolve_profiles';
import {loadSqlEngine} from '../../../src/libts/semantic/sql_parser';

beforeAll(() => loadSqlEngine());

const CTX = new ApiContext('test-project', 'us', 'test-token');
const OPTS = {project: 'dest', location: 'us', entryGroup: 'eg'};
const GRAPH =
    'bigquery.googleapis.com/projects/data-proj/datasets/sem/propertyGraphs/shop_graph';
const TABLE = (p: string, d: string, t: string) =>
    `bigquery.googleapis.com/projects/${p}/datasets/${d}/tables/${t}`;

afterEach(() => {
  mock.restore();
});

const SHOP_YAML = `version: "0.2.0.dev0/google"
semantic_model:
  - name: shop
    description: The shop model.
    ai_context:
      instructions: Use for shop analytics.
      synonyms: [store, retail]
      examples: [Revenue by segment last quarter?]
    deployments:
      - {name: default, target: ${GRAPH}}
      - {name: staging, target: ${GRAPH}_staging, profile: staging}
    glossary:
      description: Commercial vocabulary.
      categories:
        - {id: finance, display_name: Finance}
      terms:
        - id: gross-revenue
          display_name: Gross Revenue
          definition: Total value of orders.
          category: finance
          synonyms: [turnover]
          defines: [{metric: revenue}, {entity: Order}]
    entities:
      - name: Customer
        extends: [Party]
        source: ${TABLE('src', 'sales', 'customers')}
        primary_key: [customerId]
        description: A buyer.
        grain: one row per customer version
        history:
          versioned: true
          current_flag: isCurrent
          valid_from: signupDate
        ai_context:
          instructions: One row per customer.
          synonyms: [client, account]
          examples: [How many customers?]
        fields:
          - name: customerId
            expression: customer_id
            datatype: String
            ai_context: {synonyms: [customer number]}
          - {name: parentCustomerId, expression: parent_customer_id, datatype: String}
          - {name: email, expression: email, datatype: String}
          - {name: segment, expression: segment}
          - {name: isCurrent, expression: is_current, datatype: Boolean}
          - name: signupDate
            expression: signup_date
            datatype: Date
            dimension: {is_time: true}
          - name: region
            dimension: {}
            expression:
              dialects:
                - {dialect: SNOWFLAKE, expression: REGION_CODE}
      - name: Order
        source: ${TABLE('src', 'sales', 'orders')}
        primary_key: [orderId]
        mode: view
        hydration:
          grain: {latest_by: updated_at}
          normalize:
            - {field: amount, before: "2024-03-25", divide_by: 100, on: updated_at}
          resolve:
            - {field: customerId, match: [customerId, email]}
        fields:
          - {name: orderId, expression: order_id, datatype: String}
          - {name: customerId, expression: customer_ref, datatype: String}
          - {name: statusKey, expression: status_key, datatype: String}
          - name: amount
            expression: amount
            datatype: Decimal
            unit: USD
            scale: 100
            ai_context: {instructions: "Gross, tax included."}
      - name: OrderStatus
        primary_key: [code]
        members:
          - code: OPEN
            label: Open
            order: 1
            synonyms: [pending]
            definition: Not shipped yet.
            iri: http://example.org/shop#Open
          - {code: SHIPPED, label: Shipped, order: 2}
        fields:
          - {name: code, datatype: String}
      - name: Party
        abstract: true
        description: Any counterparty.
        fields:
          - {name: displayName, datatype: String}
      - name: Product
        source: ${TABLE('src', 'sales', 'products')}
        primary_key: [productId]
        mode: direct
        fields:
          - {name: productId, expression: product_id, datatype: String}
      - name: VipCustomer
        extends: [Customer]
        defined:
          expression: Customer.segment = 'VIP'
          description: Segment filter for VIPs.
        description: Top-tier buyers.
    relationships:
      - name: customerStatuses
        from: Customer
        to: OrderStatus
        via: [^placedBy, hasStatus]
        filter: Order.amount > 0
        description: Statuses of positive-value orders placed by a customer.
      - name: hasStatus
        from: Order
        to: OrderStatus
        from_columns: [statusKey]
        to_columns: [code]
      - name: parentAccount
        from: Customer
        to: Customer
        from_columns: [parentCustomerId]
        to_columns: [customerId]
        description: Parent account in the customer hierarchy.
      - name: placedBy
        extends: [relatesTo]
        from: Order
        to: Customer
        from_columns: [customer_ref]
        to_columns: [customer_id]
        inverse: orders
        description: Each order has one buyer.
        ai_context: {instructions: The buyer., synonyms: [buyer]}
      - name: relatesTo
        from: Order
        to: Party
        abstract: true
        description: Any link from an order to a party.
    metrics:
      - name: orderCount
        entity: Order
        expression: COUNT(DISTINCT Order.orderId)
      - name: revenue
        entity: Order
        datatype: Decimal
        description: Gross revenue.
        expression: SUM(Order.amount)
        ai_context: {synonyms: [sales], examples: [Revenue by month?]}
      - name: topSegment
        entity: Customer
        datatype: String
        expression:
          dialects:
            - {dialect: BIGQUERY, expression: ANY_VALUE(Customer.segment)}
            - {dialect: SNOWFLAKE, expression: ANY_VALUE(SEGMENT)}
`;

const STAGING_PROFILE_YAML = `name: staging
entities:
  - name: Order
    source: ${TABLE('src', 'sales_stg', 'orders')}
    mode: view
    hydration:
      grain: {deterministic: true}
  - name: Product
    mode: direct
`;

function shop(): SemanticModel {
  const model = loadModels(SHOP_YAML).models[0];
  model.relationships.unshift({
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
  });
  model.profiles = [loadProfileFile(STAGING_PROFILE_YAML, 'staging')];
  return model;
}

function roundTrip(model: SemanticModel, opts = OPTS) {
  const {entries, entryLinks} = generateCatalogResources(model, opts);
  return modelsFromCatalogResources(entries, entryLinks);
}


describe('K1: V2 per-construct round trip', () => {
  const src = shop();
  const res = roundTrip(src);
  const back = res.models[0];
  const entity = (m: SemanticModel, n: string) =>
      m.entities.find(e => e.name === n)!;
  const rel = (m: SemanticModel, n: string) =>
      m.relationships.find(r => r.name === n)!;
  const metric = (m: SemanticModel, n: string) =>
      m.metrics.find(x => x.name === n)!;

  test('zero warnings on emit and read, including self-referential parentAccount', () => {
    const emitted = generateCatalogResources(src, OPTS);
    expect(emitted.warnings).toEqual([]);
    expect(res.warnings).toEqual([]);
    // Self-edge emits 1 reference link and 0 self semantic-links.
    const selfRefs = emitted.entryLinks.filter(
        l => l.entryReferences.some(
            r => r.name.endsWith('/relationships/parentAccount')));
    expect(selfRefs).toHaveLength(1);
    expect(emitted.entryLinks.some(
               l => l.entryLinkType.endsWith('/semantic-link') &&
                   l.entryReferences[0].name === l.entryReferences[1].name))
        .toBe(false);
  });

  test('model ai_context and glossary', () => {
    expect(back.aiContext).toEqual(src.aiContext);
    expect(back.glossary).toEqual(src.glossary);
  });

  test('abstract & defined entities, extends, grain, and history', () => {
    expect(entity(back, 'Party')).toEqual(entity(src, 'Party'));
    expect(entity(back, 'VipCustomer')).toEqual(entity(src, 'VipCustomer'));
    expect(entity(back, 'Customer').grain).toBe('one row per customer version');
    expect(entity(back, 'Customer').history).toEqual({
      versioned: true,
      currentFlag: 'isCurrent',
      validFrom: 'signupDate',
    });
  });

  test('field ai_context, unit/scale, dialects, String vs untyped, dimensions', () => {
    expect(entity(back, 'Customer').fields)
        .toEqual(entity(src, 'Customer').fields);
    const amount = entity(back, 'Order').fields.find(f => f.name === 'amount')!;
    expect(amount.unit).toBe('USD');
    expect(amount.scale).toBe(100);
    expect(amount.aiContext).toEqual({instructions: 'Gross, tax included.'});
  });

  test('metric expression, types (untyped / String / Decimal) and dialects', () => {
    for (const n of ['orderCount', 'revenue', 'topSegment']) {
      expect(metric(back, n)).toEqual(metric(src, n));
    }
  });

  test('inline and profile hydration + mode (ProfileSpec)', () => {
    expect(entity(back, 'Order').mode).toBe('view');
    expect(entity(back, 'Order').hydration)
        .toEqual(entity(src, 'Order').hydration);
    expect(entity(back, 'Product').mode).toBe('direct');
    expect(entity(back, 'Customer').mode).toBeUndefined();
    expect(back.profiles).toEqual(src.profiles);
  });

  test('full vocabulary members (order, synonyms, definition, iri)', () => {
    expect(entity(back, 'OrderStatus').members)
        .toEqual(entity(src, 'OrderStatus').members);
  });

  test('derived (via + filter), inverse, abstract, extends, self-edge, and association relationships', () => {
    expect(rel(back, 'customerStatuses'))
        .toEqual(rel(src, 'customerStatuses'));
    expect(rel(back, 'placedBy')).toEqual(rel(src, 'placedBy'));
    expect(rel(back, 'relatesTo')).toEqual(rel(src, 'relatesTo'));
    expect(rel(back, 'parentAccount')).toEqual(rel(src, 'parentAccount'));
    expect(rel(back, 'containsProduct')).toEqual(rel(src, 'containsProduct'));
  });

  test('the whole model and its serialized files come back identical', () => {
    expect(back).toEqual(src);
    expect(serializeModelFiles(back)).toEqual(serializeModelFiles(src));
  });

  test('only built-in dataplex-types aspects are attached (no custom annotation aspects)', () => {
    const res = generateCatalogResources(src, OPTS);
    const keys = res.entries.flatMap(e => Object.keys(e.aspects ?? {}));
    expect(keys.some(k => k.startsWith('dest.global.'))).toBe(false);
    expect(res.bindingLinks).toBeUndefined();
  });
});


// ---------------------------------------------------------------------------
// In-memory V2 catalog: just enough of CatalogClient for push and pull.
// ---------------------------------------------------------------------------

function aspectKey(aspectType: string): string {
  const m = aspectType.match(
      /^projects\/([^/]+)\/locations\/([^/]+)\/aspectTypes\/(.+)$/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : aspectType;
}

function fakeCatalog() {
  const entries = new Map<string, Entry>();
  const links = new Map<string, EntryLink>();
  const ok = (result?: any) => ({status: 200, result});
  const P = CatalogClient.prototype as any;
  spyOn(P, 'getEntryGroup').mockImplementation(async () => ok({}));
  spyOn(ResourceManagerClient.prototype, 'getProject')
      .mockImplementation(async (project: string) =>
          ok({projectId: project, projectNumber: '999'}) as any);
  spyOn(P, 'listEntries').mockImplementation(async function*() {
    for (const e of [...entries.values()]) {
      yield {
        name: e.name,
        entryType: e.entryType,
        parentEntry: e.parentEntry,
        entrySource: e.entrySource,
      };
    }
  });
  spyOn(P, 'getEntry').mockImplementation(async (...a: any[]) => {
    for (const [name, e] of entries) {
      if (name.endsWith(`/entries/${a[3]}`)) return ok(structuredClone(e));
    }
    return {status: 404, message: 'not found'};
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
    const prev = entries.get(entry.name);
    entries.set(entry.name, {
      ...prev,
      ...structuredClone(entry),
      aspects: {...(prev?.aspects ?? {}), ...(structuredClone(entry.aspects) ?? {})},
    });
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
        const raw = a[3];
        const aspectList: string[] =
            Array.isArray(raw) ? raw : (raw?.aspects ?? []);
        const paths: string[]|undefined =
            Array.isArray(raw) ? undefined : raw?.paths;
        const want = new Set(aspectList.map(aspectKey));
        const out = structuredClone(e);
        out.aspects = Object.fromEntries(
            Object.entries(e.aspects ?? {}).filter(([k, asp]) => {
              const [ref, keyPath = ''] = k.split('@');
              return want.has(ref) &&
                  (!paths || paths.includes(asp.path || keyPath));
            }));
        return ok(out);
      });
  spyOn(P, 'createEntryLink').mockImplementation(async (...a: any[]) => {
    const link: EntryLink = a[4];
    if (links.has(link.name!)) return {status: 409, message: 'already exists'};
    links.set(link.name!, structuredClone(link));
    return ok(link);
  });
  spyOn(P, 'getEntryLink').mockImplementation(async (...a: any[]) => {
    for (const [name, l] of links) {
      if (name.endsWith(`/entryLinks/${a[3]}`)) return ok(structuredClone(l));
    }
    return {status: 404, message: 'not found'};
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


// ---------------------------------------------------------------------------
// K3 & K1 end-to-end over fakeCatalog (including grounding trailers!).
// ---------------------------------------------------------------------------

const LOCATOR = {
  datasetLocations: new Map([['data-proj.sem', 'US'], ['src.sales', 'US']]),
  projectNumbers: new Map([['data-proj', '42'], ['src', '43']]),
};

describe('K1: push -> pull over a V2 catalog (with grounding trailers)', () => {
  test('the pulled IR and serialized files equal the pushed ones (zero spurious diffs)', async () => {
    const {entries} = fakeCatalog();
    const push = await deployKnowledgeCatalog(
        loaded(shop()), CTX,
        {...OPTS, entryCreateTries: 1, bigQueryEntries: LOCATOR});
    expect(push.details).toBeUndefined();
    expect(push.success).toBe(true);
    // Verify grounding trailers were actually written to the stored entries.
    const anchor = [...entries.values()].find(e => e.name.endsWith('/entries/shop'))!;
    expect(anchor.entrySource?.description).toContain('Contents:');
    const customer = [...entries.values()].find(
        e => e.name.endsWith('/entries/shop/entities/Customer'))!;
    expect(customer.entrySource?.description).toContain('Read through:');
    expect(customer.entrySource?.description).toContain('Relationships:');

    const pull = await pullKnowledgeCatalog(new CatalogClient(CTX), OPTS);
    expect(pull.warnings).toEqual([]);
    expect(pull.models).toHaveLength(1);
    expect(pull.models[0]).toEqual(shop());
    expect(serializeModelFiles(pull.models[0]))
        .toEqual(serializeModelFiles(shop()));
  });

  test('a re-push is idempotent and still pulls back equal', async () => {
    const {entries} = fakeCatalog();
    const o = {...OPTS, entryCreateTries: 1, bigQueryEntries: LOCATOR};
    await deployKnowledgeCatalog(loaded(shop()), CTX, o);
    const count = entries.size;
    const again = await deployKnowledgeCatalog(loaded(shop()), CTX, o);
    expect(again.success).toBe(true);
    expect(again.created).toBe(0);
    expect(entries.size).toBe(count);
    const pull = await pullKnowledgeCatalog(new CatalogClient(CTX), OPTS);
    expect(pull.models[0]).toEqual(shop());
  });
});


describe('K3: binding links', () => {
  const res = generateCatalogResources(
      shop(), {...OPTS, bigQueryEntries: LOCATOR});
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
        .toBe('projects/dest/locations/us/entryGroups/eg/entries/shop/entities/Customer');
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

  test('an entry group in another region than the data: none, one warning',
       () => {
         const r = generateCatalogResources(shop(), {
           ...OPTS,
           location: 'global',
           bigQueryEntries: LOCATOR,
         });
         expect(r.bindingLinks).toEqual([]);
         const skipped = r.warnings.filter(w => /binding links? skipped/.test(w));
         expect(skipped).toHaveLength(1);
         expect(skipped[0]).toStartWith(
             `${res.bindingLinks!.length} binding links skipped`);
         expect(skipped[0]).toContain(`in 'global'`);
         expect(skipped[0]).toContain(`in 'us'`);
       });

  test('push of such a model writes none and still succeeds', async () => {
    const {links} = fakeCatalog();
    const r = await deployKnowledgeCatalog(loaded(shop()), CTX, {
      ...OPTS,
      location: 'global',
      entryCreateTries: 1,
      bigQueryEntries: LOCATOR,
    });
    expect(r.success).toBe(true);
    expect(r.bound).toBe(0);
    expect([...links.keys()].some(n => n.includes('-bind-'))).toBe(false);
  });

  test('push writes them non-fatally and reconciles stale ones', async () => {
    const {links} = fakeCatalog();
    const o = {...OPTS, entryCreateTries: 1, bigQueryEntries: LOCATOR};
    const first = await deployKnowledgeCatalog(loaded(shop()), CTX, o);
    expect(first.success).toBe(true);
    expect(first.bound).toBe(res.bindingLinks!.length);
    const ids = () => [...links.keys()].map(n => n.split('/').pop()!);
    expect(ids()).toContain('shop-bind-view-product');

    // Drop Product (and the relationship through it): its binding links go.
    const m = shop();
    m.entities = m.entities.filter(e => e.name !== 'Product');
    m.relationships = m.relationships.filter(r => !r.association);
    for (const p of m.profiles ?? []) {
      p.entities = p.entities.filter(e => e.name !== 'Product');
    }
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
    deployments: [{name: 'default', target: GRAPH}],
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
