// Tests for the semantic-model Knowledge Catalog deploy leg
// (src/libts/semantic/deploy_knowledge_catalog.ts).
//
// `deployKnowledgeCatalog` is exercised end to end over an Ossie fixture
// (loader -> IR -> emitter -> writes), with the catalog client stubbed so no
// network call is made. The focus is the publish SEQUENCE the emitter
// goldens cannot show: anchor-first entry writes (the entry group is
// provisioned at `init`, not here), idempotent upsert on re-push, delete
// reconciliation, and the dry-run plan.

import {afterEach, describe, expect, mock, spyOn, test} from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {ApiResult} from '../../../src/libts/gcp/api';
import {ApiContext} from '../../../src/libts/gcp/context';
import {CatalogClient} from '../../../src/libts/gcp/dataplex';
import {deployKnowledgeCatalog} from '../../../src/libts/semantic/deploy_knowledge_catalog';
import {loadSemanticModels} from '../../../src/libts/semantic/loader';

const CTX = new ApiContext('test-project', 'us', 'test-token');
const FIXTURES = path.join(__dirname, 'fixtures');

// A loader-valid model: one entity (orders) + one metric (total_revenue), so a
// push writes exactly three entries (model anchor + entity + metric).
const OSSIE =
    fs.readFileSync(path.join(FIXTURES, 'sales_bq_graph_target.yaml'), 'utf8');
const DOCS = [{name: 'sales.yaml', text: OSSIE}];

// A model with a direct-FK relationship: 5 entries (anchor + 2 entities + 2
// metrics) plus 1 schema-join entry link (orders -> customer). Used to exercise
// the link write path the OSSIE fixture (no relationship) cannot.
const STAR =
    fs.readFileSync(path.join(FIXTURES, 'star_orders_customer.yaml'), 'utf8');
const STAR_DOCS = [{name: 'star.yaml', text: STAR}];

// The deploy leg now consumes models already parsed by loadSemanticModels
// (shared with the BigQuery leg). These tests author documents, so this helper
// parses them the way commands.ts does.
function models(docs: {name: string; text: string}[]) {
  const r = loadSemanticModels(docs, {defaultProject: 'test-project'});
  if (r.error) throw new Error(r.error);
  return r.models;
}

// A destination entry name for a given entry id, as the catalog returns it from
// listEntries; reconciliation keys off the id (the last path segment).
function entryName(id: string): string {
  return `projects/dest/locations/us/entryGroups/eg/entries/${id}`;
}

// The same loader-valid model, but its GOOGLE custom_extension carries invalid
// JSON: the doc parses, yet the emitter (via bigQueryGraphTargets) throws while
// building the semantic-model aspect. Surgically swap only the `data:` value so
// the rest of the document stays valid.
const MALFORMED_EXTENSION =
    OSSIE.replace(/data: '[^\n]*'/, 'data: \'not valid json\'');

// entryCreateTries: 1 keeps the propagation-retry loop from sleeping in tests.
const OPTS = {
  project: 'dest',
  location: 'us',
  entryGroup: 'eg',
  entryCreateTries: 1
};

// bun's spyOn accumulates calls across tests; restore originals after each so
// per-test call counts and ordering assertions are isolated.
afterEach(() => {
  mock.restore();
});

function ok<T>(result?: T): ApiResult<T> {
  return {status: 200, result};
}
function err(status: number, message: string): ApiResult<any> {
  return {status, message};
}

// Stubs createEntryGroup + createEntry (+ optionally updateEntry) and the entry-
// link writes, returning the spies so a test can assert call counts and
// ordering.
function stubClient(opts: {
  group?: ApiResult<any>,
  create?: (entryId: string) => ApiResult<any>,
  update?: ApiResult<any>,
  // Entries the destination entry group already holds (yielded by listEntries).
  // A bare id defaults to a generic entryType; pass {id, type} to stage a
  // specific one (e.g. a foreign semantic-model anchor). Default: none.
  existing?: (string | {id: string; type: string})[],
  del?: (entryId: string) => ApiResult<any>,
  // Result of createEntryLink, keyed by the entry-link id. Default: 200.
  createLink?: (linkId: string) => ApiResult<any>,
  updateLink?: ApiResult<any>,
  // Entry links the destination returns from lookupEntryLinks, keyed by the
  // referenced entry's full resource name. Default: none (ok, empty list).
  links?: (entry: string) => ApiResult<any>,
  // Result of deleteEntryLink, keyed by the entry-link id. Default: 200.
  delLink?: (linkId: string) => ApiResult<any>,
} = {}) {
  const group = spyOn(CatalogClient.prototype, 'createEntryGroup')
                    .mockImplementation(async () => opts.group ?? ok({}));
  const create = spyOn(CatalogClient.prototype, 'createEntry')
                     .mockImplementation(
                         async (_p, _l, _eg, entryId) =>
                             (opts.create ?? (() => ok({})))(entryId));
  const update = spyOn(CatalogClient.prototype, 'updateEntry')
                     .mockImplementation(async () => opts.update ?? ok({}));
  const list = spyOn(CatalogClient.prototype, 'listEntries')
                   .mockImplementation(async function*() {
                     for (const e of opts.existing ?? []) {
                       const id = typeof e === 'string' ? e : e.id;
                       const entryType =
                           typeof e === 'string' ? 'semantic' : e.type;
                       yield {name: entryName(id), entryType} as any;
                     }
                   });
  const del = spyOn(CatalogClient.prototype, 'deleteEntry')
                  .mockImplementation(
                      async (_p, _l, _eg, entryId) =>
                          (opts.del ?? (() => ok({})))(entryId));
  const createLink = spyOn(CatalogClient.prototype, 'createEntryLink')
                         .mockImplementation(
                             async (_p, _l, _eg, linkId) =>
                                 (opts.createLink ?? (() => ok({})))(linkId));
  const updateLink = spyOn(CatalogClient.prototype, 'updateEntryLink')
                         .mockImplementation(
                             async () => opts.updateLink ?? ok({}));
  const lookupLinks =
      spyOn(CatalogClient.prototype, 'lookupEntryLinks')
          .mockImplementation(
              async (_p, _l, o: any) => (opts.links ?? (() => ok([])))(o.entry));
  const delLink = spyOn(CatalogClient.prototype, 'deleteEntryLink')
                      .mockImplementation(
                          async (_p, _l, _eg, linkId) =>
                              (opts.delLink ?? (() => ok({})))(linkId));
  return {group,      create, update,      list,
          del,        createLink,          updateLink,
          lookupLinks, delLink};
}


describe('deployKnowledgeCatalog: happy path', () => {
  test('writes entries anchor-first, provisioning nothing', async () => {
    const {group, create, update} = stubClient();

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.created).toBe(3);
    expect(result.updated).toBe(0);

    // Push provisions neither the entry group (created at `init`) nor any type
    // (the semantic types are built-in): it only writes the three entries.
    expect(group).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(3);
    expect(update).not.toHaveBeenCalled();

    // The model anchor is written before its children.
    const firstEntryId = create.mock.calls[0][3];
    expect(firstEntryId).toBe('sales');
  });
});


describe('deployKnowledgeCatalog: re-push upserts', () => {
  test('an entry that already exists is updated in place', async () => {
    const {create, update} = stubClient({
      create: () => err(409, 'entry already exists'),
      update: ok({}),
    });

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(3);
    expect(create).toHaveBeenCalledTimes(3);
    expect(update).toHaveBeenCalledTimes(3);
  });
});


describe('deployKnowledgeCatalog: relationship entry links', () => {
  test('a direct-FK relationship is written as one schema-join link', async () => {
    const {create, createLink, updateLink} = stubClient();

    const result = await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.created).toBe(5);  // anchor + 2 entities + 2 metrics
    expect(result.linked).toBe(1);
    expect(create).toHaveBeenCalledTimes(5);
    expect(createLink).toHaveBeenCalledTimes(1);
    expect(updateLink).not.toHaveBeenCalled();
    // Links are written to the same destination the entries are.
    const [project, location, entryGroup, linkId] = createLink.mock.calls[0];
    expect(project).toBe('dest');
    expect(location).toBe('us');
    expect(entryGroup).toBe('eg');
    expect(linkId).toBe('sales-orders-to-customer');
  });

  test('a link that already exists is upserted via updateEntryLink', async () => {
    const {createLink, updateLink} = stubClient({
      createLink: () => err(409, 'entry link already exists'),
      updateLink: ok({}),
    });

    const result = await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.linked).toBe(1);
    expect(createLink).toHaveBeenCalledTimes(1);
    expect(updateLink).toHaveBeenCalledTimes(1);
  });

  test('a failed link write fails the push, naming the link', async () => {
    stubClient({
      createLink: () => err(500, 'boom'),
    });

    const result = await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

    expect(result.success).toBe(false);
    expect(result.details).toContain('sales-orders-to-customer');
  });

  test('a model with no relationships writes no links', async () => {
    const {createLink} = stubClient();

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.linked).toBe(0);
    expect(createLink).not.toHaveBeenCalled();
  });
});


describe('deployKnowledgeCatalog: validateOnly', () => {
  test('writes nothing and returns a plan', async () => {
    const {group, create} = stubClient();

    const result =
        await deployKnowledgeCatalog(models(DOCS), CTX, {...OPTS, validateOnly: true});

    expect(result.success).toBe(true);
    expect(result.created).toBe(0);
    expect(group).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(result.plan.join('\n')).toContain('Knowledge Catalog plan');
    expect(result.plan.join('\n')).toContain('sales');
  });
});


describe('deployKnowledgeCatalog: failures', () => {
  test('a failed anchor write stops before its children', async () => {
    const {create} = stubClient({
      create: (id) => id === 'sales' ? err(500, 'boom') : ok({}),
    });

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);  // anchor only; children skipped
  });

  test(
      'a model that throws during emit fails with the model + document named',
      async () => {
        // A parseable doc whose GOOGLE extension is invalid JSON makes the
        // emitter throw; the publisher must report it, not crash the push.
        const {create} = stubClient();
        const docs = [{name: 'broken.yaml', text: MALFORMED_EXTENSION}];

        const result = await deployKnowledgeCatalog(models(docs), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details).toContain('broken.yaml');
        expect(result.details).toContain('sales');  // the model name
        expect(create).not.toHaveBeenCalled();
      });

  test(
      'two models generating the same entry id fail before any write',
      async () => {
        // Both docs declare a model named 'sales', so their entry ids collide
        // within the entry group; the second would silently upsert over the
        // first. The publisher must catch the collision up front.
        const {group, create} = stubClient();
        const docs = [
          {name: 'a.yaml', text: OSSIE},
          {name: 'b.yaml', text: OSSIE},
        ];

        const result = await deployKnowledgeCatalog(models(docs), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details).toContain('sales');   // the colliding entry id
        expect(result.details).toContain('unique');  // the reason
        expect(group).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
      });

  test('no documents is a hard error for a real push', async () => {
    stubClient();
    const result = await deployKnowledgeCatalog([], CTX, OPTS);
    expect(result.success).toBe(false);
    expect(result.details).toContain('No semantic model documents');
  });

  test('no documents is a clean no-op for validateOnly', async () => {
    stubClient();
    const result =
        await deployKnowledgeCatalog([], CTX, {...OPTS, validateOnly: true});
    expect(result.success).toBe(true);
  });
});


describe('deployKnowledgeCatalog: delete reconciliation', () => {
  // The fixture model 'sales' emits exactly three ids: the anchor 'sales', the
  // entity 'sales.entities.orders', and the metric 'sales.metrics.total_revenue'.
  const EMITTED = ['sales', 'sales.entities.orders', 'sales.metrics.total_revenue'];

  test('deletes entities/metrics removed from the model, scoped by owner', async () => {
    // The group also holds two orphans owned by the 'sales' anchor (an entity
    // and a metric no longer in the model) plus two entries owned by a
    // different model. Only the two orphans under 'sales' must be deleted.
    const {del, list} = stubClient({
      existing: [
        ...EMITTED,
        'sales.entities.removed',
        'sales.metrics.removed',
        'other',
        'other.entities.x',
      ],
    });

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(2);
    expect(list).toHaveBeenCalledTimes(1);
    const deletedIds = del.mock.calls.map(c => c[3]).sort();
    expect(deletedIds).toEqual(['sales.entities.removed', 'sales.metrics.removed']);
  });

  test('deletes nothing when the model still emits every entry', async () => {
    const {del} = stubClient({existing: EMITTED});

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(0);
    expect(del).not.toHaveBeenCalled();
  });

  test('a 404 on an orphan is tolerated (already gone)', async () => {
    const {del} = stubClient({
      existing: [...EMITTED, 'sales.entities.removed'],
      del: () => err(404, 'not found'),
    });

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(1);
    expect(del).toHaveBeenCalledTimes(1);
  });

  test('a failed delete fails the push, naming the entry', async () => {
    const {del} = stubClient({
      existing: [...EMITTED, 'sales.metrics.removed'],
      del: () => err(500, 'boom'),
    });

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(false);
    expect(result.details).toContain('sales.metrics.removed');
    expect(del).toHaveBeenCalledTimes(1);
  });

  test('validateOnly never lists or deletes (offline)', async () => {
    const {list, del} = stubClient({existing: ['sales.entities.removed']});

    const result =
        await deployKnowledgeCatalog(models(DOCS), CTX, {...OPTS, validateOnly: true});

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(0);
    expect(list).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });
});


// Built-in system entry types, as the catalog reports them on existing entries.
const MODEL_TYPE =
    'projects/dataplex-types/locations/global/entryTypes/semantic-model';
const ENTITY_TYPE =
    'projects/dataplex-types/locations/global/entryTypes/semantic-entity';
const METRIC_TYPE =
    'projects/dataplex-types/locations/global/entryTypes/semantic-metric';

// A schema-join entry link as lookupEntryLinks returns it: `refIds` are the two
// endpoint entry ids (undirected, both UNSPECIFIED).
function linkEntry(id: string, refIds: string[]): any {
  return {
    name: `projects/dest/locations/us/entryGroups/eg/entryLinks/${id}`,
    entryLinkType:
        'projects/dataplex-types/locations/global/entryLinkTypes/schema-join',
    entryReferences: refIds.map(r => ({name: entryName(r), type: 'UNSPECIFIED'})),
  };
}


describe('deployKnowledgeCatalog: link reconciliation', () => {
  // The STAR model 'sales' has entities orders + customer and emits exactly one
  // schema-join link, 'sales-orders-to-customer'.
  const KEPT = linkEntry(
      'sales-orders-to-customer',
      ['sales.entities.orders', 'sales.entities.customer']);

  test('deletes an owned schema-join link the model no longer emits',
     async () => {
       // The server also still holds a link to a dropped relationship (both
       // endpoints under this model). It is returned from both endpoints it
       // touches (orders + customer), so the dedup path is exercised too.
       const orphan = linkEntry(
           'sales-orders-to-supplier',
           ['sales.entities.orders', 'sales.entities.supplier']);
       const {delLink} = stubClient({
         links: (entry: string) => entry.endsWith('sales.entities.orders')
             ? ok([orphan, KEPT])
             : ok([KEPT]),
       });

       const result = await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

       expect(result.success).toBe(true);
       expect(result.unlinked).toBe(1);
       expect(delLink).toHaveBeenCalledTimes(1);
       expect(delLink.mock.calls[0][3]).toBe('sales-orders-to-supplier');
     });

  test('keeps a link the model still emits', async () => {
    const {delLink} = stubClient({
      links: (entry: string) =>
          entry.endsWith('sales.entities.orders') ? ok([KEPT]) : ok([KEPT]),
    });

    const result = await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.unlinked).toBe(0);
    expect(delLink).not.toHaveBeenCalled();
  });

  test('never deletes a link that touches an entry outside the model',
     async () => {
       // One endpoint is another model's entity: not owned, so not this model's
       // to reconcile even though it references one of our entities.
       const foreign = linkEntry(
           'sales-orders-to-external',
           ['sales.entities.orders', 'other.entities.x']);
       const {delLink} = stubClient({
         links: (entry: string) =>
             entry.endsWith('sales.entities.orders') ? ok([foreign]) : ok([]),
       });

       const result = await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

       expect(result.success).toBe(true);
       expect(result.unlinked).toBe(0);
       expect(delLink).not.toHaveBeenCalled();
     });

  test('a failed link delete fails the push, naming the link', async () => {
    const orphan = linkEntry(
        'sales-orders-to-supplier',
        ['sales.entities.orders', 'sales.entities.supplier']);
    const {delLink} = stubClient({
      links: (entry: string) =>
          entry.endsWith('sales.entities.orders') ? ok([orphan]) : ok([]),
      delLink: () => err(500, 'boom'),
    });

    const result = await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

    expect(result.success).toBe(false);
    expect(result.details).toContain('sales-orders-to-supplier');
    expect(delLink).toHaveBeenCalledTimes(1);
  });

  test('validateOnly never looks up or deletes links (offline)', async () => {
    const {lookupLinks, delLink} = stubClient({
      links: () => ok([linkEntry(
          'sales-orders-to-supplier',
          ['sales.entities.orders', 'sales.entities.supplier'])]),
    });

    const result = await deployKnowledgeCatalog(
        models(STAR_DOCS), CTX, {...OPTS, validateOnly: true});

    expect(result.success).toBe(true);
    expect(lookupLinks).not.toHaveBeenCalled();
    expect(delLink).not.toHaveBeenCalled();
  });
});


describe('deployKnowledgeCatalog: whole-model removal (--force-remove)', () => {
  test('a model already in the group that this push omits fails without the flag',
     async () => {
       const {create, del} = stubClient({
         existing: [{id: 'old', type: MODEL_TYPE}],
       });

       const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

       expect(result.success).toBe(false);
       expect(result.details).toContain('old');
       expect(result.details).toContain('--force-remove');
       // Nothing is written or deleted -- the guard runs before any mutation.
       expect(create).not.toHaveBeenCalled();
       expect(del).not.toHaveBeenCalled();
     });

  test('--force-remove drops the omitted model (entries + links), then writes',
     async () => {
       const orphanLink = linkEntry(
           'old-a-to-b', ['old.entities.a', 'old.entities.b']);
       const {create, del, delLink} = stubClient({
         existing: [
           {id: 'old', type: MODEL_TYPE},
           {id: 'old.entities.a', type: ENTITY_TYPE},
           {id: 'old.entities.b', type: ENTITY_TYPE},
           {id: 'old.metrics.m', type: METRIC_TYPE},
         ],
         links: (entry: string) =>
             entry.endsWith('old.entities.a') ? ok([orphanLink]) : ok([]),
       });

       const result = await deployKnowledgeCatalog(
           models(DOCS), CTX, {...OPTS, forceRemove: true});

       expect(result.success).toBe(true);
       // The foreign model's 4 entries and its 1 link are removed...
       expect(result.deleted).toBe(4);
       expect(result.unlinked).toBe(1);
       expect(delLink.mock.calls.map(c => c[3])).toEqual(['old-a-to-b']);
       expect(del.mock.calls.map(c => c[3]).sort()).toEqual(
           ['old', 'old.entities.a', 'old.entities.b', 'old.metrics.m']);
       // ...and the current model is still written (3 entries).
       expect(create).toHaveBeenCalledTimes(3);
     });

  test('an existing anchor this push re-emits is not treated as foreign',
     async () => {
       // The group already holds the same model being pushed: a normal re-push,
       // no --force-remove required, nothing removed.
       const {del} = stubClient({
         existing: [
           {id: 'sales', type: MODEL_TYPE},
           {id: 'sales.entities.orders', type: ENTITY_TYPE},
           {id: 'sales.metrics.total_revenue', type: METRIC_TYPE},
         ],
       });

       const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

       expect(result.success).toBe(true);
       expect(result.deleted).toBe(0);
       expect(del).not.toHaveBeenCalled();
     });
});
