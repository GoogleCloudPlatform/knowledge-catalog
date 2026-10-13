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
// single-model-per-group invariant, aborting on any fetch failure, ignoring
// foreign entries, and the stored file copies a pull returns.

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
  // ai_context.instructions rides back through the guidelines aspect; keys,
  // unique keys, and the field label ride back through the schema aspect -- all
  // persisted by a default push, so the full model reconstructs exactly.
  aiContext: {instructions: 'Use for order analysis.'},
  entities: [{
    name: 'orders',
    authoredSource: '//bigquery.googleapis.com/projects/demo/datasets/sales/tables/orders',
    dataSource: 'demo.sales.orders',
    keys: ['o_orderkey'],
    uniqueKeys: [['o_totalprice']],
    aiContext: {instructions: 'One row per order.'},
    fields: [
      {name: 'o_orderkey', expression: 'orders.o_orderkey', type: 'Integer'},
      {
        name: 'o_totalprice',
        expression: 'orders.o_totalprice',
        type: 'Decimal',
        label: 'Total Price',
      },
    ],
  }],
  relationships: [],
  metrics: [{
    name: 'total_revenue',
    expression: 'SUM(orders.o_totalprice)',
    entity: 'orders',
    aiContext: {instructions: 'Sum of order totals.'},
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

// The warning a pull gives when the catalog holds no stored copy of the model
// file. Entries emitted without sourceFiles hold none.
const NO_COPY_WARNING =
    expect.stringContaining('no stored copy of the model file was found');

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
    // The entries hold no file copy, so the pull says it rebuilt the model.
    expect(warnings).toEqual([NO_COPY_WARNING]);
    // Every listed semantic entry (model + entity + metric) was hydrated.
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  test(
      'an entity is hydrated with its semantic-entity, schema, and ' +
          'guidelines aspects',
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
        // The guidelines aspect carries ai_context.instructions, so pull must
        // request it too (for every semantic entry, not just entities).
        expect(aspectTypes.some(t => t.endsWith('/aspectTypes/guidelines')))
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
        expect(warnings).toEqual([NO_COPY_WARNING]);
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

  test('a failed link lookup aborts the pull', async () => {
    const {entries, entryLinks} = generateCatalogResources(SALES_REL, OPTS);
    const ordersEntry =
        entries.find(e => (e.entrySource?.displayName) === 'orders')!;
    // A non-200 link lookup means a relationship might be silently missing, so
    // the pull aborts rather than reconstruct a model with a dropped edge.
    stubClient(entries, entries, undefined, entryLinks, ordersEntry.name);

    const cat = new CatalogClient({} as any);
    await expect(pullKnowledgeCatalog(cat, OPTS))
        .rejects.toThrow(new RegExp(
            `failed to fetch entry links.*${ordersEntry.name}`, 'i'));
  });
});


describe('pullKnowledgeCatalog: single-model invariant and robustness', () => {
  test(
      'more than one semantic model in the group is a hard error', async () => {
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
        // An entry group holds exactly one model; two anchors is an unexpected
        // catalog state the pull refuses to guess through, naming both.
        await expect(pullKnowledgeCatalog(cat, OPTS))
            .rejects.toThrow(/holds 2 semantic models.*expected exactly one/i);
      });

  test('an empty group reconstructs no models (a clean no-op)', async () => {
    stubClient([], []);

    const cat = new CatalogClient({} as any);
    const {models, warnings} = await pullKnowledgeCatalog(cat, OPTS);
    expect(models).toHaveLength(0);
    // Zero anchors is "nothing to pull", surfaced as a soft warning.
    expect(warnings.some(w => /nothing to reconstruct/i.test(w))).toBe(true);
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

  test('a failed hydration aborts the pull', async () => {
    const entries = entriesFor(SALES);
    const metricEntry =
        entries.find(e => e.entryType.endsWith('/semantic-metric'))!;
    stubClient(entries, entries, metricEntry.name);

    const cat = new CatalogClient({} as any);
    // A failed fetch means part of the model would be silently missing, so the
    // pull aborts rather than reconstruct an incomplete model.
    await expect(pullKnowledgeCatalog(cat, OPTS))
        .rejects.toThrow(
            new RegExp(`failed to fetch entry.*${metricEntry.name}`, 'i'));
  });

  test(
      'a child whose parentEntry does not resolve is kept (sole-anchor ' +
          'fallback)',
      async () => {
        const entries = entriesFor(SALES);
        // Simulate a project-id normalization mismatch: the metric points at an
        // anchor name that differs from the emitted one. With a single model in
        // the group the reader still attaches it via the sole-anchor fallback.
        const metricEntry =
            entries.find(e => e.entryType.endsWith('/semantic-metric'))!;
        metricEntry.parentEntry = metricEntry.parentEntry!.replace(
            'projects/dest/', 'projects/12345/');
        const {lookup} = stubClient(entries, entries);

        const cat = new CatalogClient({} as any);
        const {models} = await pullKnowledgeCatalog(cat, OPTS);

        expect(models).toHaveLength(1);
        expect(models[0].metrics.map(m => m.name)).toEqual(['total_revenue']);
        // The metric was hydrated despite the parent mismatch (3 entries).
        expect(lookup).toHaveBeenCalledTimes(3);
      });
});


describe('pullKnowledgeCatalog: file copies', () => {
  const MODEL_FILE = {fileName: 'sales.yaml', content: '# sales\nversion: x\n'};
  const PROFILE_FILE = {
    fileName: 'sales.profile.prod.yaml',
    content: 'name: prod\n',
  };
  // The model file is listed first and sorts last, so the result shows the
  // sort.
  const withCopies = () => generateCatalogResources(SALES, {
                       ...OPTS,
                       emitExpressions: true,
                       sourceFiles: [MODEL_FILE, PROFILE_FILE],
                     }).entries;
  const isCopy = (e: Entry) => e.entryType.endsWith('/semantic-model-file');
  // The entries a push of both files writes. It labels the model entry with
  // its push id.
  const stamp = (pushId: string) => ({pushId, pushFileCount: 2});
  const pushed = (pushId = 'push-3') => generateCatalogResources(SALES, {
                                          ...OPTS,
                                          emitExpressions: true,
                                          sourceFiles: [
                                            {...MODEL_FILE, ...stamp(pushId)},
                                            {...PROFILE_FILE, ...stamp(pushId)},
                                          ],
                                        }).entries;
  const NOT_FINISHED = 'the last push of model \'sales\' did not finish: ';

  test('returns each stored file, sorted by file name', async () => {
    const entries = withCopies();
    const {lookup} = stubClient(entries, entries);

    const cat = new CatalogClient({} as any);
    const {models, rawFiles, warnings} = await pullKnowledgeCatalog(cat, OPTS);

    expect(rawFiles).toEqual([PROFILE_FILE, MODEL_FILE]);
    // The rebuilt model still comes back, for the caller's checks.
    expect(models[0]).toEqual(SALES);
    expect(warnings).toEqual([]);
    // Each copy is fetched with its aspect, in the destination project where
    // the custom type lives.
    const copy = entries.find(isCopy)!;
    const call = lookup.mock.calls.find((c: any[]) => c[2] === copy.name)!;
    expect(call[3]).toEqual(
        ['projects/dest/locations/global/aspectTypes/semantic-model-file']);
  });

  test('with v2Aspects on, returns no file and fetches none', async () => {
    const entries = withCopies();
    const {lookup} = stubClient(entries, entries);

    const cat = new CatalogClient({} as any);
    const {rawFiles, warnings} =
        await pullKnowledgeCatalog(cat, {...OPTS, v2Aspects: true});

    expect(rawFiles).toBeUndefined();
    expect(warnings).toEqual([]);
    const fetched = lookup.mock.calls.map((c: any[]) => c[2]);
    expect(entries.filter(isCopy).some(e => fetched.includes(e.name)))
        .toBe(false);
  });

  // A model an older kcmd pushed has no push id label and no copies.
  test('a model with no label and no copies is rebuilt from the aspects and ' +
           'warns',
       async () => {
         const entries = entriesFor(SALES);
         expect(entries[0].entrySource?.labels).toBeUndefined();
         stubClient(entries, entries);

         const cat = new CatalogClient({} as any);
         const {models, rawFiles, warnings} =
             await pullKnowledgeCatalog(cat, OPTS);

         expect(rawFiles).toEqual([]);
         expect(models[0]).toEqual(SALES);
         expect(warnings).toEqual([NO_COPY_WARNING]);
       });

  // A push writes the model entry before its copies, so one that stopped in
  // between leaves the labeled model entry and no copy.
  test('a labeled model with no copies aborts the pull', async () => {
    const entries = pushed().filter(e => !isCopy(e));
    expect(entries[0].entrySource?.labels).toEqual({'kcmd-push-id': 'push-3'});
    stubClient(entries, entries);

    const cat = new CatalogClient({} as any);
    await expect(pullKnowledgeCatalog(cat, OPTS))
        .rejects.toThrow(
            `${NOT_FINISHED}the catalog holds none of its file copies, so ` +
            'pull writes nothing. Push again, then pull.');
  });

  // A re-push whose model entry landed and whose copies did not leaves the
  // copies of the push before it, which are a finished set.
  test('a labeled model whose copies come from another push aborts the pull',
       async () => {
         const entries = [
           ...pushed().filter(e => !isCopy(e)),
           ...pushed('push-2').filter(isCopy),
         ];
         stubClient(entries, entries);

         const cat = new CatalogClient({} as any);
         await expect(pullKnowledgeCatalog(cat, OPTS))
             .rejects.toThrow(
                 `${NOT_FINISHED}its model entry and its file copies come ` +
                 'from different pushes, so pull writes nothing. Push ' +
                 'again, then pull.');
       });

  test('a labeled model whose copies are all unreadable aborts the pull, ' +
           'naming them',
       async () => {
         const entries = pushed();
         for (const e of entries.filter(isCopy)) {
           for (const a of Object.values(e.aspects ?? {})) delete a.data!.content;
         }
         stubClient(entries, entries);

         const cat = new CatalogClient({} as any);
         await expect(pullKnowledgeCatalog(cat, OPTS))
             .rejects.toThrow(
                 `${NOT_FINISHED}the catalog holds no readable file copy, so ` +
                 'pull writes nothing. Push again, then pull. file copy ' +
                 '\'sales.files.sales.yaml\' holds no file name or no ' +
                 'content; it is skipped.');
       });

  // Only the model entry carries the label. A listing may put any entry
  // first, such as the model's own children or a copy another model left.
  test('the label is read from the model entry, wherever it is listed',
       async () => {
         const [anchor, ...children] = pushed().filter(e => !isCopy(e));
         const stray = generateCatalogResources({...SALES, name: 'old'}, {
                         ...OPTS,
                         sourceFiles: [{
                           fileName: 'old.yaml',
                           content: 'x',
                           pushId: 'push-1',
                         }],
                       }).entries.filter(isCopy);
         const listed = [...stray, ...children, anchor];
         stubClient(listed, listed);

         const cat = new CatalogClient({} as any);
         await expect(pullKnowledgeCatalog(cat, OPTS))
             .rejects.toThrow('the catalog holds none of its file copies');
       });

  test('with v2Aspects on, a labeled model with no copies is pulled',
       async () => {
         const entries = pushed().filter(e => !isCopy(e));
         stubClient(entries, entries);

         const cat = new CatalogClient({} as any);
         const {models} =
             await pullKnowledgeCatalog(cat, {...OPTS, v2Aspects: true});

         expect(models.map(m => m.name)).toEqual(['sales']);
       });

  test('the rebuilt model\'s warnings are left out when the copies are used',
       async () => {
         // The reader warns that it made up a deployment name.
         const targeted: SemanticModel = {
           ...SALES,
           customExtensions: [{
             vendorName: 'GOOGLE',
             data: JSON.stringify({
               deploymentTargets: [
                 '//bigquery.googleapis.com/projects/demo/datasets/d/propertyGraphs/g',
               ],
             }),
           }],
         };
         const entries =
             generateCatalogResources(
                 targeted, {...OPTS, sourceFiles: [MODEL_FILE]})
                 .entries;
         stubClient(entries, entries);

         const cat = new CatalogClient({} as any);
         const {rawFiles, warnings} = await pullKnowledgeCatalog(cat, OPTS);

         expect(rawFiles).toEqual([MODEL_FILE]);
         expect(warnings).toEqual([]);
       });

  test('copies without the model file are not used, and the model is rebuilt',
       async () => {
         const entries = generateCatalogResources(SALES, {
                           ...OPTS,
                           emitExpressions: true,
                           sourceFiles: [
                             {fileName: 'shop.yaml', content: 'x'},
                             PROFILE_FILE,
                           ],
                         }).entries;
         stubClient(entries, entries);

         const cat = new CatalogClient({} as any);
         const {models, rawFiles, warnings} =
             await pullKnowledgeCatalog(cat, OPTS);

         expect(rawFiles).toEqual([]);
         expect(models[0]).toEqual(SALES);
         expect(warnings).toEqual([
           'the stored copies of model \'sales\' hold no \'sales.yaml\', so ' +
               'the model file is rebuilt from the catalog\'s aspects and may ' +
               'differ from what was pushed',
         ]);
       });

  test('copies from one push come back with its id', async () => {
    const entries = generateCatalogResources(SALES, {
                      ...OPTS,
                      sourceFiles: [
                        {...MODEL_FILE, pushId: 'push-2'},
                        {...PROFILE_FILE, pushId: 'push-2'},
                      ],
                    }).entries;
    stubClient(entries, entries);

    const cat = new CatalogClient({} as any);
    const {rawFiles} = await pullKnowledgeCatalog(cat, OPTS);

    expect(rawFiles).toEqual([
      {...PROFILE_FILE, pushId: 'push-2'},
      {...MODEL_FILE, pushId: 'push-2'},
    ]);
  });

  // Copies stored before push ids carry none, and are used as they are.
  test('copies of which none carries a push id are used', async () => {
    const entries = withCopies();
    stubClient(entries, entries);

    const cat = new CatalogClient({} as any);
    const {rawFiles} = await pullKnowledgeCatalog(cat, OPTS);

    expect(rawFiles).toEqual([PROFILE_FILE, MODEL_FILE]);
  });

  // A push that stopped partway leaves some copies from it beside copies
  // from the push before.
  for (const [label, profileId] of [
         ['differ', 'push-1'],
         ['are on only some copies', undefined],
       ] as const) {
    test(`copies whose push ids ${label} abort the pull`, async () => {
      const entries = generateCatalogResources(SALES, {
                        ...OPTS,
                        sourceFiles: [
                          {...MODEL_FILE, pushId: 'push-2'},
                          {...PROFILE_FILE, pushId: profileId},
                        ],
                      }).entries;
      stubClient(entries, entries);

      const cat = new CatalogClient({} as any);
      await expect(pullKnowledgeCatalog(cat, OPTS))
          .rejects.toThrow(
              'the last push of model \'sales\' did not finish: its file ' +
              'copies in the catalog come from different pushes, so pull ' +
              'writes nothing. Push again, then pull.');
    });
  }

  // Every copy that push wrote landed.
  test('a set of as many copies as the push stored is used', async () => {
    const stamped = {pushId: 'push-2', pushFileCount: 2};
    const entries = generateCatalogResources(SALES, {
                      ...OPTS,
                      sourceFiles: [
                        {...MODEL_FILE, ...stamped},
                        {...PROFILE_FILE, ...stamped},
                      ],
                    }).entries;
    stubClient(entries, entries);

    const cat = new CatalogClient({} as any);
    const {rawFiles} = await pullKnowledgeCatalog(cat, OPTS);

    expect(rawFiles).toEqual([
      {...PROFILE_FILE, ...stamped},
      {...MODEL_FILE, ...stamped},
    ]);
  });

  // A push that stopped before its last copy landed leaves a set whose ids
  // agree.
  test('fewer copies than the push stored abort the pull', async () => {
    const entries = generateCatalogResources(SALES, {
                      ...OPTS,
                      sourceFiles: [
                        {...MODEL_FILE, pushId: 'push-2', pushFileCount: 2},
                      ],
                    }).entries;
    stubClient(entries, entries);

    const cat = new CatalogClient({} as any);
    await expect(pullKnowledgeCatalog(cat, OPTS))
        .rejects.toThrow(
            'the last push of model \'sales\' did not finish: the catalog ' +
            'holds 1 of its 2 file copies, so pull writes nothing. Push ' +
            'again, then pull.');
  });

  // More copies than the push stored, which only another writer leaves,
  // abort the pull too.
  test('more copies than the push stored abort the pull', async () => {
    const entries = generateCatalogResources(SALES, {
                      ...OPTS,
                      sourceFiles: [
                        {...MODEL_FILE, pushId: 'push-2', pushFileCount: 1},
                        {...PROFILE_FILE, pushId: 'push-2', pushFileCount: 1},
                      ],
                    }).entries;
    stubClient(entries, entries);

    const cat = new CatalogClient({} as any);
    await expect(pullKnowledgeCatalog(cat, OPTS))
        .rejects.toThrow(
            'the catalog holds 2 file copies, but the push stored 1, so pull ' +
            'writes nothing.');
  });

  // A copy with no content is skipped, so the set comes up short; the error
  // names the skipped copy.
  test('a skipped copy is named in the refusal', async () => {
    const entries = generateCatalogResources(SALES, {
                      ...OPTS,
                      sourceFiles: [
                        {...MODEL_FILE, pushId: 'push-2', pushFileCount: 2},
                        {...PROFILE_FILE, pushId: 'push-2', pushFileCount: 2},
                      ],
                    }).entries;
    for (const e of entries.filter(isCopy)) {
      for (const a of Object.values(e.aspects ?? {})) {
        if ((a as any).data?.fileName === PROFILE_FILE.fileName) {
          delete (a as any).data.content;
        }
      }
    }
    stubClient(entries, entries);

    const cat = new CatalogClient({} as any);
    await expect(pullKnowledgeCatalog(cat, OPTS))
        .rejects.toThrow(/holds 1 of its 2 file copies.*holds no file name or no content; it is skipped/);
  });

  // Another model's copy, left behind by a push that failed while deleting
  // it, is not one of this model's.
  test('a copy under another model\'s prefix is ignored', async () => {
    const entries = generateCatalogResources(SALES, {
                      ...OPTS,
                      sourceFiles: [{...MODEL_FILE, pushId: 'push-2'}],
                    }).entries;
    const stray = generateCatalogResources({...SALES, name: 'old'}, {
                    ...OPTS,
                    sourceFiles: [
                      {fileName: 'old.yaml', content: 'x', pushId: 'push-1'},
                    ],
                  }).entries.filter(isCopy);
    stubClient([...entries, ...stray], [...entries, ...stray]);

    const cat = new CatalogClient({} as any);
    const {rawFiles} = await pullKnowledgeCatalog(cat, OPTS);

    expect(rawFiles).toEqual([{...MODEL_FILE, pushId: 'push-2'}]);
  });

  test('a copy with no content is skipped with a warning', async () => {
    const entries = withCopies();
    const profile = entries.find(
        e => isCopy(e) && e.name.endsWith('sales.profile.prod.yaml'))!;
    for (const aspect of Object.values(profile.aspects!)) {
      delete aspect.data!.content;
    }
    stubClient(entries, entries);

    const cat = new CatalogClient({} as any);
    const {rawFiles, warnings} = await pullKnowledgeCatalog(cat, OPTS);

    expect(rawFiles).toEqual([MODEL_FILE]);
    expect(warnings).toEqual([
      'file copy \'sales.files.sales.profile.prod.yaml\' holds no file name ' +
          'or no content; it is skipped',
    ]);
  });
});
