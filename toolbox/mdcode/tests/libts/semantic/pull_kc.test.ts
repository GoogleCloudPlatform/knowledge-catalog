// Tests for the semantic-model Knowledge Catalog pull leg
// (pullKnowledgeCatalog in src/libts/semantic/pull_kc.ts).
//
// pullKnowledgeCatalog is the orchestration around the pure reader: enumerate
// the entry group, hydrate each semantic entry's aspect data, and reconstruct
// the IR. The catalog client is stubbed so no network call is made. The entries
// the fake serves are produced by the real emitter, so this exercises the true
// list -> hydrate -> read path end to end (an entity is re-fetched with BOTH
// its semantic-entity and schema aspects, and a second pass fetches each
// entity's schema-join links). The reader's own mapping is covered in
// kc_converter.test.ts; the focus here is the fetch SEQUENCE: aspect hydration,
// the relationship-link fetch (per-entry, deduped across endpoints), the
// --model filter, skipped entries, and ignoring foreign entries.

import {afterEach, describe, expect, mock, spyOn, test} from 'bun:test';

import {ApiResult} from '../../../src/libts/gcp/api';
import {CatalogClient, Entry, EntryLink} from '../../../src/libts/gcp/dataplex';
import {SemanticModel} from '../../../src/libts/semantic/ir';
import {generateCatalogResources} from '../../../src/libts/semantic/knowledge_catalog';
import {pullKnowledgeCatalog} from '../../../src/libts/semantic/pull_kc';

const OPTS = {
  project: 'dest',
  location: 'us',
  entryGroup: 'eg'
};

const SALES: SemanticModel = {
  name: 'sales',
  entities: [{
    name: 'orders',
    dataSource: 'demo.sales.orders',
    keys: [],
    fields: [
      {name: 'o_totalprice', expression: 'orders.o_totalprice', type: 'Decimal'}
    ],
  }],
  relationships: [],
  metrics: [{
    name: 'total_revenue',
    expression: 'SUM(orders.o_totalprice)',
    entity: 'orders',
    // Metrics carry a datatype through KC (semantic-metric.dataType is
    // required); Decimal -> NUMERIC on emit, NUMERIC -> Decimal on read.
    type: 'Decimal'
  }],
};

// The entries the emitter would have written for a model. Emitted with
// expressions on (a `--emit-expressions` push) so a model that carries field /
// metric expressions reconstructs exactly; the default push omits them (the
// converter tests in kc_converter.test.ts pin that gating).
function entriesFor(model: SemanticModel): Entry[] {
  return generateCatalogResources(model, {...OPTS, emitExpressions: true})
      .entries;
}

function ok<T>(result?: T): ApiResult<T> {
  return {status: 200, result};
}
function err(status: number, message: string): ApiResult<any> {
  return {status, message};
}

// Stubs listEntries (yields `listed`) and lookupEntry (serves `served` by name,
// or 404s an unknown name). `lookupFail` forces a failure for one entry name.
// `links` are served by lookupEntryLinks per referenced entry (so an undirected
// link comes back once from each endpoint, exercising the puller's dedup);
// `linkFail` forces a link-lookup failure for one entry name.
function stubClient(
    listed: Entry[], served: Entry[], lookupFail?: string,
    links: EntryLink[] = [],
    linkFail?: string): {list: any; lookup: any; lookupLinks: any} {
  const byName = new Map(served.map(e => [e.name, e]));
  const list = spyOn(CatalogClient.prototype, 'listEntries')
                   .mockImplementation(async function*() {
                     for (const e of listed) yield e;
                   } as any);
  const lookup = spyOn(CatalogClient.prototype, 'lookupEntry')
                     .mockImplementation(async (_p, _l, name) => {
                       if (name === lookupFail) return err(500, 'boom');
                       const e = byName.get(name);
                       return e ? ok(e) : err(404, 'not found');
                     });
  const lookupLinks =
      spyOn(CatalogClient.prototype, 'lookupEntryLinks')
          .mockImplementation(async (_p: any, _l: any, opts: any) => {
            if (opts.entry === linkFail) return err(500, 'boom');
            const forEntry = links.filter(
                l =>
                    (l.entryReferences ?? []).some(r => r.name === opts.entry));
            return ok(forEntry);
          });
  return {list, lookup, lookupLinks};
}

afterEach(() => {
  mock.restore();
});


describe('pullKnowledgeCatalog: happy path', () => {
  test('reconstructs the model from listed + hydrated entries', async () => {
    const entries = entriesFor(SALES);
    const {lookup} = stubClient(entries, entries);

    const cat = new CatalogClient({} as any);
    const {models, warnings} = await pullKnowledgeCatalog(cat, OPTS);

    expect(models).toHaveLength(1);
    expect(models[0]).toEqual(SALES);
    expect(warnings).toHaveLength(0);
    // Every listed semantic entry (model + entity + metric) was hydrated.
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  test(
      'an entity is hydrated with BOTH its semantic-entity and schema aspects',
      async () => {
        const entries = entriesFor(SALES);
        const {lookup} = stubClient(entries, entries);

        const cat = new CatalogClient({} as any);
        await pullKnowledgeCatalog(cat, OPTS);

        // Find the lookup call for the entity entry and inspect its requested
        // aspect types (the 4th arg).
        const entityEntry =
            entries.find(e => e.entryType.endsWith('/semantic-entity'))!;
        const call =
            lookup.mock.calls.find((c: any[]) => c[2] === entityEntry.name)!;
        const aspectTypes: string[] = call[3];
        expect(
            aspectTypes.some(t => t.endsWith('/aspectTypes/semantic-entity')))
            .toBe(true);
        expect(aspectTypes.some(t => t.endsWith('/aspectTypes/schema')))
            .toBe(true);
      });
});


describe('pullKnowledgeCatalog: relationship links', () => {
  // A 1:N model: orders.o_custkey (the FK side) references customer.c_custkey.
  const SALES_REL: SemanticModel = {
    name: 'sales',
    entities: [
      {
        name: 'orders',
        dataSource: 'demo.sales.orders',
        keys: [],
        fields: [{name: 'o_custkey', expression: 'orders.o_custkey'}],
      },
      {
        name: 'customer',
        dataSource: 'demo.sales.customer',
        keys: [],
        fields: [{name: 'c_custkey', expression: 'customer.c_custkey'}],
      },
    ],
    relationships: [{
      name: 'places',
      source: {entity: 'orders', columns: ['o_custkey']},
      destination: {entity: 'customer', columns: ['c_custkey']},
    }],
    metrics: [],
  };

  test(
      'a schema-join link reconstructs into a relationship exactly once',
      async () => {
        const {entries, entryLinks} = generateCatalogResources(SALES_REL, OPTS);
        const {lookupLinks} =
            stubClient(entries, entries, undefined, entryLinks);

        const cat = new CatalogClient({} as any);
        const {models, warnings} = await pullKnowledgeCatalog(cat, OPTS);

        expect(models[0].relationships).toEqual([{
          name: 'places',
          source: {entity: 'orders', columns: ['o_custkey']},
          destination: {entity: 'customer', columns: ['c_custkey']},
        }]);
        expect(warnings).toHaveLength(0);
        // Links are fetched per entity (2 entities), and the single undirected
        // link -- returned from both endpoints -- is deduped to one edge.
        expect(lookupLinks).toHaveBeenCalledTimes(2);
      });

  test(
      'an unnamed link returned from both endpoints is deduped to one edge',
      async () => {
        const {entries, entryLinks} = generateCatalogResources(SALES_REL, OPTS);
        // A nameless link can't dedup by name; the puller must fall back to the
        // endpoint pair, or the per-endpoint fan-out would yield it twice.
        const nameless = entryLinks.map(l => ({...l, name: undefined}));
        const {lookupLinks} = stubClient(entries, entries, undefined, nameless);

        const cat = new CatalogClient({} as any);
        const {models} = await pullKnowledgeCatalog(cat, OPTS);

        // Deduped to a single edge (a nameless link has no id, so the name
        // itself can't be recovered -- but it must not be counted twice).
        expect(models[0].relationships).toHaveLength(1);
        expect(models[0].relationships[0].source.entity).toBe('orders');
        expect(lookupLinks).toHaveBeenCalledTimes(2);
      });

  test(
      'a failed link lookup on one endpoint still recovers the edge from the ' +
          'other, and warns',
      async () => {
        const {entries, entryLinks} = generateCatalogResources(SALES_REL, OPTS);
        const ordersEntry =
            entries.find(e => (e.entrySource?.displayName) === 'orders')!;
        // Fail the link lookup for the orders entity; the link still comes back
        // from the customer endpoint.
        stubClient(entries, entries, undefined, entryLinks, ordersEntry.name);

        const cat = new CatalogClient({} as any);
        const {models, warnings} = await pullKnowledgeCatalog(cat, OPTS);

        expect(models[0].relationships.map(r => r.name)).toEqual(['places']);
        expect(warnings.some(
                   w => /failed to fetch entry links/i.test(w) &&
                       w.includes(ordersEntry.name)))
            .toBe(true);
      });
});


describe('pullKnowledgeCatalog: filtering and robustness', () => {
  test('--model keeps only the named model', async () => {
    const other: SemanticModel = {
      name: 'inventory',
      entities:
          [{name: 'items', dataSource: 'p.d.items', keys: [], fields: []}],
      relationships: [],
      metrics: [],
    };
    const entries = [...entriesFor(SALES), ...entriesFor(other)];
    stubClient(entries, entries);

    const cat = new CatalogClient({} as any);
    const {models} = await pullKnowledgeCatalog(cat, {...OPTS, model: 'sales'});
    expect(models.map(m => m.name)).toEqual(['sales']);
  });

  test('--model with no match returns nothing and warns', async () => {
    const entries = entriesFor(SALES);
    stubClient(entries, entries);

    const cat = new CatalogClient({} as any);
    const {models, warnings} =
        await pullKnowledgeCatalog(cat, {...OPTS, model: 'nope'});
    expect(models).toHaveLength(0);
    expect(warnings.some(w => /no semantic model named 'nope'/i.test(w)))
        .toBe(true);
  });

  test(
      'a non-semantic entry in the group is ignored, not fetched', async () => {
        const entries = entriesFor(SALES);
        const foreign: Entry = {
          name: `projects/dest/locations/us/entryGroups/eg/entries/foreign`,
          entryType: 'projects/x/locations/us/entryTypes/some-other-type',
        };
        const {lookup} = stubClient([...entries, foreign], entries);

        const cat = new CatalogClient({} as any);
        const {models} = await pullKnowledgeCatalog(cat, OPTS);
        expect(models).toHaveLength(1);
        // The foreign entry is never hydrated (only the 3 semantic entries
        // are).
        expect(lookup).toHaveBeenCalledTimes(3);
      });

  test('a failed hydration is skipped with a warning', async () => {
    const entries = entriesFor(SALES);
    const metricEntry =
        entries.find(e => e.entryType.endsWith('/semantic-metric'))!;
    stubClient(entries, entries, metricEntry.name);

    const cat = new CatalogClient({} as any);
    const {models, warnings} = await pullKnowledgeCatalog(cat, OPTS);

    // The model + entity still reconstruct; only the metric is dropped.
    expect(models).toHaveLength(1);
    expect(models[0].metrics).toHaveLength(0);
    expect(warnings.some(
               w => /failed to fetch/i.test(w) && w.includes(metricEntry.name)))
        .toBe(true);
  });

  test('--model hydrates only the target model\'s entries', async () => {
    const other: SemanticModel = {
      name: 'inventory',
      entities:
          [{name: 'items', dataSource: 'p.d.items', keys: [], fields: []}],
      relationships: [],
      metrics: [],
    };
    const entries = [...entriesFor(SALES), ...entriesFor(other)];
    const {lookup} = stubClient(entries, entries);

    const cat = new CatalogClient({} as any);
    const {models} = await pullKnowledgeCatalog(cat, {...OPTS, model: 'sales'});
    expect(models.map(m => m.name)).toEqual(['sales']);
    // SALES has 3 entries (model + entity + metric); inventory's are never
    // fetched -- the flag scopes hydration, not just the final result.
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  test(
      '--model keeps a child whose parentEntry does not resolve (sole-anchor ' +
          'fallback)',
      async () => {
        const entries = entriesFor(SALES);
        // Simulate a project-id normalization mismatch: the metric points at an
        // anchor name that differs from the emitted one. With a single model in
        // the group a full pull still attaches it via the reader's sole-anchor
        // fallback, so a scoped pull must keep it too (else --model silently
        // drops a child a full pull returns).
        const metricEntry =
            entries.find(e => e.entryType.endsWith('/semantic-metric'))!;
        metricEntry.parentEntry = metricEntry.parentEntry!.replace(
            'projects/dest/', 'projects/12345/');
        const {lookup} = stubClient(entries, entries);

        const cat = new CatalogClient({} as any);
        const {models} =
            await pullKnowledgeCatalog(cat, {...OPTS, model: 'sales'});

        expect(models).toHaveLength(1);
        expect(models[0].metrics.map(m => m.name)).toEqual(['total_revenue']);
        // The metric was hydrated despite the parent mismatch (3 entries).
        expect(lookup).toHaveBeenCalledTimes(3);
      });

  test('--model with no match fetches nothing and warns', async () => {
    const entries = entriesFor(SALES);
    const {lookup} = stubClient(entries, entries);

    const cat = new CatalogClient({} as any);
    const {models, warnings} =
        await pullKnowledgeCatalog(cat, {...OPTS, model: 'nope'});
    expect(models).toHaveLength(0);
    expect(lookup).not.toHaveBeenCalled();
    expect(warnings.some(w => /no semantic model named 'nope'/i.test(w)))
        .toBe(true);
  });
});
