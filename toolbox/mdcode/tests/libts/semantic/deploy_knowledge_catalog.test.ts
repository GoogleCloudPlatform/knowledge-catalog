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
import {fixProject, ResourceManagerClient} from '../../../src/libts/gcp/crm';
import {CatalogClient} from '../../../src/libts/gcp/dataplex';
import {applyKnowledgeCatalog, deployEmittedModels, deployKnowledgeCatalog, EmittedModel, preflightKnowledgeCatalog,} from '../../../src/libts/semantic/deploy_knowledge_catalog';
import {entryIdOf, semanticLinkId} from '../../../src/libts/semantic/kc_ids';
import {loadSemanticModels} from '../../../src/libts/semantic/loader';

const CTX = new ApiContext('test-project', 'us', 'test-token');
const FIXTURES = path.join(__dirname, 'fixtures');

// A loader-valid model: one entity (orders) + one metric (total_revenue), so a
// push writes exactly three entries (model anchor + entity + metric).
const OSSIE =
    fs.readFileSync(path.join(FIXTURES, 'sales_bq_graph_target.yaml'), 'utf8');
const DOCS = [{name: 'sales.yaml', text: OSSIE}];

// A model with a direct-FK relationship: 6 entries (anchor + 2 entities + 2
// metrics + the relationship) plus 3 entry links (the semantic-link from
// orders to customer and the relationship's 2 reference links). Used to
// exercise the link write path the OSSIE fixture (no relationship) cannot.
const STAR =
    fs.readFileSync(path.join(FIXTURES, 'star_orders_customer.yaml'), 'utf8');
const STAR_DOCS = [{name: 'star.yaml', text: STAR}];

const STAR_SEMANTIC_LINK =
    semanticLinkId('link', 'sales', 'orders', 'customer');
// The reference links from the relationship entry to its two entities.
const STAR_REFERENCES = ['source', 'target'].map(
    end => semanticLinkId('relationship', 'sales', 'orders_to_customer', end));

// A model declaring actions, used to exercise custom-type preflight checks.
const ACTIONS_DOC =
    fs.readFileSync(path.join(FIXTURES, 'actions_executors.yaml'), 'utf8');
const ACTIONS_DOCS = [{name: 'actions.yaml', text: ACTIONS_DOC}];

// The deploy leg now consumes models already parsed by loadSemanticModels
// (shared with the BigQuery leg). These tests author documents, so this helper
// parses them the way commands.ts does.
function models(docs: {name: string; text: string}[]) {
  const r = loadSemanticModels(docs);
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

// entryCreateTries: 1 keeps the propagation-retry loop from sleeping in tests.
const OPTS = {
  project: 'dest',
  location: 'us',
  entryGroup: 'eg',
  entryCreateTries: 1,
};

// The most data Dataplex stores in an aspect other than schema.
const LIMIT = 122_880;

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
const EXISTS = () => err(409, 'already exists');
// The model entry's label during a push and after it.
const WRITING = {'kcmd-push-state': 'writing'};
const FINISHED = {'kcmd-push-state': 'finished'};

// Stubs CatalogClient entry, entry-link, and custom-type operations, returning
// the spies so a test can assert call counts and ordering.
function stubClient(opts: {
  group?: ApiResult<any>,
  // Result of getEntryGroup, the preflight's read of the destination group.
  // Default: 200.
  getGroup?: ApiResult<any>,
  create?: (entryId: string) => ApiResult<any>,
  update?: ApiResult<any>,
  // Entries the destination entry group already holds (yielded by listEntries).
  // A bare id defaults to a generic entryType; pass {id, type} to stage a
  // specific one (e.g. a foreign semantic-model anchor). Default: none.
  existing?: (string |
              {
                id: string;
                type?: string;
                labels?: Record<string, string>;
                source?: Record<string, string>
              })[],
  // How listEntries spells the project in the names it yields. Defaults to the
  // scope's own project; set to a number to reproduce the server's inconsistent
  // id/number spelling.
  existingProject?: string,
  del?: (entryId: string) => ApiResult<any>,
  // Result of createEntryLink, keyed by the entry-link id. Default: 200.
  createLink?: (linkId: string) => ApiResult<any>,
  updateLink?: ApiResult<any>,
  // Result of getEntryLink. Default: 404, no link with that name.
  getLink?: ApiResult<any>,
  // Entry links the destination returns from lookupEntryLinks, keyed by the
  // referenced entry's full resource name. Default: none (ok, empty list).
  links?: (entry: string) => ApiResult<any>,
  // Result of deleteEntryLink, keyed by the entry-link id. Default: 200.
  delLink?: (linkId: string) => ApiResult<any>,
  // Result of getEntry, keyed by entry id. Default: 200 with no entrySource.
  getEntry?: (entryId: string) => ApiResult<any>,
  // Result of getEntryType / getAspectType, keyed by typeId. Default: 200.
  entryType?: (typeId: string) => ApiResult<any>,
  aspectType?: (typeId: string) => ApiResult<any>,
  // Result of Cloud Resource Manager's getProject, keyed by project. Default:
  // project 'dest' has the number 123456789, and any other project is denied.
  project?: (project: string) => ApiResult<any>,
} = {}) {
  const group = spyOn(CatalogClient.prototype, 'createEntryGroup')
                    .mockImplementation(async () => opts.group ?? ok({}));
  const getGroup = spyOn(CatalogClient.prototype, 'getEntryGroup')
                       .mockImplementation(async () => opts.getGroup ?? ok({}));
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
                       const labels =
                           typeof e === 'string' ? undefined : e.labels;
                       const source =
                           typeof e === 'string' ? undefined : e.source;
                       yield {
                         name: entryName(id, opts.existingProject),
                         entryType,
                         ...(labels || source ?
                                 {entrySource: {...source, labels}} :
                                 {}),
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
  const getLink = spyOn(CatalogClient.prototype, 'getEntryLink')
                      .mockImplementation(
                          async () => opts.getLink ?? err(404, 'not found'));
  const lookupLinks =
      spyOn(CatalogClient.prototype, 'lookupEntryLinks')
          .mockImplementation(
              async (_p, _l, o: any) => (opts.links ?? (() => ok([])))(o.entry));
  const delLink = spyOn(CatalogClient.prototype, 'deleteEntryLink')
                      .mockImplementation(
                          async (_p, _l, _eg, linkId) =>
                              (opts.delLink ?? (() => ok({})))(linkId));
  const getEntry = spyOn(CatalogClient.prototype, 'getEntry')
                       .mockImplementation(
                           async (_p, _l, _eg, entryId) =>
                               (opts.getEntry ?? (() => ok({})))(entryId));
  const getEntryType = spyOn(CatalogClient.prototype, 'getEntryType')
                           .mockImplementation(
                               async (_p, _l, typeId) =>
                                   (opts.entryType ?? (() => ok({})))(typeId));
  const getAspectType = spyOn(CatalogClient.prototype, 'getAspectType')
                            .mockImplementation(
                                async (_p, _l, typeId) => (
                                    opts.aspectType ?? (() => ok({})))(typeId));
  const getProject =
      spyOn(ResourceManagerClient.prototype, 'getProject')
          .mockImplementation(
              async (project) => (opts.project ?? destProject)(project));
  return {
    group,
    getGroup,
    create,
    update,
    list,
    del,
    createLink,
    updateLink,
    getLink,
    lookupLinks,
    delLink,
    getEntry,
    getEntryType,
    getAspectType,
    getProject,
  };
}

// Cloud Resource Manager's answer for the scope's project 'dest', whose number
// is 123456789. Any other project is denied.
function destProject(project: string): ApiResult<any> {
  return project === 'dest' ?
      ok({name: 'projects/123456789', projectId: 'dest'}) :
      err(403, 'Permission denied');
}


describe('deployKnowledgeCatalog: happy path', () => {
  test('writes entries anchor-first, provisioning nothing', async () => {
    // The model entry as the push ends, with a label another writer set.
    const held =
        {displayName: 'sales', labels: {owner: 'data-team', ...WRITING}};
    const {group, create, update, getEntry} =
        stubClient({getEntry: () => ok({entrySource: held})});

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.created).toBe(3);
    expect(result.updated).toBe(0);

    // Push provisions neither the entry group nor any type -- both are created
    // at `init` -- so it only writes the three entries.
    expect(group).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledTimes(3);

    // The model anchor is written before its children, labeled as writing.
    expect(create.mock.calls[0][3]).toBe('sales');
    expect(create.mock.calls[0][4]!.entrySource!.labels).toEqual(WRITING);
    // One more write labels it finished. It reads the entry first, sends back
    // what the entry holds then, and names only the entrySource.
    expect(getEntry.mock.calls.map(c => c.slice(3)))
        .toEqual([['sales', undefined, {keepSourceResource: true}]]);
    const finish = update.mock.calls.map(([e, mask]) => [e.entrySource, mask]);
    expect(finish).toEqual([[
      {...held, labels: {owner: 'data-team', ...FINISHED}}, ['entry_source']
    ]]);
  });
});


describe('deployKnowledgeCatalog: re-push upserts', () => {

  test('a failed entry update fails the push, naming the entry', async () => {
    stubClient({
      create: () => err(409, 'entry already exists'),
      update: err(500, 'update boom'),
    });

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(false);
    expect(result.details).toBe('Model \'sales\': entry \'sales\': update boom');
  });
});


// A call whose request cannot be sent, such as when the network is down,
// throws: the API client lets fetch's `TypeError: fetch failed` through.
describe('deployKnowledgeCatalog: a thrown error', () => {
  const fetchFailed = (): never => {
    throw new TypeError('fetch failed');
  };

  test('a write that throws fails the push with its message', async () => {
    stubClient({create: fetchFailed});

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result).toMatchObject({success: false, details: 'fetch failed'});
  });

  test('a delete of another model that throws fails the push before any ' +
           'write',
       async () => {
         const {create} = stubClient({
           existing: [{id: 'old', type: MODEL_TYPE}],
           del: fetchFailed,
         });

         const result = await deployKnowledgeCatalog(
             models(DOCS), CTX, {...OPTS, forceRemove: true});

         expect(result).toMatchObject({success: false, details: 'fetch failed'});
         expect(create).not.toHaveBeenCalled();
       });
});


describe('deployKnowledgeCatalog: other writers\' fields', () => {
  // The entry each update call sent for entry `id`.
  const updated = (update: any, id: string) => update.mock.calls.find(
      (c: any[]) => c[0].name.endsWith(`/entries/${id}`))!;
  const ENTITY = 'sales/entities/orders';
  // Labels another writer set on the model entry and on its orders entity.
  const labeled = () => [
    {id: 'sales', type: MODEL_TYPE, labels: {'owner': 'data-team'}},
    {id: ENTITY, type: ENTITY_TYPE, labels: {'owner': 'data-team'}},
  ];
  const exists = () => err(409, 'entry already exists');

  // The update replaces the whole entrySource, so it carries them over.
  test('a re-push keeps the labels another writer set', async () => {
    const {update} = stubClient({create: exists, existing: labeled()});
    expect((await deployKnowledgeCatalog(models(DOCS), CTX, OPTS)).success)
        .toBe(true);
    const [entry, mask] = updated(update, 'sales');
    expect(entry.entrySource.labels)
        .toEqual({'owner': 'data-team', ...WRITING});
    // The mask names the entrySource, so Dataplex stores the labels.
    expect(mask).toContain('entry_source');
    expect(updated(update, ENTITY)[0].entrySource.labels)
        .toEqual({'owner': 'data-team'});
  });

  test('a re-push keeps the source fields another writer set', async () => {
    const source = {
      resource: '//bigquery.googleapis.com/projects/p/datasets/d/tables/t',
      system: 'other-tool',
      platform: 'gcp',
      createTime: '2026-01-02T03:04:05Z',
      updateTime: '2026-02-03T04:05:06Z',
    };
    // kcmd owns the display name and the description. This model sets no
    // description.
    const listed = {
      ...source,
      displayName: 'renamed in console',
      description: 'set by an earlier push',
    };
    const {create, update} = stubClient({
      create: exists,
      existing: [
        {id: 'sales', type: MODEL_TYPE, source: listed},
        {id: ENTITY, type: ENTITY_TYPE, source: listed},
      ],
    });
    expect((await deployKnowledgeCatalog(models(DOCS), CTX, OPTS)).success)
        .toBe(true);
    // kcmd's own fields come from the entry it emitted.
    const emitted = (id: string): Record<string, any> =>
        create.mock.calls.find((c: any[]) => c[3] === id)![4]!.entrySource!;
    expect(updated(update, 'sales')[0].entrySource)
        .toEqual({...source, ...emitted('sales')});
    expect(emitted('sales')).toEqual({displayName: 'sales', labels: WRITING});
    expect(updated(update, ENTITY)[0].entrySource)
        .toEqual({...source, ...emitted(ENTITY)});
  });

  // A listing the caller may not make comes back empty, and another writer
  // can create an entry after the listing.
  test('an entry the listing lacks is read before its update, and its ' +
           'fields are kept',
       async () => {
         const source = {
           system: 'other-tool',
           labels: {'owner': 'data-team'},
         };
         const {getEntry, update} = stubClient({
           create: exists,
           // A listed entry with no entrySource is not read again.
           existing: [{id: ENTITY, type: ENTITY_TYPE}],
           getEntry: (id) => ok(id === 'sales' ? {entrySource: source} : {}),
         });
         expect((await deployKnowledgeCatalog(models(DOCS), CTX, OPTS)).success)
             .toBe(true);
         expect(updated(update, 'sales')[0].entrySource).toEqual({
           system: 'other-tool',
           displayName: 'sales',
           labels: {'owner': 'data-team', ...WRITING},
         });
         // The read keeps the stored resource as it is.
         const read = getEntry.mock.calls.find((c: any[]) => c[3] === 'sales')!;
         expect(read[5]).toEqual({keepSourceResource: true});
         expect(getEntry.mock.calls.map((c: any[]) => c[3]))
             .not.toContain(ENTITY);

         mock.restore();
         stubClient({create: exists, getEntry: () => err(403, 'denied')});
         const failed = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);
         expect(failed.success).toBe(false);
         expect(failed.details)
             .toContain('entry \'sales\': reading it before the update: ');
       });

  // A relative `projects/<number>` name would otherwise come back with the
  // project id, which push would then write.
  test('push writes a listed resource back as stored, with no project ' +
           'lookup',
       async () => {
         const resource = 'projects/123456789/locations/us/things/t';
         const listed =
             {name: entryName('sales'), entryType: MODEL_TYPE,
              entrySource: {resource}};
         spyOn(CatalogClient.prototype, '_get')
             .mockImplementation(
                 (async (name: string) => name.endsWith('/entries') ?
                      ok({entries: [listed]}) :
                      err(404, 'not found')) as any);
         const lookup =
             spyOn(ResourceManagerClient.prototype, 'getProject')
                 .mockResolvedValue(ok({projectId: 'other-proj'}) as any);
         const {update} = stubClient({create: exists});
         // stubClient replaces listEntries; the real one reads through `_get`.
         (CatalogClient.prototype.listEntries as any).mockRestore();

         expect((await deployKnowledgeCatalog(models(DOCS), CTX, OPTS)).success)
             .toBe(true);
         expect(updated(update, 'sales')[0].entrySource.resource)
             .toBe(resource);
         expect(lookup).not.toHaveBeenCalled();
       });
});


describe('deployKnowledgeCatalog: relationship entry links', () => {

  test('a link that already exists is upserted via updateEntryLink', async () => {
    // Reading the link shows it joins this model's two entities. Its
    // references spell the project with the number and its name with the ID.
    const {createLink, updateLink} = stubClient({
      createLink: starLinkExists(),
      getLink: ok(gotStarLink()),
      updateLink: ok({}),
    });

    const result = await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.linked).toBe(3);
    // Links are written to the same destination the entries are.
    expect(createLink.mock.calls.map(c => c.slice(0, 4)))
        .toEqual([STAR_SEMANTIC_LINK, ...STAR_REFERENCES].map(
            id => ['dest', 'us', 'eg', id]));
    expect(updateLink).toHaveBeenCalledTimes(1);
    // The upsert narrows the patch to the link's aspect keys (semantic-link);
    // UpdateEntryLink has no update mask, so a stale ['aspects'] mask would 400.
    const aspectKeys = updateLink.mock.calls[0][1] ?? [];
    expect(aspectKeys.some((k: string) => k.endsWith('semantic-link'))).toBe(true);
  });

  // The reference link from STAR's relationship to its source entity, as
  // getEntryLink returns it, from when that source was supplier.
  const OLD_SOURCE_LINK = {
    ...directed(
        'reference', STAR_REFERENCES[0],
        'sales/relationships/orders_to_customer', 'sales/entities/supplier'),
    name: linkEntry(STAR_REFERENCES[0], []).name,
  };

  test(
      'a link the lookup did not return whose endpoints changed is deleted ' +
          'and created again',
      async () => {
        // A read by name finds the model's own link under this ID, joining
        // the relationship to supplier. Its references are immutable, so an
        // update would leave the old endpoints.
        let deleted = false;
        const {createLink, delLink, updateLink} = stubClient({
          createLink: (id) => deleted || id !== STAR_REFERENCES[0] ?
              ok({}) :
              err(409, 'entry link already exists'),
          getLink: ok(OLD_SOURCE_LINK),
          delLink: () => {
            deleted = true;
            return ok({});
          },
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(true);
        expect(result.linked).toBe(3);
        expect(result.unlinked).toBe(0);
        expect(delLink.mock.calls.map(c => c[3])).toEqual([
          STAR_REFERENCES[0],
        ]);
        expect(createLink).toHaveBeenCalledTimes(4);
        expect(updateLink).not.toHaveBeenCalled();
      });

  test(
      'when creating that link again fails, the error says to push again',
      async () => {
        let deleted = false;
        stubClient({
          createLink: (id) => id !== STAR_REFERENCES[0] ? ok({}) :
              deleted ? err(500, 'create failed') :
                        err(409, 'entry link already exists'),
          getLink: ok(OLD_SOURCE_LINK),
          delLink: () => {
            deleted = true;
            return ok({});
          },
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.linked).toBe(2);
        expect(result.unlinked).toBe(0);
        expect(result.details)
            .toBe(
                `Model 'sales': entry link '${STAR_REFERENCES[0]}': ` +
                'create failed (push again to restore the link)');
      });

  test(
      'a thrown error creating that link again says to push again',
      async () => {
        let deleted = false;
        stubClient({
          createLink: (id) => {
            if (id !== STAR_REFERENCES[0]) return ok({});
            if (deleted) throw new Error('socket hang up');
            return err(409, 'entry link already exists');
          },
          getLink: ok(OLD_SOURCE_LINK),
          delLink: () => {
            deleted = true;
            return ok({});
          },
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.unlinked).toBe(0);
        expect(result.details)
            .toBe(
                `Model 'sales': entry link '${STAR_REFERENCES[0]}': ` +
                'socket hang up (push again to restore the link)');
      });

  test(
      'a failed update of a link the lookup did not return, whose type and ' +
          'endpoints match, reports the server\'s message',
      async () => {
        // The read showed a link under this ID, so the 403 cannot mean that
        // another link holds the two entries.
        stubClient({
          createLink: starLinkExists(),
          getLink: ok(gotStarLink()),
          updateLink:
              err(403, 'Permission denied on resource (or it may not exist)'),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details)
            .toBe(
                `Model 'sales': entry link '${STAR_SEMANTIC_LINK}': ` +
                'Permission denied on resource (or it may not exist)');
      });

  test(
      'a 404 on reading the link after a 409 on createEntryLink fails the ' +
          'push with the 409\'s text and no update when the lookup finds no ' +
          'link between the two entries',
      async () => {
        // No link holds the ID, so the 409 came from another link on the
        // pair, which is gone by the time push looks it up. This push deleted
        // nothing, so the error has no push-again hint.
        const {createLink, updateLink} = stubClient({
          createLink: starLinkExists(
              'EntryLink already exists, for the given entry reference and ' +
              'link type'),
          getLink: err(404, 'EntryLink does not exist.'),
          updateLink: err(403, 'Permission denied on resource'),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.linked).toBe(2);
        expect(result.details)
            .toBe(
                `Model 'sales': entry link '${STAR_SEMANTIC_LINK}': ` +
                'EntryLink already exists, for the given entry reference and ' +
                'link type');
        expect(createLink).toHaveBeenCalledTimes(3);
        expect(updateLink).not.toHaveBeenCalled();
      });

  test(
      'a 403 or 503 on reading the link after a 409 fails with the read\'s ' +
          'error, and push neither updates nor deletes the link',
      async () => {
        // Push cannot tell whose link holds the ID, or whether its endpoints
        // match.
        for (const read of [
               err(403, 'Permission denied on resource'),
               err(503, 'The service is currently unavailable.'),
             ]) {
          const {updateLink, delLink} = stubClient({
            createLink: () => err(409, 'entry link already exists'),
            getLink: read,
            updateLink: ok({}),
          });

          const result =
              await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

          expect(result.success).toBe(false);
          expect(result.linked).toBe(0);
          expect(result.details)
              .toBe(
                  'Model \'sales\': reading entry link ' +
                  `'${STAR_SEMANTIC_LINK}' failed: ` + read.message);
          expect(updateLink).not.toHaveBeenCalled();
          expect(delLink).not.toHaveBeenCalled();
          mock.restore();
        }
      });

  test(
      'a thrown error reading the link after a 409 names the link and ' +
          'updates nothing',
      async () => {
        const {updateLink} = stubClient({
          createLink: () => err(409, 'entry link already exists'),
        });
        spyOn(CatalogClient.prototype, 'getEntryLink')
            .mockImplementation(async () => {
              throw new Error('socket hang up');
            });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details)
            .toBe(
                `Model 'sales': entry link '${STAR_SEMANTIC_LINK}': ` +
                'socket hang up');
        expect(updateLink).not.toHaveBeenCalled();
      });

  test(
      'a hard failure on updateEntryLink fails the push, naming the link',
      async () => {
        stubClient({
          createLink: starLinkExists(),
          getLink: ok(gotStarLink()),
          updateLink: err(500, 'update link boom'),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details)
            .toContain(`entry link '${STAR_SEMANTIC_LINK}': update link boom`);
      });

  test('a failed link write fails the push, naming the link', async () => {
    stubClient({
      createLink: () => err(500, 'boom'),
    });

    const result = await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

    expect(result.success).toBe(false);
    expect(result.details).toContain(STAR_SEMANTIC_LINK);
  });

  test(
      'a failed link write in a batch of two keeps the partial linked count',
      async () => {
        stubClient({
          createLink: (id) =>
              id === 'sales-orders-to-lineitem' ? err(500, 'boom') : ok({}),
        });
        const emitted: EmittedModel[] = [{
          model: 'sales',
          resources: {
            entries: [
              {name: entryName('sales'), entryType: MODEL_TYPE},
            ],
            entryLinks: [
              linkEntry(
                  'sales-orders-to-customer',
                  ['sales.entities.orders', 'sales.entities.customer']),
              linkEntry(
                  'sales-orders-to-lineitem',
                  ['sales.entities.orders', 'sales.entities.lineitem']),
            ],
            ownedPrefixes: ['sales.entities.'],
            warnings: [],
          },
        }];

        const result = await deployEmittedModels(emitted, [], CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.created).toBe(1);
        expect(result.linked).toBe(1);
        expect(result.details)
            .toBe(
                'Model \'sales\': entry link \'sales-orders-to-lineitem\': ' +
                'boom');
      });

  test(
      'a thrown network error on a link write waits for other links in ' +
          'the batch and names the link',
      async () => {
        stubClient({
          createLink: (id) => {
            if (id === 'sales-orders-to-lineitem') {
              throw new Error('socket hang up');
            }
            return ok({});
          },
        });
        const emitted: EmittedModel[] = [{
          model: 'sales',
          resources: {
            entries: [
              {name: entryName('sales'), entryType: MODEL_TYPE},
            ],
            entryLinks: [
              linkEntry(
                  'sales-orders-to-customer',
                  ['sales.entities.orders', 'sales.entities.customer']),
              linkEntry(
                  'sales-orders-to-lineitem',
                  ['sales.entities.orders', 'sales.entities.lineitem']),
            ],
            ownedPrefixes: ['sales.entities.'],
            warnings: [],
          },
        }];

        const result = await deployEmittedModels(emitted, [], CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.created).toBe(1);
        expect(result.linked).toBe(1);
        expect(result.details)
            .toBe(
                'Model \'sales\': entry link \'sales-orders-to-lineitem\': ' +
                'socket hang up');
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
  test('an entry group that does not exist stops the push before any write',
       async () => {
         const {getGroup, list, create} =
             stubClient({getGroup: err(404, 'not found')});

         const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

         expect(result.details)
             .toBe(
                 "entry group 'eg' does not exist in location 'us' of " +
                 "project 'dest'; run 'kcmd init --semantic-model " +
                 "dest.us.eg' to create it, or correct the scope in " +
                 'catalog.yaml.');
         expect(getGroup).toHaveBeenCalledWith('dest', 'us', 'eg');
         expect(list).not.toHaveBeenCalled();
         expect(create).not.toHaveBeenCalled();
       });

  test('a refused read of the entry group lets the push go on', async () => {
    stubClient({getGroup: err(403, 'denied')});

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
  });

  test('a read of the entry group that throws stops the push', async () => {
    const {getGroup, list} = stubClient();
    getGroup.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.details).toBe("reading entry group 'eg': fetch failed");
    expect(list).not.toHaveBeenCalled();
  });

  test('a failed anchor write stops before its children', async () => {
    const {create} = stubClient({
      create: (id) => id === 'sales' ? err(500, 'boom') : ok({}),
    });

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(false);
    expect(create).toHaveBeenCalledTimes(1);  // anchor only; children skipped
  });

  test(
      'a failed child entry write in a batch of three keeps partial created ' +
          'and updated counts',
      async () => {
        // `STAR_DOCS` writes the anchor (`sales`) first, then the two
        // independent entity entries (`sales/entities/orders` and
        // `sales/entities/customer`) and its relationship entry concurrently
        // in one batch. Let the anchor be updated in place (409 -> 200), the
        // first entity and the relationship be created (200), and the second
        // entity fail (500).
        const {create, update} = stubClient({
          create: (id) => {
            if (id === 'sales') return err(409, 'already exists');
            if (id === 'sales/entities/customer') return err(500, 'boom');
            return ok({});
          },
          update: ok({}),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.created).toBe(2);  // orders and the relationship
        expect(result.updated).toBe(1);  // sales (anchor)
        expect(result.details)
            .toBe('Model \'sales\': entry \'sales/entities/customer\': boom');
        expect(create).toHaveBeenCalledTimes(4);  // dependent metrics skipped
        expect(update).toHaveBeenCalledTimes(1);
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
  // entity 'sales/entities/orders', and the metric 'sales/metrics/total_revenue'.
  const EMITTED = ['sales', 'sales/entities/orders', 'sales/metrics/total_revenue'];

  test('deletes entities/metrics/actions removed from the model, scoped by owner',
       async () => {
    // The group also holds three orphans owned by the 'sales' anchor (an
    // entity, a metric and an action no longer in the model) plus two entries
    // owned by a different model. Only the three orphans under 'sales' must be
    // deleted.
    const {del, list} = stubClient({
      existing: [
        ...EMITTED,
        'sales/entities/removed',
        'sales/metrics/removed',
        'sales.actions.Removed',
        'other',
        'other/entities/x',
      ],
    });

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(3);
    expect(list).toHaveBeenCalledTimes(1);
    const deletedIds = del.mock.calls.map(c => c[3]).sort();
    expect(deletedIds).toEqual([
      'sales.actions.Removed',
      'sales/entities/removed',
      'sales/metrics/removed',
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
      existing: [...EMITTED, 'sales/metrics/removed'],
      existingProject: '123456789',
    });

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(1);
    expect(del.mock.calls.map(c => c[3])).toEqual(['sales/metrics/removed']);
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

  test(
      'an emitter that produced no entries deletes nothing even with ' +
          'non-empty ownedPrefixes',
      async () => {
        const {del, lookupLinks, delLink} = stubClient({
          existing: [
            {id: 'sales.entities.orders', type: ENTITY_TYPE},
            {id: 'sales.metrics.total_revenue', type: METRIC_TYPE},
          ],
        });

        const result = await deployEmittedModels(
            [{
              model: 'sales',
              resources: {
                entries: [],
                entryLinks: [],
                warnings: [],
                ownedPrefixes: ['sales.entities.', 'sales.metrics.'],
              },
            }],
            [], CTX, OPTS);

        expect(result.success).toBe(true);
        expect(lookupLinks).not.toHaveBeenCalled();
        expect(delLink).not.toHaveBeenCalled();
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
      existing: [...EMITTED, 'sales/entities/removed'],
      del: () => err(404, 'not found'),
    });

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(true);
    expect(result.deleted).toBe(1);
    expect(del).toHaveBeenCalledTimes(1);
  });

  test(
      'a failed delete fails the push, naming the orphaned entry and model ' +
          'while keeping partial counts',
      async () => {
        const {del} = stubClient({
          existing: [
            ...EMITTED,
            'sales/entities/removed',
            'sales/metrics/removed',
          ],
          del: (id) =>
              id === 'sales/metrics/removed' ? err(500, 'boom') : ok({}),
        });

        const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.created).toBe(3);
        expect(result.deleted).toBe(1);
        expect(result.details)
            .toBe(
                'Deleting orphaned entry \'sales/metrics/removed\' from model ' +
                '\'sales\' failed: boom');
        expect(del).toHaveBeenCalledTimes(2);
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
const RELATIONSHIP_TYPE =
    'projects/dataplex-types/locations/global/entryTypes/semantic-relationship';
const SEMANTIC_LINK_TYPE =
    'projects/dataplex-types/locations/global/entryLinkTypes/semantic-link';
const FILE_TYPE =
    'projects/dest/locations/global/entryTypes/semantic-model-file';

// A schema-join entry link, the kind an older kcmd wrote, as lookupEntryLinks
// returns it: `refIds` are the two endpoint entry ids (undirected, both
// UNSPECIFIED).
function linkEntry(id: string, refIds: string[], project = 'dest'): any {
  return {
    name: `projects/${project}/locations/us/entryGroups/eg/entryLinks/${id}`,
    entryLinkType:
        'projects/dataplex-types/locations/global/entryLinkTypes/schema-join',
    entryReferences: refIds.map(
        r => ({
          name: `projects/${project}/locations/us/entryGroups/eg/entries/${r}`,
          type: 'UNSPECIFIED',
        })),
  };
}

// STAR's entries as a second-generation push writes them.
const V2_ENTRIES = [
  {id: 'sales', type: MODEL_TYPE},
  {id: 'sales/entities/orders', type: ENTITY_TYPE},
  {id: 'sales/entities/customer', type: ENTITY_TYPE},
  {id: 'sales/metrics/total_revenue', type: METRIC_TYPE},
  {id: 'sales/metrics/order_count', type: METRIC_TYPE},
  {id: 'sales/relationships/orders_to_customer', type: RELATIONSHIP_TYPE},
];
// A link of type `type` from entry `from` to entry `to`, as
// lookupEntryLinks returns it with the project number `project`.
function directed(
    type: string, id: string, from: string, to: string, project = '123456789') {
  const ref = (entry: string, type: string) =>
      ({name: entryName(entry, project), type});
  return {
    ...linkEntry(id, [], project),
    entryLinkType: `projects/dataplex-types/locations/global/entryLinkTypes/${
        type}`,
    entryReferences: [ref(from, 'SOURCE'), ref(to, 'TARGET')],
  };
}
// A semantic-link from entity `from` to entity `to`.
const semanticLink = (id: string, from: string, to: string) => directed(
    'semantic-link', id, `sales/entities/${from}`, `sales/entities/${to}`);
// The reference links from relationship `rel` to entities `from` and `to`.
const references = (rel: string, from: string, to: string) =>
    [['source', from], ['target', to]].map(
        ([end, entity]) => directed(
            'reference', semanticLinkId('relationship', 'sales', rel, end),
            `sales/relationships/${rel}`, `sales/entities/${entity}`));
// lookupEntryLinks' answer when the catalog holds `links`: the ones that
// reference the looked-up entry.
const linksTo = (...links: any[]) => (entry: string) => ok(links.filter(
    l => l.entryReferences.some(
        (r: any) => entryIdOf(r.name) === entryIdOf(entry))));
// STAR's link from orders to customer, and a link from customer to orders.
const STAR_LINK = semanticLink(STAR_SEMANTIC_LINK, 'orders', 'customer');
const BACK_ID = semanticLinkId('link', 'sales', 'customer', 'orders');
const BACK_LINK = semanticLink(BACK_ID, 'customer', 'orders');
// The ID of a link from orders to supplier, an entity STAR does not have.
const SUPPLIER_ID = semanticLinkId('link', 'sales', 'orders', 'supplier');
// lookupEntryLinks' answer when the catalog holds the links a push of STAR
// writes: STAR_LINK and the reference links from its relationship.
const STAR_LINKS = linksTo(
    STAR_LINK, ...references('orders_to_customer', 'orders', 'customer'));

// STAR_LINK as getEntryLink returns it: Dataplex spells the name as push
// requested it, with the scope's project 'dest'. A new object on each call.
function gotStarLink(): any {
  return {
    ...semanticLink(STAR_SEMANTIC_LINK, 'orders', 'customer'),
    name: linkEntry(STAR_SEMANTIC_LINK, []).name,
  };
}

// createLink's answer when, of the links STAR emits, the catalog holds only
// STAR_LINK: 409 with `message` for it, and 200 for the reference links.
const starLinkExists = (message = 'entry link already exists') =>
    (id: string) => id === STAR_SEMANTIC_LINK ? err(409, message) : ok({});


describe('deployKnowledgeCatalog: link reconciliation', () => {
  // STAR's entity entries as an older kcmd named them, which the destination
  // still holds. The deploy pipeline looks up links via these server-known
  // entities, so they must be in the pre-write listing for a link to be
  // discoverable.
  const STAR_ENTITIES = [
    {id: 'sales.entities.orders', type: ENTITY_TYPE},
    {id: 'sales.entities.customer', type: ENTITY_TYPE},
  ];

  test(
      'a failed orphan delete after another orphan\'s delete freed the ' +
          'pair says to push again',
      async () => {
        // BACK_LINK, from customer to orders, joins the two entities
        // STAR_LINK joins.
        const dropped = semanticLink(SUPPLIER_ID, 'orders', 'supplier');
        const {createLink} = stubClient({
          existing: V2_ENTRIES,
          links: () => ok([BACK_LINK, dropped]),
          delLink: (id) => id === SUPPLIER_ID ?
              err(500, 'delete failed') :
              ok({}),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details)
            .toBe(
                `Deleting orphaned entry link '${SUPPLIER_ID}' ` +
                'from model \'sales\' failed: delete failed (push again to ' +
                'restore the link)');
        expect(createLink).not.toHaveBeenCalled();
      });

  test(
      'a failed delete of a link that still joins the pair has no push-again ' +
          'hint',
      async () => {
        // BACK_LINK still joins the two entities STAR_LINK joins, so nothing
        // is missing.
        const {createLink} = stubClient({
          existing: V2_ENTRIES,
          links: linksTo(BACK_LINK),
          delLink: () => err(500, 'delete failed'),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details)
            .toBe(
                `Deleting orphaned entry link '${BACK_ID}' from model ` +
                '\'sales\' failed: delete failed');
        expect(createLink).not.toHaveBeenCalled();
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

  test(
      'never deletes a link to an entry with one of the model\'s IDs in ' +
          'another entry group or project',
      async () => {
        // Both links are stored in this entry group, so the lookup returns
        // them. Each is a semantic-link from `orders` under the ID push gives
        // such a link, to an entry with one of the model's IDs in another
        // entry group or project.
        const otherGroup = semanticLink(SUPPLIER_ID, 'orders', 'supplier');
        otherGroup.entryReferences[1].name =
            'projects/123456789/locations/us/entryGroups/other-eg/entries/' +
            'sales/entities/supplier';
        const otherProject = semanticLink(
            semanticLinkId('link', 'sales', 'orders', 'warehouse'), 'orders',
            'warehouse');
        otherProject.entryReferences[1].name =
            entryName('sales/entities/warehouse', '987654321');
        const {delLink} = stubClient({
          existing: V2_ENTRIES,
          links: linksTo(otherGroup, otherProject, STAR_LINK),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(true);
        expect(result.unlinked).toBe(0);
        expect(delLink).not.toHaveBeenCalled();
      });

  test(
      'a thrown read of a new link ID before a link delete names the model ' +
          'and the link, and deletes nothing',
      async () => {
        const renamedFrom =
            references('old_orders_to_customer', 'orders', 'customer');
        const {delLink} = stubClient({
          existing: V2_ENTRIES,
          links: () => ok([STAR_LINK, ...renamedFrom]),
        });
        spyOn(CatalogClient.prototype, 'getEntryLink')
            .mockImplementation(async () => {
              throw new Error('socket hang up');
            });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details)
            .toBe(
                `Model 'sales': entry link '${STAR_REFERENCES[0]}': ` +
                'socket hang up');
        expect(delLink).not.toHaveBeenCalled();
      });

  test(
      'a failed read of a new link ID before a link delete gives the read\'s ' +
          'error without saying the link exists, and deletes nothing',
      async () => {
        // No create has run, so nothing shows that a link holds the ID.
        const renamedFrom =
            references('old_orders_to_customer', 'orders', 'customer');
        const {createLink, delLink} = stubClient({
          existing: V2_ENTRIES,
          links: () => ok([STAR_LINK, ...renamedFrom]),
          getLink: err(503, 'backend unavailable'),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details)
            .toBe(
                'Model \'sales\': reading entry link ' +
                `'${STAR_REFERENCES[0]}' failed: backend unavailable`);
        expect(delLink).not.toHaveBeenCalled();
        expect(createLink).not.toHaveBeenCalled();
      });

  test(
      'a 404 on an orphaned link delete is tolerated (already gone) and ' +
          'counts as unlinked',
      async () => {
        const orphan = linkEntry(
            'sales-orders-to-supplier',
            ['sales.entities.orders', 'sales.entities.supplier']);
        const {delLink} = stubClient({
          existing: STAR_ENTITIES,
          links: (entry: string) =>
              entry.endsWith('sales.entities.orders') ? ok([orphan]) : ok([]),
          delLink: () => err(404, 'already gone'),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(true);
        expect(result.unlinked).toBe(1);
        expect(delLink).toHaveBeenCalledTimes(1);
        expect(delLink.mock.calls[0][3]).toBe('sales-orders-to-supplier');
      });

  test(
      'a failed link delete fails the push, naming the orphaned entry link ' +
          'and model while keeping partial counts',
      async () => {
        const warehouseId =
            semanticLinkId('link', 'sales', 'orders', 'warehouse');
        const orphanA = semanticLink(SUPPLIER_ID, 'orders', 'supplier');
        const orphanB = semanticLink(warehouseId, 'orders', 'warehouse');
        const {createLink, delLink} = stubClient({
          existing: V2_ENTRIES,
          links: (entry: string) => entry.endsWith('sales/entities/orders') ?
              ok([orphanA, orphanB]) :
              ok([]),
          delLink: (id) => id === warehouseId ? err(500, 'boom') : ok({}),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.created).toBe(6);
        expect(result.linked).toBe(0);
        expect(result.unlinked).toBe(1);
        expect(result.details)
            .toBe(
                `Deleting orphaned entry link '${warehouseId}' ` +
                'from model \'sales\' failed: boom');
        expect(delLink).toHaveBeenCalledTimes(2);
        expect(createLink).not.toHaveBeenCalled();
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
       // The foreign model's 4 entries (anchor first, then its children) and
       // its 1 link are removed...
       expect(result.deleted).toBe(4);
       expect(result.unlinked).toBe(1);
       expect(delLink.mock.calls.map(c => c[3])).toEqual(['old-a-to-b']);
       expect(del.mock.calls.map(c => c[3])).toEqual([
         'old', 'old.entities.a', 'old.entities.b', 'old.metrics.m'
       ]);
       // ...and the current model is still written (3 entries).
       expect(create).toHaveBeenCalledTimes(3);
     });

  test('--force-remove asks Resource Manager for the project number once',
       async () => {
         // Both the removed model's links and this model's link are spelled
         // with the project number 777. The project is one no other test
         // uses, so the module's number cache cannot answer.
         const project = 'once-proj';
         const oldLink = linkEntry(
             'old-a-to-b', ['old.entities.a', 'old.entities.b'], '777');
         const own = directed(
             'semantic-link', STAR_SEMANTIC_LINK, 'sales/entities/orders',
             'sales/entities/customer', '777');
         const {getProject} = stubClient({
           existing: [
             {id: 'old', type: MODEL_TYPE},
             {id: 'old.entities.a', type: ENTITY_TYPE},
             {id: 'old.entities.b', type: ENTITY_TYPE},
             {id: 'sales', type: MODEL_TYPE},
             {id: 'sales/entities/orders', type: ENTITY_TYPE},
             {id: 'sales/entities/customer', type: ENTITY_TYPE},
           ],
           existingProject: project,
           links: (entry: string) =>
               entry.includes('old.entities.') ? ok([oldLink]) : ok([own]),
           createLink: starLinkExists('already exists'),
           project: (p) => p === project ?
               ok({name: 'projects/777', projectId: p}) :
               err(403, 'denied'),
         });

         const result = await deployKnowledgeCatalog(
             models(STAR_DOCS), CTX, {...OPTS, project, forceRemove: true});

         expect(result.success).toBe(true);
         expect(result.unlinked).toBe(1);
         expect(getProject).toHaveBeenCalledTimes(1);
       });

  // Dataplex deletes the anchor's children, and their links, with it. A push
  // that stops after the anchor delete then leaves nothing of the old model,
  // and the deletes after it get 404.
  test('--force-remove deletes the omitted model\'s anchor first, then its ' +
           'links and children',
       async () => {
         const order: string[] = [];
         const link =
             linkEntry('old-a-to-b', ['old.entities.a', 'old.entities.b']);
         const {create} = stubClient({
           existing: [
             {id: 'old.entities.a', type: ENTITY_TYPE},
             {id: 'old', type: MODEL_TYPE},
             {id: 'old.entities.b', type: ENTITY_TYPE},
             {id: 'old.files.old.yaml', type: FILE_TYPE},
           ],
           links: (entry: string) => {
             order.push(`lookup ${entry.split('/').pop()}`);
             return entry.endsWith('old.entities.a') ? ok([link]) : ok([]);
           },
           del: (id) => {
             order.push(id);
             return id === 'old' ? ok({}) : err(404, 'not found');
           },
           delLink: (id) => {
             order.push(id);
             return err(404, 'not found');
           },
         });

         const result = await deployKnowledgeCatalog(
             models(DOCS), CTX, {...OPTS, forceRemove: true});

         expect(result.success).toBe(true);
         expect(order).toEqual([
           'lookup old.entities.a', 'lookup old.entities.b', 'old',
           'old-a-to-b', 'old.entities.a', 'old.entities.b',
           'old.files.old.yaml'
         ]);
         expect(result.deleted).toBe(4);
         expect(result.unlinked).toBe(1);
         expect(create).toHaveBeenCalledTimes(3);
       });

  // Nothing else of the model is deleted either, so the catalog still holds
  // the whole model.
  test('--force-remove deletes nothing else when deleting the omitted ' +
           'model\'s anchor fails',
       async () => {
         const {del, delLink, create} = stubClient({
           existing: [
             {id: 'old', type: MODEL_TYPE},
             {id: 'old.entities.a', type: ENTITY_TYPE},
             {id: 'old.files.old.yaml', type: FILE_TYPE},
           ],
           del: (entryId) =>
               entryId === 'old' ? err(500, 'delete boom') : ok({}),
         });

         const result = await deployKnowledgeCatalog(
             models(DOCS), CTX, {...OPTS, forceRemove: true});

         expect(result.success).toBe(false);
         expect(result.details)
             .toBe(
                 'Deleting entry \'old\' from removed model \'old\' failed: ' +
                 'delete boom');
         expect(del.mock.calls.map(c => c[3])).toEqual(['old']);
         expect(delLink).not.toHaveBeenCalled();
         expect(create).not.toHaveBeenCalled();
       });

  test(
      '--force-remove does not call deleteEntryLink on a non-relationship ' +
          'link',
      async () => {
        const orphanRelLink =
            linkEntry('old-a-to-b', ['old.entities.a', 'old.entities.b']);
        const synonymLink = {
          ...linkEntry('old-synonym', ['old.entities.a', 'old.entities.b']),
          entryLinkType:
              'projects/dataplex-types/locations/global/entryLinkTypes/synonym',
        };
        const {delLink} = stubClient({
          existing: [
            {id: 'old', type: MODEL_TYPE},
            {id: 'old.entities.a', type: ENTITY_TYPE},
            {id: 'old.entities.b', type: ENTITY_TYPE},
          ],
          links: (entry: string) => entry.endsWith('old.entities.a') ?
              ok([orphanRelLink, synonymLink]) :
              ok([]),
        });

        const result = await deployKnowledgeCatalog(
            models(DOCS), CTX, {...OPTS, forceRemove: true});

        expect(result.success).toBe(true);
        expect(result.unlinked).toBe(1);
        expect(delLink.mock.calls.map(c => c[3])).toEqual(['old-a-to-b']);
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
           {id: 'sales/entities/orders', type: ENTITY_TYPE},
           {id: 'sales/metrics/total_revenue', type: METRIC_TYPE},
         ],
       });

       const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

       expect(result.success).toBe(true);
       expect(result.deleted).toBe(0);
       expect(del).not.toHaveBeenCalled();
     });
});


describe('deployKnowledgeCatalog: old file copies on a re-push', () => {
  // An older kcmd stored copies under the model's `.files.` prefix, so the
  // model owns them and a push, which stores none, deletes them. A copy is
  // not an entity, so no link lookup goes through it.
  test('deletes every old copy and looks up links only through entities',
       async () => {
         const {del, lookupLinks, delLink} = stubClient({
           existing: [
             {id: 'sales', type: MODEL_TYPE},
             {id: 'sales/entities/orders', type: ENTITY_TYPE},
             {id: 'sales/entities/customer', type: ENTITY_TYPE},
             {id: 'sales.files.star.yaml', type: FILE_TYPE},
             {id: 'sales.files.star.profile.prod.yaml', type: FILE_TYPE},
           ],
           links: () => ok([STAR_LINK]),
         });

         const result =
             await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

         expect(result.success).toBe(true);
         expect(lookupLinks.mock.calls.map(c => (c[2] as any).entry).sort())
             .toEqual([
               entryName('sales/entities/customer'),
               entryName('sales/entities/orders'),
             ]);
         expect(delLink).not.toHaveBeenCalled();
         expect(del.mock.calls.map(c => c[3]).sort()).toEqual([
           'sales.files.star.profile.prod.yaml',
           'sales.files.star.yaml',
         ]);
         expect(result.deleted).toBe(2);
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
        // Only the custom type the model uses is looked up.
        for (const spy of [getEntryType, getAspectType]) {
          expect(spy.mock.calls.map(c => c[2])).toEqual(['semantic-action']);
        }
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
            .toBe(
                'Looking up entry links for \'old.entities.a\' from removed ' +
                'model \'old\' failed: lookup failed');
      });

  test(
      'apply fails under --force-remove when deleteEntryLink fails on a ' +
          'foreign model',
      async () => {
        const forceOpts = {...OPTS, forceRemove: true};
        const foreignLinkA =
            linkEntry('old-a-to-b', ['old.entities.a', 'old.entities.b']);
        const foreignLinkB =
            linkEntry('old-a-to-c', ['old.entities.a', 'old.entities.c']);
        stubClient({
          existing: [
            {id: 'old', type: MODEL_TYPE},
            {id: 'old.entities.a', type: ENTITY_TYPE},
            {id: 'old.entities.b', type: ENTITY_TYPE},
            {id: 'old.entities.c', type: ENTITY_TYPE},
          ],
          links: () => ok([foreignLinkA, foreignLinkB]),
          delLink: (id) =>
              id === 'old-a-to-c' ? err(500, 'delete link failed') : ok({}),
        });

        const pre =
            await preflightKnowledgeCatalog(models(DOCS), CTX, forceOpts);
        const applied =
            await applyKnowledgeCatalog(pre.prepared!, CTX, forceOpts);

        expect(applied.success).toBe(false);
        expect(applied.unlinked).toBe(1);
        expect(applied.details)
            .toBe(
                'Deleting entry link \'old-a-to-c\' from removed model ' +
                '\'old\' failed: delete link failed');
      });

  test(
      'apply fails under --force-remove when deleteEntry fails on a ' +
          'foreign model\'s child, after deleting its anchor',
      async () => {
        const forceOpts = {...OPTS, forceRemove: true};
        const {del} = stubClient({
          existing: [
            {id: 'old', type: MODEL_TYPE},
            {id: 'old.entities.a', type: ENTITY_TYPE},
            {id: 'old.entities.b', type: ENTITY_TYPE},
          ],
          del: (id) => id === 'old.entities.b' ?
              err(500, 'delete entry failed') :
              ok({}),
        });

        const pre =
            await preflightKnowledgeCatalog(models(DOCS), CTX, forceOpts);
        const applied =
            await applyKnowledgeCatalog(pre.prepared!, CTX, forceOpts);

        expect(applied.success).toBe(false);
        expect(applied.deleted).toBe(2);
        expect(del.mock.calls.map(c => c[3])).toEqual([
          'old',
          'old.entities.a',
          'old.entities.b',
        ]);
        expect(applied.details)
            .toBe(
                'Deleting entry \'old.entities.b\' from removed model ' +
                '\'old\' failed: delete entry failed');
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


describe('deployKnowledgeCatalog: aspect removal on update', () => {
  test(
      'updating model, entity, metric, and action entries passes the ' +
          'exact aspectKeys list and deleteMissingAspects: true',
      async () => {
        // Force every `createEntry` call to return 409 ALREADY_EXISTS so
        // `writeEntry` falls back to `updateEntry`.
        const events: string[] = [];
        const {create, update} = stubClient({
          create: (id) =>
              (events.push(`create:${id}`), err(409, 'already exists')),
          update: ok({}),
        });

        const salesResult =
            await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);
        // The fourth update labels the model entry finished.
        expect(salesResult)
            .toMatchObject({success: true, created: 0, updated: 3});
        expect(create).toHaveBeenCalledTimes(3);
        expect(update).toHaveBeenCalledTimes(4);

        events.length = 0;
        const actionsResult = await deployKnowledgeCatalog(
            models(ACTIONS_DOCS), CTX,
            {...OPTS, onWarnings: (warnings) => events.push(...warnings)});

        expect(actionsResult.success).toBe(true);
        // The emitter's warning reaches onWarnings before the first write.
        expect(events.slice(0, 2)).toEqual([
          '[commerce] model \'commerce\': 4 action(s) published as ' +
              'semantic-action entries (Knowledge Catalog is the only ' +
              'system an action reaches).',
          'create:commerce',
        ]);

        const modelUpdateCall = update.mock.calls.find(
            c => (c[0].name as string).endsWith('/entries/sales'));
        const entityUpdateCall = update.mock.calls.find(
            c => (c[0].name as string).endsWith('sales/entities/orders'));
        const metricUpdateCall = update.mock.calls.find(
            c => (c[0].name as string).endsWith('sales/metrics/total_revenue'));
        const actionUpdateCall = update.mock.calls.find(
            c =>
                (c[0].name as string).endsWith('commerce.actions.RefundOrder'));

        expect(modelUpdateCall).toBeDefined();
        expect(entityUpdateCall).toBeDefined();
        expect(metricUpdateCall).toBeDefined();
        expect(actionUpdateCall).toBeDefined();

        expect(modelUpdateCall![2]).toEqual([
          'dataplex-types.global.semantic-model',
          'dataplex-types.global.guidelines',
          'dataplex-types.global.semantic-extensions',
          'dataplex-types.global.overview',
        ]);
        expect(modelUpdateCall![3]).toBe(true);

        expect(entityUpdateCall![2]).toEqual([
          'dataplex-types.global.semantic-entity',
          'dataplex-types.global.schema',
          'dataplex-types.global.sql-expressions',
          'dataplex-types.global.guidelines',
          'dataplex-types.global.semantic-extensions',
          'dataplex-types.global.overview',
          'dataplex-types.global.guidelines@*',
          'dataplex-types.global.semantic-extensions@*',
          'dataplex-types.global.overview@*',
        ]);
        expect(entityUpdateCall![3]).toBe(true);

        expect(metricUpdateCall![2]).toEqual([
          'dataplex-types.global.semantic-metric',
          'dataplex-types.global.sql-expressions',
          'dataplex-types.global.guidelines',
          'dataplex-types.global.semantic-extensions',
          'dataplex-types.global.overview',
        ]);
        expect(metricUpdateCall![3]).toBe(true);

        expect(actionUpdateCall![2]).toEqual([
          'dest.global.semantic-action',
          'dataplex-types.global.guidelines',
        ]);
        expect(actionUpdateCall![3]).toBe(true);
      });
});


describe(
    'deployKnowledgeCatalog: link recreation when references change',
    () => {
      // STAR's relationship orders_to_customer once ran from supplier, which
      // the model no longer has. The previous push left supplier's entry, the
      // semantic-link from supplier to customer and the relationship's
      // reference links. The source one, under the ID push still emits, points
      // at supplier.
      const FROM_SUPPLIER =
          semanticLinkId('link', 'sales', 'supplier', 'customer');
      const SOURCE_LINKS = [
        semanticLink(FROM_SUPPLIER, 'supplier', 'customer'),
        ...references('orders_to_customer', 'supplier', 'customer'),
      ];
      const SOURCE_MOVED = {
        existing: [
          ...V2_ENTRIES, {id: 'sales/entities/supplier', type: ENTITY_TYPE},
        ],
        links: linksTo(...SOURCE_LINKS),
        // The target reference link still exists.
        createLink: (id: string) =>
            id === STAR_REFERENCES[1] ? EXISTS() : ok({}),
      };

      test(
          'a relationship that keeps its name and changes an endpoint has ' +
              'its link deleted and created again',
          async () => {
            // The lookup through supplier's entry finds the source reference
            // link, with the project spelled by number ('123456789').
            const callOrder: string[] = [];
            const {createLink, updateLink} = stubClient({
              ...SOURCE_MOVED,
              createLink: (id) => {
                callOrder.push(`createLink:${id}`);
                return SOURCE_MOVED.createLink(id);
              },
              delLink: (id) => {
                callOrder.push(`delLink:${id}`);
                return ok({});
              },
              del: (id) => {
                callOrder.push(`delEntry:${id}`);
                return ok({});
              },
            });

            const result =
                await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

            expect(result.success).toBe(true);
            expect(result.linked).toBe(2);
            expect(result.unchangedLinks).toBe(1);
            expect(result.unlinked).toBe(1);
            const source =
                createLink.mock.calls.find(c => c[3] === STAR_REFERENCES[0])!;
            expect((source[4] as any).entryReferences.map((r: any) => r.name))
                .toEqual([
                  entryName('sales/relationships/orders_to_customer'),
                  entryName('sales/entities/orders'),
                ]);
            // Both old links are deleted before any link is written, and
            // supplier's entry last.
            expect(callOrder).toEqual([
              `delLink:${FROM_SUPPLIER}`,
              `delLink:${STAR_REFERENCES[0]}`,
              `createLink:${STAR_SEMANTIC_LINK}`,
              `createLink:${STAR_REFERENCES[0]}`,
              'delEntry:sales/entities/supplier',
            ]);
            // The lookup returned the target reference link with the same
            // ends, and it has no aspect, so push sends no request for it.
            expect(updateLink).not.toHaveBeenCalled();
          });

      test(
          'a link that lookupEntryLinks does not return is updated in place',
          async () => {
            const {createLink, updateLink, delLink} = stubClient({
              existing: [
                {id: 'sales', type: MODEL_TYPE},
                {id: 'sales/entities/orders', type: ENTITY_TYPE},
                {id: 'sales/entities/customer', type: ENTITY_TYPE},
              ],
              links: () => ok([]),
              createLink: starLinkExists('already exists'),
              getLink: ok(gotStarLink()),
              updateLink: ok({}),
            });

            const result =
                await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

            expect(result.success).toBe(true);
            expect(result.linked).toBe(3);
            expect(createLink).toHaveBeenCalledTimes(3);
            expect(updateLink).toHaveBeenCalledTimes(1);
            expect(delLink).not.toHaveBeenCalled();
          });

      test(
          'a 403 on updating a link the lookup returned reports the ' +
              'server\'s message and does not blame another link',
          async () => {
            // Dataplex also answers 403 to a caller that may not update the
            // link. The lookup shows the link exists, so no other link is
            // involved.
            stubClient({
              existing: V2_ENTRIES,
              links: () => ok([
                STAR_LINK,
                ...references('orders_to_customer', 'orders', 'customer'),
              ]),
              createLink: EXISTS,
              updateLink:
                  err(403, 'Permission denied on resource (or it may not exist)'),
            });

            const result =
                await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

            expect(result.success).toBe(false);
            expect(result.details)
                .toBe(
                    `Model 'sales': entry link '${STAR_SEMANTIC_LINK}': ` +
                    'Permission denied on resource (or it may not exist)');
          });

      // The create of the source reference link, whose stale link the push
      // deleted, returns 409 and the read returns 404: another link held the
      // two entries. FOREIGN is another tool's link between them, which
      // push's lookup through the entities leaves alone. Each case fails with
      // `details`.
      const DUPLICATE =
          'EntryLink already exists, for the given entry reference and link type';
      const FOREIGN = directed(
          'reference', 'catalog-reference-1',
          'sales/relationships/orders_to_customer', 'sales/entities/orders');
      // A link of another type between the same two entries, which does not
      // block a reference link.
      const RELATED = {...FOREIGN, entryLinkType: FOREIGN.entryLinkType.replace(
          /reference$/, 'related')};
      for (const [name, links, createLink, details] of [
        ['a 409 on creating the ID of a deleted stale link names the other ' +
             'link and says to delete it, with no push-again hint',
         linksTo(...SOURCE_LINKS, FOREIGN),
         (id: string) => id === STAR_REFERENCES[0] ? err(409, DUPLICATE) :
                                                      SOURCE_MOVED.createLink(id),
         `Model 'sales': failed to create entry link '${STAR_REFERENCES[0]}' ` +
             `because another 'reference' link 'catalog-reference-1' already ` +
             `goes from 'sales/relationships/orders_to_customer' to ` +
             `'sales/entities/orders'; delete that link, then push again`],
        ['a 409 on creating the ID of a deleted stale link, with no other ' +
             'link of its type between the two entries any more, gives the ' +
             '409\'s text and the push-again hint',
         linksTo(...SOURCE_LINKS, RELATED),
         (id: string) => id === STAR_REFERENCES[0] ? err(409, DUPLICATE) :
                                                      SOURCE_MOVED.createLink(id),
         `Model 'sales': entry link '${STAR_REFERENCES[0]}': ${DUPLICATE} ` +
             `(push again to restore the link)`],
        ['a link a deleted orphan made way for still gets the push-again ' +
             'hint when another link is blocked',
         linksTo(...SOURCE_LINKS, BACK_LINK, FOREIGN),
         (id: string) => id === STAR_SEMANTIC_LINK ?
             err(500, 'backend unavailable') :
             id === STAR_REFERENCES[0] ? err(409, DUPLICATE) :
                                         SOURCE_MOVED.createLink(id),
         `Model 'sales': entry link '${STAR_SEMANTIC_LINK}': backend ` +
             `unavailable (push again to restore the link)`],
      ] as [string, Stubs['links'], Stubs['createLink'], string][]) {
        test(name, async () => {
          stubClient({
            ...SOURCE_MOVED,
            links,
            createLink,
            getLink: err(404, 'EntryLink does not exist.'),
          });

          const result =
              await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

          expect(result).toMatchObject({success: false, details});
        });
      }

      test(
          'returns an error when deleting a link with changed references fails',
          async () => {
            const {createLink} = stubClient({
              ...SOURCE_MOVED,
              delLink: (id) => id === STAR_REFERENCES[0] ?
                  err(500, 'delete failed') :
                  ok({}),
            });

            const result =
                await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

            expect(result.success).toBe(false);
            expect(result.details)
                .toBe(
                    'Deleting stale entry link ' +
                    `'${STAR_REFERENCES[0]}' from model 'sales' ` +
                    'failed: delete failed');
            expect(createLink).not.toHaveBeenCalled();
          });

      test(
          'a thrown error on a link delete after an earlier delete in the ' +
              'same batch names the link, keeps the count and says to push ' +
              'again',
          async () => {
            // The first orphan, BACK_LINK, joins the two entities STAR_LINK
            // joins, so its delete leaves the pair without a link.
            const dropped = semanticLink(SUPPLIER_ID, 'orders', 'supplier');
            stubClient({
              existing: [
                {id: 'sales', type: MODEL_TYPE},
                {id: 'sales/entities/orders', type: ENTITY_TYPE},
                {id: 'sales/entities/customer', type: ENTITY_TYPE},
              ],
              links: () => ok([BACK_LINK, dropped]),
              delLink: (id) => {
                if (id === SUPPLIER_ID) {
                  throw new Error('socket hang up');
                }
                return ok({});
              },
            });

            const result =
                await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

            expect(result.success).toBe(false);
            expect(result.unlinked).toBe(1);
            expect(result.details)
                .toBe(
                    'Deleting orphaned entry link ' +
                    `'${SUPPLIER_ID}' from model 'sales' ` +
                    'failed: socket hang up (push again to restore the link)');
          });

      test(
          'returns an error when recreating a link after deletion fails',
          async () => {
            // A 404 on a delete counts as deleted.
            stubClient({
              ...SOURCE_MOVED,
              delLink: () => err(404, 'already gone'),
              createLink: (id) => id === STAR_REFERENCES[0] ?
                  err(500, 'recreate failed') :
                  SOURCE_MOVED.createLink(id),
            });

            const result =
                await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

            expect(result.success).toBe(false);
            expect(result.details)
                .toBe(
                    'Model \'sales\': entry link ' +
                    `'${STAR_REFERENCES[0]}': recreate failed ` +
                    '(push again to restore the link)');
          });

      test(
          'an error on one link after another replaced a deleted link has ' +
              'no push-again hint',
          async () => {
            // `sales-old-a` joins the pair `sales-a` takes, and `sales-a` is
            // written. The stored `sales-b` lacks its aspect, so push updates
            // it. That update fails, and the link still exists.
            const linkA = linkEntry(
                'sales-a', ['sales.entities.orders', 'sales.entities.customer']);
            const linkB = {
              ...linkEntry(
                  'sales-b',
                  ['sales.entities.orders', 'sales.entities.supplier']),
              aspects: {'dataplex-types.global.schema-join': {data: {}}},
            };
            stubClient({
              existing: [
                {id: 'sales', type: MODEL_TYPE},
                {id: 'sales.entities.orders', type: ENTITY_TYPE},
              ],
              links: () => ok([
                linkEntry(
                    'sales-old-a',
                    ['sales.entities.orders', 'sales.entities.customer']),
                {...linkB, aspects: undefined},
              ]),
              updateLink: err(500, 'backend error'),
            });
            const emitted: EmittedModel[] = [{
              model: 'sales',
              resources: {
                entries: [{name: entryName('sales'), entryType: MODEL_TYPE}],
                entryLinks: [linkA, linkB],
                ownedPrefixes: ['sales.entities.'],
                warnings: [],
              },
            }];

            const result = await deployEmittedModels(emitted, [], CTX, OPTS);

            expect(result.success).toBe(false);
            expect(result.details)
                .toBe('Model \'sales\': entry link \'sales-b\': backend error');
          });
    });


describe('deployKnowledgeCatalog: both relationship link types', () => {
  // The STAR model's anchor and entity entries, as a re-push finds them after
  // a first-generation push.
  const STAR_ENTITY_ENTRIES = [
    {id: 'sales', type: MODEL_TYPE},
    {id: 'sales.entities.orders', type: ENTITY_TYPE},
    {id: 'sales.entities.customer', type: ENTITY_TYPE},
  ];

  test(
      'lookupEntryLinks omits entryLinkTypes and filters to schema-join and ' +
          'semantic-link links',
      async () => {
        // Stage orphaned `schema-join` and `semantic-link` links and a
        // non-relationship `synonym` link on the model's entities.
        const orphanSchemaJoin = linkEntry(
            'sales-old-join',
            ['sales.entities.orders', 'sales.entities.customer']);
        const orphanSemanticLink = {
          ...linkEntry(
              'sales-old-rel',
              ['sales.entities.orders', 'sales.entities.customer']),
          entryLinkType: SEMANTIC_LINK_TYPE,
        };
        const unrelatedLink = {
          ...linkEntry(
              'sales-synonym-link',
              ['sales.entities.orders', 'sales.entities.customer']),
          entryLinkType:
              'projects/dataplex-types/locations/global/entryLinkTypes/synonym',
        };
        const {lookupLinks, delLink} = stubClient({
          existing: [
            {id: 'sales', type: MODEL_TYPE},
            {id: 'sales.entities.orders', type: ENTITY_TYPE},
            {id: 'sales.entities.customer', type: ENTITY_TYPE},
          ],
          links: (entry: string) => entry.endsWith('sales.entities.orders') ?
              ok([orphanSchemaJoin, orphanSemanticLink, unrelatedLink]) :
              ok([]),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        // `lookupEntryLinks` omitted `entryLinkTypes` and only the two
        // relationship orphans were deleted.
        expect(result.success).toBe(true);
        expect(result.unlinked).toBe(2);
        expect(lookupLinks.mock.calls.map(c => c[2])).toEqual([
          {entry: entryName('sales.entities.orders')},
          {entry: entryName('sales.entities.customer')},
        ]);
        expect(delLink.mock.calls.map(c => c[3]).sort()).toEqual([
          'sales-old-join',
          'sales-old-rel',
        ]);
      });

  test(
      'looks up links only through entity entries, skipping model, metric ' +
          'and relationship entries',
      async () => {
        // A re-push over STAR's entries and links as a push writes them.
        const {lookupLinks, result} = await pushAgain(STAR_DOCS, V2_ENTRIES, {
          createLink: EXISTS,
          links: STAR_LINKS,
        });

        expect(result.success).toBe(true);
        expect(lookupLinks.mock.calls.map(c => c[2])).toEqual([
          {entry: entryName('sales/entities/orders')},
          {entry: entryName('sales/entities/customer')},
        ]);
      });

  test(
      'lookupEntryLinks skips relationship links stored in a sibling entry ' +
          'group',
      async () => {
        // A relationship link created in a sibling entry group (`other-eg`)
        // that references this model's entities must not shadow the model's
        // own link on update or be treated as an orphan to delete in `eg`.
        // `link` stored in `other-eg`, with its second reference there too.
        const inSibling = (link: any) => {
          const sibling = structuredClone(link);
          sibling.name = sibling.name.replace(
              '/entryGroups/eg/', '/entryGroups/other-eg/');
          sibling.entryReferences[1].name =
              sibling.entryReferences[1].name.replace(
                  '/entryGroups/eg/', '/entryGroups/other-eg/');
          return sibling;
        };
        // One holds the ID of STAR's link, and one joins its two entities.
        const siblingSameIdLink =
            inSibling(semanticLink(STAR_SEMANTIC_LINK, 'orders', 'supplier'));
        const siblingOrphanCandidate =
            inSibling(semanticLink(SUPPLIER_ID, 'orders', 'customer'));
        const {createLink, updateLink, delLink} = stubClient({
          existing: V2_ENTRIES,
          links: linksTo(siblingSameIdLink, siblingOrphanCandidate),
          createLink: starLinkExists(),
          getLink: ok(gotStarLink()),
          updateLink: ok({}),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result).toMatchObject({success: true, linked: 3, unlinked: 0});
        expect(createLink).toHaveBeenCalledTimes(3);
        expect(updateLink).toHaveBeenCalledTimes(1);
        expect(delLink).not.toHaveBeenCalled();
      });

  test(
      'lookupEntryLinks skips relationship links stored in another ' +
          'project\'s entry group of the same name',
      async () => {
        // Dataplex spells link names with project numbers. The scope's project
        // 'dest' has the number 123456789, so 987654321 is another project.
        const otherProjectLink = {
          ...linkEntry(
              'sales-other-proj-link',
              ['sales.entities.orders', 'sales.entities.customer'],
              '987654321'),
          entryReferences: [
            {
              name: entryName('sales.entities.orders', '123456789'),
              type: 'UNSPECIFIED',
            },
            {
              name: entryName('sales.entities.customer', '987654321'),
              type: 'UNSPECIFIED',
            },
          ],
        };
        const {delLink, getProject} = stubClient({
          existing: [
            {id: 'sales', type: MODEL_TYPE},
            {id: 'sales.entities.orders', type: ENTITY_TYPE},
            {id: 'sales.entities.customer', type: ENTITY_TYPE},
          ],
          links: (entry: string) =>
              entry.endsWith('/entries/sales.entities.orders') ?
              ok([otherProjectLink]) :
              ok([]),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(true);
        expect(result.unlinked).toBe(0);
        expect(delLink).not.toHaveBeenCalled();
        expect(getProject.mock.calls.map(c => c[0])).toEqual(['dest']);

        // Also when `opts.project` is given as a numeric project number
        // ('123456789'), a link stored in another numeric project ('987654321')
        // is skipped.
        const otherNumericLink = {
          ...linkEntry(
              'sales-other-num-link',
              ['sales.entities.orders', 'sales.entities.customer'],
              '987654321'),
          entryReferences: [
            {
              name: entryName('sales.entities.orders', '123456789'),
              type: 'UNSPECIFIED',
            },
            {
              name: entryName('sales.entities.customer', '987654321'),
              type: 'UNSPECIFIED',
            },
          ],
        };
        const {delLink: delNumericLink} = stubClient({
          existing: [
            {id: 'sales', type: MODEL_TYPE},
            {id: 'sales.entities.orders', type: ENTITY_TYPE},
            {id: 'sales.entities.customer', type: ENTITY_TYPE},
          ],
          existingProject: '123456789',
          links: (entry: string) =>
              entry.endsWith('/entries/sales.entities.orders') ?
              ok([otherNumericLink]) :
              ok([]),
        });

        const numericResult = await deployKnowledgeCatalog(
            models(STAR_DOCS), CTX, {...OPTS, project: '123456789'});

        expect(numericResult.success).toBe(true);
        expect(numericResult.unlinked).toBe(0);
        expect(delNumericLink).not.toHaveBeenCalled();
      });

  test(
      'a link read back with its references under a project number is ' +
          'updated in place, with no Resource Manager call',
      async () => {
        // The listing spells the project as requested, so it gives no number,
        // and the read spells the references with one. Push compares the
        // references by entry ID, so it needs no project number.
        const project = 'unresolved-proj';
        const got = {
          ...directed(
              'semantic-link', STAR_SEMANTIC_LINK, 'sales/entities/orders',
              'sales/entities/customer', '555'),
          name: `projects/${project}/locations/us/entryGroups/eg/entryLinks/` +
              STAR_SEMANTIC_LINK,
        };
        const {updateLink, delLink, getProject} = stubClient({
          existing: [{id: 'sales', type: MODEL_TYPE}],
          existingProject: project,
          project: () => err(403, 'Permission denied'),
          createLink: starLinkExists(),
          getLink: ok(got),
          updateLink: ok({}),
        });

        const result = await deployKnowledgeCatalog(
            models(STAR_DOCS), CTX, {...OPTS, project});

        expect(result.success).toBe(true);
        expect(updateLink).toHaveBeenCalledTimes(1);
        expect(delLink).not.toHaveBeenCalled();
        expect(getProject).not.toHaveBeenCalled();
      });

  test(
      'lookupEntryLinks keeps a link under any project number when the ' +
          'scope\'s project number cannot be found',
      async () => {
        // Neither the scope nor the listing spells a number, and Resource
        // Manager denies the lookup, so the filter cannot tell the scope's
        // number from another project's.
        const orphan = linkEntry(
            'sales-orders-to-supplier',
            ['sales.entities.orders', 'sales.entities.supplier'], '987654321');
        const {delLink, getProject} = stubClient({
          existing: STAR_ENTITY_ENTRIES,
          links: () => ok([orphan]),
          project: () => err(403, 'Permission denied'),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(true);
        expect(delLink.mock.calls.map(c => c[3])).toEqual([
          'sales-orders-to-supplier',
        ]);
        expect(getProject).toHaveBeenCalledTimes(1);
      });

  test(
      'lookupEntryLinks keeps a link under any project number when ' +
          'Resource Manager throws',
      async () => {
        const orphan = linkEntry(
            'sales-orders-to-supplier',
            ['sales.entities.orders', 'sales.entities.supplier'], '987654321');
        const {delLink} = stubClient({
          existing: STAR_ENTITY_ENTRIES,
          links: () => ok([orphan]),
          project: () => {
            throw new TypeError('fetch failed');
          },
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(true);
        expect(delLink.mock.calls.map(c => c[3])).toEqual([
          'sales-orders-to-supplier',
        ]);
      });

  test(
      'lookupEntryLinks takes the scope\'s project number that fixProject ' +
          'cached, with no second Resource Manager call',
      async () => {
        // The listing's _fixEntry resolves the number to the ID through
        // fixProject, which caches the pair. The cache outlives a test, so
        // this test uses a project no other test uses.
        const ownOrphan = linkEntry(
            'sales-orders-to-supplier',
            ['sales.entities.orders', 'sales.entities.supplier'], '555000111');
        const otherProjectOrphan = linkEntry(
            'sales-orders-to-warehouse',
            ['sales.entities.orders', 'sales.entities.warehouse'], '987654321');
        const {delLink, getProject} = stubClient({
          existing: STAR_ENTITY_ENTRIES,
          existingProject: 'cached-proj',
          links: () => ok([ownOrphan, otherProjectOrphan]),
          project: (p) => p === '555000111' ?
              ok({name: 'projects/555000111', projectId: 'cached-proj'}) :
              err(403, 'Permission denied'),
        });
        expect(await fixProject('projects/555000111', CTX))
            .toBe('projects/cached-proj');

        const result = await deployKnowledgeCatalog(
            models(STAR_DOCS), CTX, {...OPTS, project: 'cached-proj'});

        expect(result.success).toBe(true);
        expect(delLink.mock.calls.map(c => c[3])).toEqual([
          'sales-orders-to-supplier',
        ]);
        expect(getProject.mock.calls.map(c => c[0])).toEqual(['555000111']);
      });

  test(
      'lookupEntryLinks skips links stored in another location or in an ' +
          'entry group whose name starts with the destination\'s',
      async () => {
        const otherLocationLink = {
          ...linkEntry(
              'sales-other-location-link',
              ['sales.entities.orders', 'sales.entities.customer']),
          name: 'projects/dest/locations/eu/entryGroups/eg/entryLinks/' +
              'sales-other-location-link',
        };
        const longerGroupLink = {
          ...linkEntry(
              'sales-longer-group-link',
              ['sales.entities.orders', 'sales.entities.customer']),
          name: 'projects/dest/locations/us/entryGroups/eg2/entryLinks/' +
              'sales-longer-group-link',
          entryReferences: [
            {name: entryName('sales.entities.orders'), type: 'UNSPECIFIED'},
            {
              name: 'projects/dest/locations/us/entryGroups/eg2/entries/' +
                  'sales.entities.customer',
              type: 'UNSPECIFIED',
            },
          ],
        };
        const {delLink} = stubClient({
          existing: STAR_ENTITY_ENTRIES,
          links: () => ok([otherLocationLink, longerGroupLink]),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(true);
        expect(result.unlinked).toBe(0);
        expect(delLink).not.toHaveBeenCalled();
      });

  test('a lookupEntryLinks call that returns 404 fails the push', async () => {
    stubClient({
      existing: [
        {id: 'sales', type: MODEL_TYPE},
        {id: 'sales.entities.orders', type: ENTITY_TYPE},
      ],
      links: () => err(404, 'not found'),
    });

    const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

    expect(result.success).toBe(false);
    expect(result.details)
        .toBe(
            'Looking up entry links for \'sales.entities.orders\' from ' +
            'model \'sales\' failed: not found');
  });

  test(
      'returns an error when lookupEntryLinks fails while snapshotting ' +
          'existing links',
      async () => {
        stubClient({
          existing: [
            {id: 'sales', type: MODEL_TYPE},
            {id: 'sales.entities.orders', type: ENTITY_TYPE},
          ],
          links: () => err(500, 'lookup failed'),
        });

        const result = await deployKnowledgeCatalog(models(DOCS), CTX, OPTS);

        expect(result.success).toBe(false);
        expect(result.details)
            .toBe(
                'Looking up entry links for \'sales.entities.orders\' from ' +
                'model \'sales\' failed: lookup failed');
      });
});


describe('deployKnowledgeCatalog: a relationship with no join columns', () => {
  // `previous_department` and `requested_department` have no join columns.
  // `assignment` joins `employee` to `department` on `department_id`.
  const HR_DOCS = [{
    name: 'hr.yaml',
    text: `
version: "0.2.0.dev0/google"
semantic_model:
  - name: hr
    entities:
      - name: employee
        source: bigquery.googleapis.com/projects/demo/datasets/hr/tables/employee
        primary_key: [employee_id]
        fields:
          - name: employee_id
            expression:
              dialects: [{ dialect: BIGQUERY, expression: employee_id }]
          - name: department_id
            expression:
              dialects: [{ dialect: BIGQUERY, expression: department_id }]
      - name: department
        source: bigquery.googleapis.com/projects/demo/datasets/hr/tables/department
        primary_key: [department_id]
        fields:
          - name: department_id
            expression:
              dialects: [{ dialect: BIGQUERY, expression: department_id }]
    relationships:
      - {name: previous_department, from: employee, to: department}
      - {name: requested_department, from: employee, to: department}
      - name: assignment
        from: employee
        to: department
        from_columns: [department_id]
        to_columns: [department_id]
`,
  }];

  test('validateOnly plans its entry and reference links, with no warning',
       async () => {
         const {list, create, createLink} = stubClient();

         const result = await deployKnowledgeCatalog(
             models(HR_DOCS), CTX, {...OPTS, validateOnly: true});

         expect(result.success).toBe(true);
         expect(result.warnings).toEqual([]);
         expect(result.plan).toContain(
             '    - hr/relationships/previous_department ' +
             '(semantic-relationship)');
         // One semantic-link for the pair, and two reference links for each
         // of the three relationships.
         expect(result.plan).toContain('  1 semantic-link link:');
         expect(result.plan).toContain('  6 reference links:');
         expect(list).not.toHaveBeenCalled();
         expect(create).not.toHaveBeenCalled();
         expect(createLink).not.toHaveBeenCalled();
       });
});


describe('deployEmittedModels', () => {
  test('passes the warnings to onWarnings before the first write',
       async () => {
         const events: string[] = [];
         stubClient({create: (id) => (events.push(`create:${id}`), ok({}))});
         const resources = {
           entries: [{name: entryName('hr'), entryType: MODEL_TYPE}],
           entryLinks: [], ownedPrefixes: ['hr.'], warnings: [],
         };

         const result = await deployEmittedModels(
             [{model: 'hr', resources}], ['a warning'], CTX,
             {...OPTS, onWarnings: (warnings) => events.push(...warnings)});

         expect(result.success).toBe(true);
         expect(events).toEqual(['a warning', 'create:hr']);
       });
});


describe('deployKnowledgeCatalog: cross-layout V1 -> V2 cleanup', () => {
  test(
      'pushing into an entry group holding V1 entries and schema-join ' +
          'links creates V2 entries and links and deletes old V1 entries ' +
          'and links',
      async () => {
        // The entry group holds what a first-generation push of a model with
        // relationships from orders to customer and to supplier left: the
        // dotted entries and two `schema-join` links.
        const {create, update, del, createLink, delLink} = stubClient({
          existing: [
            {id: 'sales', type: MODEL_TYPE},
            {id: 'sales.entities.orders', type: ENTITY_TYPE},
            {id: 'sales.entities.customer', type: ENTITY_TYPE},
            {id: 'sales.entities.supplier', type: ENTITY_TYPE},
            {id: 'sales.metrics.total_revenue', type: METRIC_TYPE},
            {id: 'sales.metrics.order_count', type: METRIC_TYPE},
          ],
          create: (id) => id === 'sales' ? err(409, 'already exists') : ok({}),
          links: linksTo(
              linkEntry(
                  'sales-orders-to-customer',
                  ['sales.entities.orders', 'sales.entities.customer']),
              linkEntry(
                  'sales-orders-to-supplier',
                  ['sales.entities.orders', 'sales.entities.supplier'])),
          createLink: () => ok({}),
        });

        const result =
            await deployKnowledgeCatalog(models(STAR_DOCS), CTX, OPTS);

        expect(result.success).toBe(true);
        expect(result.updated).toBe(1);  // anchor 'sales'
        // 2 slash entities, 2 slash metrics and the relationship entry.
        expect(result.created).toBe(5);
        // The pair's semantic-link and the relationship's reference links.
        expect(result.linked).toBe(3);
        expect(result.deleted).toBe(5);   // the 5 old dotted entries
        expect(result.unlinked).toBe(2);  // both V1 schema-join links deleted
        // The anchor, and the label that says the push finished.
        expect(update).toHaveBeenCalledTimes(2);
        expect(createLink.mock.calls.map(c => c[3]))
            .toEqual([STAR_SEMANTIC_LINK, ...STAR_REFERENCES]);
        expect(create.mock.calls.map(c => c[3]).sort()).toEqual([
          'sales',
          'sales/entities/customer',
          'sales/entities/orders',
          'sales/metrics/order_count',
          'sales/metrics/total_revenue',
          'sales/relationships/orders_to_customer',
        ]);
        expect(del.mock.calls.map(c => c[3]).sort()).toEqual([
          'sales.entities.customer',
          'sales.entities.orders',
          'sales.entities.supplier',
          'sales.metrics.order_count',
          'sales.metrics.total_revenue',
        ]);
        expect(delLink.mock.calls.map(c => c[3]).sort()).toEqual([
          'sales-orders-to-customer',
          'sales-orders-to-supplier',
        ]);
      });
});


type Stubs = NonNullable<Parameters<typeof stubClient>[0]>;
// Pushes `docs` over a catalog that lists `existing` and answers each create
// with 409. `stubs` overrides any stub.
async function pushAgain(
    docs: {name: string; text: string}[], existing: Stubs['existing'],
    stubs: Stubs = {}) {
  const spies = stubClient(
      {create: EXISTS, ...stubs, existing: stubs.existing ?? existing});
  const result = await deployKnowledgeCatalog(models(docs), CTX, OPTS);
  return {...spies, result};
}


describe('deployKnowledgeCatalog: relationship entries and links', () => {
  // Pushes `docs` again over STAR's entries, whose entry and link creates
  // return 409.
  const rePush = (stubs: Stubs, docs = STAR_DOCS) =>
      pushAgain(docs, V2_ENTRIES, {createLink: EXISTS, ...stubs});

  test('a relationship dropped from the model has its entry deleted, its ' +
           'reference links, and its semantic-link when it was the last on ' +
           'its pair; a reference link push did not name is kept, and one ' +
           'unchanged is not updated',
       async () => {
         const dropped = references('customer_orders', 'customer', 'orders');
         const callOrder: string[] = [];
         const {updateLink, result} = await rePush({
           existing: [
             ...V2_ENTRIES,
             {id: 'sales/relationships/customer_orders',
              type: RELATIONSHIP_TYPE},
           ],
           links: () => ok([
             STAR_LINK, BACK_LINK, ...dropped,
             ...references('orders_to_customer', 'orders', 'customer'),
             directed('reference', 'my-note', 'sales/entities/customer',
                      'sales/entities/orders'),
           ]),
           delLink: (id) => (callOrder.push(`delLink:${id}`), ok({})),
           createLink: (id) => (callOrder.push(`createLink:${id}`), EXISTS()),
           del: (id) => (callOrder.push(`delEntry:${id}`), ok({})),
         });

         expect(result.success).toBe(true);
         expect(result.deleted).toBe(1);
         expect(result.unlinked).toBe(3);
         expect(result.linked).toBe(1);
         expect(result.unchangedLinks).toBe(2);
         // The orphaned links go first, and the orphaned entry goes last.
         // The lookup returned STAR's links with the same ends, so push
         // creates none of them. STAR_LINK is stored without its aspect, so
         // it gets the one update.
         expect(callOrder).toEqual([
           ...[BACK_ID, ...dropped.map(l => l.name.split('/').pop())].map(
               id => `delLink:${id}`),
           'delEntry:sales/relationships/customer_orders',
         ]);
         expect(updateLink).toHaveBeenCalledTimes(1);
       });

  // STAR_LINK as the lookup returns it after a push: its aspect is keyed with
  // the types project `project`, holds `relationships`, and carries the
  // fields Dataplex adds.
  const storedLink = (project: string, relationships: string[]) => ({
    ...STAR_LINK,
    aspects: {
      [`${project}.global.semantic-link`]: {
        aspectType:
            `projects/${project}/locations/global/aspectTypes/semantic-link`,
        createTime: '2026-11-07T00:35:40Z',
        updateTime: '2026-11-07T00:35:40Z',
        aspectSource: {},
        data: {relationships},
      },
    },
  });
  const [SOURCE_REF, TARGET_REF] =
      references('orders_to_customer', 'orders', 'customer');
  // `link` as stored in another project, 987654321, from that project's
  // entry with the ID of the link's source. The lookup of the link's target
  // returns it.
  const inOtherProject = (link: any) => {
    const other = structuredClone(link);
    for (const r of [other, other.entryReferences[0]]) {
      r.name = r.name.replace('projects/123456789/', 'projects/987654321/');
    }
    return other;
  };
  // Resource Manager does not give the scope's project number.
  const NO_NUMBER = {project: () => err(403, 'Permission denied')};
  // Each case pushes STAR again over the links `links` with the stubs `stubs`
  // and expects creates of the link IDs `created` and updates of `updated`.
  // STAR's other links count as unchanged.
  for (const [name, links, created, updated, stubs] of [
    ['an unchanged re-push sends no entry link write',
     [storedLink('655216118709', ['orders_to_customer']), SOURCE_REF,
      TARGET_REF],
     [], []],
    ['an aspect keyed with the types project ID counts as unchanged',
     [storedLink('dataplex-types', ['orders_to_customer']), SOURCE_REF,
      TARGET_REF],
     [], []],
    ['a link whose aspect changed gets an update and no create',
     [storedLink('655216118709', ['old_name']), SOURCE_REF, TARGET_REF], [],
     [STAR_SEMANTIC_LINK]],
    ['a link the lookup did not return is created',
     [storedLink('655216118709', ['orders_to_customer']), SOURCE_REF],
     [STAR_REFERENCES[1]], []],
    ['with no project number, a link in another project that holds the ' +
         'aspect does not count as unchanged',
     [inOtherProject(storedLink('655216118709', ['orders_to_customer'])),
      SOURCE_REF, TARGET_REF],
     [STAR_SEMANTIC_LINK], [], NO_NUMBER],
    ['with no project number, a link in another project whose aspect ' +
         'differs gets no update',
     [inOtherProject(storedLink('655216118709', ['old_name'])), SOURCE_REF,
      TARGET_REF],
     [STAR_SEMANTIC_LINK], [], NO_NUMBER],
    ['with no project number, a link in another project does not hide the ' +
         'project\'s own',
     [inOtherProject(storedLink('655216118709', ['orders_to_customer'])),
      storedLink('655216118709', ['old_name']), SOURCE_REF, TARGET_REF],
     [], [STAR_SEMANTIC_LINK], NO_NUMBER],
  ] as [string, object[], string[], string[], Stubs?][]) {
    test(name, async () => {
      const {createLink, updateLink, result} = await rePush(
          {links: () => ok(links), createLink: () => ok({}), ...stubs});
      const linked = created.length + updated.length;
      expect(result).toMatchObject(
          {success: true, linked, unchangedLinks: 3 - linked});
      expect(createLink.mock.calls.map(c => c[3])).toEqual(created);
      expect(updateLink.mock.calls.map(c => c[0].name!.split('/').pop()))
          .toEqual(updated);
    });
  }

  // STAR with its relationship turned to run from customer to orders.
  const FLIPPED = [{
    name: 'star.yaml',
    text: STAR.replace(
        'from: orders\n        to: customer\n' +
            '        from_columns: [o_custkey]\n' +
            '        to_columns: [c_custkey]',
        'from: customer\n        to: orders\n' +
            '        from_columns: [c_custkey]\n' +
            '        to_columns: [o_custkey]'),
  }];

  test('a relationship that changes direction has its link and both ' +
           'reference links deleted before any link is written',
       async () => {
         // The reference links keep their IDs and swap entities, so the new
         // source link joins the two entries the old target link joins.
         const callOrder: string[] = [];
         const record = (call: string) => (id: string) => {
           callOrder.push(`${call}:${id}`);
           return ok({});
         };
         const {result} = await rePush(
             {
               links: STAR_LINKS,
               createLink: record('createLink'),
               delLink: record('delLink'),
             },
             FLIPPED);

         expect(result).toMatchObject({success: true, linked: 3, unlinked: 1});
         expect(callOrder).toEqual([
           `delLink:${STAR_SEMANTIC_LINK}`,
           ...STAR_REFERENCES.map(id => `delLink:${id}`),
           `createLink:${BACK_ID}`,
           ...STAR_REFERENCES.map(id => `createLink:${id}`),
         ]);
       });

  // Each case pushes `docs` again with `stubs`, tries to delete the links
  // `deleted`, deletes only the first, and fails with `details`.
  for (const [name, stubs, docs, deleted, details] of [
    ['a failed update of a kept link gives no push-again hint when only ' +
         'the link in the other direction was deleted',
     {
       links: () => ok([STAR_LINK, BACK_LINK]),
       updateLink: err(500, 'backend unavailable'),
     },
     STAR_DOCS, [BACK_ID],
     `Model 'sales': entry link '${STAR_SEMANTIC_LINK}': backend unavailable`],
    ['a relationship that changes direction, whose new link fails to ' +
         'write, says to push again',
     {
       links: () => ok([STAR_LINK]),
       createLink: () => err(500, 'backend unavailable'),
     },
     FLIPPED, [STAR_SEMANTIC_LINK],
     `Model 'sales': entry link '${BACK_ID}': backend unavailable ` +
         `(push again to restore the link)`],
    ['a relationship that changes direction, whose stale reference link ' +
         'fails to delete after its link was deleted, says to push again',
     {
       links: STAR_LINKS,
       delLink: (id: string) =>
           id === STAR_REFERENCES[0] ? err(500, 'delete failed') : ok({}),
     },
     FLIPPED, [STAR_SEMANTIC_LINK, STAR_REFERENCES[0]],
     `Deleting stale entry link '${STAR_REFERENCES[0]}' from model 'sales' ` +
         `failed: delete failed (push again to restore the link)`],
    ['a failed orphan delete gives no push-again hint when the read ' +
         'before the deletes found the kept link unchanged',
     {
       links: () => ok(
           [BACK_LINK, semanticLink(SUPPLIER_ID, 'orders', 'supplier')]),
       // getEntryLink returns the kept link unchanged.
       getLink: ok(gotStarLink()),
       delLink: (id: string) =>
           id === SUPPLIER_ID ? err(500, 'delete failed') : ok({}),
     },
     STAR_DOCS, [BACK_ID, SUPPLIER_ID],
     `Deleting orphaned entry link '${SUPPLIER_ID}' from model 'sales' ` +
         `failed: delete failed`],
  ] as [string, Stubs, typeof STAR_DOCS, string[], string][]) {
    test(name, async () => {
      const {delLink, result} = await rePush(stubs, docs);
      expect(delLink.mock.calls.map(c => c[3])).toEqual(deleted);
      expect(result).toMatchObject({success: false, unlinked: 1, details});
    });
  }
});


describe('deployKnowledgeCatalog: the size of an aspect', () => {
  type Opts = Parameters<typeof deployKnowledgeCatalog>[2];
  // Pushes OSSIE with `instructions` on the model and `description` on field
  // o_orderkey.
  const push = (instructions: string, opts: Opts = OPTS,
                description = 'd') =>
      deployKnowledgeCatalog(models([{
        name: 'sales.yaml',
        text: OSSIE
            .replace('  - name: sales\n', '  - name: sales\n    ai_context: ' +
                     `{instructions: ${JSON.stringify(instructions)}}\n`)
            .replace('- name: o_orderkey\n', '- name: o_orderkey\n' +
                     `            description: ${description}\n`),
      }]), CTX, opts);
  // The error for aspect `key` of `owner`, whose data takes `bytes` bytes.
  const tooLarge = (key: string, owner: string, bytes: number, limit = LIMIT) =>
      `aspect 'dataplex-types.global.${key}' of ${owner} is too large to ` +
      `store in Knowledge Catalog: its data takes ${bytes} bytes, and one ` +
      `aspect holds at most ${limit}.`;
  // The JSON around the instructions in the guidelines aspect.
  const ENVELOPE = JSON.stringify({instructions: '', userManaged: true}).length;
  // Instructions of `ch` just past the limit, where Dataplex stores each `ch`
  // in `width` bytes, and the error for them.
  const over = (ch: string, width: number) => {
    const count = Math.ceil((LIMIT - ENVELOPE) / width) + 1;
    const bytes = count * width + ENVELOPE;
    return [ch.repeat(count), tooLarge('guidelines', 'entry \'sales\'', bytes)];
  };

  // A push that fails lists and writes nothing.
  for (const [name, [instructions, details], opts, description] of [
    ['an aspect exactly at the limit fits', ['x'.repeat(LIMIT - ENVELOPE)]],
    ['an aspect one byte over the limit fails', over('x', 1)],
    // JSON.stringify writes é in two bytes, < > & = and ' in one and U+2028
    // and U+2029 in three, and Dataplex writes each of the last seven in six.
    ['the size counts UTF-8 bytes and Dataplex\'s escapes',
     over('é<>&=\'\u2028\u2029', 44)],
    ['a schema aspect over 120 KiB and under 2 MiB fits', ['x'], OPTS,
     'd'.repeat(LIMIT)],
    ['a schema aspect over 2 MiB fails',
     ['x', tooLarge('schema', 'entry \'sales/entities/orders\'', 2_097_313,
                    2 * 1024 * 1024)],
     {...OPTS, validateOnly: true}, 'd'.repeat(2 * 1024 * 1024)],
  ] as [string, string[], Opts?, string?][]) {
    test(name, async () => {
      const {list, create} = stubClient();
      expect(await push(instructions, opts, description))
          .toMatchObject(details ? {success: false, details} : {success: true});
      if (details) {
        expect(list).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
      }
    });
  }

  // OSSIE with n more fields on orders, f0 to f<n-1>, each with an example.
  const wide = (n: number) => models([{
    name: 'sales.yaml',
    text: OSSIE.replace('- name: o_orderkey\n', Array.from(
        {length: n}, (_, i) => `- { name: f${i}, expression: f${i}, ` +
            'ai_context: {examples: [e]} }\n          ').join('') +
        '- name: o_orderkey\n'),
  }]);

  test('an entry with 100 or more instances of one aspect type is pushed',
       async () => {
         stubClient();
         expect(await deployKnowledgeCatalog(wide(100), CTX, OPTS))
             .toMatchObject({success: true});
       });

  test('a semantic-link aspect is checked too', async () => {
    stubClient();
    const relationships = ['r'.repeat(LIMIT)];
    const entryLinks = [{
      ...linkEntry('sales-link', []), entryLinkType: SEMANTIC_LINK_TYPE,
      aspects: {'dataplex-types.global.semantic-link': {data: {relationships}}},
    }];
    const resources =
        {entries: [], entryLinks, ownedPrefixes: [], warnings: []};
    const details = tooLarge(
        'semantic-link', 'entry link \'sales-link\'',
        LIMIT + JSON.stringify({relationships: ['']}).length);
    expect(await deployEmittedModels([{model: 'sales', resources}], [], CTX,
                                     {...OPTS, validateOnly: true}))
        .toMatchObject({success: false, details});
  });
});
