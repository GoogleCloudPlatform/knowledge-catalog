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
import {applyKnowledgeCatalog, deployEmittedModels, deployKnowledgeCatalog, EmittedModel, preflightKnowledgeCatalog,} from '../../../src/libts/semantic/deploy_knowledge_catalog';
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

// A model declaring actions, used to exercise custom-type preflight checks.
const ACTIONS_DOC =
    fs.readFileSync(path.join(FIXTURES, 'actions_executors.yaml'), 'utf8');
const ACTIONS_DOCS = [{name: 'actions.yaml', text: ACTIONS_DOC}];

// The deploy leg now consumes models already parsed by loadSemanticModels
// (shared with the BigQuery leg). These tests author documents, so this helper
// parses them the way commands.ts does.
function models(docs: {name: string; text: string}[]) {
  const r = loadSemanticModels(docs, {defaultProject: 'test-project'});
  if (r.error) throw new Error(r.error);
  return r.models;
}

// A destination entry name for a given entry id, as the catalog returns it from
// listEntries. Reconciliation recovers the id by matching the CONTAINER's shape
// (`projects/*/locations/*/entryGroups/*/entries/`), not its exact text, so that
// a name spelling the project as a number is still recognised -- see the
// project-number test below.
function entryName(id: string, project = 'dest'): string {
  return `projects/${project}/locations/us/entryGroups/eg/entries/${id}`;
}

// A loader-valid VANILLA (0.2.0.dev0) model whose model-level GOOGLE
// custom_extension carries invalid JSON: the doc parses, yet the emitter (via
// googleDeploymentTargets) throws while building the semantic-model aspect.
// Under the extended profile the deployment target is a native key with no JSON
// to corrupt, so the malformed-carrier case is a vanilla document (which is the
// version that carries the target in a GOOGLE custom_extension at all).
const MALFORMED_EXTENSION = `
version: "0.2.0.dev0"
semantic_model:
  - name: sales
    custom_extensions:
      - vendor_name: GOOGLE
        data: 'not valid json'
    datasets:
      - name: orders
        source: demo.sales.orders
        primary_key: [o_orderkey]
        fields:
          - { name: o_orderkey, expression: o_orderkey }
          - { name: o_totalprice, expression: o_totalprice }
    metrics:
      - name: total_revenue
        expression: SUM(orders.o_totalprice)
`;

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

// Stubs CatalogClient entry, entry-link, and custom-type operations, returning
// the spies so a test can assert call counts and ordering.
function stubClient(opts: {
  group?: ApiResult<any>,
  create?: (entryId: string) => ApiResult<any>,
  update?: ApiResult<any>,
  // Entries the destination entry group already holds (yielded by listEntries).
  // A bare id defaults to a generic entryType; pass {id, type} to stage a
  // specific one (e.g. a foreign semantic-model anchor). Default: none.
  existing?: (string |
              {
                id: string;
                type?: string
              })[],
  // How listEntries spells the project in the names it yields. Defaults to the
  // scope's own project; set to a number to reproduce the server's inconsistent
  // id/number spelling.
  existingProject?: string,
  del?: (entryId: string) => ApiResult<any>,
  // Result of createEntryLink, keyed by the entry-link id. Default: 200.
  createLink?: (linkId: string) => ApiResult<any>,
  updateLink?: ApiResult<any>,
  // Entry links the destination returns from lookupEntryLinks, keyed by the
  // referenced entry's full resource name. Default: none (ok, empty list).
  links?: (entry: string) => ApiResult<any>,
  // Result of deleteEntryLink, keyed by the entry-link id. Default: 200.
  delLink?: (linkId: string) => ApiResult<any>,
  // Result of getEntryType / getAspectType, keyed by typeId. Default: 200.
  entryType?: (typeId: string) => ApiResult<any>,
  aspectType?: (typeId: string) => ApiResult<any>,
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
                       const entryType = typeof e === 'string' ?
                           'semantic' :
                           (e.type ?? 'semantic');
                       yield {
                         name: entryName(id, opts.existingProject),
                         entryType,
                       } as any;
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
  const getEntryType = spyOn(CatalogClient.prototype, 'getEntryType')
                           .mockImplementation(
                               async (_p, _l, typeId) =>
                                   (opts.entryType ?? (() => ok({})))(typeId));
  const getAspectType = spyOn(CatalogClient.prototype, 'getAspectType')
                            .mockImplementation(
                                async (_p, _l, typeId) => (
                                    opts.aspectType ?? (() => ok({})))(typeId));
  return {
    group,
    create,
    update,
    list,
    del,
    createLink,
    updateLink,
    lookupLinks,
    delLink,
    getEntryType,
    getAspectType,
  };
}


describe('deployKnowledgeCatalog: happy path', () => {
  test('writes entries anchor-first, provisioning nothing', async () => {
    const {group, create, update} = stubClient();

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.created).toBe(3);
    expect(result.updated).toBe(0);

    // Push provisions neither the entry group nor any type -- both are created
    // at `init` -- so it only writes the three entries.
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
    // Dataplex keeps an aspect that aspectKeys names and the body leaves out
    // unless deleteMissingAspects is set, so a removed guidelines aspect is
    // only deleted with it.
    // With deleteMissingAspects set, aspectKeys is what keeps aspects other
    // tools attached: it names the entry's own aspects and guidelines only.
    for (const call of update.mock.calls) {
      const own = Object.keys((call[0] as any).aspects ?? {});
      expect([...(call[2] as string[])].sort())
          .toEqual([...new Set([...own, 'dataplex-types.global.guidelines'])].sort());
      expect(call[3]).toBe(true);
    }
  });

  test('a failed entry update fails the push, naming the entry', async () => {
    stubClient({
      create: () => err(409, 'entry already exists'),
      update: err(500, 'update boom'),
    });

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(false);
    expect(result.details).toContain('entry \'sales\': update boom');
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
    // The upsert narrows the patch to the link's aspect keys (schema-join);
    // UpdateEntryLink has no update mask, so a stale ['aspects'] mask would 400.
    const aspectKeys = updateLink.mock.calls[0][1] ?? [];
    expect(aspectKeys.some((k: string) => k.endsWith('schema-join'))).toBe(true);
  });

  test('an existing link whose update is not addressable still succeeds',
       async () => {
         // The link exists (409), but this catalog surface exposes only create
         // + lookup for entry links, so the by-name aspect-refresh update comes
         // back NOT_FOUND. The link is fully present; only the aspect refresh is
         // unavailable, so the push must not fail on it.
         const {createLink, updateLink} = stubClient({
           createLink: () => err(409, 'entry link already exists'),
           updateLink: err(404, 'entry link not found'),
         });

         const result = await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

         expect(result.success).toBe(true);
         expect(result.linked).toBe(1);
         expect(createLink).toHaveBeenCalledTimes(1);
         expect(updateLink).toHaveBeenCalledTimes(1);
       });

  test('a masked PERMISSION_DENIED on the link update also succeeds', async () => {
    const {updateLink} = stubClient({
      createLink: () => err(409, 'entry link already exists'),
      updateLink: err(403, 'permission denied'),
    });

    const result = await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.linked).toBe(1);
    expect(updateLink).toHaveBeenCalledTimes(1);
  });

  test(
      'a hard failure on updateEntryLink fails the push, naming the link',
      async () => {
        stubClient({
          createLink: () => err(409, 'entry link already exists'),
          updateLink: err(500, 'update link boom'),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details)
            .toContain(
                'entry link \'sales-orders-to-customer\': update link boom');
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

    const result = await deployKnowledgeCatalog(
        models(DOCS), CTX, {...OPTS, validateOnly: true});

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
      'more than one model in a single push is rejected before any write',
      async () => {
        // Only one model per entry group is supported, so a push carrying two
        // documents is rejected up front -- which also means two models can
        // never race for the same entry id.
        const {group, create} = stubClient();
        const docs = [
          {name: 'a.yaml', text: OSSIE},
          {name: 'b.yaml', text: OSSIE},
        ];

        const result = await deployKnowledgeCatalog(models(docs), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details).toContain('one model per entry group');
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

  test('deletes entities/metrics/actions removed from the model, scoped by owner',
       async () => {
    // The group also holds three orphans owned by the 'sales' anchor (an
    // entity, a metric and an action no longer in the model) plus two entries
    // owned by a different model. Only the three orphans under 'sales' must be
    // deleted.
    const {del, list} = stubClient({
      existing: [
        ...EMITTED,
        'sales.entities.removed',
        'sales.metrics.removed',
        'sales.actions.Removed',
        'other',
        'other.entities.x',
      ],
    });

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(3);
    expect(list).toHaveBeenCalledTimes(1);
    const deletedIds = del.mock.calls.map(c => c[3]).sort();
    expect(deletedIds).toEqual([
      'sales.actions.Removed',
      'sales.entities.removed',
      'sales.metrics.removed',
    ]);
  });

  test('recognises owned entries when the server names the project by number',
       async () => {
    // listEntries does not always spell the project the way the scope does: the
    // server mixes ids and numbers, and _fixEntry only normalises them when its
    // Cloud Resource Manager lookup succeeds -- which silently fails for a
    // caller without resourcemanager.projects.get.
    //
    // An exact-prefix match against the scope's project therefore recovered no
    // id at all, so nothing was ever "owned", nothing was deleted, and the push
    // still reported success. Orphans accumulated invisibly.
    const {del} = stubClient({
      existing: [...EMITTED, 'sales.metrics.removed'],
      existingProject: '123456789',
    });

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(1);
    expect(del.mock.calls.map(c => c[3])).toEqual(['sales.metrics.removed']);
  });

  test('an empty ownedPrefixes entry cannot delete the whole entry group',
       async () => {
    // Unreachable through either current emitter -- both build prefixes from a
    // validated model name -- but deployEmittedModels is exported as the
    // seam for future origins, and it deletes on the strength of what it is
    // handed. An empty prefix matches every id, so without the guard this wipes
    // every entry in the group that the push did not re-emit.
    const {del} = stubClient({
      existing: ['mine', 'someone-elses-entry', 'bigquery.table.42'],
    });

    const result = await deployEmittedModels(
        [{
          model: 'm',
          resources: {
            entries: [{
              name: entryName('mine'),
              entryType: 'x',
              aspects: {},
            }] as any,
            entryLinks: [],
            warnings: [],
            ownedPrefixes: [''],
          },
        }],
        [], CTX, OPTS);

    expect(result.success).toBe(true);
    expect(del).not.toHaveBeenCalled();
    expect(result.deleted).toBe(0);
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

  // The model's entity entries as the destination already holds them (a
  // re-push). The deploy pipeline looks up links via these server-known
  // entities, so they must be in the pre-write listing for a link to be
  // discoverable.
  const STAR_ENTITIES = [
    {id: 'sales.entities.orders', type: ENTITY_TYPE},
    {id: 'sales.entities.customer', type: ENTITY_TYPE},
  ];

  test('deletes an owned schema-join link the model no longer emits',
     async () => {
       // The server also still holds a link to a dropped relationship (both
       // endpoints under this model). It is returned from both endpoints it
       // touches (orders + customer), so the dedup path is exercised too.
       const orphan = linkEntry(
           'sales-orders-to-supplier',
           ['sales.entities.orders', 'sales.entities.supplier']);
       const {delLink} = stubClient({
         existing: STAR_ENTITIES,
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
      existing: STAR_ENTITIES,
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
         existing: STAR_ENTITIES,
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
      existing: STAR_ENTITIES,
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

  test('deletes a link whose BOTH endpoints were removed in this push',
     async () => {
       // The dropped relationship's two endpoints are both entities removed from
       // the model, so the orphan link is reachable ONLY via those removed
       // entries in the pre-write snapshot -- never via a still-emitted entity.
       // Enumerating the snapshot (not the emitted set) is what finds it.
       const orphan = linkEntry(
           'sales-supplier-to-warehouse',
           ['sales.entities.supplier', 'sales.entities.warehouse']);
       const {delLink} = stubClient({
         existing: [
           ...STAR_ENTITIES,
           {id: 'sales.entities.supplier', type: ENTITY_TYPE},
           {id: 'sales.entities.warehouse', type: ENTITY_TYPE},
         ],
         links: (entry: string) =>
             entry.endsWith('sales.entities.supplier') ||
                 entry.endsWith('sales.entities.warehouse')
             ? ok([orphan])
             : ok([]),
       });

       const result = await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

       expect(result.success).toBe(true);
       expect(result.unlinked).toBe(1);
       expect(delLink.mock.calls.map(c => c[3]))
           .toEqual(['sales-supplier-to-warehouse']);
     });

  test('a first push (empty group) issues no link lookups', async () => {
    // No entity of the model exists on the server yet, so there are no
    // existing entity names to pass to lookupEntryLinks.
    const {lookupLinks, delLink} = stubClient();

    const result = await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

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

  test('a foreign model whose ids use a different scheme is removed whole',
     async () => {
       // The foreign model is by definition not in this push, so its emitter's
       // ownedPrefixes are unavailable and ownership has to be inferred from
       // the anchor. Naming the segments (`.entities.` / `.metrics.`) matches
       // only one id scheme: a model published with path-form ids keeps all of
       // its children, and because its anchor is gone no later push sees a
       // foreign model, so nothing ever owns them again.
       const {del} = stubClient({
         existing: [
           {id: 'old', type: MODEL_TYPE},
           {id: 'old/entities/customers', type: ENTITY_TYPE},
           {id: 'old/metrics/customers/count', type: METRIC_TYPE},
           {id: 'old/explores/all', type: ENTITY_TYPE},
         ],
         links: () => ok([]),
       });

       const result = await deployKnowledgeCatalog(
           models(DOCS), CTX, {...OPTS, forceRemove: true});

       expect(result.success).toBe(true);
       expect(result.deleted).toBe(4);
       expect(del.mock.calls.map(c => c[3]).sort()).toEqual([
         'old', 'old/entities/customers', 'old/explores/all',
         'old/metrics/customers/count',
       ]);
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


describe('preflightKnowledgeCatalog and applyKnowledgeCatalog', () => {
  test(
      'fails preflight before any write when a custom entry type is missing',
      async () => {
        // The model declares actions (`semantic-action`), which is a custom
        // type that `kcmd init --semantic-model` provisions in the destination
        // project (`global` location). Simulate a project where
        // `semantic-action` has not been provisioned (404 on getEntryType).
        const {
          create,
          update,
          del,
          createLink,
          updateLink,
          delLink,
          getEntryType,
          getAspectType,
        } = stubClient({
          entryType: (typeId) =>
              typeId === 'semantic-action' ? err(404, 'not found') : ok({}),
        });

        const pre =
            await preflightKnowledgeCatalog(models(ACTIONS_DOCS), CTX, OPTS);

        // Preflight returns a failure result without writing any entry.
        expect(pre.prepared).toBeUndefined();
        expect(pre.result?.success).toBe(false);
        expect(pre.result?.details)
            .toBe(
                'Custom type \'semantic-action\' not found in project \'dest\'; ' +
                'run \'kcmd init --semantic-model\' first.');
        expect(getEntryType)
            .toHaveBeenCalledWith('dest', 'global', 'semantic-action');
        expect(getAspectType)
            .toHaveBeenCalledWith('dest', 'global', 'semantic-action');
        expect(create).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
        expect(del).not.toHaveBeenCalled();
        expect(createLink).not.toHaveBeenCalled();
        expect(updateLink).not.toHaveBeenCalled();
        expect(delLink).not.toHaveBeenCalled();
      });

  test(
      'fails preflight before any write when a custom aspect type is missing',
      async () => {
        // Simulate a project where the `semantic-action` entry type exists but
        // its companion aspect type has not been provisioned (404 on
        // getAspectType).
        const {create, update, getEntryType, getAspectType} = stubClient({
          aspectType: (typeId) =>
              typeId === 'semantic-action' ? err(404, 'not found') : ok({}),
        });

        const pre =
            await preflightKnowledgeCatalog(models(ACTIONS_DOCS), CTX, OPTS);

        expect(pre.prepared).toBeUndefined();
        expect(pre.result?.success).toBe(false);
        expect(pre.result?.details)
            .toBe(
                'Custom type \'semantic-action\' not found in project \'dest\'; ' +
                'run \'kcmd init --semantic-model\' first.');
        expect(getEntryType)
            .toHaveBeenCalledWith('dest', 'global', 'semantic-action');
        expect(getAspectType)
            .toHaveBeenCalledWith('dest', 'global', 'semantic-action');
        expect(create).not.toHaveBeenCalled();
        expect(update).not.toHaveBeenCalled();
      });

  test(
      'fails preflight naming the status when getEntryType or getAspectType ' +
          'returns a non-404 error',
      async () => {
        // Only HTTP 404 reports the type as missing ('run kcmd init'); any
        // other non-200 status (e.g. 403 or 500) still fails preflight naming
        // the status and error rather than proceeding to writes.
        const {create} = stubClient({
          entryType: () => err(403, 'permission denied'),
          aspectType: () => ok({}),
        });

        const entryErr =
            await preflightKnowledgeCatalog(models(ACTIONS_DOCS), CTX, OPTS);
        expect(entryErr.prepared).toBeUndefined();
        expect(entryErr.result?.success).toBe(false);
        expect(entryErr.result?.details)
            .toBe(
                'checking entry type \'semantic-action\' (HTTP 403): ' +
                'permission denied');
        expect(create).not.toHaveBeenCalled();

        mock.restore();
        stubClient({
          entryType: () => ok({}),
          aspectType: () => err(500, 'internal error'),
        });

        const aspectErr =
            await preflightKnowledgeCatalog(models(ACTIONS_DOCS), CTX, OPTS);
        expect(aspectErr.prepared).toBeUndefined();
        expect(aspectErr.result?.success).toBe(false);
        expect(aspectErr.result?.details)
            .toBe(
                'checking aspect type \'semantic-action\' (HTTP 500): ' +
                'internal error');
      });

  test(
      'skips getEntryType and getAspectType when no custom types are used, ' +
          'and succeeds when used custom types exist',
      async () => {
        const {getEntryType, getAspectType} = stubClient();

        const pre = await preflightKnowledgeCatalog(models(DOCS), CTX, OPTS);

        expect(pre.result).toBeUndefined();
        expect(pre.prepared).toBeDefined();
        expect(getEntryType).not.toHaveBeenCalled();
        expect(getAspectType).not.toHaveBeenCalled();

        const actionsPre =
            await preflightKnowledgeCatalog(models(ACTIONS_DOCS), CTX, OPTS);
        expect(actionsPre.result).toBeUndefined();
        expect(actionsPre.prepared).toBeDefined();
        expect(getEntryType)
            .toHaveBeenCalledWith('dest', 'global', 'semantic-action');
        expect(getAspectType)
            .toHaveBeenCalledWith('dest', 'global', 'semantic-action');
      });

  test(
      'preflight performs no deletions under --force-remove until apply runs',
      async () => {
        // Stage a foreign model ('old') in the entry group and run preflight
        // with `forceRemove: true`. Preflight must succeed without calling
        // `deleteEntry` or `deleteEntryLink`; only `applyKnowledgeCatalog`
        // performs the deletions and writes.
        const {create, del, delLink} = stubClient({
          existing: [
            {id: 'old', type: MODEL_TYPE},
            {id: 'old.entities.a', type: ENTITY_TYPE},
          ],
        });
        const forceOpts = {...OPTS, forceRemove: true};

        const pre =
            await preflightKnowledgeCatalog(models(DOCS), CTX, forceOpts);

        // Preflight makes zero mutations.
        expect(pre.result).toBeUndefined();
        expect(pre.prepared).toBeDefined();
        expect(create).not.toHaveBeenCalled();
        expect(del).not.toHaveBeenCalled();
        expect(delLink).not.toHaveBeenCalled();

        const applied =
            await applyKnowledgeCatalog(pre.prepared!, CTX, forceOpts);

        // Apply deletes the foreign model and creates the new entries.
        expect(applied.success).toBe(true);
        expect(applied.deleted).toBe(2);
        expect(applied.created).toBe(3);
        expect(del).toHaveBeenCalledTimes(2);
        expect(create).toHaveBeenCalledTimes(3);
      });

  test(
      'apply fails under --force-remove when lookupEntryLinks fails on a ' +
          'foreign model',
      async () => {
        const forceOpts = {...OPTS, forceRemove: true};
        stubClient({
          existing: [
            {id: 'old', type: MODEL_TYPE},
            {id: 'old.entities.a', type: ENTITY_TYPE},
            {id: 'old.entities.b', type: ENTITY_TYPE},
          ],
          links: () => err(500, 'lookup failed'),
        });

        const pre =
            await preflightKnowledgeCatalog(models(DOCS), CTX, forceOpts);
        const applied =
            await applyKnowledgeCatalog(pre.prepared!, CTX, forceOpts);

        expect(applied.success).toBe(false);
        expect(applied.details)
            .toContain(
                'looking up entry links for \'old.entities.a\': lookup failed');
      });

  test(
      'apply fails under --force-remove when deleteEntryLink fails on a ' +
          'foreign model',
      async () => {
        const forceOpts = {...OPTS, forceRemove: true};
        const foreignLink =
            linkEntry('old-a-to-b', ['old.entities.a', 'old.entities.b']);
        stubClient({
          existing: [
            {id: 'old', type: MODEL_TYPE},
            {id: 'old.entities.a', type: ENTITY_TYPE},
            {id: 'old.entities.b', type: ENTITY_TYPE},
          ],
          links: () => ok([foreignLink]),
          delLink: () => err(500, 'delete link failed'),
        });

        const pre =
            await preflightKnowledgeCatalog(models(DOCS), CTX, forceOpts);
        const applied =
            await applyKnowledgeCatalog(pre.prepared!, CTX, forceOpts);

        expect(applied.success).toBe(false);
        expect(applied.details)
            .toContain(
                'deleting entry link \'old-a-to-b\': delete link failed');
      });

  test(
      'apply fails under --force-remove when deleteEntry fails on a ' +
          'foreign model',
      async () => {
        const forceOpts = {...OPTS, forceRemove: true};
        stubClient({
          existing: [
            {id: 'old', type: MODEL_TYPE},
            {id: 'old.entities.a', type: ENTITY_TYPE},
          ],
          del: () => err(500, 'delete entry failed'),
        });

        const pre =
            await preflightKnowledgeCatalog(models(DOCS), CTX, forceOpts);
        const applied =
            await applyKnowledgeCatalog(pre.prepared!, CTX, forceOpts);

        expect(applied.success).toBe(false);
        expect(applied.details).toContain('delete entry failed');
      });

  test(
      'preflight treats a transient entry-group propagation error during ' +
          'listEntries as empty and fails on non-propagation errors',
      async () => {
        stubClient();
        spyOn(CatalogClient.prototype, 'listEntries')
            .mockImplementationOnce(async function*() {
              throw new Error('Entry group eg may not exist');
            })
            .mockImplementationOnce(async function*() {
              throw new Error('backend unavailable');
            });

        const transientPre =
            await preflightKnowledgeCatalog(models(DOCS), CTX, OPTS);
        expect(transientPre.result).toBeUndefined();
        expect(transientPre.prepared?.existing).toEqual([]);

        const fatalPre =
            await preflightKnowledgeCatalog(models(DOCS), CTX, OPTS);
        expect(fatalPre.prepared).toBeUndefined();
        expect(fatalPre.result?.success).toBe(false);
        expect(fatalPre.result?.details)
            .toContain(
                'listing entries in entry group \'eg\': backend unavailable');
      });

  test(
      'retries createEntry on transient entry-group propagation errors and ' +
          'stops on non-propagation 404s',
      async () => {
        let calls = 0;
        const {create} = stubClient({
          create: () => {
            calls++;
            return calls === 1 ? err(404, 'entry group eg not found') : ok({});
          },
        });
        const retryOpts = {
          ...OPTS,
          entryCreateTries: 2,
          entryCreateRetryMs: 0,
        };

        const recovered =
            await deployKnowledgeCatalog(models(DOCS), CTX, retryOpts);
        expect(recovered.success).toBe(true);
        expect(create).toHaveBeenCalledTimes(4);

        mock.restore();
        const {create: createFatal} = stubClient({
          create: () => err(404, 'aspect type not found'),
        });
        const fatal =
            await deployKnowledgeCatalog(models(DOCS), CTX, retryOpts);
        expect(fatal.success).toBe(false);
        expect(createFatal).toHaveBeenCalledTimes(1);
      });

  test(
      'planSummary groups entry links by linkTypeId from the links themselves',
      async () => {
        stubClient();
        const emitted: EmittedModel[] = [{
          model: 'sales',
          resources: {
            entries: [
              {name: entryName('sales'), entryType: MODEL_TYPE},
            ],
            entryLinks: [
              {
                ...linkEntry(
                    'sales-orders-to-customer',
                    ['sales/entities/orders', 'sales/entities/customer']),
                entryLinkType:
                    'projects/dataplex-types/locations/global/entryLinkTypes/' +
                    'semantic-relationship',
              },
              {
                ...linkEntry(
                    'sales-orders-to-lineitem',
                    ['sales/entities/orders', 'sales/entities/lineitem']),
                entryLinkType:
                    'projects/dataplex-types/locations/global/entryLinkTypes/' +
                    'semantic-relationship',
              },
              linkEntry(
                  'sales-legacy-join',
                  ['sales.entities.orders', 'sales.entities.customer']),
            ],
            ownedPrefixes: ['sales/entities/'],
            warnings: [],
          },
        }];

        const result = await deployEmittedModels(
            emitted, [], CTX, {...OPTS, validateOnly: true});

        expect(result.success).toBe(true);
        expect(result.plan.join('\n'))
            .toContain(
                '  2 semantic-relationship links:\n' +
                '    - sales-orders-to-customer\n' +
                '    - sales-orders-to-lineitem\n' +
                '  1 schema-join link:\n' +
                '    - sales-legacy-join');
      });
});
